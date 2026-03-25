/**
 * WBXML encoder/decoder for Exchange ActiveSync.
 *
 * WBXML 1.3 (WAP Binary XML) with EAS code pages.
 * Reference: MS-ASWBXML, WBXML 1.3 spec (WAP-192-WBXML-20010725-a)
 */

import { CODE_PAGES, lookupTag, encodeTag, PAGE_BY_NAME } from './protocol.js';

const WBXML_VERSION = 0x03;   // WBXML 1.3
const PUBLIC_ID     = 0x01;   // Unknown / literal public identifier
const CHARSET_UTF8  = 0x6A;   // 106 = UTF-8

// Global tokens
const T_SWITCH_PAGE = 0x00;
const T_END         = 0x01;
const T_ENTITY      = 0x02;
const T_STR_I       = 0x03;   // Inline string (null-terminated UTF-8)
const T_STR_T       = 0x83;   // String from string table (we don't use this)
const T_OPAQUE      = 0xC3;   // Opaque data block

// Tag token flags
const HAS_CHILDREN  = 0x40;
const HAS_ATTRS     = 0x80;
const TAG_MASK      = 0x3F;

// ─────────────────────────────────────────────────────────────────
// Decode WBXML bytes → JS object tree
// ─────────────────────────────────────────────────────────────────

/**
 * Node shape: { ns: pageIndex, tag: string, children: Node[], text: string }
 */
export function decode(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let pos = 0;

  function readByte() { return bytes[pos++]; }

  function readMbUint() {
    let value = 0;
    let b;
    do { b = readByte(); value = (value << 7) | (b & 0x7F); } while (b & 0x80);
    return value;
  }

  function readCStr() {
    let s = '';
    let b;
    while ((b = readByte()) !== 0) s += String.fromCharCode(b);
    return decodeURIComponent(escape(s)); // UTF-8 decode
  }

  // Header
  const version   = readByte();  // 0x03
  const publicId  = readMbUint();
  const charset   = readMbUint();
  const strtblLen = readMbUint();
  pos += strtblLen; // skip string table (EAS never uses it)

  if (version !== WBXML_VERSION) {
    throw new Error(`Unexpected WBXML version: 0x${version.toString(16)}`);
  }

  let currentPage = 0;

  function readNode() {
    while (pos < bytes.length) {
      const token = readByte();

      if (token === T_SWITCH_PAGE) {
        currentPage = readByte();
        continue;
      }

      if (token === T_END) return null; // end of parent element

      if (token === T_STR_I) {
        // Bare inline string (text node at the top level - unusual but handle)
        return { ns: -1, tag: '#text', children: [], text: readCStr() };
      }

      if (token === T_ENTITY) {
        readMbUint(); // skip entity code point
        continue;
      }

      if (token === T_OPAQUE) {
        const len = readMbUint();
        const data = bytes.slice(pos, pos + len);
        pos += len;
        // Decode as binary (base64) or UTF-8 depending on context
        return { ns: -1, tag: '#opaque', children: [], text: '', data };
      }

      const hasAttrs    = !!(token & HAS_ATTRS);
      const hasChildren = !!(token & HAS_CHILDREN);
      const tagToken    = token & TAG_MASK;

      const tagName = lookupTag(currentPage, tagToken);
      const node = {
        ns: currentPage,
        tag: tagName || `_${tagToken.toString(16)}`,
        children: [],
        text: '',
      };

      if (hasAttrs) {
        // Skip attributes until END token (EAS never uses attrs, but be safe)
        while (readByte() !== T_END) {/* skip */}
      }

      if (hasChildren) {
        const savedPage = currentPage;
        let child;
        while (pos < bytes.length) {
          const peek = bytes[pos];
          if (peek === T_END) { pos++; break; }

          if (peek === T_STR_I) {
            pos++;
            node.text += readCStr();
          } else if (peek === T_SWITCH_PAGE) {
            pos++;
            currentPage = readByte();
          } else if (peek === T_ENTITY) {
            pos++;
            readMbUint();
          } else if (peek === T_OPAQUE) {
            pos++;
            const len = readMbUint();
            node.text = bytes.slice(pos, pos + len);
            pos += len;
          } else {
            child = readNode();
            if (child) node.children.push(child);
          }
        }
        currentPage = savedPage;
      }

      return node;
    }
    return null;
  }

  return readNode();
}

