/**
 * EAS HTTP transport (MS-ASHTTP).
 *
 * Responsibilities:
 *  - plain-text query string in the exact form real clients emit
 *  - Basic auth with selectable charset
 *  - protocol version negotiation, capped by the active device profile
 *  - the two-phase Provision handshake and automatic retry
 *  - translating HTTP status codes *and* in-band WBXML <Status> values into
 *    one error taxonomy the sync layer can act on
 *
 * The in-band part is the one that costs people days: from protocol version
 * 14.0 onwards Exchange reports almost every error as a WBXML <Status> inside
 * an HTTP 200 response. A client that only inspects `resp.status` sees
 * "200 OK" plus an empty folder tree and starts looking in the wrong place.
 */

import {
  EAS_PATH, MIME_WBXML, MIME_RFC822,
  VERSION_PREFERENCE, INVALID_CLIENT_VERSIONS, DEFAULT_VERSION, versionValue,
  STATUS, PROVISION_REQUIRED_STATUS, DEVICE_BLOCKED_STATUS, describeStatus,
  resolveProfile,
} from './protocol.js';
import { encode, decode, el, tel, eel, bel, find, getText } from './wbxml.js';
import { buildDeviceInformation, buildSettings } from './commands.js';

// ─────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────

export const ERR = {
  NETWORK:        'NETWORK',
  AUTH_FAILED:    'AUTH_FAILED',
  DEVICE_BLOCKED: 'DEVICE_BLOCKED',
  THROTTLED:      'THROTTLED',
  REDIRECT:       'REDIRECT',
  NOT_FOUND:      'NOT_FOUND',
  PROTOCOL:       'PROTOCOL',
  SERVER_ERROR:   'SERVER_ERROR',
  PROVISION_LOOP: 'PROVISION_LOOP',
  MAILBOX_FULL:   'MAILBOX_FULL',
  PASSWORD_EXPIRED: 'PASSWORD_EXPIRED',
};

export class EasError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name   = 'EasError';
    this.code   = code;
    this.detail = detail;
  }
  /** Errors where retrying soon is pointless and noisy. */
  get isFatalForNow() {
    return this.code === ERR.DEVICE_BLOCKED ||
           this.code === ERR.AUTH_FAILED ||
           this.code === ERR.PASSWORD_EXPIRED;
  }
}

/**
 * A 403 has two very different causes and the response body does not always
 * distinguish them. Both are actionable by the same person in the same place,
 * so the message names both rather than guessing.
 */
const FORBIDDEN_HELP =
  'HTTP 403 — the server refused this device. Two causes are possible and both are fixed in ' +
  'OWA → Options → Phone → Mobile Devices: (a) an Allow/Block/Quarantine rule rejects this ' +
  'DeviceType / User-Agent — try the "Outlook Desktop" or "iPhone" device profile; ' +
  '(b) the mailbox device-partnership quota is exhausted (commonly 5) — delete stale devices there.';

/**
 * Say which of the blocking conditions actually occurred.
 *
 * A generic "the server refuses this device" sends people looking for a block
 * list when the real cause is a full device quota — a different problem with a
 * different fix.
 */
function describeBlockedStatus(cmd, status) {
  switch (status) {
    case STATUS.MAX_DEVICES_REACHED:
      return `${cmd} returned status 177 (MaximumDevicesReached) — the mailbox has reached its ` +
        'limit of ActiveSync device partnerships, commonly five. Delete devices you no longer ' +
        'use in OWA → Options → Phone → Mobile Devices. Note that Exchange counts a partnership ' +
        'per DeviceId *and* DeviceType, so an earlier device profile of this add-on occupies a ' +
        'slot of its own — including one that is still sitting in quarantine.';
    case STATUS.DEVICE_BLOCKED:
      return `${cmd} returned status 129 (DeviceIsBlockedForThisUser) — this device is on the ` +
        'block list for this mailbox. An administrator has to release it, or a different device ' +
        'profile may be accepted; "Compare device profiles" on the setup page will tell you.';
    case STATUS.USER_DISABLED_FOR_SYNC:
      return `${cmd} returned status 126 (UserDisabledForSync) — ActiveSync is switched off for ` +
        'this mailbox entirely. Only an administrator can enable it.';
    default:
      return `${cmd} returned status ${status} — the server refuses this device. Check the ` +
        'mobile device list in OWA → Options → Phone → Mobile Devices.';
  }
}

