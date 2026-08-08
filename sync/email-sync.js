/**
 * Per-account synchronisation.
 *
 * Mirrors the EAS folder hierarchy into a Thunderbird folder tree, pulls
 * messages as raw MIME, and pushes read-flag and delete changes back.
 *
 * Two behaviours here are load-bearing and easy to get wrong:
 *
 *  - A Sync with SyncKey=0 is a *priming* request. The server answers with a
 *    fresh key and deliberately no items; the data only arrives on the next
 *    request. Treating the priming answer as "no changes" makes the first sync
 *    of every folder silently return nothing, and the mailbox only starts
 *    filling on the following cycle.
 *
 *  - From protocol version 14.0 errors travel as WBXML <Status> inside HTTP
 *    200 responses. The transport layer maps those onto typed errors; this
 *    layer reacts to the codes rather than to HTTP.
 */

import { EasClient, EasError, ERR } from '../eas/client.js';
import {
  buildFolderSync, parseFolderSync,
  buildSync, parseSync,
  buildItemOperationsFetch, parseItemOperationsFetch,
  buildSettings, parseSettings,
  FILTER_TYPE, DEFAULT_TRUNCATION_SIZE,
} from '../eas/commands.js';
import {
  FOLDER_ROLE, MAIL_FOLDER_TYPES,
  STATUS, SYNC_KEY_INVALID_STATUS, PING_STATUS, HEARTBEAT,
  resolveProfile,
} from '../eas/protocol.js';

/** How long to stay quiet after the server refused the device. */
const BLOCKED_BACKOFF_MS = 30 * 60 * 1000;
/** Cap on Sync round trips per folder per cycle, so a server that keeps
 *  answering MoreAvailable cannot spin forever. */
const MAX_SYNC_PAGES = 200;

export class AccountSync {
  constructor(account, opts = {}) {
    this.account = account;
    this.log = opts.log || ((...a) => console.log(`[EAS:${account.username}]`, ...a));

    this.client = new EasClient({
      ...account,
      log: this.log,
      onPolicyKeyUpdated:   key => this._patchAccount({ policyKey: key }),
      onVersionNegotiated:  v   => this._patchAccount({ easVersion: v }),
      onResyncRequired:     ()  => { this._resyncPending = true; },
    });

    this.profile   = resolveProfile(account);
    this.tbAccount = null;      // MailAccount or MailFolder acting as root
    this.pushAbort = null;
    this.pushing   = false;
    this._maps     = null;      // { easFolderId: { easServerId: tbMessageId } }
    this._revMap   = null;      // { tbMessageId: { easFolderId, easServerId } }
    this._mapsDirty = new Set();
    this._resyncPending = false;
  }

  // ── Backoff ───────────────────────────────────────────────────────

  /**
   * True while the account is inside a backoff window.
   *
   * Real clients do not hammer a server that has refused them. Without this,
   * every alarm tick fires a fresh Provision request and Exchange generates
   * another quarantine notification mail to the user for each one.
   */
  isBackingOff() {
    const until = this.account.backoffUntil || 0;
    return Date.now() < until;
  }

  backoffRemainingMs() {
    return Math.max(0, (this.account.backoffUntil || 0) - Date.now());
  }

  async _enterBackoff(ms, reason, code) {
    this.account.backoffUntil  = Date.now() + ms;
    this.account.backoffReason = reason;
    this.account.backoffCode   = code;
    await this._saveAccount();
    this.log(`backing off for ${Math.round(ms / 60000)} min: ${reason}`);
  }

  async _clearBackoff() {
    if (!this.account.backoffUntil) return;
    this.account.backoffUntil  = null;
    this.account.backoffReason = null;
    this.account.backoffCode   = null;
    await this._saveAccount();
  }

  // ── Setup ─────────────────────────────────────────────────────────

