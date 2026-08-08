/**
 * Autodiscover for Exchange ActiveSync.
 *
 * Two mechanisms, tried in this order:
 *
 *  1. Autodiscover V2 (JSON) — a single unauthenticated GET. Not covered by
 *     any Open Specification, but supported by Exchange 2016+ and Exchange
 *     Online, and by far the cheapest path. Verified working against the
 *     reference server on 2026-08-07.
 *
 *  2. Autodiscover V1 (POX) — the documented POST with the mobilesync schema.
 *     Requires credentials; a 401 on the first attempt is normal.
 *
 * Two traps worth naming, both hit in the reference measurement:
 *
 *  - The apex domain need not exist. In a measured case the bare domain had no
 *    A record at all while its `autodiscover.` host resolved fine. A client
 *    that walks Microsoft's candidate list strictly serially burns a DNS
 *    timeout on step 1. The candidates below are therefore launched with a
 *    200 ms stagger and the first success wins.
 *
 *  - The response nests two different default namespaces: the outer
 *    <Autodiscover> is in .../autodiscover/responseschema/2006, the inner
 *    <Response> switches to .../autodiscover/mobilesync/responseschema/2006.
 *    Parsing is therefore namespace-agnostic: find any <Server> whose <Type>
 *    is MobileSync.
 */

const POX_REQUEST_NS = 'http://schemas.microsoft.com/exchange/autodiscover/mobilesync/requestschema/2006';
const POX_RESPONSE_NS = 'http://schemas.microsoft.com/exchange/autodiscover/mobilesync/responseschema/2006';

const CANDIDATE_STAGGER_MS = 200;
const REQUEST_TIMEOUT_MS   = 15000;
const MAX_REDIRECTS        = 5;

/**
 * Domain part of an SMTP address, or null if the input is not an address.
 *
 * Returning null rather than the whole string matters: a display name that
 * lands in an address field would otherwise be turned into a host name and
 * "discovered" as something like `eas.Florian Wöhrl`.
 */
export function domainOf(email) {
  const value = String(email ?? '').trim();
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return null;
  const domain = value.slice(at + 1).trim().toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : null;
}

/** Pick the first value that actually looks like an SMTP address. */
export function firstAddress(...candidates) {
  return candidates.find(c => domainOf(c)) || null;
}

