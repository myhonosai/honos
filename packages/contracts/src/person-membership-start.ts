/**
 * M-B (0624): start a new membership, or renew one, from a student's contact card. The server makes one DRAFT bound to the
 * exact current plan version the staff member picked, with the start date they chose and the plan's term; staff then start
 * it with the unchanged 0177 preview and confirm. One membership per program: never two overlapping in the same program, and
 * plans without a program share one group. Nothing is charged, scheduled or sent.
 */
export const PERSON_MEMBERSHIP_START_CONFIRMATION = 'I_CONFIRM_DIRECT_HUMAN_MEMBERSHIP_FROM_PLAN' as const;
export const PERSON_MEMBERSHIP_START_READ_COMMAND = 'billing.membership.start_options.read' as const;
export const PERSON_MEMBERSHIP_START_COMMAND = 'billing.membership.start_from_plan' as const;
/** Blockers that apply to every plan (read and command), and those only the command can find for one plan and date. */
export const PERSON_MEMBERSHIP_PERSON_BLOCKERS = ['NO_STUDENT_RECORD', 'CONTACT_ARCHIVED'] as const;
export const PERSON_MEMBERSHIP_START_BLOCKERS = [...PERSON_MEMBERSHIP_PERSON_BLOCKERS, 'PLAN_UNAVAILABLE', 'START_DATE_OUT_OF_RANGE',
  'PAYER_NO_GUARDIAN', 'PAYER_CHOOSE_PAYER', 'PAYER_NOT_ALLOWED', 'PLAN_CURRENCY_MISMATCH', 'RENEWAL_NOT_ALLOWED', 'DRAFT_IN_PROGRAM',
  'OVERLAPS_CURRENT_MEMBERSHIP'] as const;
export const PERSON_MEMBERSHIP_PAYER_PROBLEMS = ['NO_GUARDIAN', 'CHOOSE_PAYER'] as const;
export const PERSON_MEMBERSHIP_STATES = ['DRAFT', 'ACTIVE', 'FROZEN', 'CANCELLATION_PENDING', 'CANCELLED', 'EXPIRED'] as const;
export type PersonMembershipPersonBlocker = typeof PERSON_MEMBERSHIP_PERSON_BLOCKERS[number];
export type PersonMembershipStartBlocker = typeof PERSON_MEMBERSHIP_START_BLOCKERS[number];
export type PersonMembershipPayerProblem = typeof PERSON_MEMBERSHIP_PAYER_PROBLEMS[number];
export type PersonMembershipKind = 'NEW' | 'RENEW';

