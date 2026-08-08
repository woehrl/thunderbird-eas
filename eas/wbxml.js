/**
 * WBXML 1.3 encoder/decoder for Exchange ActiveSync.
 *
 * Reference: MS-ASWBXML, WAP-192-WBXML-20010725-a.
 *
 * EAS uses a fixed 4-byte header and only four global tokens, so this is a
 * deliberately small subset:
 *
 *   03 01 6a 00   version 1.3 | public id 1 | charset UTF-8 | no string table
 *
 *   0x00 SWITCH_PAGE  followed by one code page byte
 *   0x01 END          closes the most recently opened element
 *   0x03 STR_I        inline NUL-terminated UTF-8 string
 *   0xC3 OPAQUE       length-prefixed binary blob
 *
 * Tag byte: bit 6 (0x40) = has content, bit 7 (0x80) = has attributes.
 * EAS never uses attributes, but the decoder skips them defensively.
 *
 * OPAQUE is not optional: Exchange uses it for policy data in Provision
 * responses and for MIME bodies.
 */

import { lookupTag, encodeTag, pageIndex } from './codepages.js';

const WBXML_VERSION = 0x03;
const PUBLIC_ID     = 0x01;
const CHARSET_UTF8  = 0x6A;   // IANA MIBenum 106

const T_SWITCH_PAGE = 0x00;
const T_END         = 0x01;
const T_ENTITY      = 0x02;
const T_STR_I       = 0x03;
const T_LITERAL     = 0x04;
const T_PI          = 0x43;
const T_STR_T       = 0x83;
const T_OPAQUE      = 0xC3;

const HAS_CONTENT   = 0x40;
const HAS_ATTRS     = 0x80;
const TAG_MASK      = 0x3F;

/** Guard against a hostile or broken server sending pathological nesting. */
const MAX_DEPTH = 256;

const _decoder = new TextDecoder('utf-8', { fatal: false });
const _encoder = new TextEncoder();

// ─────────────────────────────────────────────────────────────────────
// Decode
// ─────────────────────────────────────────────────────────────────────

/**
 * Decode WBXML into a node tree.
 *
 * Node shape: { ns, tag, children, text, data }
 *   ns       code page index the tag was read from
 *   tag      element name, or `_0x12` when the token is unknown
 *   text     concatenated inline string content (OPAQUE decoded as UTF-8)
 *   data     Uint8Array when the content came from an OPAQUE block
 *
 * Returns null for an empty body (a legitimate "no changes" Sync response).
 */
export function decode(buffer) {
  if (!buffer) return null;
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length === 0) return null;

  let pos = 0;
  let currentPage = 0;

  function readByte() {
    if (pos >= bytes.length) throw new Error('WBXML: unexpected end of input');
    return bytes[pos++];
  }

  function readMbUint() {
    let value = 0;
    let b;
    let guard = 0;
    do {
      b = readByte();
      value = (value * 128) + (b & 0x7F);
      if (++guard > 5) throw new Error('WBXML: multi-byte integer too long');
    } while (b & 0x80);
    return value;
  }

  function readCStr() {
    const start = pos;
    while (pos < bytes.length && bytes[pos] !== 0) pos++;
    const str = _decoder.decode(bytes.subarray(start, pos));
    pos++; // consume terminator
    return str;
  }

  function readOpaque() {
    const len = readMbUint();
    if (pos + len > bytes.length) throw new Error('WBXML: opaque length exceeds body');
    const data = bytes.subarray(pos, pos + len);
    pos += len;
    return data;
  }

  // ── Header ────────────────────────────────────────────────────────
  const version = readByte();
  if (version !== WBXML_VERSION) {
    throw new Error(`WBXML: unexpected version 0x${version.toString(16)}`);
  }
  readMbUint();                      // public identifier
  readMbUint();                      // charset
  const strTableLen = readMbUint();  // string table length (EAS: always 0)
  pos += strTableLen;

  /** Consume the children of an open element into `node`. */
  function readContent(node, depth) {
    if (depth > MAX_DEPTH) throw new Error('WBXML: maximum nesting depth exceeded');

    for (;;) {
      if (pos >= bytes.length) return;      // truncated body — stop gracefully
      const token = bytes[pos];

      if (token === T_END)         { pos++; return; }
      if (token === T_SWITCH_PAGE) { pos++; currentPage = readByte(); continue; }

      if (token === T_STR_I) { pos++; node.text += readCStr(); continue; }

      if (token === T_OPAQUE) {
        pos++;
        const data = readOpaque();
        node.data  = node.data ? concat(node.data, data) : data;
        node.text += _decoder.decode(data);
        continue;
      }

      if (token === T_ENTITY) { pos++; node.text += entityChar(readMbUint()); continue; }
      if (token === T_STR_T)  { pos++; readMbUint(); continue; }  // string table unused by EAS
      if (token === T_LITERAL){ pos++; readMbUint(); continue; }
      if (token === T_PI)     { pos++; skipAttributes(); continue; }

      const child = readElement(depth + 1);
      if (child) node.children.push(child);
    }
  }

  function skipAttributes() {
    while (pos < bytes.length && bytes[pos] !== T_END) {
      const t = bytes[pos++];
      if (t === T_STR_I)  readCStr();
      else if (t === T_OPAQUE) readOpaque();
      else if (t === T_STR_T || t === T_ENTITY) readMbUint();
    }
    pos++; // consume END
  }

  function readElement(depth) {
    const token = readByte();

    // Global tokens are handled by readContent; reaching one here means the
    // stream is malformed. Skip the byte rather than throwing away the whole
    // response — partial data is more useful than none.
    if (token === T_END || token === T_SWITCH_PAGE) return null;

    const hasAttrs   = !!(token & HAS_ATTRS);
    const hasContent = !!(token & HAS_CONTENT);
    const tagToken   = token & TAG_MASK;
    const tagName    = lookupTag(currentPage, tagToken);

    const node = {
      ns:       currentPage,
      tag:      tagName || `_0x${tagToken.toString(16)}`,
      children: [],
      text:     '',
      data:     null,
    };

    if (hasAttrs) skipAttributes();

    if (hasContent) {
      const savedPage = currentPage;
      readContent(node, depth);
      currentPage = savedPage;   // a page switch inside a child does not leak out
    }

    return node;
  }

  // Skip any leading page switch, then read the single root element.
  while (pos < bytes.length && bytes[pos] === T_SWITCH_PAGE) {
    pos++;
    currentPage = readByte();
  }
  if (pos >= bytes.length) return null;

  return readElement(0);
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function entityChar(code) {
  try { return String.fromCodePoint(code); } catch { return ''; }
}