function basicAuth(username, password) {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `Basic ${btoa(binary)}`;
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

function hostOfUrl(url) {
  try { return new URL(url).host; } catch { return null; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────
// Autodiscover V2 (JSON)
// ─────────────────────────────────────────────────────────────────────

/**
 * @returns {Promise<{url: string, host: string, source: string}|null>}
 */
export async function autodiscoverV2(email, { protocol = 'ActiveSync', log = () => {} } = {}) {
  const domain = domainOf(email);
  if (!domain) { log(`Autodiscover V2: "${email}" is not an email address`); return null; }

  const url = `https://autodiscover.${domain}/autodiscover/autodiscover.json/v1.0/` +
              `${encodeURIComponent(email)}?Protocol=${encodeURIComponent(protocol)}`;

  log(`Autodiscover V2: GET ${url}`);
  const t = withTimeout(REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { method: 'GET', signal: t.signal, redirect: 'follow' });
    if (!resp.ok) { log(`Autodiscover V2: HTTP ${resp.status}`); return null; }

    const body = await resp.text();
    let json;
    try { json = JSON.parse(body); } catch { log('Autodiscover V2: response was not JSON'); return null; }

    if (!json.Url) { log(`Autodiscover V2: no Url in response (${body.slice(0, 120)})`); return null; }
    const host = hostOfUrl(json.Url);
    if (!host) { log(`Autodiscover V2: unparseable Url ${json.Url}`); return null; }

    log(`Autodiscover V2: ${json.Protocol || protocol} → ${json.Url}`);
    return { url: json.Url, host, source: 'autodiscover-v2' };
  } catch (e) {
    log(`Autodiscover V2 failed: ${e.message}`);
    return null;
  } finally {
    t.done();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Autodiscover V1 (POX)
// ─────────────────────────────────────────────────────────────────────

function poxCandidates(domain) {
  // Ordered by likelihood, not by the Microsoft spec order: the
  // autodiscover.<domain> host is the one that actually exists in practice.
  // The mixed-case duplicates are a real quirk — case-sensitive paths on
  // Linux-hosted Autodiscover endpoints.
  return [
    `https://autodiscover.${domain}/autodiscover/autodiscover.xml`,
    `https://${domain}/autodiscover/autodiscover.xml`,
    `https://autodiscover.${domain}/Autodiscover/Autodiscover.xml`,
    `https://${domain}/Autodiscover/Autodiscover.xml`,
  ];
}

function poxBody(email) {
  return `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="${POX_REQUEST_NS}">
  <Request>
    <EMailAddress>${escapeXml(email)}</EMailAddress>
    <AcceptableResponseSchema>${POX_RESPONSE_NS}</AcceptableResponseSchema>
  </Request>
</Autodiscover>`;
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, c => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
  ));
}

/** Namespace-agnostic: every element whose local name is `name`. */
function localElements(root, name) {
  return Array.from(root.getElementsByTagName('*')).filter(
    e => (e.localName || e.nodeName.replace(/^.*:/, '')) === name
  );
}

function localText(parent, name) {
  const el = localElements(parent, name)[0];
  return el ? el.textContent.trim() : null;
}

/**
 * Parse a POX response.
 * @returns {{url}|{redirectAddress}|{redirectUrl}|{error}}
 */
export function parsePoxResponse(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) return { error: 'malformed XML' };

  // <Action><Redirect>other@address</Redirect></Action> → restart with that address
  const redirectAddr = localText(doc.documentElement, 'Redirect');
  if (redirectAddr) return { redirectAddress: redirectAddr };

  const redirectUrl = localText(doc.documentElement, 'RedirectUrl');
  if (redirectUrl) return { redirectUrl };

  // Any <Server> whose <Type> is MobileSync.
  for (const server of localElements(doc.documentElement, 'Server')) {
    const type = localText(server, 'Type');
    if (type && type.toLowerCase() === 'mobilesync') {
      const url = localText(server, 'Url') || localText(server, 'Name');
      if (url) {
        return {
          url,
          displayName:  localText(doc.documentElement, 'DisplayName'),
          emailAddress: localText(doc.documentElement, 'EMailAddress'),
        };
      }
    }
  }

  const errCode = localText(doc.documentElement, 'ErrorCode');
  const errMsg  = localText(doc.documentElement, 'Message');
  if (errCode || errMsg) return { error: `${errCode || '?'}: ${errMsg || 'Autodiscover error'}` };

  return { error: 'no MobileSync server element in response' };
}

async function poxAttempt(url, email, username, password, log) {
  const t = withTimeout(REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type':  'text/xml; charset=utf-8',
        'Authorization': basicAuth(username, password),
        'User-Agent':    'Microsoft Office/16.0',
      },
      body:     poxBody(email),
      signal:   t.signal,
      redirect: 'follow',
    });

    if (resp.status === 401) { log(`POX ${url}: HTTP 401`); return null; }
    if (!resp.ok)            { log(`POX ${url}: HTTP ${resp.status}`); return null; }

    const text   = await resp.text();
    const parsed = parsePoxResponse(text);
    if (parsed.error) { log(`POX ${url}: ${parsed.error}`); return null; }
    return parsed;
  } catch (e) {
    log(`POX ${url}: ${e.message}`);
    return null;
  } finally {
    t.done();
  }
}

/**
 * Run all four POX candidates with a 200 ms stagger; first usable answer wins.
 */
