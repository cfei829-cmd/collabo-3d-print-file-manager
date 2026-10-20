'use strict';
const fs = require('fs/promises');
const path = require('path');
const { idOf } = require('./store');

const EXTS = new Set(['.stl', '.obj', '.3mf', '.step', '.stp', '.iges', '.igs']);
const SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'system volume information']);

async function scanDir(root) {
  const out = [];
  async function walk(dir, depth) {
    if (depth > 24) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name.toLowerCase())) continue;
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!EXTS.has(ext)) continue;
        try {
          const st = await fs.stat(full);
          out.push({
            id: idOf(full), path: full, root, dir: dir, name: e.name,
            ext: ext.slice(1) === 'stp' ? 'step' : ext.slice(1) === 'igs' ? 'iges' : ext.slice(1),
            size: st.size, mtimeMs: Math.round(st.mtimeMs)
          });
        } catch { /* file vanished */ }
      }
    }
  }
  await walk(root, 0);
  return out;
}

module.exports = { scanDir, EXTS };
