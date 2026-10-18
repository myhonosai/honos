// HON Champions Club (Milestone 1) closed contracts. Recordkeeping only: no contract here
// carries a credit, free month, lifetime membership, prize, payment, refund or message.
export type ChampionsAttributionState = 'PENDING' | 'QUALIFIED' | 'REJECTED' | 'REFUNDED' | 'REVERSED';
export type ChampionsStateReason = 'CAPTURED' | 'QUALIFICATION_VERIFIED' | 'DUPLICATE_ACCOUNT' | 'SELF_REFERRAL' | 'FRAUD_SUSPECTED'
  | 'NOT_ELIGIBLE' | 'ATTRIBUTION_EXPIRED' | 'DISPUTE_RESOLVED' | 'REFUND_ISSUED' | 'PAYMENT_REVERSED' | 'SUBSCRIPTION_CANCELLED';
export type ChampionsPaymentVerificationSource = 'UNDECIDED' | 'HON_BILLING' | 'HQ_OWNER_ATTESTATION';
export type ChampionsPolicyStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED';
/** Pinned by database constraint until billing integration and owner approval. */
export type ChampionsFinancialRewards = 'DISABLED';

export const CHAMPIONS_ATTRIBUTION_STATES: readonly ChampionsAttributionState[] = ['PENDING','QUALIFIED','REJECTED','REFUNDED','REVERSED'];
export const CHAMPIONS_STATE_REASONS: readonly ChampionsStateReason[] = ['CAPTURED','QUALIFICATION_VERIFIED','DUPLICATE_ACCOUNT','SELF_REFERRAL',
  'FRAUD_SUSPECTED','NOT_ELIGIBLE','ATTRIBUTION_EXPIRED','DISPUTE_RESOLVED','REFUND_ISSUED','PAYMENT_REVERSED','SUBSCRIPTION_CANCELLED'];
export const CHAMPIONS_REJECT_REASONS = ['DUPLICATE_ACCOUNT','SELF_REFERRAL','FRAUD_SUSPECTED','NOT_ELIGIBLE','ATTRIBUTION_EXPIRED','DISPUTE_RESOLVED'] as const;
export const CHAMPIONS_REVERSE_REASONS = ['PAYMENT_REVERSED','SUBSCRIPTION_CANCELLED','FRAUD_SUSPECTED','DISPUTE_RESOLVED'] as const;
/** Human-command header values, one per command route. */
export const CHAMPIONS_COMMANDS = {
  issueReferralCode: 'champions-referral-code-issue',
  createPolicyDraft: 'champions-policy-draft',
  publishPolicy: 'champions-policy-publish',
  captureAttribution: 'champions-attribution-capture',
  decideAttribution: 'champions-attribution-decide',
} as const;
export type ChampionsCommand = typeof CHAMPIONS_COMMANDS[keyof typeof CHAMPIONS_COMMANDS];

export interface ChampionsReferralCode { code: string; status: 'ACTIVE'; issuedAt: string }
export interface ChampionsReferralCodeReceipt extends ChampionsReferralCode { schoolId: string; created: boolean; replayed: boolean }
export interface ChampionsReferralCounts { pending: number; qualified: number; rejected: number; refunded: number; reversed: number }
export interface ChampionsSchoolView {
  schoolId: string;
  referralCode: ChampionsReferralCode | null;
  program: { status: 'POLICY_UNDECIDED' | 'PUBLISHED'; policyVersion: number | null; financialRewards: ChampionsFinancialRewards };
  referrals: ChampionsReferralCounts;
}
export interface ChampionsPolicyTerms {
  attributionWindowDays: number | null; refundWindowDays: number | null; minimumPaidDays: number | null; minimumPaidInvoices: number | null;
  paymentVerificationSource: ChampionsPaymentVerificationSource; welcomeCreditMinor: number | null; termsReference: string | null;
}
export type ChampionsPolicyDraftInput = ChampionsPolicyTerms;
export interface ChampionsPolicy extends ChampionsPolicyTerms {
  policyId: string; policyVersion: number; status: ChampionsPolicyStatus; currency: 'USD'; financialRewards: ChampionsFinancialRewards;
  createdAt: string; publishedAt: string | null;
}
export interface ChampionsProgram { published: ChampionsPolicy | null; drafts: ChampionsPolicy[]; financialRewards: ChampionsFinancialRewards }
export interface ChampionsPolicyDraftReceipt { policy: ChampionsPolicy; replayed: boolean }
export interface ChampionsPolicyPublishReceipt { policy: ChampionsPolicy; retiredPolicyId: string | null; replayed: boolean }
export interface ChampionsAttribution {
  attributionId: string; state: ChampionsAttributionState; stateReason: ChampionsStateReason; version: number;
  referrerOrganizationId: string; referrerSchoolId: string; referrerSchoolName: string;
  referredOrganizationId: string; referredOrganizationName: string;
  capturedAt: string; qualifiedPolicyVersion: number | null; qualifiedAt: string | null; decidedAt: string | null;
}
export interface ChampionsAttributionCaptureInput { referralCode: string; referredOrganizationId: string }
export interface ChampionsQualificationEvidence { firstPaidAt: string; paidInvoiceCount: number; reference: string }
export type ChampionsDecisionInput =
  | { decision: 'QUALIFY'; reasonCode: 'QUALIFICATION_VERIFIED'; expectedVersion: number; evidence: ChampionsQualificationEvidence }
  | { decision: 'REJECT'; reasonCode: typeof CHAMPIONS_REJECT_REASONS[number]; expectedVersion: number }
  | { decision: 'REFUND'; reasonCode: 'REFUND_ISSUED'; expectedVersion: number }
  | { decision: 'REVERSE'; reasonCode: typeof CHAMPIONS_REVERSE_REASONS[number]; expectedVersion: number };
