# Thunderbird EAS Connector

A Thunderbird add-on that speaks **Exchange ActiveSync (EAS)**, so a mailbox that offers no IMAP access can still be read and written from Thunderbird. Works against on-premise Exchange 2010 and newer and any server implementing EAS 12.1–14.1.

> **Check EWS first.** Thunderbird has had native Exchange support over EWS since 2024/2025 — no add-on, no device partnership, no administrator approval. If your mailbox answers on EWS, a native Exchange account is simpler and more reliable than this add-on in every respect. The setup page has a **Check for EWS first** button that tests it in one click. Only continue here if EWS is unavailable.
>
> In Thunderbird's own EWS dialog, the endpoint field wants the **complete URL** — `https://ews.<domain>/EWS/Exchange.asmx`, not just the hostname. A bare host is rejected as an invalid address.

Eine deutschsprachige Schritt-für-Schritt-Anleitung liegt in [ANLEITUNG.md](ANLEITUNG.md).

---

## Features

- Email sync for Inbox, Sent, Drafts, Deleted and custom folders
- Outgoing mail through EAS `SendMail` — no SMTP server required
- Read-flag changes propagated back to the server, and folder moves mirrored as EAS `MoveItems`
  — deleting locally moves the message to Deleted Items on the server, as Exchange itself does
- **Push** via the EAS `Ping` command with an adaptive heartbeat, plus interval polling as a fallback
- Autodiscover (V2/JSON with POX fallback) so only the mailbox address is needed
- Full two-phase provisioning, including the in-band status codes Exchange actually uses
- Device profiles with verified fingerprints, and a built-in probe that shows which ones the server accepts
- Privileged build: a real top-level account node, tagged special folders, password stored in Thunderbird's password manager

---

## Requirements

| Component | Minimum version |
|---|---|
| Thunderbird | 128.0 (tested on 140.9 ESR) |
| Exchange | Any version speaking EAS 12.1 or newer |
| Node.js | 18+ (build only) |

Exchange Online is **not** supported: it has required EAS 16.1 with OAuth 2.0 since 2026, and Basic authentication for EAS there has been permanently disabled since 2023.

---

## Installation

Two builds are produced from identical source:

| File | Description |
|---|---|
| `thunderbird-eas-x.y.z-<ts>.xpi` | **Standard** — installs anywhere, files mail under Local Folders |
| `thunderbird-eas-x.y.z-privileged-<ts>.xpi` | **Privileged** — real account node; needs one about:config change first |

1. In Thunderbird: **Tools → Add-ons and Themes → gear icon → Install Add-on From File**
2. Pick the `.xpi` and confirm.

### Build from source

```bash
git clone https://github.com/woehrl/thunderbird-eas
cd thunderbird-eas

node tools/selftest.mjs      # protocol self-test (also runs as part of packaging)
node package.js              # standard build
node package.js --privileged # privileged build
```

No npm, no bundler, no dependencies — plain ES modules and Node's standard library.

Local builds carry a timestamp in the filename so repeated builds don't collide with a locked file; `--release` drops it for a stable asset name.

### Cutting a release

Releases are built by GitHub Actions, not uploaded by hand — the `.xpi` is then provably built from the tagged commit, with the self-test as part of it.

1. Bump `version` in `manifest.json`, commit, push.
2. Tag it and push the tag:
   ```bash
   git tag v1.1.0
   git push origin v1.1.0
   ```

The workflow checks the tag against the manifest version (a mismatch fails the build, since Thunderbird decides updates from the manifest), builds both variants with `--release`, and attaches `thunderbird-eas-<version>.xpi` and `thunderbird-eas-<version>-privileged.xpi` to a new GitHub release for the tag.

---

## Standard vs privileged build

### Standard

Works immediately. Mail is filed into a folder named after the account inside **Local Folders**, and the password lives in extension storage.

### Privileged

The account gets its own top-level node in the folder pane, indistinguishable from an IMAP account:

- a real `nsIMsgAccount` with its own identity, so the address appears in the compose **From** picker
- Inbox / Sent / Drafts / Trash carry the proper Thunderbird folder flags, so they get the right icons and behaviour, and sent mail and drafts are filed into the EAS folders rather than Local Folders
- the password is stored in **Thunderbird's password manager** instead of extension storage, so a primary password protects it

**One-time preparation before installing:**

1. **Tools → Settings → General**, scroll to the bottom, click **Config Editor**
2. Search `extensions.experiments.enabled`, set it to **`true`**
3. Install the `-privileged` `.xpi`

