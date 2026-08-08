"use strict";

/**
 * Privileged XPCOM experiment.
 *
 * Thunderbird has no EAS backend, so an EAS mailbox cannot be a real
 * nsIMsgIncomingServer of its own type. What it *can* be is a server of type
 * "none" — the same type Local Folders uses — owned by its own nsIMsgAccount.
 * That gives a genuine top-level node in the folder pane, indistinguishable
 * from an IMAP account to the user, while the add-on drives all traffic.
 *
 * Four things separate a bare account node from one that feels native, and
 * all four need XPCOM:
 *
 *   1. an identity, so the address appears in the compose From picker and the
 *      account has a name instead of a hostname
 *   2. folder flags, so Inbox/Sent/Drafts/Trash get their real icons and
 *      Thunderbird's special-folder behaviour (delete-to-trash, save-to-drafts)
 *   3. identity folder URIs, so sent mail and drafts land in the EAS folders
 *      rather than in Local Folders
 *   4. nsILoginManager, so the password is not kept in plaintext extension
 *      storage
 *
 * Everything here is idempotent: calling createAccount twice returns the same
 * account key rather than creating a second one.
 */

// Cc, Ci and Services are already globals in the experiment sandbox. Do not
// re-declare them: `const Cc = ...` is a redeclaration error that kills the
// whole script at parse time, and the only visible symptom is a greyed-out
// options button in the Add-ons Manager.
/* global ExtensionCommon, ChromeUtils, Cc, Ci, Services */

const LOGIN_REALM = "Exchange ActiveSync";

/** Marks the servers this add-on created, so orphans can be found later. */
const MANAGED_PREF = "eas_managed_by_addon";

function importModule(esmPath, jsmPath, symbol) {
  try {
    return ChromeUtils.importESModule(esmPath)[symbol];
  } catch (_) {
    return ChromeUtils.import(jsmPath)[symbol];
  }
}

function getMailServices() {
  return importModule(
    "resource:///modules/MailServices.sys.mjs",
    "resource:///modules/MailServices.jsm",
    "MailServices"
  );
}

function getServices() {
  if (typeof Services !== "undefined") return Services;
  return importModule(
    "resource://gre/modules/Services.sys.mjs",
    "resource://gre/modules/Services.jsm",
    "Services"
  );
}

/** EAS folder role → nsMsgFolderFlags bit. */
function flagForRole(role) {
  const F = Ci.nsMsgFolderFlags;
  switch (role) {
    case "inbox":    return F.Inbox;
    case "sent":     return F.SentMail;
    case "drafts":   return F.Drafts;
    case "trash":    return F.Trash;
    case "outbox":   return F.Queue;
    case "junk":     return F.Junk;
    case "archives": return F.Archive;
    case "templates":return F.Templates;
    default:         return 0;
  }
}

function findAccountByKey(MailServices, accountKey) {
  for (const acct of MailServices.accounts.accounts) {
    if (acct.key === accountKey) return acct;
  }
  return null;
}

/**
 * Every account node this add-on could have created.
 *
 * Servers created from now on carry a marker preference. Nodes from earlier
 * versions do not, so the fallback is structural: Thunderbird itself only ever
 * creates one server of type "none" (Local Folders), so any *other* "none"
 * server belongs to us. Without this, a node left behind by a failed setup is
 * unreachable — Thunderbird hides Delete and Set-as-default for "none"
 * accounts, and the add-on cannot find it either once its own storage entry is
 * gone.
 */
function listManagedAccounts(MailServices) {
  const localFoldersKey = (() => {
    try { return MailServices.accounts.localFoldersServer?.key || null; } catch (_) { return null; }
  })();

  const out = [];
  for (const account of MailServices.accounts.accounts) {
    const server = account.incomingServer;
    if (!server || server.type !== "none") continue;
    if (localFoldersKey && server.key === localFoldersKey) continue;

    let managed = false;
    try { managed = server.getBoolValue(MANAGED_PREF); } catch (_) {}

    let identityCount = 0;
    try { identityCount = account.identities?.length || 0; } catch (_) {}

    out.push({
      accountKey:   account.key,
      serverKey:    server.key,
      name:         server.prettyName || "",
      hostname:     server.hostName || "",
      username:     server.username || "",
      markedManaged: managed,
      identityCount,
    });
  }
  return out;
}

