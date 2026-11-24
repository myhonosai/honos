import {
  validatePublishSchoolAnnouncementInput, validateWithdrawSchoolAnnouncementInput, verifySchoolAnnouncementReceipt, verifySchoolAnnouncements,
  type SchoolAnnouncementReceipt, type SchoolAnnouncements,
} from '@hon/contracts';

/**
 * School announcements (0576): same-origin browser commands only. Staff send the shell's school scope, which the server
 * checks again with family_messages.manage. Posting shows the announcement in the HON Family app; nothing is texted, emailed or pushed.
 */
export class AnnouncementsAccessError extends Error { constructor(message: string, readonly status: number) { super(message); } }
/** A definite refusal: nothing was stored, so a retry is a new command. Other failures keep the key for an exact retry. */
export class AnnouncementsRefusal extends Error {}
export type AnnouncementsScope = Readonly<{ organizationId: string; schoolId: string }>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function invalid(): never { throw new Error('The answer could not be checked. Nothing is assumed. Refresh to see the current announcements.'); }
const MESSAGES: Record<string, string> = {
  SCHOOL_ANNOUNCEMENTS_RATE_LIMITED: 'Your school posted 20 announcements in the last day. Please try again later.',
  SCHOOL_ANNOUNCEMENTS_NOT_FOUND: 'That announcement is not available.',
  VERSION_CONFLICT: 'This announcement changed. Refresh to see the latest.',
  VALIDATION_FAILED: 'A title is 1 to 120 characters on one line; the message is plain text of 1 to 2,000 characters.',
  IDEMPOTENCY_KEY_REUSED: 'This post could not be matched to the earlier one. Refresh and post it again.',
};

async function call(url: string, method: 'GET' | 'POST', command?: string, body?: unknown, key?: string): Promise<{ data: unknown; meta?: unknown }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method === 'POST') { headers['Content-Type'] = 'application/json'; headers['X-HON-Human-Command'] = command!; if (key) headers['Idempotency-Key'] = key; }
  const response = await fetch(url, { method, credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', headers,
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
  const value: unknown = await response.json().catch(() => invalid());
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const root = value as Record<string, unknown>;
  if (!response.ok) {
    if (response.status === 401) throw new AnnouncementsAccessError('Your session has ended. Sign in again.', 401);
    if (response.status === 403) throw new AnnouncementsAccessError('Announcements are not available on this account right now.', 403);
    if (MESSAGES[String(root.code)]) throw new AnnouncementsRefusal(MESSAGES[String(root.code)]!);
    throw new Error('Announcements are unavailable right now. If you were posting, it may or may not have gone through. Refresh to check.');
  }
  if (!Object.hasOwn(root, 'data')) invalid();
  return root as { data: unknown; meta?: unknown };
}
function base(scope: AnnouncementsScope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) invalid();
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/announcements`;
}
export async function loadSchoolAnnouncements(scope: AnnouncementsScope): Promise<SchoolAnnouncements> {
  return verifySchoolAnnouncements((await call(base(scope), 'GET')).data);
}
export async function publishSchoolAnnouncement(scope: AnnouncementsScope, title: string, body: string, key: string): Promise<SchoolAnnouncementReceipt> {
  const input = validatePublishSchoolAnnouncementInput({ title, body });
  return verifySchoolAnnouncementReceipt((await call(base(scope), 'POST', 'school_announcements.publish', input, key)).data, { ...input, status: 'PUBLISHED' });
}
export async function withdrawSchoolAnnouncement(scope: AnnouncementsScope, announcementId: string, expectedVersion: number, key: string): Promise<SchoolAnnouncementReceipt> {
  const input = validateWithdrawSchoolAnnouncementInput({ announcementId: announcementId.toLowerCase(), expectedVersion });
  const out = await call(`${base(scope)}/${input.announcementId}/withdraw`, 'POST', 'school_announcements.withdraw', { expectedVersion: input.expectedVersion }, key);
  return verifySchoolAnnouncementReceipt(out.data, { announcementId: input.announcementId, status: 'WITHDRAWN' });
}
/** An unknown outcome keeps its key so Try again repeats the same command; changing the text starts a new one. */
export function attemptFor(identity: string, previous: { identity: string; key: string } | null, key: () => string) {
  return previous?.identity === identity ? previous : { identity, key: key() };
}
