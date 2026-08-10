/**
 * EAS protocol constants, status codes and device profiles.
 *
 * The WBXML code page tables live in ./codepages.js — they are re-exported
 * here so existing imports keep working.
 */

export {
  CODE_PAGES, PAGE_NAMES, PAGE_BY_NAME, FIRST_TOKEN,
  lookupTag, encodeTag, pageIndex, verifyCodePages, TABLE_ANCHORS,
} from './codepages.js';

export const EAS_PATH = '/Microsoft-Server-ActiveSync';

/**
 * Protocol versions we are willing to speak, most preferred first.
 *
 * 14.1 leads deliberately. Our Sync/Calendar handling implements 14.x
 * semantics; 16.x changed recurrence exceptions (InstanceId), the calendar
 * workflow and draft handling, so negotiating 16.1 would produce requests we
 * cannot correctly interpret. EAS-4-TbSync makes the same choice for the same
 * reason. 16.1 is only required for Exchange Online, which also mandates
 * OAuth 2.0 and therefore cannot be reached with Basic auth anyway.
 */
export const VERSION_PREFERENCE = ['14.1', '14.0', '12.1', '12.0'];

/** Versions a server may advertise that are not valid client versions. */
export const INVALID_CLIENT_VERSIONS = ['2.0', '2.1'];

export const DEFAULT_VERSION = '14.1';

/** Numeric form for comparisons: '14.1' → 141 */
export function versionValue(v) {
  const [major, minor = '0'] = String(v).split('.');
  return parseInt(major, 10) * 10 + parseInt(minor, 10);
}

export const MIME_WBXML  = 'application/vnd.ms-sync.wbxml';
export const MIME_RFC822 = 'message/rfc822';

// ── EAS folder types (MS-ASCMD FolderSync Type) ──────────────────────

export const FOLDER_TYPE = {
  USER_GENERIC:  1,
  INBOX:         2,
  DRAFTS:        3,
  DELETED:       4,
  SENT:          5,
  OUTBOX:        6,
  TASKS:         7,
  CALENDAR:      8,
  CONTACTS:      9,
  NOTES:        10,
  JOURNAL:      11,
  USER_MAIL:    12,
  USER_CALENDAR:13,
  USER_CONTACTS:14,
  USER_TASKS:   15,
  USER_JOURNAL: 16,
  USER_NOTES:   17,
  UNKNOWN:      18,
  RECIPIENT_CACHE: 19,
};

/** EAS folder type → Thunderbird special-folder role. */
export const FOLDER_ROLE = {
  [FOLDER_TYPE.INBOX]:   'inbox',
  [FOLDER_TYPE.DRAFTS]:  'drafts',
  [FOLDER_TYPE.DELETED]: 'trash',
  [FOLDER_TYPE.SENT]:    'sent',
  [FOLDER_TYPE.OUTBOX]:  'outbox',
  [FOLDER_TYPE.JOURNAL]: 'archives',
};

export const FOLDER_TYPE_NAME = {
  [FOLDER_TYPE.INBOX]:   'Inbox',
  [FOLDER_TYPE.DRAFTS]:  'Drafts',
  [FOLDER_TYPE.DELETED]: 'Trash',
  [FOLDER_TYPE.SENT]:    'Sent',
  [FOLDER_TYPE.OUTBOX]:  'Outbox',
};

/** Folder types we mirror into Thunderbird's mail tree. */
export const MAIL_FOLDER_TYPES = new Set([
  FOLDER_TYPE.USER_GENERIC, FOLDER_TYPE.INBOX, FOLDER_TYPE.DRAFTS,
  FOLDER_TYPE.DELETED, FOLDER_TYPE.SENT, FOLDER_TYPE.OUTBOX,
  FOLDER_TYPE.USER_MAIL,
]);

// ── Body types (MS-ASAIRS) ───────────────────────────────────────────

export const BODY_TYPE = { PLAIN: 1, HTML: 2, RTF: 3, MIME: 4 };

/** Sync/Options/MIMESupport values. */
export const MIME_SUPPORT = { NEVER: 0, SMIME_ONLY: 1, ALWAYS: 2 };

// ── Status codes ─────────────────────────────────────────────────────

/**
 * MS-ASCMD common status codes that matter to us. From 14.0 onwards almost
 * every error arrives as a WBXML <Status> inside an HTTP 200 response — a
 * client that only inspects HTTP status codes sees "200 OK" and an empty
 * mailbox.
 */
