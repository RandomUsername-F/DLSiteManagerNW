// system/pe-version.js
// Reads the FileDescription string out of a Windows executable's version
// resource (the "File description" shown on the Details tab of the exe's
// Properties). Pure JS, synchronous, reads only the headers and the
// resource section - never the whole (possibly huge) file. Returns null if
// the file isn't a PE, has no version resource, or anything looks off.

const fs = require('fs');

const MAX_SECTION_BYTES = 32 * 1024 * 1024;

function readExact(fd, position, length) {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, position);
  return n < length ? buf.subarray(0, n) : buf;
}

/** Resource-directory entries at `rel` (offset from the resource root). */
function readDirEntries(buf, rootOff, rel) {
  const base = rootOff + rel;
  const named = buf.readUInt16LE(base + 12);
  const ids = buf.readUInt16LE(base + 14);
  const entries = [];
  for (let i = 0; i < named + ids; i++) {
    const e = base + 16 + i * 8;
    entries.push({ id: buf.readUInt32LE(e), offset: buf.readUInt32LE(e + 4), named: i < named });
  }
  return entries;
}

function getFileDescription(exePath) {
  let fd;
  try {
    fd = fs.openSync(exePath, 'r');

    const dos = readExact(fd, 0, 64);
    if (dos.length < 64 || dos.readUInt16LE(0) !== 0x5a4d) return null; // "MZ"
    const peOff = dos.readUInt32LE(0x3c);

    const coff = readExact(fd, peOff, 24);
    if (coff.length < 24 || coff.readUInt32LE(0) !== 0x00004550) return null; // "PE\0\0"
    const numSections = coff.readUInt16LE(6);
    const optSize = coff.readUInt16LE(20);

    const rest = readExact(fd, peOff + 24, optSize + numSections * 40);
    if (rest.length < optSize + numSections * 40 || optSize < 96) return null;

    const dataDirStart = rest.readUInt16LE(0) === 0x20b ? 112 : 96; // PE32+ : PE32
    if (optSize < dataDirStart + 24) return null;
    const resRva = rest.readUInt32LE(dataDirStart + 16); // data directory #2 = resources
    if (!resRva) return null;

    // Section containing the resource directory
    let section = null;
    for (let i = 0; i < numSections; i++) {
      const b = optSize + i * 40;
      const virtualSize = rest.readUInt32LE(b + 8);
      const va = rest.readUInt32LE(b + 12);
      const rawSize = rest.readUInt32LE(b + 16);
      const rawPtr = rest.readUInt32LE(b + 20);
      if (resRva >= va && resRva < va + Math.max(virtualSize, rawSize)) {
        section = { va, rawSize, rawPtr };
        break;
      }
    }
    if (!section) return null;

    const buf = readExact(fd, section.rawPtr, Math.min(section.rawSize, MAX_SECTION_BYTES));
    const rootOff = resRva - section.va;

    // Resource tree: type (RT_VERSION = 16) -> name -> language -> data entry
    const types = readDirEntries(buf, rootOff, 0);
    const versionType = types.find(e => !e.named && e.id === 16 && (e.offset & 0x80000000));
    if (!versionType) return null;

    const names = readDirEntries(buf, rootOff, versionType.offset & 0x7fffffff);
    if (!names.length || !(names[0].offset & 0x80000000)) return null;

    const langs = readDirEntries(buf, rootOff, names[0].offset & 0x7fffffff);
    if (!langs.length || (langs[0].offset & 0x80000000)) return null;

    const dataEntry = rootOff + langs[0].offset;
    const dataRva = buf.readUInt32LE(dataEntry);
    const dataSize = buf.readUInt32LE(dataEntry + 4);
    const blobStart = dataRva - section.va;
    if (blobStart < 0 || blobStart + dataSize > buf.length) return null;
    const blob = buf.subarray(blobStart, blobStart + dataSize);

    // VS_VERSIONINFO: find the "FileDescription" key, the value follows it (4-byte aligned), UTF-16LE, NUL-terminated.
    const key = Buffer.from('FileDescription\0', 'utf16le');
    const keyIdx = blob.indexOf(key);
    if (keyIdx === -1) return null;

    let p = (keyIdx + key.length + 3) & ~3;
    let end = p;
    while (end + 1 < blob.length && (blob[end] | blob[end + 1]) !== 0) end += 2;
    const text = blob.subarray(p, end).toString('utf16le').trim();
    return text || null;
  } catch (e) {
    return null; // unreadable / malformed - metadata is only ever a best-effort hint
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (e) { /* ignore */ }
    }
  }
}

module.exports = { getFileDescription };
