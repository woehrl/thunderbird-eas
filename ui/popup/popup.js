/**
 * Popup UI – per-account status with colored dot + badge + full tooltip.
 */

const $ = id => document.getElementById(id);

function classifyStatus(st) {
  if (st.syncing)                              return 'syncing';
  if (st.error?.toLowerCase().includes('quarantine')) return 'quarantine';
  if (st.error)                                return 'error';
  if (st.lastSync)                             return 'ok';
  return 'idle';
}

const BADGE_LABEL = {
  syncing:    'Syncing…',
  ok:         'OK',
  quarantine: 'Pending',
  error:      'Error',
  idle:       'Never synced',
};

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

async function render() {
  let accounts, status;
  try {
    [accounts, status] = await Promise.all([
      messenger.runtime.sendMessage({ type: 'GET_ACCOUNTS' }),
      messenger.runtime.sendMessage({ type: 'GET_STATUS' }),
    ]);
  } catch (_) {
    return; // popup closing, context unloaded — skip update
  }

  const list = $('account-list');
  list.innerHTML = '';

  if (!accounts || accounts.length === 0) {
    $('no-accounts').style.display = '';
    return;
  }
  $('no-accounts').style.display = 'none';

  for (const acc of accounts) {
    const st    = status?.[acc.id] || {};
    const kind  = classifyStatus(st);
    const label = BADGE_LABEL[kind];

    const lastSync = st.lastSync
      ? new Date(st.lastSync).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})
      : '—';

    // Full tooltip on hover (native title attribute)
    let tooltip = `${acc.email || acc.username} @ ${acc.host}\nLast sync: ${lastSync}`;
    if (st.error) tooltip += `\n\n${st.error}`;

    // Status line shown under account name (truncated, full in tooltip)
    let statusLine = '';
    if (kind === 'quarantine') {
      statusLine = `<div class="status-line quarantine" title="${escHtml(st.error)}">⏳ Awaiting admin approval in OWA → Options → Phone → Mobile Devices</div>`;
    } else if (kind === 'error') {
      statusLine = `<div class="status-line error" title="${escHtml(st.error)}">${escHtml(st.error)}</div>`;
    }

    const div = document.createElement('div');
    div.className = 'account';
    div.title = tooltip;
    div.innerHTML = `
      <div class="account-header">
        <span class="dot ${kind}"></span>
        <span class="account-name">${escHtml(acc.email || acc.username)}</span>
        <span class="badge ${kind}">${label}</span>
      </div>
      <div class="account-meta">${escHtml(acc.host)} · Last sync: ${lastSync}</div>
      ${statusLine}
    `;
    list.appendChild(div);
  }
}

$('btn-sync-all').addEventListener('click', async () => {
  $('btn-sync-all').textContent = 'Syncing…';
  $('btn-sync-all').disabled = true;
  await messenger.runtime.sendMessage({ type: 'SYNC_NOW' });
  setTimeout(() => {
    $('btn-sync-all').textContent = 'Sync All';
    $('btn-sync-all').disabled = false;
    render();
  }, 2000);
});

$('btn-setup').addEventListener('click', () => {
  messenger.tabs.create({ url: '../../ui/setup/setup.html' });
  window.close();
});

messenger.runtime.onMessage.addListener(msg => {
  if (msg.type === 'STATUS_UPDATE') render();
});

// Poll while popup is open so status stays current even if the
// STATUS_UPDATE message was missed (e.g. popup opened mid-sync).
const _refreshTimer = setInterval(render, 2500);
window.addEventListener('unload', () => clearInterval(_refreshTimer));

render();
