// B-HQ-1 HQ access overview (migration 0219 proposed): one read-only HQ list of every organization's access standing,
// its open D9 exception, subscription, open checkout, latest school-owner invitation and the advisory exception-grant
// eligibility. HQ owner, or HQ operator with hq.billing.manage. Writes nothing; every command still decides again in
// the database. `viewer.canGrantAndRevokeExceptions` is true only for a current HQ owner (D9).
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsInt as isInt,
  championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsNullable as nullable, championsRecord as record } from './champions-club.js';
import { SAAS_ACCESS_EXCEPTION_PURPOSES, type SaasAccessExceptionLifecycle, type SaasAccessExceptionPurpose } from './saas-paid-access.js';
import { SAAS_ORGANIZATION_ACCESS_STATES, validateSaasEntitlementView, type SaasEntitlementView,
  type SaasOrganizationAccessState } from './saas-school-billing.js';

const has = (list: readonly unknown[], value: unknown) => list.includes(value);
// Display names are unconstrained text in the database; the read truncates them to 300 characters.
const label = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const code = (v: unknown): v is string => typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,59}$/.test(v);

export const SAAS_ACCESS_OVERVIEW_STATUSES = ['AWAITING_FIRST_PAYMENT','EXCEPTION_IN_EFFECT','EXCEPTION_SCHEDULED','PAID_ACCESS',
  'PROVISIONED_ACCESS','NO_ACCESS'] as const;
export type SaasAccessOverviewStatus = typeof SAAS_ACCESS_OVERVIEW_STATUSES[number];
/** In the order hon.grant_saas_access_exception refuses them. */
export const SAAS_EXCEPTION_GRANT_BLOCKERS = ['ORGANIZATION_NOT_ACTIVE','NO_ACTIVE_SCHOOL','NO_ENTITLEMENT','EXCEPTION_POLICY_REQUIRED',
  'ACCESS_EXCEPTION_ACTIVE','ENTITLEMENT_IN_EFFECT','ACCESS_STATE_EXISTS','SUBSCRIPTION_EXISTS','CHECKOUT_OPEN'] as const;
export type SaasExceptionGrantBlocker = typeof SAAS_EXCEPTION_GRANT_BLOCKERS[number];
export const SAAS_OWNER_ONBOARDING_STATUSES = ['NOT_INVITED','PENDING','EXPIRED','ACCEPTED','REVOKED'] as const;
export type SaasOwnerOnboardingStatus = typeof SAAS_OWNER_ONBOARDING_STATUSES[number];
const OPEN_LIFECYCLES: readonly SaasAccessExceptionLifecycle[] = ['SCHEDULED','IN_EFFECT','EXPIRED','SUPERSEDED'];

// ---------- query ----------
export interface SaasAccessOverviewCursor { createdAt: string; organizationId: string }
export interface SaasAccessOverviewQuery { status: SaasAccessOverviewStatus | null; cursor: SaasAccessOverviewCursor | null; limit: number }
/** `?cursor=` value for the next page: `<createdAt>~<organizationId>` from the previous page's `nextCursor`. */
export function encodeSaasAccessOverviewCursor(cursor: SaasAccessOverviewCursor): string {
  return `${cursor.createdAt}~${cursor.organizationId}`;
}
export function validateSaasAccessOverviewQuery(value: unknown): SaasAccessOverviewQuery {
  const q = record(value ?? {}, invalid);
  if (Object.keys(q).some(k => !['status','cursor','limit'].includes(k))) invalid();
  const one = (v: unknown): string | null => (v === undefined ? null : typeof v === 'string' ? v : invalid());
  const status = one(q.status), cursor = one(q.cursor), limit = one(q.limit);
  if ((status !== null && !has(SAAS_ACCESS_OVERVIEW_STATUSES, status)) || (limit !== null && !/^(?:[1-9]\d?|100)$/.test(limit))) invalid();
  let decoded: SaasAccessOverviewCursor | null = null;
  if (cursor !== null) {
    if (cursor.length > 80) invalid();
    const [createdAt, organizationId, ...rest] = cursor.split('~');
    if (rest.length || !isTimestamp(createdAt) || !isUuid(organizationId)) invalid();
    decoded = { createdAt: createdAt as string, organizationId: organizationId as string };
  }
  return { status: status as SaasAccessOverviewStatus | null, cursor: decoded, limit: limit === null ? 50 : Number(limit) };
}

