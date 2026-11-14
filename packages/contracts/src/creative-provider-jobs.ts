// C1 (0354): asynchronous creative provider jobs, per-school daily caps and HON's daily provider spend guard.
// Job receipts are what the runtime gets back when it asks for a permit and records the provider's job id. The HQ
// limits are HON's own provider cost (micro-USD), never a customer balance or a charge. The database decides authority:
// a human HQ owner may change a limit, HQ billing staff may read.
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsTimestamp as isTimestamp,
  championsIsUuid as isUuid, championsRecord as record } from './champions-club.js';

export const CREATIVE_JOB_PROVIDERS = ['HEYGEN', 'HIGGSFIELD'] as const;
export type CreativeJobProvider = typeof CREATIVE_JOB_PROVIDERS[number];
/** $10,000 a day in micro-USD, the database's upper bound for one provider's daily limit. */
export const CREATIVE_PROVIDER_MAX_DAILY_LIMIT_MICROS = 10_000_000_000;
export const CREATIVE_SCHOOL_MAX_DAILY_CAP = 1000;
export const CREATIVE_DEFAULT_SCHOOL_DAILY_CAPS = Object.freeze({ images: 50, videos: 12, avatarVideos: 10 });
/** A provider job id as the database accepts it (1..200 safe characters). */
export const CREATIVE_PROVIDER_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

export interface CreativeProviderJobReceipt {
  jobId: string; generationId: string; status: 'PERMITTED' | 'SUBMITTED'; submitted: boolean; deadlineAt: string; replayed: boolean;
}
export interface CreativeProviderDailyLimitInput { providerId: CreativeJobProvider; dailyLimitMicros: number; reason: string; expectedVersion: number }
export interface CreativeProviderDailyLimitReceipt { providerId: CreativeJobProvider; dailyLimitMicros: number; version: number; replayed: boolean }
export interface CreativeSchoolDailyCaps { images: number; videos: number; avatarVideos: number }
export interface CreativeSchoolDailyCapsInput extends CreativeSchoolDailyCaps { schoolId: string; reason: string; expectedVersion: number }
export interface CreativeSchoolDailyCapsReceipt extends CreativeSchoolDailyCaps { schoolId: string; version: number; replayed: boolean }
export interface CreativeProviderLimitStatus {
  providerId: CreativeJobProvider; dailyLimitMicros: number | null; version: number; reason: string | null; committedTodayMicros: number; openJobs: number;
}
export interface CreativeRequesterUnavailableJob {
  jobId: string; schoolId: string; reservationId: string; providerId: CreativeJobProvider; closedAt: string; providerResult: Record<string, unknown> | null;
}
export interface CreativeSchoolDailyCapsRow extends CreativeSchoolDailyCaps { schoolId: string; reason: string; version: number }
export interface CreativeLimitsHqView {
  providers: CreativeProviderLimitStatus[]; requesterUnavailable: CreativeRequesterUnavailableJob[]; defaultSchoolCaps: CreativeSchoolDailyCaps;
  schoolCaps: CreativeSchoolDailyCapsRow[]; day: { start: string; end: string };
}

const isReason = (v: unknown): v is string => typeof v === 'string' && v === v.trim() && v.length >= 10 && v.length <= 500;
const isCount = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
const isProvider = (v: unknown): v is CreativeJobProvider => (CREATIVE_JOB_PROVIDERS as readonly unknown[]).includes(v);
const isCap = (v: unknown): v is number => isCount(v, CREATIVE_SCHOOL_MAX_DAILY_CAP);
const isLimit = (v: unknown): v is number => isCount(v, CREATIVE_PROVIDER_MAX_DAILY_LIMIT_MICROS);
const isVersion = (v: unknown): v is number => isCount(v, 999_999_999);

export function validateCreativeProviderJobReceipt(value: unknown): CreativeProviderJobReceipt {
  const r = record(value, drift); exactKeys(r, ['jobId', 'generationId', 'status', 'submitted', 'deadlineAt', 'replayed'], drift);
  if (!isUuid(r.jobId) || !isUuid(r.generationId) || !(r.status === 'PERMITTED' || r.status === 'SUBMITTED') || r.submitted !== (r.status === 'SUBMITTED')
    || !isTimestamp(r.deadlineAt) || typeof r.replayed !== 'boolean') drift();
  return r as unknown as CreativeProviderJobReceipt;
}

export function validateCreativeProviderDailyLimitInput(value: unknown): CreativeProviderDailyLimitInput {
  const r = record(value, invalid); exactKeys(r, ['providerId', 'dailyLimitMicros', 'reason', 'expectedVersion'], invalid);
  if (!isProvider(r.providerId) || !isLimit(r.dailyLimitMicros) || !isReason(r.reason) || !isVersion(r.expectedVersion)) invalid();
  return { providerId: r.providerId, dailyLimitMicros: r.dailyLimitMicros, reason: r.reason, expectedVersion: r.expectedVersion };
}

export function validateCreativeProviderDailyLimitReceipt(value: unknown): CreativeProviderDailyLimitReceipt {
  const r = record(value, drift); exactKeys(r, ['providerId', 'dailyLimitMicros', 'version', 'replayed'], drift);
  if (!isProvider(r.providerId) || !isLimit(r.dailyLimitMicros) || !isVersion(r.version) || (r.version as number) < 1 || typeof r.replayed !== 'boolean') drift();
  return r as unknown as CreativeProviderDailyLimitReceipt;
}

