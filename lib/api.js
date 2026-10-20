'use strict';
// 本地只读 REST + MCP(Streamable HTTP)。仅监听 127.0.0.1，Bearer Token 鉴权，每次启动轮换。
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const MAX_BODY = 64 * 1024;
const MAX_PAGE = 100;
const RATE_LIMIT = 240;
const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function toModel(r) {
  return {
    id: r.id, name: r.name, format: r.ext, path: r.path, directory: r.dir,
    sizeBytes: r.size, modifiedAt: new Date(r.mtimeMs).toISOString(),
    dimensions: r.info && r.info.size ? r.info.size : null,
    triangles: r.info && r.info.triangles != null ? r.info.triangles : null
  };
}

function createApi({ store, userDataDir, version }) {
  const token = crypto.randomBytes(32).toString('hex');
  let server = null;
  let port = 0;
  let hits = [];

  function query(params) {
    const q = String(params.q || '').trim().toLowerCase();
    if (q.length > 200) throw new HttpError(400, 'INVALID_ARGUMENT', 'q too long');
    const format = params.format ? String(params.format).toLowerCase() : '';
    const page = Math.max(1, parseInt(params.page || '1', 10) || 1);
    const pageSize = Math.min(MAX_PAGE, Math.max(1, parseInt(params.pageSize || '20', 10) || 20));
    let list = store.all();
    if (format) list = list.filter((r) => r.ext === format);
    if (q) list = list.filter((r) => r.name.toLowerCase().includes(q) || r.dir.toLowerCase().includes(q));
    list.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    const total = list.length;
    return {
      items: list.slice((page - 1) * pageSize, page * pageSize).map(toModel),
      page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize))
    };
  }
  function getModel(id) {
    const r = store.get(String(id));
    if (!r) throw new HttpError(404, 'NOT_FOUND', 'model not found');
    return toModel(r);
  }

  function openapi(origin) {
    const p = (summary) => ({ get: { summary, security: [{ bearer: [] }], responses: { 200: { description: 'OK' } } } });
    return {
      openapi: '3.0.3', info: { title: 'Collabo 3D Print File Manager API', version },
      servers: [{ url: origin }],
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
      paths: {
        '/api/v1/health': p('Health'), '/api/v1/models': p('List models (q, format, page, pageSize)'),
        '/api/v1/search': p('Search models by q'), '/api/v1/models/{id}': p('Get one model')
      }
    };
  }

  const TOOLS = [
    { name: 'list_models', description: 'List indexed 3D models (paged).', inputSchema: { type: 'object', properties: { format: { type: 'string' }, page: { type: 'integer' }, pageSize: { type: 'integer' } } } },
    { name: 'search_models', description: 'Search models by file name or folder.', inputSchema: { type: 'object', required: ['q'], properties: { q: { type: 'string' }, format: { type: 'string' }, page: { type: 'integer' }, pageSize: { type: 'integer' } } } },
    { name: 'get_model_info', description: 'Get one model by id.', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } }
  ];

  function mcp(msg) {
    const id = msg.id;
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    switch (msg.method) {
      case 'initialize': {
        const want = msg.params && msg.params.protocolVersion;
        return ok({
          protocolVersion: MCP_VERSIONS.includes(want) ? want : MCP_VERSIONS[0],
          capabilities: { tools: {} }, serverInfo: { name: 'collabo-3d-print-file-manager', version }
        });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS });
      case 'tools/call': {
        const { name, arguments: a = {} } = msg.params || {};
        try {
          let data;
          if (name === 'list_models') data = query(a);
          else if (name === 'search_models') { if (!a.q) throw new HttpError(400, 'INVALID_ARGUMENT', 'q required'); data = query(a); }
          else if (name === 'get_model_info') data = getModel(a.id);
          else return err(-32602, 'unknown tool');
          return ok({ content: [{ type: 'text', text: JSON.stringify(data) }] });
        } catch (e) {
          return ok({ isError: true, content: [{ type: 'text', text: e.message }] });
        }
      }
      default:
        return id === undefined ? null : err(-32601, 'method not found');
    }
  }

  function send(res, status, body, headers = {}) {
    const text = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(text);
  }

  function authorize(req) {
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, 'FORBIDDEN', 'bad host');
    if (req.headers.origin) {
      let o;
      try { o = new URL(req.headers.origin); } catch { throw new HttpError(403, 'FORBIDDEN', 'bad origin'); }
      if (!['127.0.0.1', 'localhost'].includes(o.hostname)) throw new HttpError(403, 'FORBIDDEN', 'bad origin');
    }
    const m = /^Bearer (.+)$/.exec(String(req.headers.authorization || ''));
    const a = Buffer.from(m ? m[1] : '');
    const b = Buffer.from(token);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'UNAUTHORIZED', 'invalid token');
    const now = Date.now();
    hits = hits.filter((t) => now - t < 60000);
    if (hits.length >= RATE_LIMIT) throw new HttpError(429, 'RATE_LIMITED', 'too many requests');
    hits.push(now);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new HttpError(413, 'TOO_LARGE', 'body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function handle(req, res) {
    try {
      authorize(req);
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const origin = `http://127.0.0.1:${port}`;
      if (url.pathname === '/mcp') {
        if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'POST only');
        let body;
        try { body = JSON.parse(await readBody(req)); } catch (e) { if (e instanceof HttpError) throw e; return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
        if (Array.isArray(body)) {
          const out = body.map(mcp).filter(Boolean);
          return out.length ? send(res, 200, out) : send(res, 202);
        }
        const r = mcp(body);
        return r ? send(res, 200, r) : send(res, 202);
      }
      if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'GET only');
      const params = Object.fromEntries(url.searchParams);
      if (url.pathname === '/api/v1/health') return send(res, 200, { status: 'ok', version, indexed: store.all().length });
      if (url.pathname === '/api/v1/openapi.json') return send(res, 200, openapi(origin));
      if (url.pathname === '/api/v1/models') return send(res, 200, query(params));
      if (url.pathname === '/api/v1/search') {
        if (!params.q) throw new HttpError(400, 'INVALID_ARGUMENT', 'q required');
        return send(res, 200, query(params));
      }
      const m = /^\/api\/v1\/models\/([0-9a-f]{16})$/.exec(url.pathname);
      if (m) return send(res, 200, getModel(m[1]));
      throw new HttpError(404, 'NOT_FOUND', 'unknown route');
    } catch (e) {
      send(res, e.status || 500, { error: { code: e.code || 'INTERNAL', message: e.message } });
    }
  }

  function connectionInfo() {
    if (!port) return null;
    const base = `http://127.0.0.1:${port}`;
    return {
      baseUrl: base, apiUrl: base + '/api/v1', mcpUrl: base + '/mcp',
      headers: { Authorization: 'Bearer ' + token }, token
    };
  }

  function start() {
    return new Promise((resolve, reject) => {
      server = http.createServer(handle);
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        try {
          fs.mkdirSync(userDataDir, { recursive: true });
          fs.writeFileSync(path.join(userDataDir, 'api.json'), JSON.stringify(connectionInfo(), null, 2), { mode: 0o600 });
        } catch { /* ignore */ }
        resolve(connectionInfo());
      });
    });
  }
  function stop() {
    try { fs.rmSync(path.join(userDataDir, 'api.json'), { force: true }); } catch { /* ignore */ }
    return new Promise((r) => (server ? server.close(() => r()) : r()));
  }

  return { start, stop, connectionInfo };
}

module.exports = { createApi };
