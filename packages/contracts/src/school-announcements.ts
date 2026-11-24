/**
 * School announcements (0576). Staff with family_messages.manage post a short announcement to every family of their school
 * from the CRM; families see the live ones from the last 60 days on the HON Family app's Home screen. A posted announcement
 * never changes; staff can take it down once. Nothing is texted, emailed or pushed. Families never see who posted it.
 */
export const SCHOOL_ANNOUNCEMENT_STATUSES = ['PUBLISHED', 'WITHDRAWN'] as const;
export type SchoolAnnouncementStatus = (typeof SCHOOL_ANNOUNCEMENT_STATUSES)[number];
export const SCHOOL_ANNOUNCEMENT_LIMITS = { title: 120, body: 2000, family: 20, staff: 100 } as const;

export interface FamilySchoolAnnouncement { announcementId: string; title: string; body: string; publishedAt: string }
export interface ParentSchoolAnnouncements { schoolName: string; announcements: FamilySchoolAnnouncement[] }
export interface SchoolAnnouncement extends FamilySchoolAnnouncement { status: SchoolAnnouncementStatus; withdrawnAt: string | null; version: number }
export interface SchoolAnnouncements { announcements: SchoolAnnouncement[] }
export interface SchoolAnnouncementReceipt { announcement: SchoolAnnouncement }
export interface PublishSchoolAnnouncementInput { title: string; body: string }
export interface WithdrawSchoolAnnouncementInput { announcementId: string; expectedVersion: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TITLE_CONTROL = /[\u0000-\u001f\u007f]/;
const BODY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function invalid(): never { throw new Error('Invalid school announcement data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value; }
function instant(value: unknown): string {
  if (typeof value !== 'string' || !INSTANT.test(value) || new Date(value).toISOString() !== value) invalid();
  return value;
}
export function isSchoolAnnouncementTitle(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= SCHOOL_ANNOUNCEMENT_LIMITS.title && value.trim() !== '' && !TITLE_CONTROL.test(value);
}
export function isSchoolAnnouncementBody(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= SCHOOL_ANNOUNCEMENT_LIMITS.body && value.replace(/[ \t\r\n]/g, '') !== '' && !BODY_CONTROL.test(value);
}
function title(value: unknown): string { if (!isSchoolAnnouncementTitle(value)) invalid(); return value; }
function body(value: unknown): string { if (!isSchoolAnnouncementBody(value)) invalid(); return value; }
function newestFirst<T extends { publishedAt: string }>(list: T[]): T[] {
  if (list.some((x, i) => i > 0 && x.publishedAt > list[i - 1]!.publishedAt)) invalid();
  if (new Set(list.map(x => (x as unknown as { announcementId: string }).announcementId)).size !== list.length) invalid();
  return list;
}

export function validatePublishSchoolAnnouncementInput(value: unknown): PublishSchoolAnnouncementInput {
  const row = record(value, ['title', 'body']);
  return { title: title(row.title), body: body(row.body) };
}
export function validateWithdrawSchoolAnnouncementInput(value: unknown): WithdrawSchoolAnnouncementInput {
  const row = record(value, ['announcementId', 'expectedVersion']);
  if (!Number.isSafeInteger(row.expectedVersion) || (row.expectedVersion as number) < 1 || (row.expectedVersion as number) > 999_999_999) invalid();
  return { announcementId: uuid(row.announcementId), expectedVersion: row.expectedVersion as number };
}

function familyItem(value: unknown): FamilySchoolAnnouncement {
  const row = record(value, ['announcementId', 'title', 'body', 'publishedAt']);
  return { announcementId: uuid(row.announcementId), title: title(row.title), body: body(row.body), publishedAt: instant(row.publishedAt) };
}
export function verifyParentSchoolAnnouncements(value: unknown): ParentSchoolAnnouncements {
  const row = record(value, ['schoolName', 'announcements']);
  if (typeof row.schoolName !== 'string' || !row.schoolName.trim() || row.schoolName.length > 200 || TITLE_CONTROL.test(row.schoolName)) invalid();
  if (!Array.isArray(row.announcements) || row.announcements.length > SCHOOL_ANNOUNCEMENT_LIMITS.family) invalid();
  return { schoolName: row.schoolName, announcements: newestFirst(row.announcements.map(familyItem)) };
}

export function verifySchoolAnnouncement(value: unknown): SchoolAnnouncement {
  const row = record(value, ['announcementId', 'title', 'body', 'status', 'publishedAt', 'withdrawnAt', 'version']);
  if (typeof row.status !== 'string' || !(SCHOOL_ANNOUNCEMENT_STATUSES as readonly string[]).includes(row.status)) invalid();
  if (!Number.isSafeInteger(row.version) || (row.version as number) < 1) invalid();
  const status = row.status as SchoolAnnouncementStatus;
  const withdrawnAt = row.withdrawnAt === null ? null : instant(row.withdrawnAt);
  if ((status === 'WITHDRAWN') !== (withdrawnAt !== null) || (status === 'PUBLISHED' && row.version !== 1)) invalid();
  return { announcementId: uuid(row.announcementId), title: title(row.title), body: body(row.body), status, publishedAt: instant(row.publishedAt), withdrawnAt,
    version: row.version as number };
}
export function verifySchoolAnnouncements(value: unknown): SchoolAnnouncements {
  const row = record(value, ['announcements']);
  if (!Array.isArray(row.announcements) || row.announcements.length > SCHOOL_ANNOUNCEMENT_LIMITS.staff) invalid();
  return { announcements: newestFirst(row.announcements.map(verifySchoolAnnouncement)) };
}
export function verifySchoolAnnouncementReceipt(value: unknown, expected: { title?: string; body?: string; announcementId?: string; status: SchoolAnnouncementStatus }): SchoolAnnouncementReceipt {
  const row = record(value, ['announcement']);
  const announcement = verifySchoolAnnouncement(row.announcement);
  if (announcement.status !== expected.status || (expected.title !== undefined && announcement.title !== expected.title)
    || (expected.body !== undefined && announcement.body !== expected.body) || (expected.announcementId !== undefined && announcement.announcementId !== expected.announcementId)) invalid();
  return { announcement };
}
