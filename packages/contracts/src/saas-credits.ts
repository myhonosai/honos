// HON Subscription Billing Milestone B3 closed contracts: premium AI credit allowances and usage
// accounting. Credits are an allowance of the school's HON plan, never purchased here: topUps is
// always UNAVAILABLE, overage DISABLED, purchases DISABLED. Ordinary assistant use, CRM, scheduling,
// reporting, deterministic automation and lead sync never consume premium credits. School views never
// carry provider cost; only HQ views do.
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsInt as isInt,
  championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsNullable as nullable, championsRecord as record } from './champions-club.js';
import { saasUuid } from './saas-billing.js';

export type SaasCostUnit = 'IMAGE' | 'VIDEO_SECOND' | 'AUDIO_SECOND' | 'TOKEN_1K' | 'REQUEST' | 'TASK';
export type SaasPremiumCategory = 'IMAGE_GENERATION' | 'VIDEO_GENERATION' | 'VOICE_GENERATION' | 'AI_EMPLOYEE_TASK' | 'DEEP_RESEARCH'
  | 'CAMPAIGN_OPTIMIZATION' | 'OTHER_APPROVED';
export type SaasRequiredCapability = 'ai.premium_metered' | 'ai.workforce' | 'ai.delegated_jobs' | 'ai.orchestration'
  | 'marketing.campaigns_ai_managed' | 'attribution.ai_insight';
export type SaasReservationState = 'RESERVED' | 'FINALIZED' | 'RELEASED' | 'OUTCOME_UNKNOWN';
export type SaasReservationStateReason = 'RESERVED' | 'PROVIDER_SUCCEEDED' | 'PROVIDER_FAILED' | 'PROVIDER_OUTCOME_UNKNOWN'
  | 'HQ_RESOLVED_SUCCEEDED' | 'HQ_RESOLVED_NOT_CHARGED';
export type SaasCreditRefusal = 'SAAS_CREDITS_NOT_ACTIVE' | 'SAAS_SUBSCRIPTION_NOT_ACTIVE' | 'SAAS_OPERATION_NOT_IN_PLAN'
  | 'SAAS_OPERATION_UNITS_EXCEEDED' | 'SAAS_CREDITS_EXHAUSTED';
const COST_UNITS: readonly SaasCostUnit[] = ['IMAGE','VIDEO_SECOND','AUDIO_SECOND','TOKEN_1K','REQUEST','TASK'];
const CATEGORIES: readonly SaasPremiumCategory[] = ['IMAGE_GENERATION','VIDEO_GENERATION','VOICE_GENERATION','AI_EMPLOYEE_TASK','DEEP_RESEARCH',
  'CAMPAIGN_OPTIMIZATION','OTHER_APPROVED'];
const CAPABILITIES: readonly SaasRequiredCapability[] = ['ai.premium_metered','ai.workforce','ai.delegated_jobs','ai.orchestration',
  'marketing.campaigns_ai_managed','attribution.ai_insight'];
const PROVIDERS = ['OPENROUTER','DIRECT_LLM_API','HEYGEN','HIGGSFIELD'] as const;
const STATES: readonly SaasReservationState[] = ['RESERVED','FINALIZED','RELEASED','OUTCOME_UNKNOWN'];
const REASONS: readonly SaasReservationStateReason[] = ['RESERVED','PROVIDER_SUCCEEDED','PROVIDER_FAILED','PROVIDER_OUTCOME_UNKNOWN','HQ_RESOLVED_SUCCEEDED','HQ_RESOLVED_NOT_CHARGED'];
const REFUSALS: readonly SaasCreditRefusal[] = ['SAAS_CREDITS_NOT_ACTIVE','SAAS_SUBSCRIPTION_NOT_ACTIVE','SAAS_OPERATION_NOT_IN_PLAN','SAAS_OPERATION_UNITS_EXCEEDED','SAAS_CREDITS_EXHAUSTED'];
/** Owner-approved planned monthly allowances (B1 catalog values); the catalog row is authoritative. */
export const SAAS_PLANNED_MONTHLY_CREDITS = { CORE: 5000, COMPLETE: 12000 } as const;
/** Operations that never consume premium credits (owner direction, B3). */
export const SAAS_INCLUDED_OPERATIONS = ['ordinary_assistant_conversation','crm','attendance_and_scheduling','reporting_and_dashboards',
  'deterministic_automation','third_party_lead_sync','routine_software_operations'] as const;