export interface PersonMembershipPayer { personId: string; givenName: string; familyName: string; relation: 'SELF' | 'GUARDIAN'; billingContact: boolean }
export interface PersonMembershipItem {
  membershipId: string; state: typeof PERSON_MEMBERSHIP_STATES[number]; planCode: string; programId: string | null;
  startDate: string | null; endDate: string | null; renewable: boolean; renewStartDate: string | null;
}
export interface PersonMembershipStartOptions {
  personId: string; schoolToday: string; schoolTimezone: string; minor: boolean; blockers: PersonMembershipPersonBlocker[];
  payers: PersonMembershipPayer[]; defaultPayerPersonId: string | null; payerProblem: PersonMembershipPayerProblem | null; memberships: PersonMembershipItem[];
}
export interface PersonMembershipStartInput {
  personId: string; membershipPlanId: string; membershipPlanVersion: number; kind: PersonMembershipKind; renewsMembershipId: string | null;
  startDate: string; payerPersonId: string | null; confirmation: typeof PERSON_MEMBERSHIP_START_CONFIRMATION;
}
export interface PersonMembershipStartReceipt {
  membershipId: string; state: 'DRAFT'; personId: string; kind: PersonMembershipKind; renewsMembershipId: string | null;
  membershipPlanId: string; membershipPlanVersion: number; planCode: string; programId: string | null; payerPersonId: string; billingAccountId: string;
  startDate: string; endDate: string | null; termStartedAt: string; termEndsAt: string | null; recordedAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UNSAFE = /[\x00-\x1f\x7f-\x9f]/;
function fail(): never { throw new Error('Unverified membership start.'); }
function bad(): never { throw new Error('VALIDATION_FAILED'); }
function exact(value: unknown, keys: readonly string[], onFail: () => never = fail): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) onFail();
  const source = value as Record<string, unknown>;
  if (Object.keys(source).length !== keys.length || keys.some(key => !Object.hasOwn(source, key))) onFail();
  return source;
}
const id = (v: unknown, onFail: () => never = fail): string => { if (typeof v !== 'string' || !UUID.test(v)) onFail(); return v as string; };
const maybeId = (v: unknown, onFail: () => never = fail): string | null => v === null ? null : id(v, onFail);
/** A real calendar day written YYYY-MM-DD. */
export function isCalendarDate(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
const date = (v: unknown, onFail: () => never = fail): string => { if (!isCalendarDate(v)) onFail(); return v as string; };
const maybeDate = (v: unknown): string | null => v === null ? null : date(v);
const instant = (v: unknown): string => { if (typeof v !== 'string' || !INSTANT.test(v) || Number.isNaN(Date.parse(v))) fail(); return v; };
const text = (v: unknown, max: number): string => { if (typeof v !== 'string' || !v || v.length > max || UNSAFE.test(v)) fail(); return v; };
const bool = (v: unknown): boolean => { if (typeof v !== 'boolean') fail(); return v; };
function codes<T extends string>(v: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(v) || v.length > allowed.length || new Set(v).size !== v.length || v.some(x => !(allowed as readonly unknown[]).includes(x))) fail();
  return v as T[];
}

export function validatePersonMembershipStartInput(value: unknown): PersonMembershipStartInput {
  const v = exact(value, ['personId', 'membershipPlanId', 'membershipPlanVersion', 'kind', 'renewsMembershipId', 'startDate', 'payerPersonId', 'confirmation'], bad);
  if (typeof v.membershipPlanVersion !== 'number' || !Number.isSafeInteger(v.membershipPlanVersion) || v.membershipPlanVersion < 1 || v.membershipPlanVersion > 999_999) bad();
  if (v.kind !== 'NEW' && v.kind !== 'RENEW') bad();
  const renewsMembershipId = maybeId(v.renewsMembershipId, bad);
  if ((v.kind === 'RENEW') !== (renewsMembershipId !== null)) bad();
  if (v.confirmation !== PERSON_MEMBERSHIP_START_CONFIRMATION) bad();
  return { personId: id(v.personId, bad), membershipPlanId: id(v.membershipPlanId, bad), membershipPlanVersion: v.membershipPlanVersion as number,
    kind: v.kind, renewsMembershipId, startDate: date(v.startDate, bad), payerPersonId: maybeId(v.payerPersonId, bad), confirmation: PERSON_MEMBERSHIP_START_CONFIRMATION };
}

function payer(v: unknown): PersonMembershipPayer {
  const p = exact(v, ['personId', 'givenName', 'familyName', 'relation', 'billingContact']);
  if (p.relation !== 'SELF' && p.relation !== 'GUARDIAN') fail();
  return { personId: id(p.personId), givenName: text(p.givenName, 200), familyName: text(p.familyName, 200), relation: p.relation, billingContact: bool(p.billingContact) };
}
function item(v: unknown): PersonMembershipItem {
  const m = exact(v, ['membershipId', 'state', 'planCode', 'programId', 'startDate', 'endDate', 'renewable', 'renewStartDate']);
  if (!(PERSON_MEMBERSHIP_STATES as readonly unknown[]).includes(m.state)) fail();
  const out: PersonMembershipItem = { membershipId: id(m.membershipId), state: m.state as PersonMembershipItem['state'], planCode: text(m.planCode, 200),
    programId: maybeId(m.programId), startDate: maybeDate(m.startDate), endDate: maybeDate(m.endDate), renewable: bool(m.renewable), renewStartDate: maybeDate(m.renewStartDate) };
  if (out.renewable && (out.endDate === null || out.renewStartDate === null || !['ACTIVE', 'FROZEN', 'CANCELLATION_PENDING', 'EXPIRED'].includes(out.state))) fail();
  if ((out.endDate === null) !== (out.renewStartDate === null)) fail();
  return out;
}

