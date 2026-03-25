/**
 * EAS command builders and response parsers.
 *
 * Implemented commands:
 *   FolderSync   – sync folder hierarchy
 *   Sync         – sync email items (fetch changes, read flag, delete)
 *   MoveItems    – move message to another folder
 *   ItemFetch    – fetch single item (full MIME)
 */

import { el, tel, encode, decode, findAll, find, getText } from './wbxml.js';
import { BODY_TYPE, FOLDER_TYPE_NAME } from './protocol.js';

// ─────────────────────────────────────────────────────────────────
// FolderSync
// ─────────────────────────────────────────────────────────────────

/**
 * Build FolderSync WBXML request.
 * @param {string} syncKey  '0' = initial sync
 */
export function buildFolderSync(syncKey) {
  return encode(
    el('FolderHierarchy', 'FolderSync',
      tel('FolderHierarchy', 'SyncKey', syncKey)
    )
  );
}

/**
 * Parse FolderSync response.
 * Returns { syncKey, status, added: [], deleted: [], updated: [] }
 */
export function parseFolderSync(buf) {
  const doc = decode(buf);
  const root = doc.tag === 'FolderSync' ? doc : find(doc, 'FolderSync');
  if (!root) throw new Error('FolderSync: missing root element');

  const status   = getText(root, 'Status') || '0';
  const syncKey  = getText(root, 'SyncKey') || '0';
  const changes  = find(root, 'Changes');

  const result = { syncKey, status, added: [], deleted: [], updated: [] };

  if (changes) {
    for (const child of changes.children) {
      const folder = {
        serverId:    getText(child, 'ServerId'),
        parentId:    getText(child, 'ParentId'),
        displayName: getText(child, 'DisplayName'),
        type:        parseInt(getText(child, 'Type') || '1', 10),
        typeName:    FOLDER_TYPE_NAME[parseInt(getText(child, 'Type') || '1', 10)] || null,
      };
      if (child.tag === 'Add')    result.added.push(folder);
      if (child.tag === 'Delete') result.deleted.push({ serverId: getText(child, 'ServerId') });
      if (child.tag === 'Update') result.updated.push(folder);
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────
// Sync
// ─────────────────────────────────────────────────────────────────

/**
 * Build Sync request for a single folder.
 *
 * @param {string} syncKey
 * @param {string} collectionId   EAS ServerId of folder
 * @param {object} [opts]
 * @param {number} [opts.windowSize=50]  max items per response
 * @param {boolean} [opts.getChanges]    false = push changes only
 * @param {string[]} [opts.fetchIds]     explicit item IDs to fetch
 * @param {string[]} [opts.deleteIds]    items to delete on server
 * @param {object[]} [opts.readChanges]  [{serverId, read}] flag updates
 */
export function buildSync(syncKey, collectionId, opts = {}) {
  const {
    windowSize  = 50,
    getChanges  = true,
    fetchIds    = [],
    deleteIds   = [],
    readChanges = [],
  } = opts;

  // Note: CollectionId lives in the GetItemEstimate code page (6) in WBXML,
  // even when used inside a Sync Collection element.
  // WindowSize goes directly on Collection, not inside Options.
  // ApplicationData is not a real WBXML element; properties go directly in Change.

  const options = el('AirSync', 'Options',
    el('AirSyncBase', 'BodyPreference',
      tel('AirSyncBase', 'Type', String(BODY_TYPE.MIME)),
    ),
  );

  const commands = [];

  for (const id of fetchIds) {
    commands.push(el('AirSync', 'Fetch', tel('AirSync', 'ServerId', id)));
  }

  for (const id of deleteIds) {
    commands.push(el('AirSync', 'Delete', tel('AirSync', 'ServerId', id)));
  }

  for (const { serverId, read } of readChanges) {
    // Properties placed directly inside Change (no ApplicationData wrapper in WBXML)
    commands.push(
      el('AirSync', 'Change',
        tel('AirSync', 'ServerId', serverId),
        tel('Email', 'Read', read ? '1' : '0'),
      )
    );
  }

  const collectionEl = el('AirSync', 'Collection',
    tel('AirSync', 'Class', 'Email'),
    tel('AirSync', 'SyncKey', syncKey),
    tel('GetItemEstimate', 'CollectionId', collectionId), // SWITCH_PAGE to page 6
    tel('AirSync', 'WindowSize', String(windowSize)),
    options,
    commands.length > 0 ? el('AirSync', 'Commands', ...commands) : null,
  );

  return encode(
    el('AirSync', 'Sync',
      el('AirSync', 'Collections', collectionEl)
    )
  );
}

/**
 * Parse Sync response.
 * Returns { syncKey, status, collectionId, moreAvailable, added[], changed[], deleted[] }
 *
 * Each added/changed item: { serverId, mime }
 * deleted item: { serverId }
 */
export function parseSync(buf) {
  const doc = decode(buf);

  // Empty 200 with no body means no changes
  if (!doc) return null;

  const root = doc.tag === 'Sync' ? doc : find(doc, 'Sync');
  if (!root) return null;

  const collection = find(root, 'Collections', 'Collection');
  if (!collection) return null;

  const syncKey      = getText(collection, 'SyncKey') || '0';
  const status       = getText(collection, 'Status') || '1';
  const collectionId = getText(collection, 'CollectionId') || '';
  const moreAvail    = !!find(collection, 'MoreAvailable');

  const result = { syncKey, status, collectionId, moreAvailable: moreAvail,
                   added: [], changed: [], deleted: [] };

  const commands = find(collection, 'Commands');
  if (!commands) return result;

  for (const cmd of commands.children) {
    const serverId = getText(cmd, 'ServerId');
    if (!serverId) continue;

    if (cmd.tag === 'Add' || cmd.tag === 'Change') {
      const appData = find(cmd, 'ApplicationData');
      const mimeNode = appData ? find(appData, 'Body') : null;
      // The body Data node contains raw MIME (requested as Type=4)
      const dataNode = mimeNode ? find(mimeNode, 'Data') : null;
      const mime = dataNode ? dataNode.text : null;
      const mimeStr = mime instanceof Uint8Array
        ? new TextDecoder().decode(mime)
        : (mime || '');

      const readNode = appData ? find(appData, 'Read') : null;
      const read = readNode ? readNode.text !== '0' : false;

      const entry = { serverId, mime: mimeStr, read };
      if (cmd.tag === 'Add')    result.added.push(entry);
      else                      result.changed.push(entry);
    }

    if (cmd.tag === 'Delete') {
      result.deleted.push({ serverId });
    }
  }

  // Also handle Responses block for our sent commands
  return result;
}

// ─────────────────────────────────────────────────────────────────
// MoveItems
// ─────────────────────────────────────────────────────────────────

export function buildMoveItems(srcMsgId, srcFldId, dstFldId) {
  return encode(
    el('Move', 'MoveItems',
      el('Move', 'Move',
        tel('Move', 'SrcMsgId', srcMsgId),
        tel('Move', 'SrcFldId', srcFldId),
        tel('Move', 'DstFldId', dstFldId),
      )
    )
  );
}

export function parseMoveItems(buf) {
  const doc = decode(buf);
  const responses = find(doc, 'Response') ? [find(doc, 'Response')] : findAll(doc, 'Response');
  return responses.map(r => ({
    srcMsgId: getText(r, 'SrcMsgId'),
    status:   getText(r, 'Status'),
    dstMsgId: getText(r, 'DstMsgId'),
  }));
}

// ─────────────────────────────────────────────────────────────────
// SendMail (via raw MIME – EAS 14+)
// ─────────────────────────────────────────────────────────────────

// No WBXML needed for raw MIME send – handled by client.sendRawMime()

// ─────────────────────────────────────────────────────────────────
// Settings – DeviceInformation (register client with server)
// ─────────────────────────────────────────────────────────────────

export function buildSettings(profile = {}) {
  const model        = profile.model        || 'Thunderbird';
  const friendlyName = profile.friendlyName || 'Thunderbird EAS';
  const os           = profile.os           || 'Windows';
  const userAgent    = profile.userAgent    || 'Thunderbird-EAS/1.0';

  return encode(
    el('Settings', 'Settings',
      el('Settings', 'DeviceInformation',
        el('Settings', 'Set',
          tel('Settings', 'Model',        model),
          tel('Settings', 'FriendlyName', friendlyName),
          ...(os ? [tel('Settings', 'OS', os)] : []),
          tel('Settings', 'UserAgent',    userAgent),
        )
      )
    )
  );
}