export interface ChampionsAttributionReceipt { attribution: ChampionsAttribution; replayed: boolean }
export interface ChampionsAttributionList { attributions: ChampionsAttribution[]; limit: 100 }

export const CHAMPIONS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CHAMPIONS_REFERRAL_CODE = /^[A-HJ-NP-Z2-9]{10}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ORG_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function invalid(): never { throw new Error('INVALID_CHAMPIONS_INPUT'); }
function drift(): never { throw new Error('INVALID_CHAMPIONS_RESPONSE'); }
function record(value: unknown, fail: () => never): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], fail: () => never): void {
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail();
}
const isInt = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const isUuid = (value: unknown): value is string => typeof value === 'string' && CHAMPIONS_UUID.test(value);
const isTimestamp = (value: unknown): value is string => typeof value === 'string' && TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
const isName = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= 300;
const nullable = <T>(value: unknown, check: (v: unknown) => v is T): boolean => value === null || check(value);

export function championsUuid(value: unknown): string {
  if (!isUuid(value)) invalid();
  return value.toLowerCase();
}
export function validateChampionsAttributionStateFilter(value: unknown): ChampionsAttributionState | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !(CHAMPIONS_ATTRIBUTION_STATES as readonly string[]).includes(value)) invalid();
  return value as ChampionsAttributionState;
}

