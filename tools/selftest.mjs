#!/usr/bin/env node
/**
 * Protocol self-test — run with `node tools/selftest.mjs`.
 *
 * The WBXML code page tables are the one part of this add-on where a silent
 * off-by-one produces requests that servers answer with a generic protocol
 * error and nothing else. That failure mode cost this project its first
 * working release, so the tables are pinned here against byte-level
 * measurements rather than trusted.
 *
 * No dependencies, no test framework: Node's stdlib only.
 */

import { verifyCodePages, encodeTag } from '../eas/codepages.js';
import { encode, decode, dump, el, tel, eel } from '../eas/wbxml.js';
import {
  buildFolderSync, parseFolderSync,
  buildSync, parseSync,
  buildSettings, buildDeviceInformation, buildItemOperationsFetch,
} from '../eas/commands.js';
import { STATUS, DEVICE_BLOCKED_STATUS } from '../eas/protocol.js';

let failures = 0;
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(' ');

function check(name, actual, expected) {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    console.log(`      expected: ${expected}`);
    console.log(`      actual:   ${actual}`);
  }
}

// ── 1. Table consistency ────────────────────────────────────────────
check('code page tables consistent', verifyCodePages().join('; ') || 'none', 'none');

// Tokens that were wrong in the first implementation and broke every Sync
// and every Settings request.
check('AirSync:CollectionId',       '0x' + encodeTag('AirSync', 'CollectionId').token.toString(16), '0x12');
check('AirSync:Collections',        '0x' + encodeTag('AirSync', 'Collections').token.toString(16), '0x1c');
check('AirSync:ApplicationData',    '0x' + encodeTag('AirSync', 'ApplicationData').token.toString(16), '0x1d');
check('AirSync:Commands',           '0x' + encodeTag('AirSync', 'Commands').token.toString(16), '0x16');
check('AirSync:Options',            '0x' + encodeTag('AirSync', 'Options').token.toString(16), '0x17');
check('AirSync:WindowSize',         '0x' + encodeTag('AirSync', 'WindowSize').token.toString(16), '0x15');
check('AirSync:MIMESupport',        '0x' + encodeTag('AirSync', 'MIMESupport').token.toString(16), '0x22');
check('Settings:DeviceInformation', '0x' + encodeTag('Settings', 'DeviceInformation').token.toString(16), '0x16');
check('Settings:Model',             '0x' + encodeTag('Settings', 'Model').token.toString(16), '0x17');
check('Settings:UserAgent',         '0x' + encodeTag('Settings', 'UserAgent').token.toString(16), '0x20');

// ── 2. FolderSync SyncKey=0 ─────────────────────────────────────────
// Measured reference: the smallest meaningful EAS request is 13 bytes.
const folderSync0 = encode(buildFolderSync('0'));
check('FolderSync(0) bytes',  hex(folderSync0), '03 01 6a 00 00 07 56 52 03 30 00 01 01');
check('FolderSync(0) length', folderSync0.length, 13);

// ── 3. A real server response ───────────────────────────────────────
// 15 bytes captured from Exchange 2019: <FolderSync><Status>142</Status></FolderSync>
const measured = new Uint8Array([
  0x03, 0x01, 0x6a, 0x00,
  0x00, 0x07,
  0x56,                          // FolderSync | content
  0x4c,                          // Status     | content
  0x03, 0x31, 0x34, 0x32, 0x00,  // STR_I "142"
  0x01, 0x01,
]);
check('measured 142 response', parseFolderSync(decode(measured)).status, '142');

// ── 4. Sync request shape ───────────────────────────────────────────
const priming = decode(encode(buildSync({ syncKey: '0', collectionId: '5' })));
check('priming Sync is bare',
  priming.children[0].children[0].children.map(c => c.tag).join(','), 'SyncKey,CollectionId');

const fullSync = decode(encode(buildSync({
  syncKey: '7', collectionId: '5', windowSize: 100, getChanges: true,
  readChanges: [{ serverId: '5:1', read: true }],
})));
const collection = fullSync.children[0].children[0];
check('full Sync element order',
  collection.children.map(c => c.tag).join(','),
  'SyncKey,CollectionId,DeletesAsMoves,GetChanges,WindowSize,Options,Commands');
check('read change is wrapped in ApplicationData',
  collection.children.at(-1).children[0].children.map(c => c.tag).join(','),
  'ServerId,ApplicationData');

