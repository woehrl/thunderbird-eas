# Development Notes — Thunderbird EAS Connector

Technical reference for contributors and maintainers. Covers protocol specifics, architecture decisions, findings discovered during development, and known open problems.

---

## Table of Contents

1. [Repository Layout](#repository-layout)
2. [Build System](#build-system)
3. [Technology Stack](#technology-stack)
4. [Exchange ActiveSync Protocol](#exchange-activesync-protocol)
5. [WBXML Encoding](#wbxml-encoding)
6. [EAS Provisioning Flow](#eas-provisioning-flow)
7. [Thunderbird WebExtension API Notes](#thunderbird-webextension-api-notes)
8. [Experiments API (Real Account Node)](#experiments-api-real-account-node)
9. [Known Server Behaviours](#known-server-behaviours)
10. [Status Code Reference](#status-code-reference)
11. [State Persistence](#state-persistence)
12. [Device Identity](#device-identity)
13. [Popup Status UI](#popup-status-ui)
14. [Security Notes](#security-notes)
15. [Open Issues and Future Work](#open-issues-and-future-work)
16. [WBXML Code Page Index](#wbxml-code-page-index-eas-161)

---

## Repository Layout

```
thunderbird-eas/
├── manifest.json             # WebExtension manifest (MV2); experiment_apis absent by default
├── package.js                # Node.js build script → dist/*.xpi (standard + privileged)
├── README.md                 # User-facing documentation
├── DEVELOPMENT.md            # This file
│
├── background/
│   ├── background.html       # Background page (required for ES modules in MV2)
│   └── background.js         # Entry point: SyncManager start, message router
│
├── eas/
│   ├── protocol.js           # WBXML code page tables, EAS constants, device profiles
│   ├── wbxml.js              # WBXML 1.3 encoder/decoder
│   ├── commands.js           # Per-command request builders + response parsers
│   └── client.js             # HTTP transport: auth, headers, provision, retry
│
├── sync/
│   ├── manager.js            # SyncManager: alarm, compose interception, UI message handler
│   └── email-sync.js         # AccountSync: folder hierarchy + message import
│
├── experiments/
│   ├── schema.json           # WebExtension API schema (easAccount namespace)
│   └── implementation.js     # Privileged XPCOM implementation (injected by --privileged build)
│
└── ui/
    ├── setup/                # Account management page (options_ui)
    └── popup/                # Toolbar popup: per-account status indicators
```

---

## Build System

`package.js` is a dependency-free Node.js script. It has no npm dependencies — only Node.js stdlib (`fs`, `path`, `zlib`).

### What it does

1. Walks the directory tree recursively
2. Skips: `package.js`, `README.md`, `DEVELOPMENT.md`, `.git/`, `dist/`, `*.xpi`, dot-files
3. Writes a ZIP (stored, uncompressed) using a hand-rolled `ZipWriter` with CRC-32
4. Outputs to `dist/` with a timestamp suffix to avoid Windows file-lock conflicts

### Two build variants

```bash
node package.js              # Standard build
node package.js --privileged # Privileged build (injects experiment_apis into manifest)
```

| Variant | Output filename | Manifest difference |
|---|---|---|
| Standard | `thunderbird-eas-x.y.z-<ts>.xpi` | No `experiment_apis` key |
| Privileged | `thunderbird-eas-x.y.z-privileged-<ts>.xpi` | `experiment_apis` block injected at build time |

The `--privileged` flag causes the build script to inject the `experiment_apis` JSON block into `manifest.json` in-memory before adding it to the ZIP. The source `manifest.json` on disk is never modified. Both variants share 100% identical source code and the same addon ID (`thunderbird-eas@woehrl.biz`).

### Why manifest injection rather than a separate manifest

Keeping one `manifest.json` in source avoids drift between variants. The injected block is a constant string in `package.js`:

```javascript
const EXPERIMENT_API_BLOCK = `,
  "experiment_apis": {
    "easAccount": {
      "schema": "experiments/schema.json",
      "parent": {
        "scopes":  ["addon_parent"],
        "script":  "experiments/implementation.js",
        "events":  ["startup"]
      }
    }
  }`;
```

It is inserted before the final closing brace of `manifest.json` using a regex replace.

---

## Technology Stack

| Layer | Choice | Reason |
|---|---|---|
| Extension API | Thunderbird WebExtension (MV2) | Only stable public API for TB add-ons |
| Language | ES2020 modules (`type="module"`) | Supported natively in Gecko; no bundler needed |
| Protocol | Exchange ActiveSync 14.1 / 16.1 | Negotiated via OPTIONS; server decides max version |
| Encoding | WBXML 1.3 | Binary XML format mandated by EAS spec |
| Storage | `messenger.storage.local` | Persists across restarts; survives upgrades |
| Scheduling | `messenger.alarms` | Survives background page lifecycle |
| Build | Node.js (stdlib only) | Zero dependencies |

---

## Exchange ActiveSync Protocol

### Overview

EAS is a sync protocol carried over HTTPS POST to `/Microsoft-Server-ActiveSync`. Each request has:
- **URL parameters:** `Cmd`, `User`, `DeviceId`, `DeviceType`
- **Headers:** `MS-ASProtocolVersion`, `X-MS-PolicyKey`, `Authorization` (Basic), `User-Agent`
- **Body:** WBXML-encoded XML (or raw MIME for SendMail)

### Version Negotiation

1. Send `OPTIONS /Microsoft-Server-ActiveSync` (no body)
2. Server responds with `MS-ASProtocolVersions` header listing supported versions
3. Client picks the highest mutually supported version from the preferred list `['16.1','16.0','14.1','14.0','12.1','12.0']`
4. All subsequent requests carry `MS-ASProtocolVersion: <chosen>`

**Finding:** Some servers return HTTP 401 on OPTIONS (credentials required even for OPTIONS). The `MS-ASProtocolVersions` header may still be present on 401. We treat 401 + empty versions header as "endpoint reachable, proceed with default version" — credentials will be verified on first actual command.

### Device Profile System

Each EAS account has a `deviceProfileId` that selects one of three predefined profiles from `eas/protocol.js`:

| Profile ID | DeviceType | User-Agent | Model | OS | OSLanguage |
|---|---|---|---|---|---|
| `iPhone` | `iPhone` | `Apple-iPhone/702.67` | `iPhone` | `iOS 17.4.1` | `en-US` |
| `WindowsOutlook15` | `WindowsOutlook15` | `Outlook/16.0 (16.0.19426.20076; x86)` | `WindowsOutlook15` | — | — |
| `Android` | `Android` | `Android-Mail/2026.03.09.884664556.Release` | `SM-G975F` | `Android 12` | `en-US` |
| `Thunderbird` | `Thunderbird` | `Thunderbird/140.9` | `Thunderbird` | — | — |

The selected profile controls:
- `DeviceType` URL parameter
- `User-Agent` header
- `Settings/DeviceInformation` payload (Model, OS, OSLanguage, FriendlyName, UserAgent)

**Profile accuracy note:** The `WindowsOutlook15` and `Thunderbird` profiles intentionally send no `OS` or `OSLanguage`. A verified working Outlook 2016 connection on this server shows empty Gerätebetriebssystem and Gerätesprache in OWA — sending those fields would make the profile look *less* like real Outlook. Empty Gerätename is also normal for approved Outlook connections; Exchange simply does not populate it from `FriendlyName` for this device type.

`FriendlyName` is always suffixed with the account email — e.g. `Thunderbird EAS (user@domain)` — so the Exchange admin can identify which user the device belongs to when reviewing quarantined devices in OWA.

`Settings` is re-sent at the start of every sync cycle until `account.settingsConfirmed` is set. This flag is set after the first successful `FolderSync`. Exchange does not reliably persist `Settings/DeviceInformation` for devices in quarantine state, so the re-send ensures the device details appear in OWA after the admin approves the device.

### Commands Implemented

| Command | Description |
|---|---|
| `OPTIONS` | Version negotiation (HTTP OPTIONS, no WBXML) |
| `Settings` | Register device information with server |
| `Provision` | Two-phase policy key exchange |
| `FolderSync` | Sync folder hierarchy |
| `Sync` | Sync email items in a folder (fetch/change/delete) |
| `SendMail` | Send outgoing email as raw MIME |
| `MoveItems` | Move message between folders (implemented, not yet wired to UI) |
| `ItemOperations` | Fetch full MIME for items truncated in Sync response (`Truncated=1`) |

---

## WBXML Encoding

EAS uses **WBXML 1.3** (WAP Binary XML) — a compact binary encoding of XML with a predefined token vocabulary split across 24 "code pages" (namespaces).

### Key Encoding Rules

- **Document header:** `0x03 0x01 0x6A 0x00` (version 1.3, unknown charset, no string table)
- Each element is a single byte token (0x05–0x7F range; token | 0x40 means "has content")
- **Text nodes:** `STR_I (0x03)` + null-terminated UTF-8 string + `END (0x01)`
- **Namespace switch:** `SWITCH_PAGE (0x00)` + one-byte page index; affects all subsequent tokens until next switch

### Critical Code Page Findings

**Finding 1 — `CollectionId` is on page 6, not page 0:**

`CollectionId` lives in code page 6 (`GetItemEstimate`), not page 0 (`AirSync`), even when used inside a `Sync/Collections/Collection` element. Sending it on page 0 causes servers to silently reject or misinterpret the request.

```javascript
// CORRECT — triggers SWITCH_PAGE to page 6
tel('GetItemEstimate', 'CollectionId', collectionId)

// WRONG — encodes on AirSync page 0, server rejects
tel('AirSync', 'CollectionId', collectionId)
```

**Finding 2 — No `ApplicationData` wrapper in `Sync/Change`:**

`ApplicationData` is **not** a real WBXML element when sending flag changes. Properties go directly inside the `Change` element:

```javascript
el('AirSync', 'Change',
  tel('AirSync', 'ServerId', serverId),
  tel('Email', 'Read', '1'),   // directly inside Change
)
// NOT: el('AirSync', 'Change', el('AirSync', 'ApplicationData', tel('Email','Read','1')))
```

### Decoder Implementation

`wbxml.js` decodes a WBXML `ArrayBuffer` into a plain JS object tree:

```javascript
{ ns: 'AirSync', tag: 'Sync', children: [
  { ns: 'AirSync', tag: 'Collections', children: [...] }
]}
```

Text values are on `node.text` as a string. Binary opaque data is stored as `Uint8Array` on `node.text`.

---

## EAS Provisioning Flow

Provisioning is a two-phase handshake where the client obtains a **PolicyKey** token that must accompany every subsequent request. Without a valid PolicyKey the server returns HTTP 449 or EAS status 142.

### Phase 1 — Request Policy

```xml
<Provision>
  <Policies>
    <Policy>
      <PolicyType>MS-EAS-Provisioning-WBXML</PolicyType>
    </Policy>
  </Policies>
</Provision>
```

Server responds with policy data (password rules, device encryption requirements, etc.) and a **temporary** PolicyKey.

### Phase 2 — Acknowledge

```xml
<Provision>
  <Policies>
    <Policy>
      <PolicyType>MS-EAS-Provisioning-WBXML</PolicyType>
      <PolicyKey>{tmpKey}</PolicyKey>
      <Status>1</Status>   <!-- 1 = accept all policies -->
    </Policy>
  </Policies>
</Provision>
```

Server responds with the **permanent** PolicyKey. This key is stored in `messenger.storage.local` via `account.policyKey` and sent as `X-MS-PolicyKey` on every subsequent request.

### Trigger Conditions

| Trigger | Where | Action |
|---|---|---|
| HTTP 449 | `client.request()` | Calls `provision()`, retries once |
| HTTP 451 | `client.request()` | Same as 449 |
| EAS status 142 | `_syncFolders()` | Calls `client.provision()`, continues loop |
| EAS status 145 | `_syncFolders()` | Same as 142 |

### Robustness — `_extractPolicyKey()`

Servers vary widely in what they include in the Provision response. The method handles all observed variants:

| Response shape | Behaviour |
|---|---|
| Full response with `PolicyKey` | Returns key text |
| `Policies` present, no `PolicyKey` | Returns `'1'` (server has no policy to enforce) |
| No `Policies` node | Returns `'1'` |
| Empty / null response | Returns `'1'` |
| `Status` = 165 (quarantined) | Throws `Error('DEVICE_QUARANTINED')` |
| `Status` ≠ 1 (other failure) | Throws with status code |

---

## Thunderbird WebExtension API Notes

### Manifest Version

Thunderbird uses **Manifest V2**. Key differences from Firefox MV3 that caused bugs during development:

| MV3 pattern (wrong) | MV2 equivalent (correct) |
|---|---|
| Separate `"host_permissions"` key | Must go inside `"permissions": ["https://*/*"]` |
| `"composeAction"` in permissions | It is a manifest key, not a permission string |
| `"experiment_apis"` always available | Requires `extensions.experiments.enabled = true` for unsigned installs |

### Permissions Used

| Permission | Used for |
|---|---|
| `accountsRead` | List TB accounts to find Local Folders host |
| `accountsFolders` | Create / rename / delete folders |
| `messagesRead` | Read messages for ID mapping |
| `messagesDelete` | Delete server-deleted messages locally |
| `messagesMove` | Move messages between folders |
| `messagesImport` | Import EML blobs into TB folders |
| `compose` | Intercept outgoing mail via `onBeforeSend` |
| `storage` | Persist accounts, sync keys, message mappings |
| `alarms` | Periodic sync timer |
| `https://*/*` | `fetch()` to EAS servers |

### `messenger.folders.create(parent, name)`

Accepts either a `MailAccount` object **or** a `MailFolder` object as `parent`. Passing an account object directly creates the folder at the account root. This was discovered empirically — it is not clearly documented.

### `messenger.messages.import(file, folder, options)`

Accepts a `File` object with type `message/rfc822`. The `options` object supports `{ read: bool, flagged: bool }`.

### `onMessage` Response Pattern

When an `onMessage` listener needs to return data, it must either return a `Promise` or a synchronous value. Returning a plain object from a synchronous function is technically valid but can behave inconsistently depending on the Thunderbird version. Always use `async` to guarantee a `Promise` is returned:

```javascript
// Reliable across all TB versions
async _getStatus() {
  const result = {};
  for (const [id, st] of this.status) result[id] = st;
  return result;
}
```

Using a non-async function that returns a plain object worked in some versions but caused the popup to receive `undefined` in others.

---

## Experiments API (Real Account Node)

### Goal

Make EAS accounts appear as dedicated top-level nodes in Thunderbird's folder pane — identical to IMAP/POP3 accounts — rather than as subfolders inside Local Folders.

### How It Works

The Experiments API allows an extension to ship a privileged JavaScript file that runs in Thunderbird's main process with full XPCOM access. We define a custom WebExtension namespace `easAccount` that exposes two methods:

```javascript
// Creates a "none"-type incoming server + account via MailServices
async createAccount(email, hostname) → accountKey

// Removes the account and its local mail files
async removeAccount(accountKey)
```

The `createAccount` call uses:

```javascript
const server = MailServices.accounts.createIncomingServer(email, hostname, 'none');
server.prettyName = email;
server.valid = true;
const account = MailServices.accounts.createAccount();
account.incomingServer = server;
return account.key; // e.g. "account15"
```

Server type `'none'` is the same type used by Thunderbird's built-in Local Folders. Multiple `none`-type servers can coexist. The returned `account.key` is identical to the WebExtension `MailAccount.id`, so `messenger.accounts.get(key)` retrieves the account object for use with `messenger.folders.create`.

### Runtime Detection

`email-sync.js` checks for the API at runtime before using it:

```javascript
if (typeof messenger.easAccount !== 'undefined') {
  // Privileged path: create real account node
  const key = await messenger.easAccount.createAccount(email, host);
  ...
} else {
  // Fallback: subfolder inside Local Folders
  return this._ensureLocalFolder(email);
}
```

This means the same binary can handle both cases. Switching builds (standard ↔ privileged) without removing the extension first transparently switches the folder strategy while preserving all account data.

### Why `experiment_apis` Cannot Be Enabled at Runtime

This is a hard constraint of the WebExtension architecture:

```
manifest has experiment_apis  AND  extensions.experiments.enabled = true
        ↓                                    ↓
  TB loads the schema              TB grants privilege to run it
        └──────────────┬───────────────────┘
                       ↓
            messenger.easAccount exists
```

- **Manifest missing `experiment_apis`:** `messenger.easAccount` is `undefined`, regardless of the pref.
- **Pref is `false` and manifest has `experiment_apis`:** Thunderbird **rejects the entire extension at install time** — nothing loads, setup page is inaccessible.
- There is no runtime API to "add" an experiment permission after the fact.

This is why two separate builds exist. The privileged build has `experiment_apis` injected into its `manifest.json` at package time; the standard build does not.

### Enabling the Privileged Build

1. Open **Extras → Einstellungen → Allgemein** → scroll to bottom → **Konfigurationseditor**
2. Search `extensions.experiments.enabled` → double-click to set **`true`**
3. Install `thunderbird-eas-x.y.z-privileged-<ts>.xpi` over the existing extension

### MailServices Import Path

The experiment implementation supports both modern and older Thunderbird module formats:

```javascript
_getMailServices() {
  try {
    // Thunderbird 115+ (ESM)
    return ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs").MailServices;
  } catch (_) {
    // Thunderbird 91–114 (JSM)
    return ChromeUtils.import("resource:///modules/MailServices.jsm").MailServices;
  }
}
```

---

## Known Server Behaviours

This section documents server-side behaviour patterns observed during development. Specific server hostnames have been omitted; these patterns have been observed on Exchange Server 2019 / Exchange Online deployments.

### TLS Renegotiation

Some servers perform SSL renegotiation twice per connection. Observed via `curl --verbose`. This is harmless for Gecko's `fetch()` API (which handles renegotiation transparently) but causes failures with lower-level HTTP clients that don't expect mid-handshake renegotiation.

### EAS Version Negotiation

Most modern Exchange servers advertise EAS 16.1 via OPTIONS and accept it. The client negotiates down if necessary (preferred version list: `16.1 → 16.0 → 14.1 → 14.0 → 12.1 → 12.0`).

Some servers require authentication even for OPTIONS. The 401 response may still include the `MS-ASProtocolVersions` header. If it does not, the client falls back to the default version (`14.1`) and logs a note.

### Device Quarantine (Status 165 / 177)

Many Exchange deployments quarantine **all new device registrations** until an administrator explicitly approves them via OWA → Options → Phone → Mobile Devices. This is independent of credentials.

| Signal | Context | Meaning |
|---|---|---|
| EAS Provision `Status=165` | Phase 1 Provision response | Device quarantined during provisioning |
| FolderSync `Status=177` | FolderSync response | Non-standard; server-specific quarantine signal |

Both are caught and translated to `Error('DEVICE_QUARANTINED')`. The `SyncManager` displays a user-friendly message rather than entering a crash/retry loop.

**Quarantine backoff:** Once `DEVICE_QUARANTINED` is first detected, the timestamp is persisted in `account.quarantineDetectedAt`. For the next 30 minutes, subsequent sync cycles skip all network requests and immediately rethrow the error — no new Provision requests are sent to the server. Without this backoff, every 5-minute alarm cycle would send a Phase 1 Provision request, and Exchange generates a fresh quarantine notification email for each one. After 30 minutes the backoff expires and the connector tries again in case the admin approved the device. On the first successful `FolderSync`, `quarantineDetectedAt` is cleared.

### Device Limit

Exchange enforces a per-user limit on active device partnerships (commonly 5). Exceeding this triggers an email notification to the user. Stale devices must be removed via OWA to free up slots. Each unique `DeviceId` + `DeviceType` combination counts as one device entry.

---

## Status Code Reference

### Provision Status (inside `<Provision><Status>`)

| Code | Meaning | Handled |
|---|---|---|
| 1 | Success | ✅ |
| 165 | Device quarantined / blocked | ✅ → `DEVICE_QUARANTINED` error |
| other | Provision failed | ✅ → throws with code |

### FolderSync Status (inside `<FolderSync><Status>`)

| Code | Meaning | Handled |
|---|---|---|
| 1 | Success | ✅ |
| 9 | Malformed request / sync key invalid | ✅ → reset + retry |
| 12 | Hierarchy sync required | ✅ → reset + retry |
| 142 | Device not provisioned | ✅ → provision + retry |
| 145 | Policy key mismatch | ✅ → provision + retry |
| 177 | Quarantined (server-specific) | ✅ → `DEVICE_QUARANTINED` error |

### Sync Status (inside `<Sync><Collections><Collection><Status>`)

| Code | Meaning | Handled |
|---|---|---|
| 1 | Success | ✅ |
| 3 | Invalid sync key | ✅ → reset to key `0` |
| 12 | Invalid sync key | ✅ → reset to key `0` |

### HTTP Level

| Code | Meaning | Handled |
|---|---|---|
| 200 | OK | ✅ |
| 200 + empty body | No changes (Sync) | ✅ → `parseSync` returns `null` |
| 201 / 204 | No Content (SendMail success) | ✅ |
| 401 | Authentication failed | ✅ → throws user-facing error |
| 449 | Retry after provision | ✅ → provision + retry once |
| 451 | Redirect / provision needed | ✅ → same as 449 |

---

## State Persistence

All persistent state is stored in `messenger.storage.local` (an IndexedDB-backed key-value store; no practical size limit).

### Storage Keys

| Key | Type | Contents |
|---|---|---|
| `accounts` | `Account[]` | All configured EAS accounts (see shape below) |
| `deviceId` | `string` | Stable 32-char hex device UUID, shared across all accounts |
| `mapping_{accountId}_{folderId}` | `object` | EAS ServerId → Thunderbird message ID |
| `rev_mapping_{accountId}` | `object` | Thunderbird message ID → `{ easFolderId, easServerId }` |

### Account Object Shape

```javascript
{
  id:              string,   // random UUID, stable for the lifetime of the account
  host:            string,   // EAS server hostname (no protocol, no port)
  username:        string,   // usually the full email address
  email:           string,   // display email (may differ from username)
  password:        string,   // plaintext — see security note below
  enabled:         boolean,
  deviceId:        string,   // 32-char hex, shared across all accounts on this install
  deviceProfileId:       string,   // 'Thunderbird' | 'iPhone' | 'WindowsOutlook15' | 'Android' | 'Custom'
  customProfile:         object?,  // custom profile fields when deviceProfileId === 'Custom'
  policyKey:             string,   // EAS PolicyKey, updated after each provisioning cycle
  easVersion:            string,   // negotiated EAS protocol version
  folderSyncKey:         string,   // FolderSync state token ('0' = initial)
  folders:               { [serverId]: FolderInfo },
  tbAccountKey:          string?,  // set when Experiments API creates a real TB account node
  syncInterval:          number,   // minutes between sync cycles
  settingsConfirmed:     boolean?, // true after first successful FolderSync; Settings re-sent until then
  quarantineDetectedAt:  number?,  // Date.now() when quarantine was first detected; null when cleared
}
```

**Security note:** Passwords are stored in plaintext. Using Thunderbird's `nsILoginManager` would be more appropriate but requires Experiments API access. This is tracked in Open Issues.

### Upgrade Survival

Storage survives extension **upgrades** when the same addon ID (`thunderbird-eas@woehrl.biz`) is installed over the existing extension. Storage is **wiped** on explicit removal via Add-ons Manager. The addon ID must remain stable across all future releases — changing it is equivalent to a fresh install for all existing users.

---

## Device Identity

A single `deviceId` (32-char uppercase hex string, generated once via `crypto.randomUUID()` with hyphens removed) is shared across all EAS accounts on the installation. It appears in the Exchange admin's Mobile Devices list in OWA as the "Device ID".

### Profile Changes and Server Identity

Changing the device profile (`iPhone` → `WindowsOutlook15`) sends a different `DeviceType` URL parameter. Most Exchange servers treat `DeviceId + DeviceType` as the unique device key, so a profile change registers as a new device entry in OWA — even though the local `deviceId` hex value is the same.

### Loss of Device ID

If the extension is removed (not upgraded), `deviceId` is wiped from storage. On next install, a new UUID is generated. The server sees a completely new device, which triggers the quarantine cycle again.

---

## Popup Status UI

### Architecture

The popup is a standalone HTML page (`ui/popup/popup.html`) with an ES module script. It communicates with the background script exclusively via `messenger.runtime.sendMessage`.

### Polling

The popup polls the background for status every **2.5 seconds** while open:

```javascript
const _refreshTimer = setInterval(render, 2500);
window.addEventListener('unload', () => clearInterval(_refreshTimer));
```

This is necessary because:
- The first sync fires ~6 seconds after extension load (alarm `delayInMinutes: 0.1`)
- If the popup opens before the first sync completes, the initial render shows "Never synced"
- `STATUS_UPDATE` messages from the background only reach an open popup; if the popup was closed when the update was sent, it is lost

### Context Unload Safety

When the popup is closed, any in-flight `sendMessage` calls reject with `"Actor 'Conduits' destroyed before query 'RuntimeMessage' was resolved"`. Without a try/catch, this causes `render()` to throw, preventing the display from updating on the next interval tick even if the popup is still open. The fix:

```javascript
async function render() {
  let accounts, status;
  try {
    [accounts, status] = await Promise.all([
      messenger.runtime.sendMessage({ type: 'GET_ACCOUNTS' }),
      messenger.runtime.sendMessage({ type: 'GET_STATUS' }),
    ]);
  } catch (_) {
    return; // context unloading — skip this render cycle
  }
  // ... update DOM
}
```

### Status Classification

```javascript
function classifyStatus(st) {
  if (st.syncing)                                      return 'syncing';
  if (st.error?.toLowerCase().includes('quarantine'))  return 'quarantine';
  if (st.error)                                        return 'error';
  if (st.lastSync)                                     return 'ok';
  return 'idle';
}
```

Quarantine is detected by substring match on the error message, which is set to `'Device quarantined – ...'` by the SyncManager when it catches `Error('DEVICE_QUARANTINED')`.

---

## Security Notes

### Threat Model

The extension operates entirely within a single Thunderbird instance. The attack surface is:

1. **The configured EAS server** — all WBXML responses and message bodies are server-controlled data.
2. **User input in the setup form** — host, username, email fields.
3. **Thunderbird's local storage** — credentials and sync state at rest.

### Mitigations in Place

| Risk | Location | Mitigation |
|---|---|---|
| MIME header injection | `email-sync.js` `_injectEasHeader()` | `serverId` / `accountId` stripped of `\r\n` before embedding in header string |
| Host field path injection | `manager.js` `_uiAddAccount()` | Host normalized on save: `https://` prefix and any path/query suffix stripped |
| `SendMail` provision loop | `client.js` `sendRawMime()` | `retried` guard added — provision retried at most once, matching `request()` behaviour |
| XSS in popup / setup UI | `popup.js`, `setup.js` | All account data rendered through `escHtml()` before insertion into `innerHTML` |
| Credentials in network requests | `client.js` | Password only ever appears in the `Authorization: Basic` header, never in URL or body |
| All network traffic | `client.js` | `baseUrl` hard-coded to `https://` — plaintext HTTP is structurally impossible |

### Known Weaknesses

| Weakness | Severity | Notes |
|---|---|---|
| **Plaintext password storage** | Medium | `account.password` stored as a string in `messenger.storage.local`. Fix: `nsILoginManager` via Experiments API. Tracked in Open Issues. |
| **No WBXML depth/size limits** | Low | A malicious server could send a deeply nested response causing stack overflow in `wbxml.js`. Exploitable only if the user deliberately connects to a hostile server. |
| **`https://*/*` permission is broad** | Info | Covers all HTTPS hosts because the EAS hostname is user-configured at runtime. Cannot be narrowed without a dynamic permission request. |

---

## Open Issues and Future Work

### High Priority

| Issue | Notes |
|---|---|
| **Attachments** | Incoming: full MIME (Type=4) fetched with a 20 MB `TruncationSize`; items exceeding the limit are re-fetched via `ItemOperations/Fetch`. Outgoing: `compose.onBeforeSend` calls `messenger.compose.listAttachments()`, reads each file as `ArrayBuffer`, and builds a `multipart/mixed` message with base64-encoded parts. Non-ASCII filenames use RFC 5987 encoding. Single-part messages (no attachments) are unchanged. |
| **Push sync (Ping)** | Currently poll-only. The EAS `Ping` command allows the server to push change notifications, enabling near-real-time sync without constant polling. |
| **Secure credential storage** | Passwords stored in plaintext in `messenger.storage.local`. Thunderbird's `nsILoginManager` (via Experiments API) is the appropriate solution. |

### Medium Priority

| Issue | Notes |
|---|---|
| **Calendar sync** | EAS `Calendar` class is defined in the WBXML tables (code page 4). TB 128+ has a calendar WebExtension API. Would require `MeetingRequest` handling and timezone normalisation. |
| **Contacts sync** | EAS `Contacts` class defined (code page 1). TB contacts WebExtension API is limited; may need Experiments API. |
| **Per-account DeviceId** | Currently one DeviceId is shared across all accounts. Some server policies may behave better with per-account IDs. |
| **OAuth2 / Modern Auth** | Currently only HTTP Basic Auth. Exchange Online increasingly mandates OAuth2. Would require a browser redirect flow or device-code flow. |

### Low Priority / Nice to Have

| Issue | Notes |
|---|---|
| EAS `Ping` heartbeat | Server pushes change notifications; avoids polling |
| Lazy full-MIME fetch | Fetch full MIME only when a message is opened, not during bulk sync |
| MoveItems UI integration | `buildMoveItems` is implemented but not wired to Thunderbird drag-drop or move menu events |
| Extension signing | Signed extensions don't display the unsigned-addon warning banner in Thunderbird |
| Better icon | Current icon is a plain blue square |

---

## WBXML Code Page Index (EAS 16.1)

The 24 code pages defined in `eas/protocol.js`. Token arrays start at index 0x05.

| Index | Namespace | Key Elements |
|---|---|---|
| 0 | AirSync | Sync, Collections, Collection, Commands, SyncKey, ServerId, WindowSize |
| 1 | Contacts | All contact vCard fields |
| 2 | Email | Subject, From, To, Read, Body, Attachments, DateReceived |
| 3 | AirNotify | *(internal, not used)* |
| 4 | Calendar | StartTime, EndTime, Subject, Attendees, MeetingRequest |
| 5 | Move | MoveItems, Move, SrcMsgId, SrcFldId, DstFldId |
| **6** | **GetItemEstimate** | **CollectionId** ← required for Sync requests; must be on this page |
| 7 | FolderHierarchy | FolderSync, Add, Delete, Update, ServerId, ParentId, DisplayName, Type |
| 8 | MeetingResponse | |
| 9 | Tasks | |
| 10 | ResolveRecipients | |
| 11 | ValidateCert | |
| 12 | Contacts2 | |
| 13 | Ping | HeartbeatInterval, Folders, Folder |
| **14** | **Provision** | **PolicyKey**, Policies, Policy, PolicyType, Status |
| 15 | Search | |
| 16 | GAL | DisplayName, Phone, Office, Title, Company, Alias, FirstName, LastName |
| **17** | **AirSyncBase** | **BodyPreference**, Body, Type, Data, EstimatedDataSize — used in Sync Options |
| **18** | **Settings** | DeviceInformation, Set, Model, OS, FriendlyName, UserAgent |
| 19 | DocumentLibrary | |
| **20** | **ItemOperations** | Fetch — needed for attachment download (not yet implemented) |
| 21 | ComposeMail | SendMail, ReplyTo, Forward, SmartReply, SmartForward |
| 22 | Email2 | UmCallerID, UmUserNotes, ConversationId |
| 23 | Notes | Subject, MessageClass, LastModifiedDate, Categories |
