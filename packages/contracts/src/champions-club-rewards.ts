// HON Champions Club Milestone 2: reward ACCOUNTING contracts. Every amount here is a recorded
// liability; financialActivation is always 'DISABLED' and no state means "issued" or "fulfilled".
import {
  championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsInt as isInt,
  championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsNullable as nullable, championsRecord as record,
} from './champions-club.js';

export type ChampionsRewardKind = 'REFERRER_CREDIT' | 'WELCOME_CREDIT' | 'FREE_MONTHS' | 'PRIZE' | 'LIFETIME_MEMBERSHIP';
export type ChampionsRewardStatus = 'ACCRUED' | 'APPROVED' | 'REVERSAL_REVIEW' | 'VOIDED';
export type ChampionsPlanBasis = 'MONTHLY' | 'ANNUAL' | 'FOUNDER' | 'PAID_LIFETIME';
export type ChampionsClawbackRule = 'UNDECIDED' | 'VOID_UNFULFILLED' | 'RETAIN_EARNED';
export type ChampionsRewardRule = 'UNDECIDED' | 'AS_EARNED' | 'OWNER_SUBSTITUTE';
export type ChampionsVoidReason = 'BASIS_REVERSED' | 'FRAUD_CONFIRMED' | 'DUPLICATE' | 'OWNER_CORRECTION';
export type ChampionsPrizeKind = 'ELECTRONICS' | 'EXPERIENCE';
export type ChampionsFinancialActivation = 'DISABLED';

export const CHAMPIONS_REWARD_KINDS: readonly ChampionsRewardKind[] = ['REFERRER_CREDIT','WELCOME_CREDIT','FREE_MONTHS','PRIZE','LIFETIME_MEMBERSHIP'];
export const CHAMPIONS_REWARD_STATUSES: readonly ChampionsRewardStatus[] = ['ACCRUED','APPROVED','REVERSAL_REVIEW','VOIDED'];
const PLAN_BASES: readonly string[] = ['MONTHLY','ANNUAL','FOUNDER','PAID_LIFETIME'];
const VOID_REASONS: readonly string[] = ['BASIS_REVERSED','FRAUD_CONFIRMED','DUPLICATE','OWNER_CORRECTION'];
const TIERS: readonly string[] = ['ESSENTIAL','CORE','COMPLETE'];

export interface ChampionsRewardTerms {
  referrerCreditMinor: number | null; referrerCreditMaxRank: number | null; welcomeCreditMinor: number | null;
  firstFreeMonthsCount: number | null; firstFreeMonthsTotal: number | null; secondFreeMonthsCount: number | null; secondFreeMonthsTotal: number | null;
  prizeCount: number | null; prizeBudgetMinor: number | null; lifetimeCount: number | null;
  clawbackRule: ChampionsClawbackRule; monthlyRule: ChampionsRewardRule; annualRule: ChampionsRewardRule; founderRule: ChampionsRewardRule;
  paidLifetimeRule: 'UNDECIDED' | 'OWNER_SUBSTITUTE'; termsReference: string | null;
}
export type ChampionsRewardPolicyDraftInput = ChampionsRewardTerms;
export interface ChampionsRewardPolicy extends ChampionsRewardTerms {
  policyId: string; policyVersion: number; status: 'DRAFT' | 'PUBLISHED' | 'RETIRED'; aiAllowance: 'FULL_PLAN_ALLOWANCE';
  currency: 'USD'; financialActivation: ChampionsFinancialActivation; createdAt: string; publishedAt: string | null;
}
export interface ChampionsRewardProgram { published: ChampionsRewardPolicy | null; drafts: ChampionsRewardPolicy[]; financialActivation: ChampionsFinancialActivation }
export interface ChampionsRewardPolicyDraftReceipt { policy: ChampionsRewardPolicy; replayed: boolean }
export interface ChampionsRewardPolicyPublishReceipt { policy: ChampionsRewardPolicy; retiredPolicyId: string | null; replayed: boolean }
export interface ChampionsRewardEntry {
  entryId: string; rewardKind: ChampionsRewardKind; beneficiaryRole: 'REFERRER' | 'REFERRED'; beneficiaryOrganizationId: string;
  referrerOrganizationId: string; referrerSchoolId: string; attributionId: string | null; milestoneOrdinal: number | null; milestoneCount: number | null;
  creditMinor: number | null; freeMonths: number | null; lifetimeTier: 'ESSENTIAL' | 'CORE' | 'COMPLETE' | null; aiAllowance: 'FULL_PLAN_ALLOWANCE' | null;
  basisQualifiedCount: number; status: ChampionsRewardStatus; retained: boolean; version: number; policyVersion: number;
  planBasis: ChampionsPlanBasis | null; fulfillmentForm: 'AS_EARNED' | 'OWNER_SUBSTITUTE' | null;
  substitute: { description: string; valueMinor: number } | null; prize: { kind: ChampionsPrizeKind; description: string; costMinor: number } | null;
  voidReason: ChampionsVoidReason | null; accruedAt: string; approvedAt: string | null; voidedAt: string | null;
}
export interface ChampionsRewardReconcileReceipt {
  schoolId: string; qualifiedCount: number; policyVersion: number; accrued: number; flaggedForReview: number; restored: number;
  entries: ChampionsRewardEntry[]; financialActivation: ChampionsFinancialActivation; replayed: boolean;
}
export type ChampionsRewardDecisionInput =
  | { decision: 'APPROVE'; expectedVersion: number; planBasis: ChampionsPlanBasis;
      substitute: { description: string; valueMinor: number } | null; prize: { kind: ChampionsPrizeKind; description: string; costMinor: number } | null }
  | { decision: 'VOID'; expectedVersion: number; reasonCode: ChampionsVoidReason }
  | { decision: 'RETAIN'; expectedVersion: number };