  async initialize() {
    this.log(`initialising against ${this.account.host} as ${this.profile.deviceType}`);

    try {
      const info = await this.client.options();
      this.log(`protocol ${info.chosen}` +
        (info.server ? ` (server ${info.server})` : '') +
        (info.note ? ` — ${info.note}` : ''));
      if (info.versions.length) await this._patchAccount({ serverVersions: info.versions });
    } catch (e) {
      if (e instanceof EasError && e.isFatalForNow) throw e;
      this.log(`OPTIONS failed, continuing with ${this.client.easVersion}: ${e.message}`);
    }

    // Only adopt a node that already exists. Creating one here would leave an
    // orphan behind for every account that never gets past provisioning — and
    // Thunderbird offers no way to delete a "none"-type account from its own
    // UI, so the user would be stuck with it. The node is created lazily, once
    // the server has actually handed us a folder to put in it.
    this.tbAccount = await this._findExistingTbAccount();
    if (this.tbAccount) {
      this.log(`Thunderbird root ready: ${this.tbAccount.name || this.tbAccount.path || '?'}`);
    }

    await this._loadMaps();
  }

  // ── Full sync cycle ───────────────────────────────────────────────

  /**
   * Run a sync cycle.
   *
   * Cycles are serialised per account. The periodic alarm and the Ping push
   * loop both call this, and two concurrent Sync requests against the same
   * collection would race on the sync key: the server answers the second one
   * with status 3 and the collection gets rebuilt from scratch.
   *
   * @param {object} [opts]
   * @param {string[]} [opts.onlyCollections] restrict to these collection ids
   */
  async sync(opts = {}) {
    const previous = this._pendingSync || Promise.resolve();
    const next = previous.catch(() => {}).then(() => this._syncSerialised(opts));
    this._pendingSync = next.catch(() => {});
    return next;
  }

  async _syncSerialised(opts) {
    if (this.isBackingOff()) {
      throw new EasError(this.account.backoffCode || ERR.DEVICE_BLOCKED,
        this.account.backoffReason || 'account is in backoff');
    }

    try {
      await this._syncOnce(opts);
      await this._clearBackoff();
    } catch (e) {
      if (e instanceof EasError) {
        if (e.code === ERR.DEVICE_BLOCKED) {
          await this._enterBackoff(BLOCKED_BACKOFF_MS, e.message, e.code);
        } else if (e.code === ERR.THROTTLED) {
          const wait = (e.detail?.retryAfterSec || 60) * 1000;
          await this._enterBackoff(Math.max(wait, 60000), e.message, e.code);
        } else if (e.code === ERR.AUTH_FAILED || e.code === ERR.PASSWORD_EXPIRED) {
          await this._enterBackoff(BLOCKED_BACKOFF_MS, e.message, e.code);
        }
      }
      throw e;
    }
  }

  async _syncOnce(opts) {
    await this._loadMaps();

    if (this._resyncPending) {
      this.log('server signalled X-MS-RP — discarding sync state and starting over');
      await this._resetSyncState();
      this._resyncPending = false;
    }

    // Register device metadata until a FolderSync confirms the server kept it.
    // Exchange does not persist Settings for a device that is still in
    // quarantine, so it has to be re-sent once the admin approves the device.
    // Outlook never sends Settings at all — sending it under that fingerprint
    // would be inconsistent with the profile.
    if (this.profile.sendSettings !== false && !this.account.settingsConfirmed) {
      try {
        const { doc } = await this.client.request('Settings',
          buildSettings(this.profile, { email: this.account.email || this.account.username }));
        const settings = parseSettings(doc);
        if (settings.status && settings.status !== STATUS.SUCCESS) {
          this.log(`Settings/DeviceInformation rejected with status ${settings.status}`);
        }
      } catch (e) {
        if (e instanceof EasError && e.code === ERR.DEVICE_BLOCKED) throw e;
        this.log(`Settings/DeviceInformation failed (non-fatal): ${e.message}`);
      }
    }

    await this._syncFolders();

    if (!this.account.settingsConfirmed) {
      await this._patchAccount({ settingsConfirmed: true });
    }

    const folders = this._mailFolders()
      .filter(f => !opts.onlyCollections || opts.onlyCollections.includes(f.serverId));

    this.log(`syncing ${folders.length} folder(s): ${folders.map(f => f.displayName).join(', ') || '(none)'}`);

    for (const folder of folders) {
      try {
        await this._syncFolder(folder);
      } catch (e) {
        // A device-level refusal is not folder-specific — stop the cycle.
        if (e instanceof EasError && e.isFatalForNow) throw e;
        this.log(`folder "${folder.displayName}" failed: ${e.message}`);
      }
    }

    await this._flushMaps();
    await this._saveAccount();
  }