> **Why can't this be a toggle?** The `experiment_apis` manifest key is read at extension load time and cannot be requested later. With the pref off, Thunderbird refuses to install an extension declaring it at all — so the key is injected at packaging time into the privileged build only. Both builds share the add-on ID `thunderbird-eas@woehrl.biz`, so installing one over the other keeps all account data.

---

## Account setup

EAS accounts are **not** created through Thunderbird's account wizard — that wizard only knows IMAP, POP3 and Thunderbird's own EWS support. The add-on brings its own page:

> **Tools → Exchange ActiveSync accounts…**

Alternatively **Tools → Add-ons and Themes → Extensions** → the **wrench icon** on *Thunderbird EAS Connector*. The wrench sits between the enable toggle and the `…` menu — the `…` menu itself only offers Remove and Manage, and the detail view has no Options tab.

If the wrench is greyed out and the Tools entry is missing, the extension's background page failed to start — usually a privileged build installed without `extensions.experiments.enabled = true`. Check the Error Console (Ctrl+Shift+J).

The **EAS Sync** toolbar button (status display and *Sync All*) is not shown by default: right-click the toolbar → **Customise…** → drag the extension's icon in.

### Leftover account nodes

Thunderbird offers no Delete for `none`-type accounts, so a node left behind by a failed setup — or by removing and reinstalling the add-on, which wipes extension storage while the node survives — cannot be removed through Thunderbird's own UI. The setup page lists such nodes and offers **Delete**, and **Restore** where the node still carries a usable copy of the configuration. Restoring keeps the original DeviceId, so the server keeps seeing the same device.

1. Open that page
2. Enter the mailbox address and password
3. Press **Find server** — Autodiscover fills in the host, or say so if it cannot
4. Optionally press **Check for EWS first** (see the note at the top)
5. Pick a device profile, press **Test Connection**, then **Add Account**

### Device profiles

Exchange can restrict which clients may connect through an Allow/Block/Quarantine (ABQ) rule keyed on `DeviceType` and `User-Agent`, and it enforces a per-mailbox limit on device partnerships — commonly five.

A measurement against a production Exchange 2019 in August 2026 returned:

| DeviceType | User-Agent | Result |
|---|---|---|
| `WindowsOutlook15` | `Outlook/16.0 (…; C2R; x64)` | HTTP 200 |
| `iPhone` | `Apple-iPhone14C1/2011.223` | HTTP 200 |
| `Android` | `Android/14.0` | HTTP 403 |
| `TBSync` | `Thunderbird-EAS/1.0` | HTTP 403 |

That measurement was later explained: the mailbox device quota was exhausted at the time, and status 165 (`DeviceInformationRequired`) accounted for the rest. With the quota cleared, `Thunderbird` provisions and syncs against the same server.

**The default is therefore the honest `Thunderbird` fingerprint.** The imitation profiles exist for servers that admit only known clients — presenting as another vendor's product without need would misreport the device in every administrator's inventory.

Its User-Agent is `Thunderbird-EAS/1.0` and deliberately carries no Thunderbird version. MS-ASHTTP allows a server to track the User-Agent across requests and block a device that changes it too often, and a Thunderbird version string changes with every update. The running version is reported through `Settings/DeviceInformation` instead, where it is display metadata and changing it is expected — it shows up in the OWA device list as `Thunderbird 153.0.2 (user@domain)`.

The profile also decides the protocol version: a client calling itself `WindowsOutlook15` negotiates 14.0, because that is what real Outlook does. Asking for 16.1 under that name is a fingerprint that does not exist anywhere.

**Compare device profiles** in the Advanced section sends one minimal FolderSync per profile using the same DeviceId and reports which the server accepts.

> Exchange keys a device partnership on `DeviceId` **and** `DeviceType`. Changing profiles later registers an *additional* device and consumes another quota slot; the old entry has to be deleted in OWA by hand. The same applies to the probe.

### Advanced options

| Option | Purpose |
|---|---|
| Poll interval | Fallback polling when push is off or unavailable |
| Sync messages from | `FilterType` — limits how far back the initial sync reaches |
| Credential encoding | UTF-8 by default. Real Outlook sends Basic credentials as ISO-8859-1; with a non-ASCII password that difference looks exactly like a wrong password |
| Push (Ping) | Long-poll for changes instead of waiting for the next interval |
| Device ID | Leave empty to generate one. Reuse an existing ID to re-attach to a partnership the server already knows — after reinstalling, or on another profile — instead of consuming another quota slot and starting a fresh quarantine |
| Mailbox address | Only when the login is not the mailbox address itself |

---

## Status indicators