// ─────────────────────────────────────────────────────────────────────
// Client
// ─────────────────────────────────────────────────────────────────────

export class EasClient {
  /**
   * @param {object} account
   * @param {string} account.host          e.g. 'eas.example.com'
   * @param {string} account.username      full SMTP login
   * @param {string} account.password
   * @param {string} account.deviceId      stable 32-char hex, persisted
   * @param {string} [account.policyKey]
   * @param {string} [account.easVersion]  last negotiated version
   * @param {string} [account.authEncoding] 'utf-8' (default) | 'iso-8859-1'
   * @param {function} [account.onPolicyKeyUpdated]
   * @param {function} [account.onVersionNegotiated]
   * @param {function} [account.onResyncRequired]  fired on a real X-MS-RP
   */
  constructor(account) {
    this.account      = account;
    this.baseUrl      = `https://${account.host}${EAS_PATH}`;
    this.policyKey    = account.policyKey || '0';
    this.profile      = resolveProfile(account);
    this.easVersion   = this._clampVersion(account.easVersion || this.profile.maxVersion || DEFAULT_VERSION);
    this.authEncoding = account.authEncoding || 'utf-8';

    this.serverVersions = [];
    this.serverCommands = [];
    this.log = account.log || ((...a) => console.log('[EAS]', ...a));
  }

  get deviceType() { return this.profile.deviceType; }
  get userAgent()  { return this.profile.userAgent; }

  // ── Request plumbing ───────────────────────────────────────────────

  /**
   * Basic credentials.
   *
   * Real Outlook encodes this header as ISO-8859-1 while every mobile client
   * uses UTF-8; Z-Push carries an explicit workaround for it (ZP-864). With
   * pure ASCII credentials both encodings are byte-identical, so this only
   * matters once the login or password contains non-ASCII characters — at
   * which point the failure looks like a plain wrong password and is
   * essentially undiscoverable. UTF-8 is the default; the account can opt into
   * ISO-8859-1.
   */
  _authHeader() {
    const raw = `${this.account.username}:${this.account.password}`;
    let binary = '';
    if (this.authEncoding === 'iso-8859-1') {
      for (const ch of raw) {
        const cp = ch.codePointAt(0);
        binary += String.fromCharCode(cp <= 0xFF ? cp : 0x3F); // '?' for unrepresentable
      }
    } else {
      for (const b of new TextEncoder().encode(raw)) binary += String.fromCharCode(b);
    }
    return `Basic ${btoa(binary)}`;
  }

  _headers(extra = {}, { policyKey = true } = {}) {
    const headers = {
      'Authorization':        this._authHeader(),
      'MS-ASProtocolVersion': this.easVersion,
      'User-Agent':           this.userAgent,
      ...extra,
    };
    // MS-ASHTTP: X-MS-PolicyKey is not sent with Autodiscover, Ping or OPTIONS.
    if (policyKey) headers['X-MS-PolicyKey'] = this.policyKey;
    return headers;
  }

  /**
   * Plain-text query string.
   *
   * Deliberately hand-built rather than via URLSearchParams: the parameter
   * order (Cmd, User, DeviceId, DeviceType) is part of the fingerprint, and
   * URLSearchParams would percent-encode the '@' in the user name, which no
   * real client does. Base64 query encoding is not implemented — it is only
   * legal from 12.1, saves about 20 bytes, and buys an extra failure path.
   */
  _url(cmd, extraParams = {}) {
    const enc = v => encodeURIComponent(String(v)).replace(/%40/g, '@');
    const parts = [
      `Cmd=${enc(cmd)}`,
      `User=${enc(this.account.username)}`,
      `DeviceId=${enc(this.account.deviceId)}`,
      `DeviceType=${enc(this.deviceType)}`,
    ];
    for (const [k, v] of Object.entries(extraParams)) {
      if (v !== undefined && v !== null) parts.push(`${enc(k)}=${enc(v)}`);
    }
    return `${this.baseUrl}?${parts.join('&')}`;
  }

