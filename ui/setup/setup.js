/**
 * Account setup page.
 *
 * Every network operation is routed through the background script so it runs
 * in the privileged extension context with the host permissions.
 */

const $ = id => document.getElementById(id);

const send = msg => messenger.runtime.sendMessage(msg);

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showStatus(message, type = 'info') {
  const el = $('status-msg');
  el.textContent = message;
  el.className = `status-msg ${type}`;
  el.style.display = '';
}

function log(line) {
  const box = $('debug-log');
  box.style.display = '';
  box.textContent += `[${new Date().toISOString().slice(11, 19)}] ${line}\n`;
  box.scrollTop = box.scrollHeight;
}

function busy(id, on, label) {
  const btn = $(id);
  btn.disabled = on;
  if (label) btn.dataset.label ||= btn.textContent;
  btn.textContent = on ? (label || btn.textContent) : (btn.dataset.label || btn.textContent);
}

// ── Profiles ────────────────────────────────────────────────────────

let PROFILES = [];

async function loadProfiles() {
  PROFILES = await send({ type: 'GET_PROFILES' }) || [];
  const select = $('device-profile');
  select.innerHTML = '';

  for (const profile of PROFILES) {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = profile.label;
    select.appendChild(option);
  }
  const custom = document.createElement('option');
  custom.value = 'Custom';
  custom.textContent = 'Custom…';
  select.appendChild(custom);

  updateProfileHint();
}

/** Last predefined profile the user looked at; the seed for custom fields. */
let lastPredefined = null;

/**
 * Fill empty custom fields from the profile that was selected before.
 *
 * Presenting an empty form invites values that cannot work — a bare DeviceType
 * with no matching User-Agent, or a protocol version no client of that name
 * would negotiate. Seeding from a working profile means the user edits a
 * coherent fingerprint instead of assembling one from nothing. Fields the user
 * has already typed into are never overwritten.
 */
function prefillCustomFields() {
  const seed = lastPredefined || PROFILES.find(p => p.verified) || PROFILES[0];
  if (!seed) return;

  const fill = (id, value) => { if (!$(id).value && value) $(id).value = value; };
  fill('custom-device-type',   seed.deviceType);
  fill('custom-model',         seed.model);
  fill('custom-user-agent',    seed.userAgent);
  fill('custom-os',            seed.os);
  fill('custom-os-language',   seed.osLanguage);
  fill('custom-friendly-name', seed.friendlyName);
  if (seed.maxVersion) $('custom-max-version').value = seed.maxVersion;
}

function updateProfileHint() {
  const id = $('device-profile').value;
  const isCustom = id === 'Custom';
  const profile = PROFILES.find(p => p.id === id);

  if (profile) lastPredefined = profile;

  const section = $('custom-profile-section');
  section.style.display = isCustom ? '' : 'none';
  if (isCustom) {
    prefillCustomFields();
    section.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  $('profile-hint').innerHTML = profile
    ? `<code>DeviceType=${escHtml(profile.deviceType)}</code> · ` +
      `<code>${escHtml(profile.userAgent)}</code> · protocol ${escHtml(profile.maxVersion)}<br>` +
      escHtml(profile.note || '')
    : 'Define the fingerprint yourself — the fields are below.';
}

$('device-profile').addEventListener('change', updateProfileHint);

// ── Capabilities banner ─────────────────────────────────────────────

async function loadCapabilities() {
  const caps = await send({ type: 'GET_CAPABILITIES' });
  const el = $('capabilities');

  if (caps?.codePageErrors?.length) {
    el.className = 'status-msg error';
    el.textContent = `WBXML code page tables are inconsistent: ${caps.codePageErrors.join('; ')}`;
    return;
  }

  if (caps?.privileged) {
    el.className = 'status-msg success';
    el.textContent = 'Privileged build active: accounts get their own top-level node in the folder ' +
      'pane, special folders are tagged, and passwords are stored in Thunderbird\'s password manager.';
  } else {
    el.className = 'status-msg warn';
    el.textContent = 'Standard build: mail is filed under Local Folders and the password is kept in ' +
      'extension storage. Install the privileged build for a real account node and password-manager storage.';
  }
}

// ── Account list ────────────────────────────────────────────────────

async function loadAccounts() {
  const accounts = await send({ type: 'GET_ACCOUNTS' }) || [];
  const list = $('account-list');

  [...list.children].forEach(child => { if (child.id !== 'accounts-empty') child.remove(); });
  $('accounts-empty').style.display = accounts.length ? 'none' : '';

  for (const account of accounts) {
    const profile = PROFILES.find(p => p.id === account.deviceProfileId);
    const item = document.createElement('li');
    item.className = 'account-item';
    item.innerHTML = `
      <div>
        <div class="account-name">${escHtml(account.email || account.username)}</div>
        <div class="account-meta">
          ${escHtml(account.host)} · ${escHtml(profile?.deviceType || account.deviceProfileId)}
          · protocol ${escHtml(account.easVersion || '—')}
          · device ${escHtml(account.deviceId || '—')}
        </div>
      </div>
      <button class="btn-remove" data-id="${escHtml(account.id)}">Remove</button>
    `;
    list.appendChild(item);
  }

  list.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', () => removeAccount(btn.dataset.id));
  });
}