// ---------- response ----------
export interface SaasAccessOverviewException {
  exceptionId: string; schoolId: string; purpose: SaasAccessExceptionPurpose; scopeTier: 'CORE' | 'COMPLETE'; startsAt: string; expiresAt: string;
  lifecycle: Exclude<SaasAccessExceptionLifecycle, 'REVOKED'>; revocable: boolean;
}
export interface SaasAccessOverviewOrganization {
  organizationId: string; organizationDisplayName: string; organizationStatus: string; createdAt: string;
  schools: { schoolId: string; schoolDisplayName: string; schoolStatus: string }[]; schoolCount: number;
  entitlement: SaasEntitlementView | null; accessState: SaasOrganizationAccessState; accessStatus: SaasAccessOverviewStatus;
  currentException: SaasAccessOverviewException | null;
  subscription: { subscriptionId: string; status: string; planCode: 'ESSENTIAL' | 'CORE' | 'COMPLETE'; billingInterval: string } | null;
  openCheckout: boolean;
  ownerOnboarding: { status: SaasOwnerOnboardingStatus; invitedAt: string | null; expiresAt: string | null; acceptedAt: string | null };
  exceptionGrant: { eligible: boolean; blockers: SaasExceptionGrantBlocker[]; expectedEntitlementVersion: number | null };
}
export interface SaasAccessOverview {
  viewer: { canGrantAndRevokeExceptions: boolean };
  paidAccessProgram: 'INACTIVE' | 'ACTIVE';
  exceptionPolicy: { ready: boolean; maxDays: number | null; validUntil: string | null; maxScheduleAheadDays: 30 };
  summary: Record<SaasAccessOverviewStatus, number> & { total: number };
  organizations: SaasAccessOverviewOrganization[];
  limit: number; nextCursor: SaasAccessOverviewCursor | null; asOf: string;
}