  _mailFolders() {
    return Object.values(this.account.folders || {})
      .filter(f => MAIL_FOLDER_TYPES.has(f.type) && f.thunderbirdFolderId);
  }

  // ── Folder hierarchy ──────────────────────────────────────────────

  async _syncFolders() {
    let syncKey = this.account.folderSyncKey || '0';

    for (let attempt = 0; attempt < 3; attempt++) {
      const { doc } = await this.client.request('FolderSync', buildFolderSync(syncKey));
      const result  = parseFolderSync(doc);

      if (result.status !== STATUS.SUCCESS) {
        if (SYNC_KEY_INVALID_STATUS.has(result.status)) {
          this.log(`FolderSync status ${result.status} — rebuilding the hierarchy from scratch`);
          syncKey = '0';
          await this._resetSyncState();
          continue;
        }
        throw new EasError(ERR.SERVER_ERROR, `FolderSync returned status ${result.status}`,
          { status: result.status });
      }

      await this._applyFolderChanges(result);
      await this._patchAccount({ folderSyncKey: result.syncKey });
      return;
    }

    throw new EasError(ERR.SERVER_ERROR, 'FolderSync did not converge after three attempts');
  }

  async _applyFolderChanges(result) {
    for (const { serverId } of result.deleted) await this._deleteFolder(serverId);

    // Parents must exist before children. The server usually lists them in
    // order, but nothing guarantees it, so sort by depth first.
    for (const folder of this._sortByHierarchy(result.added)) await this._addFolder(folder);
    for (const folder of result.updated) await this._updateFolder(folder);
  }

  _sortByHierarchy(folders) {
    const byId = new Map(folders.map(f => [f.serverId, f]));
    const depth = (folder, seen = new Set()) => {
      let d = 0;
      let cur = folder;
      while (cur?.parentId && cur.parentId !== '0' && !seen.has(cur.serverId)) {
        seen.add(cur.serverId);
        cur = byId.get(cur.parentId);
        if (!cur) break;
        d++;
      }
      return d;
    };
    return [...folders].sort((a, b) => depth(a) - depth(b));
  }

  async _addFolder(easFolder) {
    if (!MAIL_FOLDER_TYPES.has(easFolder.type)) return;   // calendar, contacts, tasks

    const folders = this.account.folders || {};
    if (folders[easFolder.serverId]?.thunderbirdFolderId) return;

    const parentInfo = easFolder.parentId && easFolder.parentId !== '0'
      ? folders[easFolder.parentId]
      : null;
    const parent = parentInfo?.thunderbirdFolderId
      ? await this._getFolderById(parentInfo.thunderbirdFolderId)
      : null;

    // First folder from the server is what justifies creating the account node.
    if (!parent && !this.tbAccount) this.tbAccount = await this._ensureTbAccount();

    const container = parent || this.tbAccount;
    if (!container) {
      this.log(`no place to create "${easFolder.displayName}" — skipping`);
      return;
    }

    let tbFolder = await this._findChildFolder(container, easFolder.displayName);
    if (!tbFolder) {
      try {
        tbFolder = await messenger.folders.create(container, easFolder.displayName);
      } catch (e) {
        this.log(`could not create folder "${easFolder.displayName}": ${e.message}`);
        tbFolder = await this._findChildFolder(container, easFolder.displayName);
      }
    }

    folders[easFolder.serverId] = {
      serverId:            easFolder.serverId,
      parentId:            easFolder.parentId,
      displayName:         easFolder.displayName,
      type:                easFolder.type,
      thunderbirdFolderId: tbFolder?.id || null,
      syncKey:             '0',
    };
    this.account.folders = folders;

    await this._tagSpecialFolder(easFolder.type, tbFolder);
    await this._saveAccount();
  }

