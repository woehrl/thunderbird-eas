/**
 * EAS WBXML Code Pages (MS-ASWBXML specification)
 * Arrays start at token 0x05; use null for undefined/reserved tokens.
 */

export const CODE_PAGES = [
  // Page 0: AirSync
  ['Sync','Responses','Add','Change','Delete','Fetch','SyncKey','ClientId',
   'ServerId','Status','Collection','Class','Version','Collections','Options',
   'Total','Commands','Get','Add','Delete','Fetch','SyncKey','ClientId',
   'Change','MoreAvailable','WindowSize','PerformanceStats','Partial',
   'ConversationMode','MaxItems','HeartbeatInterval'],

  // Page 1: Contacts
  ['Anniversary','AssistantName','AssistantTelephoneNumber','Birthday',
   'Body','BodySize','BodyTruncated','Business2TelephoneNumber',
   'BusinessAddressCity','BusinessAddressCountry','BusinessAddressPostalCode',
   'BusinessAddressState','BusinessAddressStreet','BusinessFaxNumber',
   'BusinessTelephoneNumber','CarTelephoneNumber','Categories','Category',
   'Children','Child','CompanyName','Department','Email1Address',
   'Email2Address','Email3Address','FileAs','FirstName','Home2TelephoneNumber',
   'HomeAddressCity','HomeAddressCountry','HomeAddressPostalCode',
   'HomeAddressState','HomeAddressStreet','HomeFaxNumber','HomeTelephoneNumber',
   'Alias','WeightedRank'],

  // Page 2: Email
  ['Attachment','Attachments','AttName','AttSize','Att0Id','AttMethod',
   'AttRemoved','Body','BodySize','BodyTruncated','DateReceived','DisplayName',
   'DisplayTo','Importance','MessageClass','Subject','Read','To','Cc','From',
   'Reply_To','AllDayEvent','Categories','Category','DtStamp','EndTime',
   'InstanceType','BusyStatus','Location','MeetingRequest','Organizer',
   'RecurrenceId','Reminder','ResponseRequested','Recurrences','Recurrence',
   'RecurrenceType','Until','Occurrences','Interval','DayOfWeek','DayOfMonth',
   'WeekOfMonth','MonthOfYear','StartTime','Sensitivity','TimeZone',
   'GlobalObjId','ThreadTopic','MIMEData','MIMETruncated','MIMESize',
   'InternetCPID','Flag','Status','ContentClass','FlagType','CompleteTime',
   'DisallowNewTimeProposal'],

  // Page 3: AirNotify (deprecated)
  [],

  // Page 4: Calendar
  ['TimeZone','AllDayEvent','Attendees','Attendee','Email','DisplayName',
   'StartTime','Subject','Body','BodyTruncated','EndTime','Recurrence',
   'Type','Until','Occurrences','Interval','DayOfWeek','DayOfMonth',
   'WeekOfMonth','MonthOfYear','Sensitivity','BusyStatus','AllAttendeesString',
   'MeetingStatus','Reminder','IsLeapmonth','CalendarType','IsRecurring',
   'ResponseRequested','DisallowNewTimeProposal','Uid','OrganizerName',
   'OrganizerEmail'],

  // Page 5: Move
  ['MoveItems','Move','SrcMsgId','SrcFldId','DstFldId','Response','Status','DstMsgId'],

  // Page 6: GetItemEstimate
  ['GetItemEstimate','Version','Collections','Collection','Class',
   'CollectionId','DateTime','Estimate','Response','Status'],

  // Page 7: FolderHierarchy
  ['Folders','Folder','DisplayName','ServerId','ParentId','Type','Response',
   'Status','ContentClass','Changes','Add','Delete','Update','SyncKey',
   'FolderCreate','FolderDelete','FolderUpdate','FolderSync','Count'],

  // Page 8: MeetingResponse
  ['CalendarId','CollectionId','MeetingResponse','RequestId','Request',
   'Result','Status','UserResponse','Version'],

  // Page 9: Tasks
  ['Body','BodySize','BodyTruncated','Categories','Category','Complete',
   'DateCompleted','DueDate','UtcDueDate','Importance','Recurrence',
   'RecurrenceType','RecurrenceStart','Until','Occurrences','Interval',
   'DayOfMonth','DayOfWeek','WeekOfMonth','MonthOfYear','Regenerate',
   'DeadOccur','ReminderSet','ReminderTime','Sensitivity','StartDate',
   'UtcStartDate','Subject','NativeBodyType','ContentClass'],

  // Page 10: ResolveRecipients
  ['ResolveRecipients','Response','Status','Type','Recipient','DisplayName',
   'EmailAddress','Certificates','Certificate','MiniCertificate','Options',
   'To','CertificateRetrieval','RecipientCount','MaxCertificates',
   'MaxAmbiguousRecipients','CertificateCount','Availability','StartTime',
   'EndTime','MergedFreeBusy','Picture','MaxSize','Data','MaxPictures'],

  // Page 11: ValidateCert
  ['ValidateCert','Certificates','Certificate','CertificateChain','CheckCRL','Status'],

  // Page 12: Contacts2
  ['CustomerId','GovernmentId','IMAddress','IMAddress2','IMAddress3',
   'ManagerName','CompanyMainPhone','AccountName','NickName','MMS'],

  // Page 13: Ping
  ['Ping','AutdState','Status','HeartbeatInterval','Folders','Folder','Id','Class','MaxFolders'],

  // Page 14: Provision
  ['Provision','Policies','Policy','PolicyType','PolicyKey','Data','Status',
   'RemoteWipe','EASProvisionDoc','DevicePasswordEnabled',
   'AlphanumericDevicePasswordRequired','RequireStorageCardEncryption',
   'PasswordRecoveryEnabled','DocumentBrowseEnabled','AttachmentsEnabled',
   'MinDevicePasswordLength','MaxInactivityTimeDeviceLock',
   'MaxDevicePasswordFailedAttempts','MaxAttachmentSize',
   'AllowSimpleDevicePassword','DevicePasswordExpiration','DevicePasswordHistory',
   'AllowStorageCard','AllowCamera','RequireDeviceEncryption',
   'AllowUnsignedApplications','AllowUnsignedInstallationPackages',
   'MinDevicePasswordComplexCharacters','AllowWiFi','AllowTextMessaging',
   'AllowPOPIMAPEmail','AllowBluetooth','AllowIrDA',
   'RequireManualSyncWhenRoaming','AllowDesktopSync','MaxCalendarAgeFilter',
   'AllowHTMLEmail','MaxEmailAgeFilter','MaxEmailBodyTruncationSize',
   'MaxEmailHTMLBodyTruncationSize','RequireSignedSMIMEMessages',
   'RequireEncryptedSMIMEMessages','RequireSignedSMIMEAlgorithm',
   'RequireEncryptionSMIMEAlgorithm','AllowSMIMEEncryptionAlgorithmNegotiation',
   'AllowSMIMESoftCerts','AllowBrowser','AllowConsumerEmail','AllowRemoteDesktop',
   'AllowInternetSharing','UnapprovedInROMApplicationList','ApplicationName',
   'ApprovedApplicationList','HashAlgorithm'],

  // Page 15: Search
  ['Search','Stores','Store','Name','Query','Options','Range','Status',
   'Response','Result','Properties','Total','EqualTo','Value','And','Or',
   'FreeText', null,'DeepTraversal','LongId','RebuildResults','LessThan',
   'GreaterThan', null,'UserName','Password','ConversationId','Picture',
   'MaxSize','MaxPictures'],

  // Page 16: GAL
  ['DisplayName','Phone','Office','Title','Company','Alias','FirstName',
   'LastName','HomePhone','MobilePhone','EmailAddress','Picture','Status','Data'],

  // Page 17: AirSyncBase
  ['BodyPreference','Type','TruncationSize','AllOrNone', null,
   'Body','Data','EstimatedDataSize','Truncated','Attachments','Attachment',
   'DisplayName','FileReference','Method','ContentId','ContentLocation',
   'IsInline','NativeBodyType','ContentType','Preview','BodyPartReference',
   'BodyPart','Status'],

  // Page 18: Settings
  ['Settings','Status','Get','Set','Oof','OofState','StartTime','EndTime',
   'OofMessage','AppliesToInternal','AppliesToExternalKnown',
   'AppliesToExternalUnknown','Enabled','ReplyMessage','BodyType','Data',
   'DevicePassword','Password','DeviceInformation','Model','IMEI','FriendlyName',
   'OS','OSLanguage','PhoneNumber','UserInformation','EmailAddresses',
   'SmimeEnabled','UserAgent','EnableOutboundSMS','MobileOperator',
   'PrimarySmtpAddress','Accounts','Account','AccountId','AccountName',
   'UserDisplayName','SendDisabled', null,'RightsManagementInformation'],

  // Page 19: DocumentLibrary
  ['LinkId','DisplayName','IsFolder','CreationDate','LastModifiedDate',
   'IsHidden','ContentLength','ContentType'],

  // Page 20: ItemOperations
  ['ItemOperations','Fetch','Store','Options','Range','Total','Properties',
   'Data','Status','Response','Version','Schema','Part','EmptyFolderContents',
   'DeleteSubFolders','UserName','Password','Move','DstFldId','ConversationId',
   'MoveAlways'],

  // Page 21: ComposeMail
  ['SendMail','SmartForward','SmartReply','SaveInSentItems','ReplaceMime',
   null,'Source','FolderId','ItemId','LongId','InstanceId','MIME',
   'ClientId','Status','AccountId'],

  // Page 22: Email2
  ['UmCallerId','UmUserNotes','UmAttDuration','UmAttOrder','ConversationId',
   'ConversationIndex','LastVerbExecuted','LastVerbExecutionTime','ReceivedAsBcc',
   'Sender','CalendarType','IsLeapMonth','AccountId','FirstDayOfWeek',
   'MeetingMessageType', null,'IsDraft','Bcc','Send'],
];

