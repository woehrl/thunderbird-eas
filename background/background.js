/**
 * Background entry point.
 *
 * MV2 persistent background page: the Ping push loop needs a context that
 * stays alive between alarm ticks, which an event page would not provide.
 */

import { SyncManager } from '../sync/manager.js';

const manager = new SyncManager();

manager.start().catch(e => console.error('[EAS] SyncManager failed to start:', e));

messenger.runtime.onMessage.addListener(msg => manager.handleMessage(msg));

messenger.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install' || reason === 'update') {
    await messenger.runtime.openOptionsPage().catch(() => {});
  }
});

/**
 * Put the setup page in the Tools menu.
 *
 * The Add-ons Manager route is not obvious: the options button is a small
 * wrench between the enable toggle and the "…" menu, the "…" menu itself only
 * offers Remove and Manage, and the detail view has no options tab. The
 * toolbar button is not shown until the user adds it through toolbar
 * customisation. A Tools menu entry is always visible and needs no setup.
 */
const SETTINGS_MENU_ID = 'eas-open-settings';

if (messenger.menus) {
  messenger.menus.create({
    id:       SETTINGS_MENU_ID,
    title:    'Exchange ActiveSync accounts…',
    contexts: ['tools_menu'],
  });

  messenger.menus.onClicked.addListener(info => {
    if (info.menuItemId === SETTINGS_MENU_ID) messenger.runtime.openOptionsPage();
  });
}