// ── Leftover Thunderbird account nodes ──────────────────────────────

async function loadOrphans() {
  const result = await send({ type: 'LIST_TB_ACCOUNTS' });
  const card = $('orphans-card');
  const list = $('orphan-list');

  const orphans = (result?.accounts || []).filter(a => a.orphaned);
  if (!result?.supported || orphans.length === 0) {
    card.style.display = 'none';
    return;
  }

  card.style.display = '';
  list.innerHTML = '';

  for (const node of orphans) {
    const item = document.createElement('li');
    item.className = 'account-item';
    item.innerHTML = `
      <div>
        <div class="account-name">${escHtml(node.name || node.hostname || node.accountKey)}</div>
        <div class="account-meta">
          ${escHtml(node.accountKey)}
          ${node.hostname ? ` · ${escHtml(node.hostname)}` : ''}
          ${node.identityCount ? '' : ' · no identity'}
        </div>
      </div>
      <button class="btn-remove" data-key="${escHtml(node.accountKey)}">Delete node</button>
    `;
    list.appendChild(item);
  }

  list.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', () => removeOrphan(btn.dataset.key));
  });
}

async function removeOrphan(accountKey) {
  if (!confirm('Delete this account node and the mail files stored in it? This cannot be undone.')) return;
  const result = await send({ type: 'REMOVE_TB_ACCOUNT', accountKey });
  if (result?.success) {
    showStatus('Account node deleted.', 'success');
  } else {
    showStatus(`Could not delete the node: ${result?.error || 'unknown error'}`, 'error');
  }
  await loadOrphans();
  await loadAccounts();
}

async function removeAccount(id) {
  if (!confirm('Remove this EAS account? Messages already synced stay in Thunderbird, and the ' +
               'device partnership on the server is not deleted — remove it in OWA if you no ' +
               'longer need it.')) return;
  await send({ type: 'REMOVE_ACCOUNT', accountId: id });
  await loadAccounts();
  await loadOrphans();
}

// ── Form ────────────────────────────────────────────────────────────

function looksLikeAddress(value) {
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(String(value || '').trim());
}

