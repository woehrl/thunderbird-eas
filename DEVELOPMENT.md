# Development Notes — Thunderbird EAS Connector

Technical reference for contributors. Covers the protocol, the architecture, the findings that shaped it, and the open problems.

---

## Contents

1. [Repository layout](#repository-layout)
2. [Build system](#build-system)
3. [The bug that broke the first release](#the-bug-that-broke-the-first-release)
4. [WBXML](#wbxml)
5. [HTTP transport](#http-transport)
6. [Version negotiation and device profiles](#version-negotiation-and-device-profiles)
7. [Provisioning](#provisioning)
8. [Sync semantics](#sync-semantics)
9. [Push (Ping)](#push-ping)
10. [Autodiscover](#autodiscover)
11. [Error taxonomy and backoff](#error-taxonomy-and-backoff)
12. [Experiments API](#experiments-api)
13. [State persistence](#state-persistence)
14. [Security notes](#security-notes)
15. [Open issues](#open-issues)

---

## Repository layout

```
thunderbird-eas/
├── manifest.json           WebExtension manifest (MV2). experiment_apis is absent here
│                           on purpose and injected by the privileged build.
├── package.js              Dependency-free packager → dist/*.xpi
├── tools/
│   └── selftest.mjs        Protocol self-test; gates packaging
│
├── background/             Persistent background page + entry point
│
├── eas/
│   ├── codepages.js        The 26 WBXML code page tables (see below)
│   ├── protocol.js         Constants, status codes, device profiles
│   ├── wbxml.js            WBXML 1.3 encoder/decoder
│   ├── commands.js         Request builders and response parsers
│   ├── client.js           HTTP transport, negotiation, provisioning, Ping
│   └── autodiscover.js     Autodiscover V2/POX and the EWS probe
│
├── sync/
│   ├── manager.js          Accounts, scheduling, compose interception, UI API
│   └── email-sync.js       Per-account folder and message synchronisation
│
├── experiments/            Privileged XPCOM API (account node, folder flags, logins)
└── ui/                     setup/ (options page) and popup/
```

---

## Build system

`package.js` uses only Node's standard library and a hand-rolled `ZipWriter`.

```bash
node package.js                    # standard
node package.js --privileged       # injects experiment_apis into the manifest in-memory
node package.js --skip-selftest    # escape hatch
```

Packaging runs `tools/selftest.mjs` first and refuses to build if it fails. That is deliberate — see the next section.

The `experiment_apis` block is injected by a regex replace before the closing brace of `manifest.json`. The build validates the result with `JSON.parse` and aborts if the substitution did not apply, so a manifest reformat cannot silently produce an `.xpi` without the API.

---

## The bug that broke the first release

Worth recording in full, because the failure mode is invisible from the client side and the wrong conclusions it produced were written into this document for months.

The AirSync code page table (page 0) was correct up to token `0x11` and wrong from `0x12` onwards. Consequences on the wire:

| Element the builder emitted | Token sent | Element the server actually read |
|---|---|---|
| `Collections` | `0x12` | `CollectionId` |
| `Options` | `0x13` | `GetChanges` |
| `Commands` | `0x15` | `WindowSize` |
| `MoreAvailable` | `0x1D` | `ApplicationData` |
| `WindowSize` | `0x1E` | `DeletesAsMoves` |

Every `Sync` request was structurally meaningless. The Settings page (18) had an extra `Data` entry at `0x14`, shifting `DeviceInformation`, `Model`, `FriendlyName`, `OS` and `UserAgent` by one token each, so `Settings/DeviceInformation` never worked either.

Two "findings" recorded here were misreadings of that bug:

- *"`CollectionId` lives on code page 6, not page 0."* It does not. `CollectionId` is `0x12` on AirSync. The old table simply had no `CollectionId` entry on page 0, so `encodeTag` returned null and the workaround was to borrow the `GetItemEstimate` element.
- *"`ApplicationData` is not a real WBXML element."* It is, at `0x1D` on AirSync. Read-flag changes must be wrapped in it.

**The lesson, and why the self-test exists:** a shifted code page table produces a request that is syntactically valid WBXML and semantically nonsense. Servers answer with a generic protocol error or an empty result. There is nothing in the response pointing at the table. `tools/selftest.mjs` therefore pins the tables against byte-level measurements:

- the canonical 13-byte `FolderSync` with `SyncKey=0`
  `03 01 6a 00 00 07 56 52 03 30 00 01 01`
- a 15-byte response captured from Exchange 2019 decoding to `<FolderSync><Status>142</Status></FolderSync>`
- explicit token assertions for every element that drifted

`verifyCodePages()` runs the same anchor checks at add-on startup and reports to the console and to the setup page.

---

## WBXML

EAS uses WBXML 1.3 with a fixed four-byte header and four global tokens.

```
03 01 6a 00
│  │  │  └─ string table length = 0 (EAS never uses one)
│  │  └──── charset 0x6A = UTF-8 (IANA MIBenum 106)
│  └─────── public identifier 1 (unknown)
└────────── version 1.3
```

| Token | Value | Meaning |
|---|---|---|
| `SWITCH_PAGE` | `0x00` | followed by one code page byte |
| `END` | `0x01` | closes the innermost open element |
| `STR_I` | `0x03` | inline NUL-terminated UTF-8 string |
| `OPAQUE` | `0xC3` | length-prefixed binary blob |

Tag byte: `0x40` = has content, `0x80` = has attributes. EAS never uses attributes; the decoder skips them defensively. A tag without content is written as the bare token with **no** `END`.

**OPAQUE is not optional.** Exchange sends policy data in `Provision` responses and MIME bodies as OPAQUE. A decoder that only understands `STR_I` loses both. `wbxml.js` stores the raw bytes on `node.data` and the UTF-8 interpretation on `node.text`.

### The 26 code pages

There are 26, numbered 0–25. Page 3 (**AirNotify**) is deprecated but **occupies its slot** — dropping it shifts every page from `Move` (5) onwards and produces parse failures in folders and calendar that look completely unrelated to the cause.

| # | Namespace | # | Namespace | # | Namespace |
|---|---|---|---|---|---|
| 0 | AirSync | 9 | Tasks | 18 | Settings |
| 1 | Contacts | 10 | ResolveRecipients | 19 | DocumentLibrary |
| 2 | Email | 11 | ValidateCert | 20 | ItemOperations |
| 3 | AirNotify *(deprecated)* | 12 | Contacts2 | 21 | ComposeMail |
| 4 | Calendar | 13 | Ping | 22 | Email2 |
| 5 | Move | 14 | Provision | 23 | Notes |
| 6 | GetItemEstimate | 15 | Search | 24 | RightsManagement |
| 7 | FolderHierarchy | 16 | GAL | 25 | Find |
| 8 | MeetingResponse | 17 | AirSyncBase | | |

Editing rule: never add or remove an entry without compensating with a `null`. Add an anchor to `TABLE_ANCHORS` for anything the code depends on.

### Namespace-qualified navigation

`Status`, `Body` and `Data` exist on several pages. `find()`, `getText()` and `findAll()` accept either a bare tag or a qualified `'AirSyncBase:Body'`, and the parsers use the qualified form throughout. The earlier implementation parsed the namespace hint and then discarded it, which made `find(appData, 'Body')` a coin flip between `Email:Body` and `AirSyncBase:Body`.

---

## HTTP transport

### Query string

```
POST /Microsoft-Server-ActiveSync?Cmd=…&User=…&DeviceId=…&DeviceType=… HTTP/1.1
```

Plain text, in that parameter order, with a literal `@` in `User`. `URLSearchParams` is deliberately not used: it percent-encodes the `@`, which no real client does. Base64 query encoding is legal from 12.1 but is not implemented — it saves about twenty bytes and adds a failure path.

`DeviceId` is limited by MS-ASHTTP to 1–32 characters, ALPHA/DIGIT only. A v4 UUID uppercased with the hyphens removed is exactly 32.

### Headers

| Header | Sent when |
|---|---|
| `Authorization: Basic` | always |
| `MS-ASProtocolVersion` | always (plain-text query) |
| `User-Agent` | always, from the device profile |
| `X-MS-PolicyKey` | every command except `Ping`, `OPTIONS` and Autodiscover |
| `Content-Type` | `application/vnd.ms-sync.wbxml`, or `message/rfc822` for legacy SendMail |

### The in-band status trap

From 14.0 onwards Exchange reports almost every error as a WBXML `<Status>` inside an **HTTP 200** response. Measured example: `FolderSync` without a policy key returns HTTP 200 and a 15-byte body carrying status 142, not HTTP 449.

A client that only inspects `resp.status` sees "200 OK" plus an empty folder tree. `client.execute()` therefore reads the command-level status on every response and maps it onto the same error taxonomy as the HTTP codes.

### `X-MS-RP`

Per spec this header tells the client to discard its sync state. Exchange also emits it on first contact carrying nothing but the version list. Reacting to that with a full resync would wipe the sync state on every fresh setup, so a value that is only digits, dots and commas is logged and ignored.

### Basic auth charset

Z-Push carries an explicit workaround (ZP-864) for the fact that Outlook encodes the `Authorization` header as ISO-8859-1 while every mobile client uses UTF-8. With ASCII credentials both are byte-identical; with a non-ASCII password the difference presents as a wrong password and is essentially undiscoverable. Default UTF-8, switchable per account.

---

## Version negotiation and device profiles

`OPTIONS` returns `MS-ASProtocolVersions` and `MS-ASProtocolCommands`. Some servers require authentication even for `OPTIONS`, and some proxies strip the headers; a 401 that still carries the header is used, and an answer without it falls back to the profile default.

Preference order is `14.1 → 14.0 → 12.1 → 12.0`, capped by the profile's `maxVersion`. **16.x is deliberately not negotiated**: it changed recurrence exceptions (`InstanceId` instead of `ExceptionStartTime`), the calendar workflow and draft handling. Advertising support we do not have would produce requests we cannot interpret. EAS-4-TbSync makes the same call for the same reason. 16.1 is only mandatory for Exchange Online, which also requires OAuth 2.0 and is therefore out of reach anyway.

Server versions `2.0` and `2.1` are advertised by some servers but are not valid client versions; they are filtered out.

### Profiles

A profile bundles `DeviceType`, `User-Agent`, `maxVersion`, `windowSize` and whether `Settings/DeviceInformation` is sent.

| Profile | DeviceType | Version | Verified |
|---|---|---|---|
| `WindowsOutlook15` (default) | `WindowsOutlook15` | 14.0 | accepted |
| `iPhone` | `iPhone` | 14.1 | accepted |
| `Thunderbird` | `Thunderbird` | 14.1 | may be blocked |
| `Android` | `Android` | 14.1 | returned 403 |

Version and DeviceType are coupled on purpose. Outlook's EAS stack is an Outlook 2013 legacy component that negotiates exactly 14.0 — a client calling itself `WindowsOutlook15` and asking for 16.1 is a fingerprint that exists nowhere.

Choosing the Outlook fingerprint also activates server-side special handling: longer permitted response times, batches up to 512 items, native TNEF pass-through — but also single-contact-folder behaviour and no Notes sync. Only mail is synced today, so those costs are currently theoretical.

`sendSettings: false` for the Outlook profile because real Outlook does not send `Settings/DeviceInformation`.

### The 403 measurement

Against a production Exchange 2019 in August 2026, with identical DeviceId and request:

| DeviceType | Result |
|---|---|
| `WindowsOutlook15` | HTTP 200 |
| `iPhone` | HTTP 200 |
| `Android` | HTTP 403 |
| `TBSync` | HTTP 403 |

Two explanations fit and that data alone did not separate them: an ABQ rule on DeviceType/User-Agent, or an exhausted device-partnership quota — a "5 of 5 devices" notification arrived during the run, and Exchange keys partnerships on DeviceId **and** DeviceType, so probing four types can itself consume four slots.

**Resolved by a later run.** After stale devices were removed in OWA, `WindowsOutlook15` connected on the first attempt: provisioning completed, FolderSync returned the full hierarchy, and Sync imported a message. The 403s were the **quota**, not an ABQ rule.

Exchange then quarantined the new partnership and sent its standard notification, which is the single most useful diagnostic this protocol offers — it echoes back exactly what arrived on the wire:

```
Gerätemodell:                    WindowsOutlook15
Gerätetyp:                       WindowsOutlook15
Geräte-ID:                       3F7A1C9E4B2D48A6B0E5C81D6F03A2B7
Gerätebetriebssystem:            (empty)
Gerätebenutzer-Agent:            Outlook/16.0 (16.0.17932.20884; C2R; x64)
Geräte-IMEI:                     (empty)
Exchange ActiveSync-Version:     14.0
Gerätezugriffsstatus:            Quarantined
Grund für Gerätezugriffsstatus:  Global
```

That confirms the whole fingerprint end to end, including the empty OS/IMEI fields the Outlook profile deliberately omits and the 14.0 cap the profile enforces.

**"Grund: Global"** is the field that matters: the quarantine comes from the organisation-wide default access level, not from a device rule. Every new device lands there regardless of DeviceType, and only an administrator can release it. The reason values worth distinguishing:

| Reason | Cause | Does a different device profile help? |
|---|---|---|
| `Global` | Org-wide `DefaultAccessLevel = Quarantine` | No |
| `Individual` | Per-mailbox or per-device rule | Sometimes |
| `DeviceRule` | ABQ rule on DeviceType / User-Agent | Yes |

Consequences in the code: `WindowsOutlook15` is the default, 403 messages name both possible causes, and `probeFingerprints()` warns before running.

Note that a quarantined device is *not* refused: it provisions, gets the folder hierarchy and receives exactly one message — the notification itself. A client that treats "folders appeared" as success will report a healthy account with an almost empty mailbox.

---

## Provisioning

Two phases. Phase 1 requests the policy and receives a temporary key; phase 2 acknowledges with `Status=1` and receives the permanent key, which then accompanies every command.

```xml
<Provision>
  <settings:DeviceInformation>        <!-- 14.1 and later: mandatory in practice -->
    <settings:Set>
      <settings:Model>…</settings:Model>
      <settings:FriendlyName>…</settings:FriendlyName>
      <settings:UserAgent>…</settings:UserAgent>
    </settings:Set>
  </settings:DeviceInformation>
  <Policies><Policy>
    <PolicyType>MS-EAS-Provisioning-WBXML</PolicyType>
  </Policy></Policies>
</Provision>
```

### Status 165 is `DeviceInformationRequired`, not a quarantine

The single most expensive misreading in this project's history, and worth spelling out.

From 14.1 the `Provision` request may carry `settings:DeviceInformation` ahead of `Policies`, and Exchange **requires** it: omit the element and the response is status 165 before any policy is issued. At 14.0 the element does not exist and the server does not ask for it.

That difference is exactly why the profiles behaved differently against the reference server:

| Profile | Version | DeviceInformation in Provision | Outcome |
|---|---|---|---|
| `WindowsOutlook15` | 14.0 | not applicable | provisioned, FolderSync succeeded |
| `Thunderbird` | 14.1 | missing | `Provision returned status 165` |

Earlier notes in this repository recorded 165 as "device quarantined", because the default profile was `Thunderbird` at 14.1 and a quarantine notification happened to arrive around the same time. An entire error path — `DEVICE_QUARANTINED`, a 30-minute backoff, a dedicated popup state — was built around a status code that actually means "you forgot to tell me what device you are". The correct handling is to send the element, not to go quiet for half an hour.

Consequences: `provision()` includes `DeviceInformation` whenever the negotiated version is 14.1 or higher, 165 is a provision-and-retry trigger rather than a block, and `DEVICE_BLOCKED_STATUS` is now deliberately narrow — 126, 129 and 177, all unambiguous. The self-test pins both the element order and the fact that 165 is not in the blocked set.

There is, for the record, **no** status code meaning "quarantined". Exchange signals quarantine by letting the device provision and sync its folder hierarchy, then delivering a single explanatory message and no content.

**Parser trap:** `Provision/Status` and `Provision/Policies/Policy/Status` have the same tag name. They must be read path-anchored or you read the wrong one. `_readProvision()` uses explicit paths.

**`Policy/Status = 2` is not an error.** It means the server defines no policy. No acknowledgement is needed and the client continues without a key. Treating it as a failure is the most common misreading against open-source servers that carry no policies at all.

Triggers, all handled centrally in `client.execute()`:

| Trigger | Source |
|---|---|
| HTTP 449 | pre-14.0 servers |
| in-band status 142, 143, 144, 145 | 14.0+ servers, including Exchange |
| in-band status 165 | 14.1+ servers wanting `DeviceInformation` first |

Both provision once and retry the original command exactly once. A second failure raises `PROVISION_LOOP` rather than looping.

Measured against the reference server: provisioning is **mandatory**. `X-MS-PolicyKey: 0` alone is not enough, and the refusal arrives as in-band status 142 on HTTP 200.

---

## Sync semantics

### The priming request

`Sync` with `SyncKey=0` is a *priming* request. The server answers with a fresh key and deliberately **no items**; data arrives on the next request. Treating that answer as "nothing to do" makes the first sync of every folder return nothing, and the mailbox only starts filling on the following cycle. `_syncFolder()` tracks `primed` and always issues at least one more request.

The priming request is also sent bare — just `SyncKey` and `CollectionId`. Options on a priming request are pointless and some servers dislike them.

### Options that matter

```xml
<Options>
  <FilterType>…</FilterType>
  <MIMESupport>2</MIMESupport>
  <airsyncbase:BodyPreference>
    <Type>4</Type>
    <TruncationSize>262144</TruncationSize>
  </BodyPreference>
</Options>
```

**`MIMESupport` is required.** Without it the server ignores `BodyPreference Type=4` and returns a plain-text body instead of the raw message. That was missing before — and was unreachable anyway, since `MIMESupport` was absent from the broken table.

`TruncationSize` is a budget, not a limit: items flagged `Truncated=1` are re-fetched in full via `ItemOperations/Fetch`, which sends `BodyPreference` **without** `TruncationSize`.

### Element order

EAS schemas are ordered sequences. `Collection` children must appear as `Class?, SyncKey, CollectionId, DeletesAsMoves, GetChanges, WindowSize, Options, Commands`. The self-test asserts this.

`Class` is a 2.5/12.x element. From 14.0 the server derives the class from the collection, and sending it can be answered with status 4 — so it is only emitted below 14.0.

### SendMail

From 14.0, `SendMail` is a WBXML request on the ComposeMail code page carrying `<Mime>`; the raw `message/rfc822` body form is 2.5/12.x only. The previous implementation always used the old form. Both paths exist now, selected by the negotiated version.

`SaveInSentItems` is sent so the server files the copy; the next sync picks it up from the Sent folder.

### Pushing local changes

Read-flag and delete changes are sent as `Commands` inside a `Sync` with **`GetChanges=0`**. Without that, the server's own changes come back in the same response, get acknowledged by the new sync key, and are never imported — silent mail loss. The old code destructured a `getChanges` option and never used it.

---

## Push (Ping)

`Ping` long-polls: the request carries `HeartbeatInterval` and the folders to watch, and the server holds the connection until something changes or the heartbeat elapses.

Heartbeat handling is adaptive because intermediate proxies and NAT gateways routinely kill idle connections well before the negotiated heartbeat, which is indistinguishable from a network error. Start at 8 minutes, halve on a network failure, grow by 2 minutes after a clean heartbeat, clamp to 3–59 minutes, and persist the result.

| Status | Handling |
|---|---|
| 1 heartbeat expired | grow the heartbeat, ping again |
| 2 changes | sync exactly the folders named in the response |
| 3 / 4 missing parameters or syntax error | stop pushing, fall back to polling |
| 5 invalid heartbeat | adopt the `HeartbeatInterval` from the response |
| 6 too many folders | adopt `MaxFolders` and truncate the watch list |
| 7 hierarchy stale | `FolderSync`, then ping again |

Ignoring status 5 and 6 is how a Ping loop turns into a tight retry loop against the same rejected parameters.

The HTTP timeout is heartbeat + 60 s, so the server decides when the poll ends rather than the client killing its own long poll.

The push loop and the interval alarm both call `AccountSync.sync()`, which serialises cycles per account through a promise chain. Two concurrent `Sync` requests on one collection race on the sync key: the server rejects the second with status 3 and the collection is rebuilt from scratch.

---

## Autodiscover

Order: **V2 (JSON) first**, POX as fallback, conventional-name guess last.

```
GET https://autodiscover.<domain>/autodiscover/autodiscover.json/v1.0/<smtp>?Protocol=ActiveSync
→ {"Protocol":"ActiveSync","Url":"https://…/Microsoft-Server-ActiveSync"}
```

Unauthenticated, one request, no XML. Not covered by any Open Specification — an Exchange 2016+/Online feature — so POX stays as the fallback.

Two measured traps:

- **The apex domain need not exist.** The reference domain has no A record at all, while its `autodiscover.` host resolves fine. A client walking Microsoft's candidate list strictly serially burns a DNS timeout on step 1. The four POX candidates run with a 200 ms stagger and the first usable answer wins. The mixed-case duplicates are also real: case-sensitive paths on Linux-hosted endpoints.
- **The response nests two default namespaces.** The outer `<Autodiscover>` is in `…/autodiscover/responseschema/2006`; the inner `<Response>` switches to `…/autodiscover/mobilesync/responseschema/2006`. Parsing is namespace-agnostic by local name: any `<Server>` whose `<Type>` is `MobileSync`.

Also: the server may echo the address with different capitalisation than was asked for. SMTP addresses are never compared case-sensitively.

### The EWS probe

`probeEws()` asks Autodiscover V2 for `Protocol=Ews` and then sends a minimal `GetFolder` for `msgfolderroot`. It is surfaced as a first-class button in setup, not a footnote: Thunderbird has had native Exchange support over EWS since 2024/2025, and if EWS answers for the mailbox it is better than this add-on in every respect — no WBXML, no device partnership, no ABQ rules, no quota.

---

## Error taxonomy and backoff

`EasError` carries a `code` so callers branch on a value rather than on message text.

| Code | Sources |
|---|---|
| `NETWORK` | fetch failure, timeout |
| `AUTH_FAILED` | HTTP 401, 456 |
| `PASSWORD_EXPIRED` | HTTP 457 |
| `DEVICE_BLOCKED` | HTTP 403, status 126 / 129 / 177 |
| `THROTTLED` | HTTP 503, honours `Retry-After` and `X-MS-ASThrottle` |
| `REDIRECT` | HTTP 451 with `X-MS-Location` |
| `NOT_FOUND` | HTTP 404 |
| `PROTOCOL` | HTTP 400, 501, undecodable WBXML |
| `PROVISION_LOOP` | still unprovisioned after provisioning |
| `MAILBOX_FULL` | HTTP 507 |

`DEVICE_BLOCKED`, `AUTH_FAILED` and `PASSWORD_EXPIRED` set `isFatalForNow` and trigger a 30-minute backoff during which no request is made at all. Real clients do not hammer a server that has refused them, and Exchange sends the mailbox owner a fresh quarantine notification for **every** Provision attempt. `THROTTLED` backs off for the server-supplied `Retry-After`.

An explicit **Sync All** clears the backoff — the user pressing it has usually just approved the device in OWA.

Note that HTTP 451 is a redirect (`X-MS-Location`), not a provisioning signal. The previous code treated it as one.

---

## Experiments API

The privileged build ships `experiments/implementation.js`, running in Thunderbird's parent process with XPCOM access.

Thunderbird has no EAS backend, so an EAS mailbox cannot be a server of its own type. It can be a server of type `"none"` — the same type Local Folders uses — owned by its own `nsIMsgAccount`. That produces a genuine top-level node while the add-on drives all traffic.

| Method | Purpose |
|---|---|
| `createAccount(email, host, opts)` | server + account + identity; idempotent, returns the account key |
| `setSpecialFolder(key, path, role)` | sets `nsMsgFolderFlags` and points the identity at Sent/Drafts/Archive |
| `setAccountName(key, name)` | folder-pane display name |
| `removeAccount(key)` | account plus local mail files |
| `storePassword` / `getPassword` / `removePassword` | `nsILoginManager`, realm `Exchange ActiveSync` |

Four things separate a bare account node from one that feels native, and all four need XPCOM:

1. **an identity** — otherwise the address never appears in the compose From picker
2. **folder flags** — otherwise Inbox/Sent/Drafts/Trash are ordinary folders with generic icons and no delete-to-trash
3. **identity folder URIs** — otherwise sent mail and drafts land in Local Folders
4. **`nsILoginManager`** — otherwise the password sits in extension storage in plaintext

`identity.smtpServerKey` is cleared: outgoing mail goes through EAS `SendMail`, so offering a broken SMTP path would be worse than offering none.

### Why it cannot be a runtime toggle

```
manifest declares experiment_apis   AND   extensions.experiments.enabled = true
            ↓                                        ↓
     the schema is loaded                    privilege is granted
            └──────────────────┬─────────────────────┘
                               ↓
                   messenger.easAccount exists
```

Without the manifest key the namespace is undefined regardless of the pref. With the key and the pref off, Thunderbird rejects the extension outright at install time. There is no API to request the privilege later. Hence two builds from one source tree.

Both builds carry the add-on ID `thunderbird-eas@woehrl.biz`, and `_ensureTbAccount()` detects the API at runtime, so switching builds in place preserves account data and transparently changes the folder strategy.

---

## State persistence

`messenger.storage.local`, IndexedDB-backed.

| Key | Contents |
|---|---|
| `accounts` | account objects (see below) |
| `mapping_{accountId}_{folderId}` | EAS ServerId → Thunderbird message id |
| `rev_mapping_{accountId}` | Thunderbird message id → `{ easFolderId, easServerId }` |

The maps are loaded once per session, held in memory and flushed at the end of a cycle. The previous implementation did a read-modify-write of two storage keys per imported message, making the first sync of a large folder quadratic in storage operations.

### Account shape

```javascript
{
  id, host, username, email,
  password,           // only on the standard build; privileged uses nsILoginManager
  enabled,
  deviceId,           // 32 hex chars, generated once, NEVER regenerated
  deviceProfileId, customProfile,
  authEncoding,       // 'utf-8' | 'iso-8859-1'
  easVersion, policyKey, folderSyncKey,
  folders: { [serverId]: { serverId, parentId, displayName, type,
                           thunderbirdFolderId, syncKey } },
  tbAccountKey,       // privileged build only
  syncInterval, filterType, truncationSize,
  push, heartbeatSec, maxPingFolders,
  settingsConfirmed,
  backoffUntil, backoffReason, backoffCode,
}
```

### DeviceId stability

The single most important piece of client state. Exchange treats a changed DeviceId as a brand new device: fresh quarantine cycle, another slot of the mailbox quota, and a failed full resync.

Outlook itself got this wrong — builds 16.0.14701–16.0.14827 regenerated the DeviceId on every restart because it was never persisted. Mail vanished and device quotas filled up. Generated once here, never regenerated. Removing (rather than upgrading) the extension is the only thing that loses it.

Exchange keys a partnership on DeviceId **and** DeviceType, so changing the device profile also registers a new device. `_uiUpdateAccount` returns `profileChanged` so the UI can say so.

---

## Security notes

| Risk | Mitigation |
|---|---|
| MIME header injection from a crafted `ServerId` | CR/LF stripped in `_injectEasHeaders()` |
| Host field path injection | scheme, path and query stripped on save |
| XSS in the UI | all server/account data passes through `escHtml()` |
| Credentials in URLs or bodies | password only ever appears in the `Authorization` header |
| Plaintext HTTP | `baseUrl` is hard-coded `https://` |
| Hostile WBXML | depth limit 256, length validation, no unbounded recursion |
| Password at rest | `nsILoginManager` on the privileged build |

Remaining weaknesses:

| Weakness | Severity | Note |
|---|---|---|
| Plaintext password on the **standard** build | Medium | Unavoidable without XPCOM |
| `https://*/*` host permission | Info | The EAS host is user-configured at runtime and cannot be narrowed |

---

## Open issues

### High

| Issue | Note |
|---|---|
| **Full content sync against a released device** | Provisioning, FolderSync, folder creation, special-folder tagging and a single-message Sync are confirmed against a live Exchange 2019. Everything beyond that — bulk sync, paging via `MoreAvailable`, truncation and `ItemOperations/Fetch`, read-flag propagation, `SendMail`, the Ping loop — has only been exercised against the self-test, because the device is still in quarantine and Exchange withholds content. |
| **Capture a real Outlook session** | The reference document describes a mitmproxy setup driven by repointing Outlook's `EAS Server URL` registry value. That would settle header order, heartbeat and the provisioning sequence — replacing several reconstructions with measurements. The quarantine notification has already confirmed DeviceType, User-Agent and negotiated version. |
| **Surface the quarantine state** | A quarantined device provisions and receives its folder tree, so the add-on reports a healthy account with an almost empty mailbox. Exchange offers no protocol-level signal for this; the only marker is the notification message itself. Worth considering: flag an account that has folders but has imported nothing but a single message from the server's own notification sender. |
| **Outgoing mail via drafts** | `SendMail` works, but composing into the Drafts folder (16.x `Sync/Add`) is not implemented. |
| **Message list goes stale after an import** | Observed once: importing into the folder currently displayed left the thread pane showing only the newly imported message. The data was intact — switching folders and back restored the full list — so this is a view refresh problem, not loss. Not attributed yet; `messages.import()` is the only thing this add-on does to a folder. Worth discriminating: does it also happen when the target folder is *not* the one on screen? |

### Medium

| Issue | Note |
|---|---|
| Calendar sync | Code page 4 is now correct and complete. Needs `MeetingRequest` handling and timezone normalisation; recurrences drift by an hour across DST transitions when the server sends no timezone blob. |
| Contacts sync | Code page 1 is correct. The Thunderbird address-book API is limited; may need XPCOM. |
| `MoveItems` wiring | `buildMoveItems` exists but is not connected to Thunderbird's move/drag events. |
| OAuth 2.0 | Required for Exchange Online, along with protocol 16.1. Both are large. |
| Search / `Find` | Not implemented. The reference server advertises `Find`, so 16.1 search is available in principle. |

### Low

| Issue | Note |
|---|---|
| Lazy full-MIME fetch | Fetch the complete body when a message is opened rather than during bulk sync. |
| Extension signing | Removes the unsigned-add-on warning. |
| Better icon | Still a plain blue square. |

---

## Sources

Microsoft Open Specifications: **MS-ASHTTP** (transport, query string, status codes), **MS-ASCMD** (commands and status codes), **MS-ASWBXML** (code page tables), **MS-ASPROV** (provisioning), **MS-ASAIRS** (body preferences).

Open-source implementations consulted for real-world behaviour: EAS-4-TbSync (the closest precedent for a Thunderbird EAS client), Z-Push and grommunio-sync (server-side quirks, the ISO-8859-1 auth workaround), Horde ActiveSync (`Device.php` — the densest collection of Outlook quirks anywhere), SOGo.

Measurements marked in this document as captured come from a production Exchange 2019 (`MS-Server-ActiveSync: 15.2`, IIS 10, separate front-end and back-end) in August 2026.