// ─────────────────────────────────────────────────────────────────────
// Encode
// ─────────────────────────────────────────────────────────────────────

/**
 * Encode a node tree to WBXML.
 *
 * A node with `opaque` (Uint8Array) is written as an OPAQUE block;
 * a node with `text` is written as STR_I. Element order is preserved
 * verbatim — EAS schemas are sequence-ordered, so builders must emit
 * children in schema order.
 */
export function encode(node) {
  const out = [];
  out.push(WBXML_VERSION, PUBLIC_ID, CHARSET_UTF8, 0x00);

  let currentPage = 0;

  function writeMbUint(value) {
    const parts = [];
    do { parts.unshift(value & 0x7F); value = Math.floor(value / 128); } while (value > 0);
    for (let i = 0; i < parts.length - 1; i++) out.push(parts[i] | 0x80);
    out.push(parts[parts.length - 1]);
  }

  function writeStr(str) {
    out.push(T_STR_I);
    const encoded = _encoder.encode(str);
    for (let i = 0; i < encoded.length; i++) {
      // A NUL byte would terminate the inline string early; drop it.
      if (encoded[i] !== 0) out.push(encoded[i]);
    }
    out.push(0);
  }

  function writeOpaque(data) {
    out.push(T_OPAQUE);
    writeMbUint(data.length);
    for (let i = 0; i < data.length; i++) out.push(data[i]);
  }

  function writeNode(n) {
    const page    = pageIndex(n.ns ?? 0);
    const tagInfo = encodeTag(page, n.tag);
    if (!tagInfo) throw new Error(`Unknown EAS tag: ${n.ns}:${n.tag}`);

    if (tagInfo.page !== currentPage) {
      out.push(T_SWITCH_PAGE, tagInfo.page);
      currentPage = tagInfo.page;
    }

    const children  = n.children || [];
    const hasText   = n.text !== undefined && n.text !== null && String(n.text) !== '';
    const hasOpaque = n.opaque instanceof Uint8Array && n.opaque.length > 0;
    const hasContent = children.length > 0 || hasText || hasOpaque;

    out.push(tagInfo.token | (hasContent ? HAS_CONTENT : 0));

    if (!hasContent) return;   // self-closing: no END token

    for (const child of children) writeNode(child);
    if (hasOpaque)   writeOpaque(n.opaque);
    else if (hasText) writeStr(String(n.text));
    out.push(T_END);
  }

  writeNode(node);
  return new Uint8Array(out);
}

// ─────────────────────────────────────────────────────────────────────
// Builders
// ─────────────────────────────────────────────────────────────────────

/** Element node. Falsy children are dropped so callers can inline conditionals. */
export function el(ns, tag, ...children) {
  return { ns, tag, children: children.flat().filter(Boolean), text: '' };
}

/** Text-bearing element. */
export function tel(ns, tag, text) {
  return { ns, tag, children: [], text: String(text) };
}

/** Element carrying binary content, written as an OPAQUE block. */
export function bel(ns, tag, bytes) {
  return { ns, tag, children: [], text: '', opaque: bytes };
}

/** Empty element (written self-closing, no END token). */
export function eel(ns, tag) {
  return { ns, tag, children: [], text: '' };
}

// ─────────────────────────────────────────────────────────────────────
// Tree navigation
// ─────────────────────────────────────────────────────────────────────
//
// Path steps are either a bare tag name ('Status') or namespace-qualified
// ('AirSyncBase:Body'). Qualifying matters: 'Status', 'Body' and 'Data' exist
// on several code pages, and an unqualified lookup happily returns the wrong
// one. The previous implementation parsed the namespace hint and then ignored
// it.

function matches(node, step) {
  const sep = step.indexOf(':');
  if (sep < 0) return node.tag === step;
  const ns  = step.slice(0, sep);
  const tag = step.slice(sep + 1);
  return node.tag === tag && node.ns === pageIndex(ns);
}

/** First descendant reached by following `path` one level at a time. */
export function find(node, ...path) {
  let cur = node;
  for (const step of path) {
    if (!cur || !cur.children) return null;
    cur = cur.children.find(c => matches(c, step)) || null;
  }
  return cur;
}

/** Text content of the node at `path`, or null. */
export function getText(node, ...path) {
  const found = find(node, ...path);
  return found ? found.text : null;
}

/** All direct children matching `step`. */
export function findAll(node, step) {
  if (!node || !node.children) return [];
  return node.children.filter(c => matches(c, step));
}

/** Compact debug rendering of a decoded tree. */
export function dump(node, indent = '') {
  if (!node) return '(empty)';
  const text = node.text ? ` = ${JSON.stringify(node.text.slice(0, 120))}` : '';
  let out = `${indent}${node.tag}${text}\n`;
  for (const child of node.children || []) out += dump(child, `${indent}  `);
  return out;
}
