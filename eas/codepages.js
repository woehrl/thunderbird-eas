/**
 * EAS WBXML code page tables (MS-ASWBXML).
 *
 * There are 26 code pages, 0..25. Each array starts at token 0x05; `null`
 * marks a reserved/unassigned token so the surrounding indices stay correct.
 *
 * ── Why this file exists ────────────────────────────────────────────────
 * The previous single-table version had the AirSync page (0) wrong from
 * token 0x12 onwards and the Settings page (18) off by one from 0x14
 * onwards. Every Sync request and every Settings request the add-on sent
 * was therefore malformed. Getting these tables byte-exact is the single
 * most important correctness property of the whole EAS stack — a shifted
 * table produces requests that a server answers with a generic protocol
 * error, which is nearly impossible to debug from the client side.
 *
 * Rule when editing: never insert or remove an entry without adding/removing
 * a `null` to compensate. Page 3 (AirNotify) is deprecated but *occupies the
 * slot* — dropping it shifts every page from Move (5) onwards.
 */

/** Token value of the first entry in every page array. */
export const FIRST_TOKEN = 0x05;

export const PAGE_NAMES = [
  'AirSync',           //  0
  'Contacts',          //  1
  'Email',             //  2
  'AirNotify',         //  3  deprecated — occupies the slot
  'Calendar',          //  4
  'Move',              //  5
  'GetItemEstimate',   //  6
  'FolderHierarchy',   //  7
  'MeetingResponse',   //  8
  'Tasks',             //  9
  'ResolveRecipients', // 10
  'ValidateCert',      // 11
  'Contacts2',         // 12
  'Ping',              // 13
  'Provision',         // 14
  'Search',            // 15
  'GAL',               // 16
  'AirSyncBase',       // 17
  'Settings',          // 18
  'DocumentLibrary',   // 19
  'ItemOperations',    // 20
  'ComposeMail',       // 21
  'Email2',            // 22
  'Notes',             // 23
  'RightsManagement',  // 24
  'Find',              // 25
];