export function verifyPersonMembershipStartOptions(value: unknown, personId: string): PersonMembershipStartOptions {
  const s = exact(value, ['personId', 'schoolToday', 'schoolTimezone', 'minor', 'blockers', 'payers', 'defaultPayerPersonId', 'payerProblem', 'memberships']);
  if (id(s.personId) !== personId || !Array.isArray(s.payers) || s.payers.length > 50 || !Array.isArray(s.memberships) || s.memberships.length > 500) fail();
  const payers = s.payers.map(payer);
  if (new Set(payers.map(p => p.personId)).size !== payers.length || payers.filter(p => p.relation === 'SELF').some(p => p.personId !== personId)) fail();
  const defaultPayerPersonId = maybeId(s.defaultPayerPersonId);
  const payerProblem = s.payerProblem === null ? null : (PERSON_MEMBERSHIP_PAYER_PROBLEMS as readonly unknown[]).includes(s.payerProblem) ? s.payerProblem as PersonMembershipPayerProblem : fail();
  if (defaultPayerPersonId !== null && (payerProblem !== null || !payers.some(p => p.personId === defaultPayerPersonId))) fail();
  const memberships = s.memberships.map(item);
  if (new Set(memberships.map(m => m.membershipId)).size !== memberships.length) fail();
  return { personId, schoolToday: date(s.schoolToday), schoolTimezone: text(s.schoolTimezone, 64), minor: bool(s.minor),
    blockers: codes(s.blockers, PERSON_MEMBERSHIP_PERSON_BLOCKERS), payers, defaultPayerPersonId, payerProblem, memberships };
}

export function verifyPersonMembershipStartReceipt(value: unknown, input: PersonMembershipStartInput): PersonMembershipStartReceipt {
  const r = exact(value, ['membershipId', 'state', 'personId', 'kind', 'renewsMembershipId', 'membershipPlanId', 'membershipPlanVersion', 'planCode', 'programId',
    'payerPersonId', 'billingAccountId', 'startDate', 'endDate', 'termStartedAt', 'termEndsAt', 'recordedAt']);
  if (r.state !== 'DRAFT' || r.personId !== input.personId || r.kind !== input.kind || r.renewsMembershipId !== input.renewsMembershipId
    || r.membershipPlanId !== input.membershipPlanId || r.membershipPlanVersion !== input.membershipPlanVersion || r.startDate !== input.startDate
    || (input.payerPersonId !== null && r.payerPersonId !== input.payerPersonId)) fail();
  const endDate = maybeDate(r.endDate);
  if (endDate !== null && endDate < input.startDate) fail();
  const termEndsAt = r.termEndsAt === null ? null : instant(r.termEndsAt);
  if ((endDate === null) !== (termEndsAt === null)) fail();
  return { membershipId: id(r.membershipId), state: 'DRAFT', personId: input.personId, kind: input.kind, renewsMembershipId: input.renewsMembershipId,
    membershipPlanId: input.membershipPlanId, membershipPlanVersion: input.membershipPlanVersion, planCode: text(r.planCode, 200), programId: maybeId(r.programId),
    payerPersonId: id(r.payerPersonId), billingAccountId: id(r.billingAccountId), startDate: input.startDate, endDate,
    termStartedAt: instant(r.termStartedAt), termEndsAt, recordedAt: instant(r.recordedAt) };
}