export const STATUS = {
  SUCCESS:                    '1',
  INVALID_SYNC_KEY:           '3',
  INVALID_CONTENT:            '101',
  INVALID_WBXML:              '102',
  INVALID_MIME:               '107',
  PROTOCOL_ERROR:             '4',
  SERVER_ERROR:               '5',
  SYNC_STATE_CORRUPT:         '9',
  FOLDER_HIERARCHY_CHANGED:   '12',
  USER_DISABLED_FOR_SYNC:     '126',
  DEVICE_BLOCKED:             '129', // DeviceIsBlockedForThisUser
  ACCESS_DENIED:              '130',
  SYNC_STATE_NOT_FOUND:       '131',
  REMOTE_WIPE_REQUESTED:      '140',
  DEVICE_NOT_PROVISIONABLE:   '141',
  DEVICE_NOT_PROVISIONED:     '142',
  POLICY_REFRESH:             '143',
  INVALID_POLICY_KEY:         '144',
  EXTERNALLY_MANAGED:         '145',
  // 165 is DeviceInformationRequired, NOT a quarantine signal. Earlier notes in
  // this project recorded it as "device quarantined" because a quarantine mail
  // happened to arrive at the same time, and a whole error path was built
  // around that misreading. From 14.1 the server expects
  // Settings/DeviceInformation inside the Provision request itself; omit it and
  // Exchange answers 165 before any policy is issued.
  DEVICE_INFORMATION_REQUIRED: '165',
  MAX_DEVICES_REACHED:        '177',
};

/**
 * Names for the status codes that actually turn up in logs. A bare
 * "status 102" tells nobody anything; "102 (InvalidWBXML)" points straight at
 * the encoder.
 */
export const STATUS_NAMES = {
  '101': 'InvalidContent',
  '102': 'InvalidWBXML',
  '103': 'InvalidXML',
  '104': 'InvalidDateTime',
  '105': 'InvalidCombinationOfIDs',
  '106': 'InvalidIDs',
  '107': 'InvalidMIME',
  '108': 'DeviceIdMissingOrInvalid',
  '109': 'DeviceTypeMissingOrInvalid',
  '110': 'ServerError',
  '111': 'ServerErrorRetryLater',
  '112': 'ActiveDirectoryAccessDenied',
  '113': 'MailboxQuotaExceeded',
  '115': 'SendQuotaExceeded',
  '116': 'MessageRecipientUnresolved',
  '117': 'MessageReplyNotAllowed',
  '118': 'MessagePreviouslySent',
  '119': 'MessageHasNoRecipient',
  '120': 'MailSubmissionFailed',
  '121': 'MessageReplyFailed',
  '122': 'AttachmentIsTooLarge',
  '126': 'UserDisabledForSync',
  '129': 'DeviceIsBlockedForThisUser',
  '130': 'AccessDenied',
  '137': 'CommandNotSupported',
  '138': 'VersionNotSupported',
  '140': 'RemoteWipeRequested',
  '141': 'DeviceNotProvisionable',
  '142': 'DeviceNotProvisioned',
  '143': 'PolicyRefresh',
  '144': 'InvalidPolicyKey',
  '145': 'ExternallyManagedDevicesNotAllowed',
  '164': 'BodyPartPreferenceTypeNotSupported',
  '165': 'DeviceInformationRequired',
  '177': 'MaximumDevicesReached',
};

export function describeStatus(status) {
  const name = STATUS_NAMES[String(status)];
  return name ? `${status} (${name})` : String(status);
}

/** Statuses that mean "run the Provision handshake, then retry". */
export const PROVISION_REQUIRED_STATUS = new Set([
  STATUS.DEVICE_NOT_PROVISIONED,
  STATUS.POLICY_REFRESH,
  STATUS.INVALID_POLICY_KEY,
  STATUS.EXTERNALLY_MANAGED,
]);

/**
 * Statuses that mean "the server refuses this device, stop hammering it".
 *
 * Deliberately narrow. A code that lands here silences the account for half an
 * hour, so only values whose meaning is unambiguous belong in this set.
 */
export const DEVICE_BLOCKED_STATUS = new Set([
  STATUS.USER_DISABLED_FOR_SYNC, // ActiveSync switched off for this mailbox
  STATUS.DEVICE_BLOCKED,         // explicit block list
  STATUS.MAX_DEVICES_REACHED,    // device partnership quota exhausted
]);