// ---------- inputs ----------
const TERM_KEYS = ['attributionWindowDays','refundWindowDays','minimumPaidDays','minimumPaidInvoices','paymentVerificationSource','welcomeCreditMinor','termsReference'] as const;
const TERM_LIMITS: Record<string, [number, number]> = { attributionWindowDays: [1, 730], refundWindowDays: [0, 365], minimumPaidDays: [0, 730], minimumPaidInvoices: [0, 24], welcomeCreditMinor: [0, 100000] };
/** Every term is required; null records an undecided owner decision and keeps the draft unpublishable. */
export function validateChampionsPolicyDraftInput(value: unknown): ChampionsPolicyDraftInput {
  const input = record(value, invalid); exactKeys(input, TERM_KEYS, invalid);
  for (const [key, [min, max]] of Object.entries(TERM_LIMITS)) if (input[key] !== null && !isInt(input[key], min, max)) invalid();
  if (!['UNDECIDED','HON_BILLING','HQ_OWNER_ATTESTATION'].includes(input.paymentVerificationSource as string)) invalid();
  const terms = input.termsReference;
  if (terms !== null && (typeof terms !== 'string' || terms.length < 1 || terms.length > 500 || terms.trim() !== terms)) invalid();
  return Object.fromEntries(TERM_KEYS.map(key => [key, input[key]])) as unknown as ChampionsPolicyDraftInput;
}
export function validateChampionsAttributionCaptureInput(value: unknown): ChampionsAttributionCaptureInput {
  const input = record(value, invalid); exactKeys(input, ['referralCode','referredOrganizationId'], invalid);
  if (typeof input.referralCode !== 'string' || !CHAMPIONS_REFERRAL_CODE.test(input.referralCode)) invalid();
  if (typeof input.referredOrganizationId !== 'string' || !ORG_UUID.test(input.referredOrganizationId.toLowerCase())) invalid();
  return { referralCode: input.referralCode, referredOrganizationId: input.referredOrganizationId.toLowerCase() };
}
export function validateChampionsDecisionInput(value: unknown): ChampionsDecisionInput {
  const input = record(value, invalid);
  if (!isInt(input.expectedVersion, 1, 999_999_999)) invalid();
  const expectedVersion = input.expectedVersion;
  switch (input.decision) {
    case 'QUALIFY': {
      exactKeys(input, ['decision','reasonCode','expectedVersion','evidence'], invalid);
      if (input.reasonCode !== 'QUALIFICATION_VERIFIED') invalid();
      const evidence = record(input.evidence, invalid); exactKeys(evidence, ['firstPaidAt','paidInvoiceCount','reference'], invalid);
      if (!isTimestamp(evidence.firstPaidAt) || !/^20\d{2}-/.test(evidence.firstPaidAt) || !isInt(evidence.paidInvoiceCount, 0, 999)
        || typeof evidence.reference !== 'string' || evidence.reference.length < 1 || evidence.reference.length > 200 || evidence.reference.trim() !== evidence.reference) invalid();
      return { decision: 'QUALIFY', reasonCode: 'QUALIFICATION_VERIFIED', expectedVersion,
        evidence: { firstPaidAt: evidence.firstPaidAt, paidInvoiceCount: evidence.paidInvoiceCount, reference: evidence.reference } };
    }
    case 'REJECT':
      exactKeys(input, ['decision','reasonCode','expectedVersion'], invalid);
      if (!(CHAMPIONS_REJECT_REASONS as readonly unknown[]).includes(input.reasonCode)) invalid();
      return { decision: 'REJECT', reasonCode: input.reasonCode as typeof CHAMPIONS_REJECT_REASONS[number], expectedVersion };
    case 'REFUND':
      exactKeys(input, ['decision','reasonCode','expectedVersion'], invalid);
      if (input.reasonCode !== 'REFUND_ISSUED') invalid();
      return { decision: 'REFUND', reasonCode: 'REFUND_ISSUED', expectedVersion };
    case 'REVERSE':
      exactKeys(input, ['decision','reasonCode','expectedVersion'], invalid);
      if (!(CHAMPIONS_REVERSE_REASONS as readonly unknown[]).includes(input.reasonCode)) invalid();
      return { decision: 'REVERSE', reasonCode: input.reasonCode as typeof CHAMPIONS_REVERSE_REASONS[number], expectedVersion };
    default: return invalid();
  }
}