// ---------- inputs ----------
export interface SaasCreditProgramInput { action: 'ACTIVATE' | 'DEACTIVATE'; expectedVersion: number; authorizationReference: string }
export interface SaasCostEvidenceInput {
  providerId: typeof PROVIDERS[number]; modelCode: string; costUnit: SaasCostUnit; measuredUnits: number; billedCostMicrounits: number;
  fullyLoadedCostMicrounits: number; evidenceReference: string; periodStart: string; periodEnd: string; note: string | null;
}
export interface SaasOperationPriceDraft {
  operationCode: string; category: SaasPremiumCategory; displayName: string; billingUnit: SaasCostUnit; creditsPerUnit: number;
  maxUnitsPerRequest: number; requiredCapability: SaasRequiredCapability; costEvidenceId: string;
}
export interface SaasPricingDraftInput { termsReference: string | null; operations: SaasOperationPriceDraft[] }
export type SaasAllowanceCommand =
  | { action: 'OPEN_CURRENT'; subscriptionId: string }
  | { action: 'EXPIRE'; allowanceId: string; expectedVersion: number };
export interface SaasCreditReserveInput {
  operationCode: string; units: number; employeeKey: string | null; actionRequestId: string | null; workItemId: string | null;
}
export type SaasCreditSettleInput =
  | { outcome: 'SUCCEEDED'; expectedVersion: number; finalUnits: number; providerCostMicrounits: number; inputUnits: number | null; outputUnits: number | null }
  | { outcome: 'FAILED'; expectedVersion: number; finalUnits: null; providerCostMicrounits: number | null; inputUnits: number | null; outputUnits: number | null }
  | { outcome: 'UNKNOWN'; expectedVersion: number; finalUnits: null; providerCostMicrounits: null; inputUnits: null; outputUnits: null };
export type SaasCreditResolveInput =
  | { resolution: 'SUCCEEDED'; expectedVersion: number; finalUnits: number; providerCostMicrounits: number; evidenceReference: string }
  | { resolution: 'NOT_CHARGED'; expectedVersion: number; finalUnits: null; providerCostMicrounits: number | null; evidenceReference: string };