/**
 * Reverse lookup: namespace:tagName -> {page, token}
 * Built lazily on first use.
 */
let _reverseMap = null;

function getReverseMap() {
  if (_reverseMap) return _reverseMap;
  _reverseMap = new Map();
  for (let page = 0; page < CODE_PAGES.length; page++) {
    const tags = CODE_PAGES[page];
    if (!tags || !tags.length) continue;
    for (let i = 0; i < tags.length; i++) {
      const name = tags[i];
      if (!name) continue;
      const key = `${page}:${name}`;
      // Only register first occurrence (avoid duplicate overwrite)
      if (!_reverseMap.has(key)) {
        _reverseMap.set(key, { page, token: i + 0x05 });
      }
    }
  }
  return _reverseMap;
}

export const PAGE_NAMES = [
  'AirSync', 'Contacts', 'Email', 'AirNotify', 'Calendar', 'Move',
  'GetItemEstimate', 'FolderHierarchy', 'MeetingResponse', 'Tasks',
  'ResolveRecipients', 'ValidateCert', 'Contacts2', 'Ping', 'Provision',
  'Search', 'GAL', 'AirSyncBase', 'Settings', 'DocumentLibrary',
  'ItemOperations', 'ComposeMail', 'Email2',
];

export const PAGE_BY_NAME = Object.fromEntries(PAGE_NAMES.map((n, i) => [n, i]));

