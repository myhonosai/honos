/**
 * School email and text blasts (BL1, migration 0500). Owner request (David, 2026-11-18): blasts with merge tags, a checkout
 * link and pictures or video. Piece 1: staff write one email or text, pick groups and tags, see the deduplicated count, and
 * send now or schedule. The database resolves the audience, fills the merge tags and queues one 0243 message per reachable
 * recipient (origin CAMPAIGN). Spec: docs/architecture/SCHOOL_BLASTS.md. validateSaveSchoolBlast mirrors the 0500 checks.
 */

export const SCHOOL_BLAST_CHANNELS = ['EMAIL', 'SMS'] as const;
export type SchoolBlastChannel = typeof SCHOOL_BLAST_CHANNELS[number];
export const SCHOOL_BLAST_AUDIENCE_GROUPS = ['ACTIVE_STUDENTS', 'PROSPECTS', 'TRIAL', 'FORMER_STUDENTS', 'ALL_CONTACTS'] as const;
export type SchoolBlastAudienceGroup = typeof SCHOOL_BLAST_AUDIENCE_GROUPS[number];
export const SCHOOL_BLAST_MERGE_FIELDS = ['first_name', 'last_name', 'school_name', 'staff_name'] as const;
export type SchoolBlastMergeField = typeof SCHOOL_BLAST_MERGE_FIELDS[number];
export const SCHOOL_BLAST_STATUSES = ['DRAFT', 'QUEUED', 'CANCELLED'] as const;
export type SchoolBlastStatus = typeof SCHOOL_BLAST_STATUSES[number];
export const SCHOOL_BLAST_OUTCOMES = ['QUEUED', 'NO_CONSENT', 'NO_ADDRESS', 'DUPLICATE_ADDRESS'] as const;
export type SchoolBlastOutcome = typeof SCHOOL_BLAST_OUTCOMES[number];
/** WAITING: queued, no delivery attempt created yet (scheduled, or the worker has not picked it up). */
export const SCHOOL_BLAST_DELIVERY_STATES = ['WAITING', 'PENDING', 'SENDING', 'ACCEPTED', 'DELIVERED', 'BOUNCED', 'FAILED', 'SUPPRESSED', 'UNKNOWN', 'CANCELLED'] as const;
export type SchoolBlastDeliveryState = typeof SCHOOL_BLAST_DELIVERY_STATES[number];
export const SCHOOL_BLAST_LIMITS = {
  name: 100, subject: 150, emailBody: 3500, smsBody: 1000, groups: 5, tags: 10, recipients: 2000, perDay: 10, scheduleDays: 60, list: 100,
} as const;
export const SCHOOL_BLAST_COMMANDS = { save: 'marketing_blast.save', send: 'marketing_blast.send', cancel: 'marketing_blast.cancel' } as const;
export const SCHOOL_BLAST_READ_COMMAND = 'marketing_blast.read';

export interface SchoolBlastAudience { groups: SchoolBlastAudienceGroup[]; tags: string[] }
export interface SaveSchoolBlastInput {
  blastId: string | null; expectedVersion: number; name: string; channel: SchoolBlastChannel; subject: string | null; body: string; audience: SchoolBlastAudience;
}
/** sendAt null sends now; otherwise a future instant (ISO, milliseconds, Z) within 60 days. */
export interface SendSchoolBlastInput { blastId: string; expectedVersion: number; sendAt: string | null }
export interface CancelSchoolBlastInput { blastId: string; expectedVersion: number }
export type SchoolBlastOutcomeCounts = Record<SchoolBlastOutcome, number>;
export type SchoolBlastDeliveryCounts = Record<SchoolBlastDeliveryState, number>;
export interface SchoolBlast {
  blastId: string; name: string; channel: SchoolBlastChannel; subject: string | null; body: string; audience: SchoolBlastAudience;
  status: SchoolBlastStatus; version: number; sendAt: string | null; queuedAt: string | null; cancelledAt: string | null;
  recipientCount: number | null; outcomes: SchoolBlastOutcomeCounts | null; deliveries: SchoolBlastDeliveryCounts | null;
  createdAt: string; updatedAt: string;
}
export interface SchoolBlastSummary {
  blastId: string; name: string; channel: SchoolBlastChannel; status: SchoolBlastStatus; version: number; sendAt: string | null;
  queuedAt: string | null; recipientCount: number | null; updatedAt: string;
}
export interface SchoolBlastAudiencePreview {
  blastId: string; version: number; channel: SchoolBlastChannel; matched: number; outcomes: SchoolBlastOutcomeCounts;
  /** The first reachable recipient's rendered message (first name only), or null when nobody is reachable. */
  sample: { firstName: string; subject: string | null; body: string } | null;
}
export interface SchoolBlastReceipt { blast: SchoolBlast; replayed: boolean }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TAG = /^[A-Za-z0-9](?:[A-Za-z0-9 _-]{0,38}[A-Za-z0-9])?$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const MERGE = /\{\{(first_name|last_name|school_name|staff_name)\}\}/g;