export async function autodiscoverPox(email, username, password, { log = () => {}, depth = 0 } = {}) {
  if (depth > MAX_REDIRECTS) { log('POX: redirect limit reached'); return null; }

  const domain = domainOf(email);
  if (!domain) { log(`POX: "${email}" is not an email address`); return null; }

  const results = await Promise.all(
    poxCandidates(domain).map(async (url, i) => {
      await sleep(i * CANDIDATE_STAGGER_MS);
      return { url, parsed: await poxAttempt(url, email, username, password, log) };
    })
  );

  for (const { parsed } of results) {
    if (!parsed) continue;

    if (parsed.redirectAddress) {
      log(`POX: redirected to address ${parsed.redirectAddress}`);
      return autodiscoverPox(parsed.redirectAddress, username, password, { log, depth: depth + 1 });
    }
    if (parsed.redirectUrl) {
      log(`POX: RedirectUrl ${parsed.redirectUrl}`);
      const redirected = await poxAttempt(parsed.redirectUrl, email, username, password, log);
      if (redirected?.url) {
        const host = hostOfUrl(redirected.url);
        if (host) return { url: redirected.url, host, source: 'autodiscover-pox', ...redirected };
      }
      continue;
    }
    if (parsed.url) {
      const host = hostOfUrl(parsed.url);
      if (host) {
        log(`POX: MobileSync → ${parsed.url}`);
        return { url: parsed.url, host, source: 'autodiscover-pox', ...parsed };
      }
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────

/**
 * Discover the EAS endpoint for an address.
 *
 * @param {string} email
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{url, host, source}|null>}
 */
export async function discover(email, username, password, { log = () => {} } = {}) {
  // Only an address can carry a domain, and only a domain can be discovered.
  // Guessing from anything else produces a nonsense host name that looks like
  // a real result.
  const address = firstAddress(email, username);
  if (!address) {
    throw new Error(
      'Autodiscover needs an email address. Enter the mailbox address in ' +
      '"Username / Email" (or under Advanced, if the login name is not an address).'
    );
  }
  if (address !== email) log(`Using ${address} for discovery`);

  const v2 = await autodiscoverV2(address, { log });
  if (v2) return v2;

  log('Autodiscover V2 gave nothing, falling back to POX');
  const pox = await autodiscoverPox(address, username || address, password, { log });
  if (pox) return pox;

  // Last resort: the conventional guess. Cheap and often right.
  const guess = `eas.${domainOf(address)}`;
  log(`Autodiscover failed; falling back to conventional host ${guess}`);
  return { url: `https://${guess}/Microsoft-Server-ActiveSync`, host: guess, source: 'guess' };
}

// ─────────────────────────────────────────────────────────────────────
// EWS probe
// ─────────────────────────────────────────────────────────────────────

/**
 * Check whether the mailbox is reachable over EWS.
 *
 * This is deliberately part of the setup flow rather than a footnote.
 * Thunderbird has had native Exchange support over EWS since 2024/2025 — a
 * Rust implementation, no add-on required, no WBXML, no device partnership,
 * no ABQ rules, no device quota. If EWS answers for this mailbox, using it is
 * strictly better than this add-on and the user should be told so plainly.
 *
 * @returns {Promise<{available: boolean, url?: string, detail: string}>}
 */
export async function probeEws(email, username, password, { log = () => {} } = {}) {
  const address = firstAddress(email, username);
  const domain  = domainOf(address);
  if (!domain) {
    return { available: false, detail: 'An email address is needed to look for an EWS endpoint.' };
  }

  // Ask Autodiscover where EWS lives rather than guessing.
  //
  // Guessing from the certificate's SAN list is tempting and wrong: in a
  // measured case the certificate listed `ews.<domain>` while that name had no
  // DNS record at all, and the live endpoint sat on `mail.<domain>`. A probe
  // against the SAN name fails with a connection error that reads like an
  // authentication problem.
  const candidates = [];
  const v2 = await autodiscoverV2(address, { protocol: 'Ews', log });
  if (v2?.url) candidates.push(v2.url);
  candidates.push(`https://mail.${domain}/EWS/Exchange.asmx`);
  candidates.push(`https://ews.${domain}/EWS/Exchange.asmx`);

  const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Body>
    <m:GetFolder>
      <m:FolderShape><t:BaseShape>IdOnly</t:BaseShape></m:FolderShape>
      <m:FolderIds><t:DistinguishedFolderId Id="msgfolderroot"/></m:FolderIds>
    </m:GetFolder>
  </soap:Body>
</soap:Envelope>`;

  const seen = new Set();
  let lastFailure = null;

  for (const url of candidates) {
    if (seen.has(url)) continue;
    seen.add(url);

    log(`EWS probe: POST ${url}`);
    const t = withTimeout(REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type':  'text/xml; charset=utf-8',
          'Authorization': basicAuth(username || address, password),
        },
        body:   soap,
        signal: t.signal,
      });

      const text = await resp.text();
      if (resp.ok && /GetFolderResponse/i.test(text)) {
        log('EWS probe: mailbox reachable over EWS');
        return {
          available: true,
          url,
          detail: 'EWS responded successfully. Thunderbird supports Exchange over EWS natively — ' +
                  'a native Exchange account is simpler and more reliable than this add-on. ' +
                  `Endpoint: ${url}`,
        };
      }

      // The distinction that matters is not the status code but whether the
      // server offered a way in at all.
      const challenge = resp.headers.get('WWW-Authenticate') || '';
      log(`EWS probe: HTTP ${resp.status}${challenge ? ` (WWW-Authenticate: ${challenge})` : ' (no challenge)'}`);

      let detail;
      if (resp.status === 401 && /basic/i.test(challenge)) {
        detail = 'EWS offers Basic authentication but rejected these credentials — check the ' +
                 'user name form and password.';
      } else if (resp.status === 401) {
        detail = challenge
          ? `EWS only offers ${challenge.split(',')[0].trim()} authentication. Thunderbird's EWS ` +
            'client speaks Basic and OAuth 2.0 only, so EWS is not usable here.'
          : 'EWS rejected the request with HTTP 401 and no authentication challenge.';
      } else if (resp.status === 403) {
        detail = 'EWS answered HTTP 403 without an authentication challenge — that is a refusal, ' +
                 'not a failed login. The EWS virtual directory is blocked for this mailbox or ' +
                 'organisation, and no client-side setting will change that.';
      } else {
        detail = `EWS answered HTTP ${resp.status}; not usable for this mailbox.`;
      }

      lastFailure = { available: false, url, status: resp.status, challenge, detail };
    } catch (e) {
      log(`EWS probe: ${url} — ${e.message}`);
      lastFailure ??= {
        available: false, url,
        detail: `EWS not reachable at ${url}: ${e.message}`,
      };
    } finally {
      t.done();
    }
  }

  return lastFailure || {
    available: false,
    detail: 'No EWS endpoint could be reached for this domain.',
  };
}
