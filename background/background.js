/**
 * Background entry point.
 * Loads the SyncManager and wires up runtime message handling.
 */

console.log('[EAS] Background script starting…');

import { SyncManager } from '../sync/manager.js';

console.log('[EAS] SyncManager imported OK');

const manager = new SyncManager();

// Start on extension load
manager.start()
  .then(() => console.log('[EAS] SyncManager started OK'))
  .catch(e => console.error('[EAS] Failed to start SyncManager:', e));

// Handle messages from popup and setup pages
messenger.runtime.onMessage.addListener((msg, sender) => {
  return manager.handleMessage(msg, sender);
});

// Open setup page when first installed
if (messenger.runtime.onInstalled) {
  messenger.runtime.onInstalled.addListener(async ({ reason }) => {
    if (reason === 'install') {
      await messenger.tabs.create({ url: '../ui/setup/setup.html' });
    }
  });
}
