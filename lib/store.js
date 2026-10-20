'use strict';
// Collabo 3D打印文件管理器 - JSON 索引存储
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const idOf = (p) => crypto.createHash('sha1').update(path.resolve(p).toLowerCase()).digest('hex').slice(0, 16);

class Store {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, dirs: [], files: {}, settings: { theme: 'system' } };
    this.timer = null;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object') this.data = { ...this.data, ...raw };
    } catch { /* first run */ }
  }
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 500);
  }
  flush() {
    clearTimeout(this.timer);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
  get dirs() { return this.data.dirs; }
  get settings() { return this.data.settings; }
  addDir(dir) {
    const full = path.resolve(dir);
    if (this.data.dirs.some((d) => d.toLowerCase() === full.toLowerCase())) return false;
    this.data.dirs.push(full);
    this.save();
    return true;
  }
  removeDir(dir) {
    const lower = path.resolve(dir).toLowerCase();
    this.data.dirs = this.data.dirs.filter((d) => d.toLowerCase() !== lower);
    for (const [id, rec] of Object.entries(this.data.files)) {
      if (rec.root.toLowerCase() === lower) delete this.data.files[id];
    }
    this.save();
  }
  all() { return Object.values(this.data.files); }
  get(id) { return this.data.files[id] || null; }
  /** 用扫描结果替换某个根目录下的记录，保留已有缩略图信息 */
  applyScan(root, found) {
    const keep = new Set();
    let added = 0;
    for (const f of found) {
      keep.add(f.id);
      const old = this.data.files[f.id];
      if (old && old.mtimeMs === f.mtimeMs && old.size === f.size) continue;
      this.data.files[f.id] = { ...f, thumb: null, thumbFail: 0, info: null };
      added++;
    }
    let removed = 0;
    for (const [id, rec] of Object.entries(this.data.files)) {
      if (rec.root === root && !keep.has(id)) { delete this.data.files[id]; removed++; }
    }
    if (added || removed) this.save();
    return { added, removed };
  }
  patch(id, fields) {
    const rec = this.data.files[id];
    if (!rec) return null;
    Object.assign(rec, fields);
    this.save();
    return rec;
  }
}

module.exports = { Store, idOf };
