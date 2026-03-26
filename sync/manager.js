/**
 * Sync manager – orchestrates all EAS accounts.
 *
 * - Loads accounts from storage on startup
 * - Schedules periodic sync via messenger.alarms
 * - Routes outgoing compose events to the right account
 * - Exposes API for the popup/setup UI via messaging
 */

import { AccountSync } from './email-sync.js';

const ALARM_NAME    = 'eas-sync';
const DEFAULT_INTERVAL_MIN = 5; // minutes

export class SyncManager {
  constructor() {
    this.syncs  = new Map();  // accountId → AccountSync
    this.status = new Map();  // accountId → { lastSync, error, syncing }
  }

  // ── Lifecycle ────────────────────────────────────────────────

  async start() {
    await this._loadAccounts();
    this._setupAlarm();
    this._listenCompose();
    this._listenMessages();
    console.log('[EAS] SyncManager started with', this.syncs.size, 'accounts');
  }

  async _loadAccounts() {
    const { accounts = [] } = await messenger.storage.local.get('accounts');
    for (const account of accounts) {
      if (!account.enabled) continue;
      await this._addAccount(account);
    }
  }

  async _addAccount(account) {
    const sync = new AccountSync(account);
    this.syncs.set(account.id, sync);
    this.status.set(account.id, { lastSync: null, error: null, syncing: false });
    try {
      await sync.initialize();
    } catch (e) {
      console.error(`[EAS] Failed to initialize account ${account.username}:`, e);
      this.status.set(account.id, { lastSync: null, error: e.message, syncing: false });
    }
  }

  // ── Alarm-based sync ─────────────────────────────────────────

  _setupAlarm() {
    messenger.alarms.create(ALARM_NAME, {
      delayInMinutes:  0.1,
      periodInMinutes: DEFAULT_INTERVAL_MIN,
    });
    messenger.alarms.onAlarm.addListener(alarm => {
      if (alarm.name === ALARM_NAME) this.syncAll();
    });
  }

  async syncAll() {
    for (const [id, sync] of this.syncs) {
      const st = this.status.get(id);
      if (st?.syncing) continue;
      this._syncAccount(id, sync);
    }
  }

  async _syncAccount(id, sync) {
    this.status.set(id, { ...this.status.get(id), syncing: true, error: null });
    this._notifyStatus(id);
    try {
      await sync.sync();
      this.status.set(id, { lastSync: Date.now(), error: null, syncing: false });
    } catch (e) {
      const isQuarantined = e.message === 'DEVICE_QUARANTINED';
      const userMsg = isQuarantined
        ? 'Device quarantined – waiting for admin approval in Outlook Web App → Options → Phone → Mobile Devices'
        : e.message;
      if (!isQuarantined) console.error(`[EAS] Sync failed for account ${id}:`, e);
      else                console.warn(`[EAS] Device quarantined for account ${id} – needs admin approval`);
      this.status.set(id, { ...this.status.get(id), error: userMsg, syncing: false });
    }
    this._notifyStatus(id);
  }

  // ── Compose interception ─────────────────────────────────────

  _listenCompose() {
    messenger.compose.onBeforeSend.addListener(async (tab, details) => {
      // Check if From address matches an EAS account
      const from = details.from || '';
      const sync = this._findSyncByEmail(from);
      if (!sync) return; // not an EAS account, let Thunderbird handle normally

      // Cancel normal send and use EAS instead
      try {
        const mime = await this._buildMimeFromDetails(tab);
        await sync.sendMail(mime);
        return { cancel: true }; // prevent normal SMTP send
      } catch (e) {
        console.error('[EAS] SendMail failed:', e);
        // Show error to user but don't cancel – let them retry
        return { cancel: true };
      }
    });
  }

  _findSyncByEmail(email) {
    const addr = email.replace(/.*<(.+)>/, '$1').trim().toLowerCase();
    for (const [, sync] of this.syncs) {
      if (sync.account.username.toLowerCase() === addr) return sync;
      if (sync.account.email?.toLowerCase() === addr)    return sync;
    }
    return null;
  }