export interface ChampionsRewardDecisionReceipt { entry: ChampionsRewardEntry; replayed: boolean }
export interface ChampionsRewardLiability {
  status: Exclude<ChampionsRewardStatus, 'VOIDED'>; rewardKind: ChampionsRewardKind; entries: number;
  creditMinor: number; freeMonths: number; prizeCostMinor: number; substituteValueMinor: number;
}
export interface ChampionsRewardLedger {
  entries: ChampionsRewardEntry[]; limit: 200; liabilities: ChampionsRewardLiability[]; currency: 'USD'; financialActivation: ChampionsFinancialActivation;
}
export interface ChampionsSchoolReward {
  rewardKind: ChampionsRewardKind; beneficiaryRole: 'REFERRER' | 'REFERRED'; milestoneCount: number | null; creditMinor: number | null;
  freeMonths: number | null; lifetimeTier: 'ESSENTIAL' | 'CORE' | 'COMPLETE' | null; aiAllowance: 'FULL_PLAN_ALLOWANCE' | null;
  status: Exclude<ChampionsRewardStatus, 'VOIDED'>; accruedAt: string;
}
export interface ChampionsSchoolRewards {
  schoolId: string; qualifiedReferrals: number; program: { status: 'POLICY_UNDECIDED' | 'PUBLISHED'; policyVersion: number | null };
  nextMilestone: { rewardKind: ChampionsRewardKind; milestoneCount: number; remaining: number } | null;
  rewards: ChampionsSchoolReward[]; financialActivation: ChampionsFinancialActivation;
}

// ---------- inputs ----------
const LADDER_LIMITS: Record<string, [number, number]> = {
  referrerCreditMinor: [0, 100000], referrerCreditMaxRank: [0, 10], welcomeCreditMinor: [0, 100000], firstFreeMonthsCount: [1, 100],
  firstFreeMonthsTotal: [1, 60], secondFreeMonthsCount: [1, 100], secondFreeMonthsTotal: [1, 60], prizeCount: [1, 200],
  prizeBudgetMinor: [0, 2000000], lifetimeCount: [1, 500],
};
const RULE_VALUES: Record<string, readonly string[]> = {
  clawbackRule: ['UNDECIDED','VOID_UNFULFILLED','RETAIN_EARNED'], monthlyRule: ['UNDECIDED','AS_EARNED','OWNER_SUBSTITUTE'],
  annualRule: ['UNDECIDED','AS_EARNED','OWNER_SUBSTITUTE'], founderRule: ['UNDECIDED','AS_EARNED','OWNER_SUBSTITUTE'],
  paidLifetimeRule: ['UNDECIDED','OWNER_SUBSTITUTE'],
};
const TERM_KEYS = [...Object.keys(LADDER_LIMITS), ...Object.keys(RULE_VALUES), 'termsReference'];
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length >= 1 && value.length <= max && value.trim() === value;