// ---------- responses (closed shapes; any drift fails closed) ----------
function checkReferralCode(value: unknown): ChampionsReferralCode {
  const r = record(value, drift); exactKeys(r, ['code','status','issuedAt'], drift);
  if (typeof r.code !== 'string' || !CHAMPIONS_REFERRAL_CODE.test(r.code) || r.status !== 'ACTIVE' || !isTimestamp(r.issuedAt)) drift();
  return r as unknown as ChampionsReferralCode;
}
export function validateChampionsReferralCodeReceipt(value: unknown): ChampionsReferralCodeReceipt {
  const r = record(value, drift); exactKeys(r, ['schoolId','code','status','issuedAt','created','replayed'], drift);
  checkReferralCode({ code: r.code, status: r.status, issuedAt: r.issuedAt });
  if (!isUuid(r.schoolId) || typeof r.created !== 'boolean' || typeof r.replayed !== 'boolean') drift();
  return r as unknown as ChampionsReferralCodeReceipt;
}
export function validateChampionsSchoolView(value: unknown): ChampionsSchoolView {
  const r = record(value, drift); exactKeys(r, ['schoolId','referralCode','program','referrals'], drift);
  if (!isUuid(r.schoolId)) drift();
  if (r.referralCode !== null) checkReferralCode(r.referralCode);
  const program = record(r.program, drift); exactKeys(program, ['status','policyVersion','financialRewards'], drift);
  if (program.financialRewards !== 'DISABLED'
    || !((program.status === 'POLICY_UNDECIDED' && program.policyVersion === null) || (program.status === 'PUBLISHED' && isInt(program.policyVersion, 1, 2147483647)))) drift();
  const counts = record(r.referrals, drift); exactKeys(counts, ['pending','qualified','rejected','refunded','reversed'], drift);
  if (Object.values(counts).some(count => !isInt(count, 0, Number.MAX_SAFE_INTEGER))) drift();
  return r as unknown as ChampionsSchoolView;
}
function checkPolicy(value: unknown): ChampionsPolicy {
  const r = record(value, drift);
  exactKeys(r, [...TERM_KEYS,'policyId','policyVersion','status','currency','financialRewards','createdAt','publishedAt'], drift);
  for (const [key, [min, max]] of Object.entries(TERM_LIMITS)) if (r[key] !== null && !isInt(r[key], min, max)) drift();
  if (!['UNDECIDED','HON_BILLING','HQ_OWNER_ATTESTATION'].includes(r.paymentVerificationSource as string)
    || !nullable(r.termsReference, isName) || !isUuid(r.policyId) || !isInt(r.policyVersion, 1, 2147483647)
    || !['DRAFT','PUBLISHED','RETIRED'].includes(r.status as string) || r.currency !== 'USD' || r.financialRewards !== 'DISABLED'
    || !isTimestamp(r.createdAt) || !nullable(r.publishedAt, isTimestamp) || (r.status === 'DRAFT') !== (r.publishedAt === null)) drift();
  return r as unknown as ChampionsPolicy;
}
export function validateChampionsProgram(value: unknown): ChampionsProgram {
  const r = record(value, drift); exactKeys(r, ['published','drafts','financialRewards'], drift);
  if (r.financialRewards !== 'DISABLED' || !Array.isArray(r.drafts) || r.drafts.length > 10) drift();
  if (r.published !== null && checkPolicy(r.published).status !== 'PUBLISHED') drift();
  for (const draft of r.drafts) if (checkPolicy(draft).status !== 'DRAFT') drift();
  return r as unknown as ChampionsProgram;
}
export function validateChampionsPolicyDraftReceipt(value: unknown): ChampionsPolicyDraftReceipt {
  const r = record(value, drift); exactKeys(r, ['policy','replayed'], drift);
  if (checkPolicy(r.policy).status !== 'DRAFT' || typeof r.replayed !== 'boolean') drift();
  return r as unknown as ChampionsPolicyDraftReceipt;
}
export function validateChampionsPolicyPublishReceipt(value: unknown): ChampionsPolicyPublishReceipt {
  const r = record(value, drift); exactKeys(r, ['policy','retiredPolicyId','replayed'], drift);
  // A replayed receipt reports the policy as it was published, even if a later version retired it.
  if (checkPolicy(r.policy).status !== 'PUBLISHED' || !nullable(r.retiredPolicyId, isUuid) || typeof r.replayed !== 'boolean') drift();
  return r as unknown as ChampionsPolicyPublishReceipt;
}
function checkAttribution(value: unknown): ChampionsAttribution {
  const r = record(value, drift);
  exactKeys(r, ['attributionId','state','stateReason','version','referrerOrganizationId','referrerSchoolId','referrerSchoolName',
    'referredOrganizationId','referredOrganizationName','capturedAt','qualifiedPolicyVersion','qualifiedAt','decidedAt'], drift);
  if (!isUuid(r.attributionId) || !(CHAMPIONS_ATTRIBUTION_STATES as readonly unknown[]).includes(r.state)
    || !(CHAMPIONS_STATE_REASONS as readonly unknown[]).includes(r.stateReason) || !isInt(r.version, 1, 2147483647)
    || !isUuid(r.referrerOrganizationId) || !isUuid(r.referrerSchoolId) || !isName(r.referrerSchoolName)
    || !isUuid(r.referredOrganizationId) || !isName(r.referredOrganizationName) || !isTimestamp(r.capturedAt)
    || !nullable(r.qualifiedPolicyVersion, (v): v is number => isInt(v, 1, 2147483647)) || !nullable(r.qualifiedAt, isTimestamp)
    || !nullable(r.decidedAt, isTimestamp) || (r.qualifiedAt === null) !== (r.qualifiedPolicyVersion === null)
    || (r.state === 'PENDING') !== (r.decidedAt === null) || (r.state === 'QUALIFIED' && r.qualifiedAt === null)) drift();
  return r as unknown as ChampionsAttribution;
}
export function validateChampionsAttributionReceipt(value: unknown): ChampionsAttributionReceipt {
  const r = record(value, drift); exactKeys(r, ['attribution','replayed'], drift);
  checkAttribution(r.attribution);
  if (typeof r.replayed !== 'boolean') drift();
  return r as unknown as ChampionsAttributionReceipt;
}
export function validateChampionsAttributionList(value: unknown): ChampionsAttributionList {
  const r = record(value, drift); exactKeys(r, ['attributions','limit'], drift);
  if (r.limit !== 100 || !Array.isArray(r.attributions) || r.attributions.length > 100) drift();
  for (const attribution of r.attributions) checkAttribution(attribution);
  return r as unknown as ChampionsAttributionList;
}
