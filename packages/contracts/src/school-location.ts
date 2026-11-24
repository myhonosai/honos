/**
 * 0392: the school's address and the biometric (face check-in) notice it decides. Sign-up asks for the address; existing
 * schools add it in Settings. The notice is information only and every profile is a TEST-ONLY DRAFT for lawyer review.
 * The database validates every rule here again.
 */
export const US_REGIONS = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA',
  'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'PR', 'GU', 'VI', 'AS', 'MP'] as const;
export const CA_REGIONS = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'] as const;

export const BIOMETRIC_PROFILES = ['US_IL_BIPA', 'US_TX_CUBI', 'US_WA_BIOMETRIC', 'US_CA_CCPA', 'US_CO_CPA', 'US_NYC', 'US_PORTLAND_BAN', 'US_GENERAL',
  'EU_GDPR', 'UK_GDPR', 'KR_PIPA', 'NOT_REVIEWED'] as const;
export type BiometricProfile = typeof BIOMETRIC_PROFILES[number];
export const BIOMETRIC_ADD_ONS = ['WRITTEN_RELEASE', 'PUBLIC_RETENTION_SCHEDULE', 'PRIVATE_RIGHT_OF_ACTION', 'DESTROY_WITHIN_ONE_YEAR', 'HEALTH_DATA_CONSENT',
  'SENSITIVE_DATA_NOTICE', 'NO_DENIAL_FOR_REFUSAL', 'ENTRANCE_SIGN', 'IMPACT_ASSESSMENT', 'SEPARATE_CONSENT', 'RIGHT_TO_REFUSE_NOTICE', 'CITY_BAN'] as const;
export type BiometricAddOn = typeof BIOMETRIC_ADD_ONS[number];
export type FaceCheckInAvailability = 'AVAILABLE_WITH_CONSENT' | 'BLOCKED' | 'NOT_REVIEWED' | 'LOCATION_REQUIRED';

export interface SchoolLocationInput {
  country: string; region: string | null; city: string; postalCode: string | null; addressLine1: string | null; addressLine2: string | null;
}
export interface SchoolLocation extends SchoolLocationInput { version: number; updatedAt: string }
export interface FaceCheckInNotice {
  profile: BiometricProfile | null; status: FaceCheckInAvailability; laws: string[]; addOns: BiometricAddOn[];
  reviewStatus: 'TEST_ONLY_DRAFT'; rulesVersion: 1;
}
export interface SchoolLocationView { location: SchoolLocation | null; faceCheckInNotice: FaceCheckInNotice }
export interface SaveSchoolLocationInput { location: SchoolLocationInput; expectedVersion: number }

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// eslint-disable-next-line no-control-regex
const UNSAFE = /[<>\u0000-\u001f\u007f]/;
const INPUT_KEYS = ['addressLine1', 'addressLine2', 'city', 'country', 'postalCode', 'region'] as const;

function invalid(): never { throw new Error('Invalid school location data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}
function text(value: unknown, max: number, required: boolean): string | null {
  if (value === null && !required) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.trim() !== value || UNSAFE.test(value)) invalid();
  return value;
}
/** US and Canada need a state or province from the closed lists; elsewhere a region is optional. */
export function schoolLocationRegionOk(country: string, region: string | null): boolean {
  if (country === 'US') return region !== null && (US_REGIONS as readonly string[]).includes(region);
  if (country === 'CA') return region !== null && (CA_REGIONS as readonly string[]).includes(region);
  return region === null || /^[A-Z0-9]{1,3}$/.test(region);
}
export function validateSchoolLocationInput(value: unknown): SchoolLocationInput {
  const row = record(value, INPUT_KEYS);
  if (typeof row.country !== 'string' || !/^[A-Z]{2}$/.test(row.country)) invalid();
  if (row.region !== null && typeof row.region !== 'string') invalid();
  const region = row.region as string | null;
  if (!schoolLocationRegionOk(row.country, region)) invalid();
  const addressLine1 = text(row.addressLine1, 200, false), addressLine2 = text(row.addressLine2, 200, false);
  if (addressLine2 !== null && addressLine1 === null) invalid();
  return Object.freeze({ country: row.country, region, city: text(row.city, 100, true)!, postalCode: text(row.postalCode, 20, false), addressLine1, addressLine2 });
}
export function validateSaveSchoolLocationInput(value: unknown): SaveSchoolLocationInput {
  const row = record(value, ['expectedVersion', 'location']);
  const v = row.expectedVersion;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 999_999_999) invalid();
  return { location: validateSchoolLocationInput(row.location), expectedVersion: v };
}

export function verifyFaceCheckInNotice(value: unknown): FaceCheckInNotice {
  const row = record(value, ['addOns', 'laws', 'profile', 'reviewStatus', 'rulesVersion', 'status']);
  if (row.reviewStatus !== 'TEST_ONLY_DRAFT' || row.rulesVersion !== 1) invalid();
  if (!Array.isArray(row.laws) || row.laws.length > 6 || row.laws.some(l => typeof l !== 'string' || l.length < 1 || l.length > 200)) invalid();
  if (!Array.isArray(row.addOns) || row.addOns.some(a => !(BIOMETRIC_ADD_ONS as readonly unknown[]).includes(a))) invalid();
  const status = row.status;
  if (row.profile === null) {
    if (status !== 'LOCATION_REQUIRED' || row.laws.length || row.addOns.length) invalid();
  } else {
    if (!(BIOMETRIC_PROFILES as readonly unknown[]).includes(row.profile)) invalid();
    if (!['AVAILABLE_WITH_CONSENT', 'BLOCKED', 'NOT_REVIEWED'].includes(String(status))) invalid();
    if ((status === 'NOT_REVIEWED') !== (row.profile === 'NOT_REVIEWED')) invalid();
    if ((status === 'BLOCKED') !== row.addOns.includes('CITY_BAN')) invalid();
    if (status === 'AVAILABLE_WITH_CONSENT' && row.laws.length === 0) invalid();
  }
  return Object.freeze({ profile: row.profile as BiometricProfile | null, status: status as FaceCheckInAvailability, laws: [...row.laws as string[]],
    addOns: [...row.addOns as BiometricAddOn[]], reviewStatus: 'TEST_ONLY_DRAFT', rulesVersion: 1 });
}
export function verifySchoolLocation(value: unknown): SchoolLocation {
  const row = record(value, [...INPUT_KEYS, 'updatedAt', 'version']);
  const { version, updatedAt } = row;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > 999_999_999) invalid();
  if (typeof updatedAt !== 'string' || !INSTANT.test(updatedAt)) invalid();
  const input = validateSchoolLocationInput(Object.fromEntries(INPUT_KEYS.map(k => [k, row[k]])));
  return Object.freeze({ ...input, version, updatedAt });
}
/** `{ location, faceCheckInNotice }`: a school without an address has a null location and a LOCATION_REQUIRED notice. */
export function verifySchoolLocationView(value: unknown, expect?: { version: number }): SchoolLocationView {
  const row = record(value, ['faceCheckInNotice', 'location']);
  const location = row.location === null ? null : verifySchoolLocation(row.location);
  const faceCheckInNotice = verifyFaceCheckInNotice(row.faceCheckInNotice);
  if ((location === null) !== (faceCheckInNotice.status === 'LOCATION_REQUIRED')) invalid();
  if (expect && location?.version !== expect.version) invalid();
  return Object.freeze({ location, faceCheckInNotice });
}
