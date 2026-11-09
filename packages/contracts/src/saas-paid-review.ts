/** HON OS schedule billing, piece 3 (0237): HQ review queue for money HON holds (a v1 checkout PAID_NEEDS_REVIEW, a schedule
 * payment that was not counted, late money on an ended sign-up). The HQ owner may record a refund obligation and verify the
 * provider's stored refund evidence. No provider refund is ever executed from these routes (`providerActionExecuted: false`). */
import { championsExactKeys as keys, championsIsInt as integer, championsIsTimestamp as timestamp,
  championsIsUuid as uuid, championsNullable as nullable, championsRecord as record } from './champions-club.js';

export const SAAS_PAID_REVIEW_RESOLVE_CONFIRMATION = 'RESOLVE_PAID_REVIEW_NO_PROVIDER_ACTION' as const;
export const SAAS_PAID_REVIEW_VERIFY_CONFIRMATION = 'VERIFY_RECORDED_REFUND_EVIDENCE_ONLY' as const;
export const SAAS_PAID_REVIEW_SUBJECT_KINDS = ['V1_CHECKOUT','SCHEDULE_BINDING'] as const;
export type SaasPaidReviewSubjectKind = typeof SAAS_PAID_REVIEW_SUBJECT_KINDS[number];
/** ACTIVATE and RESUME_BILLING (accepting held money without a refund) are owner decision OD-14: refused as SAAS_BILLING_POLICY_UNAVAILABLE. */
export const SAAS_PAID_REVIEW_DECISIONS = ['ACTIVATE','RESUME_BILLING','REFUND_OWED'] as const;
export type SaasPaidReviewDecision = typeof SAAS_PAID_REVIEW_DECISIONS[number];
export const SAAS_PAID_REVIEW_STATUSES = ['AWAITING_REFUND_EVIDENCE','REFUND_VERIFIED'] as const;
export type SaasPaidReviewStatus = typeof SAAS_PAID_REVIEW_STATUSES[number];
/** Why an item cannot be resolved yet; each needs an owner policy or provider follow-up outside piece 3. */
export const SAAS_PAID_REVIEW_BLOCKERS = ['NO_HELD_PAYMENT','HELD_PAYMENT_CONFLICT','DISPUTE_POLICY_REQUIRED','REVERSAL_POLICY_REQUIRED','PAYMENT_REFERENCE_MISSING'] as const;
export type SaasPaidReviewBlocker = typeof SAAS_PAID_REVIEW_BLOCKERS[number];

export interface SaasPaidReviewResolveInput {
  subjectKind: SaasPaidReviewSubjectKind; subjectId: string; expectedVersion: number; decision: SaasPaidReviewDecision; reason: string;
  confirmation: typeof SAAS_PAID_REVIEW_RESOLVE_CONFIRMATION;
}
export interface SaasPaidReviewVerifyInput { expectedVersion: number; confirmation: typeof SAAS_PAID_REVIEW_VERIFY_CONFIRMATION }

export interface SaasPaidReviewResolution {
  resolutionId: string; subjectKind: SaasPaidReviewSubjectKind; subjectId: string; organizationId: string; decision: 'REFUND_OWED';
  status: SaasPaidReviewStatus; version: number; heldItemCount: number; heldAmountMinor: number; reason: string;
  refundedAmountMinor: number | null; refundEvidence: string[]; createdAt: string; refundVerifiedAt: string | null; providerActionExecuted: false;
}
export interface SaasPaidReviewItem {
  subjectKind: SaasPaidReviewSubjectKind; subjectId: string; subjectVersion: number; organizationId: string; schoolId: string | null;
  billingStatus: string; reason: string; heldItemCount: number; heldAmountMinor: number; refundedAmountMinor: number; fullyRefunded: boolean;
  receivedAt: string | null; blocker: SaasPaidReviewBlocker | null; allowedDecisions: 'REFUND_OWED'[]; accessRetryAvailable: boolean;
  openResolution: SaasPaidReviewResolution | null; providerActionExecuted: false;
}
export interface SaasPaidReviewQueue { items: SaasPaidReviewItem[]; nextCursor: string | null; providerActionExecuted: false }
export interface SaasPaidReviewResolveReceipt { resolution: SaasPaidReviewResolution; item: SaasPaidReviewItem; replayed: boolean }
export interface SaasPaidReviewVerifyReceipt { resolution: SaasPaidReviewResolution; billingStatus: string; billingReviewOpen: boolean; replayed: boolean }