// ---------- responses ----------
export interface SaasCreditProgram {
  status: 'INACTIVE' | 'ACTIVE'; version: number; authorizationReference: string | null; changedAt: string;
  topUps: 'UNAVAILABLE'; overage: 'DISABLED'; purchases: 'DISABLED';
}
export interface SaasCostEvidence {
  costEvidenceId: string; providerId: string; modelCode: string; costUnit: SaasCostUnit; measuredUnits: number; billedCostMicrounits: number;
  fullyLoadedCostMicrounits: number; fullyLoadedCostMicrounitsPerUnit: number; source: 'HQ_OWNER_VERIFIED_PROVIDER_BILLING';
  evidenceReference: string; periodStart: string; periodEnd: string; note: string | null; verifiedAt: string;
}
export interface SaasOperationPrice {
  operationCode: string; category: SaasPremiumCategory; displayName: string; billingUnit: SaasCostUnit; creditsPerUnit: number;
  maxUnitsPerRequest: number; requiredCapability: SaasRequiredCapability;
}
export interface SaasOperationPriceInternal extends SaasOperationPrice {
  costEvidenceId: string; providerId: string; modelCode: string; fullyLoadedCostMicrounitsPerUnit: number; fullyLoadedCostMicrounitsPerCredit: number;
}
export interface SaasPricing<T = SaasOperationPriceInternal> {
  pricingId: string; pricingVersion: number; status: 'DRAFT' | 'PUBLISHED' | 'RETIRED'; termsReference: string | null; operations: T[];
  createdAt: string; publishedAt: string | null; retiredAt: string | null;
}
export interface SaasCreditProgramView {
  program: SaasCreditProgram; publishedPricing: SaasPricing | null; pricingDrafts: SaasPricing[]; costEvidence: SaasCostEvidence[];
  premiumCreditsFromOrdinaryUse: false;
}
export interface SaasAllowanceBalance {
  allowanceCredits: number; consumedCredits: number; heldCredits: number; expiredCredits: number; availableCredits: number; usedPercent: number;
}
export interface SaasAllowance {
  allowanceId: string; subscriptionId: string; organizationId: string; periodIndex: number; periodStart: string; periodEnd: string;
  planCode: 'CORE' | 'COMPLETE'; allowanceBasis: 'REGULAR' | 'FOUNDER' | 'LIFETIME' | 'LEGACY'; status: 'OPEN' | 'EXPIRED'; version: number;
  balance: SaasAllowanceBalance; thresholds: { thresholdPercent: 75 | 90 | 100; reachedAt: string; notification: 'NOT_SENT' }[];
  rollover: 'NONE'; topUps: 'UNAVAILABLE'; openedAt: string; expiredAt: string | null;
}
export type SaasSchoolAllowance = Omit<SaasAllowance, 'organizationId'>;
export interface SaasCreditReservation {
  reservationId: string; allowanceId: string; organizationId: string; schoolId: string; subscriptionId: string; operationCode: string;
  category: SaasPremiumCategory; creditsPerUnit: number; estimatedUnits: number; reservedCredits: number; status: SaasReservationState;
  statusReason: SaasReservationStateReason; version: number; employeeKey: string | null; actionRequestId: string | null; workItemId: string | null;
  finalUnits: number | null; finalCredits: number | null; reservedAt: string; settledAt: string | null;
}
export interface SaasCreditReservationInternal extends SaasCreditReservation {
  providerId: string; modelCode: string; providerCostMicrounits: number | null; usageId: string | null; resolutionReference: string | null;
}
export interface SaasOrganizationCredits {
  organizationId: string; subscriptionId: string | null; program: SaasCreditProgram; allowances: SaasAllowance[];
  reservations: SaasCreditReservationInternal[]; ordinaryUsageThisMonth: { events: number; providerCostMicrounits: number; premiumDeduction: 'NONE' };
}
export interface SaasSchoolCredits {
  schoolId: string; planCode: 'ESSENTIAL' | 'CORE' | 'COMPLETE' | null; subscriptionStatus: 'PENDING_ACTIVATION' | 'IN_SERVICE' | 'SUSPENDED' | null;
  programStatus: 'INACTIVE' | 'ACTIVE'; currentAllowance: SaasSchoolAllowance | null; operations: SaasOperationPrice[];
  recentReservations: SaasCreditReservation[]; ordinaryUseConsumesCredits: false; topUps: 'UNAVAILABLE';
}
export interface SaasCreditEstimate {
  operationCode: string; category: SaasPremiumCategory; units: number; creditsPerUnit: number; estimatedCredits: number;
  availableCredits: number | null; allowed: boolean; refusal: SaasCreditRefusal | null; estimateOnly: true;
}
export interface SaasCreditProgramReceipt { program: SaasCreditProgram; replayed: boolean }
export interface SaasCostEvidenceReceipt { costEvidence: SaasCostEvidence; replayed: boolean }
export interface SaasPricingReceipt { pricing: SaasPricing; replayed: boolean }
export interface SaasPricingPublishReceipt { pricing: SaasPricing; retiredPricingId: string | null; replayed: boolean }
export interface SaasAllowanceReceipt { allowance: SaasAllowance; action: SaasAllowanceCommand['action']; replayed: boolean }
export interface SaasCreditReservationReceipt { reservation: SaasCreditReservation; allowance: SaasSchoolAllowance; replayed: boolean }
export interface SaasCreditResolveReceipt { reservation: SaasCreditReservationInternal; replayed: boolean }