export function validateCreativeSchoolDailyCapsInput(value: unknown): CreativeSchoolDailyCapsInput {
  const r = record(value, invalid); exactKeys(r, ['schoolId', 'images', 'videos', 'avatarVideos', 'reason', 'expectedVersion'], invalid);
  if (!isUuid(r.schoolId) || !isCap(r.images) || !isCap(r.videos) || !isCap(r.avatarVideos) || !isReason(r.reason) || !isVersion(r.expectedVersion)) invalid();
  return { schoolId: r.schoolId, images: r.images, videos: r.videos, avatarVideos: r.avatarVideos, reason: r.reason, expectedVersion: r.expectedVersion };
}

export function validateCreativeSchoolDailyCapsReceipt(value: unknown): CreativeSchoolDailyCapsReceipt {
  const r = record(value, drift); exactKeys(r, ['schoolId', 'images', 'videos', 'avatarVideos', 'version', 'replayed'], drift);
  if (!isUuid(r.schoolId) || !isCap(r.images) || !isCap(r.videos) || !isCap(r.avatarVideos) || !isVersion(r.version) || (r.version as number) < 1
    || typeof r.replayed !== 'boolean') drift();
  return r as unknown as CreativeSchoolDailyCapsReceipt;
}

function validateProviderStatus(value: unknown): CreativeProviderLimitStatus {
  const r = record(value, drift); exactKeys(r, ['providerId', 'dailyLimitMicros', 'version', 'reason', 'committedTodayMicros', 'openJobs'], drift);
  if (!isProvider(r.providerId) || !isVersion(r.version) || !isCount(r.committedTodayMicros) || !isCount(r.openJobs)) drift();
  // No row: no limit, no reason, version 0 (the guard refuses every real submission). A row always carries its reason.
  if (r.version === 0 ? !(r.dailyLimitMicros === null && r.reason === null) : !(isLimit(r.dailyLimitMicros) && isReason(r.reason))) drift();
  return r as unknown as CreativeProviderLimitStatus;
}

function validateUnavailable(value: unknown): CreativeRequesterUnavailableJob {
  const r = record(value, drift); exactKeys(r, ['jobId', 'schoolId', 'reservationId', 'providerId', 'closedAt', 'providerResult'], drift);
  if (!isUuid(r.jobId) || !isUuid(r.schoolId) || !isUuid(r.reservationId) || !isProvider(r.providerId) || !isTimestamp(r.closedAt)
    || !(r.providerResult === null || (typeof r.providerResult === 'object' && !Array.isArray(r.providerResult)))) drift();
  return r as unknown as CreativeRequesterUnavailableJob;
}

function validateCaps(value: unknown): CreativeSchoolDailyCaps {
  const r = record(value, drift); exactKeys(r, ['images', 'videos', 'avatarVideos'], drift);
  if (!isCap(r.images) || !isCap(r.videos) || !isCap(r.avatarVideos)) drift();
  return { images: r.images, videos: r.videos, avatarVideos: r.avatarVideos };
}

function validateCapsRow(value: unknown): CreativeSchoolDailyCapsRow {
  const r = record(value, drift); exactKeys(r, ['schoolId', 'images', 'videos', 'avatarVideos', 'reason', 'version'], drift);
  if (!isUuid(r.schoolId) || !isCap(r.images) || !isCap(r.videos) || !isCap(r.avatarVideos) || !isReason(r.reason) || !isVersion(r.version) || (r.version as number) < 1) drift();
  return r as unknown as CreativeSchoolDailyCapsRow;
}

export function validateCreativeLimitsHqView(value: unknown): CreativeLimitsHqView {
  const r = record(value, drift); exactKeys(r, ['providers', 'requesterUnavailable', 'defaultSchoolCaps', 'schoolCaps', 'day'], drift);
  if (!Array.isArray(r.providers) || !Array.isArray(r.requesterUnavailable) || r.requesterUnavailable.length > 100 || !Array.isArray(r.schoolCaps)
    || r.schoolCaps.length > 500) drift();
  const providers = r.providers.map(validateProviderStatus);
  if (providers.map(p => p.providerId).join(',') !== CREATIVE_JOB_PROVIDERS.join(',')) drift();
  const defaults = validateCaps(r.defaultSchoolCaps);
  if (JSON.stringify(defaults) !== JSON.stringify(CREATIVE_DEFAULT_SCHOOL_DAILY_CAPS)) drift();
  const schoolCaps = r.schoolCaps.map(validateCapsRow);
  if (new Set(schoolCaps.map(c => c.schoolId)).size !== schoolCaps.length) drift();
  const day = record(r.day, drift); exactKeys(day, ['start', 'end'], drift);
  if (!isTimestamp(day.start) || !isTimestamp(day.end) || Date.parse(day.end) - Date.parse(day.start) !== 86_400_000) drift();
  return { providers, requesterUnavailable: r.requesterUnavailable.map(validateUnavailable), defaultSchoolCaps: defaults, schoolCaps,
    day: { start: day.start as string, end: day.end as string } };
}
