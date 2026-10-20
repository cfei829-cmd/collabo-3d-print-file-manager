'use strict';
// 3MF 内嵌预览图提取：只读 zip 中央目录，不解析几何。
const fs = require('fs');
const zlib = require('zlib');

const CANDIDATES = [
  /^metadata\/plate_1_small\.png$/i,
  /^metadata\/thumbnail\.png$/i,
  /^thumbnails\/thumbnail\.png$/i,
  /^metadata\/plate_1\.png$/i,
  /^thumbnail\.png$/i,
  /^metadata\/.*\.png$/i,
  /^thumbnails\/.*\.png$/i
];

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, pos);
  return n === len ? buf : buf.subarray(0, n);
}

/** @returns {Buffer|null} PNG bytes */
function extractPreview(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < 22) return null;
    const tailLen = Math.min(size, 65557);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOff = tail.readUInt32LE(eocd + 16);
    if (cdOff === 0xffffffff || cdSize > 16 * 1024 * 1024) return null;
    const cd = readAt(fd, cdOff, cdSize);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const method = cd.readUInt16LE(p + 10);
      const csize = cd.readUInt32LE(p + 20);
      const usize = cd.readUInt32LE(p + 24);
      const nlen = cd.readUInt16LE(p + 28);
      const xlen = cd.readUInt16LE(p + 30);
      const clen = cd.readUInt16LE(p + 32);
      const off = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nlen);
      entries.push({ name, method, csize, usize, off });
      p += 46 + nlen + xlen + clen;
    }
    for (const re of CANDIDATES) {
      const hits = entries.filter((e) => re.test(e.name) && e.usize > 0 && e.usize < 8 * 1024 * 1024);
      if (!hits.length) continue;
      hits.sort((a, b) => a.usize - b.usize);
      const e = re === CANDIDATES[0] || re === CANDIDATES[1] ? hits[0] : hits[hits.length - 1];
      const lh = readAt(fd, e.off, 30);
      if (lh.readUInt32LE(0) !== 0x04034b50) continue;
      const dataOff = e.off + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const raw = readAt(fd, dataOff, e.csize);
      const png = e.method === 0 ? raw : e.method === 8 ? zlib.inflateRawSync(raw) : null;
      if (png && png.length > 8 && png[0] === 0x89 && png[1] === 0x50) return png;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

module.exports = { extractPreview };