// ── 5. Response parsing, including UTF-8 ────────────────────────────
const response = encode(
  el('AirSync', 'Sync',
    el('AirSync', 'Collections',
      el('AirSync', 'Collection',
        tel('AirSync', 'SyncKey', '8'),
        tel('AirSync', 'CollectionId', '5'),
        tel('AirSync', 'Status', '1'),
        el('AirSync', 'Commands',
          el('AirSync', 'Add',
            tel('AirSync', 'ServerId', '5:42'),
            el('AirSync', 'ApplicationData',
              tel('Email', 'Read', '0'),
              tel('Email', 'Subject', 'Grüße'),
              el('AirSyncBase', 'Body',
                tel('AirSyncBase', 'Type', '4'),
                tel('AirSyncBase', 'Truncated', '1'),
                tel('AirSyncBase', 'Data', 'From: a@b\r\n\r\nBödy')))))))));

const parsed = parseSync(decode(response));
const item = parsed.collections[0].added[0];
check('response collection id', parsed.collections[0].collectionId, '5');
check('response sync key',      parsed.collections[0].syncKey, '8');
check('item server id',         item.serverId, '5:42');
check('item read flag',         item.read, false);
check('item truncated',         item.truncated, true);
check('subject survives UTF-8', item.subject, 'Grüße');
check('MIME survives UTF-8',    item.mime, 'From: a@b\r\n\r\nBödy');

// ── 6. Remaining builders must not reference an unknown tag ─────────
const profile = {
  model: 'iPhone', friendlyName: 'TB', os: 'iOS 17', osLanguage: 'de-DE', userAgent: 'UA',
};
check('Settings encodes', encode(buildSettings(profile)).length > 0, true);
check('ItemOperations encodes', encode(buildItemOperationsFetch('5', '5:42')).length > 0, true);

// ── 6b. Provision must be able to carry DeviceInformation ───────────
// From 14.1 Exchange answers status 165 (DeviceInformationRequired) to a
// Provision request that omits it, before issuing any policy. The element has
// to come before Policies.
const provisionWithDeviceInfo = decode(encode(
  el('Provision', 'Provision',
    buildDeviceInformation(profile, { email: 'user@example.org' }),
    el('Provision', 'Policies',
      el('Provision', 'Policy',
        tel('Provision', 'PolicyType', 'MS-EAS-Provisioning-WBXML'))))));

check('Provision child order',
  provisionWithDeviceInfo.children.map(c => c.tag).join(','), 'DeviceInformation,Policies');
check('DeviceInformation field order',
  provisionWithDeviceInfo.children[0].children[0].children.map(c => c.tag).join(','),
  'Model,FriendlyName,OS,OSLanguage,UserAgent');

// 165 is DeviceInformationRequired, not a device block. Treating it as a block
// silences the account for half an hour instead of sending the one element the
// server is asking for — the exact mistake this project shipped with.
check('165 is DeviceInformationRequired', STATUS.DEVICE_INFORMATION_REQUIRED, '165');
check('165 is not treated as a block', DEVICE_BLOCKED_STATUS.has('165'), false);
check('177 is treated as a block',     DEVICE_BLOCKED_STATUS.has('177'), true);
check('129 is treated as a block',     DEVICE_BLOCKED_STATUS.has('129'), true);

// ── 7. OPAQUE ───────────────────────────────────────────────────────
// Exchange sends policy data and MIME bodies as OPAQUE, so a decoder that
// only understands STR_I loses them.
const opaqueDoc = decode(new Uint8Array([
  0x03, 0x01, 0x6a, 0x00,
  0x00, 0x0e,                    // switch to Provision
  0x45,                          // Provision | content
  0x4a,                          // Data      | content
  0xc3, 0x03, 0x41, 0x42, 0x43,  // OPAQUE, length 3, "ABC"
  0x01, 0x01,
]));
check('opaque decoded as text',  opaqueDoc.children[0].text, 'ABC');
check('opaque kept as bytes',    opaqueDoc.children[0].data?.length, 3);

// ── 8. Self-closing elements carry no END token ─────────────────────
const sendMail = decode(encode(el('ComposeMail', 'SendMail',
  tel('ComposeMail', 'ClientId', 'x'),
  eel('ComposeMail', 'SaveInSentItems'),
  tel('ComposeMail', 'Mime', 'hi'))));
check('self-closing element preserved',
  sendMail.children.map(c => c.tag).join(','), 'ClientId,SaveInSentItems,Mime');

if (process.argv.includes('--verbose')) {
  console.log('\nfull Sync request:\n' + dump(fullSync));
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures ? 1 : 0);