export function lookupTag(pageIndex, token) {
  const tags = CODE_PAGES[pageIndex];
  if (!tags) return null;
  return tags[token - 0x05] || null;
}

export function encodeTag(pageIndex, tagName) {
  const map = getReverseMap();
  return map.get(`${pageIndex}:${tagName}`) || null;
}

// EAS Folder Types
export const FOLDER_TYPE = {
  USER_GENERIC: 1,
  INBOX: 2,
  DRAFTS: 3,
  DELETED: 4,
  SENT: 5,
  OUTBOX: 6,
  TASKS: 7,
  CALENDAR: 8,
  CONTACTS: 9,
  NOTES: 10,
  JOURNAL: 11,
  USER_MAIL: 12,
  USER_CALENDAR: 13,
  USER_CONTACTS: 14,
  USER_TASKS: 15,
  UNKNOWN: 18,
};

export const FOLDER_TYPE_NAME = {
  2: 'Inbox', 3: 'Drafts', 4: 'Trash', 5: 'Sent', 6: 'Outbox',
};

// EAS body type preferences
export const BODY_TYPE = { PLAIN: 1, HTML: 2, RTF: 3, MIME: 4 };

// EAS protocol version we negotiate
export const EAS_VERSION = '14.1';
export const DEVICE_TYPE = 'iPhone';
export const USER_AGENT = 'Apple-iPhone/702.67 (EAS Thunderbird Connector)';

/**
 * Predefined device profiles that the user can choose from.
 * Matching a profile already approved by the Exchange admin avoids the
 * new-device quarantine period.
 */
export const DEVICE_PROFILES = [
  {
    id:          'iPhone',
    label:       'iPhone (Thunderbird EAS)',
    deviceType:  'iPhone',
    userAgent:   'Apple-iPhone/702.67 (EAS Thunderbird Connector)',
    model:       'iPhone',
    os:          '',
    friendlyName:'Thunderbird EAS',
  },
  {
    id:          'WindowsOutlook15',
    label:       'Outlook 2016 (Windows)',
    deviceType:  'WindowsOutlook15',
    userAgent:   'Outlook/16.0 (16.0.19426.20076; x86)',
    model:       'WindowsOutlook15',
    os:          '',
    friendlyName:'Outlook',
  },
  {
    id:          'Android',
    label:       'Android Mail (Samsung)',
    deviceType:  'Android',
    userAgent:   'Android-Mail/2026.03.09.884664556.Release',
    model:       'SM-G975F',
    os:          'Android 12',
    friendlyName:'Android Mail',
  },
];
