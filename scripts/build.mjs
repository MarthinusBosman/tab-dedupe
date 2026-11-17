// Builds dist/tab-dedupe-<version>.zip (the store upload). Run: node scripts/build.mjs
// Small built-in zip writer: no dependencies, forward-slash paths (PowerShell's Compress-Archive writes
// backslashes on Windows PowerShell 5.1, which the stores reject).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { EXTENSION_FILES } from "./files.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

function walk(rel) {
  const abs = path.join(ROOT, rel);
  if (fs.statSync(abs).isDirectory()) return fs.readdirSync(abs).sort().flatMap((f) => walk(path.posix.join(rel, f)));
  return [rel];
}

export function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    const nameBuf = Buffer.from(name, "utf8");
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt16LE(0, 10); head.writeUInt16LE(0x21, 12); // fixed DOS time/date (1980-01-01) so builds are reproducible
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(deflated.length, 18); head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26); head.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(deflated.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(head, nameBuf, deflated);
    centrals.push(central, nameBuf);
    offset += head.length + nameBuf.length + deflated.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const files = EXTENSION_FILES.flatMap(walk);
const out = path.join(ROOT, "dist", `tab-dedupe-${version}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, zip(files.map((name) => ({ name, data: fs.readFileSync(path.join(ROOT, name)) }))));
console.log(`${path.relative(ROOT, out)}: ${files.length} files`);