  /**
   * Give Inbox/Sent/Drafts/Trash their real Thunderbird identity. Without the
   * folder flags they are ordinary folders: generic icons, no delete-to-trash,
   * sent mail filed somewhere else.
   */
  async _tagSpecialFolder(easType, tbFolder) {
    const role = FOLDER_ROLE[easType];
    if (!role || !tbFolder || !this.account.tbAccountKey) return;
    if (typeof messenger.easAccount === 'undefined') return;
    try {
      await messenger.easAccount.setSpecialFolder(this.account.tbAccountKey, tbFolder.path, role);
    } catch (e) {
      this.log(`could not tag "${tbFolder.path}" as ${role}: ${e.message}`);
    }
  }

  async _deleteFolder(serverId) {
    const folders = this.account.folders || {};
    const info = folders[serverId];
    if (!info) return;

    if (info.thunderbirdFolderId) {
      try {
        const tbFolder = await this._getFolderById(info.thunderbirdFolderId);
        if (tbFolder) await messenger.folders.delete(tbFolder);
      } catch (e) {
        this.log(`could not delete Thunderbird folder for "${info.displayName}": ${e.message}`);
      }
    }

    delete folders[serverId];
    this.account.folders = folders;
    await this._dropFolderMap(serverId);
    await this._saveAccount();
  }

  async _updateFolder(easFolder) {
    const info = this.account.folders?.[easFolder.serverId];
    if (!info) return await this._addFolder(easFolder);

    const renamed = info.displayName !== easFolder.displayName;
    info.displayName = easFolder.displayName;
    info.type        = easFolder.type;
    info.parentId    = easFolder.parentId;

    if (renamed && info.thunderbirdFolderId) {
      try {
        const tbFolder = await this._getFolderById(info.thunderbirdFolderId);
        if (tbFolder && tbFolder.name !== easFolder.displayName) {
          await messenger.folders.rename(tbFolder, easFolder.displayName);
        }
      } catch (e) {
        this.log(`could not rename folder: ${e.message}`);
      }
    }
    await this._saveAccount();
  }

  // ── Message sync ──────────────────────────────────────────────────

  async _syncFolder(folderInfo) {
    const tbFolder = await this._getFolderById(folderInfo.thunderbirdFolderId);
    if (!tbFolder) {
      this.log(`Thunderbird folder missing for "${folderInfo.displayName}" — skipping`);
      return;
    }

    let syncKey = folderInfo.syncKey || '0';
    let pages   = 0;
    let primed  = syncKey !== '0';

    for (;;) {
      if (++pages > MAX_SYNC_PAGES) {
        this.log(`"${folderInfo.displayName}": stopping after ${MAX_SYNC_PAGES} pages`);
        break;
      }

      const request = buildSync({
        syncKey,
        collectionId:   folderInfo.serverId,
        easVersion:     this.client.easVersion,
        windowSize:     this.profile.windowSize || 100,
        getChanges:     syncKey === '0' ? undefined : true,
        filterType:     this.account.filterType ?? FILTER_TYPE.ALL,
        truncationSize: this.account.truncationSize ?? DEFAULT_TRUNCATION_SIZE,
      });

      const { doc } = await this.client.request('Sync', request);
      const parsed  = parseSync(doc);

      // Empty body = "nothing changed since your last request".
      if (!parsed) break;

      if (parsed.status && parsed.status !== STATUS.SUCCESS) {
        if (SYNC_KEY_INVALID_STATUS.has(parsed.status)) {
          this.log(`"${folderInfo.displayName}": top-level status ${parsed.status} — resetting collection`);
          syncKey = '0';
          primed  = false;
          folderInfo.syncKey = '0';
          await this._dropFolderMap(folderInfo.serverId);
          continue;
        }
        throw new EasError(ERR.SERVER_ERROR,
          `Sync of "${folderInfo.displayName}" returned top-level status ${parsed.status}`,
          { status: parsed.status });
      }

      const collection = parsed.collections.find(c => c.collectionId === folderInfo.serverId)
        || parsed.collections[0];
      if (!collection) break;

      if (collection.status !== STATUS.SUCCESS) {
        if (SYNC_KEY_INVALID_STATUS.has(collection.status)) {
          this.log(`"${folderInfo.displayName}": status ${collection.status} — resetting collection`);
          syncKey = '0';
          primed  = false;
          folderInfo.syncKey = '0';
          await this._dropFolderMap(folderInfo.serverId);
          continue;
        }
        throw new EasError(ERR.SERVER_ERROR,
          `Sync of "${folderInfo.displayName}" returned status ${collection.status}`,
          { status: collection.status });
      }

      syncKey = collection.syncKey;
      folderInfo.syncKey = syncKey;

      for (const item of collection.added)   await this._importMessage(item, tbFolder, folderInfo);
      for (const item of collection.changed) await this._updateMessage(item, folderInfo);
      for (const item of collection.deleted) await this._deleteMessage(item, folderInfo);

      // The priming answer carries the new key and nothing else — keep going
      // rather than mistaking it for an empty mailbox.
      if (!primed) { primed = true; continue; }
      if (!collection.moreAvailable) break;
    }

    await this._saveAccount();
  }