function invalid(): never { throw new Error('Invalid school blast data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}
const uuid = (v: unknown): string => { if (typeof v !== 'string' || !UUID.test(v)) invalid(); return v.toLowerCase(); };
const instant = (v: unknown): string => { if (typeof v !== 'string' || !INSTANT.test(v) || Number.isNaN(Date.parse(v))) invalid(); return v; };
const nullableInstant = (v: unknown): string | null => v === null ? null : instant(v);
const count = (v: unknown, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) invalid();
  return v;
};
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T => { if (!(allowed as readonly unknown[]).includes(v)) invalid(); return v as T; };

/** Plain text: trimmed, min..max characters, no control characters except tab and line breaks, every {{...}} a merge tag. */
const EDGE_SPACE = /^[ \t\n\r]|[ \t\n\r]$/;
export function schoolBlastTextOk(v: unknown, min: number, max: number): v is string {
  return typeof v === 'string' && !EDGE_SPACE.test(v) && v.length >= min && v.length <= max && !CONTROL.test(v) && !/(\{\{|\}\})/.test(v.replace(MERGE, ''));
}
export function schoolBlastNameOk(v: unknown): v is string {
  return typeof v === 'string' && !EDGE_SPACE.test(v) && v.length >= 1 && v.length <= SCHOOL_BLAST_LIMITS.name && !CONTROL.test(v) && !/[\n\r\t]/.test(v);
}
export function schoolBlastBodyMax(channel: SchoolBlastChannel): number { return channel === 'EMAIL' ? SCHOOL_BLAST_LIMITS.emailBody : SCHOOL_BLAST_LIMITS.smsBody; }

function audience(value: unknown): SchoolBlastAudience {
  const row = record(value, ['groups', 'tags']);
  if (!Array.isArray(row.groups) || row.groups.length < 1 || row.groups.length > SCHOOL_BLAST_LIMITS.groups) invalid();
  const groups = row.groups.map(g => oneOf(g, SCHOOL_BLAST_AUDIENCE_GROUPS));
  if (new Set(groups).size !== groups.length) invalid();
  if (!Array.isArray(row.tags) || row.tags.length > SCHOOL_BLAST_LIMITS.tags) invalid();
  const tags = row.tags.map(t => { if (typeof t !== 'string' || !TAG.test(t)) invalid(); return t; });
  if (new Set(tags.map(t => t.toLowerCase())).size !== tags.length) invalid();
  return Object.freeze({ groups, tags });
}

export function validateSaveSchoolBlast(value: unknown): SaveSchoolBlastInput {
  const row = record(value, ['blastId', 'expectedVersion', 'name', 'channel', 'subject', 'body', 'audience']);
  const blastId = row.blastId === null ? null : uuid(row.blastId);
  const expectedVersion = count(row.expectedVersion, 0, 999_999_999);
  if ((blastId === null) !== (expectedVersion === 0)) invalid();
  if (!schoolBlastNameOk(row.name)) invalid();
  const channel = oneOf(row.channel, SCHOOL_BLAST_CHANNELS);
  if (channel === 'EMAIL' ? !schoolBlastTextOk(row.subject, 1, SCHOOL_BLAST_LIMITS.subject) || /[\n\r\t]/.test(row.subject as string) : row.subject !== null) invalid();
  if (!schoolBlastTextOk(row.body, 1, schoolBlastBodyMax(channel))) invalid();
  return Object.freeze({ blastId, expectedVersion, name: row.name, channel, subject: row.subject as string | null, body: row.body, audience: audience(row.audience) });
}
export function validateSendSchoolBlast(value: unknown, now: number = Date.now()): SendSchoolBlastInput {
  const row = record(value, ['blastId', 'expectedVersion', 'sendAt']);
  const sendAt = nullableInstant(row.sendAt);
  if (sendAt !== null) {
    const at = Date.parse(sendAt);
    if (at <= now + 60_000 || at > now + SCHOOL_BLAST_LIMITS.scheduleDays * 86_400_000) invalid();
  }
  return Object.freeze({ blastId: uuid(row.blastId), expectedVersion: count(row.expectedVersion, 1, 999_999_999), sendAt });
}
export function validateCancelSchoolBlast(value: unknown): CancelSchoolBlastInput {
  const row = record(value, ['blastId', 'expectedVersion']);
  return Object.freeze({ blastId: uuid(row.blastId), expectedVersion: count(row.expectedVersion, 1, 999_999_999) });
}

/** Fills the merge tags exactly as the database does: an empty first name is "there", an empty last name is nothing. */
export function renderSchoolBlast(text: string, values: Readonly<{ firstName: string; lastName: string; schoolName: string; staffName: string }>): string {
  const first = values.firstName.trim() || 'there';
  return text.replace(MERGE, (_m, field: SchoolBlastMergeField) =>
    field === 'first_name' ? first : field === 'last_name' ? values.lastName.trim() : field === 'school_name' ? values.schoolName : values.staffName);
}

function counts<K extends string>(value: unknown, keys: readonly K[]): Record<K, number> {
  const row = record(value, keys);
  return Object.freeze(Object.fromEntries(keys.map(k => [k, count(row[k], 0, 1_000_000)]))) as Record<K, number>;
}
const BLAST_KEYS = ['blastId', 'name', 'channel', 'subject', 'body', 'audience', 'status', 'version', 'sendAt', 'queuedAt', 'cancelledAt',
  'recipientCount', 'outcomes', 'deliveries', 'createdAt', 'updatedAt'] as const;

export function verifySchoolBlast(value: unknown): SchoolBlast {
  const row = record(value, BLAST_KEYS);
  const channel = oneOf(row.channel, SCHOOL_BLAST_CHANNELS);
  const status = oneOf(row.status, SCHOOL_BLAST_STATUSES);
  if (!schoolBlastNameOk(row.name) || !schoolBlastTextOk(row.body, 1, schoolBlastBodyMax(channel))) invalid();
  if (channel === 'EMAIL' ? !schoolBlastTextOk(row.subject, 1, SCHOOL_BLAST_LIMITS.subject) : row.subject !== null) invalid();
  const queuedAt = nullableInstant(row.queuedAt), cancelledAt = nullableInstant(row.cancelledAt), sendAt = nullableInstant(row.sendAt);
  const sent = status !== 'DRAFT' && queuedAt !== null;
  const recipientCount = row.recipientCount === null ? null : count(row.recipientCount, 0, SCHOOL_BLAST_LIMITS.recipients);
  const outcomes = row.outcomes === null ? null : counts(row.outcomes, SCHOOL_BLAST_OUTCOMES);
  const deliveries = row.deliveries === null ? null : counts(row.deliveries, SCHOOL_BLAST_DELIVERY_STATES);
  // A draft has nothing queued; a handed-over blast has its counts, and every queued recipient has exactly one delivery state.
  if (status === 'DRAFT' && (queuedAt !== null || cancelledAt !== null || sendAt !== null || recipientCount !== null || outcomes || deliveries)) invalid();
  if (status === 'CANCELLED' && cancelledAt === null) invalid();
  if (status === 'QUEUED' && cancelledAt !== null) invalid();
  if (status !== 'DRAFT') {
    if (!sent || recipientCount === null || !outcomes || !deliveries || outcomes.QUEUED !== recipientCount) invalid();
    if (Object.values(deliveries).reduce((a, b) => a + b, 0) !== recipientCount) invalid();
  }
  return Object.freeze({
    blastId: uuid(row.blastId), name: row.name, channel, subject: row.subject as string | null, body: row.body, audience: audience(row.audience), status,
    version: count(row.version, 1, 999_999_999), sendAt, queuedAt, cancelledAt, recipientCount, outcomes, deliveries,
    createdAt: instant(row.createdAt), updatedAt: instant(row.updatedAt),
  });
}
export function verifySchoolBlastList(value: unknown): SchoolBlastSummary[] {
  if (!Array.isArray(value) || value.length > SCHOOL_BLAST_LIMITS.list) invalid();
  const list = value.map(item => {
    const row = record(item, ['blastId', 'name', 'channel', 'status', 'version', 'sendAt', 'queuedAt', 'recipientCount', 'updatedAt']);
    const status = oneOf(row.status, SCHOOL_BLAST_STATUSES);
    const recipientCount = row.recipientCount === null ? null : count(row.recipientCount, 0, SCHOOL_BLAST_LIMITS.recipients);
    if ((status === 'DRAFT') !== (recipientCount === null) || !schoolBlastNameOk(row.name)) invalid();
    return Object.freeze({ blastId: uuid(row.blastId), name: row.name, channel: oneOf(row.channel, SCHOOL_BLAST_CHANNELS), status,
      version: count(row.version, 1, 999_999_999), sendAt: nullableInstant(row.sendAt), queuedAt: nullableInstant(row.queuedAt), recipientCount,
      updatedAt: instant(row.updatedAt) });
  });
  if (new Set(list.map(b => b.blastId)).size !== list.length) invalid();
  return list;
}
export function verifySchoolBlastAudience(value: unknown, expected: Readonly<{ blastId: string }>): SchoolBlastAudiencePreview {
  const row = record(value, ['blastId', 'version', 'channel', 'matched', 'outcomes', 'sample']);
  const channel = oneOf(row.channel, SCHOOL_BLAST_CHANNELS);
  const outcomes = counts(row.outcomes, SCHOOL_BLAST_OUTCOMES);
  let sample: SchoolBlastAudiencePreview['sample'] = null;
  if (row.sample !== null) {
    const s = record(row.sample, ['firstName', 'subject', 'body']);
    if (typeof s.firstName !== 'string' || s.firstName.length > 200 || typeof s.body !== 'string' || s.body.length < 1 || s.body.length > 4000) invalid();
    if (channel === 'EMAIL' ? typeof s.subject !== 'string' || s.subject.length < 1 || s.subject.length > 150 : s.subject !== null) invalid();
    sample = Object.freeze({ firstName: s.firstName, subject: s.subject as string | null, body: s.body });
  }
  if ((sample === null) !== (outcomes.QUEUED === 0) || Object.values(outcomes).reduce((a, b) => a + b, 0) !== row.matched) invalid();
  const blastId = uuid(row.blastId);
  if (blastId !== expected.blastId.toLowerCase()) invalid();
  return Object.freeze({ blastId, version: count(row.version, 1, 999_999_999), channel, matched: count(row.matched, 0, 1_000_000), outcomes, sample });
}
export function verifySchoolBlastReceipt(value: unknown, expected: Readonly<{ blastId?: string | null; version: number; status: SchoolBlastStatus }>): SchoolBlastReceipt {
  const row = record(value, ['blast', 'replayed']);
  if (typeof row.replayed !== 'boolean') invalid();
  const blast = verifySchoolBlast(row.blast);
  if (blast.version !== expected.version || blast.status !== expected.status) invalid();
  if (expected.blastId && blast.blastId !== expected.blastId.toLowerCase()) invalid();
  return Object.freeze({ blast, replayed: row.replayed });
}