/** Every key is required. A null ladder value is an undecided term and keeps the draft unpublishable. */
export function validateChampionsRewardPolicyDraftInput(value: unknown): ChampionsRewardPolicyDraftInput {
  const input = record(value, invalid); exactKeys(input, TERM_KEYS, invalid);
  for (const [key, [min, max]] of Object.entries(LADDER_LIMITS)) if (input[key] !== null && !isInt(input[key], min, max)) invalid();
  for (const [key, allowed] of Object.entries(RULE_VALUES)) if (!allowed.includes(input[key] as string)) invalid();
  if (input.termsReference !== null && !isText(input.termsReference, 500)) invalid();
  const n = (key: string) => input[key] as number | null;
  const ordered = (a: string, b: string) => n(a) === null || n(b) === null || (n(a) as number) < (n(b) as number);
  if (!ordered('referrerCreditMaxRank','firstFreeMonthsCount') || !ordered('firstFreeMonthsCount','secondFreeMonthsCount')
    || !ordered('secondFreeMonthsCount','prizeCount') || !ordered('prizeCount','lifetimeCount')
    || (n('firstFreeMonthsTotal') !== null && n('secondFreeMonthsTotal') !== null && (n('secondFreeMonthsTotal') as number) < (n('firstFreeMonthsTotal') as number))) invalid();
  return Object.fromEntries(TERM_KEYS.map(key => [key, input[key]])) as unknown as ChampionsRewardPolicyDraftInput;
}
export function validateChampionsRewardStatusFilter(value: unknown): ChampionsRewardStatus | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !(CHAMPIONS_REWARD_STATUSES as readonly string[]).includes(value)) invalid();
  return value as ChampionsRewardStatus;
}
export function validateChampionsRewardDecisionInput(value: unknown): ChampionsRewardDecisionInput {
  const input = record(value, invalid);
  if (!isInt(input.expectedVersion, 1, 999_999_999)) invalid();
  const expectedVersion = input.expectedVersion;
  if (input.decision === 'APPROVE') {
    exactKeys(input, ['decision','expectedVersion','planBasis','substitute','prize'], invalid);
    if (!PLAN_BASES.includes(input.planBasis as string)) invalid();
    let substitute: { description: string; valueMinor: number } | null = null;
    if (input.substitute !== null) {
      const s = record(input.substitute, invalid); exactKeys(s, ['description','valueMinor'], invalid);
      if (!isText(s.description, 300) || !isInt(s.valueMinor, 0, 2000000)) invalid();
      substitute = { description: s.description, valueMinor: s.valueMinor };
    }
    let prize: { kind: ChampionsPrizeKind; description: string; costMinor: number } | null = null;
    if (input.prize !== null) {
      const p = record(input.prize, invalid); exactKeys(p, ['kind','description','costMinor'], invalid);
      if (!['ELECTRONICS','EXPERIENCE'].includes(p.kind as string) || !isText(p.description, 300) || !isInt(p.costMinor, 0, 2000000)) invalid();
      prize = { kind: p.kind as ChampionsPrizeKind, description: p.description, costMinor: p.costMinor };
    }
    if (input.planBasis === 'PAID_LIFETIME' && substitute === null) invalid();
    return { decision: 'APPROVE', expectedVersion, planBasis: input.planBasis as ChampionsPlanBasis, substitute, prize };
  }
  if (input.decision === 'VOID') {
    exactKeys(input, ['decision','expectedVersion','reasonCode'], invalid);
    if (!VOID_REASONS.includes(input.reasonCode as string)) invalid();
    return { decision: 'VOID', expectedVersion, reasonCode: input.reasonCode as ChampionsVoidReason };
  }
  if (input.decision === 'RETAIN') {
    exactKeys(input, ['decision','expectedVersion'], invalid);
    return { decision: 'RETAIN', expectedVersion };
  }
  return invalid();
}