// ---------- input validators ----------
const ISO_INPUT = /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OPERATION = /^[a-z][a-z0-9_.]{2,59}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const has = (list: readonly unknown[], value: unknown) => list.includes(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length >= 1 && value.length <= max && value.trim() === value;
const count = (v: unknown): v is number => isInt(v, 0, Number.MAX_SAFE_INTEGER);
const nts = (v: unknown) => v === null || isTimestamp(v);
const iso = (v: unknown): v is string => typeof v === 'string' && ISO_INPUT.test(v) && isTimestamp(v);
const big = (v: unknown, min = 1) => isInt(v, min, 999_999_999_999_999);

export function validateSaasCreditProgramInput(value: unknown): SaasCreditProgramInput {
  const input = record(value, invalid); exactKeys(input, ['action','expectedVersion','authorizationReference'], invalid);
  if (!has(['ACTIVATE','DEACTIVATE'], input.action) || !isInt(input.expectedVersion, 1, 999_999_999) || !text(input.authorizationReference, 200)) invalid();
  return { action: input.action as 'ACTIVATE' | 'DEACTIVATE', expectedVersion: input.expectedVersion, authorizationReference: input.authorizationReference as string };
}
export function validateSaasCostEvidenceInput(value: unknown): SaasCostEvidenceInput {
  const input = record(value, invalid);
  exactKeys(input, ['providerId','modelCode','costUnit','measuredUnits','billedCostMicrounits','fullyLoadedCostMicrounits','evidenceReference','periodStart','periodEnd','note'], invalid);
  if (!has(PROVIDERS, input.providerId) || typeof input.modelCode !== 'string' || !MODEL.test(input.modelCode) || !has(COST_UNITS, input.costUnit)
    || !big(input.measuredUnits) || !big(input.billedCostMicrounits) || !big(input.fullyLoadedCostMicrounits)
    || (input.fullyLoadedCostMicrounits as number) < (input.billedCostMicrounits as number)
    || !text(input.evidenceReference, 200) || !iso(input.periodStart) || !iso(input.periodEnd) || Date.parse(input.periodEnd) <= Date.parse(input.periodStart)
    || (input.note !== null && !text(input.note, 500))) invalid();
  return input as unknown as SaasCostEvidenceInput;
}
export function validateSaasPricingDraftInput(value: unknown): SaasPricingDraftInput {
  const input = record(value, invalid); exactKeys(input, ['termsReference','operations'], invalid);
  if ((input.termsReference !== null && !text(input.termsReference, 500)) || !Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > 40) invalid();
  const operations = (input.operations as unknown[]).map(o => {
    const r = record(o, invalid);
    exactKeys(r, ['operationCode','category','displayName','billingUnit','creditsPerUnit','maxUnitsPerRequest','requiredCapability','costEvidenceId'], invalid);
    if (typeof r.operationCode !== 'string' || !OPERATION.test(r.operationCode) || !has(CATEGORIES, r.category) || !text(r.displayName, 120)
      || !has(COST_UNITS, r.billingUnit) || !isInt(r.creditsPerUnit, 1, 1_000_000) || !isInt(r.maxUnitsPerRequest, 1, 100_000)
      || !has(CAPABILITIES, r.requiredCapability)
      || (r.category === 'AI_EMPLOYEE_TASK' && !has(['ai.workforce','ai.delegated_jobs','ai.orchestration'], r.requiredCapability))
      || (r.category === 'CAMPAIGN_OPTIMIZATION' && r.requiredCapability !== 'marketing.campaigns_ai_managed')) invalid();
    return { ...r, costEvidenceId: saasUuid(r.costEvidenceId) } as unknown as SaasOperationPriceDraft;
  });
  if (new Set(operations.map(o => o.operationCode)).size !== operations.length) invalid();
  return { termsReference: input.termsReference as string | null, operations };
}
export function validateSaasAllowanceCommand(value: unknown): SaasAllowanceCommand {
  const input = record(value, invalid);
  if (input.action === 'OPEN_CURRENT') { exactKeys(input, ['action','subscriptionId'], invalid); return { action: 'OPEN_CURRENT', subscriptionId: saasUuid(input.subscriptionId) }; }
  if (input.action !== 'EXPIRE') invalid();
  exactKeys(input, ['action','allowanceId','expectedVersion'], invalid);
  if (!isInt(input.expectedVersion, 1, 999_999_999)) invalid();
  return { action: 'EXPIRE', allowanceId: saasUuid(input.allowanceId), expectedVersion: input.expectedVersion };
}
export function validateSaasCreditReserveInput(value: unknown): SaasCreditReserveInput {
  const input = record(value, invalid); exactKeys(input, ['operationCode','units','employeeKey','actionRequestId','workItemId'], invalid);
  if (typeof input.operationCode !== 'string' || !OPERATION.test(input.operationCode) || !isInt(input.units, 1, 100_000)
    || (input.employeeKey !== null && (typeof input.employeeKey !== 'string' || !/^[a-z]{2,20}$/.test(input.employeeKey)))) invalid();
  return { operationCode: input.operationCode, units: input.units, employeeKey: input.employeeKey as string | null,
    actionRequestId: input.actionRequestId === null ? null : saasUuid(input.actionRequestId), workItemId: input.workItemId === null ? null : saasUuid(input.workItemId) };
}
export function validateSaasCreditSettleInput(value: unknown): SaasCreditSettleInput {
  const input = record(value, invalid); exactKeys(input, ['outcome','expectedVersion','finalUnits','providerCostMicrounits','inputUnits','outputUnits'], invalid);
  const units = (v: unknown) => v === null || isInt(v, 0, 999_999_999_999);
  if (!isInt(input.expectedVersion, 1, 999_999_999) || !units(input.inputUnits) || !units(input.outputUnits)) invalid();
  if (input.outcome === 'SUCCEEDED') { if (!isInt(input.finalUnits, 0, 999_999) || !big(input.providerCostMicrounits, 0)) invalid(); }
  else if (input.outcome === 'FAILED') { if (input.finalUnits !== null || !(input.providerCostMicrounits === null || big(input.providerCostMicrounits, 0))) invalid(); }
  else if (input.outcome === 'UNKNOWN') { if (input.finalUnits !== null || input.providerCostMicrounits !== null || input.inputUnits !== null || input.outputUnits !== null) invalid(); }
  else invalid();
  return input as unknown as SaasCreditSettleInput;
}
export function validateSaasCreditResolveInput(value: unknown): SaasCreditResolveInput {
  const input = record(value, invalid); exactKeys(input, ['resolution','expectedVersion','finalUnits','providerCostMicrounits','evidenceReference'], invalid);
  if (!isInt(input.expectedVersion, 1, 999_999_999) || !text(input.evidenceReference, 200)) invalid();
  if (input.resolution === 'SUCCEEDED') { if (!isInt(input.finalUnits, 0, 999_999) || !big(input.providerCostMicrounits, 0)) invalid(); }
  else if (input.resolution === 'NOT_CHARGED') { if (input.finalUnits !== null || !(input.providerCostMicrounits === null || big(input.providerCostMicrounits, 0))) invalid(); }
  else invalid();
  return input as unknown as SaasCreditResolveInput;
}
export function validateSaasCreditEstimateQuery(value: unknown): { operation: string; units: number } {
  const q = record(value ?? {}, invalid); exactKeys(q, ['operation','units'], invalid);
  if (typeof q.operation !== 'string' || !OPERATION.test(q.operation) || typeof q.units !== 'string' || !/^[1-9][0-9]{0,5}$/.test(q.units)) invalid();
  const units = Number(q.units); if (units > 100_000) invalid();
  return { operation: q.operation, units };
}

// ---------- response validators (closed; any drift fails) ----------
function validateProgram(value: unknown): void {
  const p = record(value, drift); exactKeys(p, ['status','version','authorizationReference','changedAt','topUps','overage','purchases'], drift);
  if (!has(['INACTIVE','ACTIVE'], p.status) || !isInt(p.version, 1, 2147483647) || !nullable(p.authorizationReference, (v): v is string => text(v, 200))
    || (p.status === 'ACTIVE' && p.authorizationReference === null) || !isTimestamp(p.changedAt)
    || p.topUps !== 'UNAVAILABLE' || p.overage !== 'DISABLED' || p.purchases !== 'DISABLED') drift();
}
function validateOperation(value: unknown, internal: boolean): void {
  const o = record(value, drift);
  const keys = ['operationCode','category','displayName','billingUnit','creditsPerUnit','maxUnitsPerRequest','requiredCapability'];
  exactKeys(o, internal ? [...keys, 'costEvidenceId','providerId','modelCode','fullyLoadedCostMicrounitsPerUnit','fullyLoadedCostMicrounitsPerCredit'] : keys, drift);
  if (typeof o.operationCode !== 'string' || !OPERATION.test(o.operationCode) || !has(CATEGORIES, o.category) || !text(o.displayName, 120)
    || !has(COST_UNITS, o.billingUnit) || !isInt(o.creditsPerUnit, 1, 1_000_000) || !isInt(o.maxUnitsPerRequest, 1, 100_000) || !has(CAPABILITIES, o.requiredCapability)) drift();
  if (internal && (!isUuid(o.costEvidenceId) || !has(PROVIDERS, o.providerId) || typeof o.modelCode !== 'string' || !big(o.fullyLoadedCostMicrounitsPerUnit)
    || !big(o.fullyLoadedCostMicrounitsPerCredit))) drift();
}
function validatePricing(value: unknown, internal = true): void {
  const p = record(value, drift); exactKeys(p, ['pricingId','pricingVersion','status','termsReference','operations','createdAt','publishedAt','retiredAt'], drift);
  if (!isUuid(p.pricingId) || !isInt(p.pricingVersion, 1, 2147483647) || !has(['DRAFT','PUBLISHED','RETIRED'], p.status)
    || !nullable(p.termsReference, (v): v is string => text(v, 500)) || !Array.isArray(p.operations) || p.operations.length < 1
    || !isTimestamp(p.createdAt) || !nts(p.publishedAt) || !nts(p.retiredAt) || (p.status === 'DRAFT') !== (p.publishedAt === null)
    || (p.status === 'RETIRED') !== (p.retiredAt !== null)) drift();
  (p.operations as unknown[]).forEach(o => validateOperation(o, internal));
}
function validateEvidence(value: unknown): void {
  const e = record(value, drift);
  exactKeys(e, ['costEvidenceId','providerId','modelCode','costUnit','measuredUnits','billedCostMicrounits','fullyLoadedCostMicrounits',
    'fullyLoadedCostMicrounitsPerUnit','source','evidenceReference','periodStart','periodEnd','note','verifiedAt'], drift);
  if (!isUuid(e.costEvidenceId) || !has(PROVIDERS, e.providerId) || typeof e.modelCode !== 'string' || !has(COST_UNITS, e.costUnit)
    || !big(e.measuredUnits) || !big(e.billedCostMicrounits) || !big(e.fullyLoadedCostMicrounits) || !big(e.fullyLoadedCostMicrounitsPerUnit)
    || (e.fullyLoadedCostMicrounits as number) < (e.billedCostMicrounits as number) || e.source !== 'HQ_OWNER_VERIFIED_PROVIDER_BILLING'
    || !text(e.evidenceReference, 200) || !isTimestamp(e.periodStart) || !isTimestamp(e.periodEnd) || !nullable(e.note, (v): v is string => text(v, 500))
    || !isTimestamp(e.verifiedAt)) drift();
}
function validateAllowance(value: unknown, school: boolean): void {
  const a = record(value, drift);
  const keys = ['allowanceId','subscriptionId','periodIndex','periodStart','periodEnd','planCode','allowanceBasis','status','version','balance',
    'thresholds','rollover','topUps','openedAt','expiredAt'];
  exactKeys(a, school ? keys : [...keys, 'organizationId'], drift);
  if (!isUuid(a.allowanceId) || !isUuid(a.subscriptionId) || (!school && !isUuid(a.organizationId)) || !count(a.periodIndex) || !isTimestamp(a.periodStart)
    || !isTimestamp(a.periodEnd) || !has(['CORE','COMPLETE'], a.planCode) || !has(['REGULAR','FOUNDER','LIFETIME','LEGACY'], a.allowanceBasis)
    || !has(['OPEN','EXPIRED'], a.status) || !isInt(a.version, 1, 2147483647) || a.rollover !== 'NONE' || a.topUps !== 'UNAVAILABLE'
    || !isTimestamp(a.openedAt) || !nts(a.expiredAt) || (a.status === 'EXPIRED') !== (a.expiredAt !== null)) drift();
  const b = record(a.balance, drift);
  exactKeys(b, ['allowanceCredits','consumedCredits','heldCredits','expiredCredits','availableCredits','usedPercent'], drift);
  if (!isInt(b.allowanceCredits, 1, 1_000_000) || !count(b.consumedCredits) || !count(b.heldCredits) || !count(b.expiredCredits)
    || !count(b.availableCredits) || !isInt(b.usedPercent, 0, 100)
    || (b.consumedCredits as number) + (b.heldCredits as number) > (b.allowanceCredits as number)
    || (a.status === 'OPEN' && (b.availableCredits as number) !== (b.allowanceCredits as number) - (b.consumedCredits as number) - (b.heldCredits as number))
    || (a.status === 'EXPIRED' && b.availableCredits !== 0)) drift();
  if (!Array.isArray(a.thresholds) || a.thresholds.length > 3) drift();
  (a.thresholds as unknown[]).forEach(t => {
    const r = record(t, drift); exactKeys(r, ['thresholdPercent','reachedAt','notification'], drift);
    if (!has([75, 90, 100], r.thresholdPercent) || !isTimestamp(r.reachedAt) || r.notification !== 'NOT_SENT') drift();
  });
}
function validateReservation(value: unknown, internal: boolean): void {
  const r = record(value, drift);
  const keys = ['reservationId','allowanceId','organizationId','schoolId','subscriptionId','operationCode','category','creditsPerUnit','estimatedUnits',
    'reservedCredits','status','statusReason','version','employeeKey','actionRequestId','workItemId','finalUnits','finalCredits','reservedAt','settledAt'];
  exactKeys(r, internal ? [...keys, 'providerId','modelCode','providerCostMicrounits','usageId','resolutionReference'] : keys, drift);
  if (!isUuid(r.reservationId) || !isUuid(r.allowanceId) || !isUuid(r.organizationId) || !isUuid(r.schoolId) || !isUuid(r.subscriptionId)
    || typeof r.operationCode !== 'string' || !OPERATION.test(r.operationCode) || !has(CATEGORIES, r.category) || !isInt(r.creditsPerUnit, 1, 1_000_000)
    || !isInt(r.estimatedUnits, 1, 100_000) || r.reservedCredits !== (r.creditsPerUnit as number) * (r.estimatedUnits as number)
    || !has(STATES, r.status) || !has(REASONS, r.statusReason) || !isInt(r.version, 1, 2147483647)
    || !nullable(r.employeeKey, (v): v is string => typeof v === 'string' && /^[a-z]{2,20}$/.test(v)) || !nullable(r.actionRequestId, isUuid)
    || !nullable(r.workItemId, isUuid) || !isTimestamp(r.reservedAt) || !nts(r.settledAt)) drift();
  const finalized = r.status === 'FINALIZED';
  if (finalized ? !count(r.finalUnits) || r.finalCredits !== (r.finalUnits as number) * (r.creditsPerUnit as number) || (r.finalCredits as number) > (r.reservedCredits as number)
    : r.finalCredits !== null) drift();
  if ((r.status === 'RESERVED' || r.status === 'OUTCOME_UNKNOWN') !== (r.settledAt === null)) drift();
  if (internal && (!has(PROVIDERS, r.providerId) || typeof r.modelCode !== 'string' || !nullable(r.providerCostMicrounits, count) || !nullable(r.usageId, isUuid)
    || (finalized && (r.usageId === null || r.providerCostMicrounits === null)) || !nullable(r.resolutionReference, (v): v is string => text(v, 200)))) drift();
}

export function validateSaasCreditProgramView(value: unknown): SaasCreditProgramView {
  const r = record(value, drift); exactKeys(r, ['program','publishedPricing','pricingDrafts','costEvidence','premiumCreditsFromOrdinaryUse'], drift);
  validateProgram(r.program);
  if (r.publishedPricing !== null) { validatePricing(r.publishedPricing); if ((r.publishedPricing as SaasPricing).status !== 'PUBLISHED') drift(); }
  if (!Array.isArray(r.pricingDrafts) || r.pricingDrafts.length > 10 || !Array.isArray(r.costEvidence) || r.costEvidence.length > 50) drift();
  (r.pricingDrafts as unknown[]).forEach(p => { validatePricing(p); if ((p as SaasPricing).status !== 'DRAFT') drift(); });
  (r.costEvidence as unknown[]).forEach(validateEvidence);
  if (r.premiumCreditsFromOrdinaryUse !== false || ((r.program as SaasCreditProgram).status === 'ACTIVE' && r.publishedPricing === null)) drift();
  return r as unknown as SaasCreditProgramView;
}
export function validateSaasOrganizationCredits(value: unknown): SaasOrganizationCredits {
  const r = record(value, drift); exactKeys(r, ['organizationId','subscriptionId','program','allowances','reservations','ordinaryUsageThisMonth'], drift);
  if (!isUuid(r.organizationId) || !nullable(r.subscriptionId, isUuid) || !Array.isArray(r.allowances) || r.allowances.length > 12
    || !Array.isArray(r.reservations) || r.reservations.length > 50) drift();
  validateProgram(r.program);
  (r.allowances as unknown[]).forEach(a => validateAllowance(a, false));
  (r.reservations as unknown[]).forEach(x => validateReservation(x, true));
  const o = record(r.ordinaryUsageThisMonth, drift); exactKeys(o, ['events','providerCostMicrounits','premiumDeduction'], drift);
  if (!count(o.events) || !count(o.providerCostMicrounits) || o.premiumDeduction !== 'NONE') drift();
  return r as unknown as SaasOrganizationCredits;
}
export function validateSaasSchoolCredits(value: unknown): SaasSchoolCredits {
  const r = record(value, drift);
  exactKeys(r, ['schoolId','planCode','subscriptionStatus','programStatus','currentAllowance','operations','recentReservations','ordinaryUseConsumesCredits','topUps'], drift);
  if (!isUuid(r.schoolId) || !nullable(r.planCode, (v): v is string => has(['ESSENTIAL','CORE','COMPLETE'], v))
    || !nullable(r.subscriptionStatus, (v): v is string => has(['PENDING_ACTIVATION','IN_SERVICE','SUSPENDED'], v))
    || !has(['INACTIVE','ACTIVE'], r.programStatus) || r.ordinaryUseConsumesCredits !== false || r.topUps !== 'UNAVAILABLE'
    || !Array.isArray(r.operations) || !Array.isArray(r.recentReservations) || r.recentReservations.length > 20) drift();
  if (r.currentAllowance !== null) validateAllowance(r.currentAllowance, true);
  (r.operations as unknown[]).forEach(o => validateOperation(o, false));
  (r.recentReservations as unknown[]).forEach(x => validateReservation(x, false));
  return r as unknown as SaasSchoolCredits;
}
export function validateSaasCreditEstimate(value: unknown): SaasCreditEstimate {
  const r = record(value, drift);
  exactKeys(r, ['operationCode','category','units','creditsPerUnit','estimatedCredits','availableCredits','allowed','refusal','estimateOnly'], drift);
  if (typeof r.operationCode !== 'string' || !has(CATEGORIES, r.category) || !isInt(r.units, 1, 100_000) || !isInt(r.creditsPerUnit, 1, 1_000_000)
    || r.estimatedCredits !== (r.units as number) * (r.creditsPerUnit as number) || !nullable(r.availableCredits, count) || typeof r.allowed !== 'boolean'
    || !nullable(r.refusal, (v): v is string => has(REFUSALS, v)) || r.allowed !== (r.refusal === null) || r.estimateOnly !== true) drift();
  return r as unknown as SaasCreditEstimate;
}
export function validateSaasCreditProgramReceipt(value: unknown): SaasCreditProgramReceipt {
  const r = record(value, drift); exactKeys(r, ['program','replayed'], drift); validateProgram(r.program);
  if (typeof r.replayed !== 'boolean') drift();
  return r as unknown as SaasCreditProgramReceipt;
}
export function validateSaasCostEvidenceReceipt(value: unknown): SaasCostEvidenceReceipt {
  const r = record(value, drift); exactKeys(r, ['costEvidence','replayed'], drift); validateEvidence(r.costEvidence);
  if (typeof r.replayed !== 'boolean') drift();
  return r as unknown as SaasCostEvidenceReceipt;
}
export function validateSaasPricingReceipt(value: unknown): SaasPricingReceipt {
  const r = record(value, drift); exactKeys(r, ['pricing','replayed'], drift); validatePricing(r.pricing);
  if ((r.pricing as SaasPricing).status !== 'DRAFT' || typeof r.replayed !== 'boolean') drift();
  return r as unknown as SaasPricingReceipt;
}
export function validateSaasPricingPublishReceipt(value: unknown): SaasPricingPublishReceipt {
  const r = record(value, drift); exactKeys(r, ['pricing','retiredPricingId','replayed'], drift); validatePricing(r.pricing);
  if ((r.pricing as SaasPricing).status === 'DRAFT' || !nullable(r.retiredPricingId, isUuid) || typeof r.replayed !== 'boolean') drift();
  return r as unknown as SaasPricingPublishReceipt;
}
export function validateSaasAllowanceReceipt(value: unknown): SaasAllowanceReceipt {
  const r = record(value, drift); exactKeys(r, ['allowance','action','replayed'], drift); validateAllowance(r.allowance, false);
  if (!has(['OPEN_CURRENT','EXPIRE'], r.action) || typeof r.replayed !== 'boolean') drift();
  return r as unknown as SaasAllowanceReceipt;
}
export function validateSaasCreditReservationReceipt(value: unknown): SaasCreditReservationReceipt {
  const r = record(value, drift); exactKeys(r, ['reservation','allowance','replayed'], drift);
  validateReservation(r.reservation, false); validateAllowance(r.allowance, true);
  if (typeof r.replayed !== 'boolean') drift();
  return r as unknown as SaasCreditReservationReceipt;
}
export function validateSaasCreditResolveReceipt(value: unknown): SaasCreditResolveReceipt {
  const r = record(value, drift); exactKeys(r, ['reservation','replayed'], drift); validateReservation(r.reservation, true);
  if (typeof r.replayed !== 'boolean') drift();
  return r as unknown as SaasCreditResolveReceipt;
}
