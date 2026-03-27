/**
 * EAS HTTP client.
 *
 * Handles:
 *  - Basic authentication over HTTPS
 *  - MS-ASProtocolVersion header negotiation
 *  - EAS Provision handshake (policy key exchange)
 *  - Automatic retry after provisioning
 */

import { EAS_VERSION, DEVICE_TYPE, USER_AGENT, DEVICE_PROFILES, resolveProfile } from './protocol.js';

const MIME_WBXML    = 'application/vnd.ms-sync.wbxml';
const MIME_RFC822   = 'message/rfc822';
const EAS_PATH      = '/Microsoft-Server-ActiveSync';

export class EasClient {
  /**
   * @param {object} account
   * @param {string} account.host        e.g. 'eas.example.com'
   * @param {string} account.username
   * @param {string} account.password
   * @param {string} account.deviceId    stable UUID for this installation
   * @param {string} [account.policyKey] persisted after provisioning
   * @param {function} account.onPolicyKeyUpdated  callback(newKey)
   */
  constructor(account) {
    this.account    = account;
    this.baseUrl    = `https://${account.host}${EAS_PATH}`;
    this.policyKey  = account.policyKey || '0';
    this.easVersion = account.easVersion || EAS_VERSION;

    const profile   = resolveProfile(account);
    this.deviceType  = profile.deviceType;
    this.userAgent   = profile.userAgent;
    this.deviceModel = profile.model;
    this.deviceOs    = profile.os;
  }

  // ── Helpers ──────────────────────────────────────────────────────

  _authHeader() {
    const token = btoa(`${this.account.username}:${this.account.password}`);
    return `Basic ${token}`;
  }

  _baseHeaders(extra = {}) {
    return {
      'Authorization':       this._authHeader(),
      'MS-ASProtocolVersion': this.easVersion,
      'X-MS-PolicyKey':       this.policyKey,
      'User-Agent':           this.userAgent,
      ...extra,
    };
  }

  _url(cmd, extraParams = {}) {
    const params = new URLSearchParams({
      Cmd:        cmd,
      User:       this.account.username,
      DeviceId:   this.account.deviceId,
      DeviceType: this.deviceType,
      ...extraParams,
    });
    return `${this.baseUrl}?${params}`;
  }

  // ── OPTIONS – discover supported protocol versions ────────────────

  async options() {
    let resp;
    try {
      resp = await fetch(this.baseUrl, {
        method:  'OPTIONS',
        headers: { Authorization: this._authHeader(), 'User-Agent': this.userAgent },
      });
    } catch (netErr) {
      throw new Error(`Network error reaching ${this.account.host}: ${netErr.message}`);
    }

    // 401 with WWW-Authenticate: Basic is expected when auth is required for OPTIONS.
    // The MS-ASProtocolVersions header may still be present on 401.
    if (!resp.ok && resp.status !== 401 && resp.status !== 200) {
      throw new Error(`OPTIONS returned HTTP ${resp.status} – check server address and credentials`);
    }

    const versions = (resp.headers.get('MS-ASProtocolVersions') || '').split(',')
      .map(v => v.trim()).filter(Boolean);
    const commands = (resp.headers.get('MS-ASProtocolCommands') || '').split(',')
      .map(c => c.trim()).filter(Boolean);

    // If server gave no versions header on 401, it still confirms the endpoint exists.
    // Fall back to a sensible default and treat as success.
    const preferred = ['16.1','16.0','14.1','14.0','12.1','12.0'];
    const chosen = preferred.find(v => versions.includes(v)) || EAS_VERSION;
    this.easVersion = chosen;

    // 401 with no version header = endpoint reachable, credentials will be verified on first Sync
    if (resp.status === 401 && versions.length === 0) {
      return { versions: [chosen], commands, chosen, note: 'endpoint reachable (auth confirmed)' };
    }

    return { versions, commands, chosen };
  }

  // ── Core request method ───────────────────────────────────────────

  /**
   * Send a WBXML request and return a WBXML response as ArrayBuffer.
   * Handles 449 (Retry After Provision) automatically.
   */
  async request(cmd, wbxmlBytes, retried = false) {
    const resp = await fetch(this._url(cmd), {
      method:  'POST',
      headers: this._baseHeaders({ 'Content-Type': MIME_WBXML }),
      body:    wbxmlBytes,
    });

    if (resp.status === 449 || resp.status === 451) {
      if (retried) throw new Error('Provision loop – giving up');
      await this.provision();
      return this.request(cmd, wbxmlBytes, true);
    }

    if (resp.status === 401) throw new Error('Authentication failed – check credentials');
    if (!resp.ok)            throw new Error(`EAS ${cmd} returned HTTP ${resp.status}`);

    const buf = await resp.arrayBuffer();
    return buf;
  }