/** Statuses that mean "throw away the sync key and start the collection over". */
export const SYNC_KEY_INVALID_STATUS = new Set([
  STATUS.INVALID_SYNC_KEY,
  STATUS.SYNC_STATE_CORRUPT,
  STATUS.FOLDER_HIERARCHY_CHANGED,
  STATUS.SYNC_STATE_NOT_FOUND,
]);

/** Ping status codes (MS-ASCMD 2.2.3.177.2). */
export const PING_STATUS = {
  EXPIRED:            '1', // heartbeat elapsed, nothing changed
  CHANGES:            '2', // folders listed in the response have changes
  MISSING_PARAMETERS: '3',
  SYNTAX_ERROR:       '4',
  INVALID_HEARTBEAT:  '5', // response carries <Limit> = allowed value
  TOO_MANY_FOLDERS:   '6', // response carries <Limit> = MaxFolders
  HIERARCHY_STALE:    '7',
  SERVER_ERROR:       '8',
};

// ── Heartbeat / Ping tuning ──────────────────────────────────────────

export const HEARTBEAT = {
  INITIAL: 8 * 60,   // seconds — conservative start, see MS guidance
  MIN:     3 * 60,
  MAX:     59 * 60,
  STEP_UP: 2 * 60,   // grow slowly after a clean heartbeat
};

// ── Device profiles ──────────────────────────────────────────────────

/**
 * A profile is the client's fingerprint on the wire: DeviceType, User-Agent,
 * protocol version and the Settings/DeviceInformation payload.
 *
 * Two things make this more than cosmetics:
 *
 * 1. Exchange may run an Allow/Block/Quarantine (ABQ) rule keyed on
 *    DeviceType and User-Agent, and it enforces a per-mailbox limit on device
 *    partnerships (commonly 5). A measurement against a production Exchange
 *    2019 on 2026-08-07 returned HTTP 200 for `WindowsOutlook15` and
 *    `iPhone`, and HTTP 403 for `Android` and `TBSync`. Whether that was an
 *    ABQ rule or an exhausted device quota was not resolved — a device-limit
 *    notification arrived during the run. Either way a well-known DeviceType
 *    is the safer choice.
 *
 * 2. Servers switch behaviour on the DeviceType string. Presenting as
 *    `WindowsOutlook15` gets you longer allowed response times and large sync
 *    batches, but also single-contact-folder handling and no Notes sync. It
 *    also implies protocol version 14.0 — a client calling itself
 *    WindowsOutlook15 while asking for 16.1 is a fingerprint that does not
 *    exist in the wild.
 *
 * `maxVersion` therefore caps negotiation per profile.
 *
 * IMPORTANT for the user-facing UI: Exchange keys a device partnership on
 * DeviceId **and** DeviceType. Switching profiles registers a *new* device and
 * consumes another slot of the mailbox quota — the old entry has to be removed
 * in OWA manually.
 */
