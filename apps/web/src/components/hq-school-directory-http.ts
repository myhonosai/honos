import {
  HQ_SCHOOL_OPERATIONAL_STATUSES,
  HON_TIERS,
  type HqSchoolDirectory,
  type HqSchoolDirectoryEntry,
  type HqSchoolOperationalStatus,
  type HonTier,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from './session-invalidation';

type ClosedRecord = Record<string, unknown>;

const PATH = '/api/v1/hq/schools';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UNSAFE_TEXT = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;

export class HqSchoolDirectoryAccessError extends Error {
  constructor(message: string, readonly status: 401 | 403) {
    super(message);
  }
}

function invalid(): never {
  throw new Error('HQ school directory data was not a verified minimized projection.');
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

function name(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 500 || UNSAFE_TEXT.test(value)) invalid();
  return value;
}

function status(value: unknown): HqSchoolOperationalStatus {
  if ((HQ_SCHOOL_OPERATIONAL_STATUSES as readonly string[]).includes(value as string)) return value as HqSchoolOperationalStatus;
  return invalid();
}

function tier(value: unknown): HonTier | null {
  if (value === null) return null;
  if ((HON_TIERS as readonly string[]).includes(value as string)) return value as HonTier;
  return invalid();
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !UTC_MILLIS.test(value) || UNSAFE_TEXT.test(value) || new Date(value).toISOString() !== value) invalid();
  return value;
}

function entry(value: unknown): HqSchoolDirectoryEntry {
  const item = closed(value, ['schoolId', 'organizationDisplayName', 'schoolDisplayName', 'organizationOperationalStatus', 'schoolOperationalStatus', 'entitlementTier', 'createdAt']);
  return {
    schoolId: opaqueId(item.schoolId),
    organizationDisplayName: name(item.organizationDisplayName),
    schoolDisplayName: name(item.schoolDisplayName),
    organizationOperationalStatus: status(item.organizationOperationalStatus),
    schoolOperationalStatus: status(item.schoolOperationalStatus),
    entitlementTier: tier(item.entitlementTier),
    createdAt: timestamp(item.createdAt),
  };
}

/** Reconstruct only the fixed redacted list; unknown fields and invalid order fail closed. */
export function verifyHqSchoolDirectorySnapshot(value: unknown): HqSchoolDirectory {
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

/** Fixed same-origin GET: there is no selector, body, redirect follow, or cache fallback. */
export async function loadHqSchoolDirectory(signal: AbortSignal = new AbortController().signal): Promise<HqSchoolDirectory> {
  signal.throwIfAborted();
  const response = await fetch(PATH, {
    method: 'GET',
    credentials: 'same-origin',
    mode: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  signal.throwIfAborted();
  if (response.status === 401) reportConfirmedSessionInvalidation();
  if (!response.ok) {
    if (response.status === 401) throw new HqSchoolDirectoryAccessError('Sign in with a verified platform HQ session to view schools.', 401);
    if (response.status === 403) throw new HqSchoolDirectoryAccessError('This account does not have current platform HQ school-directory authority.', 403);
    throw new Error('The HQ school directory is unavailable. No result is shown.');
  }
  let envelope: unknown;
  try {
    envelope = await response.json();
    signal.throwIfAborted();
  } catch {
    invalid();
  }
  const root = closed(envelope, ['data']);
  const data = closed(root.data, ['directory']);
  return verifyHqSchoolDirectorySnapshot(data.directory);
}

/** Fixed resolver-backed session read; directory capability includes owners and operators. */
export async function readHqSchoolDirectoryPrincipal(signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const response = await fetch('/api/v1/hq/session', {
    method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
    headers: { Accept: 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  signal.throwIfAborted();
  if (response.status === 401) reportConfirmedSessionInvalidation();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new HqSchoolDirectoryAccessError('Current HQ directory access could not be verified.', response.status);
    invalid();
  }
  const root = closed(await response.json(), ['data']);
  signal.throwIfAborted();
  const scope = closed(root.data, ['principalId', 'hqRole']);
  if (scope.hqRole !== 'HON_HQ_OWNER' && scope.hqRole !== 'HON_HQ_OPERATOR') throw new HqSchoolDirectoryAccessError('Current HQ directory access could not be verified.', 403);
  return opaqueId(scope.principalId);
}
