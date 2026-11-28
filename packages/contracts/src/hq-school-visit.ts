/**
 * HQ goes inside a customer school (0696; owner, 2026-11-25: full access anytime, logged; the owner keeps money
 * settings). A visit is a 4-hour "HON HQ support" grant at one school; Leave ends it at once.
 */
export const HQ_SCHOOL_VISIT_COMMAND = 'hq-school-visit';
export const HQ_SCHOOL_VISIT_HOURS = 4;
export const HQ_SCHOOL_VISIT_REASON_MAX = 300;

export interface HqSchoolVisitEnterInput { reason?: string }
export interface HqSchoolVisitEnterReceipt {
  visitId: string; organizationId: string; schoolId: string; action: 'ENTER' | 'EXTEND';
  startedAt: string; endsAt: string; replayed: boolean;
}
export type HqSchoolVisitLeaveReceipt =
  | { schoolId: string; left: false; replayed: boolean }
  | { visitId: string; schoolId: string; left: true; leftAt: string; replayed: boolean };
export interface HqSchoolVisit { visitId: string; organizationId: string; schoolId: string; schoolName: string; startedAt: string; endsAt: string }
export interface HqSchoolVisits { visits: HqSchoolVisit[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const fail = (): never => { throw new Error('INVALID_HQ_SCHOOL_VISIT'); };
const keys = (value: object) => Object.keys(value).sort().join();
const uuid = (value: unknown) => typeof value === 'string' && UUID.test(value);
const iso = (value: unknown) => typeof value === 'string' && ISO.test(value);

export function hqSchoolVisitUuid(value: unknown): string {
  if (!uuid(value)) fail();
  return (value as string).toLowerCase();
}

/** Body of Go inside: nothing, or an optional short reason the school's log shows. */
export function validateHqSchoolVisitEnterInput(value: unknown): HqSchoolVisitEnterInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== 'reason')) fail();
  if (input.reason === undefined) return {};
  if (typeof input.reason !== 'string') return fail();
  const reason = input.reason.trim();
  if (reason.length > HQ_SCHOOL_VISIT_REASON_MAX || /[\u0000-\u001f\u007f]/.test(reason)) fail();
  return reason ? { reason } : {};
}

/** Leave takes no body fields. */
export function validateHqSchoolVisitLeaveInput(value: unknown): Record<string, never> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) fail();
  return {};
}

export function validateHqSchoolVisitEnterReceipt(value: unknown): HqSchoolVisitEnterReceipt {
  const r = value as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || keys(r) !== 'action,endsAt,organizationId,replayed,schoolId,startedAt,visitId'
    || !uuid(r.visitId) || !uuid(r.organizationId) || !uuid(r.schoolId) || (r.action !== 'ENTER' && r.action !== 'EXTEND')
    || !iso(r.startedAt) || !iso(r.endsAt) || typeof r.replayed !== 'boolean') fail();
  return r as unknown as HqSchoolVisitEnterReceipt;
}

export function validateHqSchoolVisitLeaveReceipt(value: unknown): HqSchoolVisitLeaveReceipt {
  const r = value as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || !uuid(r.schoolId) || typeof r.replayed !== 'boolean') return fail();
  if (r.left === false && keys(r) === 'left,replayed,schoolId') return r as unknown as HqSchoolVisitLeaveReceipt;
  if (r.left === true && keys(r) === 'left,leftAt,replayed,schoolId,visitId' && uuid(r.visitId) && iso(r.leftAt)) return r as unknown as HqSchoolVisitLeaveReceipt;
  return fail();
}

export function validateHqSchoolVisits(value: unknown): HqSchoolVisits {
  const v = value as { visits?: unknown } | null;
  if (!v || typeof v !== 'object' || keys(v) !== 'visits' || !Array.isArray(v.visits) || v.visits.length > 500) return fail();
  for (const row of v.visits as Record<string, unknown>[]) {
    if (!row || typeof row !== 'object' || keys(row) !== 'endsAt,organizationId,schoolId,schoolName,startedAt,visitId'
      || !uuid(row.visitId) || !uuid(row.organizationId) || !uuid(row.schoolId)
      || typeof row.schoolName !== 'string' || row.schoolName.length < 1 || row.schoolName.length > 200
      || !iso(row.startedAt) || !iso(row.endsAt)) fail();
  }
  return v as HqSchoolVisits;
}