  _clampVersion(v) {
    const cap = this.profile?.maxVersion;
    if (cap && versionValue(v) > versionValue(cap)) return cap;
    return v;
  }

  /**
   * X-MS-RP tells the client to discard its sync state after a server upgrade.
   * Exchange also emits it on first contact carrying nothing but the version
   * list — reacting to that with a full resync would wipe the mailbox state on
   * every fresh setup. Only a value that is not a version list is treated as a
   * real resync signal.
   */
  _checkResyncHeader(resp) {
    const rp = resp.headers.get('X-MS-RP');
    if (!rp) return;
    const looksLikeVersionList = /^[\d.,\s]+$/.test(rp);
    if (looksLikeVersionList) {
      this.log('X-MS-RP carried only a version list — not treating it as a resync request');
      return;
    }
    this.log('X-MS-RP received — server requests a full resync');
    this.account.onResyncRequired?.();
  }

  /** Map an HTTP response that is not 200 onto the error taxonomy. */
  async _httpError(cmd, resp) {
    const status = resp.status;
    let bodySnippet = '';
    try {
      const text = await resp.text();
      bodySnippet = text.slice(0, 512);
    } catch { /* body already consumed or binary */ }

    switch (status) {
      case 401:
        return new EasError(ERR.AUTH_FAILED,
          'Authentication failed — check user name and password. ' +
          'If the password contains non-ASCII characters, try the ISO-8859-1 auth encoding.',
          { status, cmd });
      case 403:
        return new EasError(ERR.DEVICE_BLOCKED, FORBIDDEN_HELP,
          { status, cmd, deviceType: this.deviceType, userAgent: this.userAgent, body: bodySnippet });
      case 404:
        return new EasError(ERR.NOT_FOUND,
          `HTTP 404 for ${this.baseUrl} — this host does not serve ActiveSync at that path.`,
          { status, cmd });
      case 451: {
        const location = resp.headers.get('X-MS-Location');
        return new EasError(ERR.REDIRECT,
          location
            ? `Server redirected this mailbox to ${location}.`
            : 'Server redirected this mailbox but sent no X-MS-Location; re-run Autodiscover.',
          { status, cmd, location });
      }
      case 456:
        return new EasError(ERR.AUTH_FAILED, 'HTTP 456 — the account is blocked on the server.', { status, cmd });
      case 457:
        return new EasError(ERR.PASSWORD_EXPIRED,
          'HTTP 457 — the password has expired and must be changed.',
          { status, cmd, serviceUrl: resp.headers.get('X-MS-Credential-Service-Url') });
      case 503: {
        const retryAfter = parseInt(resp.headers.get('Retry-After') || '', 10);
        const throttle   = resp.headers.get('X-MS-ASThrottle');
        return new EasError(ERR.THROTTLED,
          throttle
            ? `Server is throttling this client (${throttle}).`
            : 'Server temporarily unavailable (HTTP 503).',
          { status, cmd, retryAfterSec: Number.isFinite(retryAfter) ? retryAfter : null, throttle });
      }
      case 507:
        return new EasError(ERR.MAILBOX_FULL, 'HTTP 507 — the mailbox is out of space.', { status, cmd });
      case 501:
        return new EasError(ERR.PROTOCOL, `Server does not implement ${cmd} (HTTP 501).`, { status, cmd });
      case 400:
        return new EasError(ERR.PROTOCOL,
          `HTTP 400 for ${cmd} — malformed request or protocol version ${this.easVersion} not supported.`,
          { status, cmd, body: bodySnippet });
      default:
        return new EasError(ERR.SERVER_ERROR, `EAS ${cmd} returned HTTP ${status}.`,
          { status, cmd, body: bodySnippet });
    }
  }

  async _fetch(url, init) {
    try {
      return await fetch(url, init);
    } catch (e) {
      throw new EasError(ERR.NETWORK,
        `Network error reaching ${this.account.host}: ${e.message}`, { cause: e.message });
    }
  }

  // ── OPTIONS / version negotiation ──────────────────────────────────