  async _importMessage(item, tbFolder, folderInfo) {
    let mime = item.mime;

    if (item.truncated) {
      try {
        const { doc } = await this.client.request('ItemOperations',
          buildItemOperationsFetch(folderInfo.serverId, item.serverId));
        const full = parseItemOperationsFetch(doc);
        if (full.mime) mime = full.mime;
      } catch (e) {
        this.log(`full fetch for ${item.serverId} failed, importing truncated body: ${e.message}`);
      }
    }

    if (!mime || !mime.trim()) {
      this.log(`item ${item.serverId} carried no MIME body — skipped`);
      return;
    }

    const withHeaders = this._injectEasHeaders(mime, item.serverId);
    const file = new File(
      [new Blob([withHeaders], { type: 'message/rfc822' })],
      'message.eml',
      { type: 'message/rfc822' }
    );

    try {
      const msg = await messenger.messages.import(file, tbFolder, {
        read:    item.read,
        flagged: false,
      });
      this._setMapping(folderInfo.serverId, item.serverId, msg.id);
    } catch (e) {
      this.log(`import of ${item.serverId} failed: ${e.message}`);
    }
  }

  async _updateMessage(item, folderInfo) {
    const tbId = this._getMapping(folderInfo.serverId, item.serverId);
    if (!tbId) return;
    if (!item.hasReadFlag) return;
    try {
      await messenger.messages.update(tbId, { read: item.read });
    } catch (_) { /* message gone locally */ }
  }

  async _deleteMessage(item, folderInfo) {
    const tbId = this._getMapping(folderInfo.serverId, item.serverId);
    if (!tbId) return;
    try {
      await messenger.messages.delete([tbId], true);   // skipTrash: already in the EAS trash
    } catch (_) { /* already gone */ }
    this._removeMapping(folderInfo.serverId, item.serverId);
  }

  // ── Outgoing changes ──────────────────────────────────────────────

  async sendMail(mimeData) {
    await this.client.sendMail(mimeData, { saveInSent: true });
  }

  /** Push a local read/unread change back to the server. */
  async propagateReadFlag(tbMessageId, read) {
    const mapping = this._getReverseMapping(tbMessageId);
    if (!mapping) return false;

    const folderInfo = this.account.folders?.[mapping.easFolderId];
    if (!folderInfo || folderInfo.syncKey === '0') return false;

    const { doc } = await this.client.request('Sync', buildSync({
      syncKey:      folderInfo.syncKey,
      collectionId: folderInfo.serverId,
      easVersion:   this.client.easVersion,
      // Suppress the server's own changes: this request exists to push one
      // flag, and any items returned here would be acknowledged by the new
      // sync key without ever being imported.
      getChanges:   false,
      readChanges:  [{ serverId: mapping.easServerId, read }],
    }));

    const parsed = parseSync(doc);
    const collection = parsed?.collections?.find(c => c.collectionId === folderInfo.serverId)
      || parsed?.collections?.[0];
    if (collection?.syncKey) {
      folderInfo.syncKey = collection.syncKey;
      await this._saveAccount();
    }

    const failed = collection?.responses?.find(r => r.status && r.status !== STATUS.SUCCESS);
    if (failed) this.log(`read-flag change rejected with status ${failed.status}`);
    return !failed;
  }