| Dot | Badge | Meaning |
|---|---|---|
| 🟢 | OK | Last sync completed |
| 🟡 | Syncing… | Sync running |
| 🟠 | Blocked | Server refused the device, or is throttling — shows the remaining backoff |
| 🔴 | Error | Sync failed; hover for the message |
| ⚫ | Never synced | Nothing has run yet |

---

## Quarantine — the normal first outcome

Many Exchange organisations quarantine every new device by default. It looks like success: the account node appears, the full folder tree is created, and the inbox contains exactly one message from "Microsoft Outlook" explaining that access is blocked pending administrator approval. That is Exchange behaving as designed — a quarantined device may provision and fetch its hierarchy, but no content.

That notification is the best diagnostic the protocol offers, because it echoes back what actually arrived on the wire: DeviceType, User-Agent, negotiated protocol version, DeviceId. The decisive field is **Grund für Gerätezugriffsstatus / device access state reason**:

| Reason | Cause | Does another device profile help? |
|---|---|---|
| `Global` | Org-wide default access level is Quarantine | No — only an administrator can release it |
| `Individual` | Per-mailbox or per-device rule | Sometimes |
| `DeviceRule` | ABQ rule on DeviceType / User-Agent | Yes — try **Compare device profiles** |

To request release, the administrator needs the mailbox, the DeviceId (also shown per account on the setup page) and the DeviceType. Afterwards press **Sync All** in the popup, which clears any pending backoff.

## When the server refuses the device

Symptom: an orange **Blocked** badge, an HTTP 403 or EAS status 126/129/177 in the log — and **no** folder tree at all.

There are two causes and they are fixed in the same place:

1. **ABQ rule** — the DeviceType or User-Agent is not on the allow list. Switch to the `WindowsOutlook15` or `iPhone` profile, or run **Compare device profiles**.
2. **Device quota exhausted** — Exchange allows a limited number of partnerships per mailbox. Every stale phone and every earlier probe counts.

Both: **OWA → Options → Phone → Mobile Devices**. Approve the new device, or delete the ones you no longer use.

After a refusal the add-on stays quiet for 30 minutes rather than retrying every cycle — otherwise Exchange sends the mailbox owner a fresh quarantine notification for each attempt. **Sync All** in the popup clears the backoff immediately, which is what you want right after approving the device.

---

## Updating

Install the new `.xpi` **over** the existing extension. Removing and re-installing wipes extension storage, which regenerates the DeviceId — Exchange then sees a brand new device, starts a fresh quarantine cycle and consumes another quota slot.

---

## Folder layout

```
Standard build                    Privileged build

Local Folders                     user@domain.org      ← its own account node
└── user@domain.org               ├── Inbox            ← tagged as the real Inbox
    ├── Inbox                     ├── Sent Items       ← identity files sent mail here
    ├── Sent Items                ├── Drafts
    ├── Drafts                    ├── Deleted Items
    ├── Deleted Items             └── (custom folders…)
    └── (custom folders…)
```

---

## Troubleshooting

**Everything connects but no mail arrives.** Check the error console (Ctrl+Shift+J) for `[EAS]` lines. If the code page self-test reports an inconsistency at startup, that is the cause — run `node tools/selftest.mjs`.

**Test Connection fails.** The host field takes a hostname only, no scheme and no port. `curl -u user:pass -v https://<host>/Microsoft-Server-ActiveSync` is a quick independent check.

**Password with umlauts rejected.** Switch Credential encoding to ISO-8859-1 in the Advanced section.

**Common status codes**

| Status | Meaning | Handling |
|---|---|---|
| 142 / 143 / 144 / 145 | Provisioning needed or policy key stale | Automatic: provision, then retry once |
| 126 / 129 / 177 | ActiveSync disabled for the mailbox, device blocked, or device quota exhausted | 30-minute backoff, admin action required |
| 165 | `DeviceInformationRequired` — **not** a block | Automatic: device information is sent inside the Provision request |
| 3 / 9 / 12 / 131 | Sync key invalid | Automatic: collection rebuilt |
| HTTP 403 | ABQ rule or device quota | See the section above |
| HTTP 503 | Throttling | Backoff honouring `Retry-After` |

---

## Limitations

- **Email only.** Calendar, contacts, tasks and notes are not synced.
- **Basic authentication only.** No OAuth 2.0, so Exchange Online is out of reach.
- **Protocol 14.1 at most.** 16.x changed calendar, recurrence and draft handling; negotiating it would mean sending requests this client cannot interpret.
- **Unsigned.** Thunderbird installs it but shows a warning.
- **Patents.** Microsoft's EAS patent licensing programme explicitly names client-side implementations. This add-on is a client. That is a situation to be aware of, not legal advice.

---

## License

MIT — see [LICENSE](LICENSE).