const drift = (): never => { throw new Error('SAAS_CONTRACT_DRIFT'); };
const invalid = (): never => { throw new Error('INVALID_SAAS_INPUT'); };
const CODE = /^[A-Z_]{3,80}$/;
const CURSOR = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z~[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const code = (v: unknown): v is string => typeof v === 'string' && CODE.test(v);
const money = (v: unknown, min: number) => integer(v, min, 1_000_000_000);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

export function validateSaasPaidReviewCursor(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !CURSOR.test(value)) invalid();
  return value as string;
}
export function validateSaasPaidReviewResolveInput(value: unknown): SaasPaidReviewResolveInput {
  const r = record(value, invalid); keys(r, ['subjectKind','subjectId','expectedVersion','decision','reason','confirmation'], invalid);
  if (!oneOf(SAAS_PAID_REVIEW_SUBJECT_KINDS, r.subjectKind) || !uuid(r.subjectId) || !integer(r.expectedVersion, 1, 999999999)
    || !oneOf(SAAS_PAID_REVIEW_DECISIONS, r.decision) || typeof r.reason !== 'string' || r.reason !== r.reason.trim()
    || r.reason.length < 10 || r.reason.length > 500 || r.confirmation !== SAAS_PAID_REVIEW_RESOLVE_CONFIRMATION) invalid();
  return Object.freeze({ subjectKind: r.subjectKind, subjectId: r.subjectId, expectedVersion: r.expectedVersion, decision: r.decision,
    reason: r.reason, confirmation: SAAS_PAID_REVIEW_RESOLVE_CONFIRMATION }) as SaasPaidReviewResolveInput;
}
export function validateSaasPaidReviewVerifyInput(value: unknown): SaasPaidReviewVerifyInput {
  const r = record(value, invalid); keys(r, ['expectedVersion','confirmation'], invalid);
  if (!integer(r.expectedVersion, 1, 999999999) || r.confirmation !== SAAS_PAID_REVIEW_VERIFY_CONFIRMATION) invalid();
  return Object.freeze({ expectedVersion: r.expectedVersion as number, confirmation: SAAS_PAID_REVIEW_VERIFY_CONFIRMATION });
}

