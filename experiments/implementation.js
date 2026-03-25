"use strict";

/**
 * Privileged XPCOM experiment: create/remove real Thunderbird account nodes.
 *
 * Thunderbird exposes MailServices via XPCOM. We use it to create an
 * nsIMsgIncomingServer of type "none" (same as Local Folders) and wire it
 * to a new nsIMsgAccount. The account shows up as a top-level node in the
 * Thunderbird folder pane just like IMAP accounts.
 *
 * Each EAS email address gets its own server (identified by email+hostname).
 * The WebExtension API layer returns the account.key so the extension can
 * later call messenger.accounts.get(key) to get the WebExtension MailAccount.
 */

// ExtensionCommon is injected into the experiment script scope by Thunderbird.
// ChromeUtils is always available as a privileged global.
/* global ExtensionCommon, ChromeUtils */

this.easAccount = class extends ExtensionCommon.ExtensionAPI {

  _getMailServices() {
    // Thunderbird 115+ uses .sys.mjs; older versions use .jsm
    try {
      return ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs").MailServices;
    } catch (_) {
      return ChromeUtils.import("resource:///modules/MailServices.jsm").MailServices;
    }
  }

  getAPI(context) {
    // Capture reference so closures below can use it
    const self = this;

    return {
      easAccount: {

        /**
         * Create (or re-use) a Thunderbird account node for the EAS account.
         * Returns the nsIMsgAccount.key string so the WebExtension can call
         * messenger.accounts.get(key) to obtain a MailAccount object.
         */
        async createAccount(email, hostname) {
          const MailServices = self._getMailServices();

          // Re-use an existing server if we already created one for this email+host.
          let server = null;
          try {
            server = MailServices.accounts.findServer(email, hostname, "none");
          } catch (_) { /* not found */ }

          if (!server) {
            server = MailServices.accounts.createIncomingServer(email, hostname, "none");
            server.prettyName = email;
            // Mark it as valid so it appears in the folder pane
            server.valid = true;
          }

          // Find the account that already owns this server (after extension restart)
          for (const acct of MailServices.accounts.accounts) {
            if (acct.incomingServer?.key === server.key) {
              return acct.key;
            }
          }

          // No account owns this server yet — create one
          const account = MailServices.accounts.createAccount();
          account.incomingServer = server;
          return account.key;
        },

        /**
         * Remove the account node and its local mail files.
         */
        async removeAccount(accountKey) {
          const MailServices = self._getMailServices();

          let found = null;
          for (const acct of MailServices.accounts.accounts) {
            if (acct.key === accountKey) { found = acct; break; }
          }

          if (found) {
            // true = also remove the local mail files
            MailServices.accounts.removeAccount(found, true);
          }
        },

      }
    };
  }
};
