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

  const api_notes = (id, text) => js(`window.collabo.setNotes(${JSON.stringify(id)}, ${JSON.stringify(text)})`);
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

      // 选择：Ctrl 多选 + 右栏详情 + 备注
      const ids = await js('window.__collabo.ids()');
      await js(`window.__collabo.select(${JSON.stringify(ids.slice(0, 2))})`);
      const sel2 = await js('window.__collabo.selected().length');
      const insp = await js("document.getElementById('insp-body').textContent");
      check('multi select + inspector', sel2 === 2 && insp.includes('已选中 2'), insp.slice(0, 40));
      await shot('selected');
      check('save notes', (await api_notes(first.id, '自测备注')) === true && store.get(first.id).notes === '自测备注');

      // 批量改名（在临时副本上做，不动测试数据）
      const os = require('os');
      const path = require('path');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'collabo-rn-'));
      for (const n of ['body.stl', 'lid.stl']) fs.copyFileSync(path.join(process.env.COLLABO_TEST_DIR, n), path.join(tmp, n));
      await addDir(tmp);
      await sleep(1500);
      const rec = store.all().filter((r) => r.dir.toLowerCase() === path.resolve(tmp).toLowerCase()).sort((a, b) => a.name.localeCompare(b.name));
      const rr = await js(`window.collabo.renameFiles(${JSON.stringify(rec.map((r, i) => ({ id: r.id, newName: 'part_0' + (i + 1) + '.stl' })))})`);
      check('batch rename ok', rr.ok === true && fs.existsSync(path.join(tmp, 'part_01.stl')) && fs.existsSync(path.join(tmp, 'part_02.stl')), JSON.stringify(rr));
      const bad = await js(`window.collabo.renameFiles(${JSON.stringify([{ id: store.all().find((r) => r.name === 'part_01.stl').id, newName: 'x.obj' }])})`);
      check('rename rejects ext change', bad.ok === false, bad.error);
      const dup = await js(`window.collabo.renameFiles(${JSON.stringify(store.all().filter((r) => r.dir.toLowerCase() === path.resolve(tmp).toLowerCase()).map((r) => ({ id: r.id, newName: 'same.stl' })))})`);
      check('rename rejects duplicate names', dup.ok === false, dup.error);
      await js(`window.collabo.removeDir(${JSON.stringify(tmp)})`);
      fs.rmSync(tmp, { recursive: true, force: true });
      await sleep(500);

      // 预览：默认 Support Fins 编辑视口（iframe），可切换到基础预览
      await js(`window.__collabo.open(${JSON.stringify(first.id)})`);
      let fm = '';
      for (let i = 0; i < 40; i++) { await sleep(500); fm = await js("document.getElementById('v-msg').textContent"); if (fm === '') break; }
      const src = await js("document.getElementById('v-fins').src");
      check('support fins viewport loads', fm === '' && src.startsWith('http://127.0.0.1:'), src.slice(0, 40) + ' ' + fm);
      await sleep(3000);
      await shot('fins');
      await js("document.getElementById('v-mode-basic').click()");
      await sleep(2500);
      const msg = await js("document.getElementById('v-msg').textContent");
      check('basic viewer loads model', msg === '', msg);
      await shot('viewer');
      await js("document.getElementById('v-close').click()");

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