  /**
   * Negotiate the protocol version.
   *
   * Falls back to reading MS-ASProtocolVersions off a FolderSync response when
   * OPTIONS is stripped or answered without the header — some proxies remove
   * it, and some servers require authentication even for OPTIONS.
   */
  async options() {
    const resp = await this._fetch(this.baseUrl, {
      method:  'OPTIONS',
      headers: this._headers({}, { policyKey: false }),
    });

    if (resp.status === 403) throw await this._httpError('OPTIONS', resp);
    if (resp.status !== 200 && resp.status !== 401) {
      throw await this._httpError('OPTIONS', resp);
    }

    const versions = splitHeader(resp.headers.get('MS-ASProtocolVersions'));
    const commands = splitHeader(resp.headers.get('MS-ASProtocolCommands'));
    const server   = resp.headers.get('MS-Server-ActiveSync') || null;

    this.serverVersions = versions;
    this.serverCommands = commands;

    const chosen = this.negotiate(versions);
    this.easVersion = chosen;
    this.account.onVersionNegotiated?.(chosen);

    return {
      versions, commands, chosen, server,
      authRequired: resp.status === 401,
      note: versions.length === 0
        ? 'server sent no MS-ASProtocolVersions header; using the profile default'
        : null,
    };
  }

  /**
   * Highest version that (a) we implement, (b) the server advertises and
   * (c) the active device profile can plausibly speak.
   */
  negotiate(serverVersions = []) {
    const usable = serverVersions.filter(v => !INVALID_CLIENT_VERSIONS.includes(v));
    const cap    = this.profile?.maxVersion || DEFAULT_VERSION;

    const candidates = VERSION_PREFERENCE.filter(v => versionValue(v) <= versionValue(cap));
    const chosen = candidates.find(v => usable.includes(v));
    if (chosen) return chosen;

    // Server advertised nothing we recognise (or nothing at all).
    return candidates[0] || DEFAULT_VERSION;
  }

  // ── Command execution ──────────────────────────────────────────────

  /**
   * Send a WBXML command and return the decoded response tree.
   *
   * @param {string} cmd
   * @param {Uint8Array|object} body  encoded bytes or a node tree
   * @param {object} [opts]
   * @param {boolean} [opts.autoProvision=true]  handle in-band 142/144 transparently
   * @param {object}  [opts.params]              extra query parameters
   * @param {number}  [opts.timeoutMs]
   * @returns {Promise<{doc: object|null, bytes: Uint8Array, status: string|null}>}
   */
  async execute(cmd, body, opts = {}) {
    // A Sync carrying a window of full MIME bodies is not a quick request, and
    // the server may already be busy with this device's parked Ping.
    const { autoProvision = true, params = {}, timeoutMs = 180000 } = opts;
    const bytes = body instanceof Uint8Array ? body : encode(body);

    const result = await this._send(cmd, bytes, params, timeoutMs);
    const status = topLevelStatus(result.doc);

    if (status && status !== STATUS.SUCCESS) {
      if (DEVICE_BLOCKED_STATUS.has(status)) {
        throw new EasError(ERR.DEVICE_BLOCKED, describeBlockedStatus(cmd, status), { cmd, status });
      }

      // 165 also lands here: provision() sends the device information the
      // server is asking for, so the same provision-and-retry cycle fixes it.
      const needsProvisioning = PROVISION_REQUIRED_STATUS.has(status) ||
                                status === STATUS.DEVICE_INFORMATION_REQUIRED;

      if (autoProvision && needsProvisioning) {
        this.log(`${cmd}: in-band status ${status} → provisioning, then retrying once`);
        await this.provision();
        const retry = await this._send(cmd, bytes, params, timeoutMs);
        const retryStatus = topLevelStatus(retry.doc);
        if (retryStatus && PROVISION_REQUIRED_STATUS.has(retryStatus)) {
          throw new EasError(ERR.PROVISION_LOOP,
            `${cmd} still reports status ${retryStatus} after provisioning — giving up to avoid a loop.`,
            { cmd, status: retryStatus });
        }
        return { ...retry, status: retryStatus };
      }
    }

    return { ...result, status };
  }

  async _send(cmd, bytes, params, timeoutMs) {
    const controller = new AbortController();
    // Our own timeout and a genuine connection failure both surface as an
    // AbortError. Distinguishing them keeps "the operation was aborted" out of
    // the log where "timed out" is the truth.
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);