export const CODE_PAGES = [

  // ── Page 0: AirSync ─────────────────────────────────────────────────
  // 0x05..0x29. Elements marked (2.5) exist only in protocol version 2.5
  // but still occupy their token.
  [
    'Sync',            // 0x05
    'Responses',       // 0x06
    'Add',             // 0x07
    'Change',          // 0x08
    'Delete',          // 0x09
    'Fetch',           // 0x0A
    'SyncKey',         // 0x0B
    'ClientId',        // 0x0C
    'ServerId',        // 0x0D
    'Status',          // 0x0E
    'Collection',      // 0x0F
    'Class',           // 0x10
    'Version',         // 0x11  (2.5)
    'CollectionId',    // 0x12  ← lives here, NOT on GetItemEstimate
    'GetChanges',      // 0x13
    'MoreAvailable',   // 0x14
    'WindowSize',      // 0x15
    'Commands',        // 0x16
    'Options',         // 0x17
    'FilterType',      // 0x18
    'Truncation',      // 0x19  (2.5)
    'RTFTruncation',   // 0x1A  (2.5)
    'Conflict',        // 0x1B
    'Collections',     // 0x1C
    'ApplicationData', // 0x1D  ← is a real element
    'DeletesAsMoves',  // 0x1E
    'NotifyGUID',      // 0x1F  (2.5)
    'Supported',       // 0x20
    'SoftDelete',      // 0x21
    'MIMESupport',     // 0x22  ← required to receive Type=4 (MIME) bodies
    'MIMETruncation',  // 0x23
    'Wait',            // 0x24
    'Limit',           // 0x25
    'Partial',         // 0x26
    'ConversationMode',// 0x27
    'MaxItems',        // 0x28
    'HeartbeatInterval'// 0x29
  ],

  // ── Page 1: Contacts ────────────────────────────────────────────────
  [
    'Anniversary',              // 0x05
    'AssistantName',            // 0x06
    'AssistantPhoneNumber',     // 0x07
    'Birthday',                 // 0x08
    'Body',                     // 0x09 (2.5)
    'BodySize',                 // 0x0A (2.5)
    'BodyTruncated',            // 0x0B (2.5)
    'Business2PhoneNumber',     // 0x0C
    'BusinessAddressCity',      // 0x0D
    'BusinessAddressCountry',   // 0x0E
    'BusinessAddressPostalCode',// 0x0F
    'BusinessAddressState',     // 0x10
    'BusinessAddressStreet',    // 0x11
    'BusinessFaxNumber',        // 0x12
    'BusinessPhoneNumber',      // 0x13
    'CarPhoneNumber',           // 0x14
    'Categories',               // 0x15
    'Category',                 // 0x16
    'Children',                 // 0x17
    'Child',                    // 0x18
    'CompanyName',              // 0x19
    'Department',               // 0x1A
    'Email1Address',            // 0x1B
    'Email2Address',            // 0x1C
    'Email3Address',            // 0x1D
    'FileAs',                   // 0x1E
    'FirstName',                // 0x1F
    'Home2PhoneNumber',         // 0x20
    'HomeAddressCity',          // 0x21
    'HomeAddressCountry',       // 0x22
    'HomeAddressPostalCode',    // 0x23
    'HomeAddressState',         // 0x24
    'HomeAddressStreet',        // 0x25
    'HomeFaxNumber',            // 0x26
    'HomePhoneNumber',          // 0x27
    'JobTitle',                 // 0x28
    'LastName',                 // 0x29
    'MiddleName',               // 0x2A
    'MobilePhoneNumber',        // 0x2B
    'OfficeLocation',           // 0x2C
    'OtherAddressCity',         // 0x2D
    'OtherAddressCountry',      // 0x2E
    'OtherAddressPostalCode',   // 0x2F
    'OtherAddressState',        // 0x30
    'OtherAddressStreet',       // 0x31
    'PagerNumber',              // 0x32
    'RadioPhoneNumber',         // 0x33
    'Spouse',                   // 0x34
    'Suffix',                   // 0x35
    'Title',                    // 0x36
    'WebPage',                  // 0x37
    'YomiCompanyName',          // 0x38
    'YomiFirstName',            // 0x39
    'YomiLastName',             // 0x3A
    'CompressedRTF',            // 0x3B (2.5)
    'Picture',                  // 0x3C
    'Alias',                    // 0x3D
    'WeightedRank',             // 0x3E
  ],

  // ── Page 2: Email ───────────────────────────────────────────────────
  [
    'Attachment',               // 0x05
    'Attachments',              // 0x06
    'AttName',                  // 0x07
    'AttSize',                  // 0x08
    'Att0Id',                   // 0x09
    'AttMethod',                // 0x0A
    'AttRemoved',               // 0x0B
    'Body',                     // 0x0C
    'BodySize',                 // 0x0D
    'BodyTruncated',            // 0x0E
    'DateReceived',             // 0x0F
    'DisplayName',              // 0x10
    'DisplayTo',                // 0x11
    'Importance',               // 0x12
    'MessageClass',             // 0x13
    'Subject',                  // 0x14
    'Read',                     // 0x15
    'To',                       // 0x16
    'Cc',                       // 0x17
    'From',                     // 0x18
    'ReplyTo',                  // 0x19
    'AllDayEvent',              // 0x1A
    'Categories',               // 0x1B
    'Category',                 // 0x1C
    'DtStamp',                  // 0x1D
    'EndTime',                  // 0x1E
    'InstanceType',             // 0x1F
    'BusyStatus',               // 0x20
    'Location',                 // 0x21
    'MeetingRequest',           // 0x22
    'Organizer',                // 0x23
    'RecurrenceId',             // 0x24
    'Reminder',                 // 0x25
    'ResponseRequested',        // 0x26
    'Recurrences',              // 0x27
    'Recurrence',               // 0x28
    'Recurrence_Type',          // 0x29
    'Recurrence_Until',         // 0x2A
    'Recurrence_Occurrences',   // 0x2B
    'Recurrence_Interval',      // 0x2C
    'Recurrence_DayOfWeek',     // 0x2D
    'Recurrence_DayOfMonth',    // 0x2E
    'Recurrence_WeekOfMonth',   // 0x2F
    'Recurrence_MonthOfYear',   // 0x30
    'StartTime',                // 0x31
    'Sensitivity',              // 0x32
    'TimeZone',                 // 0x33
    'GlobalObjId',              // 0x34
    'ThreadTopic',              // 0x35
    'MIMEData',                 // 0x36
    'MIMETruncated',            // 0x37
    'MIMESize',                 // 0x38
    'InternetCPID',             // 0x39
    'Flag',                     // 0x3A
    'Status',                   // 0x3B
    'ContentClass',             // 0x3C
    'FlagType',                 // 0x3D
    'CompleteTime',             // 0x3E
    'DisallowNewTimeProposal',  // 0x3F
  ],

  // ── Page 3: AirNotify (deprecated, occupies the slot) ───────────────
  [],

  // ── Page 4: Calendar ────────────────────────────────────────────────
  [
    'TimeZone',                 // 0x05
    'AllDayEvent',              // 0x06
    'Attendees',                // 0x07
    'Attendee',                 // 0x08
    'Attendee_Email',           // 0x09
    'Attendee_Name',            // 0x0A
    'Body',                     // 0x0B (2.5)
    'BodyTruncated',            // 0x0C (2.5)
    'BusyStatus',               // 0x0D
    'Categories',               // 0x0E
    'Category',                 // 0x0F
    'CompressedRTF',            // 0x10 (2.5)
    'DtStamp',                  // 0x11
    'EndTime',                  // 0x12
    'Exception',                // 0x13
    'Exceptions',               // 0x14
    'Exception_Deleted',        // 0x15
    'Exception_StartTime',      // 0x16
    'Location',                 // 0x17
    'MeetingStatus',            // 0x18
    'Organizer_Email',          // 0x19
    'Organizer_Name',           // 0x1A
    'Recurrence',               // 0x1B
    'Recurrence_Type',          // 0x1C
    'Recurrence_Until',         // 0x1D
    'Recurrence_Occurrences',   // 0x1E
    'Recurrence_Interval',      // 0x1F
    'Recurrence_DayOfWeek',     // 0x20
    'Recurrence_DayOfMonth',    // 0x21
    'Recurrence_WeekOfMonth',   // 0x22
    'Recurrence_MonthOfYear',   // 0x23
    'Reminder',                 // 0x24
    'Sensitivity',              // 0x25
    'Subject',                  // 0x26
    'StartTime',                // 0x27
    'UID',                      // 0x28
    'Attendee_Status',          // 0x29
    'Attendee_Type',            // 0x2A
    null, null, null, null,     // 0x2B..0x2E reserved
    null, null, null, null,     // 0x2F..0x32 reserved
    'DisallowNewTimeProposal',  // 0x33
    'ResponseRequested',        // 0x34
    'AppointmentReplyTime',     // 0x35
    'ResponseType',             // 0x36
    'CalendarType',             // 0x37
    'IsLeapMonth',              // 0x38
    'FirstDayOfWeek',           // 0x39
    'OnlineMeetingConfLink',    // 0x3A
    'OnlineMeetingExternalLink',// 0x3B
    'ClientUid',                // 0x3C
  ],

  // ── Page 5: Move ────────────────────────────────────────────────────
  ['MoveItems', 'Move', 'SrcMsgId', 'SrcFldId', 'DstFldId', 'Response', 'Status', 'DstMsgId'],

  // ── Page 6: GetItemEstimate ─────────────────────────────────────────
  [
    'GetItemEstimate', // 0x05
    'Version',         // 0x06
    'Collections',     // 0x07
    'Collection',      // 0x08
    'Class',           // 0x09
    'CollectionId',    // 0x0A
    'DateTime',        // 0x0B
    'Estimate',        // 0x0C
    'Response',        // 0x0D
    'Status',          // 0x0E
  ],

  // ── Page 7: FolderHierarchy ─────────────────────────────────────────
  [
    'Folders',       // 0x05 (2.5)
    'Folder',        // 0x06 (2.5)
    'DisplayName',   // 0x07
    'ServerId',      // 0x08
    'ParentId',      // 0x09
    'Type',          // 0x0A
    'Response',      // 0x0B
    'Status',        // 0x0C
    'ContentClass',  // 0x0D
    'Changes',       // 0x0E
    'Add',           // 0x0F
    'Delete',        // 0x10
    'Update',        // 0x11
    'SyncKey',       // 0x12
    'FolderCreate',  // 0x13
    'FolderDelete',  // 0x14
    'FolderUpdate',  // 0x15
    'FolderSync',    // 0x16
    'Count',         // 0x17
  ],

  // ── Page 8: MeetingResponse ─────────────────────────────────────────
  [
    'CalendarId',        // 0x05
    'CollectionId',      // 0x06
    'MeetingResponse',   // 0x07
    'RequestId',         // 0x08
    'Request',           // 0x09
    'Result',            // 0x0A
    'Status',            // 0x0B
    'UserResponse',      // 0x0C
    null,                // 0x0D reserved
    'InstanceId',        // 0x0E
    null,                // 0x0F reserved
    'ProposedStartTime', // 0x10 (16.1)
    'ProposedEndTime',   // 0x11 (16.1)
    'SendResponse',      // 0x12 (16.1)
  ],

  // ── Page 9: Tasks ───────────────────────────────────────────────────
  [
    'Body',                      // 0x05 (2.5)
    'BodySize',                  // 0x06 (2.5)
    'BodyTruncated',             // 0x07 (2.5)
    'Categories',                // 0x08
    'Category',                  // 0x09
    'Complete',                  // 0x0A
    'DateCompleted',             // 0x0B
    'DueDate',                   // 0x0C
    'UtcDueDate',                // 0x0D
    'Importance',                // 0x0E
    'Recurrence',                // 0x0F
    'Recurrence_Type',           // 0x10
    'Recurrence_Start',          // 0x11
    'Recurrence_Until',          // 0x12
    'Recurrence_Occurrences',    // 0x13
    'Recurrence_Interval',       // 0x14
    'Recurrence_DayOfMonth',     // 0x15
    'Recurrence_DayOfWeek',      // 0x16
    'Recurrence_WeekOfMonth',    // 0x17
    'Recurrence_MonthOfYear',    // 0x18
    'Recurrence_Regenerate',     // 0x19
    'Recurrence_DeadOccur',      // 0x1A
    'ReminderSet',               // 0x1B
    'ReminderTime',              // 0x1C
    'Sensitivity',               // 0x1D
    'StartDate',                 // 0x1E
    'UtcStartDate',              // 0x1F
    'Subject',                   // 0x20
    'CompressedRTF',             // 0x21 (2.5)
    'OrdinalDate',               // 0x22
    'SubOrdinalDate',            // 0x23
    'CalendarType',              // 0x24
    'IsLeapMonth',               // 0x25
    'FirstDayOfWeek',            // 0x26
  ],

  // ── Page 10: ResolveRecipients ──────────────────────────────────────
  [
    'ResolveRecipients', 'Response', 'Status', 'Type', 'Recipient', 'DisplayName',
    'EmailAddress', 'Certificates', 'Certificate', 'MiniCertificate', 'Options',
    'To', 'CertificateRetrieval', 'RecipientCount', 'MaxCertificates',
    'MaxAmbiguousRecipients', 'CertificateCount', 'Availability', 'StartTime',
    'EndTime', 'MergedFreeBusy', 'Picture', 'MaxSize', 'Data', 'MaxPictures',
  ],

  // ── Page 11: ValidateCert ───────────────────────────────────────────
  ['ValidateCert', 'Certificates', 'Certificate', 'CertificateChain', 'CheckCRL', 'Status'],

  // ── Page 12: Contacts2 ──────────────────────────────────────────────
  [
    'CustomerId', 'GovernmentId', 'IMAddress', 'IMAddress2', 'IMAddress3',
    'ManagerName', 'CompanyMainPhone', 'AccountName', 'NickName', 'MMS',
  ],

  // ── Page 13: Ping ───────────────────────────────────────────────────
  ['Ping', 'AutdState', 'Status', 'HeartbeatInterval', 'Folders', 'Folder', 'Id', 'Class', 'MaxFolders'],

  // ── Page 14: Provision ──────────────────────────────────────────────
  [
    'Provision',                                 // 0x05
    'Policies',                                  // 0x06
    'Policy',                                    // 0x07
    'PolicyType',                                // 0x08
    'PolicyKey',                                 // 0x09
    'Data',                                      // 0x0A
    'Status',                                    // 0x0B
    'RemoteWipe',                                // 0x0C
    'EASProvisionDoc',                           // 0x0D
    'DevicePasswordEnabled',                     // 0x0E
    'AlphanumericDevicePasswordRequired',        // 0x0F
    'RequireStorageCardEncryption',              // 0x10
    'PasswordRecoveryEnabled',                   // 0x11
    'DocumentBrowseEnabled',                     // 0x12
    'AttachmentsEnabled',                        // 0x13
    'MinDevicePasswordLength',                   // 0x14
    'MaxInactivityTimeDeviceLock',               // 0x15
    'MaxDevicePasswordFailedAttempts',           // 0x16
    'MaxAttachmentSize',                         // 0x17
    'AllowSimpleDevicePassword',                 // 0x18
    'DevicePasswordExpiration',                  // 0x19
    'DevicePasswordHistory',                     // 0x1A
    'AllowStorageCard',                          // 0x1B
    'AllowCamera',                               // 0x1C
    'RequireDeviceEncryption',                   // 0x1D
    'AllowUnsignedApplications',                 // 0x1E
    'AllowUnsignedInstallationPackages',         // 0x1F
    'MinDevicePasswordComplexCharacters',        // 0x20
    'AllowWiFi',                                 // 0x21
    'AllowTextMessaging',                        // 0x22
    'AllowPOPIMAPEmail',                         // 0x23
    'AllowBluetooth',                            // 0x24
    'AllowIrDA',                                 // 0x25
    'RequireManualSyncWhenRoaming',              // 0x26
    'AllowDesktopSync',                          // 0x27
    'MaxCalendarAgeFilter',                      // 0x28
    'AllowHTMLEmail',                            // 0x29
    'MaxEmailAgeFilter',                         // 0x2A
    'MaxEmailBodyTruncationSize',                // 0x2B
    'MaxEmailHTMLBodyTruncationSize',            // 0x2C
    'RequireSignedSMIMEMessages',                // 0x2D
    'RequireEncryptedSMIMEMessages',             // 0x2E
    'RequireSignedSMIMEAlgorithm',               // 0x2F
    'RequireEncryptionSMIMEAlgorithm',           // 0x30
    'AllowSMIMEEncryptionAlgorithmNegotiation',  // 0x31
    'AllowSMIMESoftCerts',                       // 0x32
    'AllowBrowser',                              // 0x33
    'AllowConsumerEmail',                        // 0x34
    'AllowRemoteDesktop',                        // 0x35
    'AllowInternetSharing',                      // 0x36
    'UnapprovedInROMApplicationList',            // 0x37
    'ApplicationName',                           // 0x38
    'ApprovedApplicationList',                   // 0x39
    'HashAlgorithm',                             // 0x3A
  ],

  // ── Page 15: Search ─────────────────────────────────────────────────
  [
    'Search',         // 0x05
    'Stores',         // 0x06
    'Store',          // 0x07
    null, null, null, // 0x08..0x0A reserved
    'Name',           // 0x0B
    'Query',          // 0x0C
    'Options',        // 0x0D
    'Range',          // 0x0E
    'Status',         // 0x0F
    'Response',       // 0x10
    'Result',         // 0x11
    'Properties',     // 0x12
    'Total',          // 0x13
    'EqualTo',        // 0x14
    'Value',          // 0x15
    'And',            // 0x16
    'Or',             // 0x17
    'FreeText',       // 0x18
    null,             // 0x19 reserved
    'DeepTraversal',  // 0x1A
    'LongId',         // 0x1B
    'RebuildResults', // 0x1C
    'LessThan',       // 0x1D
    'GreaterThan',    // 0x1E
    'Schema',         // 0x1F
    'Supported',      // 0x20
    'UserName',       // 0x21
    'Password',       // 0x22
    'ConversationId', // 0x23
    'Picture',        // 0x24
    'MaxSize',        // 0x25
    'MaxPictures',    // 0x26
  ],

  // ── Page 16: GAL ────────────────────────────────────────────────────
  [
    'DisplayName', 'Phone', 'Office', 'Title', 'Company', 'Alias', 'FirstName',
    'LastName', 'HomePhone', 'MobilePhone', 'EmailAddress', 'Picture', 'Status', 'Data',
  ],

  // ── Page 17: AirSyncBase ────────────────────────────────────────────
  [
    'BodyPreference',      // 0x05
    'Type',                // 0x06
    'TruncationSize',      // 0x07
    'AllOrNone',           // 0x08
    null,                  // 0x09 reserved
    'Body',                // 0x0A
    'Data',                // 0x0B
    'EstimatedDataSize',   // 0x0C
    'Truncated',           // 0x0D
    'Attachments',         // 0x0E
    'Attachment',          // 0x0F
    'DisplayName',         // 0x10
    'FileReference',       // 0x11
    'Method',              // 0x12
    'ContentId',           // 0x13
    'ContentLocation',     // 0x14
    'IsInline',            // 0x15
    'NativeBodyType',      // 0x16
    'ContentType',         // 0x17
    'Preview',             // 0x18
    'BodyPartPreference',  // 0x19
    'BodyPart',            // 0x1A
    'Status',              // 0x1B
    'Add',                 // 0x1C (16.0)
    'Delete',              // 0x1D (16.0)
    'ClientId',            // 0x1E (16.0)
    'Content',             // 0x1F (16.0)
    'Location',            // 0x20 (16.0)
    'Annotation',          // 0x21 (16.0)
    'Street',              // 0x22 (16.0)
    'City',                // 0x23 (16.0)
    'State',               // 0x24 (16.0)
    'Country',             // 0x25 (16.0)
    'PostalCode',          // 0x26 (16.0)
    'Latitude',            // 0x27 (16.0)
    'Longitude',           // 0x28 (16.0)
    'Accuracy',            // 0x29 (16.0)
    'Altitude',            // 0x2A (16.0)
    'AltitudeAccuracy',    // 0x2B (16.0)
    'LocationUri',         // 0x2C (16.0)
    'InstanceId',          // 0x2D (16.0)
  ],

  // ── Page 18: Settings ───────────────────────────────────────────────
  // NOTE: there is no 'Data' element on this page. The old table had one at
  // 0x14, which shifted DeviceInformation/Model/FriendlyName/OS/UserAgent by
  // one token each and made every Settings request unparseable for Exchange.
  [
    'Settings',                   // 0x05
    'Status',                     // 0x06
    'Get',                        // 0x07
    'Set',                        // 0x08
    'Oof',                        // 0x09
    'OofState',                   // 0x0A
    'StartTime',                  // 0x0B
    'EndTime',                    // 0x0C
    'OofMessage',                 // 0x0D
    'AppliesToInternal',          // 0x0E
    'AppliesToExternalKnown',     // 0x0F
    'AppliesToExternalUnknown',   // 0x10
    'Enabled',                    // 0x11
    'ReplyMessage',               // 0x12
    'BodyType',                   // 0x13
    'DevicePassword',             // 0x14
    'Password',                   // 0x15
    'DeviceInformation',          // 0x16
    'Model',                      // 0x17
    'IMEI',                       // 0x18
    'FriendlyName',               // 0x19
    'OS',                         // 0x1A
    'OSLanguage',                 // 0x1B
    'PhoneNumber',                // 0x1C
    'UserInformation',            // 0x1D
    'EmailAddresses',             // 0x1E
    'SmtpAddress',                // 0x1F
    'UserAgent',                  // 0x20
    'EnableOutboundSMS',          // 0x21
    'MobileOperator',             // 0x22
    'PrimarySmtpAddress',         // 0x23
    'Accounts',                   // 0x24
    'Account',                    // 0x25
    'AccountId',                  // 0x26
    'AccountName',                // 0x27
    'UserDisplayName',            // 0x28
    'SendDisabled',               // 0x29
    null,                         // 0x2A reserved
    'RightsManagementInformation',// 0x2B
  ],

  // ── Page 19: DocumentLibrary ────────────────────────────────────────
  [
    'LinkId', 'DisplayName', 'IsFolder', 'CreationDate', 'LastModifiedDate',
    'IsHidden', 'ContentLength', 'ContentType',
  ],

  // ── Page 20: ItemOperations ─────────────────────────────────────────
  [
    'ItemOperations',      // 0x05
    'Fetch',               // 0x06
    'Store',               // 0x07
    'Options',             // 0x08
    'Range',               // 0x09
    'Total',               // 0x0A
    'Properties',          // 0x0B
    'Data',                // 0x0C
    'Status',              // 0x0D
    'Response',            // 0x0E
    'Version',             // 0x0F
    'Schema',              // 0x10
    'Part',                // 0x11
    'EmptyFolderContents', // 0x12
    'DeleteSubFolders',    // 0x13
    'UserName',            // 0x14
    'Password',            // 0x15
    'Move',                // 0x16
    'DstFldId',            // 0x17
    'ConversationId',      // 0x18
    'MoveAlways',          // 0x19
  ],

  // ── Page 21: ComposeMail ────────────────────────────────────────────
  [
    'SendMail',        // 0x05
    'SmartForward',    // 0x06
    'SmartReply',      // 0x07
    'SaveInSentItems', // 0x08
    'ReplaceMime',     // 0x09
    null,              // 0x0A reserved
    'Source',          // 0x0B
    'FolderId',        // 0x0C
    'ItemId',          // 0x0D
    'LongId',          // 0x0E
    'InstanceId',      // 0x0F
    'Mime',            // 0x10
    'ClientId',        // 0x11
    'Status',          // 0x12
    'AccountId',       // 0x13
  ],

  // ── Page 22: Email2 ─────────────────────────────────────────────────
  [
    'UmCallerId',            // 0x05
    'UmUserNotes',           // 0x06
    'UmAttDuration',         // 0x07
    'UmAttOrder',            // 0x08
    'ConversationId',        // 0x09
    'ConversationIndex',     // 0x0A
    'LastVerbExecuted',      // 0x0B
    'LastVerbExecutionTime', // 0x0C
    'ReceivedAsBcc',         // 0x0D
    'Sender',                // 0x0E
    'CalendarType',          // 0x0F
    'IsLeapMonth',           // 0x10
    'AccountId',             // 0x11
    'FirstDayOfWeek',        // 0x12
    'MeetingMessageType',    // 0x13
    null,                    // 0x14 reserved
    'IsDraft',               // 0x15
    'Bcc',                   // 0x16
    'Send',                  // 0x17
  ],

  // ── Page 23: Notes (14.1) ───────────────────────────────────────────
  ['Subject', 'MessageClass', 'LastModifiedDate', 'Categories', 'Category'],

  // ── Page 24: RightsManagement (14.1) ────────────────────────────────
  [
    'RightsManagementSupport',            // 0x05
    'RightsManagementTemplates',          // 0x06
    'RightsManagementTemplate',           // 0x07
    'RightsManagementLicense',            // 0x08
    'EditAllowed',                        // 0x09
    'ReplyAllowed',                       // 0x0A
    'ReplyAllAllowed',                    // 0x0B
    'ForwardAllowed',                     // 0x0C
    'ModifyRecipientsAllowed',            // 0x0D
    'ExtractAllowed',                     // 0x0E
    'PrintAllowed',                       // 0x0F
    'ExportAllowed',                      // 0x10
    'ProgrammaticAccessAllowed',          // 0x11
    'Owner',                              // 0x12
    'ContentExpiryDate',                  // 0x13
    'TemplateID',                         // 0x14
    'TemplateName',                       // 0x15
    'TemplateDescription',                // 0x16
    'ContentOwner',                       // 0x17
    'RemoveRightsManagementDistribution', // 0x18
  ],

  // ── Page 25: Find (16.1) ────────────────────────────────────────────
  [
    'Find',                  // 0x05
    'SearchId',              // 0x06
    'ExecuteSearch',         // 0x07
    'MailBoxSearchCriterion',// 0x08
    'Query',                 // 0x09
    'Status',                // 0x0A
    'FreeText',              // 0x0B
    'Options',               // 0x0C
    'Range',                 // 0x0D
    'DeepTraversal',         // 0x0E
    'Response',              // 0x0F
    'Result',                // 0x10
    'Properties',            // 0x11
    'Preview',               // 0x12
    'HasAttachments',        // 0x13
    'Total',                 // 0x14
    'DisplayCc',             // 0x15
    'DisplayBcc',            // 0x16
    'GalSearchCriterion',    // 0x17
    'MaxPictures',           // 0x18
    'MaxSize',               // 0x19
    'Picture',               // 0x1A
  ],
];