  async _buildMimeFromDetails(tab) {
    // Get full compose details and attachment list
    const full        = await messenger.compose.getComposeDetails(tab.id);
    const attachments = await messenger.compose.listAttachments(tab.id);

    const isHtml = full.isPlainText === false;
    const bodyQP = this._quotedPrintableEncode(
      isHtml ? (full.body || '') : (full.plainTextBody || full.body || '')
    );
    const bodyCT = isHtml ? 'text/html' : 'text/plain';

    // ── Top-level message headers ──────────────────────────────
    const hdr = [];
    if (full.from)        hdr.push(`From: ${full.from}`);
    if (full.to?.length)  hdr.push(`To: ${full.to.join(', ')}`);
    if (full.cc?.length)  hdr.push(`Cc: ${full.cc.join(', ')}`);
    if (full.bcc?.length) hdr.push(`Bcc: ${full.bcc.join(', ')}`);
    if (full.subject)     hdr.push(`Subject: ${this._encodeMimeHeader(full.subject)}`);
    hdr.push(`Date: ${new Date().toUTCString()}`);
    hdr.push(`MIME-Version: 1.0`);
    hdr.push(`Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@thunderbird-eas>`);

    // ── No attachments: single-part (original behaviour) ───────
    if (attachments.length === 0) {
      hdr.push(`Content-Type: ${bodyCT}; charset=UTF-8`);
      hdr.push(`Content-Transfer-Encoding: quoted-printable`);
      hdr.push('');
      hdr.push(bodyQP);
      return hdr.join('\r\n');
    }

    // ── Attachments present: multipart/mixed ───────────────────
    const boundary = `_TB_EAS_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    hdr.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

    // message headers + mandatory blank line before first boundary
    const out = [hdr.join('\r\n'), ''];

    // Body part
    out.push([
      `--${boundary}`,
      `Content-Type: ${bodyCT}; charset=UTF-8`,
      `Content-Transfer-Encoding: quoted-printable`,
      '',
      bodyQP,
    ].join('\r\n'));

    // One part per attachment
    for (const att of attachments) {
      const file    = await att.getFile();
      const buf     = await file.arrayBuffer();
      const ct      = file.type || 'application/octet-stream';
      const name    = file.name || att.name || 'attachment';
      const b64     = this._base64Encode(buf);
      const fnParam = this._encodeAttachmentFilename(name);

      out.push([
        `--${boundary}`,
        `Content-Type: ${ct}; name="${name}"`,
        `Content-Transfer-Encoding: base64`,
        `Content-Disposition: attachment; ${fnParam}`,
        '',
        b64,
      ].join('\r\n'));
    }

    out.push(`--${boundary}--`);
    return out.join('\r\n');
  }

  _encodeMimeHeader(subject) {
    // Encode non-ASCII using RFC 2047 base64
    if (/^[\x00-\x7F]*$/.test(subject)) return subject;
    const b64 = btoa(unescape(encodeURIComponent(subject)));
    return `=?UTF-8?B?${b64}?=`;
  }

  _quotedPrintableEncode(str) {
    // Simple QP encoder – good enough for common characters
    return str.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, c => {
      const bytes = new TextEncoder().encode(c);
      return Array.from(bytes).map(b => `=${b.toString(16).toUpperCase().padStart(2,'0')}`).join('');
    });
  }

  _base64Encode(arrayBuffer) {
    // Chunked to avoid spread-call stack overflow on large files
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const b64 = btoa(binary);
    // MIME requires base64 lines to be at most 76 characters
    return b64.match(/.{1,76}/g)?.join('\r\n') ?? b64;
  }

  _encodeAttachmentFilename(name) {
    // ASCII-only: plain filename parameter
    if (/^[\x20-\x7E]*$/.test(name)) return `filename="${name}"`;
    // Non-ASCII: RFC 5987 extended parameter
    return `filename*=UTF-8''${encodeURIComponent(name)}`;
  }

  // ── Message event listeners ───────────────────────────────────

  _listenMessages() {
    // Propagate read-flag changes back to EAS server
    if (messenger.messages.onUpdated) {
      messenger.messages.onUpdated.addListener(async (msg, props) => {
        if (!('read' in props)) return;
        for (const [, sync] of this.syncs) {
          await sync.propagateReadFlag(msg.folder?.id, msg.id, props.read);
        }
      });
    }
  }

  // ── UI messaging API ─────────────────────────────────────────

  handleMessage(msg, sender) {
    switch (msg.type) {
      case 'GET_STATUS':       return this._getStatus();
      case 'GET_ACCOUNTS':     return this._getAccounts();
      case 'ADD_ACCOUNT':      return this._uiAddAccount(msg.account);
      case 'REMOVE_ACCOUNT':   return this._uiRemoveAccount(msg.accountId);
      case 'SYNC_NOW':         return this._uiSyncNow(msg.accountId);
      case 'TEST_CONNECTION':  return this._uiTestConnection(msg.account);
    }
  }

  async _uiTestConnection(accountData) {
    const { EasClient } = await import('../eas/client.js');
    const client = new EasClient({
      host:      accountData.host,
      username:  accountData.username,
      password:  accountData.password,
      deviceId:  await this._getOrCreateDeviceId(),
      policyKey: '0',
    });
    try {
      const info = await client.options();
      return { success: true, version: info.chosen, versions: info.versions };
    } catch (e) {
      return { success: false, error: e.message, detail: e.stack?.split('\n')[1] };
    }
  }

  async _getStatus() {
    const result = {};
    for (const [id, st] of this.status) result[id] = st;
    return result;
  }

  async _getAccounts() {
    const { accounts = [] } = await messenger.storage.local.get('accounts');
    // Omit passwords from UI response
    return accounts.map(({ password, ...rest }) => ({ ...rest, hasPassword: !!password }));
  }

  async _uiAddAccount(accountData) {
    const account = {
      id:              crypto.randomUUID(),
      host:            accountData.host.replace(/^https?:\/\//i, '').split('/')[0].split('?')[0],
      username:        accountData.username,
      email:           accountData.email || accountData.username,
      password:        accountData.password,
      enabled:         true,
      deviceId:        await this._getOrCreateDeviceId(),
      deviceProfileId: accountData.deviceProfileId || 'iPhone',
      folderSyncKey:   '0',
      folders:         {},
      policyKey:       '0',
      syncInterval:    accountData.syncInterval || DEFAULT_INTERVAL_MIN,
    };

    const { accounts = [] } = await messenger.storage.local.get('accounts');
    accounts.push(account);
    await messenger.storage.local.set({ accounts });

    await this._addAccount(account);
    // Kick off initial sync in the background
    const sync = this.syncs.get(account.id);
    if (sync) this._syncAccount(account.id, sync);

    return { success: true, accountId: account.id };
  }

  async _uiRemoveAccount(accountId) {
    this.syncs.delete(accountId);
    this.status.delete(accountId);

    const { accounts = [] } = await messenger.storage.local.get('accounts');
    const account = accounts.find(a => a.id === accountId);

    // Remove the dedicated TB account node created via Experiments API (if available)
    if (account?.tbAccountKey && typeof messenger.easAccount !== 'undefined') {
      try {
        await messenger.easAccount.removeAccount(account.tbAccountKey);
        console.log('[EAS] Removed TB account node:', account.tbAccountKey);
      } catch (e) {
        console.warn('[EAS] Could not remove TB account node:', e.message);
      }
    }

    const updated = accounts.filter(a => a.id !== accountId);
    await messenger.storage.local.set({ accounts: updated });
    return { success: true };
  }

  async _uiSyncNow(accountId) {
    if (accountId) {
      const sync = this.syncs.get(accountId);
      if (sync) this._syncAccount(accountId, sync);
    } else {
      this.syncAll();
    }
    return { success: true };
  }

  _notifyStatus(accountId) {
    messenger.runtime.sendMessage({
      type:      'STATUS_UPDATE',
      accountId,
      status:    this.status.get(accountId),
    }).catch(() => {}); // ignore if no listeners
  }

  async _getOrCreateDeviceId() {
    const { deviceId } = await messenger.storage.local.get('deviceId');
    if (deviceId) return deviceId;
    const id = crypto.randomUUID().replace(/-/g, '').toUpperCase().slice(0, 32);
    await messenger.storage.local.set({ deviceId: id });
    return id;
  }
}