    let resp;
    try {
      resp = await this._fetch(this._url(cmd, params), {
        method:  'POST',
        headers: this._headers({ 'Content-Type': MIME_WBXML }),
        body:    bytes,
        signal:  controller.signal,
      });
    } catch (e) {
      if (timedOut) {
        throw new EasError(ERR.NETWORK,
          `${cmd} timed out after ${Math.round(timeoutMs / 1000)}s`,
          { cmd, timeout: true });
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }

    this._checkResyncHeader(resp);

    // HTTP 449 is the pre-14.0 way of demanding provisioning. Handled by the
    // caller of _send via execute(); here we surface it as a typed error.
    if (resp.status === 449) {
      throw new EasError(ERR.PROTOCOL, 'HTTP 449 — provisioning required', { http449: true, cmd });
    }
    if (resp.status !== 200) throw await this._httpError(cmd, resp);

    const buf   = await resp.arrayBuffer();
    const bytesOut = new Uint8Array(buf);
    let doc = null;
    if (bytesOut.length > 0) {
      try {
        doc = decode(bytesOut);
      } catch (e) {
        throw new EasError(ERR.PROTOCOL, `${cmd}: could not decode WBXML response — ${e.message}`,
          { cmd, bytes: hexPreview(bytesOut) });
      }
    }
    return { doc, bytes: bytesOut };
  }

  /**
   * Wrapper that also converts an HTTP 449 into a provision-and-retry, so
   * callers do not need to know which of the two mechanisms a server uses.
   */
  async request(cmd, body, opts = {}) {
    try {
      return await this.execute(cmd, body, opts);
    } catch (e) {
      if (e instanceof EasError && e.detail?.http449 && opts.autoProvision !== false && !opts._retried) {
        this.log(`${cmd}: HTTP 449 → provisioning, then retrying once`);
        await this.provision();
        return this.execute(cmd, body, { ...opts, _retried: true });
      }
      throw e;
    }
  }

  // ── Provisioning ───────────────────────────────────────────────────

  /**
   * Two-phase Provision handshake.
   *
   * Phase 1 asks for the policy and receives a temporary key; phase 2
   * acknowledges it and receives the permanent key.
   *
   * Policy/Status = 2 ("policy not defined") is *not* an error — the server
   * simply enforces nothing. Acknowledging in that case is unnecessary, and
   * treating it as a failure is the single most common misreading against
   * open-source servers that carry no policies at all.
   */
  async provision({ allowDeviceInfoRetry = true } = {}) {
    this.log('Provision phase 1: requesting policy');
    this.policyKey = '0';

    // From 14.1 the server expects Settings/DeviceInformation inside the
    // Provision request, ahead of Policies. Omitting it makes Exchange answer
    // status 165 (DeviceInformationRequired) before issuing any policy — which
    // is what blocked every 14.1 profile in this add-on until now. At 14.0 the
    // element does not exist, and real Outlook does not send it either.
    const email = this.account.email || this.account.username;
    const withDeviceInfo = versionValue(this.easVersion) >= 141;

    const phase1Request = el('Provision', 'Provision',
      withDeviceInfo ? buildDeviceInformation(this.profile, { email }) : null,
      el('Provision', 'Policies',
        el('Provision', 'Policy',
          tel('Provision', 'PolicyType', 'MS-EAS-Provisioning-WBXML'))));

    let phase1;
    try {
      phase1 = await this._provisionRequest(phase1Request);
    } catch (e) {
      // Belt and braces: a server that wants the device information by way of
      // the standalone Settings command still gets it.
      if (allowDeviceInfoRetry && e instanceof EasError && e.detail?.deviceInformationRequired) {
        this.log('Provision: server requires device information first — sending Settings, then retrying');
        await this.execute('Settings', encode(buildSettings(this.profile, { email })),
          { autoProvision: false });
        return this.provision({ allowDeviceInfoRetry: false });
      }
      throw e;
    }

    const p1 = this._readProvision(phase1.doc, 'phase 1');

    if (p1.policyStatus === '2') {
      this.log('Provision: server defines no policy (Policy/Status=2) — continuing without a key');
      this._setPolicyKey('0');
      return { policyKey: '0', policyless: true };
    }

    if (!p1.policyKey) {
      // Some servers answer without a key at all; '1' is the conventional
      // stand-in so subsequent requests carry a non-zero key.
      this.log('Provision: no PolicyKey in phase 1 response — continuing with key 1');
      this._setPolicyKey('1');
      return { policyKey: '1', policyless: true };
    }

    this.log('Provision phase 2: acknowledging policy');
    this.policyKey = p1.policyKey;

    const phase2 = await this._provisionRequest(
      el('Provision', 'Provision',
        el('Provision', 'Policies',
          el('Provision', 'Policy',
            tel('Provision', 'PolicyType', 'MS-EAS-Provisioning-WBXML'),
            tel('Provision', 'PolicyKey',  p1.policyKey),
            tel('Provision', 'Status',     '1'))))
    );

    const p2 = this._readProvision(phase2.doc, 'phase 2');
    const finalKey = p2.policyKey || p1.policyKey;
    this._setPolicyKey(finalKey);
    this.log('Provision complete, policy key acquired');
    return { policyKey: finalKey, policy: p1.policy };
  }

