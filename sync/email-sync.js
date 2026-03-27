/**
 * Email synchronisation logic.
 *
 * Responsibilities:
 *  - Sync EAS folder hierarchy → Thunderbird local folder tree
 *  - Sync EAS messages → import as EML into Thunderbird
 *  - Propagate deletions and read-flag changes back to server
 *  - Track EAS ServerId ↔ Thunderbird message ID mappings
 */

import { EasClient }    from '../eas/client.js';
import {
  buildFolderSync, parseFolderSync,
  buildSync, parseSync,
  buildItemOperationsFetch, parseItemOperationsFetch,
  buildSettings,
} from '../eas/commands.js';
import { FOLDER_TYPE, resolveProfile }  from '../eas/protocol.js';

// Root folder name is derived from the account email at runtime — see _ensureRootFolder()

// ─────────────────────────────────────────────────────────────────
// AccountSync – manages one EAS account
// ─────────────────────────────────────────────────────────────────

export class AccountSync {
  constructor(account) {
    this.account = account;
    this.client  = new EasClient({
      ...account,
      onPolicyKeyUpdated: (key) => this._savePolicyKey(key),
    });
  }

  // ── Initial setup ─────────────────────────────────────────────

  async initialize() {
    console.log('[EAS] Initializing account:', this.account.username, '@', this.account.host);

    // Negotiate EAS version
    try {
      const info = await this.client.options();
      console.log('[EAS] Negotiated version:', info.chosen, '| note:', info.note || 'ok');
    } catch (e) {
      console.warn('[EAS] OPTIONS failed, using default version:', e.message);
    }

    // Register device info with server
    try {
      const profile = resolveProfile(this.account);
      await this.client.request('Settings', buildSettings(profile, { email: this.account.email || this.account.username }));
      console.log('[EAS] Device registration OK');
    } catch (e) {
      console.warn('[EAS] Settings/DeviceInformation failed (non-fatal):', e.message);
    }

    // Find or create top-level Thunderbird account node
    this.tbRootFolder = await this._ensureTbAccount();
    console.log('[EAS] TB account ready:', this.tbRootFolder?.name || this.tbRootFolder?.id);
  }

  // ── Full sync cycle ───────────────────────────────────────────

  static get QUARANTINE_BACKOFF_MS() { return 30 * 60 * 1000; }

  /** Returns true if the account is in the quarantine backoff window. */
  isInQuarantineBackoff() {
    return !!(this.account.quarantineDetectedAt &&
      (Date.now() - this.account.quarantineDetectedAt) < AccountSync.QUARANTINE_BACKOFF_MS);
  }

  async sync() {
    console.log('[EAS] Starting sync for', this.account.username);

    // If the device was quarantined, back off for 30 minutes before retrying.
    // Real EAS clients (Android, iOS) do not hammer the server; they wait for
    // admin approval. Without this, every 5-minute alarm cycle triggers a new
    // Provision request and Exchange generates a fresh quarantine notification email.
    if (this.isInQuarantineBackoff()) {
      // Caller (SyncManager.syncAll) should check isInQuarantineBackoff() first and
      // skip entirely, but guard here too in case sync() is called directly.
      throw new Error('DEVICE_QUARANTINED');
    }

    if (this.account.quarantineDetectedAt) {
      // Backoff expired – try again; admin may have approved the device
      console.log('[EAS] Quarantine backoff expired – retrying sync');
    }

    // Re-send device metadata on every sync until Exchange confirms it by completing
    // a successful FolderSync. Exchange does not store Settings for quarantined devices,
    // so we must re-send after admin approval to populate OWA device details.
    if (!this.account.settingsConfirmed) {
      try {
        const profile = resolveProfile(this.account);
        await this.client.request('Settings', buildSettings(profile, { email: this.account.email || this.account.username }));
      } catch (e) { /* non-fatal */ }
    }

    try {
      await this._syncFolders();
      // First successful FolderSync after quarantine – clear the backoff state
      if (this.account.quarantineDetectedAt) {
        this.account.quarantineDetectedAt = null;
        await this._saveAccount();
        console.log('[EAS] Quarantine cleared – device approved by admin');
      }
    } catch (e) {
      if (e.message === 'DEVICE_QUARANTINED' && !this.account.quarantineDetectedAt) {
        this.account.quarantineDetectedAt = Date.now();
        await this._saveAccount();
        console.warn('[EAS] Device quarantined – backing off for 30 minutes');
      }
      throw e;
    }

    const emailFolders = Object.values(this.account.folders || {})
      .filter(f => this._isEmailFolder(f.type));
    console.log('[EAS] Email folders to sync:', emailFolders.map(f => f.displayName).join(', ') || '(none)');
    for (const folder of emailFolders) {
      try {
        await this._syncFolder(folder);
      } catch (e) {
        console.error(`[EAS] Sync failed for folder ${folder.displayName}:`, e);
      }
    }
    console.log('[EAS] Sync complete for', this.account.username);
  }

