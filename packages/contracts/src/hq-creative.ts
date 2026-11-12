// M2 HQ Creative Studio + HQ creative budget (migration 0253): HON's own image and video requests for marketing HON OS,
// paid from a separate monthly HQ credit budget the human HQ owner sets. Same published operation codes, unit rates and
// prompt rule as the school Creative Studio (0216), but never a school wallet. A credit cap is an internal planning limit,
// never a charge or a provider budget. Views carry no provider identity, model or provider cost.
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsInt as isInt,
  championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsRecord as record } from './champions-club.js';
import { CREATIVE_ASSET_MEDIA_TYPES, CREATIVE_GENERATION_FORMATS, CREATIVE_GENERATION_LIMITS, isCreativePrompt,
  type CreativeAssetMediaType, type CreativeGenerationFormat } from './creative-studio.js';
import { isHqMarketingDate, type HqMarketingPerson } from './hq-marketing.js';
import type { SaasCreativeBillingUnit, SaasCreativeMediaKind } from './saas-creative-wallet.js';

export const HQ_CREATIVE_STATUSES = ['GENERATING', 'SUCCEEDED', 'FAILED', 'UNDER_REVIEW', 'RESOLVED_CHARGED', 'RESOLVED_NOT_CHARGED'] as const;
export type HqCreativeStatus = typeof HQ_CREATIVE_STATUSES[number];
export const HQ_CREATIVE_FAILURE_REASONS = ['PROVIDER_REJECTED', 'PROVIDER_NOT_CONNECTED', 'INVALID_REQUEST', 'PROVIDER_UNKNOWN', 'UNVERIFIED_RESULT', 'INTERRUPTED'] as const;
export type HqCreativeFailureReason = typeof HQ_CREATIVE_FAILURE_REASONS[number];
export const HQ_CREATIVE_LIMITS = { maxCap: 10_000_000, maxInProgress: 3, listLimit: 50, historyLimit: 12, reason: 300, evidence: 200, monthsAhead: 12 } as const;
export const HQ_CREATIVE_PROVIDER_STATES = ['CONNECTED', 'NOT_CONNECTED'] as const;
export type HqCreativeProviderState = typeof HQ_CREATIVE_PROVIDER_STATES[number];

const OPERATION = /^[a-z][a-z0-9_.]{2,59}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const has = (list: readonly unknown[], v: unknown) => list.includes(v);
const text = (v: unknown, min: number, max: number): v is string =>
  typeof v === 'string' && v.trim() === v && v.length >= min && v.length <= max && !CONTROL.test(v);
const isMonth = (v: unknown): v is string => isHqMarketingDate(v) && (v as string).endsWith('-01');

// ---------- inputs ----------
export interface HqCreativeGenerationInput { operationCode: string; units: number; format: CreativeGenerationFormat; prompt: string; campaignId: string | null }
export interface HqCreativeBudgetInput { periodStart: string; creditCap: number; expectedVersion: number | null; reason: string }
export type HqCreativeResolveInput =
  | { expectedVersion: number; resolution: 'SUCCEEDED'; finalUnits: number; providerCostMicrounits: number | null; evidenceReference: string }
  | { expectedVersion: number; resolution: 'NOT_CHARGED'; finalUnits: null; providerCostMicrounits: number | null; evidenceReference: string };