  _setPolicyKey(key) {
    this.policyKey = key;
    this.account.policyKey = key;
    this.account.onPolicyKeyUpdated?.(key);
  }

  async _provisionRequest(node) {
    // autoProvision must be off here — otherwise a provision failure would
    // recurse into provisioning.
    return this.execute('Provision', encode(node), { autoProvision: false });
  }

  /**
   * Read a Provision response.
   *
   * Path anchoring is essential: `Provision/Status` and
   * `Provision/Policies/Policy/Status` carry the same tag name, and an
   * unanchored search returns whichever comes first.
   */
  _readProvision(doc, phase) {
    if (!doc) throw new EasError(ERR.PROTOCOL, `Provision ${phase}: empty response`);

    const root = doc.tag === 'Provision' ? doc : find(doc, 'Provision:Provision');
    if (!root) throw new EasError(ERR.PROTOCOL, `Provision ${phase}: no Provision element in response`);

    const provStatus = getText(root, 'Provision:Status');
    if (provStatus && provStatus !== STATUS.SUCCESS) {
      if (provStatus === STATUS.DEVICE_INFORMATION_REQUIRED) {
        throw new EasError(ERR.PROTOCOL,
          `Provision ${phase}: the server requires Settings/DeviceInformation before provisioning ` +
          '(status 165).',
          { phase, status: provStatus, deviceInformationRequired: true });
      }
      if (DEVICE_BLOCKED_STATUS.has(provStatus)) {
        throw new EasError(ERR.DEVICE_BLOCKED,
          describeBlockedStatus(`Provision ${phase}`, provStatus),
          { phase, status: provStatus });
      }
      if (provStatus === STATUS.DEVICE_NOT_PROVISIONABLE) {
        throw new EasError(ERR.PROTOCOL,
          `Provision ${phase}: server reports the device is not provisionable (status 141).`,
          { phase, status: provStatus });
      }
      throw new EasError(ERR.SERVER_ERROR,
        `Provision ${phase} failed with status ${provStatus}.`, { phase, status: provStatus });
    }

    const policy = find(root, 'Provision:Policies', 'Provision:Policy');
    if (!policy) return { policyKey: null, policyStatus: null, policy: null };

    return {
      policyKey:    getText(policy, 'Provision:PolicyKey'),
      policyStatus: getText(policy, 'Provision:Status'),
      policy:       find(policy, 'Provision:Data'),
    };
  }

  // ── SendMail ───────────────────────────────────────────────────────