function organization(value: unknown, policyReady: boolean): SaasAccessOverviewOrganization {
  const o = record(value, drift);
  exactKeys(o, ['organizationId','organizationDisplayName','organizationStatus','createdAt','schools','schoolCount','entitlement','accessState',
    'accessStatus','currentException','subscription','openCheckout','ownerOnboarding','exceptionGrant'], drift);
  validateSaasEntitlementView(o.entitlement);
  const ent = o.entitlement as SaasEntitlementView | null;
  if (!isUuid(o.organizationId) || !label(o.organizationDisplayName, 300) || !code(o.organizationStatus) || !isTimestamp(o.createdAt)
    || !Array.isArray(o.schools) || o.schools.length > 10 || !isInt(o.schoolCount, 0, 1_000_000) || o.schools.length > (o.schoolCount as number)
    || !has(SAAS_ORGANIZATION_ACCESS_STATES, o.accessState) || !has(SAAS_ACCESS_OVERVIEW_STATUSES, o.accessStatus)
    || (o.accessState === 'NONE' && ent !== null) || typeof o.openCheckout !== 'boolean') drift();
  for (const s of o.schools as unknown[]) {
    const r = record(s, drift); exactKeys(r, ['schoolId','schoolDisplayName','schoolStatus'], drift);
    if (!isUuid(r.schoolId) || !label(r.schoolDisplayName, 300) || !code(r.schoolStatus)) drift();
  }
  // Exception summary.
  const x = o.currentException === null ? null : record(o.currentException, drift);
  if (x) {
    exactKeys(x, ['exceptionId','schoolId','purpose','scopeTier','startsAt','expiresAt','lifecycle','revocable'], drift);
    if (!isUuid(x.exceptionId) || !isUuid(x.schoolId) || !has(SAAS_ACCESS_EXCEPTION_PURPOSES, x.purpose) || !has(['CORE','COMPLETE'], x.scopeTier)
      || !isTimestamp(x.startsAt) || !isTimestamp(x.expiresAt) || Date.parse(x.expiresAt as string) <= Date.parse(x.startsAt as string)
      || !has(OPEN_LIFECYCLES, x.lifecycle) || x.revocable !== (x.lifecycle === 'IN_EFFECT' || x.lifecycle === 'SCHEDULED')) drift();
  }
  // Status is derived from the facts shown; the first matching rule wins.
  const inEffect = ent?.inEffect === true;
  const expected = o.accessState === 'AWAITING_FIRST_PAYMENT' ? 'AWAITING_FIRST_PAYMENT'
    : x?.lifecycle === 'IN_EFFECT' && inEffect ? 'EXCEPTION_IN_EFFECT'
    : x?.lifecycle === 'SCHEDULED' ? 'EXCEPTION_SCHEDULED'
    : inEffect && o.accessState === 'PAYMENT_ACTIVE' ? 'PAID_ACCESS'
    : inEffect ? 'PROVISIONED_ACCESS' : 'NO_ACCESS';
  if (o.accessStatus !== expected) drift();
  // Subscription.
  if (o.subscription !== null) {
    const s = record(o.subscription, drift); exactKeys(s, ['subscriptionId','status','planCode','billingInterval'], drift);
    if (!isUuid(s.subscriptionId) || !code(s.status) || s.status === 'VOIDED' || !has(['ESSENTIAL','CORE','COMPLETE'], s.planCode) || !code(s.billingInterval)) drift();
  }
  // Owner onboarding: never an email address or token.
  const ob = record(o.ownerOnboarding, drift); exactKeys(ob, ['status','invitedAt','expiresAt','acceptedAt'], drift);
  if (!has(SAAS_OWNER_ONBOARDING_STATUSES, ob.status) || !nullable(ob.invitedAt, isTimestamp) || !nullable(ob.expiresAt, isTimestamp)
    || !nullable(ob.acceptedAt, isTimestamp) || (ob.status === 'NOT_INVITED') !== (ob.invitedAt === null) || (ob.invitedAt === null) !== (ob.expiresAt === null)
    // An accepted invitation that HQ later revoked keeps its acceptance time.
    || (ob.status === 'ACCEPTED' && ob.acceptedAt === null) || (ob.acceptedAt !== null && ob.status !== 'ACCEPTED' && ob.status !== 'REVOKED')) drift();
  // Advisory grant eligibility; must agree with the facts above.
  const g = record(o.exceptionGrant, drift); exactKeys(g, ['eligible','blockers','expectedEntitlementVersion'], drift);
  if (!Array.isArray(g.blockers)) drift();
  const blockers = g.blockers as unknown[];
  if (typeof g.eligible !== 'boolean' || blockers.some(b => !has(SAAS_EXCEPTION_GRANT_BLOCKERS, b))
    || new Set(blockers).size !== blockers.length
    || blockers.join(',') !== SAAS_EXCEPTION_GRANT_BLOCKERS.filter(b => blockers.includes(b)).join(',')
    || g.eligible !== (blockers.length === 0)
    || g.expectedEntitlementVersion !== (ent?.version ?? null)
    || (ent === null) !== blockers.includes('NO_ENTITLEMENT')
    || policyReady === blockers.includes('EXCEPTION_POLICY_REQUIRED')
    || inEffect !== blockers.includes('ENTITLEMENT_IN_EFFECT')
    || (o.accessState === 'AWAITING_FIRST_PAYMENT' || o.accessState === 'PAYMENT_ACTIVE') !== blockers.includes('ACCESS_STATE_EXISTS')
    || (o.subscription !== null) !== blockers.includes('SUBSCRIPTION_EXISTS')
    || o.openCheckout !== blockers.includes('CHECKOUT_OPEN')
    || (o.organizationStatus !== 'ACTIVE') !== blockers.includes('ORGANIZATION_NOT_ACTIVE')
    // A scheduled or in-effect exception is exactly what the command refuses as an active exception.
    || (x?.revocable === true) !== blockers.includes('ACCESS_EXCEPTION_ACTIVE')) drift();
  return o as unknown as SaasAccessOverviewOrganization;
}

export function validateSaasAccessOverview(value: unknown): SaasAccessOverview {
  const r = record(value, drift);
  exactKeys(r, ['viewer','paidAccessProgram','exceptionPolicy','summary','organizations','limit','nextCursor','asOf'], drift);
  const v = record(r.viewer, drift); exactKeys(v, ['canGrantAndRevokeExceptions'], drift);
  const p = record(r.exceptionPolicy, drift); exactKeys(p, ['ready','maxDays','validUntil','maxScheduleAheadDays'], drift);
  const s = record(r.summary, drift); exactKeys(s, [...SAAS_ACCESS_OVERVIEW_STATUSES, 'total'], drift);
  if (typeof v.canGrantAndRevokeExceptions !== 'boolean' || !has(['INACTIVE','ACTIVE'], r.paidAccessProgram)
    || typeof p.ready !== 'boolean' || p.maxScheduleAheadDays !== 30
    || (p.ready ? !isInt(p.maxDays, 1, 90) || !isTimestamp(p.validUntil) : p.maxDays !== null || p.validUntil !== null)
    || Object.values(s).some(n => !isInt(n, 0, Number.MAX_SAFE_INTEGER))
    || SAAS_ACCESS_OVERVIEW_STATUSES.reduce((t, k) => t + (s[k] as number), 0) !== s.total
    || !isInt(r.limit, 1, 100) || !Array.isArray(r.organizations) || r.organizations.length > (r.limit as number)
    || r.organizations.length > (s.total as number) || !isTimestamp(r.asOf)) drift();
  const orgs = (r.organizations as unknown[]).map(o => organization(o, p.ready as boolean));
  for (let i = 1; i < orgs.length; i++) {
    const a = orgs[i - 1]!, b = orgs[i]!;
    if (a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.organizationId >= b.organizationId)) drift();
  }
  if (r.nextCursor !== null) {
    const c = record(r.nextCursor, drift); exactKeys(c, ['createdAt','organizationId'], drift);
    const last = orgs.at(-1);
    if (!last || orgs.length !== r.limit || c.createdAt !== last.createdAt || c.organizationId !== last.organizationId) drift();
  }
  return r as unknown as SaasAccessOverview;
}