export const PAGE_BY_NAME = Object.fromEntries(PAGE_NAMES.map((n, i) => [n, i]));

/** namespace index + tag name → { page, token }; built lazily. */
let _reverseMap = null;

function getReverseMap() {
  if (_reverseMap) return _reverseMap;
  _reverseMap = new Map();
  for (let page = 0; page < CODE_PAGES.length; page++) {
    const tags = CODE_PAGES[page];
    if (!tags) continue;
    for (let i = 0; i < tags.length; i++) {
      const name = tags[i];
      if (!name) continue;
      const key = `${page}:${name}`;
      if (!_reverseMap.has(key)) _reverseMap.set(key, { page, token: i + FIRST_TOKEN });
    }
  }
  return _reverseMap;
}

/** Resolve a page index from either an index or a page name. */
export function pageIndex(ns) {
  if (typeof ns === 'number') return ns;
  const idx = PAGE_BY_NAME[ns];
  if (idx === undefined) throw new Error(`Unknown EAS code page: ${ns}`);
  return idx;
}

export function lookupTag(page, token) {
  const tags = CODE_PAGES[page];
  if (!tags) return null;
  return tags[token - FIRST_TOKEN] || null;
}

export function encodeTag(ns, tagName) {
  return getReverseMap().get(`${pageIndex(ns)}:${tagName}`) || null;
}