  /**
   * Send a message.
   *
   * From 14.0 the ComposeMail code page replaced the raw-MIME body: SendMail
   * is a WBXML request carrying <Mime>. The old form (Content-Type
   * message/rfc822 with the MIME as the entire body) is 2.5/12.x only. The
   * previous implementation always used the old form, which modern Exchange
   * accepts inconsistently at best.
   *
   * @param {string|Uint8Array} mimeData
   * @param {object} [opts]
   * @param {boolean} [opts.saveInSent=true]
   */
  async sendMail(mimeData, opts = {}) {
    const { saveInSent = true } = opts;
    const mime = typeof mimeData === 'string' ? mimeData : new TextDecoder().decode(mimeData);

    if (versionValue(this.easVersion) >= 140) {
      // MS-ASCMD models the Mime element's value as opaque data, and Exchange
      // itself emits OPAQUE for message bodies — but servers differ, and a
      // rejected encoding comes back as the thoroughly unhelpful status 102
      // (InvalidWBXML). Rather than guess, try opaque and fall back to an
      // inline string once. Whichever works is remembered for this session.
      const encodings = this._mimeEncoding ? [this._mimeEncoding] : ['opaque', 'inline'];
      let lastStatus = null;

      for (const encoding of encodings) {
        const status = await this._sendMailOnce(mime, saveInSent, encoding);
        if (status === null || status === STATUS.SUCCESS) {
          this._mimeEncoding = encoding;
          return;
        }
        lastStatus = status;
        if (status !== STATUS.INVALID_WBXML) break;   // not an encoding problem
        this.log(`SendMail rejected the ${encoding} MIME encoding (status ${status})`);
      }

      throw new EasError(ERR.SERVER_ERROR,
        `SendMail failed with status ${describeStatus(lastStatus)}.`, { status: lastStatus });
    }

    // Legacy path for 12.x and 2.5.
    const body = new TextEncoder().encode(mime);
    const resp = await this._fetch(this._url('SendMail', { SaveInSent: saveInSent ? 'T' : 'F' }), {
      method:  'POST',
      headers: this._headers({ 'Content-Type': MIME_RFC822 }),
      body,
    });

    if (resp.status === 449) {
      await this.provision();
      return this.sendMail(mimeData, opts);
    }
    if (resp.status !== 200 && resp.status !== 201 && resp.status !== 204) {
      throw await this._httpError('SendMail', resp);
    }
  }

