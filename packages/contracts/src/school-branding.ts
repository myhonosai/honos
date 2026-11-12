/**
 * 0285: shared school page branding (owner decision 2026-11-12, "Branded pages"): a logo, an accent color, a cover photo
 * and one contact line, set once per school and shown on its booking and checkout pages. Not a layout or page builder.
 * The database validates every rule here again.
 */
export const SCHOOL_BRANDING_LIMITS = { imageUrlMin: 12, imageUrl: 500, contactLine: 160 } as const;

export interface SchoolBrandingInput { logoUrl: string | null; coverUrl: string | null; accentColor: string | null; contactLine: string | null }
export interface SchoolBranding extends SchoolBrandingInput { version: number; updatedAt: string | null }
export interface SaveSchoolBrandingInput { branding: SchoolBrandingInput; expectedVersion: number }
export interface SchoolBrandingReceipt { branding: SchoolBranding }
export interface PublicSchoolBranding extends SchoolBranding { schoolName: string }

export const EMPTY_SCHOOL_BRANDING: SchoolBrandingInput = Object.freeze({ logoUrl: null, coverUrl: null, accentColor: null, contactLine: null });

const IMAGE_URL = /^https:\/\/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(\/[A-Za-z0-9._~%/+=&?-]*)?$/;
const COLOR = /^#[0-9a-f]{6}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// eslint-disable-next-line no-control-regex
const UNSAFE = /[<>\u0000-\u001f\u007f-\u009f]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const INPUT_KEYS = ['accentColor', 'contactLine', 'coverUrl', 'logoUrl'] as const;

function invalid(): never { throw new Error('Invalid school branding data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}

/** A logo or cover reference: a plain https URL with a lower-case host and URL-safe path and query characters only. */
export function schoolBrandingImageUrlOk(value: unknown): value is string {
  return typeof value === 'string' && value.length >= SCHOOL_BRANDING_LIMITS.imageUrlMin && value.length <= SCHOOL_BRANDING_LIMITS.imageUrl && IMAGE_URL.test(value);
}
export function schoolBrandingColorOk(value: unknown): value is string { return typeof value === 'string' && COLOR.test(value); }
export function schoolBrandingContactLineOk(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= SCHOOL_BRANDING_LIMITS.contactLine && value.trim() === value && !UNSAFE.test(value);
}

function nullable<T>(value: unknown, ok: (v: unknown) => v is T): T | null {
  if (value === null) return null;
  if (!ok(value)) invalid();
  return value;
}
function fields(row: Record<string, unknown>): SchoolBrandingInput {
  return { logoUrl: nullable(row.logoUrl, schoolBrandingImageUrlOk), coverUrl: nullable(row.coverUrl, schoolBrandingImageUrlOk),
    accentColor: nullable(row.accentColor, schoolBrandingColorOk), contactLine: nullable(row.contactLine, schoolBrandingContactLineOk) };
}

export function validateSchoolBrandingInput(value: unknown): SchoolBrandingInput { return fields(record(value, INPUT_KEYS)); }

export function validateSaveSchoolBrandingInput(value: unknown): SaveSchoolBrandingInput {
  const row = record(value, ['branding', 'expectedVersion']);
  const expectedVersion = row.expectedVersion;
  if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 0 || expectedVersion > 999_999_999) invalid();
  return { branding: validateSchoolBrandingInput(row.branding), expectedVersion };
}

function brandingFrom(row: Record<string, unknown>): SchoolBranding {
  const version = row.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0 || version > 999_999_999) invalid();
  const updatedAt = row.updatedAt;
  // Version 0 means the school has not saved branding yet: every field is null and there is no update time.
  if (version === 0 ? updatedAt !== null : typeof updatedAt !== 'string' || !INSTANT.test(updatedAt)) invalid();
  const branding = { ...fields(row), version, updatedAt: updatedAt as string | null };
  if (version === 0 && (branding.logoUrl ?? branding.coverUrl ?? branding.accentColor ?? branding.contactLine) !== null) invalid();
  return branding;
}

export function verifySchoolBranding(value: unknown): SchoolBranding {
  return brandingFrom(record(value, [...INPUT_KEYS, 'updatedAt', 'version']));
}
/** The staff read: `{ branding }`. */
export function verifySchoolBrandingRead(value: unknown): SchoolBrandingReceipt {
  return { branding: verifySchoolBranding(record(value, ['branding']).branding) };
}
/** A save (or its exact replay) answers the next version. */
export function verifySchoolBrandingReceipt(value: unknown, expect: { version: number }): SchoolBrandingReceipt {
  const receipt = verifySchoolBrandingRead(value);
  if (receipt.branding.version !== expect.version || expect.version < 1) invalid();
  return receipt;
}
/** The public display branding (no ids, no people), or null when the school is not active. */
export function verifyPublicSchoolBranding(value: unknown): PublicSchoolBranding | null {
  if (value === null) return null;
  const row = record(value, [...INPUT_KEYS, 'schoolName', 'updatedAt', 'version']);
  const name = row.schoolName;
  if (typeof name !== 'string' || name.length < 1 || name.length > 200 || CONTROL.test(name)) invalid();
  return { ...brandingFrom(row), schoolName: name };
}