export function validateHqCreativeGenerationInput(value: unknown): HqCreativeGenerationInput {
  const r = record(value, invalid); exactKeys(r, ['operationCode', 'units', 'format', 'prompt', 'campaignId'], invalid);
  if (typeof r.operationCode !== 'string' || !OPERATION.test(r.operationCode) || !isInt(r.units, 1, CREATIVE_GENERATION_LIMITS.maxUnits)
    || !has(CREATIVE_GENERATION_FORMATS, r.format) || !isCreativePrompt(r.prompt) || !(r.campaignId === null || isUuid(r.campaignId))) invalid();
  return { operationCode: r.operationCode as string, units: r.units as number, format: r.format as CreativeGenerationFormat, prompt: r.prompt as string,
    campaignId: r.campaignId === null ? null : (r.campaignId as string).toLowerCase() };
}
export function validateHqCreativeBudgetInput(value: unknown): HqCreativeBudgetInput {
  const r = record(value, invalid); exactKeys(r, ['periodStart', 'creditCap', 'expectedVersion', 'reason'], invalid);
  if (!isMonth(r.periodStart) || !isInt(r.creditCap, 0, HQ_CREATIVE_LIMITS.maxCap) || !(r.expectedVersion === null || isInt(r.expectedVersion, 1, 999_999_999))
    || !text(r.reason, 3, HQ_CREATIVE_LIMITS.reason)) invalid();
  return { periodStart: r.periodStart as string, creditCap: r.creditCap as number, expectedVersion: r.expectedVersion as number | null, reason: r.reason as string };
}
export function validateHqCreativeResolveInput(value: unknown): HqCreativeResolveInput {
  const r = record(value, invalid); exactKeys(r, ['expectedVersion', 'resolution', 'finalUnits', 'providerCostMicrounits', 'evidenceReference'], invalid);
  if (!isInt(r.expectedVersion, 1, 999_999_999) || !has(['SUCCEEDED', 'NOT_CHARGED'], r.resolution)
    || !(r.resolution === 'SUCCEEDED' ? isInt(r.finalUnits, 0, CREATIVE_GENERATION_LIMITS.maxUnits) : r.finalUnits === null)
    || !(r.providerCostMicrounits === null || isInt(r.providerCostMicrounits, 0, 999_999_999_999_999)) || !text(r.evidenceReference, 1, HQ_CREATIVE_LIMITS.evidence)) invalid();
  return r as unknown as HqCreativeResolveInput;
}

// ---------- views ----------
export interface HqCreativeViewer extends HqMarketingPerson { canManage: boolean; isOwner: boolean }
export interface HqCreativeBudget {
  periodStart: string; creditCap: number | null; usedCredits: number; heldCredits: number; availableCredits: number; inProgress: number;
  version: number | null; setBy: HqMarketingPerson | null; setAt: string | null;
}
export interface HqCreativeBudgetChange {
  periodStart: string; version: number; creditCap: number; previousCap: number | null; reason: string; actor: HqMarketingPerson; recordedAt: string;
}
export interface HqCreativeRate {
  operationCode: string; mediaKind: SaasCreativeMediaKind; displayName: string; billingUnit: SaasCreativeBillingUnit; creditsPerUnit: number; maxUnitsPerRequest: number;
}
export interface HqCreativeAsset {
  assetId: string; ordinal: number; mediaType: CreativeAssetMediaType; width: number; height: number; durationSeconds: number | null; origin: 'SYNTHETIC';
}
export interface HqCreativeGeneration {
  generationId: string; periodStart: string; campaign: { campaignId: string; code: string; name: string } | null; operationCode: string;
  mediaKind: SaasCreativeMediaKind; units: number; format: CreativeGenerationFormat; prompt: string; status: HqCreativeStatus;
  failureReason: HqCreativeFailureReason | null; reservedCredits: number; chargedCredits: number | null; requestedBy: HqMarketingPerson;
  version: number; createdAt: string; completedAt: string | null; assets: HqCreativeAsset[];
}
export interface HqCreativeStudioRecords {
  budget: HqCreativeBudget; budgetHistory: HqCreativeBudgetChange[]; rates: HqCreativeRate[]; generations: HqCreativeGeneration[];
  limit: 50; viewer: HqCreativeViewer; asOf: string;
}
export interface HqCreativeStudio extends HqCreativeStudioRecords { provider: HqCreativeProviderState }
export interface HqCreativeGenerationReceipt { generation: HqCreativeGeneration; budget: HqCreativeBudget; replayed: boolean }
export interface HqCreativeBudgetReceipt { budget: HqCreativeBudget; replayed: boolean }

