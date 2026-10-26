import assert from "node:assert/strict";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const table = Uint32Array.from({ length: 256 }, (_, number) => {
  for (let bit = 0; bit < 8; bit++) number = number & 1 ? 0xedb88320 ^ number >>> 1 : number >>> 1;
  return number >>> 0;
});
export function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = table[(crc ^ byte) & 255] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}

// ZIP32, fixed timestamps, UTF-8 paths and a fixed compression level make identical inputs reproducible.
export function createZip(files) {
  assert.ok(files.length < 65535);
  const local = [], central = [];
  let offset = 0;
  for (const { path, data } of files) {
    const name = Buffer.from(path);
    const compressed = deflateRawSync(data, { level: 9 });
    const checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8); record.writeUInt16LE(8, 10); record.writeUInt16LE(33, 14);
    record.writeUInt32LE(checksum, 16); record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + compressed.length;
    assert.ok(offset < 0xffffffff, "Release exceeds ZIP32 size");
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export function readZip(archive) {
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50);
  let cursor = archive.readUInt32LE(end + 16);
  const files = [];
  for (let index = 0; index < archive.readUInt16LE(end + 10); index++) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50);
    assert.equal(archive.readUInt16LE(cursor + 10), 8);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const path = archive.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    assert.ok(path && !path.startsWith("/") && !path.split("/").some(part => ["", ".", ".."].includes(part)) && !/[\\:]/.test(path), "Unsafe ZIP path");
    const local = archive.readUInt32LE(cursor + 42);
    assert.equal(archive.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const size = archive.readUInt32LE(cursor + 24);
    const data = inflateRawSync(archive.subarray(start, start + archive.readUInt32LE(cursor + 20)), { maxOutputLength: size || 1 });
    assert.equal(data.length, size);
    assert.equal(crc32(data), archive.readUInt32LE(cursor + 16));
    files.push({ path, data });
    cursor += 46 + nameLength + archive.readUInt16LE(cursor + 30) + archive.readUInt16LE(cursor + 32);
  }
  assert.equal(cursor, end);
  assert.equal(new Set(files.map(file => file.path)).size, files.length);
  return files;
}