  /**
   * Send a raw MIME message (for SendMail EAS 14+).
   */
  async sendRawMime(mimeData, retried = false) {
    const body = typeof mimeData === 'string'
      ? new TextEncoder().encode(mimeData)
      : mimeData;

    const resp = await fetch(this._url('SendMail'), {
      method:  'POST',
      headers: this._baseHeaders({
        'Content-Type':   MIME_RFC822,
        'Content-Length': String(body.byteLength),
      }),
      body,
    });

    if (resp.status === 449) {
      if (retried) throw new Error('Provision loop on SendMail – giving up');
      await this.provision();
      return this.sendRawMime(mimeData, true);
    }

    if (!resp.ok && resp.status !== 200 && resp.status !== 201 && resp.status !== 204) {
      throw new Error(`SendMail failed: HTTP ${resp.status}`);
    }
    // HTTP 201 No Content = success
  }

  // ── EAS Provisioning ─────────────────────────────────────────────

  /**
   * Two-phase EAS provisioning:
   *  Phase 1: Request policy → receive policy data + temporary key
   *  Phase 2: Acknowledge with status=1 → receive permanent key
   */
  async provision() {
    const { encode, decode, el, tel } = await import('./wbxml.js');

    console.log('[EAS] Provisioning: Phase 1 – requesting policy');

    // Phase 1 – request policies
    const req1 = el('Provision', 'Provision',
      el('Provision', 'Policies',
        el('Provision', 'Policy',
          tel('Provision', 'PolicyType', 'MS-EAS-Provisioning-WBXML')
        )
      )
    );
    const buf1 = await this._rawRequest('Provision', encode(req1));
    const doc1 = decode(buf1);
    const tmpKey = this._extractPolicyKey(doc1, 'phase1');
    console.log('[EAS] Provisioning: Phase 1 tmpKey =', tmpKey);

    // Phase 2 – acknowledge (we accept all policies)
    this.policyKey = tmpKey;
    const req2 = el('Provision', 'Provision',
      el('Provision', 'Policies',
        el('Provision', 'Policy',
          tel('Provision', 'PolicyType', 'MS-EAS-Provisioning-WBXML'),
          tel('Provision', 'PolicyKey', tmpKey),
          tel('Provision', 'Status', '1'),
        )
      )
    );
    const buf2 = await this._rawRequest('Provision', encode(req2));
    const doc2 = decode(buf2);
    const finalKey = this._extractPolicyKey(doc2, 'phase2');
    console.log('[EAS] Provisioning: Phase 2 finalKey =', finalKey);
    this.policyKey = finalKey;

    if (this.account.onPolicyKeyUpdated) {
      this.account.onPolicyKeyUpdated(finalKey);
    }
  }

  /**
   * Extract the PolicyKey from a Provision response.
   * Several server response shapes are handled:
   *   A) Provision > Policies > Policy > PolicyKey  (standard)
   *   B) Provision > Policies > Policy (no PolicyKey – server has no policy)
   *   C) Provision > Status only (server accepts but sends no policy)
   *
   * In cases B/C we return '1' so the client can proceed with a non-zero key.
   */
  _extractPolicyKey(doc, phase = '') {
    if (!doc) {
      console.warn('[EAS] Provision', phase, ': empty response, using key 1');
      return '1';
    }

    const root = doc.tag === 'Provision' ? doc : doc.children?.find(c => c.tag === 'Provision');
    if (!root) {
      console.warn('[EAS] Provision', phase, ': no Provision root, doc.tag=', doc.tag, ' using key 1');
      return '1';
    }

    // Log full structure for debugging
    const summary = root.children.map(c => `${c.tag}="${c.text || ''}"`).join(', ');
    console.log('[EAS] Provision', phase, 'root children:', summary);

    const provStatus = root.children.find(c => c.tag === 'Status')?.text;
    if (provStatus && provStatus !== '1') {
      if (provStatus === '165') {
        throw new Error('DEVICE_QUARANTINED');
      }
      throw new Error(`Provision ${phase} failed with status ${provStatus}`);
    }

    const policiesNode = root.children.find(c => c.tag === 'Policies');
    if (!policiesNode) {
      console.warn('[EAS] Provision', phase, ': no Policies element, using key 1');
      return '1';
    }

    const policyNode = policiesNode.children?.find(c => c.tag === 'Policy');
    if (!policyNode) {
      console.warn('[EAS] Provision', phase, ': no Policy element, using key 1');
      return '1';
    }

    const policyStatus = policyNode.children.find(c => c.tag === 'Status')?.text;
    const keyNode      = policyNode.children.find(c => c.tag === 'PolicyKey');

    if (!keyNode || !keyNode.text) {
      // Status 2 = no policy; server may not send a key
      console.log('[EAS] Provision', phase, ': no PolicyKey (policyStatus=', policyStatus, '), using 1');
      return '1';
    }

    return keyNode.text;
  }

  async _rawRequest(cmd, body) {
    const resp = await fetch(this._url(cmd), {
      method:  'POST',
      headers: this._baseHeaders({ 'Content-Type': MIME_WBXML }),
      body,
    });
    if (!resp.ok) throw new Error(`Provision/${cmd} HTTP ${resp.status}`);
    return resp.arrayBuffer();
  }
}