  /** Push a local deletion back to the server. */
  async propagateDelete(tbMessageId) {
    const mapping = this._getReverseMapping(tbMessageId);
    if (!mapping) return false;

    const folderInfo = this.account.folders?.[mapping.easFolderId];
    if (!folderInfo || folderInfo.syncKey === '0') return false;

    const { doc } = await this.client.request('Sync', buildSync({
      syncKey:      folderInfo.syncKey,
      collectionId: folderInfo.serverId,
      easVersion:   this.client.easVersion,
      getChanges:   false,
      deleteIds:    [mapping.easServerId],
    }));

    const parsed = parseSync(doc);
    const collection = parsed?.collections?.[0];
    if (collection?.syncKey) {
      folderInfo.syncKey = collection.syncKey;
      this._removeMapping(mapping.easFolderId, mapping.easServerId);
      await this._flushMaps();
      await this._saveAccount();
    }
    return true;
  }

  // ── Push (Ping) ───────────────────────────────────────────────────

  /**
   * Long-poll the server for changes.
   *
   * Heartbeat handling is adaptive on purpose: intermediate proxies and NAT
   * gateways frequently kill idle connections long before the negotiated
   * heartbeat elapses, which looks exactly like a network error. Starting
   * conservatively, halving on a network failure and growing slowly after a
   * clean heartbeat converges on whatever the path actually tolerates.
   */
  async startPushLoop() {
    if (this.pushing) return;
    if (!this._mailFolders().length) return;

    this.pushing   = true;
    this.pushAbort = new AbortController();
    const signal   = this.pushAbort.signal;

    let heartbeat = this.account.heartbeatSec || HEARTBEAT.INITIAL;
    let maxFolders = this.account.maxPingFolders || null;

    this.log(`push loop started (heartbeat ${heartbeat}s)`);

    while (this.pushing && !signal.aborted) {
      if (this.isBackingOff()) { await this._sleep(60000, signal); continue; }

      let folders = this._mailFolders().map(f => ({ id: f.serverId, class: 'Email' }));
      if (!folders.length) break;
      if (maxFolders && folders.length > maxFolders) folders = folders.slice(0, maxFolders);

      try {
        const result = await this.client.ping(heartbeat, folders, signal);

        switch (result.status) {
          case PING_STATUS.EXPIRED:
            heartbeat = Math.min(HEARTBEAT.MAX, heartbeat + HEARTBEAT.STEP_UP);
            await this._patchAccount({ heartbeatSec: heartbeat });
            break;

          case PING_STATUS.CHANGES:
            this.log(`push: changes in ${result.changedFolders.length} folder(s)`);
            await this.sync({ onlyCollections: result.changedFolders });
            break;

          case PING_STATUS.INVALID_HEARTBEAT:
            if (result.heartbeatLimit) {
              this.log(`push: server requires heartbeat ${result.heartbeatLimit}s`);
              heartbeat = result.heartbeatLimit;
              await this._patchAccount({ heartbeatSec: heartbeat });
            } else {
              heartbeat = Math.max(HEARTBEAT.MIN, Math.floor(heartbeat / 2));
            }
            break;

          case PING_STATUS.TOO_MANY_FOLDERS:
            maxFolders = result.folderLimit || Math.max(1, folders.length - 1);
            this.log(`push: server allows at most ${maxFolders} folders`);
            await this._patchAccount({ maxPingFolders: maxFolders });
            break;

          case PING_STATUS.HIERARCHY_STALE:
            await this._syncFolders();
            break;

          case PING_STATUS.MISSING_PARAMETERS:
          case PING_STATUS.SYNTAX_ERROR:
            this.log(`push: server rejected the Ping request (status ${result.status}) — stopping push`);
            this.pushing = false;
            break;

          default:
            await this._sleep(60000, signal);
        }
      } catch (e) {
        if (signal.aborted) break;

        if (e instanceof EasError && e.isFatalForNow) {
          this.log(`push loop stopping: ${e.message}`);
          if (e.code === ERR.DEVICE_BLOCKED) await this._enterBackoff(BLOCKED_BACKOFF_MS, e.message, e.code);
          this.pushing = false;
          break;
        }

        if (e instanceof EasError && e.code === ERR.NETWORK) {
          // Most likely the connection was cut mid-heartbeat.
          heartbeat = Math.max(HEARTBEAT.MIN, Math.floor(heartbeat / 2));
          await this._patchAccount({ heartbeatSec: heartbeat });
          this.log(`push: connection dropped, heartbeat reduced to ${heartbeat}s`);
          await this._sleep(5000, signal);
          continue;
        }

        this.log(`push error: ${e.message}`);
        await this._sleep(30000, signal);
      }
    }

    this.pushing = false;
    this.log('push loop stopped');
  }