const CREDITS = Number.MAX_SAFE_INTEGER;
function person(value: unknown): HqMarketingPerson {
  const p = record(value, drift); exactKeys(p, ['principalId', 'displayName'], drift);
  if (!isUuid(p.principalId) || !text(p.displayName, 1, 120)) drift();
  return p as unknown as HqMarketingPerson;
}
function budget(value: unknown): HqCreativeBudget {
  const b = record(value, drift);
  exactKeys(b, ['periodStart', 'creditCap', 'usedCredits', 'heldCredits', 'availableCredits', 'inProgress', 'version', 'setBy', 'setAt'], drift);
  if (!isMonth(b.periodStart) || !isInt(b.usedCredits, 0, CREDITS) || !isInt(b.heldCredits, 0, CREDITS) || !isInt(b.availableCredits, 0, CREDITS)
    || !isInt(b.inProgress, 0, 1_000_000)) drift();
  if (b.creditCap === null) {
    if (b.version !== null || b.setBy !== null || b.setAt !== null || b.availableCredits !== 0) drift();
  } else {
    if (!isInt(b.creditCap, 0, HQ_CREATIVE_LIMITS.maxCap) || !isInt(b.version, 1, 999_999_999) || !isTimestamp(b.setAt)) drift();
    person(b.setBy);
    if ((b.availableCredits as number) !== Math.max((b.creditCap as number) - (b.usedCredits as number) - (b.heldCredits as number), 0)) drift();
  }
  return b as unknown as HqCreativeBudget;
}
function asset(value: unknown, kind: SaasCreativeMediaKind, ordinal: number): void {
  const a = record(value, drift); exactKeys(a, ['assetId', 'ordinal', 'mediaType', 'width', 'height', 'durationSeconds', 'origin'], drift);
  if (!isUuid(a.assetId) || a.ordinal !== ordinal || !has(CREATIVE_ASSET_MEDIA_TYPES[kind], a.mediaType) || !isInt(a.width, 1, 8192) || !isInt(a.height, 1, 8192)
    || a.origin !== 'SYNTHETIC' || (kind === 'IMAGE' ? a.durationSeconds !== null : !isInt(a.durationSeconds, 1, 600))) drift();
}
const CHARGED: readonly HqCreativeStatus[] = ['SUCCEEDED', 'RESOLVED_CHARGED'];
export function validateHqCreativeGeneration(value: unknown): HqCreativeGeneration {
  const g = record(value, drift);
  exactKeys(g, ['generationId', 'periodStart', 'campaign', 'operationCode', 'mediaKind', 'units', 'format', 'prompt', 'status', 'failureReason',
    'reservedCredits', 'chargedCredits', 'requestedBy', 'version', 'createdAt', 'completedAt', 'assets'], drift);
  if (!isUuid(g.generationId) || !isMonth(g.periodStart) || typeof g.operationCode !== 'string' || !OPERATION.test(g.operationCode)
    || !has(['IMAGE', 'VIDEO'], g.mediaKind) || !isInt(g.units, 1, CREATIVE_GENERATION_LIMITS.maxUnits) || !has(CREATIVE_GENERATION_FORMATS, g.format)
    || !isCreativePrompt(g.prompt) || !has(HQ_CREATIVE_STATUSES, g.status) || !(g.failureReason === null || has(HQ_CREATIVE_FAILURE_REASONS, g.failureReason))
    || !isInt(g.reservedCredits, 1, CREDITS) || !isInt(g.version, 1, 999_999_999) || !isTimestamp(g.createdAt)
    || !(g.completedAt === null || isTimestamp(g.completedAt)) || !Array.isArray(g.assets) || g.assets.length > CREATIVE_GENERATION_LIMITS.maxAssets) drift();
  if (g.campaign !== null) {
    const c = record(g.campaign, drift); exactKeys(c, ['campaignId', 'code', 'name'], drift);
    if (!isUuid(c.campaignId) || !text(c.code, 2, 40) || !text(c.name, 3, 120)) drift();
  }
  person(g.requestedBy);
  const status = g.status as HqCreativeStatus;
  if (CHARGED.includes(status) ? !isInt(g.chargedCredits, 0, g.reservedCredits as number) : g.chargedCredits !== null) drift();
  if ((status === 'GENERATING') !== (g.completedAt === null)) drift();
  if ((status === 'SUCCEEDED') !== ((g.assets as unknown[]).length > 0)) drift();
  if ((status === 'GENERATING' || status === 'SUCCEEDED') && g.failureReason !== null) drift();
  if ((status === 'FAILED' || status === 'UNDER_REVIEW') && g.failureReason === null) drift();
  if (status === 'FAILED' && !has(['PROVIDER_REJECTED', 'PROVIDER_NOT_CONNECTED', 'INVALID_REQUEST'], g.failureReason)) drift();
  if (status === 'UNDER_REVIEW' && !has(['PROVIDER_UNKNOWN', 'UNVERIFIED_RESULT', 'INTERRUPTED'], g.failureReason)) drift();
  if (g.completedAt !== null && Date.parse(g.completedAt as string) < Date.parse(g.createdAt as string)) drift();
  if (g.mediaKind === 'VIDEO' && (g.assets as unknown[]).length > 1) drift();
  (g.assets as unknown[]).forEach((a, i) => asset(a, g.mediaKind as SaasCreativeMediaKind, i + 1));
  return g as unknown as HqCreativeGeneration;
}
function viewer(value: unknown): HqCreativeViewer {
  const v = record(value, drift); exactKeys(v, ['principalId', 'displayName', 'canManage', 'isOwner'], drift);
  if (!isUuid(v.principalId) || !text(v.displayName, 1, 120) || typeof v.canManage !== 'boolean' || typeof v.isOwner !== 'boolean' || (v.isOwner && !v.canManage)) drift();
  return v as unknown as HqCreativeViewer;
}
function rate(value: unknown): void {
  const r = record(value, drift); exactKeys(r, ['operationCode', 'mediaKind', 'displayName', 'billingUnit', 'creditsPerUnit', 'maxUnitsPerRequest'], drift);
  if (typeof r.operationCode !== 'string' || !OPERATION.test(r.operationCode) || !has(['IMAGE', 'VIDEO'], r.mediaKind) || !text(r.displayName, 1, 120)
    || !has(['IMAGE', 'VIDEO_SECOND', 'REQUEST'], r.billingUnit) || !isInt(r.creditsPerUnit, 1, 1_000_000) || !isInt(r.maxUnitsPerRequest, 1, 1000)) drift();
}
function records(r: Record<string, unknown>): void {
  if (r.limit !== HQ_CREATIVE_LIMITS.listLimit || !isTimestamp(r.asOf) || !Array.isArray(r.budgetHistory) || r.budgetHistory.length > HQ_CREATIVE_LIMITS.historyLimit
    || !Array.isArray(r.rates) || !Array.isArray(r.generations) || r.generations.length > HQ_CREATIVE_LIMITS.listLimit) drift();
  budget(r.budget); viewer(r.viewer);
  (r.rates as unknown[]).forEach(rate);
  const codes = (r.rates as HqCreativeRate[]).map(x => x.operationCode);
  if (new Set(codes).size !== codes.length) drift();
  (r.budgetHistory as unknown[]).forEach(value => {
    const h = record(value, drift); exactKeys(h, ['periodStart', 'version', 'creditCap', 'previousCap', 'reason', 'actor', 'recordedAt'], drift);
    if (!isMonth(h.periodStart) || !isInt(h.version, 1, 999_999_999) || !isInt(h.creditCap, 0, HQ_CREATIVE_LIMITS.maxCap)
      || ((h.version === 1) !== (h.previousCap === null)) || !(h.previousCap === null || isInt(h.previousCap, 0, HQ_CREATIVE_LIMITS.maxCap))
      || !text(h.reason, 3, HQ_CREATIVE_LIMITS.reason) || !isTimestamp(h.recordedAt)) drift();
    person(h.actor);
  });
  const gens = (r.generations as unknown[]).map(validateHqCreativeGeneration);
  if (new Set(gens.map(g => g.generationId)).size !== gens.length) drift();
  for (let i = 1; i < gens.length; i++) if (Date.parse(gens[i - 1]!.createdAt) < Date.parse(gens[i]!.createdAt)) drift();
}
/** The database read (0253). */
export function validateHqCreativeStudioRecords(value: unknown): HqCreativeStudioRecords {
  const r = record(value, drift); exactKeys(r, ['budget', 'budgetHistory', 'rates', 'generations', 'limit', 'viewer', 'asOf'], drift);
  records(r); return r as unknown as HqCreativeStudioRecords;
}
/** The API view: the records plus whether a generation provider is connected (server runtime, never a client choice). */
export function validateHqCreativeStudio(value: unknown): HqCreativeStudio {
  const r = record(value, drift); exactKeys(r, ['provider', 'budget', 'budgetHistory', 'rates', 'generations', 'limit', 'viewer', 'asOf'], drift);
  if (!has(HQ_CREATIVE_PROVIDER_STATES, r.provider)) drift();
  records(r); return r as unknown as HqCreativeStudio;
}
export function validateHqCreativeGenerationReceipt(value: unknown): HqCreativeGenerationReceipt {
  const r = record(value, drift); exactKeys(r, ['generation', 'budget', 'replayed'], drift);
  if (typeof r.replayed !== 'boolean') drift();
  const g = validateHqCreativeGeneration(r.generation); const b = budget(r.budget);
  if (g.periodStart !== b.periodStart) drift();
  return r as unknown as HqCreativeGenerationReceipt;
}
export function validateHqCreativeBudgetReceipt(value: unknown): HqCreativeBudgetReceipt {
  const r = record(value, drift); exactKeys(r, ['budget', 'replayed'], drift);
  if (typeof r.replayed !== 'boolean') drift();
  if (budget(r.budget).creditCap === null) drift();
  return r as unknown as HqCreativeBudgetReceipt;
}
