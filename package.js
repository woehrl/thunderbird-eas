#!/usr/bin/env node
/**
 * Build script: packages the add-on as a .xpi file.
 * Run: node package.js
 */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// Minimal ZIP implementation (no dependencies)
class ZipWriter {
  constructor() {
    this.files   = [];
    this.central = [];
    this.offset  = 0;
  }

  addFile(name, data) {
    const nameBuf = Buffer.from(name);
    const crc     = crc32(data);
    const local   = Buffer.concat([
      Buffer.from([0x50,0x4B,0x03,0x04]), // signature
      Buffer.from([0x14,0x00]),            // version needed
      Buffer.from([0x00,0x00]),            // flags
      Buffer.from([0x00,0x00]),            // compression: stored
      Buffer.from([0x00,0x00,0x00,0x00]), // mod time/date
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),                             // extra length
      nameBuf,
      data,
    ]);

    const central = Buffer.concat([
      Buffer.from([0x50,0x4B,0x01,0x02]), // central dir signature
      Buffer.from([0x14,0x00]),            // version made by
      Buffer.from([0x14,0x00]),            // version needed
      Buffer.from([0x00,0x00]),            // flags
      Buffer.from([0x00,0x00]),            // compression
      Buffer.from([0x00,0x00,0x00,0x00]), // mod time/date
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0), u16(0), u16(0), u16(0),    // extra, comment, disk, int attrs
      u32(0),                             // ext attrs
      u32(this.offset),
      nameBuf,
    ]);

    this.files.push(local);
    this.central.push(central);
    this.offset += local.length;
  }

  build() {
    const centralBuf = Buffer.concat(this.central);
    const eocd = Buffer.concat([
      Buffer.from([0x50,0x4B,0x05,0x06]),
      u16(0), u16(0),
      u16(this.central.length),
      u16(this.central.length),
      u32(centralBuf.length),
      u32(this.offset),
      u16(0),
    ]);
    return Buffer.concat([...this.files, centralBuf, eocd]);
  }
}

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }

function crc32(buf) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function walk(dir, base = '') {
  const result = [];
  for (const entry of fs.readdirSync(dir)) {
    const full  = path.join(dir, entry);
    const rel   = base ? `${base}/${entry}` : entry;
    const stat  = fs.statSync(full);
    if (stat.isDirectory()) result.push(...walk(full, rel));
    else                    result.push({ full, rel });
  }
  return result;
}

// ── Main ──────────────────────────────────────────────────────────
//
// Usage:
//   node package.js              → standard build (no experiments API)
//   node package.js --privileged → privileged build (includes experiment_apis;
//                                   requires extensions.experiments.enabled=true
//                                   in Thunderbird about:config)

const privileged = process.argv.includes('--privileged');

const EXPERIMENT_API_BLOCK = `,

  "experiment_apis": {
    "easAccount": {
      "schema": "experiments/schema.json",
      "parent": {
        "scopes":  ["addon_parent"],
        "script":  "experiments/implementation.js",
        "events":  ["startup"]
      }
    }
  }`;

const root    = __dirname;
const distDir = path.join(root, 'dist');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const version = manifest.version;
const suffix  = privileged ? '-privileged' : '';
const out     = path.join(distDir, `thunderbird-eas-${version}${suffix}-${Date.now()}.xpi`);
const zip     = new ZipWriter();
const skip    = new Set(['package.js', 'README.md', 'DEVELOPMENT.md', '.git', 'dist']);

if (!fs.existsSync(distDir)) fs.mkdirSync(distDir);

for (const { full, rel } of walk(root)) {
  if (skip.has(rel.split('/')[0])) continue;
  if (rel.startsWith('.')) continue;
  if (rel.endsWith('.xpi')) continue;

  let data = fs.readFileSync(full);

  // Inject experiment_apis into manifest.json for the privileged build
  if (privileged && rel === 'manifest.json') {
    let text = data.toString('utf8');
    // Insert before the closing brace
    text = text.replace(/(\n\})\s*$/, `${EXPERIMENT_API_BLOCK}\n}`);
    data = Buffer.from(text, 'utf8');
  }

  zip.addFile(rel, data);
  console.log(' +', rel);
}

fs.writeFileSync(out, zip.build());
console.log(`\nPackaged: ${path.relative(root, out)} (${fs.statSync(out).size} bytes)`);
if (privileged) {
  console.log('PRIVILEGED build: requires extensions.experiments.enabled=true in about:config');
  console.log('  → Extras → Einstellungen → Allgemein → scroll to bottom → Konfigurationseditor');
  console.log('  → Search: extensions.experiments.enabled → set to true → then install this .xpi');
} else {
  console.log('Standard build: uses Local Folders fallback (no about:config change needed)');
  console.log('For real account node: node package.js --privileged');
}
console.log('Install via Thunderbird: Add-ons Manager → Install Add-on From File');
