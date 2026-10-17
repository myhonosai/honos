import type { CreatePlannedAbsenceRequestInput } from './index.js';

/** Existing profile UUID is a selector only, revalidated on every human command. */
export interface ParentPlannedAbsenceRequestContext {
  children: { studentProfileId: string; displayName: string }[];
}
/** Confirms canonical request submission only, not a current review/downstream outcome. */
export interface ParentPlannedAbsenceSubmittedReceipt { status: 'SUBMITTED'; submittedAt: string }

function invalid(): never { throw new Error('Parent planned-absence response could not be verified. No submission is assumed.'); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) invalid();
  return record;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function verifyParentPlannedAbsenceRequestContext(value: unknown): ParentPlannedAbsenceRequestContext {
  const record = object(value, ['children']);
  if (!Array.isArray(record.children) || record.children.length > 100) invalid();
  const seen = new Set<string>();
  return { children: record.children.map(value => {
    const child = object(value, ['studentProfileId', 'displayName']);
    if (typeof child.studentProfileId !== 'string' || !uuid.test(child.studentProfileId) || seen.has(child.studentProfileId.toLowerCase())) invalid();
    if (typeof child.displayName !== 'string' || !child.displayName.trim() || child.displayName.trim() !== child.displayName || [...child.displayName].length > 400 || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(child.displayName)) invalid();
    seen.add(child.studentProfileId.toLowerCase());
    return { studentProfileId: child.studentProfileId.toLowerCase(), displayName: child.displayName };
  }) };
}
export function verifyParentPlannedAbsenceSubmittedReceipt(value: unknown): ParentPlannedAbsenceSubmittedReceipt {
  const record = object(value, ['status', 'submittedAt']);
  if (record.status !== 'SUBMITTED' || typeof record.submittedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.submittedAt) || !Number.isFinite(Date.parse(record.submittedAt)) || new Date(record.submittedAt).toISOString() !== record.submittedAt) invalid();
  return { status: 'SUBMITTED', submittedAt: record.submittedAt };
}
/** Transport-only exact keys; canonical service still owns time/reason validation. */
export function validateParentPlannedAbsenceRequestInput(value: unknown): asserts value is CreatePlannedAbsenceRequestInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  const required = ['studentProfileId', 'startsAt', 'endsAt'];
  if (required.some(key => !Object.hasOwn(record, key)) || Object.keys(record).some(key => ![...required, 'reason'].includes(key))) invalid();
  if (typeof record.studentProfileId !== 'string' || !uuid.test(record.studentProfileId)) invalid();
  for (const key of ['startsAt', 'endsAt']) if (typeof record[key] !== 'string' || (record[key] as string).length > 40) invalid();
  if (record.reason !== undefined && (typeof record.reason !== 'string' || !record.reason.trim() || record.reason.length > 1000)) invalid();
}
