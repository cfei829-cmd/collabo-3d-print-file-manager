'use strict';
// Support Fins 网页版本地托管：静态资源 + 单个已索引模型的临时下载链接。仅 127.0.0.1。
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};

function createFins({ webRoot, store }) {
  let server = null;
  let ready = null;
  const grants = new Map(); // token -> {file, expires}

  function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const host = String(req.headers.host || '');
    if (!/^127\.0\.0\.1:\d+$/.test(host) && !/^localhost:\d+$/.test(host)) { res.writeHead(403).end(); return; }
    const gm = /^\/models\/([0-9a-f]{64})\//.exec(url.pathname);
    if (gm) {
      const g = grants.get(gm[1]);
      if (!g || g.expires < Date.now()) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(g.file).on('error', () => res.destroy()).pipe(res);
      return;
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.resolve(webRoot, '.' + rel);
    if (!file.startsWith(path.resolve(webRoot) + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  }

  function ensure() {
    if (!ready) {
      ready = new Promise((resolve, reject) => {
        server = http.createServer(handle);
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
      });
    }
    return ready;
  }

  async function previewUrl(id) {
    const rec = store.get(id);
    if (!rec) throw new Error('not indexed');
    const origin = await ensure();
    const token = crypto.randomBytes(32).toString('hex');
    grants.set(token, { file: rec.path, expires: Date.now() + 10 * 60 * 1000 });
    const modelUrl = `${origin}/models/${token}/${encodeURIComponent(rec.name)}`;
    return `${origin}/?stl=${encodeURIComponent(modelUrl)}&all=1`;
  }

  function stop() {
    return new Promise((r) => (server ? server.close(() => r()) : r()));
  }
  return { previewUrl, stop };
}

module.exports = { createFins };