function formData() {
  const profileId = $('device-profile').value;
  const username  = $('username').value.trim();
  const mailbox   = $('mailbox-address').value.trim();

  const data = {
    host:            $('host').value.trim().replace(/^https?:\/\//i, '').split('/')[0],
    username,
    email:           mailbox || username,
    fullName:        $('display-name').value.trim(),
    password:        $('password').value,
    deviceProfileId: profileId,
    syncInterval:    parseInt($('sync-interval').value, 10) || 5,
    filterType:      parseInt($('filter-type').value, 10) || 0,
    authEncoding:    $('auth-encoding').value,
    push:            $('push').value === 'yes',
  };

  if (profileId === 'Custom') {
    data.customProfile = {
      deviceType:   $('custom-device-type').value.trim(),
      userAgent:    $('custom-user-agent').value.trim(),
      model:        $('custom-model').value.trim(),
      os:           $('custom-os').value.trim(),
      osLanguage:   $('custom-os-language').value.trim(),
      friendlyName: $('custom-friendly-name').value.trim() || 'Thunderbird EAS',
      maxVersion:   $('custom-max-version').value,
      windowSize:   100,
      sendSettings: true,
    };
  }
  return data;
}

/**
 * Clear the form after an account has been created.
 *
 * Leaving the values in place invites a second press of Add Account, and that
 * is not a harmless no-op: it would create another account with a fresh
 * DeviceId, which Exchange registers as an additional device against a quota
 * that is commonly five. The duplicate check in the background script refuses
 * it, but the form should not suggest the action in the first place.
 */
function resetForm() {
  for (const id of ['username', 'display-name', 'password', 'host', 'mailbox-address',
                    'custom-device-type', 'custom-model', 'custom-user-agent',
                    'custom-os', 'custom-os-language', 'custom-friendly-name']) {
    $(id).value = '';
  }
  $('device-profile').selectedIndex = 0;
  $('sync-interval').value = '5';
  $('filter-type').value = '0';
  $('auth-encoding').value = 'utf-8';
  $('push').value = 'yes';

  document.querySelector('details.advanced').open = false;
  $('probe-result').innerHTML = '';
  updateProfileHint();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function validate(data, { requireHost = true, requireAddress = false } = {}) {
  if (!data.username) return 'Username is required';
  if (!data.password) return 'Password is required';

  const mailbox = $('mailbox-address').value.trim();
  if (mailbox && !looksLikeAddress(mailbox)) {
    return `"${mailbox}" is not an email address. The Mailbox address field under Advanced takes ` +
           'an address like user@domain.org — your name goes in "Your Name".';
  }
  // Autodiscover derives the domain from an address; without one it can only
  // invent a host name that looks like a result.
  if (requireAddress && !looksLikeAddress(data.email) && !looksLikeAddress(data.username)) {
    return 'Autodiscover needs an email address. Put the mailbox address in "Username / Email", ' +
           'or fill in "Mailbox address" under Advanced.';
  }

  if (requireHost && !data.host) return 'Server address is required — use "Find server" to look it up';
  if (data.deviceProfileId === 'Custom') {
    if (!data.customProfile.deviceType) return 'Device Type is required for a custom profile';
    if (!data.customProfile.model)      return 'Device Model is required for a custom profile';
    if (!data.customProfile.userAgent)  return 'User-Agent is required for a custom profile';
  }
  return null;
}

// ── Autodiscover ────────────────────────────────────────────────────

$('btn-autodiscover').addEventListener('click', async () => {
  const data = formData();
  const err = validate(data, { requireHost: false, requireAddress: true });
  if (err) return showStatus(err, 'error');

  busy('btn-autodiscover', true, 'Searching…');
  showStatus('Running Autodiscover…', 'info');
  try {
    const result = await send({ type: 'AUTODISCOVER', account: data });
    (result.log || []).forEach(log);

    if (result.success && result.host) {
      $('host').value = result.host;
      const viaGuess = result.source === 'guess';
      showStatus(
        viaGuess
          ? `Autodiscover found nothing; guessed ${result.host}. Test the connection before adding.`
          : `Found ${result.host} via ${result.source}.`,
        viaGuess ? 'warn' : 'success'
      );
    } else {
      showStatus(`Autodiscover failed: ${result.error || 'no server found'}`, 'error');
    }
  } catch (e) {
    showStatus(`Autodiscover error: ${e.message}`, 'error');
  } finally {
    busy('btn-autodiscover', false);
  }
});

// ── EWS check ───────────────────────────────────────────────────────

$('btn-ews').addEventListener('click', async () => {
  const data = formData();
  const err = validate(data, { requireHost: false, requireAddress: true });
  if (err) return showStatus(err, 'error');

  busy('btn-ews', true, 'Checking…');
  showStatus('Checking whether this mailbox is reachable over EWS…', 'info');
  try {
    const result = await send({ type: 'PROBE_EWS', account: data });
    (result.log || []).forEach(log);
    showStatus(result.detail, result.available ? 'warn' : 'info');
  } catch (e) {
    showStatus(`EWS check failed: ${e.message}`, 'error');
  } finally {
    busy('btn-ews', false);
  }
});

// ── Fingerprint probe ───────────────────────────────────────────────

$('btn-probe').addEventListener('click', async () => {
  const data = formData();
  const err = validate(data);
  if (err) return showStatus(err, 'error');

  if (!confirm('This sends one FolderSync per device profile. Exchange may register a device ' +
               'partnership for each DeviceType it accepts, which counts against the mailbox ' +
               'device quota. Continue?')) return;

  busy('btn-probe', true, 'Probing…');
  showStatus('Comparing device fingerprints…', 'info');
  try {
    const result = await send({ type: 'PROBE_PROFILES', account: data });
    if (!result.success) {
      showStatus(`Probe failed: ${result.error}`, 'error');
      return;
    }

    const rows = result.results.map(r => `
      <tr>
        <td>${escHtml(r.deviceType)}</td>
        <td>${escHtml(r.version)}</td>
        <td>${escHtml(r.http ?? '—')}</td>
        <td class="${/accepted/.test(r.verdict) ? 'ok' : 'bad'}">${escHtml(r.verdict)}</td>
      </tr>`).join('');

    $('probe-result').innerHTML = `
      <table class="probe">
        <tr><th>DeviceType</th><th>Version</th><th>HTTP</th><th>Result</th></tr>
        ${rows}
      </table>
      <div class="hint">DeviceId used for all variants: <code>${escHtml(result.deviceId)}</code></div>`;

    const accepted = result.results.filter(r => /accepted/.test(r.verdict));
    showStatus(
      accepted.length
        ? `${accepted.length} of ${result.results.length} profiles accepted. Pick one of them above.`
        : 'No profile was accepted. That points at the credentials, or at an exhausted device ' +
          'quota rather than the fingerprint — check OWA → Options → Phone → Mobile Devices.',
      accepted.length ? 'success' : 'error'
    );
  } catch (e) {
    showStatus(`Probe error: ${e.message}`, 'error');
  } finally {
    busy('btn-probe', false);
  }
});

// ── Test / Add ──────────────────────────────────────────────────────

$('btn-test').addEventListener('click', async () => {
  const data = formData();
  const err = validate(data);
  if (err) return showStatus(err, 'error');

  busy('btn-test', true, 'Testing…');
  showStatus('Testing connection…', 'info');
  log(`OPTIONS https://${data.host}/Microsoft-Server-ActiveSync`);

  try {
    const result = await send({ type: 'TEST_CONNECTION', account: data });
    if (result.success) {
      log(`server: ${result.server || 'unknown'}`);
      log(`advertised: ${result.versions.join(', ') || '(none)'}`);
      log(`negotiated: ${result.version} as ${result.deviceType}`);
      if (result.commands?.length) log(`commands: ${result.commands.join(', ')}`);
      showStatus(`Connected. Protocol ${result.version} as ${result.deviceType}.` +
                 (result.note ? ` (${result.note})` : ''), 'success');
    } else {
      log(`error [${result.code || '?'}]: ${result.error}`);
      if (result.detail?.body) log(`body: ${result.detail.body.slice(0, 300)}`);
      showStatus(result.error, 'error');
    }
  } catch (e) {
    showStatus(`Error: ${e.message}`, 'error');
  } finally {
    busy('btn-test', false);
  }
});

$('btn-add').addEventListener('click', async () => {
  const data = formData();
  const err = validate(data);
  if (err) return showStatus(err, 'error');

  busy('btn-add', true, 'Adding…');
  showStatus('Adding account…', 'info');
  try {
    const result = await send({ type: 'ADD_ACCOUNT', account: data });
    if (result?.success) {
      log(`account added (${result.accountId}); initial sync running`);
      resetForm();
      showStatus('Account added. The initial sync is running in the background — ' +
                 'watch the account list above and the log below.', 'success');
      await loadAccounts();
      await loadOrphans();
    } else {
      showStatus(result?.error || 'Failed to add account', 'error');
    }
  } catch (e) {
    showStatus(`Error: ${e.message}`, 'error');
  } finally {
    busy('btn-add', false);
  }
});

// ── Live status ─────────────────────────────────────────────────────

messenger.runtime.onMessage.addListener(msg => {
  if (msg.type === 'STATUS_UPDATE' && msg.status?.error) {
    log(`sync error (${msg.accountId}): ${msg.status.error}`);
  }
});

(async function init() {
  await loadProfiles();
  await loadCapabilities();
  await loadAccounts();
  await loadOrphans();
})();
