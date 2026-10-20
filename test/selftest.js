'use strict';
// 端到端自测：COLLABO_SELFTEST=1 COLLABO_USERDATA=<tmp> COLLABO_TEST_DIR=<含模型的目录> COLLABO_SHOT=<输出前缀> electron .
const fs = require('fs');
const http = require('http');

module.exports = function selftest({ app, win, store, addDir, api }) {
  const out = process.env.COLLABO_SHOT || 'selftest';
  const log = (m) => console.log('[selftest] ' + m);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win().webContents.executeJavaScript(code);
  const shot = async (name) => {
    const img = await win().webContents.capturePage();
    fs.writeFileSync(`${out}-${name}.png`, img.toPNG());
    log('screenshot ' + name);
  };
  const get = (url, token, method = 'GET', body) => new Promise((resolve) => {
    const req = http.request(url, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    if (body) req.write(body);
    req.end();
  });

  (async () => {
    let failed = 0;
    const check = (name, ok, extra = '') => { log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' - ' + extra : '')); if (!ok) failed++; };
    try {
      await new Promise((r) => win().webContents.once('did-finish-load', r));
      await sleep(500);
      await addDir(process.env.COLLABO_TEST_DIR);
      let s;
      for (let i = 0; i < 240; i++) {
        await sleep(500);
        s = await js('window.__collabo.summary()');
        if (s.files > 0 && !s.busy && i > 4) break;
      }
      log('summary ' + JSON.stringify(s));
      check('indexed files', s.files > 0, String(s.files));
      check('real thumbnails rendered', s.real > 0, `${s.real}/${s.files} (failed ${s.failed})`);
      await shot('grid');

      const all = store.all();
      const first = all.find((r) => r.thumb === 'real') || all[0];
      await js(`window.__collabo.open(${JSON.stringify(first.id)})`);
      await sleep(2500);
      const msg = await js("document.getElementById('v-msg').textContent");
      check('viewer loads model', msg === '', msg);
      await shot('viewer');

      const info = api.connectionInfo();
      const h = await get(info.apiUrl + '/health', info.token);
      check('api health', h.status === 200, h.body);
      const noauth = await get(info.apiUrl + '/health', 'wrong');
      check('api rejects bad token', noauth.status === 401);
      const list = await get(info.apiUrl + '/models?pageSize=5', info.token);
      check('api list models', list.status === 200 && JSON.parse(list.body).total === all.length);
      const mc = await get(info.mcpUrl, info.token, 'POST', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
      check('mcp tools/list', mc.status === 200 && JSON.parse(mc.body).result.tools.length === 3);
    } catch (e) {
      failed++;
      log('ERROR ' + (e && e.stack || e));
    }
    log(failed ? `DONE with ${failed} failure(s)` : 'DONE all passed');
    app.exit(failed ? 1 : 0);
  })();
};