// ─────────────────────────────────────────────────────────────────
// Encode JS object tree → WBXML bytes
// ─────────────────────────────────────────────────────────────────

/**
 * @param {object} node - { ns: pageIndex|pageName, tag: string, children?, text? }
 */
export function encode(node) {
  const out = [];
  out.push(WBXML_VERSION, PUBLIC_ID, CHARSET_UTF8, 0x00); // header (no strtbl)

  let currentPage = 0;

  function writeMbUint(value) {
    if (value === 0) { out.push(0); return; }
    const bytes = [];
    while (value > 0) { bytes.unshift(value & 0x7F); value >>>= 7; }
    for (let i = 0; i < bytes.length - 1; i++) out.push(bytes[i] | 0x80);
    out.push(bytes[bytes.length - 1]);
  }

  function writeStr(str) {
    out.push(T_STR_I);
    const encoded = unescape(encodeURIComponent(str)); // UTF-8 encode
    for (let i = 0; i < encoded.length; i++) out.push(encoded.charCodeAt(i));
    out.push(0); // null terminator
  }

  function writeNode(node) {
    const pageIndex = typeof node.ns === 'string' ? (PAGE_BY_NAME[node.ns] ?? 0) : (node.ns ?? 0);
    const tagInfo = encodeTag(pageIndex, node.tag);
    if (!tagInfo) throw new Error(`Unknown EAS tag: page=${pageIndex} tag=${node.tag}`);

    if (tagInfo.page !== currentPage) {
      out.push(T_SWITCH_PAGE, tagInfo.page);
      currentPage = tagInfo.page;
    }

    const hasChildren = (node.children && node.children.length > 0) ||
                        (node.text !== undefined && node.text !== null && String(node.text) !== '');
    const tokenByte = tagInfo.token | (hasChildren ? HAS_CHILDREN : 0);
    out.push(tokenByte);

    if (hasChildren) {
      if (node.children) {
        for (const child of node.children) writeNode(child);
      }
      if (node.text !== undefined && node.text !== null && String(node.text) !== '') {
        writeStr(String(node.text));
      }
      out.push(T_END);
    }
  }

  writeNode(node);
  return new Uint8Array(out);
}

// ─────────────────────────────────────────────────────────────────
// Builder helpers
// ─────────────────────────────────────────────────────────────────

/**
 * Create an element node.
 * el('AirSync', 'Sync', el('AirSync', 'Collections', ...))
 */
export function el(ns, tag, ...children) {
  return { ns, tag, children: children.flat().filter(Boolean), text: '' };
}

/** Create a text-bearing element. */
export function tel(ns, tag, text) {
  return { ns, tag, children: [], text: String(text) };
}

/** Walk a decoded tree and find first matching node */
export function find(node, ...path) {
  if (!node) return null;
  let cur = node;
  for (const step of path) {
    if (!cur || !cur.children) return null;
    // step can be 'tag' or 'page:tag'
    const [nsHint, tagHint] = step.includes(':') ? step.split(':') : [null, step];
    cur = cur.children.find(c => {
      if (tagHint && c.tag !== tagHint) return false;
      return true;
    }) || null;
  }
  return cur;
}

/** Get text content of first matching node */
export function getText(node, ...path) {
  const found = find(node, ...path);
  return found ? found.text : null;
}

/** Get all children with a given tag */
export function findAll(node, tag) {
  if (!node || !node.children) return [];
  return node.children.filter(c => c.tag === tag);
}