  stopPushLoop() {
    this.pushing = false;
    this.pushAbort?.abort();
    this.pushAbort = null;
  }

  _sleep(ms, signal) {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }

  // ── Thunderbird account node ──────────────────────────────────────

  /**
   * Give the account its own top-level node in the folder pane when the
   * privileged build is installed, and fall back to a folder inside Local
   * Folders otherwise. Both paths produce something usable, so the same code
   * runs on both builds and account data survives switching between them.
   */
  /** Adopt an already-created node, without creating one. */
  async _findExistingTbAccount() {
    if (typeof messenger.easAccount !== 'undefined') {
      if (!this.account.tbAccountKey) return null;
      return await this._getAccount(this.account.tbAccountKey);
    }

    const rootName = this.account.email || this.account.username;
    const local = await this._localFoldersAccount();
    return local ? await this._findChildFolder(local, rootName) : null;
  }

  async _ensureTbAccount() {
    const email = this.account.email || this.account.username;

    if (typeof messenger.easAccount !== 'undefined') {
      const existing = await this._findExistingTbAccount();
      if (existing) return existing;

      const created = await messenger.easAccount.createAccount(email, this.account.host, {
        displayName: this.account.displayName || email,
        fullName:    this.account.fullName || '',
      });
      // Persist the key first: without it a later removal cannot find the node.
      await this._patchAccount({ tbAccountKey: created.accountKey });
      this.log(`account node ${created.created ? 'created' : 'reused'}: ${created.accountKey}`);
      if (created.identityError) {
        this.log(`account node has no identity: ${created.identityError}`);
      }
      return await this._getAccount(created.accountKey);
    }

    this.log('privileged build not active — using a folder under Local Folders');
    return this._ensureLocalFolder(email);
  }

  async _localFoldersAccount() {
    const accounts = await messenger.accounts.list();
    return accounts.find(a => a.type === 'none') || accounts.find(a => a.type === 'local') || null;
  }

  async _getAccount(key) {
    try {
      return await messenger.accounts.get(key);
    } catch (_) {
      return null;
    }
  }

  async _ensureLocalFolder(rootName) {
    const local = await this._localFoldersAccount();
    if (!local) throw new Error('No Local Folders account found in Thunderbird');

    const existing = await this._findChildFolder(local, rootName);
    if (existing) return existing;

    return await messenger.folders.create(local, rootName);
  }

  /**
   * Look for an existing child folder by name.
   *
   * The sub-folder list carried on a cached MailAccount/MailFolder object goes
   * stale as soon as we create something, so the live list is queried first
   * and the cached arrays are only a fallback.
   */
  async _findChildFolder(container, name) {
    try {
      const children = await messenger.folders.getSubFolders(container, false);
      const hit = (children || []).find(f => f.name === name);
      if (hit) return hit;
    } catch (_) { /* older API shape, fall through */ }

    const cached = container.subFolders || container.folders || [];
    return cached.find(f => f.name === name) || null;
  }

  async _getFolderById(folderId) {
    if (!folderId) return null;
    try {
      return await messenger.folders.get(folderId);
    } catch (_) {
      return null;
    }
  }

