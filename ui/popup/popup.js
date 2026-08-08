/**
 * Popup: one status row per account.
 */

const $ = id => document.getElementById(id);

/**
 * Status is classified from the typed error code rather than by matching
 * substrings in a human-readable message — the message wording is free to
 * change without silently breaking the display.
 */
function classifyStatus(st) {
  if (st.syncing) return 'syncing';
  switch (st.errorCode) {
    case 'DEVICE_BLOCKED':    return 'quarantine';
    case 'THROTTLED':         return 'quarantine';
    case 'AUTH_FAILED':
    case 'PASSWORD_EXPIRED':  return 'error';
    default: break;
  }
  if (st.error)    return 'error';
  if (st.lastSync) return 'ok';
  return 'idle';
}

const BADGE_LABEL = {
  syncing:    'Syncing…',
  ok:         'OK',
  quarantine: 'Blocked',
  error:      'Error',
  idle:       'Never synced',
};

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatBackoff(ms) {
  if (!ms || ms <= 0) return '';
  const minutes = Math.ceil(ms / 60000);
  return ` — retrying in ${minutes} min`;
}

async function render() {
  let accounts, status;
  try {
    [accounts, status] = await Promise.all([
      messenger.runtime.sendMessage({ type: 'GET_ACCOUNTS' }),
      messenger.runtime.sendMessage({ type: 'GET_STATUS' }),
    ]);
  } catch (_) {
    return;   // popup closing, context unloading
  }

  const list = $('account-list');
  list.innerHTML = '';

  if (!accounts?.length) {
    $('no-accounts').style.display = '';
    return;
  }
  $('no-accounts').style.display = 'none';

  for (const account of accounts) {
    const st   = status?.[account.id] || {};
    const kind = classifyStatus(st);

    const lastSync = st.lastSync
      ? new Date(st.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '—';

    let tooltip = `${account.email || account.username} @ ${account.host}\nLast sync: ${lastSync}`;
    if (st.pushing) tooltip += '\nPush: active';
    if (st.error)   tooltip += `\n\n${st.error}`;

    let statusLine = '';
    if (kind === 'quarantine' || kind === 'error') {
      statusLine = `<div class="status-line ${kind === 'quarantine' ? 'quarantine' : 'error'}" ` +
        `title="${escHtml(st.error)}">${escHtml(st.error)}${escHtml(formatBackoff(st.backoffRemainingMs))}</div>`;
    }

    const row = document.createElement('div');
    row.className = 'account';
    row.title = tooltip;
    row.innerHTML = `
      <div class="account-header">
        <span class="dot ${kind}"></span>
        <span class="account-name">${escHtml(account.email || account.username)}</span>
        <span class="badge ${kind}">${BADGE_LABEL[kind]}</span>
      </div>
      <div class="account-meta">
        ${escHtml(account.host)} · Last sync: ${lastSync}${st.pushing ? ' · push' : ''}
      </div>
      ${statusLine}
    `;
    list.appendChild(row);
  }
}

$('btn-sync-all').addEventListener('click', async () => {
  const btn = $('btn-sync-all');
  btn.textContent = 'Syncing…';
  btn.disabled = true;
  try {
    await messenger.runtime.sendMessage({ type: 'SYNC_NOW' });
  } catch (_) { /* popup closing */ }
  setTimeout(() => {
    btn.textContent = 'Sync All';
    btn.disabled = false;
    render();
  }, 2000);
});

$('btn-setup').addEventListener('click', () => {
  messenger.runtime.openOptionsPage();
  window.close();
});

messenger.runtime.onMessage.addListener(msg => {
  if (msg.type === 'STATUS_UPDATE') render();
});

// Poll while open: the first sync fires a few seconds after startup, and a
// STATUS_UPDATE sent while the popup was closed is simply lost.
const refreshTimer = setInterval(render, 2500);
window.addEventListener('unload', () => clearInterval(refreshTimer));

render();