// ── Password manager ────────────────────────────────────────────────
//
// findLogins() and addLogin() were removed in favour of the async variants.
// Both spellings are attempted so the add-on works across Thunderbird
// versions; a hard call to the removed method throws
// NS_ERROR_NOT_IMPLEMENTED and takes the surrounding operation with it.

async function searchLogins(Services, origin) {
  const manager = Services.logins;
  if (typeof manager.searchLoginsAsync === "function") {
    return await manager.searchLoginsAsync({ origin, httpRealm: LOGIN_REALM });
  }
  return manager.findLogins(origin, null, LOGIN_REALM);
}

async function addLogin(Services, login) {
  const manager = Services.logins;
  if (typeof manager.addLoginAsync === "function") return await manager.addLoginAsync(login);
  return manager.addLogin(login);
}

/**
 * Resolve a WebExtension folder path ("/Inbox/Sub") against a server root.
 * Returns nsIMsgFolder or null.
 */
function resolveFolderPath(rootFolder, path) {
  const segments = String(path || "").split("/").filter(Boolean);
  let folder = rootFolder;
  for (const segment of segments) {
    if (!folder) return null;
    try {
      folder = folder.getChildNamed(segment);
    } catch (_) {
      return null;
    }
  }
  return folder === rootFolder ? null : folder;
}

/**
 * Point an identity at one of its special folders.
 *
 * The attribute names on nsIMsgIdentity were renamed during the Thunderbird
 * 115–128 cycle (`fccFolder` → `fccFolderURI` and friends). Both spellings are
 * attempted so the add-on keeps working across versions instead of throwing on
 * an unknown attribute.
 */
function setIdentityFolder(identity, role, uri) {
  const candidates = {
    sent:     ["fccFolderURI", "fccFolder"],
    drafts:   ["draftsFolderURI", "draftFolder", "drafts"],
    archives: ["archivesFolderURI", "archiveFolder"],
  }[role];
  if (!candidates) return false;

  for (const attribute of candidates) {
    try {
      identity[attribute] = uri;
      return true;
    } catch (_) { /* attribute not present in this version */ }
  }
  return false;
}

