/**
 * Sync manager — owns every configured EAS account.
 *
 * - loads accounts and resolves credentials
 * - schedules periodic sync, and runs a Ping push loop where available
 * - routes outgoing mail through EAS instead of SMTP
 * - answers the popup and setup pages
 */

import { AccountSync } from './email-sync.js';
import { EasClient, EasError, ERR } from '../eas/client.js';
import {
  DEVICE_PROFILES, DEFAULT_PROFILE_ID, resolveProfile,
  generateDeviceId, verifyCodePages,
} from '../eas/protocol.js';
import { discover, probeEws } from '../eas/autodiscover.js';
import { FILTER_TYPE } from '../eas/commands.js';

const ALARM_PREFIX         = 'eas-sync-';
const DEFAULT_INTERVAL_MIN = 5;

export class SyncManager {
  constructor() {
    this.syncs  = new Map();   // accountId → AccountSync
    this.status = new Map();   // accountId → { lastSync, error, errorCode, syncing, pushing }
    this.logs   = new Map();   // accountId → string[] (ring buffer for the UI)
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  async start() {
    // A shifted code page table produces requests that servers answer with a
    // generic protocol error and is otherwise invisible, so it is checked at
    // startup rather than left to be discovered in a packet capture.
    const tableErrors = verifyCodePages();
    if (tableErrors.length) {
      console.error('[EAS] WBXML code page tables are inconsistent:', tableErrors);
    }

    messenger.alarms.onAlarm.addListener(alarm => this.handleAlarm(alarm));

    await this._migrateAccounts();
    await this._loadAccounts();
    this._listenCompose();
    this._listenMessages();
    console.log(`[EAS] SyncManager started with ${this.syncs.size} account(s)`);
  }

  /** Bring stored accounts up to the current schema. */
  async _migrateAccounts() {
    const { accounts = [] } = await messenger.storage.local.get('accounts');
    let changed = false;

    for (const account of accounts) {
      // The old single-purpose quarantine timestamp became a general backoff.
      if (account.quarantineDetectedAt !== undefined) {
        if (account.quarantineDetectedAt && !account.backoffUntil) {
          account.backoffUntil  = account.quarantineDetectedAt + 30 * 60 * 1000;
          account.backoffReason = 'Device awaiting administrator approval';
          account.backoffCode   = ERR.DEVICE_BLOCKED;
        }
        delete account.quarantineDetectedAt;
        changed = true;
      }
      if (!account.deviceProfileId) {
        account.deviceProfileId = DEFAULT_PROFILE_ID;
        changed = true;
      }
      if (!account.deviceId) {
        account.deviceId = generateDeviceId();
        changed = true;
      }
      if (account.filterType === undefined) {
        account.filterType = FILTER_TYPE.ALL;
        changed = true;
      }
      if (account.push === undefined) {
        account.push = true;
        changed = true;
      }
    }

    if (changed) await messenger.storage.local.set({ accounts });
  }

  async _loadAccounts() {
    const { accounts = [] } = await messenger.storage.local.get('accounts');
    for (const account of accounts) {
      if (account.enabled === false) continue;
      await this._addAccount(account);
    }
  }

  async _addAccount(stored) {
    const account = { ...stored, password: await this._resolvePassword(stored) };
    const sync = new AccountSync(account, { log: (...a) => this._log(account.id, a) });

    this.syncs.set(account.id, sync);
    this.status.set(account.id, { lastSync: null, error: null, errorCode: null, syncing: false, pushing: false });

    this._scheduleAlarm(account);

    try {
      await sync.initialize();
      if (account.push !== false) this._startPush(account.id, sync);
    } catch (e) {
      this._setError(account.id, e);
      console.error(`[EAS] initialising ${account.username} failed:`, e);
    }
  }

  /**
   * Credentials come from Thunderbird's password manager when the privileged
   * build is installed, and from extension storage otherwise. Storage is
   * migrated on first sight so a user upgrading to the privileged build stops
   * carrying a plaintext password.
   */
  async _resolvePassword(account) {
    const hasApi = typeof messenger.easAccount !== 'undefined';

    if (hasApi) {
      try {
        const stored = await messenger.easAccount.getPassword(account.host, account.username);
        if (stored) return stored;
      } catch (e) {
        console.warn('[EAS] password manager unavailable:', e.message);
      }
      if (account.password) {
        try {
          await messenger.easAccount.storePassword(account.host, account.username, account.password);
          await this._stripStoredPassword(account.id);
          console.log('[EAS] moved password into Thunderbird\'s password manager');
        } catch (e) {
          console.warn('[EAS] could not migrate password:', e.message);
        }
        return account.password;
      }
      return '';
    }

    return account.password || '';
  }

  async _stripStoredPassword(accountId) {
    const { accounts = [] } = await messenger.storage.local.get('accounts');
    const idx = accounts.findIndex(a => a.id === accountId);
    if (idx < 0) return;
    delete accounts[idx].password;
    await messenger.storage.local.set({ accounts });
  }

  // ── Scheduling ────────────────────────────────────────────────────

  _scheduleAlarm(account) {
    const name = ALARM_PREFIX + account.id;
    messenger.alarms.create(name, {
      delayInMinutes:  0.1,
      periodInMinutes: account.syncInterval || DEFAULT_INTERVAL_MIN,
    });
  }

  handleAlarm(alarm) {
    if (!alarm.name.startsWith(ALARM_PREFIX)) return;
    const id = alarm.name.slice(ALARM_PREFIX.length);
    const sync = this.syncs.get(id);
    if (sync) this._syncAccount(id, sync);
  }

  async syncAll() {
    for (const [id, sync] of this.syncs) this._syncAccount(id, sync);
  }

  async _syncAccount(id, sync) {
    const current = this.status.get(id) || {};
    if (current.syncing) return;

    // Skip quietly while backing off: no requests, no error flash, no fresh
    // quarantine notification mail for the user.
    if (sync.isBackingOff()) {
      this.status.set(id, {
        ...current,
        syncing: false,
        error: sync.account.backoffReason,
        errorCode: sync.account.backoffCode,
        backoffRemainingMs: sync.backoffRemainingMs(),
      });
      this._notifyStatus(id);
      return;
    }

    this.status.set(id, { ...current, syncing: true, error: null, errorCode: null });
    this._notifyStatus(id);

    try {
      await sync.sync();
      this.status.set(id, {
        lastSync: Date.now(), error: null, errorCode: null,
        syncing: false, pushing: sync.pushing,
      });
      if (sync.account.push !== false && !sync.pushing) this._startPush(id, sync);
    } catch (e) {
      this._setError(id, e, sync);
    }

    this._notifyStatus(id);
  }

  _setError(id, error, sync = null) {
    const isEas = error instanceof EasError;
    this.status.set(id, {
      ...this.status.get(id),
      syncing:   false,
      error:     error.message,
      errorCode: isEas ? error.code : ERR.SERVER_ERROR,
      backoffRemainingMs: sync?.backoffRemainingMs() || 0,
    });

    if (isEas && error.code === ERR.DEVICE_BLOCKED) {
      console.warn(`[EAS] device refused for account ${id}: ${error.message}`);
    } else {
      console.error(`[EAS] sync failed for account ${id}:`, error);
    }
    this._log(id, [error.message]);
    this._notifyStatus(id);
  }

  _startPush(id, sync) {
    sync.startPushLoop()
      .catch(e => this._log(id, [`push loop ended: ${e.message}`]))
      .finally(() => {
        const st = this.status.get(id);
        if (st) this.status.set(id, { ...st, pushing: false });
      });
    const st = this.status.get(id);
    if (st) this.status.set(id, { ...st, pushing: true });
  }

  // ── Outgoing mail ─────────────────────────────────────────────────

  _listenCompose() {
    messenger.compose.onBeforeSend.addListener(async (tab, details) => {
      const sync = this._findSyncByEmail(details.from || '');
      if (!sync) return {};   // not ours — let Thunderbird send it normally

      try {
        const mime = await this._buildMime(tab);
        await sync.sendMail(mime);
        return { cancel: true };   // sent over EAS; suppress the SMTP send
      } catch (e) {
        console.error('[EAS] SendMail failed:', e);
        this._notify('Sending failed',
          `The message could not be sent over ActiveSync: ${e.message}`);
        // Cancelling keeps the compose window open with the message intact so
        // it can be retried, rather than silently dropping it.
        return { cancel: true };
      }
    });
  }

  _findSyncByEmail(from) {
    const addr = String(from).replace(/.*<(.+)>.*/, '$1').trim().toLowerCase();
    if (!addr) return null;
    for (const [, sync] of this.syncs) {
      // SMTP addresses are not case sensitive — the server may well answer
      // with different capitalisation than was configured.
      if (sync.account.username?.toLowerCase() === addr) return sync;
      if (sync.account.email?.toLowerCase() === addr)    return sync;
    }
    return null;
  }

  async _buildMime(tab) {
    const details     = await messenger.compose.getComposeDetails(tab.id);
    const attachments = await messenger.compose.listAttachments(tab.id);

    const isHtml = details.isPlainText === false;
    const bodyCT = isHtml ? 'text/html' : 'text/plain';
    const bodyQP = quotedPrintable(
      isHtml ? (details.body || '') : (details.plainTextBody || details.body || '')
    );

    const headers = [];
    if (details.from)        headers.push(`From: ${details.from}`);
    if (details.to?.length)  headers.push(`To: ${details.to.join(', ')}`);
    if (details.cc?.length)  headers.push(`Cc: ${details.cc.join(', ')}`);
    if (details.bcc?.length) headers.push(`Bcc: ${details.bcc.join(', ')}`);
    if (details.subject)     headers.push(`Subject: ${encodeHeaderWord(details.subject)}`);
    headers.push(`Date: ${new Date().toUTCString()}`);
    headers.push('MIME-Version: 1.0');
    headers.push(`Message-ID: <${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@thunderbird-eas>`);

    if (attachments.length === 0) {
      headers.push(`Content-Type: ${bodyCT}; charset=UTF-8`);
      headers.push('Content-Transfer-Encoding: quoted-printable');
      headers.push('');
      headers.push(bodyQP);
      return headers.join('\r\n');
    }

    const boundary = `_TB_EAS_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

    const parts = [headers.join('\r\n'), ''];
    parts.push([
      `--${boundary}`,
      `Content-Type: ${bodyCT}; charset=UTF-8`,
      'Content-Transfer-Encoding: quoted-printable',
      '',
      bodyQP,
    ].join('\r\n'));

    for (const attachment of attachments) {
      const file = await attachment.getFile();
      const name = file.name || attachment.name || 'attachment';
      parts.push([
        `--${boundary}`,
        `Content-Type: ${file.type || 'application/octet-stream'}; name="${sanitizeParam(name)}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; ${encodeFilenameParam(name)}`,
        '',
        base64Lines(await file.arrayBuffer()),
      ].join('\r\n'));
    }

    parts.push(`--${boundary}--`);
    return parts.join('\r\n');
  }

  // ── Local change propagation ──────────────────────────────────────

  _listenMessages() {
    if (messenger.messages.onUpdated) {
      messenger.messages.onUpdated.addListener(async (msg, props) => {
        if (!('read' in props)) return;
        for (const [, sync] of this.syncs) {
          try {
            if (await sync.propagateReadFlag(msg.id, props.read)) break;
          } catch (e) {
            console.warn('[EAS] read-flag propagation failed:', e.message);
          }
        }
      });
    }

    if (messenger.messages.onDeleted) {
      messenger.messages.onDeleted.addListener(async messages => {
        for (const msg of messages.messages || messages || []) {
          for (const [, sync] of this.syncs) {
            try {
              if (await sync.propagateDelete(msg.id)) break;
            } catch (e) {
              console.warn('[EAS] delete propagation failed:', e.message);
            }
          }
        }
      });
    }
  }

  // ── UI API ────────────────────────────────────────────────────────

  handleMessage(msg) {
    switch (msg.type) {
      case 'GET_STATUS':       return this._getStatus();
      case 'GET_ACCOUNTS':     return this._getAccounts();
      case 'GET_PROFILES':     return this._getProfiles();
      case 'GET_CAPABILITIES': return this._getCapabilities();
      case 'ADD_ACCOUNT':      return this._uiAddAccount(msg.account);
      case 'UPDATE_ACCOUNT':   return this._uiUpdateAccount(msg.accountId, msg.patch);
      case 'REMOVE_ACCOUNT':   return this._uiRemoveAccount(msg.accountId);
      case 'SYNC_NOW':         return this._uiSyncNow(msg.accountId);
      case 'TEST_CONNECTION':  return this._uiTestConnection(msg.account);
      case 'AUTODISCOVER':     return this._uiAutodiscover(msg.account);
      case 'PROBE_PROFILES':   return this._uiProbeProfiles(msg.account);
      case 'PROBE_EWS':        return this._uiProbeEws(msg.account);
      case 'LIST_TB_ACCOUNTS': return this._uiListTbAccounts();
      case 'REMOVE_TB_ACCOUNT':return this._uiRemoveTbAccount(msg.accountKey);
      case 'GET_LOG':          return Promise.resolve(this.logs.get(msg.accountId) || []);
      default:                 return Promise.resolve(null);
    }
  }

  async _getCapabilities() {
    return {
      privileged:   typeof messenger.easAccount !== 'undefined',
      codePageErrors: verifyCodePages(),
    };
  }

  /**
   * Profile metadata for the setup page. The Settings/DeviceInformation fields
   * are included so the custom-profile form can be seeded from a working
   * fingerprint rather than presented empty.
   */
  async _getProfiles() {
    // Through resolveProfile so the Thunderbird entry reports the version and
    // platform actually installed, which is what it will send on the wire.
    return DEVICE_PROFILES.map(raw => resolveProfile({ deviceProfileId: raw.id })).map(p => ({
      id:         p.id,
      label:      p.label,
      deviceType: p.deviceType,
      userAgent:  p.userAgent,
      model:      p.model,
      os:         p.os,
      osLanguage: p.osLanguage,
      friendlyName: p.friendlyName,
      maxVersion: p.maxVersion,
      verified:   p.verified,
      note:       p.note,
    }));
  }

  async _getStatus() {
    const out = {};
    for (const [id, st] of this.status) {
      const sync = this.syncs.get(id);
      out[id] = { ...st, backoffRemainingMs: sync ? sync.backoffRemainingMs() : 0 };
    }
    return out;
  }

  async _getAccounts() {
    const { accounts = [] } = await messenger.storage.local.get('accounts');
    return accounts.map(({ password, ...rest }) => ({ ...rest, hasPassword: true }));
  }

  /** A throwaway client for the setup page, using the profile under test. */
  _probeClient(data, deviceId) {
    return new EasClient({
      host:            data.host,
      username:        data.username,
      password:        data.password,
      deviceId:        deviceId,
      policyKey:       '0',
      deviceProfileId: data.deviceProfileId || DEFAULT_PROFILE_ID,
      customProfile:   data.customProfile || null,
      authEncoding:    data.authEncoding || 'utf-8',
    });
  }

  async _uiTestConnection(data) {
    const deviceId = data.deviceId || await this._peekDeviceId(data);
    const client = this._probeClient(data, deviceId);
    try {
      const info = await client.options();
      return {
        success: true,
        version: info.chosen,
        versions: info.versions,
        commands: info.commands,
        server: info.server,
        deviceType: client.deviceType,
        userAgent: client.userAgent,
        note: info.note,
      };
    } catch (e) {
      return {
        success: false,
        error: e.message,
        code: e instanceof EasError ? e.code : null,
        detail: e instanceof EasError ? e.detail : null,
      };
    }
  }

  async _uiAutodiscover(data) {
    const lines = [];
    const log = line => lines.push(line);
    try {
      const found = await discover(data.email || data.username, data.username, data.password, { log });
      return { success: !!found, ...found, log: lines };
    } catch (e) {
      return { success: false, error: e.message, log: lines };
    }
  }

  async _uiProbeEws(data) {
    const lines = [];
    const result = await probeEws(data.email || data.username, data.username, data.password, {
      log: line => lines.push(line),
    });
    return { ...result, log: lines };
  }

  /**
   * Compare how the server reacts to each device fingerprint.
   *
   * Deliberately reuses one DeviceId across all variants. Even so, Exchange
   * keys partnerships on DeviceId *and* DeviceType, so this can still create
   * one partnership per probed type and consume the mailbox device quota —
   * the setup page warns before offering the button.
   */
  async _uiProbeProfiles(data) {
    const deviceId = data.deviceId || await this._peekDeviceId(data);
    const client = this._probeClient(data, deviceId);
    try {
      const results = await client.probeFingerprints(DEVICE_PROFILES);
      return { success: true, deviceId, results };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /** Reuse the DeviceId of a configured account on the same host, if any. */
  async _peekDeviceId(data) {
    const { accounts = [] } = await messenger.storage.local.get('accounts');
    const match = accounts.find(a =>
      a.host === data.host && a.username?.toLowerCase() === String(data.username).toLowerCase());
    return match?.deviceId || generateDeviceId();
  }

  async _uiAddAccount(data) {
    const host = String(data.host || '')
      .replace(/^https?:\/\//i, '').split('/')[0].split('?')[0].trim();
    if (!host) return { success: false, error: 'Server address is required' };

    // Adding the same mailbox twice generates a second DeviceId, and Exchange
    // counts that as another device partnership against a per-mailbox quota
    // that is commonly five. Cheap to prevent, tedious to undo.
    const { accounts = [] } = await messenger.storage.local.get('accounts');
    const duplicate = accounts.find(a =>
      a.host?.toLowerCase() === host.toLowerCase() &&
      a.username?.toLowerCase() === String(data.username).toLowerCase());
    if (duplicate) {
      return {
        success: false,
        error: `${data.username} on ${host} is already configured. Remove the existing account ` +
               'first — adding it twice would register a second device with the server and use ' +
               'another slot of the mailbox device quota.',
      };
    }

    const account = {
      id:              crypto.randomUUID(),
      host,
      username:        data.username,
      email:           data.email || data.username,
      fullName:        data.fullName || '',
      enabled:         true,
      // A stable DeviceId is the single most important piece of client state:
      // Exchange treats a changed DeviceId as a brand new device, which starts
      // a fresh quarantine cycle and consumes another slot of the mailbox
      // device quota. Generated once, never regenerated.
      deviceId:        generateDeviceId(),
      deviceProfileId: data.deviceProfileId || DEFAULT_PROFILE_ID,
      customProfile:   data.customProfile || null,
      authEncoding:    data.authEncoding || 'utf-8',
      filterType:      data.filterType ?? FILTER_TYPE.ALL,
      push:            data.push !== false,
      folderSyncKey:   '0',
      folders:         {},
      policyKey:       '0',
      syncInterval:    data.syncInterval || DEFAULT_INTERVAL_MIN,
    };

    if (typeof messenger.easAccount !== 'undefined') {
      try {
        await messenger.easAccount.storePassword(host, account.username, data.password);
      } catch (e) {
        console.warn('[EAS] could not use the password manager, storing in extension storage:', e.message);
        account.password = data.password;
      }
    } else {
      account.password = data.password;
    }

    accounts.push(account);
    await messenger.storage.local.set({ accounts });

    await this._addAccount({ ...account, password: data.password });

    const sync = this.syncs.get(account.id);
    if (sync) this._syncAccount(account.id, sync);

    return { success: true, accountId: account.id };
  }

  async _uiUpdateAccount(accountId, patch) {
    const { accounts = [] } = await messenger.storage.local.get('accounts');
    const idx = accounts.findIndex(a => a.id === accountId);
    if (idx < 0) return { success: false, error: 'unknown account' };

    // Changing the device profile changes the DeviceType on the wire, and
    // Exchange keys a partnership on DeviceId + DeviceType — the new profile
    // registers as an additional device and the old entry has to be removed in
    // OWA by hand. Say so rather than doing it silently.
    const profileChanged = patch.deviceProfileId &&
      patch.deviceProfileId !== accounts[idx].deviceProfileId;

    Object.assign(accounts[idx], patch);
    await messenger.storage.local.set({ accounts });

    const sync = this.syncs.get(accountId);
    if (sync) {
      sync.stopPushLoop();
      this.syncs.delete(accountId);
    }
    await this._addAccount(accounts[idx]);

    return { success: true, profileChanged };
  }

  async _uiRemoveAccount(accountId) {
    const sync = this.syncs.get(accountId);
    sync?.stopPushLoop();
    this.syncs.delete(accountId);
    this.status.delete(accountId);
    messenger.alarms.clear(ALARM_PREFIX + accountId).catch(() => {});

    const { accounts = [] } = await messenger.storage.local.get('accounts');
    const account = accounts.find(a => a.id === accountId);

    if (account && typeof messenger.easAccount !== 'undefined') {
      try { await messenger.easAccount.removePassword(account.host, account.username); } catch (_) {}
      if (account.tbAccountKey) {
        try {
          await messenger.easAccount.removeAccount(account.tbAccountKey);
        } catch (e) {
          console.warn('[EAS] could not remove the Thunderbird account node:', e.message);
        }
      }
    }

    await messenger.storage.local.set({ accounts: accounts.filter(a => a.id !== accountId) });

    // Drop the message-id maps too, otherwise they leak on every re-add.
    const all = await messenger.storage.local.get(null);
    const stale = Object.keys(all).filter(k =>
      k.startsWith(`mapping_${accountId}_`) || k === `rev_mapping_${accountId}`);
    if (stale.length) await messenger.storage.local.remove(stale);

    return { success: true };
  }

  /**
   * Thunderbird account nodes this add-on created, flagged with whether a
   * configured account still claims them.
   *
   * Thunderbird hides Delete and Set-as-default for "none"-type accounts, so a
   * node whose extension-side account is gone — a failed setup, a removed and
   * reinstalled add-on — cannot be deleted through Thunderbird's own UI at all.
   * This is the only way out for the user.
   */
  async _uiListTbAccounts() {
    if (typeof messenger.easAccount === 'undefined') {
      return { supported: false, accounts: [] };
    }

    const nodes = await messenger.easAccount.listAccounts();
    const { accounts = [] } = await messenger.storage.local.get('accounts');
    const claimed = new Set(accounts.map(a => a.tbAccountKey).filter(Boolean));

    return {
      supported: true,
      accounts: nodes.map(node => ({ ...node, orphaned: !claimed.has(node.accountKey) })),
    };
  }

  async _uiRemoveTbAccount(accountKey) {
    if (typeof messenger.easAccount === 'undefined') {
      return { success: false, error: 'privileged build not active' };
    }
    try {
      await messenger.easAccount.removeAccount(accountKey);

      // Detach it from any configured account so the next sync does not simply
      // recreate a node pointing at a key that no longer exists.
      const { accounts = [] } = await messenger.storage.local.get('accounts');
      let changed = false;
      for (const account of accounts) {
        if (account.tbAccountKey === accountKey) {
          delete account.tbAccountKey;
          changed = true;
          const sync = this.syncs.get(account.id);
          if (sync) { delete sync.account.tbAccountKey; sync.tbAccount = null; }
        }
      }
      if (changed) await messenger.storage.local.set({ accounts });

      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async _uiSyncNow(accountId) {
    if (accountId) {
      const sync = this.syncs.get(accountId);
      if (!sync) return { success: false, error: 'unknown account' };
      // An explicit user action clears the backoff — the user may well have
      // just approved the device in OWA.
      await sync._clearBackoff();
      this._syncAccount(accountId, sync);
    } else {
      for (const [id, sync] of this.syncs) {
        await sync._clearBackoff();
        this._syncAccount(id, sync);
      }
    }
    return { success: true };
  }

  // ── Helpers ───────────────────────────────────────────────────────

  _log(accountId, args) {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${args.map(String).join(' ')}`;
    const buffer = this.logs.get(accountId) || [];
    buffer.push(line);
    if (buffer.length > 200) buffer.shift();
    this.logs.set(accountId, buffer);
    console.log(`[EAS:${accountId}]`, ...args);
  }

  _notify(title, message) {
    if (!messenger.notifications) return;
    messenger.notifications.create({
      type: 'basic',
      title,
      message,
      iconUrl: messenger.runtime.getURL('icons/icon-48.png'),
    }).catch(() => {});
  }

  _notifyStatus(accountId) {
    messenger.runtime.sendMessage({
      type:      'STATUS_UPDATE',
      accountId,
      status:    this.status.get(accountId),
    }).catch(() => {});   // no listener open
  }
}

// ─────────────────────────────────────────────────────────────────────
// MIME helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Quoted-printable encoder.
 *
 * Encodes '=' as well as everything outside the printable ASCII range, and
 * folds at 76 characters with soft line breaks. Both matter: an unescaped '='
 * makes the body decode incorrectly at the far end, and over-long lines are
 * rejected outright by strict MTAs.
 */
function quotedPrintable(str) {
  const out = [];
  for (const rawLine of String(str).replace(/\r\n/g, '\n').split('\n')) {
    let line = '';
    const flush = () => { out.push(`${line}=`); line = ''; };

    for (const ch of rawLine) {
      const code = ch.codePointAt(0);
      const safe = code === 0x09 || (code >= 0x20 && code <= 0x7E && code !== 0x3D);
      const token = safe
        ? ch
        : Array.from(new TextEncoder().encode(ch),
            b => `=${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');

      if (line.length + token.length > 75) flush();
      line += token;
    }

    // Trailing whitespace must be encoded, otherwise it is stripped in transit.
    line = line.replace(/[ \t]$/, m => (m === ' ' ? '=20' : '=09'));
    out.push(line);
  }
  return out.join('\r\n');
}

function encodeHeaderWord(value) {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

function base64Lines(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunk = 8192;   // chunked: String.fromCharCode(...) blows the stack on large files
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const b64 = btoa(binary);
  return b64.match(/.{1,76}/g)?.join('\r\n') ?? b64;
}

function sanitizeParam(value) {
  return String(value).replace(/["\r\n]/g, '_');
}

function encodeFilenameParam(name) {
  if (/^[\x20-\x7E]*$/.test(name)) return `filename="${sanitizeParam(name)}"`;
  return `filename*=UTF-8''${encodeURIComponent(name)}`;
}