function validateResolution(value: unknown): SaasPaidReviewResolution {
  const r = record(value, drift);
  keys(r, ['resolutionId','subjectKind','subjectId','organizationId','decision','status','version','heldItemCount','heldAmountMinor','reason',
    'refundedAmountMinor','refundEvidence','createdAt','refundVerifiedAt','providerActionExecuted'], drift);
  const verified = r.status === 'REFUND_VERIFIED';
  if (!uuid(r.resolutionId) || !oneOf(SAAS_PAID_REVIEW_SUBJECT_KINDS, r.subjectKind) || !uuid(r.subjectId) || !uuid(r.organizationId)
    || r.decision !== 'REFUND_OWED' || !oneOf(SAAS_PAID_REVIEW_STATUSES, r.status) || r.version !== (verified ? 2 : 1)
    || !integer(r.heldItemCount, 1, 1_000_000) || !money(r.heldAmountMinor, 100) || typeof r.reason !== 'string'
    || !Array.isArray(r.refundEvidence) || !r.refundEvidence.every(e => typeof e === 'string' && /^evt_[A-Za-z0-9_]{1,200}$/.test(e))
    || !timestamp(r.createdAt) || r.providerActionExecuted !== false
    || (verified ? !(money(r.refundedAmountMinor, 100) && r.refundedAmountMinor === r.heldAmountMinor && timestamp(r.refundVerifiedAt) && r.refundEvidence.length > 0)
      : !(r.refundedAmountMinor === null && r.refundVerifiedAt === null && r.refundEvidence.length === 0))) drift();
  return { ...(r as unknown as SaasPaidReviewResolution), refundEvidence: [...(r.refundEvidence as string[])] };
}
function validateItem(value: unknown): SaasPaidReviewItem {
  const r = record(value, drift);
  keys(r, ['subjectKind','subjectId','subjectVersion','organizationId','schoolId','billingStatus','reason','heldItemCount','heldAmountMinor',
    'refundedAmountMinor','fullyRefunded','receivedAt','blocker','allowedDecisions','accessRetryAvailable','openResolution','providerActionExecuted'], drift);
  if (!oneOf(SAAS_PAID_REVIEW_SUBJECT_KINDS, r.subjectKind) || !uuid(r.subjectId) || !integer(r.subjectVersion, 1, 999999999)
    || !uuid(r.organizationId) || !nullable(r.schoolId, uuid) || !code(r.billingStatus) || !code(r.reason)
    || !integer(r.heldItemCount, 0, 1_000_000) || !money(r.heldAmountMinor, 0) || !money(r.refundedAmountMinor, 0)
    || typeof r.fullyRefunded !== 'boolean' || !nullable(r.receivedAt, timestamp) || !(r.blocker === null || oneOf(SAAS_PAID_REVIEW_BLOCKERS, r.blocker))
    || !Array.isArray(r.allowedDecisions) || !r.allowedDecisions.every(d => d === 'REFUND_OWED')
    || typeof r.accessRetryAvailable !== 'boolean' || r.providerActionExecuted !== false
    || (r.allowedDecisions.length > 0 && (r.blocker !== null || r.openResolution !== null))) drift();
  return { ...(r as unknown as SaasPaidReviewItem), allowedDecisions: [...(r.allowedDecisions as 'REFUND_OWED'[])],
    openResolution: r.openResolution === null ? null : validateResolution(r.openResolution) };
}
export function validateSaasPaidReviewQueue(value: unknown): SaasPaidReviewQueue {
  const r = record(value, drift); keys(r, ['items','nextCursor','providerActionExecuted'], drift);
  if (!Array.isArray(r.items) || r.items.length > 50 || !(r.nextCursor === null || (typeof r.nextCursor === 'string' && CURSOR.test(r.nextCursor)))
    || r.providerActionExecuted !== false) drift();
  return { items: (r.items as unknown[]).map(validateItem), nextCursor: r.nextCursor as string | null, providerActionExecuted: false };
}
export function validateSaasPaidReviewResolveReceipt(value: unknown): SaasPaidReviewResolveReceipt {
  const r = record(value, drift); keys(r, ['resolution','item','replayed'], drift);
  if (typeof r.replayed !== 'boolean') drift();
  return { resolution: validateResolution(r.resolution), item: validateItem(r.item), replayed: r.replayed as boolean };
}
export function validateSaasPaidReviewVerifyReceipt(value: unknown): SaasPaidReviewVerifyReceipt {
  const r = record(value, drift); keys(r, ['resolution','billingStatus','billingReviewOpen','replayed'], drift);
  if (!code(r.billingStatus) || typeof r.billingReviewOpen !== 'boolean' || typeof r.replayed !== 'boolean') drift();
  const resolution = validateResolution(r.resolution); if (resolution.status !== 'REFUND_VERIFIED') drift();
  return { resolution, billingStatus: r.billingStatus as string, billingReviewOpen: r.billingReviewOpen as boolean, replayed: r.replayed as boolean };
}
