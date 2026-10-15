import type { ParentFamilyAccessLevel } from './index.js';

/** Display-only statuses recorded on an existing absence request; none authorizes a schedule change. */
export const PARENT_PLANNED_ABSENCE_HISTORY_STATUSES = ['SUBMITTED', 'APPROVED', 'DECLINED', 'CANCELLED'] as const;
export type ParentPlannedAbsenceHistoryStatus = (typeof PARENT_PLANNED_ABSENCE_HISTORY_STATUSES)[number];

/** No request, family, school, child-profile, reviewer, version, reason, or note identifier is exposed. */
export interface ParentPlannedAbsenceHistoryItem {
  child: { displayName: string };
  startsAt: string;
  endsAt: string;
  status: ParentPlannedAbsenceHistoryStatus;
  submittedAt: string;
  reviewedAt: string | null;
}

export interface ParentPlannedAbsenceHistoryList {
  status: 'AVAILABLE';
  items: ParentPlannedAbsenceHistoryItem[];
  limited: boolean;
}

/** Fixed server-generated UTC window: prior 180 days through the next 90 days. */
export interface ParentPlannedAbsenceHistoryView {
  generatedAt: string;
  from: string;
  to: string;
  accessLevel: Exclude<ParentFamilyAccessLevel, 'VIEWER'>;
  requests: ParentPlannedAbsenceHistoryList;
}

function invalid(): never { throw new Error('Parent planned-absence history response could not be verified.'); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) invalid();
  return record;
}
function text(value: unknown, maximum = 400): string {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value || [...value].length > maximum || /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(value)) invalid();
  return value;
}
function timestamp(value: unknown): string {
  const result = text(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(result) || !Number.isFinite(Date.parse(result))) invalid();
  return new Date(result).toISOString();
}
function values<const T extends readonly string[]>(value: unknown, options: T): T[number] {
  if (typeof value !== 'string' || !options.includes(value)) invalid();
  return value as T[number];
}
function item(value: unknown, from: string, to: string, generatedAt: string): ParentPlannedAbsenceHistoryItem {
  const record = object(value, ['child', 'startsAt', 'endsAt', 'status', 'submittedAt', 'reviewedAt']);
  const child = object(record.child, ['displayName']);
  const startsAt = timestamp(record.startsAt), endsAt = timestamp(record.endsAt), submittedAt = timestamp(record.submittedAt);
  const reviewedAt = record.reviewedAt === null ? null : timestamp(record.reviewedAt);
  const status = values(record.status, PARENT_PLANNED_ABSENCE_HISTORY_STATUSES);
  if (Date.parse(endsAt) <= Date.parse(startsAt) || Date.parse(startsAt) < Date.parse(from) || Date.parse(startsAt) >= Date.parse(to) || Date.parse(submittedAt) > Date.parse(generatedAt) + 60_000) invalid();
  if ((status === 'SUBMITTED' || status === 'CANCELLED') !== (reviewedAt === null)) invalid();
  if (reviewedAt !== null && (Date.parse(reviewedAt) < Date.parse(submittedAt) || Date.parse(reviewedAt) > Date.parse(generatedAt) + 60_000)) invalid();
  return { child: { displayName: text(child.displayName, 400) }, startsAt, endsAt, status, submittedAt, reviewedAt };
}

export function verifyParentPlannedAbsenceHistoryView(value: unknown): ParentPlannedAbsenceHistoryView {
  const record = object(value, ['generatedAt', 'from', 'to', 'accessLevel', 'requests']);
  const generatedAt = timestamp(record.generatedAt), from = timestamp(record.from), to = timestamp(record.to);
  const window = Date.parse(to) - Date.parse(from);
  if (Date.parse(to) <= Date.parse(from) || window < 270 * 86_400_000 || window > 272 * 86_400_000 || Date.parse(generatedAt) < Date.parse(from) || Date.parse(generatedAt) > Date.parse(to)) invalid();
  const requests = object(record.requests, ['status', 'items', 'limited']);
  if (requests.status !== 'AVAILABLE' || typeof requests.limited !== 'boolean' || !Array.isArray(requests.items) || requests.items.length > 100) invalid();
  return {
    generatedAt,
    from,
    to,
    accessLevel: values(record.accessLevel, ['PRIMARY_GUARDIAN', 'SECONDARY_GUARDIAN']),
    requests: { status: 'AVAILABLE', items: requests.items.map(value => item(value, from, to, generatedAt)), limited: requests.limited },
  };
}
