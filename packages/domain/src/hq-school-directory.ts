import {
  HQ_SCHOOL_OPERATIONAL_STATUSES,
  HON_TIERS,
  type HqSchoolDirectory,
  type HqSchoolDirectoryEntry,
  type HqSchoolOperationalStatus,
  type HonTier,
} from '@hon/contracts';

type ClosedRecord = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UNSAFE_TEXT = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;

function invalid(): never {
  throw new Error('HQ_SCHOOL_DIRECTORY_INVALID');
}

function isRecord(value: unknown): value is ClosedRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function closed(value: unknown, keys: readonly string[]): ClosedRecord {
  if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) invalid();
  return value;
}

function opaqueId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value) || UNSAFE_TEXT.test(value)) invalid();
  return value;
}

function displayName(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 500 || UNSAFE_TEXT.test(value)) invalid();
  return value;
}

function status(value: unknown): HqSchoolOperationalStatus {
  if ((HQ_SCHOOL_OPERATIONAL_STATUSES as readonly string[]).includes(value as string)) return value as HqSchoolOperationalStatus;
  return invalid();
}

function entitlementTier(value: unknown): HonTier | null {
  if (value === null) return null;
  if ((HON_TIERS as readonly string[]).includes(value as string)) return value as HonTier;
  return invalid();
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !UTC_MILLIS.test(value) || UNSAFE_TEXT.test(value) || new Date(value).toISOString() !== value) invalid();
  return value;
}

function entry(value: unknown): HqSchoolDirectoryEntry {
  const item = closed(value, [
    'schoolId',
    'organizationDisplayName',
    'schoolDisplayName',
    'organizationOperationalStatus',
    'schoolOperationalStatus',
    'entitlementTier',
    'createdAt',
  ]);
  return {
    schoolId: opaqueId(item.schoolId),
    organizationDisplayName: displayName(item.organizationDisplayName),
    schoolDisplayName: displayName(item.schoolDisplayName),
    organizationOperationalStatus: status(item.organizationOperationalStatus),
    schoolOperationalStatus: status(item.schoolOperationalStatus),
    entitlementTier: entitlementTier(item.entitlementTier),
    createdAt: timestamp(item.createdAt),
  };
}

/**
 * Accept only the one redacted directory shape. The ordering check mirrors the
 * fixed SQL ordering (`school.created_at`, `school.id`) and rejects a reordered
 * or augmented payload instead of adapting to it.
 */
export function verifyHqSchoolDirectory(value: unknown): HqSchoolDirectory {
  const root = closed(value, ['schools']);
  if (!Array.isArray(root.schools)) invalid();
  const schools = root.schools.map(entry);
  for (let index = 1; index < schools.length; index += 1) {
    const prior = schools[index - 1]!;
    const current = schools[index]!;
    if (current.createdAt < prior.createdAt || (current.createdAt === prior.createdAt && current.schoolId.localeCompare(prior.schoolId) < 0)) invalid();
  }
  return { schools };
}