// ---------- responses (closed; drift fails closed) ----------
function checkPolicy(value: unknown): ChampionsRewardPolicy {
  const r = record(value, drift);
  exactKeys(r, [...TERM_KEYS,'policyId','policyVersion','status','aiAllowance','currency','financialActivation','createdAt','publishedAt'], drift);
  for (const [key, [min, max]] of Object.entries(LADDER_LIMITS)) if (r[key] !== null && !isInt(r[key], min, max)) drift();
  for (const [key, allowed] of Object.entries(RULE_VALUES)) if (!allowed.includes(r[key] as string)) drift();
  if ((r.termsReference !== null && !isText(r.termsReference, 500)) || !isUuid(r.policyId) || !isInt(r.policyVersion, 1, 2147483647)
    || !['DRAFT','PUBLISHED','RETIRED'].includes(r.status as string) || r.aiAllowance !== 'FULL_PLAN_ALLOWANCE' || r.currency !== 'USD'
    || r.financialActivation !== 'DISABLED' || !isTimestamp(r.createdAt) || !nullable(r.publishedAt, isTimestamp)
    || (r.status === 'DRAFT') !== (r.publishedAt === null)) drift();
  return r as unknown as ChampionsRewardPolicy;
}
function checkEntry(value: unknown): ChampionsRewardEntry {
  const r = record(value, drift);
  exactKeys(r, ['entryId','rewardKind','beneficiaryRole','beneficiaryOrganizationId','referrerOrganizationId','referrerSchoolId','attributionId',
    'milestoneOrdinal','milestoneCount','creditMinor','freeMonths','lifetimeTier','aiAllowance','basisQualifiedCount','status','retained','version',
    'policyVersion','planBasis','fulfillmentForm','substitute','prize','voidReason','accruedAt','approvedAt','voidedAt'], drift);
  const posInt = (v: unknown): v is number => isInt(v, 0, 2147483647);
  if (!isUuid(r.entryId) || !(CHAMPIONS_REWARD_KINDS as readonly unknown[]).includes(r.rewardKind) || !['REFERRER','REFERRED'].includes(r.beneficiaryRole as string)
    || !isUuid(r.beneficiaryOrganizationId) || !isUuid(r.referrerOrganizationId) || !isUuid(r.referrerSchoolId) || !nullable(r.attributionId, isUuid)
    || !nullable(r.milestoneOrdinal, posInt) || !nullable(r.milestoneCount, posInt) || !nullable(r.creditMinor, posInt) || !nullable(r.freeMonths, posInt)
    || (r.lifetimeTier !== null && !TIERS.includes(r.lifetimeTier as string)) || (r.aiAllowance !== null && r.aiAllowance !== 'FULL_PLAN_ALLOWANCE')
    || !posInt(r.basisQualifiedCount) || !(CHAMPIONS_REWARD_STATUSES as readonly unknown[]).includes(r.status) || typeof r.retained !== 'boolean'
    || !isInt(r.version, 1, 2147483647) || !isInt(r.policyVersion, 1, 2147483647) || (r.planBasis !== null && !PLAN_BASES.includes(r.planBasis as string))
    || (r.fulfillmentForm !== null && !['AS_EARNED','OWNER_SUBSTITUTE'].includes(r.fulfillmentForm as string))
    || (r.voidReason !== null && !VOID_REASONS.includes(r.voidReason as string)) || !isTimestamp(r.accruedAt)
    || !nullable(r.approvedAt, isTimestamp) || !nullable(r.voidedAt, isTimestamp)
    || (r.planBasis === null) !== (r.approvedAt === null) || (r.status === 'VOIDED') !== (r.voidedAt !== null)
    || ((r.rewardKind === 'FREE_MONTHS' || r.rewardKind === 'LIFETIME_MEMBERSHIP') !== (r.aiAllowance === 'FULL_PLAN_ALLOWANCE'))) drift();
  if (r.substitute !== null) { const s = record(r.substitute, drift); exactKeys(s, ['description','valueMinor'], drift); if (!isText(s.description, 300) || !posInt(s.valueMinor)) drift(); }
  if (r.prize !== null) { const p = record(r.prize, drift); exactKeys(p, ['kind','description','costMinor'], drift);
    if (!['ELECTRONICS','EXPERIENCE'].includes(p.kind as string) || !isText(p.description, 300) || !posInt(p.costMinor)) drift(); }
  return r as unknown as ChampionsRewardEntry;
}
export function validateChampionsRewardProgram(value: unknown): ChampionsRewardProgram {
  const r = record(value, drift); exactKeys(r, ['published','drafts','financialActivation'], drift);
  if (r.financialActivation !== 'DISABLED' || !Array.isArray(r.drafts) || r.drafts.length > 10) drift();
  if (r.published !== null && checkPolicy(r.published).status !== 'PUBLISHED') drift();
  for (const d of r.drafts) if (checkPolicy(d).status !== 'DRAFT') drift();
  return r as unknown as ChampionsRewardProgram;
}
export function validateChampionsRewardPolicyDraftReceipt(value: unknown): ChampionsRewardPolicyDraftReceipt {
  const r = record(value, drift); exactKeys(r, ['policy','replayed'], drift);
  if (checkPolicy(r.policy).status !== 'DRAFT' || typeof r.replayed !== 'boolean') drift();
  return r as unknown as ChampionsRewardPolicyDraftReceipt;
}
export function validateChampionsRewardPolicyPublishReceipt(value: unknown): ChampionsRewardPolicyPublishReceipt {
  const r = record(value, drift); exactKeys(r, ['policy','retiredPolicyId','replayed'], drift);
  if (checkPolicy(r.policy).status !== 'PUBLISHED' || !nullable(r.retiredPolicyId, isUuid) || typeof r.replayed !== 'boolean') drift();
  return r as unknown as ChampionsRewardPolicyPublishReceipt;
}
export function validateChampionsRewardReconcileReceipt(value: unknown): ChampionsRewardReconcileReceipt {
  const r = record(value, drift);
  exactKeys(r, ['schoolId','qualifiedCount','policyVersion','accrued','flaggedForReview','restored','entries','financialActivation','replayed'], drift);
  if (!isUuid(r.schoolId) || !isInt(r.qualifiedCount, 0, 1_000_000) || !isInt(r.policyVersion, 1, 2147483647) || !isInt(r.accrued, 0, 1_000_000)
    || !isInt(r.flaggedForReview, 0, 1_000_000) || !isInt(r.restored, 0, 1_000_000) || !Array.isArray(r.entries) || r.entries.length > 5000
    || r.financialActivation !== 'DISABLED' || typeof r.replayed !== 'boolean') drift();
  for (const e of r.entries as unknown[]) checkEntry(e);
  return r as unknown as ChampionsRewardReconcileReceipt;
}
export function validateChampionsRewardDecisionReceipt(value: unknown): ChampionsRewardDecisionReceipt {
  const r = record(value, drift); exactKeys(r, ['entry','replayed'], drift);
  checkEntry(r.entry); if (typeof r.replayed !== 'boolean') drift();
  return r as unknown as ChampionsRewardDecisionReceipt;
}
export function validateChampionsRewardLedger(value: unknown): ChampionsRewardLedger {
  const r = record(value, drift); exactKeys(r, ['entries','limit','liabilities','currency','financialActivation'], drift);
  if (r.limit !== 200 || !Array.isArray(r.entries) || r.entries.length > 200 || !Array.isArray(r.liabilities) || r.currency !== 'USD' || r.financialActivation !== 'DISABLED') drift();
  for (const e of r.entries as unknown[]) checkEntry(e);
  for (const l of r.liabilities as unknown[]) {
    const x = record(l, drift); exactKeys(x, ['status','rewardKind','entries','creditMinor','freeMonths','prizeCostMinor','substituteValueMinor'], drift);
    if (!['ACCRUED','APPROVED','REVERSAL_REVIEW'].includes(x.status as string) || !(CHAMPIONS_REWARD_KINDS as readonly unknown[]).includes(x.rewardKind)
      || [x.entries, x.creditMinor, x.freeMonths, x.prizeCostMinor, x.substituteValueMinor].some(v => !isInt(v, 0, Number.MAX_SAFE_INTEGER))) drift();
  }
  return r as unknown as ChampionsRewardLedger;
}
export function validateChampionsSchoolRewards(value: unknown): ChampionsSchoolRewards {
  const r = record(value, drift); exactKeys(r, ['schoolId','qualifiedReferrals','program','nextMilestone','rewards','financialActivation'], drift);
  if (!isUuid(r.schoolId) || !isInt(r.qualifiedReferrals, 0, 1_000_000) || r.financialActivation !== 'DISABLED' || !Array.isArray(r.rewards)) drift();
  const program = record(r.program, drift); exactKeys(program, ['status','policyVersion'], drift);
  if (!((program.status === 'POLICY_UNDECIDED' && program.policyVersion === null) || (program.status === 'PUBLISHED' && isInt(program.policyVersion, 1, 2147483647)))) drift();
  if (r.nextMilestone !== null) {
    const m = record(r.nextMilestone, drift); exactKeys(m, ['rewardKind','milestoneCount','remaining'], drift);
    if (!(CHAMPIONS_REWARD_KINDS as readonly unknown[]).includes(m.rewardKind) || !isInt(m.milestoneCount, 1, 500) || !isInt(m.remaining, 1, 500)) drift();
  }
  for (const item of r.rewards as unknown[]) {
    const x = record(item, drift);
    exactKeys(x, ['rewardKind','beneficiaryRole','milestoneCount','creditMinor','freeMonths','lifetimeTier','aiAllowance','status','accruedAt'], drift);
    if (!(CHAMPIONS_REWARD_KINDS as readonly unknown[]).includes(x.rewardKind) || !['REFERRER','REFERRED'].includes(x.beneficiaryRole as string)
      || !['ACCRUED','APPROVED','REVERSAL_REVIEW'].includes(x.status as string) || !isTimestamp(x.accruedAt)
      || [x.milestoneCount, x.creditMinor, x.freeMonths].some(v => v !== null && !isInt(v, 0, 2147483647))
      || (x.lifetimeTier !== null && !TIERS.includes(x.lifetimeTier as string)) || (x.aiAllowance !== null && x.aiAllowance !== 'FULL_PLAN_ALLOWANCE')) drift();
  }
  return r as unknown as ChampionsSchoolRewards;
}