  // ── Folder hierarchy sync ─────────────────────────────────────

  async _syncFolders() {
    let syncKey = this.account.folderSyncKey || '0';
    let hasMore = true;

    while (hasMore) {
      const buf    = await this.client.request('FolderSync', buildFolderSync(syncKey));
      const result = parseFolderSync(buf);

      if (result.status !== '1') {
        if (result.status === '9' || result.status === '12') {
          // Sync state mismatch – reset
          syncKey = '0';
          await this._resetFolderState();
          continue;
        }
        if (result.status === '142' || result.status === '145') {
          // DeviceNotProvisioned – run provisioning and retry
          console.log('[EAS] FolderSync: device not provisioned, running provisioning…');
          await this.client.provision();
          continue;
        }
        if (result.status === '177') {
          throw new Error('DEVICE_QUARANTINED');
        }
        throw new Error(`FolderSync status=${result.status}`);
      }

      syncKey = result.syncKey;
      hasMore = false; // FolderSync doesn't page like Sync does

      // First successful FolderSync confirms Exchange stored our Settings metadata
      if (!this.account.settingsConfirmed) {
        this.account.settingsConfirmed = true;
        await this._saveAccount();
      }

      for (const folder of result.added) {
        await this._addFolder(folder);
      }
      for (const { serverId } of result.deleted) {
        await this._deleteFolder(serverId);
      }
      for (const folder of result.updated) {
        await this._updateFolder(folder);
      }
    }

    this.account.folderSyncKey = syncKey;
    await this._saveAccount();
  }