/**
 * Self-check used by the diagnostics page. Verifies the anchor tokens that
 * previously drifted, so a future edit that shifts a table is caught
 * immediately instead of turning into a silent protocol failure.
 */
export const TABLE_ANCHORS = [
  ['AirSync',         'CollectionId',      0x12],
  ['AirSync',         'Collections',       0x1C],
  ['AirSync',         'ApplicationData',   0x1D],
  ['AirSync',         'Commands',          0x16],
  ['AirSync',         'Options',           0x17],
  ['AirSync',         'WindowSize',        0x15],
  ['AirSync',         'MIMESupport',       0x22],
  ['AirSync',         'GetChanges',        0x13],
  ['Email',           'Read',              0x15],
  ['FolderHierarchy', 'FolderSync',        0x16],
  ['FolderHierarchy', 'SyncKey',           0x12],
  ['Provision',       'PolicyKey',         0x09],
  ['AirSyncBase',     'Body',              0x0A],
  ['AirSyncBase',     'Truncated',         0x0D],
  ['Settings',        'DeviceInformation', 0x16],
  ['Settings',        'Model',             0x17],
  ['Settings',        'FriendlyName',      0x19],
  ['Settings',        'UserAgent',         0x20],
  ['ComposeMail',     'Mime',              0x10],
  ['ItemOperations',  'Fetch',             0x06],
];

export function verifyCodePages() {
  const errors = [];
  if (PAGE_NAMES.length !== CODE_PAGES.length) {
    errors.push(`PAGE_NAMES (${PAGE_NAMES.length}) and CODE_PAGES (${CODE_PAGES.length}) length mismatch`);
  }
  for (const [ns, tag, expected] of TABLE_ANCHORS) {
    const info = encodeTag(ns, tag);
    if (!info) { errors.push(`${ns}:${tag} missing`); continue; }
    if (info.token !== expected) {
      errors.push(`${ns}:${tag} is 0x${info.token.toString(16)}, expected 0x${expected.toString(16)}`);
    }
  }
  return errors;
}
