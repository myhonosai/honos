// CS1 Creative Studio generation (proposed migration 0216) closed contracts. A generation is one image or short-video
// request by staff of ONE school, paid from that school's own creative wallet (CW1, 0202). The AI team is never involved
// and never charged. School views carry no provider identity, model, provider cost or HQ notes. Credits are reserved
// before the provider call and settled after it: SUCCEEDED charges the actual units (never above the reservation),
// FAILED returns everything, UNDER_REVIEW holds the credits until the HQ owner resolves the outcome with evidence.
// CS1 records only SYNTHETIC result metadata (fake providers); real media storage and signed reads are a later slice.
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsInt as isInt,
  championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsRecord as record } from './champions-club.js';
import { validateSaasCreativeBalance, type SaasCreativeBalance, type SaasCreativeMediaKind } from './saas-creative-wallet.js';

export const CREATIVE_GENERATION_FORMATS = ['SQUARE', 'PORTRAIT', 'LANDSCAPE'] as const;
export type CreativeGenerationFormat = typeof CREATIVE_GENERATION_FORMATS[number];
export const CREATIVE_GENERATION_STATUSES = ['GENERATING', 'SUCCEEDED', 'FAILED', 'UNDER_REVIEW', 'RESOLVED_CHARGED', 'RESOLVED_NOT_CHARGED'] as const;
export type CreativeGenerationStatus = typeof CREATIVE_GENERATION_STATUSES[number];
export const CREATIVE_GENERATION_FAILURE_REASONS = ['PROVIDER_NOT_CONNECTED', 'INVALID_REQUEST', 'PROVIDER_REJECTED', 'PROVIDER_UNKNOWN', 'UNVERIFIED_RESULT', 'INTERRUPTED'] as const;
export type CreativeGenerationFailureReason = typeof CREATIVE_GENERATION_FAILURE_REASONS[number];
export const CREATIVE_ASSET_MEDIA_TYPES = { IMAGE: ['image/png', 'image/webp'], VIDEO: ['video/mp4'] } as const;
export type CreativeAssetMediaType = 'image/png' | 'image/webp' | 'video/mp4';
/** Limits shared by the database (0216) and the API. */
export const CREATIVE_GENERATION_LIMITS = { promptCharacters: 1000, maxUnits: 1000, maxAssets: 8, listLimit: 50, maxInProgressPerSchool: 3, interruptedAfterSeconds: 120 } as const;
export const CREATIVE_STUDIO_PROVIDER_STATES = ['CONNECTED', 'NOT_CONNECTED'] as const;
export type CreativeStudioProviderState = typeof CREATIVE_STUDIO_PROVIDER_STATES[number];

export interface CreativeGenerationInput { operationCode: string; units: number; format: CreativeGenerationFormat; prompt: string }
export interface CreativeGenerationAsset {
  assetId: string; ordinal: number; mediaType: CreativeAssetMediaType; width: number; height: number; durationSeconds: number | null; origin: 'SYNTHETIC' | 'PROVIDER';
}
export interface CreativeGeneration {
  generationId: string; schoolId: string; operationCode: string; mediaKind: SaasCreativeMediaKind; units: number; format: CreativeGenerationFormat; prompt: string;
  status: CreativeGenerationStatus; failureReason: CreativeGenerationFailureReason | null; reservedCredits: number; chargedCredits: number | null;
  createdAt: string; completedAt: string | null; assets: CreativeGenerationAsset[];
}
export interface CreativeGenerationRecords { generations: CreativeGeneration[]; limit: 50 }
export interface CreativeStudioGenerationList extends CreativeGenerationRecords { provider: CreativeStudioProviderState }
export interface CreativeGenerationReceipt { generation: CreativeGeneration; balance: SaasCreativeBalance; replayed: boolean }

const OPERATION = /^[a-z][a-z0-9_.]{2,59}$/;
// Printable text plus line breaks and tabs; no other control or bidi-override characters.
const UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/;
const has = (list: readonly unknown[], value: unknown) => list.includes(value);
export function isCreativePrompt(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= CREATIVE_GENERATION_LIMITS.promptCharacters && value.trim() === value && !UNSAFE.test(value);
}

// ---------- input (closed: clients never choose a provider, model, price or school) ----------
export function validateCreativeGenerationInput(value: unknown): CreativeGenerationInput {
  const input = record(value, invalid); exactKeys(input, ['operationCode', 'units', 'format', 'prompt'], invalid);
  // avatar.* operations are reserved for the avatar routes (0276), which record the avatar with its generation.
  if (typeof input.operationCode !== 'string' || !OPERATION.test(input.operationCode) || input.operationCode.startsWith('avatar.') || !isInt(input.units, 1, CREATIVE_GENERATION_LIMITS.maxUnits)
    || !has(CREATIVE_GENERATION_FORMATS, input.format) || !isCreativePrompt(input.prompt)) invalid();
  return { operationCode: input.operationCode as string, units: input.units as number, format: input.format as CreativeGenerationFormat, prompt: input.prompt as string };
}

