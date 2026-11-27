import { CREATIVE_PROVIDER_MAX_DAILY_LIMIT_MICROS, CREATIVE_SCHOOL_MAX_DAILY_CAP, validateCreativeProviderDailyLimitInput, validateCreativeSchoolDailyCapsInput,
  type CreativeLimitsHqView, type CreativeProviderDailyLimitInput, type CreativeProviderLimitStatus, type CreativeSchoolDailyCaps,
  type CreativeSchoolDailyCapsInput } from '@hon/contracts';

/** The person's typed forms, as strings. */
export type ProviderDraft = Readonly<{ dollars: string; reason: string }>;
export type SchoolDraft = Readonly<{ schoolId: string; images: string; videos: string; avatarVideos: string; reason: string }>;

const reasonOf = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Dollars typed by a person ("25", "25.5", "1,000.50") as exact micro-USD, or null. HON's own provider cost, never a customer charge. */
export function microsFromDollars(text: string): number | null {
  const m = /^(\d{1,5})(?:\.(\d{1,2}))?$/.exec(text.trim().replace(/,/g, ''));
  if (!m) return null;
  const micros = (Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))) * 10_000;
  return Number.isSafeInteger(micros) && micros <= CREATIVE_PROVIDER_MAX_DAILY_LIMIT_MICROS ? micros : null;
}
/** Micro-USD as an editable dollar string ("25", "25.50"); sub-cent amounts are shown rounded down to the cent. */
export function dollarsFromMicros(micros: number): string {
  const cents = Math.floor(micros / 10_000), rest = cents % 100;
  return rest === 0 ? String(Math.floor(cents / 100)) : `${Math.floor(cents / 100)}.${String(rest).padStart(2, '0')}`;
}
const whole = (text: string, max: number): number | null => {
  const t = text.trim();
  return /^\d{1,4}$/.test(t) && Number(t) <= max ? Number(t) : null;
};

/** The provider limit as a closed command against the version that was read, or null when the form is not one. */
export function providerInputFrom(d: ProviderDraft, p: CreativeProviderLimitStatus): CreativeProviderDailyLimitInput | null {
  const micros = microsFromDollars(d.dollars);
  if (micros === null) return null;
  try { return validateCreativeProviderDailyLimitInput({ providerId: p.providerId, dailyLimitMicros: micros, reason: reasonOf(d.reason), expectedVersion: p.version }); }
  catch { return null; }
}
/** A school's caps as they stand now: its own row, or the defaults (version 0) when HQ never set one. */
export function capsFor(view: CreativeLimitsHqView, schoolId: string): CreativeSchoolDailyCaps & { version: number; custom: boolean } {
  const row = view.schoolCaps.find(c => c.schoolId.toLowerCase() === schoolId.toLowerCase());
  return row ? { images: row.images, videos: row.videos, avatarVideos: row.avatarVideos, version: row.version, custom: true }
    : { ...view.defaultSchoolCaps, version: 0, custom: false };
}
export function schoolInputFrom(d: SchoolDraft, view: CreativeLimitsHqView): CreativeSchoolDailyCapsInput | null {
  const schoolId = d.schoolId.trim().toLowerCase();
  const images = whole(d.images, CREATIVE_SCHOOL_MAX_DAILY_CAP), videos = whole(d.videos, CREATIVE_SCHOOL_MAX_DAILY_CAP), avatarVideos = whole(d.avatarVideos, CREATIVE_SCHOOL_MAX_DAILY_CAP);
  if (images === null || videos === null || avatarVideos === null || schoolId === '') return null;
  try { return validateCreativeSchoolDailyCapsInput({ schoolId, images, videos, avatarVideos, reason: reasonOf(d.reason), expectedVersion: capsFor(view, schoolId).version }); }
  catch { return null; }
}
/** Share of today's limit already committed, 0..1; null when the provider has no limit (every real submission is refused). */
export function usedShare(p: CreativeProviderLimitStatus): number | null {
  if (p.dailyLimitMicros === null) return null;
  return p.dailyLimitMicros === 0 ? (p.committedTodayMicros > 0 ? 1 : 0) : Math.min(1, p.committedTodayMicros / p.dailyLimitMicros);
}