// ---------- C-HQ-3 HQ school detail (migration 0225 proposed) ----------
export interface HqInvitationCounts { pending: number; expired: number; accepted: number; revoked: number; ended: number }
export interface HqSchoolDetail {
  school: { schoolId: string; schoolDisplayName: string; slug: string; timezone: string; schoolStatus: string; createdAt: string };
  organization: SaasAccessOverviewOrganization;
  exceptionPolicyReady: boolean;
  ownership: { ownerCount: number; primaryOwnerGrantId: string | null; primaryNeeded: boolean; hqSeatCount: number };
  invitations: { owner: HqInvitationCounts; staff: HqInvitationCounts; family: HqInvitationCounts };
  people: { staffWithAccess: number; familyMembersWithAccess: number; activeStudents: number };
  viewer: { canGrantAndRevokeExceptions: boolean; canManageOwnership: boolean };
  asOf: string;
}
const COUNT_MAX = 10_000_000;
function invitationCounts(value: unknown, kind: 'OWNER' | 'STAFF' | 'FAMILY'): HqInvitationCounts {
  const c = record(value, drift); exactKeys(c, ['pending','expired','accepted','revoked','ended'], drift);
  if (Object.values(c).some(n => !isInt(n, 0, COUNT_MAX)) || (kind !== 'FAMILY' && c.ended !== 0)) drift();
  return c as unknown as HqInvitationCounts;
}
/** One school for HQ: names, statuses and counts only; never a person's name, email, birth date or token. */
export function validateHqSchoolDetail(value: unknown): HqSchoolDetail {
  const r = record(value, drift);
  exactKeys(r, ['school','organization','exceptionPolicyReady','ownership','invitations','people','viewer','asOf'], drift);
  const s = record(r.school, drift); exactKeys(s, ['schoolId','schoolDisplayName','slug','timezone','schoolStatus','createdAt'], drift);
  if (!isUuid(s.schoolId) || !label(s.schoolDisplayName, 300) || !label(s.slug, 300) || !label(s.timezone, 100) || !code(s.schoolStatus)
    || !isTimestamp(s.createdAt) || typeof r.exceptionPolicyReady !== 'boolean' || !isTimestamp(r.asOf)) drift();
  const org = organization(r.organization, r.exceptionPolicyReady as boolean);
  if (org.schools.length < org.schoolCount ? false : !org.schools.some(x => x.schoolId === s.schoolId)) drift();
  const o = record(r.ownership, drift); exactKeys(o, ['ownerCount','primaryOwnerGrantId','primaryNeeded','hqSeatCount'], drift);
  if (!isInt(o.ownerCount, 0, COUNT_MAX) || !isInt(o.hqSeatCount, 0, COUNT_MAX) || !nullable(o.primaryOwnerGrantId, isUuid)
    || o.primaryNeeded !== ((o.ownerCount as number) > 0 && o.primaryOwnerGrantId === null)
    || (o.primaryOwnerGrantId !== null && o.ownerCount === 0)) drift();
  const i = record(r.invitations, drift); exactKeys(i, ['owner','staff','family'], drift);
  invitationCounts(i.owner, 'OWNER'); invitationCounts(i.staff, 'STAFF'); invitationCounts(i.family, 'FAMILY');
  const p = record(r.people, drift); exactKeys(p, ['staffWithAccess','familyMembersWithAccess','activeStudents'], drift);
  if (Object.values(p).some(n => !isInt(n, 0, COUNT_MAX))) drift();
  const v = record(r.viewer, drift); exactKeys(v, ['canGrantAndRevokeExceptions','canManageOwnership'], drift);
  if (typeof v.canGrantAndRevokeExceptions !== 'boolean' || v.canManageOwnership !== v.canGrantAndRevokeExceptions) drift();
  return r as unknown as HqSchoolDetail;
}