this.easAccount = class extends ExtensionCommon.ExtensionAPI {

  // Declared even though the manifest no longer requests the "startup" event:
  // if that declaration ever comes back, its absence takes down the entire
  // extension at bootstrap rather than degrading this one API.
  onStartup() {}

  getAPI(context) {
    return {
      easAccount: {

        /**
         * Create (or re-use) a Thunderbird account node for an EAS account,
         * including an identity so it behaves like a real mail account.
         *
         * @returns {Promise<{accountKey, serverKey, identityKey, created}>}
         */
        async createAccount(email, hostname, options = {}) {
          const MailServices = getMailServices();
          const displayName  = options.displayName || email;

          // Re-use the server if we already created one for this email+host.
          let server = null;
          let created = false;
          try {
            server = MailServices.accounts.findServer(email, hostname, "none");
          } catch (_) { /* not found */ }

          if (!server) {
            server = MailServices.accounts.createIncomingServer(email, hostname, "none");
            created = true;
          }
          server.prettyName = displayName;
          server.valid = true;
          try { server.setBoolValue(MANAGED_PREF, true); } catch (_) {}
          // A "none" server has no polling of its own; the add-on drives sync.
          try { server.setIntValue("check_time", 0); } catch (_) {}
          try { server.setBoolValue("login_at_startup", false); } catch (_) {}

          // Re-use the account that already owns this server.
          let account = null;
          for (const acct of MailServices.accounts.accounts) {
            if (acct.incomingServer?.key === server.key) { account = acct; break; }
          }
          if (!account) {
            account = MailServices.accounts.createAccount();
            account.incomingServer = server;
          }

          // Everything below is best-effort. The account key must be returned
          // even if the identity cannot be set up: without it the extension
          // never learns the key, cannot remove the node later, and leaves an
          // orphan that Thunderbird's own UI refuses to delete.
          let identityKey = null;
          let identityError = null;
          try {
            // Reading defaultIdentity on an account without identities throws
            // on some versions rather than returning null.
            let identity = null;
            try { identity = account.defaultIdentity; } catch (_) {}
            if (!identity) {
              try {
                const existing = account.identities;
                if (existing && existing.length) identity = existing[0];
              } catch (_) {}
            }

            if (!identity) {
              identity = MailServices.accounts.createIdentity();
              identity.email    = email;
              identity.fullName = options.fullName || "";
              account.addIdentity(identity);
              try { account.defaultIdentity = identity; } catch (_) {}
            } else {
              identity.email = email;
              if (options.fullName) identity.fullName = options.fullName;
            }

            // Outgoing mail goes over EAS SendMail, not SMTP; leave the SMTP
            // server unset so Thunderbird does not offer a broken send path.
            try { identity.smtpServerKey = ""; } catch (_) {}
            identityKey = identity.key;
          } catch (e) {
            identityError = String(e);
          }

          return {
            accountKey: account.key,
            serverKey:  server.key,
            identityKey,
            identityError,
            created,
          };
        },

        /**
         * List the account nodes this add-on could have created, so the setup
         * page can offer to remove orphans.
         */
        async listAccounts() {
          return listManagedAccounts(getMailServices());
        },

        /**
         * Tag a folder as a special folder so Thunderbird gives it the right
         * icon, sort position and behaviour, and point the identity at the
         * Sent/Drafts/Archive folders.
         */
        async setSpecialFolder(accountKey, folderPath, role) {
          const MailServices = getMailServices();
          const account = findAccountByKey(MailServices, accountKey);
          if (!account?.incomingServer) return false;

          const folder = resolveFolderPath(account.incomingServer.rootFolder, folderPath);
          if (!folder) return false;

          const flag = flagForRole(role);
          if (!flag) return false;
          folder.setFlag(flag);

          const identity = account.defaultIdentity;
          if (identity) {
            setIdentityFolder(identity, role, folder.URI);
            if (role === "sent") {
              try { identity.doFcc = true; } catch (_) {}
            }
          }
          return true;
        },

        /** Rename the account node shown in the folder pane. */
        async setAccountName(accountKey, name) {
          const MailServices = getMailServices();
          const account = findAccountByKey(MailServices, accountKey);
          if (!account?.incomingServer) return false;
          account.incomingServer.prettyName = name;
          return true;
        },

        /** Remove the account node and its local mail files. */
        async removeAccount(accountKey) {
          const MailServices = getMailServices();
          const account = findAccountByKey(MailServices, accountKey);
          if (!account) return false;
          MailServices.accounts.removeAccount(account, true);
          return true;
        },

        // ── Password storage ────────────────────────────────────────
        //
        // nsILoginManager is where Thunderbird keeps every other account
        // password. Using it means the EAS password is covered by the primary
        // password if one is set, and never sits in extension storage.

        async storePassword(hostname, username, password) {
          const Services = getServices();
          const origin = `https://${hostname}`;
          const login = Cc["@mozilla.org/login-manager/loginInfo;1"]
            .createInstance(Ci.nsILoginInfo);
          login.init(origin, null, LOGIN_REALM, username, password, "", "");

          const existing = (await searchLogins(Services, origin))
            .filter(l => l.username === username);

          if (existing.length) {
            Services.logins.modifyLogin(existing[0], login);
            for (const duplicate of existing.slice(1)) Services.logins.removeLogin(duplicate);
          } else {
            await addLogin(Services, login);
          }
          return true;
        },

        async getPassword(hostname, username) {
          const Services = getServices();
          const origin = `https://${hostname}`;
          const match = (await searchLogins(Services, origin))
            .find(l => l.username === username);
          return match ? match.password : null;
        },

        async removePassword(hostname, username) {
          const Services = getServices();
          const origin = `https://${hostname}`;
          for (const login of await searchLogins(Services, origin)) {
            if (login.username === username) Services.logins.removeLogin(login);
          }
          return true;
        },
      },
    };
  }
};
