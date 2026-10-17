import type { CommandContext, DecidePlannedAbsenceRequestInput, PlannedAbsenceReviewDecision } from './index.js';

export interface PlannedAbsenceReviewContext extends CommandContext { externalSubject: string }
export interface PlannedAbsenceReviewQueueItem {
  id: string;
  studentProfileId: string;
  startsAt: string;
  endsAt: string;
  reason: string | null;
  version: number;
  submittedAt: string;
}
export interface PlannedAbsenceReviewQueue {
  organizationId: string;
  schoolId: string;
  items: PlannedAbsenceReviewQueueItem[];
}
/** The staff browser does not receive reviewer identity or private review note. */
export interface PlannedAbsenceDecisionReceipt { id: string; status: PlannedAbsenceReviewDecision; version: number; reviewedAt: string }

function invalid(): never { throw new Error('The planned-absence review response could not be verified. No decision is assumed.'); }
function closed(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) invalid();
  return record;
}
export function plannedAbsenceReviewUuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) invalid();
  return value.toLowerCase();
}
function version(value: unknown, maximum = 2_147_483_646): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) invalid();
  return Number(value);
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}
export function validatePlannedAbsenceReviewInput(value: unknown): asserts value is DecidePlannedAbsenceRequestInput {
  const input = closed(value, ['decision', 'reviewNote', 'expectedVersion']);
  if (!['APPROVED','DECLINED'].includes(String(input.decision)) || typeof input.decision !== 'string'
    || typeof input.reviewNote !== 'string' || !input.reviewNote.trim() || input.reviewNote.length > 1000) invalid();
  version(input.expectedVersion);
}
export function verifyPlannedAbsenceReviewQueue(value: unknown): PlannedAbsenceReviewQueue {
  const data = closed(value, ['organizationId','schoolId','items']);
  const organizationId = plannedAbsenceReviewUuid(data.organizationId), schoolId = plannedAbsenceReviewUuid(data.schoolId);
  if (!Array.isArray(data.items) || data.items.length > 50) invalid();
  const seen = new Set<string>();
  const items = data.items.map(value => {
    const item = closed(value, ['id','studentProfileId','startsAt','endsAt','reason','version','submittedAt']);
    const id = plannedAbsenceReviewUuid(item.id), studentProfileId = plannedAbsenceReviewUuid(item.studentProfileId);
    const startsAt = timestamp(item.startsAt), endsAt = timestamp(item.endsAt), submittedAt = timestamp(item.submittedAt);
    if (seen.has(id) || Date.parse(endsAt) <= Date.parse(startsAt) || item.reason !== null && (typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 1000)) invalid();
    seen.add(id);
    return { id, studentProfileId, startsAt, endsAt, reason: item.reason as string | null, version: version(item.version), submittedAt };
  });
  return { organizationId, schoolId, items };
}
export function verifyPlannedAbsenceDecisionReceipt(value: unknown): PlannedAbsenceDecisionReceipt {
  const data = closed(value, ['id','status','version','reviewedAt']);
  if (typeof data.status !== 'string' || !['APPROVED','DECLINED'].includes(data.status)) invalid();
  return { id: plannedAbsenceReviewUuid(data.id), status: data.status as PlannedAbsenceReviewDecision, version: version(data.version, 2_147_483_647), reviewedAt: timestamp(data.reviewedAt) };
}