export const DEVICE_PROFILES = [
  {
    id:           'Thunderbird',
    label:        'Thunderbird — honest fingerprint (recommended)',
    deviceType:   'Thunderbird',
    // Deliberately carries no Thunderbird version. MS-ASHTTP allows a server to
    // track the User-Agent across requests and block a device that changes it
    // too often, and a Thunderbird version string changes with every update.
    // The number here is this client's own, bumped only when its behaviour on
    // the wire changes. The running Thunderbird version is reported through
    // Settings/DeviceInformation instead, where it is display metadata and
    // changing it is expected.
    userAgent:    'Thunderbird-EAS/1.0',
    model:        'Thunderbird',
    os:           '',        // filled at runtime
    osLanguage:   '',        // filled at runtime
    friendlyName: 'Thunderbird',
    maxVersion:   '14.1',
    windowSize:   100,
    sendSettings: true,
    verified:     true,
    note:         'Says what it is. Accepted by the reference Exchange 2019. Switch to an ' +
                  'imitation profile only if the server rejects unknown clients with HTTP 403.',
  },
  {
    id:           'WindowsOutlook15',
    label:        'Outlook Desktop (Windows) — imitation, accepted fallback',
    deviceType:   'WindowsOutlook15',
    userAgent:    'Outlook/16.0 (16.0.17932.20884; C2R; x64)',
    model:        'WindowsOutlook15',
    os:           '',        // real Outlook sends neither OS nor OSLanguage
    osLanguage:   '',
    friendlyName: 'Outlook',
    maxVersion:   '14.0',    // Outlook's EAS stack negotiates exactly 14.0
    windowSize:   512,       // Z-Push: "MS Outlook 2013+ request up to 512 items"
    sendSettings: false,     // Outlook does not send Settings/DeviceInformation
    verified:     true,
    note:         'Closest match to a real Outlook desktop client. Use this if the server rejects other device types.',
  },
  {
    id:           'iPhone',
    label:        'iPhone (iOS Mail) — imitation, accepted fallback',
    deviceType:   'iPhone',
    userAgent:    'Apple-iPhone14C1/2011.223',
    model:        'iPhone',
    os:           'iOS 17.4.1',
    osLanguage:   'en-US',
    friendlyName: 'iPhone',
    maxVersion:   '14.1',
    windowSize:   100,
    sendSettings: true,
    verified:     true,
    note:         'Second imitation fingerprint accepted by the reference server.',
  },
  {
    id:           'Android',
    label:        'Android Mail (Samsung) — imitation, untested',
    deviceType:   'Android',
    userAgent:    'Android-Mail/2026.03.09.884664556.Release',
    model:        'SM-G975F',
    os:           'Android 12',
    osLanguage:   'en-US',
    friendlyName: 'SM-G975F',   // real Android reports the model number here
    maxVersion:   '14.1',
    windowSize:   100,
    sendSettings: true,
    verified:     false,
    // The reference measurement's HTTP 403 for this DeviceType was the
    // exhausted device quota plus status 165, the same conditions that made
    // the honest Thunderbird profile look blocked — so it says nothing about
    // whether the server accepts Android. Real Android devices connect over
    // EAS every day. Not verified against the reference server; a plain,
    // unremarkable device type with no reason to prefer or avoid it.
    note:         'A common, unremarkable device type. Its 403 in the reference measurement was the ' +
                  'device quota, not the DeviceType — the same cause that made the Thunderbird profile ' +
                  'look blocked. Not verified here, but Android clients connect over EAS routinely.',
  },
];

// Honest by default. The imitation profiles exist for servers that only admit
// known clients; presenting as another vendor's product without need would
// misreport this device in every administrator's inventory.
//
// Also the value the migration assigns to accounts stored before profiles
// existed — which is correct, because that build sent DeviceType=Thunderbird
// too. If this constant ever moves again, pin the migration to the literal
// instead: changing an existing account's DeviceType registers a second device
// with the server.
export const DEFAULT_PROFILE_ID = 'Thunderbird';

function _detectOS() {
  const ua = navigator.userAgent;
  if (ua.includes('Windows'))   return 'Windows';
  if (ua.includes('Macintosh')) return 'macOS';
  if (ua.includes('Linux'))     return 'Linux';
  return '';
}

function _detectTBVersion() {
  const m = navigator.userAgent.match(/Thunderbird\/([\d.]+)/i);
  return m ? m[1] : null;
}

/**
 * Resolve the active device profile for an account.
 * Returns the matching predefined profile, or the account's customProfile
 * merged over the default when deviceProfileId === 'Custom'.
 */
export function resolveProfile(account = {}) {
  const base = DEVICE_PROFILES.find(p => p.id === DEFAULT_PROFILE_ID);

  if (account.deviceProfileId === 'Custom' && account.customProfile) {
    return {
      ...base,
      maxVersion: DEFAULT_VERSION,
      verified:   false,
      ...account.customProfile,
      id: 'Custom',
    };
  }

  const profile = DEVICE_PROFILES.find(p => p.id === account.deviceProfileId) || base;

  if (profile.id === 'Thunderbird') {
    // The running version goes into the display metadata, never into the
    // User-Agent: that string has to stay constant for the life of the
    // installation, and Thunderbird's version does not.
    const version = _detectTBVersion();
    const os      = _detectOS();
    return {
      ...profile,
      os:           os || profile.os,
      osLanguage:   navigator.language || '',
      friendlyName: version ? `Thunderbird ${version}` : profile.friendlyName,
    };
  }

  return profile;
}

/** Generate a fresh EAS DeviceId: RFC 4122 v4, uppercase hex, no hyphens. */
export function generateDeviceId() {
  return crypto.randomUUID().replace(/-/g, '').toUpperCase();
}

/**
 * MS-ASHTTP restricts DeviceId to 1..32 characters, ALPHA/DIGIT only.
 * 32 hex characters is exactly the maximum.
 */
export function isValidDeviceId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9]{1,32}$/.test(id);
}
