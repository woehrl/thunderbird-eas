/**
 * EAS command builders and response parsers.
 *
 * Builders return WBXML node trees (encoded by the client); parsers take the
 * decoded tree the client hands back.
 *
 * Element order is not cosmetic. The EAS schemas are ordered sequences, so
 * every builder emits children in schema order. Namespace-qualified lookups
 * ('AirSyncBase:Body') are used throughout, because Status, Body and Data
 * exist on several code pages and an unqualified match silently picks the
 * wrong one.
 */

import { el, tel, find, findAll, getText } from './wbxml.js';
import {
  BODY_TYPE, MIME_SUPPORT, FOLDER_TYPE_NAME, STATUS, versionValue,
} from './protocol.js';

/** Sync/Options/FilterType — how far back the server should look. */
export const FILTER_TYPE = {
  ALL:        0,
  ONE_DAY:    1,
  THREE_DAYS: 2,
  ONE_WEEK:   3,
  TWO_WEEKS:  4,
  ONE_MONTH:  5,
};

/** Default per-item MIME budget; larger items are re-fetched individually. */
export const DEFAULT_TRUNCATION_SIZE = 262144; // 256 KiB

// ─────────────────────────────────────────────────────────────────────
// FolderSync
// ─────────────────────────────────────────────────────────────────────

export function buildFolderSync(syncKey) {
  return el('FolderHierarchy', 'FolderSync',
    tel('FolderHierarchy', 'SyncKey', String(syncKey)));
}

/**
 * @returns {{syncKey, status, added: [], deleted: [], updated: []}}
 */