  // ── ServerId ↔ Thunderbird message id ─────────────────────────────
  //
  // Held in memory for the duration of a cycle and written once at the end.
  // The previous implementation did a read-modify-write of two storage keys
  // per imported message, which makes the initial sync of a large folder
  // quadratic in storage operations.

  _mapKey(easFolderId) { return `mapping_${this.account.id}_${easFolderId}`; }
  get _revKey() { return `rev_mapping_${this.account.id}`; }

  async _loadMaps() {
    if (this._maps) return;
    this._maps = {};
    for (const folderId of Object.keys(this.account.folders || {})) {
      const key  = this._mapKey(folderId);
      const data = await messenger.storage.local.get(key);
      this._maps[folderId] = data[key] || {};
    }
    const rev = await messenger.storage.local.get(this._revKey);
    this._revMap = rev[this._revKey] || {};
  }

  _setMapping(easFolderId, easServerId, tbMessageId) {
    if (!this._maps) { this._maps = {}; this._revMap = {}; }
    (this._maps[easFolderId] ||= {})[easServerId] = tbMessageId;
    this._revMap[tbMessageId] = { easFolderId, easServerId };
    this._mapsDirty.add(easFolderId);
  }

  _getMapping(easFolderId, easServerId) {
    return this._maps?.[easFolderId]?.[easServerId] || null;
  }

  _getReverseMapping(tbMessageId) {
    return this._revMap?.[tbMessageId] || null;
  }

  _removeMapping(easFolderId, easServerId) {
    const tbId = this._maps?.[easFolderId]?.[easServerId];
    if (tbId !== undefined) {
      delete this._maps[easFolderId][easServerId];
      delete this._revMap[tbId];
      this._mapsDirty.add(easFolderId);
    }
  }

  async _dropFolderMap(easFolderId) {
    await this._loadMaps();
    for (const serverId of Object.keys(this._maps[easFolderId] || {})) {
      const tbId = this._maps[easFolderId][serverId];
      delete this._revMap[tbId];
    }
    this._maps[easFolderId] = {};
    this._mapsDirty.add(easFolderId);
    await this._flushMaps();
  }

  async _flushMaps() {
    if (!this._maps || !this._mapsDirty.size) return;
    const patch = { [this._revKey]: this._revMap };
    for (const folderId of this._mapsDirty) patch[this._mapKey(folderId)] = this._maps[folderId];
    await messenger.storage.local.set(patch);
    this._mapsDirty.clear();
  }

  // ── Persistence ───────────────────────────────────────────────────

  async _patchAccount(patch) {
    Object.assign(this.account, patch);
    await this._saveAccount();
  }

  async _saveAccount() {
    const { accounts = [] } = await messenger.storage.local.get('accounts');
    const idx = accounts.findIndex(a => a.id === this.account.id);
    // Never write the password back into storage; it lives in the password
    // manager on the privileged build and is held in memory only.
    const { password, ...persisted } = this.account;
    if (idx >= 0) accounts[idx] = { ...accounts[idx], ...persisted };
    else accounts.push(persisted);
    await messenger.storage.local.set({ accounts });
  }

  async _resetSyncState() {
    this.account.folderSyncKey = '0';
    for (const folder of Object.values(this.account.folders || {})) folder.syncKey = '0';
    await this._saveAccount();
  }

  // ── Utilities ─────────────────────────────────────────────────────

  /**
   * Stamp the EAS identity onto the imported message so it can be correlated
   * later even if the storage mapping is lost.
   *
   * Server-controlled values are stripped of CR/LF first — otherwise a crafted
   * ServerId would inject arbitrary headers into the imported message.
   */
  _injectEasHeaders(mime, serverId) {
    const clean = v => String(v).replace(/[\r\n]/g, '');
    const headers =
      `X-EAS-ServerId: ${clean(serverId)}\r\n` +
      `X-EAS-AccountId: ${clean(this.account.id)}\r\n`;

    const firstBreak = mime.indexOf('\r\n');
    if (firstBreak < 0) return headers + mime;
    return mime.slice(0, firstBreak + 2) + headers + mime.slice(firstBreak + 2);
  }
}
