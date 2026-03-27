/**
 * Account setup page logic.
 * All network operations are routed through the background script
 * so they run in the privileged extension context with full host permissions.
 */

const $ = id => document.getElementById(id);

async function loadAccounts() {
  const accounts = await messenger.runtime.sendMessage({ type: 'GET_ACCOUNTS' });
  const list  = $('account-list');
  const empty = $('accounts-empty');

  if (!accounts || accounts.length === 0) {
    empty.style.display = '';
    return;
  }

  empty.style.display = 'none';
  [...list.children].forEach(c => { if (c.id !== 'accounts-empty') c.remove(); });

  for (const acc of accounts) {
    const li = document.createElement('li');
    li.className = 'account-item';
    li.innerHTML = `
      <div>
        <div class="account-name">${escHtml(acc.email || acc.username)}</div>
        <div class="account-host">${escHtml(acc.host)}</div>
      </div>
      <button class="btn-remove btn" data-id="${escHtml(acc.id)}">Remove</button>
    `;
    list.appendChild(li);
  }

  list.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', () => removeAccount(btn.dataset.id));
  });
}

async function removeAccount(id) {
  if (!confirm('Remove this EAS account? Synced messages will remain in Thunderbird.')) return;
  await messenger.runtime.sendMessage({ type: 'REMOVE_ACCOUNT', accountId: id });
  loadAccounts();
}

function showStatus(msg, type = 'info') {
  const el = $('status-msg');
  el.textContent = msg;
  el.className   = `status-msg ${type}`;
  el.style.display = '';
}

function log(msg) {
  const box = $('debug-log');
  box.style.display = '';
  const line = document.createElement('div');
  line.textContent = `[${new Date().toISOString().slice(11,23)}] ${msg}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

// ── Custom profile show/hide ──────────────────────────────────────

// Pre-populate custom fields from the iPhone profile as a starting point
const CUSTOM_DEFAULTS = {
  'custom-device-type':  'Thunderbird',
  'custom-model':        'Thunderbird',
  'custom-user-agent':   'Thunderbird/140.9',
  'custom-os':           '',
  'custom-os-language':  '',
  'custom-friendly-name':'Thunderbird',
};

$('device-profile').addEventListener('change', () => {
  const isCustom = $('device-profile').value === 'Custom';
  $('custom-profile-section').style.display = isCustom ? '' : 'none';
  if (isCustom) {
    // Fill defaults only for empty fields so a returning user keeps their values
    for (const [id, val] of Object.entries(CUSTOM_DEFAULTS)) {
      if (!$(id).value) $(id).value = val;
    }
  }
});

function getFormData() {
  const profileId = $('device-profile').value;
  const data = {
    host:            $('host').value.trim(),
    username:        $('username').value.trim(),
    email:           $('email').value.trim() || $('username').value.trim(),
    password:        $('password').value,
    deviceProfileId: profileId,
    syncInterval:    parseInt($('sync-interval').value, 10) || 5,
  };
  if (profileId === 'Custom') {
    data.customProfile = {
      deviceType:   $('custom-device-type').value.trim(),
      userAgent:    $('custom-user-agent').value.trim(),
      model:        $('custom-model').value.trim(),
      os:           $('custom-os').value.trim(),
      osLanguage:   $('custom-os-language').value.trim(),
      friendlyName: $('custom-friendly-name').value.trim() || 'Thunderbird EAS',
    };
  }
  return data;
}

function validate(data) {
  if (!data.host)     return 'EAS server is required';
  if (!data.username) return 'Username is required';
  if (!data.password) return 'Password is required';
  if (data.deviceProfileId === 'Custom') {
    if (!data.customProfile.deviceType) return 'Device Type is required for custom profile';
    if (!data.customProfile.model)      return 'Device Model is required for custom profile';
    if (!data.customProfile.userAgent)  return 'User-Agent is required for custom profile';
  }
  return null;
}

// ── Test connection (goes via background script) ──────────────────

$('btn-test').addEventListener('click', async () => {
  const data = getFormData();
  const err  = validate(data);
  if (err) { showStatus(err, 'error'); return; }

  showStatus('Testing connection…', 'info');
  log(`Testing OPTIONS https://${data.host}/Microsoft-Server-ActiveSync`);
  $('btn-test').disabled = true;

  try {
    const result = await messenger.runtime.sendMessage({
      type: 'TEST_CONNECTION',
      account: { host: data.host, username: data.username, password: data.password },
    });

    if (result.success) {
      log(`Success! EAS version negotiated: ${result.version}`);
      log(`Supported versions: ${result.versions.join(', ')}`);
      showStatus(`Connected! EAS version: ${result.version}`, 'success');
    } else {
      log(`Error: ${result.error}`);
      if (result.detail) log(`Detail: ${result.detail}`);
      showStatus(`Connection failed: ${result.error}`, 'error');
    }
  } catch (e) {
    log(`Exception: ${e.message}`);
    showStatus(`Error: ${e.message}`, 'error');
  } finally {
    $('btn-test').disabled = false;
  }
});

// ── Add account ───────────────────────────────────────────────────

$('btn-add').addEventListener('click', async () => {
  const data = getFormData();
  const err  = validate(data);
  if (err) { showStatus(err, 'error'); return; }

  showStatus('Adding account…', 'info');
  log(`Adding account ${data.username} on ${data.host}`);
  $('btn-add').disabled = true;

  try {
    const result = await messenger.runtime.sendMessage({ type: 'ADD_ACCOUNT', account: data });
    if (result?.success) {
      log(`Account added (id: ${result.accountId}). Initial sync running in background.`);
      showStatus('Account added! Initial sync is running in the background.', 'success');
      $('password').value = '';
      loadAccounts();
    } else {
      const msg = result?.error || 'Failed to add account';
      log(`Failed: ${msg}`);
      showStatus(msg, 'error');
    }
  } catch (e) {
    log(`Exception: ${e.message}`);
    showStatus(`Error: ${e.message}`, 'error');
  } finally {
    $('btn-add').disabled = false;
  }
});

// Listen for status updates from background (e.g. sync errors during initial sync)
messenger.runtime.onMessage.addListener(msg => {
  if (msg.type === 'STATUS_UPDATE' && msg.status?.error) {
    log(`Sync error (${msg.accountId}): ${msg.status.error}`);
  }
});

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

loadAccounts();
