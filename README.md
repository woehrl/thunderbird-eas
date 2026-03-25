# Thunderbird EAS Connector

A Thunderbird add-on that connects to **Exchange ActiveSync (EAS)** servers, letting you read and write email directly from Thunderbird without needing an IMAP/POP3 account. Works with Exchange Online, on-premise Exchange, and any server that speaks the EAS protocol (e.g. `eas.example.com`).

---

## Features

- Full email synchronisation (Inbox, Sent, Drafts, Deleted, custom folders)
- Outgoing mail via EAS SendMail (no SMTP required)
- Read-flag changes propagated back to server
- Automatic EAS provisioning (policy key handshake)
- Configurable device profile — impersonate Outlook, Android, or iPhone
- Status popup with per-account colour indicator (green / orange / red)
- Quarantine detection with user-friendly explanation when admin approval is needed
- Periodic sync (configurable interval, default 5 minutes)
- Optional privileged build: EAS accounts appear as dedicated top-level nodes (like IMAP)

---

## Requirements

| Component | Minimum version |
|---|---|
| Thunderbird | 91.0 (tested on 140.9.0 ESR) |
| Exchange Server | Any version supporting EAS 14.0+ |
| Node.js | 14+ (build only) |

---

## Installation

### From release

Two builds are published with each release:

| File | Description |
|---|---|
| `thunderbird-eas-x.y.z-<ts>.xpi` | **Standard** — works out of the box, no configuration needed |
| `thunderbird-eas-x.y.z-privileged-<ts>.xpi` | **Privileged** — EAS accounts appear as real account nodes; requires one-time about:config change (see below) |

1. Download the `.xpi` of your choice from [Releases](../../releases).
2. In Thunderbird: **Extras → Add-ons and Themes → gear icon → Install Add-on From File**.
3. Select the `.xpi` file and confirm.

### Build from source

```bash
git clone https://github.com/woehrl/thunderbird-eas
cd thunderbird-eas

# Standard build (Local Folders subfolder, works everywhere)
node package.js
# → dist/thunderbird-eas-1.0.0-<timestamp>.xpi

# Privileged build (real account node, requires about:config change)
node package.js --privileged
# → dist/thunderbird-eas-1.0.0-privileged-<timestamp>.xpi
```

No npm or bundler required. All source is native ES2020 modules.

---

## Standard vs Privileged Build

### Standard build

- Works immediately after install, no configuration required
- Synced folders appear as a named subfolder inside **Local Folders**
- Suitable for all users

### Privileged build

- EAS accounts appear as **dedicated top-level nodes** in the folder pane, identical to IMAP/POP3 accounts
- Uses the Thunderbird Experiments API (privileged XPCOM code)
- **Requires a one-time about:config change before installing:**

  1. Open Thunderbird → **Extras → Einstellungen (Settings) → Allgemein (General)** tab
  2. Scroll to the very bottom → click **Konfigurationseditor (Config Editor)**
  3. Search for `extensions.experiments.enabled` → double-click to set it to **`true`**
  4. Close the Config Editor
  5. Now install the `-privileged` `.xpi`