export function parseFolderSync(doc) {
  const root = doc?.tag === 'FolderSync' ? doc : find(doc, 'FolderHierarchy:FolderSync');
  if (!root) throw new Error('FolderSync: no FolderSync element in response');

  const result = {
    status:  getText(root, 'FolderHierarchy:Status') || '0',
    syncKey: getText(root, 'FolderHierarchy:SyncKey') || '0',
    added: [], deleted: [], updated: [],
  };

  const changes = find(root, 'FolderHierarchy:Changes');
  if (!changes) return result;

  for (const child of changes.children) {
    // <Count> also lives here; only Add/Delete/Update describe folders.
    if (child.tag === 'Delete') {
      result.deleted.push({ serverId: getText(child, 'FolderHierarchy:ServerId') });
      continue;
    }
    if (child.tag !== 'Add' && child.tag !== 'Update') continue;

    const type = parseInt(getText(child, 'FolderHierarchy:Type') || '1', 10);
    const folder = {
      serverId:    getText(child, 'FolderHierarchy:ServerId'),
      parentId:    getText(child, 'FolderHierarchy:ParentId'),
      displayName: getText(child, 'FolderHierarchy:DisplayName'),
      type,
      typeName:    FOLDER_TYPE_NAME[type] || null,
    };
    (child.tag === 'Add' ? result.added : result.updated).push(folder);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────
// Sync
// ─────────────────────────────────────────────────────────────────────

/**
 * Build a Sync request for one collection.
 *
 * @param {object} spec
 * @param {string} spec.syncKey
 * @param {string} spec.collectionId
 * @param {string} [spec.easVersion='14.1']
 * @param {number} [spec.windowSize=100]
 * @param {boolean} [spec.getChanges]      omit on the priming request
 * @param {number} [spec.filterType]
 * @param {number} [spec.truncationSize]
 * @param {string[]} [spec.fetchIds]
 * @param {string[]} [spec.deleteIds]
 * @param {Array<{serverId: string, read: boolean}>} [spec.readChanges]
 * @param {boolean} [spec.deletesAsMoves=true]  deleted items go to Deleted Items
 */
export function buildSync(spec) {
  const {
    syncKey,
    collectionId,
    easVersion     = '14.1',
    windowSize     = 100,
    getChanges,
    filterType     = FILTER_TYPE.ALL,
    truncationSize = DEFAULT_TRUNCATION_SIZE,
    fetchIds       = [],
    deleteIds      = [],
    readChanges    = [],
    deletesAsMoves = true,
  } = spec;

  const isPriming = String(syncKey) === '0';
  const legacy    = versionValue(easVersion) < 140;

  // The priming request (SyncKey=0) is answered with a fresh key and no items
  // regardless of what else it carries, so it is sent bare. Options on a
  // priming request are the classic reason a first sync appears to "work" but
  // return nothing.
  if (isPriming) {
    return el('AirSync', 'Sync',
      el('AirSync', 'Collections',
        el('AirSync', 'Collection',
          // Class is a 2.5/12.x element; from 14.0 the server derives it from
          // the collection and sending it can be answered with status 4.
          legacy ? tel('AirSync', 'Class', 'Email') : null,
          tel('AirSync', 'SyncKey', '0'),
          tel('AirSync', 'CollectionId', collectionId),
        )));
  }

  const commands = [
    ...fetchIds.map(id => el('AirSync', 'Fetch', tel('AirSync', 'ServerId', id))),
    ...deleteIds.map(id => el('AirSync', 'Delete', tel('AirSync', 'ServerId', id))),
    ...readChanges.map(({ serverId, read }) => el('AirSync', 'Change',
      tel('AirSync', 'ServerId', serverId),
      el('AirSync', 'ApplicationData',
        tel('Email', 'Read', read ? '1' : '0')))),
  ];

  const options = el('AirSync', 'Options',
    filterType ? tel('AirSync', 'FilterType', String(filterType)) : null,
    // Without MIMESupport the server will not honour BodyPreference Type=4 and
    // answers with a plain-text body instead of the raw message.
    tel('AirSync', 'MIMESupport', String(MIME_SUPPORT.ALWAYS)),
    el('AirSyncBase', 'BodyPreference',
      tel('AirSyncBase', 'Type', String(BODY_TYPE.MIME)),
      tel('AirSyncBase', 'TruncationSize', String(truncationSize)),
    ),
  );

  return el('AirSync', 'Sync',
    el('AirSync', 'Collections',
      el('AirSync', 'Collection',
        legacy ? tel('AirSync', 'Class', 'Email') : null,
        tel('AirSync', 'SyncKey', String(syncKey)),
        tel('AirSync', 'CollectionId', collectionId),
        tel('AirSync', 'DeletesAsMoves', deletesAsMoves ? '1' : '0'),
        getChanges === undefined ? null : tel('AirSync', 'GetChanges', getChanges ? '1' : '0'),
        tel('AirSync', 'WindowSize', String(windowSize)),
        options,
        commands.length ? el('AirSync', 'Commands', ...commands) : null,
      )));
}

/**
 * Parse a Sync response.
 *
 * Returns null for an empty body (a legitimate "nothing changed" answer).
 * Otherwise `{ status, collections: [...] }` — the response may carry several
 * collections even when the request asked for one.
 */
export function parseSync(doc) {
  if (!doc) return null;

  const root = doc.tag === 'Sync' ? doc : find(doc, 'AirSync:Sync');
  if (!root) return null;

  const result = {
    status:      getText(root, 'AirSync:Status'),
    collections: [],
  };

  const collectionsNode = find(root, 'AirSync:Collections');
  for (const collection of findAll(collectionsNode, 'AirSync:Collection')) {
    result.collections.push(parseSyncCollection(collection));
  }

  return result;
}

function parseSyncCollection(collection) {
  const out = {
    collectionId:  getText(collection, 'AirSync:CollectionId') || '',
    syncKey:       getText(collection, 'AirSync:SyncKey') || '0',
    status:        getText(collection, 'AirSync:Status') || STATUS.SUCCESS,
    moreAvailable: !!find(collection, 'AirSync:MoreAvailable'),
    added: [], changed: [], deleted: [], responses: [],
  };

  const commands = find(collection, 'AirSync:Commands');
  for (const cmd of commands?.children || []) {
    const serverId = getText(cmd, 'AirSync:ServerId');
    if (!serverId) continue;

    switch (cmd.tag) {
      case 'Add':
      case 'Change':
        (cmd.tag === 'Add' ? out.added : out.changed).push(parseItem(cmd, serverId));
        break;
      case 'Delete':
      case 'SoftDelete':
        out.deleted.push({ serverId, soft: cmd.tag === 'SoftDelete' });
        break;
    }
  }

  // Acknowledgements for the commands we sent. Worth surfacing: a Change that
  // failed here is a read flag that silently did not propagate.
  const responses = find(collection, 'AirSync:Responses');
  for (const resp of responses?.children || []) {
    out.responses.push({
      type:     resp.tag,
      serverId: getText(resp, 'AirSync:ServerId'),
      clientId: getText(resp, 'AirSync:ClientId'),
      status:   getText(resp, 'AirSync:Status'),
      item:     resp.tag === 'Fetch' ? parseItem(resp, getText(resp, 'AirSync:ServerId')) : null,
    });
  }

  return out;
}

/** Extract the fields we care about from an Add/Change/Fetch element. */
function parseItem(node, serverId) {
  const appData = find(node, 'AirSync:ApplicationData');
  if (!appData) return { serverId, mime: '', read: false, truncated: false };

  // 14.x: AirSyncBase/Body/Data holds the MIME when BodyPreference Type=4.
  // 2.5:  Email/MIMEData holds it instead.
  const body      = find(appData, 'AirSyncBase:Body');
  const dataNode  = body ? find(body, 'AirSyncBase:Data') : null;
  const legacyMime = getText(appData, 'Email:MIMEData');

  const mime = dataNode?.text ?? legacyMime ?? '';

  const truncated =
    (body ? getText(body, 'AirSyncBase:Truncated') : null) === '1' ||
    getText(appData, 'Email:MIMETruncated') === '1';

  const readText = getText(appData, 'Email:Read');

  return {
    serverId,
    mime,
    read:         readText === '1',
    hasReadFlag:  readText !== null,
    truncated,
    subject:      getText(appData, 'Email:Subject'),
    dateReceived: getText(appData, 'Email:DateReceived'),
    messageClass: getText(appData, 'Email:MessageClass'),
    estimatedSize: body ? getText(body, 'AirSyncBase:EstimatedDataSize') : null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// MoveItems
// ─────────────────────────────────────────────────────────────────────

export function buildMoveItems(moves) {
  return el('Move', 'MoveItems',
    ...moves.map(({ srcMsgId, srcFldId, dstFldId }) => el('Move', 'Move',
      tel('Move', 'SrcMsgId', srcMsgId),
      tel('Move', 'SrcFldId', srcFldId),
      tel('Move', 'DstFldId', dstFldId),
    )));
}

export function parseMoveItems(doc) {
  const root = doc?.tag === 'MoveItems' ? doc : find(doc, 'Move:MoveItems');
  if (!root) return [];
  return findAll(root, 'Move:Response').map(r => ({
    srcMsgId: getText(r, 'Move:SrcMsgId'),
    status:   getText(r, 'Move:Status'),
    dstMsgId: getText(r, 'Move:DstMsgId'),
  }));
}

// ─────────────────────────────────────────────────────────────────────
// ItemOperations / Fetch
// ─────────────────────────────────────────────────────────────────────

/**
 * Fetch one item in full.
 *
 * BodyPreference deliberately carries no TruncationSize, which is what makes
 * the server return the complete MIME.
 */
export function buildItemOperationsFetch(collectionId, serverId) {
  return el('ItemOperations', 'ItemOperations',
    el('ItemOperations', 'Fetch',
      tel('ItemOperations', 'Store', 'Mailbox'),
      tel('AirSync', 'CollectionId', collectionId),
      tel('AirSync', 'ServerId', serverId),
      el('ItemOperations', 'Options',
        tel('AirSync', 'MIMESupport', String(MIME_SUPPORT.ALWAYS)),
        el('AirSyncBase', 'BodyPreference',
          tel('AirSyncBase', 'Type', String(BODY_TYPE.MIME)),
        ),
      ),
    ));
}

export function parseItemOperationsFetch(doc) {
  const root = doc?.tag === 'ItemOperations' ? doc : find(doc, 'ItemOperations:ItemOperations');
  if (!root) throw new Error('ItemOperations: no ItemOperations element in response');

  const status = getText(root, 'ItemOperations:Status');
  if (status && status !== STATUS.SUCCESS) {
    throw new Error(`ItemOperations failed with status ${status}`);
  }

  const fetchNode = find(root, 'ItemOperations:Response', 'ItemOperations:Fetch');
  if (!fetchNode) throw new Error('ItemOperations: no Response/Fetch element');

  const fetchStatus = getText(fetchNode, 'ItemOperations:Status');
  if (fetchStatus && fetchStatus !== STATUS.SUCCESS) {
    throw new Error(`ItemOperations/Fetch item error: status ${fetchStatus}`);
  }

  const props = find(fetchNode, 'ItemOperations:Properties');
  const body  = props ? find(props, 'AirSyncBase:Body') : null;
  const data  = body ? find(body, 'AirSyncBase:Data') : null;

  return { mime: data?.text ?? getText(props, 'Email:MIMEData') ?? '' };
}

// ─────────────────────────────────────────────────────────────────────
// Settings / DeviceInformation
// ─────────────────────────────────────────────────────────────────────

/**
 * Register device metadata so the mailbox owner and the Exchange admin can
 * tell in OWA which device a partnership belongs to.
 *
 * Element order follows the MS-ASCMD schema exactly (Model, IMEI,
 * FriendlyName, OS, OSLanguage, PhoneNumber, UserAgent); optional fields are
 * omitted rather than sent empty.
 *
 * @param {object} profile
 * @param {object} [opts]
 * @param {string} [opts.email]  appended to FriendlyName for identification
 */
export function buildDeviceInformation(profile = {}, opts = {}) {
  const baseName     = profile.friendlyName || 'Thunderbird EAS';
  const friendlyName = opts.email ? `${baseName} (${opts.email})` : baseName;

  return el('Settings', 'DeviceInformation',
    el('Settings', 'Set',
      tel('Settings', 'Model', profile.model || 'Thunderbird'),
      tel('Settings', 'FriendlyName', friendlyName),
      profile.os         ? tel('Settings', 'OS',         profile.os)         : null,
      profile.osLanguage ? tel('Settings', 'OSLanguage', profile.osLanguage) : null,
      tel('Settings', 'UserAgent', profile.userAgent || 'Thunderbird-EAS/1.0'),
    ));
}

export function buildSettings(profile = {}, opts = {}) {
  return el('Settings', 'Settings', buildDeviceInformation(profile, opts));
}

export function parseSettings(doc) {
  const root = doc?.tag === 'Settings' ? doc : find(doc, 'Settings:Settings');
  if (!root) return { status: null, deviceInformationStatus: null };
  return {
    status: getText(root, 'Settings:Status'),
    deviceInformationStatus:
      getText(find(root, 'Settings:DeviceInformation'), 'Settings:Status'),
  };
}