// ---------- responses (closed; any drift fails) ----------
function validateAsset(value: unknown, mediaKind: SaasCreativeMediaKind, ordinal: number): void {
  const a = record(value, drift); exactKeys(a, ['assetId', 'ordinal', 'mediaType', 'width', 'height', 'durationSeconds', 'origin'], drift);
  if (!isUuid(a.assetId) || a.ordinal !== ordinal || !has(CREATIVE_ASSET_MEDIA_TYPES[mediaKind], a.mediaType) || !isInt(a.width, 1, 8192) || !isInt(a.height, 1, 8192)
    || (a.origin !== 'SYNTHETIC' && a.origin !== 'PROVIDER') || (mediaKind === 'IMAGE' ? a.durationSeconds !== null : !isInt(a.durationSeconds, 1, 600))) drift();
}
export function validateCreativeGeneration(value: unknown): CreativeGeneration {
  const g = record(value, drift);
  exactKeys(g, ['generationId', 'schoolId', 'operationCode', 'mediaKind', 'units', 'format', 'prompt', 'status', 'failureReason', 'reservedCredits',
    'chargedCredits', 'createdAt', 'completedAt', 'assets'], drift);
  if (!isUuid(g.generationId) || !isUuid(g.schoolId) || typeof g.operationCode !== 'string' || !OPERATION.test(g.operationCode) || !has(['IMAGE', 'VIDEO'], g.mediaKind)
    || !isInt(g.units, 1, CREATIVE_GENERATION_LIMITS.maxUnits) || !has(CREATIVE_GENERATION_FORMATS, g.format) || !isCreativePrompt(g.prompt)
    || !has(CREATIVE_GENERATION_STATUSES, g.status) || !(g.failureReason === null || has(CREATIVE_GENERATION_FAILURE_REASONS, g.failureReason))
    || !isInt(g.reservedCredits, 1, 1_000_000_000) || !isTimestamp(g.createdAt) || !(g.completedAt === null || isTimestamp(g.completedAt))
    || !Array.isArray(g.assets) || g.assets.length > CREATIVE_GENERATION_LIMITS.maxAssets) drift();
  const charged = g.status === 'SUCCEEDED' || g.status === 'RESOLVED_CHARGED';
  if (charged ? !isInt(g.chargedCredits, 0, g.reservedCredits as number) : g.chargedCredits !== null) drift();
  if ((g.status === 'GENERATING') !== (g.completedAt === null)) drift();
  if ((g.status === 'SUCCEEDED') !== ((g.assets as unknown[]).length > 0)) drift();
  if ((g.status === 'SUCCEEDED' || g.status === 'GENERATING') && g.failureReason !== null) drift();
  if ((g.status === 'FAILED' || g.status === 'UNDER_REVIEW') && g.failureReason === null) drift();
  if (g.completedAt !== null && Date.parse(g.completedAt as string) < Date.parse(g.createdAt as string)) drift();
  (g.assets as unknown[]).forEach((a, i) => validateAsset(a, g.mediaKind as SaasCreativeMediaKind, i + 1));
  return g as unknown as CreativeGeneration;
}
function validateGenerationArray(value: unknown): void {
  if (!Array.isArray(value) || value.length > CREATIVE_GENERATION_LIMITS.listLimit) drift();
  (value as unknown[]).forEach(validateCreativeGeneration);
  const ids = (value as CreativeGeneration[]).map(g => g.generationId);
  if (new Set(ids).size !== ids.length || new Set((value as CreativeGeneration[]).map(g => g.schoolId)).size > 1) drift();
  for (let i = 1; i < (value as CreativeGeneration[]).length; i++) {
    if (Date.parse((value as CreativeGeneration[])[i - 1]!.createdAt) < Date.parse((value as CreativeGeneration[])[i]!.createdAt)) drift();
  }
}
/** The database read (0216): one school's newest generations. */
export function validateCreativeGenerationRecords(value: unknown): CreativeGenerationRecords {
  const r = record(value, drift); exactKeys(r, ['generations', 'limit'], drift);
  if (r.limit !== CREATIVE_GENERATION_LIMITS.listLimit) drift();
  validateGenerationArray(r.generations);
  return r as unknown as CreativeGenerationRecords;
}
/** The API list view: the records plus whether a generation provider is connected (server runtime, never a client choice). */
export function validateCreativeStudioGenerationList(value: unknown): CreativeStudioGenerationList {
  const r = record(value, drift); exactKeys(r, ['provider', 'generations', 'limit'], drift);
  if (!has(CREATIVE_STUDIO_PROVIDER_STATES, r.provider) || r.limit !== CREATIVE_GENERATION_LIMITS.listLimit) drift();
  validateGenerationArray(r.generations);
  return r as unknown as CreativeStudioGenerationList;
}
export function validateCreativeGenerationReceipt(value: unknown): CreativeGenerationReceipt {
  const r = record(value, drift); exactKeys(r, ['generation', 'balance', 'replayed'], drift);
  if (typeof r.replayed !== 'boolean') drift();
  validateCreativeGeneration(r.generation); validateSaasCreativeBalance(r.balance);
  return r as unknown as CreativeGenerationReceipt;
}