> **Why is this needed?** The `experiment_apis` manifest key must be declared at extension load time — it cannot be opted into at runtime. Thunderbird rejects the entire extension if this key is present and the pref is `false`. The standard build omits this key entirely; the privileged build injects it during packaging. Both builds share identical source code and the same addon ID, so switching between them (install-over, don't remove first) preserves all account data.

---

## Account Setup

1. Click the **EAS Sync** button in the Thunderbird toolbar (top-right area).
2. Click **Settings**.
3. Fill in the form:

| Field | Example | Notes |
|---|---|---|
| EAS Server | `eas.example.com` | Hostname only, no `https://`, no port |
| Username | `user@domain.org` | Usually the full email address |
| Display Email | *(optional)* | If different from username |
| Password | ••••••• | Stored in local extension storage |
| Device Profile | Outlook 2016 | See section below |
| Sync Interval | `5` | Minutes between syncs |

4. Click **Test Connection** to verify the server is reachable and credentials are accepted.
5. Click **Add Account**. The initial sync starts in the background.

### Device Profile

Exchange administrators can restrict which device types may connect. Choose a profile that matches what your admin has already approved:

| Profile | User-Agent sent | DeviceType |
|---|---|---|
| iPhone (default) | `Apple-iPhone/702.67 (EAS Thunderbird Connector)` | `iPhone` |
| Outlook 2016 | `Outlook/16.0 (16.0.19426.20076; x86)` | `WindowsOutlook15` |
| Android Mail | `Android-Mail/2026.03.09.884664556.Release` | `Android` |

The selected profile also controls what is reported in the EAS `Settings/DeviceInformation` command (model, OS, friendly name), so the server sees a consistent device identity.

If your organisation uses a **global allow** policy (all devices are trusted by default) the profile does not matter. If it uses **individual approval**, choosing a profile that already has an approved device associated with it may reduce the waiting time — but the server still creates a new device entry because the Device ID is different.

---

## Status Indicators

Open the **EAS Sync** popup (toolbar button) to see the current state of each account:

| Dot colour | Badge | Meaning |
|---|---|---|
| 🟢 Green | OK | Last sync completed successfully |
| 🟡 Yellow | Syncing… | Sync in progress |
| 🟠 Orange | Pending | Device quarantined, waiting for admin approval |
| 🔴 Red | Error | Sync failed — hover over the row for details |
| ⚫ Grey | Never synced | No sync has run yet |

The popup polls the background script every 2.5 seconds while open, so status updates appear within a few seconds of any change. Hover over an account row for the full status message as a native tooltip.

---

## Device Quarantine

Some Exchange servers place **new devices in quarantine** until an administrator explicitly approves them. This is a server-side security policy and is unrelated to credentials.

**Symptoms:** Orange *Pending* badge in the popup; error console shows `Provision phase1 root children: Status="165"` or `FolderSync status=177`.

**Resolution:**
1. Log in to **Outlook Web App** (e.g. `mail.yourdomain.com`).
2. Go to **Options → Phone → Mobile Devices**.
3. Find the new device entry (shown with the device type you chose, e.g. *iPhone* or *WindowsOutlook15*).
4. Click the **Allow** (✓) button.
5. The next sync cycle (within 5 minutes) will succeed automatically — no action needed in Thunderbird.

**Device limit:** Exchange has a per-user limit on connected devices (often 5). If you hit this limit you will receive an email notification. Remove stale devices in the same OWA screen to free up slots.

---

## Updating the Add-on

> **Important:** To preserve your Device ID and provisioning state, always **install the new `.xpi` over the existing extension** — do not remove the old one first.

| Method | Effect |
|---|---|
| ✅ Extras → Install Add-on From File → select new `.xpi` | Thunderbird detects same addon ID, upgrades in-place, all storage preserved |
| ❌ Remove extension → re-install | Extension storage wiped, new Device ID generated, quarantine restarts |

Both the standard and privileged builds use the addon ID `thunderbird-eas@woehrl.biz`, so you can switch between them with an in-place upgrade.

---

## Folder Layout

### Standard build

```
Local Folders
└── user@domain.org          ← root folder named after your email
    ├── Inbox
    ├── Sent Items
    ├── Drafts
    ├── Deleted Items
    └── (custom folders…)
```

### Privileged build

```
user@domain.org              ← dedicated account node (like IMAP)
├── Inbox
├── Sent Items
├── Drafts
├── Deleted Items
└── (custom folders…)
```

---

## Troubleshooting

### Setup page does not open

- Make sure you installed from the `dist/` folder (the timestamped `.xpi`), not from the repo root.
- Open the error console (**Ctrl+Shift+J**) and look for errors at extension startup.
- If you installed the privileged build without enabling the pref first, Thunderbird will reject the extension. Enable `extensions.experiments.enabled` in about:config, then reinstall.

### Status popup shows "Never synced" after setup

The first sync runs approximately 6 seconds after the extension loads (alarm delay). Keep the popup open for a few seconds — it will update automatically within one 2.5-second poll cycle after the sync completes.

### FolderSync / Sync errors

Open the error console (**Ctrl+Shift+J**) and look for `[EAS]` log lines. Common status codes:

| Status | Meaning | Action |
|---|---|---|
| 142 / 145 | Device not provisioned | Handled automatically |
| 165 | Device quarantined (provisioning) | Admin approval required (see above) |
| 177 | Device quarantined (server-specific) | Admin approval required (see above) |
| 9 / 12 | Sync key mismatch | Handled automatically (reset + retry) |

### Connection test fails

- Verify the hostname contains no `https://` prefix and no port number.
- Some servers require TLS 1.2+ — this is handled automatically by Gecko's fetch API.
- Test with curl: `curl -u user:pass -v https://<host>/Microsoft-Server-ActiveSync`
- Some servers perform TLS renegotiation twice per connection — this is normal and harmless.

---

## Limitations

- **Attachments** are not yet downloaded (full MIME body is fetched but attachment files are not saved separately).
- **Calendar and Contacts** sync is not implemented (email only).
- **Push notifications** (EAS Ping command) are not implemented; sync is poll-based.
- **Passwords** are stored in plaintext in extension local storage. For production use, see the secure credential storage item in [DEVELOPMENT.md](DEVELOPMENT.md).
- The add-on is **unsigned**. Thunderbird will install it but may show a security warning.

---

## License

MIT — see [LICENSE](LICENSE) for details.
