// Interface language persistence closed contracts (English, Korean, Spanish). A personal preference belongs
// to the verified user and follows them across sessions, devices and schools; only they can change it. A
// school default applies when the user has no personal preference and names a school they belong to.
// Effective language: personal > school default > 'en'. Independent of appearance, timezone and currency.
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsInt as isInt,
  championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsRecord as record } from './champions-club.js';

export type HonLanguage = 'en' | 'ko' | 'es';
export const HON_LANGUAGES: readonly HonLanguage[] = ['en','ko','es'];
export const HON_DEFAULT_LANGUAGE: HonLanguage = 'en';
/** Exact x-hon-human-command values for the two update routes. */
export const LANGUAGE_COMMANDS = { updateMyLanguage: 'language-preference-update', updateSchoolDefault: 'school-language-default-update' } as const;

export interface LanguageUpdateInput {
  language: HonLanguage;
  /** The `version` last read (0 when no preference/default exists yet); a stale value is refused with 409. */
  expectedVersion: number;
}
export interface LanguagePreference { language: HonLanguage; version: number; updatedAt: string }
export interface SchoolLanguageDefault {
  schoolId: string; organizationId: string; defaultLanguage: HonLanguage; source: 'SCHOOL' | 'SYSTEM_DEFAULT';
  /** 0 while the school has never set a default. */
  version: number; updatedAt: string | null;
}
export interface EffectiveLanguage { language: HonLanguage; source: 'PERSONAL' | 'SCHOOL_DEFAULT' | 'SYSTEM_DEFAULT' }
export interface MyLanguagePreferenceView {
  preference: LanguagePreference | null;
  /** Present only when the request named a school the user belongs to. */
  schoolDefault: SchoolLanguageDefault | null;
  effective: EffectiveLanguage;
  supportedLanguages: HonLanguage[];
}
export interface SchoolLanguageDefaultView extends SchoolLanguageDefault { canManage: boolean; supportedLanguages: HonLanguage[] }
export interface MyLanguagePreferenceReceipt { preference: LanguagePreference; replayed: boolean }
export interface SchoolLanguageDefaultReceipt { schoolDefault: SchoolLanguageDefault; replayed: boolean }

const isLanguage = (v: unknown): v is HonLanguage => HON_LANGUAGES.includes(v as HonLanguage);
const nts = (v: unknown) => v === null || isTimestamp(v);

// ---------- inputs ----------
export function validateLanguageUpdateInput(value: unknown): LanguageUpdateInput {
  const r = record(value, invalid); exactKeys(r, ['language','expectedVersion'], invalid);
  if (!isLanguage(r.language) || !isInt(r.expectedVersion, 0, 999_999_999)) invalid();
  return { language: r.language as HonLanguage, expectedVersion: r.expectedVersion as number };
}
/** `GET /v1/me/language-preference` accepts only an optional `schoolId`. */
export function validateMyLanguageQuery(value: unknown): { schoolId: string | null } {
  const q = record(value ?? {}, invalid);
  if (Object.keys(q).some(k => k !== 'schoolId')) invalid();
  if (q.schoolId === undefined) return { schoolId: null };
  if (typeof q.schoolId !== 'string' || !isUuid(q.schoolId)) invalid();
  return { schoolId: (q.schoolId as string).toLowerCase() };
}

// ---------- responses ----------
function preference(value: unknown): void {
  const p = record(value, drift); exactKeys(p, ['language','version','updatedAt'], drift);
  if (!isLanguage(p.language) || !isInt(p.version, 1, 2147483647) || !isTimestamp(p.updatedAt)) drift();
}
function schoolDefault(value: unknown, extra: readonly string[] = []): void {
  const s = record(value, drift); exactKeys(s, ['schoolId','organizationId','defaultLanguage','source','version','updatedAt',...extra], drift);
  if (!isUuid(s.schoolId) || !isUuid(s.organizationId) || !isLanguage(s.defaultLanguage) || !['SCHOOL','SYSTEM_DEFAULT'].includes(s.source as string)
    || !isInt(s.version, 0, 2147483647) || !nts(s.updatedAt)
    || (s.source === 'SYSTEM_DEFAULT') !== (s.version === 0) || (s.version === 0) !== (s.updatedAt === null)
    || (s.source === 'SYSTEM_DEFAULT' && s.defaultLanguage !== HON_DEFAULT_LANGUAGE)) drift();
}
function supported(value: unknown): void {
  if (!Array.isArray(value) || value.length !== HON_LANGUAGES.length || value.some((v, i) => v !== HON_LANGUAGES[i])) drift();
}
export function validateMyLanguagePreferenceView(value: unknown): MyLanguagePreferenceView {
  const r = record(value, drift); exactKeys(r, ['preference','schoolDefault','effective','supportedLanguages'], drift);
  if (r.preference !== null) preference(r.preference);
  if (r.schoolDefault !== null) schoolDefault(r.schoolDefault);
  supported(r.supportedLanguages);
  const e = record(r.effective, drift); exactKeys(e, ['language','source'], drift);
  const pref = r.preference as LanguagePreference | null, school = r.schoolDefault as SchoolLanguageDefault | null;
  // The precedence rule itself: personal > school default > English.
  const expected: EffectiveLanguage = pref ? { language: pref.language, source: 'PERSONAL' }
    : school?.source === 'SCHOOL' ? { language: school.defaultLanguage, source: 'SCHOOL_DEFAULT' } : { language: HON_DEFAULT_LANGUAGE, source: 'SYSTEM_DEFAULT' };
  if (e.language !== expected.language || e.source !== expected.source) drift();
  return r as unknown as MyLanguagePreferenceView;
}
export function validateSchoolLanguageDefaultView(value: unknown): SchoolLanguageDefaultView {
  schoolDefault(value, ['canManage','supportedLanguages']);
  const r = value as Record<string, unknown>;
  if (typeof r.canManage !== 'boolean') drift();
  supported(r.supportedLanguages);
  return r as unknown as SchoolLanguageDefaultView;
}
export function validateMyLanguagePreferenceReceipt(value: unknown): MyLanguagePreferenceReceipt {
  const r = record(value, drift); exactKeys(r, ['preference','replayed'], drift); preference(r.preference);
  if (typeof r.replayed !== 'boolean') drift();
  return r as unknown as MyLanguagePreferenceReceipt;
}
export function validateSchoolLanguageDefaultReceipt(value: unknown): SchoolLanguageDefaultReceipt {
  const r = record(value, drift); exactKeys(r, ['schoolDefault','replayed'], drift); schoolDefault(r.schoolDefault);
  if ((r.schoolDefault as SchoolLanguageDefault).source !== 'SCHOOL' || typeof r.replayed !== 'boolean') drift();
  return r as unknown as SchoolLanguageDefaultReceipt;
}