  /**
   * One SendMail attempt.
   * @returns {Promise<string|null>} the reported status, or null for an empty
   *   (successful) response.
   */
  async _sendMailOnce(mime, saveInSent, encoding) {
    const clientId = `TBEAS${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    const node = el('ComposeMail', 'SendMail',
      tel('ComposeMail', 'ClientId', clientId),
      saveInSent ? eel('ComposeMail', 'SaveInSentItems') : null,
      encoding === 'opaque'
        ? bel('ComposeMail', 'Mime', new TextEncoder().encode(mime))
        : tel('ComposeMail', 'Mime', mime),
    );

    const { doc } = await this.request('SendMail', encode(node));
    // An empty body means success; a body carries a <Status>.
    return doc ? getText(doc, 'ComposeMail:Status') : null;
  }

  // ── Ping ───────────────────────────────────────────────────────────

  /**
   * Long-poll for changes.
   *
   * The request must carry either HeartbeatInterval or Folders (or both); an
   * empty body reuses the server-cached request. The HTTP timeout has to
   * exceed the heartbeat, otherwise the client kills its own long poll.
   *
   * @param {number} heartbeatSec
   * @param {Array<{id: string, class: string}>} folders
   * @param {AbortSignal} [signal]
   * @returns {Promise<{status: string, changedFolders: string[], limit: number|null}>}
   */
  async ping(heartbeatSec, folders, signal) {
    const node = el('Ping', 'Ping',
      tel('Ping', 'HeartbeatInterval', String(heartbeatSec)),
      el('Ping', 'Folders',
        ...folders.map(f => el('Ping', 'Folder',
          tel('Ping', 'Id', f.id),
          tel('Ping', 'Class', f.class || 'Email'),
        ))),
    );

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    // Generous margin over the heartbeat so the server, not us, decides when
    // the poll ends.
    const timer = setTimeout(() => controller.abort(), (heartbeatSec + 60) * 1000);

    let resp;
    try {
      resp = await this._fetch(this._url('Ping'), {
        method:  'POST',
        headers: this._headers({ 'Content-Type': MIME_WBXML }, { policyKey: false }),
        body:    encode(node),
        signal:  controller.signal,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    if (resp.status === 449) {
      await this.provision();
      throw new EasError(ERR.PROTOCOL, 'Ping needed provisioning; retry the loop', { transient: true });
    }
    if (resp.status !== 200) throw await this._httpError('Ping', resp);

    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.length === 0) return { status: '1', changedFolders: [], limit: null };

    const doc  = decode(buf);
    const root = doc?.tag === 'Ping' ? doc : find(doc, 'Ping:Ping');
    const status = root ? getText(root, 'Ping:Status') : null;

    const foldersNode = root ? find(root, 'Ping:Folders') : null;
    const changed = foldersNode
      ? foldersNode.children.filter(c => c.tag === 'Folder').map(c => c.text)
      : [];

    // Status 5 answers with the HeartbeatInterval the server will accept,
    // status 6 with MaxFolders. Ignoring those turns the Ping loop into a
    // tight retry loop against the same rejected parameters.
    const num = v => (v === null || v === undefined || v === '' ? null : parseInt(v, 10));
    const heartbeatLimit = root ? num(getText(root, 'Ping:HeartbeatInterval')) : null;
    const folderLimit    = root ? num(getText(root, 'Ping:MaxFolders')) : null;

    return { status: status || '1', changedFolders: changed, heartbeatLimit, folderLimit, doc };
  }

  // ── Diagnostics ────────────────────────────────────────────────────

  /**
   * Try a minimal FolderSync under several device fingerprints and report how
   * the server reacts to each. This is the in-add-on form of the standalone
   * probe script and answers the only question that matters when a setup is
   * refused: is this server rejecting the credentials, or the fingerprint?
   *
   * All variants deliberately reuse the same DeviceId — see the caveat below.
   *
   * CAVEAT for the caller's UI: Exchange keys a device partnership on DeviceId
   * *and* DeviceType, so a probe across N device types can still create up to N
   * partnerships and eat into the per-mailbox quota. Warn before running it.
   */
  async probeFingerprints(profiles) {
    const savedProfile = this.profile;
    const savedVersion = this.easVersion;
    const results = [];

    const folderSync0 = encode(
      el('FolderHierarchy', 'FolderSync', tel('FolderHierarchy', 'SyncKey', '0'))
    );

    try {
      for (const profile of profiles) {
        this.profile    = profile;
        this.easVersion = this._clampVersion(profile.maxVersion || DEFAULT_VERSION);

        const entry = {
          profileId:  profile.id,
          deviceType: profile.deviceType,
          userAgent:  profile.userAgent,
          version:    this.easVersion,
        };

        try {
          const resp = await this._fetch(this._url('FolderSync'), {
            method:  'POST',
            headers: this._headers({ 'Content-Type': MIME_WBXML }),
            body:    folderSync0,
          });
          entry.http = resp.status;

          const buf = new Uint8Array(await resp.arrayBuffer());
          entry.bytes = buf.length;

          if (resp.status === 200 && buf.length) {
            try {
              const doc = decode(buf);
              entry.easStatus = topLevelStatus(doc);
              entry.verdict = entry.easStatus === STATUS.SUCCESS ? 'accepted'
                : entry.easStatus === STATUS.DEVICE_NOT_PROVISIONED ? 'accepted (provisioning required)'
                : `accepted, status ${entry.easStatus}`;
            } catch {
              entry.verdict = 'accepted (response not decodable)';
            }
          } else if (resp.status === 403) {
            entry.verdict = 'rejected — ABQ rule or device quota';
          } else if (resp.status === 401) {
            entry.verdict = 'credentials rejected';
          } else {
            entry.verdict = `HTTP ${resp.status}`;
          }
        } catch (e) {
          entry.verdict = `error: ${e.message}`;
        }

        results.push(entry);
      }
    } finally {
      this.profile    = savedProfile;
      this.easVersion = savedVersion;
    }

    return results;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function splitHeader(value) {
  return (value || '').split(',').map(s => s.trim()).filter(Boolean);
}

/** Command-level <Status>, i.e. a direct child of the root element. */
export function topLevelStatus(doc) {
  if (!doc || !doc.children) return null;
  const node = doc.children.find(c => c.tag === 'Status');
  return node ? node.text : null;
}

function hexPreview(bytes, max = 32) {
  return Array.from(bytes.slice(0, max)).map(b => b.toString(16).padStart(2, '0')).join(' ');
}