  async _addFolder(easFolder) {
    if (!this._isEmailFolder(easFolder.type)) return; // skip calendar/contacts etc.

    const folders = this.account.folders || {};
    if (folders[easFolder.serverId]) return; // already exists

    const parentTbId = easFolder.parentId && easFolder.parentId !== '0'
      ? folders[easFolder.parentId]?.thunderbirdFolderId
      : null;

    const parent = parentTbId
      ? await this._getFolderById(parentTbId)
      : this.tbRootFolder;

    if (!parent) {
      console.warn(`Parent folder not found for ${easFolder.displayName}, placing at root`);
    }

    let tbFolder;
    try {
      tbFolder = await messenger.folders.create(parent || this.tbRootFolder, easFolder.displayName);
    } catch (e) {
      // Folder may already exist with that name
      const existing = await this._findChildFolder(parent || this.tbRootFolder, easFolder.displayName);
      tbFolder = existing;
    }

    folders[easFolder.serverId] = {
      serverId:            easFolder.serverId,
      displayName:         easFolder.displayName,
      type:                easFolder.type,
      thunderbirdFolderId: tbFolder?.id || null,
      syncKey:             '0',
    };

    this.account.folders = folders;
    await this._saveAccount();
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
        console.warn('Could not delete TB folder:', e);
      }
    }

    delete folders[serverId];
    this.account.folders = folders;
    await this._saveAccount();
  }

  async _updateFolder(easFolder) {
    const folders = this.account.folders || {};
    const info = folders[easFolder.serverId];
    if (info) {
      info.displayName = easFolder.displayName;
      info.type        = easFolder.type;
      // Rename TB folder if needed
      if (info.thunderbirdFolderId) {
        try {
          const tbFolder = await this._getFolderById(info.thunderbirdFolderId);
          if (tbFolder && tbFolder.name !== easFolder.displayName) {
            await messenger.folders.rename(tbFolder, easFolder.displayName);
          }
        } catch (e) { /* non-fatal */ }
      }
    }
    await this._saveAccount();
  }

  // ── Email item sync ───────────────────────────────────────────

  async _syncFolder(folderInfo) {
    let syncKey   = folderInfo.syncKey || '0';
    let hasMore   = true;
    const tbFolder = await this._getFolderById(folderInfo.thunderbirdFolderId);
    if (!tbFolder) {
      console.warn(`TB folder not found for ${folderInfo.displayName}`);
      return;
    }

    while (hasMore) {
      const buf    = await this.client.request('Sync',
        buildSync(syncKey, folderInfo.serverId, { windowSize: 50 }));
      const result = parseSync(buf);

      if (!result) {
        // HTTP 200 with empty body = no changes
        break;
      }

      if (result.status === '3' || result.status === '12') {
        // Sync state out of date – start over
        syncKey = '0';
        folderInfo.syncKey = '0';
        continue;
      }

      syncKey  = result.syncKey;
      hasMore  = result.moreAvailable;

      for (const item of result.added) {
        await this._importMessage(item, tbFolder, folderInfo);
      }

      for (const item of result.changed) {
        // Update read state in Thunderbird if we know the message
        await this._updateMessage(item, folderInfo);
      }

      for (const item of result.deleted) {
        await this._deleteMessage(item, folderInfo);
      }
    }

    folderInfo.syncKey = syncKey;
    await this._saveAccount();
  }

  async _importMessage(item, tbFolder, folderInfo) {
    if (!item.mime || !item.mime.trim()) return;

    // If the Sync response flagged the body as truncated, fetch the full MIME via
    // ItemOperations/Fetch before importing (no TruncationSize = server sends everything).
    let mime = item.mime;
    if (item.truncated) {
      try {
        const buf    = await this.client.request('ItemOperations',
          buildItemOperationsFetch(folderInfo.serverId, item.serverId));
        const result = parseItemOperationsFetch(buf);
        if (result.mime) mime = result.mime;
        console.log('[EAS] Fetched full MIME for truncated item:', item.serverId);
      } catch (e) {
        console.warn('[EAS] ItemOperations/Fetch failed, using truncated MIME:', e.message);
      }
    }

    // Track server ID → TB message (stored in mime header or mapping)
    const mimeWithHeader = this._injectEasHeader(mime, item.serverId, this.account.id);

    const blob = new Blob([mimeWithHeader], { type: 'message/rfc822' });
    const file = new File([blob], 'message.eml', { type: 'message/rfc822' });

    try {
      const msg = await messenger.messages.import(file, tbFolder, {
        read: item.read,
        flagged: false,
      });
      // Store mapping: easServerId → tbMessageId
      await this._storeMapping(folderInfo.serverId, item.serverId, msg.id);
    } catch (e) {
      console.error('Failed to import message:', item.serverId, e);
    }
  }

  async _updateMessage(item, folderInfo) {
    const tbId = await this._getTbMessageId(folderInfo.serverId, item.serverId);
    if (!tbId) return;
    try {
      await messenger.messages.update(tbId, { read: item.read });
    } catch (e) { /* message may have been deleted locally */ }
  }

  async _deleteMessage(item, folderInfo) {
    const tbId = await this._getTbMessageId(folderInfo.serverId, item.serverId);
    if (!tbId) return;
    try {
      await messenger.messages.delete([tbId], true); // skipTrash=true
    } catch (e) { /* already gone */ }
    await this._removeMapping(folderInfo.serverId, item.serverId);
  }

  // ── Send outgoing email via EAS ───────────────────────────────

  /**
   * Called from compose.onBeforeSend when From matches this account.
   * @param {string} mimeData  raw RFC-2822 message
   */
  async sendMail(mimeData) {
    await this.client.sendRawMime(mimeData);
  }

  // ── Mark-as-read propagation back to server ────────────────────

  async propagateReadFlag(tbFolderId, tbMessageId, read) {
    const mapping = await this._getMappingByTbId(tbMessageId);
    if (!mapping) return;
    const folderInfo = this.account.folders?.[mapping.easFolderId];
    if (!folderInfo) return;

    const buf = await this.client.request('Sync',
      buildSync(folderInfo.syncKey, folderInfo.serverId, {
        getChanges: false,
        readChanges: [{ serverId: mapping.easServerId, read }],
      })
    );
    // Parse response to get updated syncKey
    const result = parseSync(buf);
    if (result) folderInfo.syncKey = result.syncKey;
    await this._saveAccount();
  }

  // ── Thunderbird account node helpers ─────────────────────────

  /**
   * Ensure a dedicated top-level Thunderbird account node exists for this
   * EAS account. Uses the Experiments API (easAccount) to create an XPCOM
   * account via MailServices so it appears identically to IMAP accounts.
   *
   * The account key is persisted in account.tbAccountKey across restarts.
   */
  async _ensureTbAccount() {
    const email = this.account.email || this.account.username;

    // ── Path A: Experiments API available → dedicated account node ───
    if (typeof messenger.easAccount !== 'undefined') {
      // Re-use existing account node if we already created one
      if (this.account.tbAccountKey) {
        try {
          const tbAccount = await messenger.accounts.get(this.account.tbAccountKey);
          if (tbAccount) {
            console.log('[EAS] Re-using TB account node:', tbAccount.name);
            return tbAccount;
          }
        } catch (_) { /* account gone, will recreate */ }
      }

      console.log('[EAS] Creating TB account node for:', email);
      const accountKey = await messenger.easAccount.createAccount(email, this.account.host);
      this.account.tbAccountKey = accountKey;
      await this._saveAccount();
      const tbAccount = await messenger.accounts.get(accountKey);
      console.log('[EAS] TB account node created:', tbAccount?.name || accountKey);
      return tbAccount;
    }

    // ── Path B: Fallback – folder under Local Folders ─────────────
    console.log('[EAS] Experiments API not available; using Local Folders fallback');
    return this._ensureLocalFolder(email);
  }

  async _ensureLocalFolder(rootName) {
    const accounts = await messenger.accounts.list();
    const local = accounts.find(a => a.type === 'none')
               || accounts.find(a => a.type === 'local');
    if (!local) throw new Error('No Local Folders account found in Thunderbird');

    for (const folder of local.folders || []) {
      if (folder.name === rootName) {
        console.log('[EAS] Reusing local folder:', folder.path);
        return folder;
      }
    }

    console.log('[EAS] Creating local folder:', rootName);
    const folder = await messenger.folders.create(local, rootName);
    console.log('[EAS] Local folder created:', folder?.path);
    return folder;
  }

  async _findChildFolder(parent, name) {
    const subs = parent.subFolders || [];
    return subs.find(f => f.name === name) || null;
  }

  async _getFolderById(folderId) {
    if (!folderId) return null;
    try {
      return await messenger.folders.get(folderId);
    } catch (e) {
      return null;
    }
  }

  // ── Mapping storage: EAS ServerId ↔ Thunderbird messageId ────

  _mappingKey(easFolderId) {
    return `mapping_${this.account.id}_${easFolderId}`;
  }

  async _storeMapping(easFolderId, easServerId, tbMessageId) {
    const key  = this._mappingKey(easFolderId);
    const data = await messenger.storage.local.get(key);
    const map  = data[key] || {};
    map[easServerId] = tbMessageId;
    await messenger.storage.local.set({ [key]: map });

    // Also store reverse mapping
    const revKey = `rev_mapping_${this.account.id}`;
    const revData = await messenger.storage.local.get(revKey);
    const rev = revData[revKey] || {};
    rev[tbMessageId] = { easFolderId, easServerId };
    await messenger.storage.local.set({ [revKey]: rev });
  }

  async _getTbMessageId(easFolderId, easServerId) {
    const key  = this._mappingKey(easFolderId);
    const data = await messenger.storage.local.get(key);
    return data[key]?.[easServerId] || null;
  }

  async _removeMapping(easFolderId, easServerId) {
    const key  = this._mappingKey(easFolderId);
    const data = await messenger.storage.local.get(key);
    const map  = data[key] || {};
    const tbId = map[easServerId];
    delete map[easServerId];
    await messenger.storage.local.set({ [key]: map });

    if (tbId) {
      const revKey  = `rev_mapping_${this.account.id}`;
      const revData = await messenger.storage.local.get(revKey);
      const rev     = revData[revKey] || {};
      delete rev[tbId];
      await messenger.storage.local.set({ [revKey]: rev });
    }
  }

  async _getMappingByTbId(tbMessageId) {
    const revKey  = `rev_mapping_${this.account.id}`;
    const revData = await messenger.storage.local.get(revKey);
    return revData[revKey]?.[tbMessageId] || null;
  }

  // ── Persistence ──────────────────────────────────────────────

  async _saveAccount() {
    const { accounts = [] } = await messenger.storage.local.get('accounts');
    const idx = accounts.findIndex(a => a.id === this.account.id);
    if (idx >= 0) accounts[idx] = this.account;
    else accounts.push(this.account);
    await messenger.storage.local.set({ accounts });
  }

  async _savePolicyKey(key) {
    this.account.policyKey = key;
    await this._saveAccount();
  }

  async _resetFolderState() {
    this.account.folderSyncKey = '0';
    for (const f of Object.values(this.account.folders || {})) f.syncKey = '0';
    await this._saveAccount();
  }

  // ── Utilities ─────────────────────────────────────────────────

  _isEmailFolder(type) {
    return [
      FOLDER_TYPE.INBOX, FOLDER_TYPE.DRAFTS, FOLDER_TYPE.DELETED,
      FOLDER_TYPE.SENT,  FOLDER_TYPE.OUTBOX, FOLDER_TYPE.USER_MAIL,
      FOLDER_TYPE.USER_GENERIC,
    ].includes(type);
  }

  /** Inject X-EAS-ServerId header so we can correlate later */
  _injectEasHeader(mime, serverId, accountId) {
    // Sanitize server-controlled values to prevent MIME header injection
    const safeServerId  = String(serverId).replace(/[\r\n]/g, '');
    const safeAccountId = String(accountId).replace(/[\r\n]/g, '');
    const header = `X-EAS-ServerId: ${safeServerId}\r\nX-EAS-AccountId: ${safeAccountId}\r\n`;
    // Insert after first line (Return-Path or first real header)
    const pos = mime.indexOf('\r\n');
    if (pos < 0) return header + mime;
    return mime.slice(0, pos + 2) + header + mime.slice(pos + 2);
  }
}
