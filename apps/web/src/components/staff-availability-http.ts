import type { StaffAvailabilityProfile, StaffRevision, StaffRevisionInput, StaffRevisionKind } from '@hon/contracts';
import { validateStaffRevision } from '@hon/contracts';
const canonical = (v: unknown): string => JSON.stringify(v, (_, x: unknown) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
const base = '/api/v1/staff/team/availability';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_PATH = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
export class StaffAvailabilityUiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
function invalid(): never { throw new Error('Unverified staff metadata response. No success assumed; retry unchanged with its retained key.'); }
function projection(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) invalid();
}
function scope(value: Record<string, unknown>): void {
  if (value.planningOnly !== true || typeof value.principalId !== 'string' || !UUID.test(value.principalId) || typeof value.schoolId !== 'string' || !UUID.test(value.schoolId) || typeof value.timezone !== 'string' || !value.timezone || value.timezone.length > 100 || /[\u0000-\u001f\u007f]/.test(value.timezone)) invalid();
}
function revision(value: unknown, kind: StaffRevisionKind): StaffRevision {
  projection(value, ['profileId', 'principalId', 'schoolId', 'timezone', 'kind', 'version', 'recordedAt', 'planningOnly', 'expectedVersion', 'status', 'effectiveFrom', 'endsOn', kind === 'AVAILABILITY' ? 'windows' : 'qualifications']);
  scope(value);
  if (typeof value.profileId !== 'string' || !UUID.test(value.profileId) || value.kind !== kind || !Number.isSafeInteger(value.version) || Number(value.version) < 1 || typeof value.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.recordedAt))) invalid();
  const { expectedVersion, status, effectiveFrom, endsOn, windows, qualifications } = value;
  validateStaffRevision(kind, { expectedVersion, status, effectiveFrom, endsOn, ...(kind === 'AVAILABILITY' ? { windows } : { qualifications }) });
  if (value.version !== Number(expectedVersion) + 1) invalid();
  return value as unknown as StaffRevision;
}
function inputOf(r: StaffRevision): StaffRevisionInput {
  const { expectedVersion, status, effectiveFrom, endsOn, windows, qualifications, kind } = r;
  return { expectedVersion, status, effectiveFrom, endsOn, ...(kind === 'AVAILABILITY' ? { windows: windows! } : { qualifications: qualifications! }) };
}
export function staffAvailabilityPath(target: string, kind?: StaffRevisionKind, version?: number): string {
  if (target !== 'self' && !UUID.test(target)) throw new Error('Use your own profile or one already-known staff principal UUID.');
  if (kind !== undefined && !['AVAILABILITY', 'QUALIFICATIONS'].includes(kind)) throw new Error('Unknown revision stream.');
  if (version !== undefined && (kind === undefined || !Number.isSafeInteger(version) || version < 1 || version > 999999999)) throw new Error('Use an exact stream and bounded saved version.');
  return `${base}/${target}${kind ? `/${kind.toLowerCase()}/versions${version !== undefined ? `/${version}` : ''}` : ''}`;
}
export async function staffAvailabilityRequest<T extends StaffAvailabilityProfile | StaffRevision>(url: string, body?: StaffRevisionInput, key?: string): Promise<T> {
  const parsed = new URL(url, 'http://hon.invalid');
  if (!url.startsWith(`${base}/`) || parsed.origin !== 'http://hon.invalid' || parsed.search || parsed.hash || !new RegExp(`^${base}/(self|${UUID_PATH})(?:/(availability|qualifications)/versions(?:/[1-9][0-9]{0,8})?)?$`, 'i').test(parsed.pathname)) throw new Error('Only fixed same-origin staff metadata endpoints are allowed, without actor/school/query inputs.');
  const kind: StaffRevisionKind = parsed.pathname.includes('/qualifications/') ? 'QUALIFICATIONS' : 'AVAILABILITY';
  if (body) {
    if (!parsed.pathname.endsWith('/versions') || !key) throw new Error('An exact revision endpoint and retained retry key are required.');
    validateStaffRevision(kind, body);
  } else if (parsed.pathname.endsWith('/versions')) throw new Error('No revision listing/directory endpoint exists.');
  const response = await fetch(url, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': 'staff-availability', 'Idempotency-Key': key! } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new StaffAvailabilityUiError(response.status === 401 ? 'Sign in with a verified human staff session.' : response.status === 403 ? 'Current exact school permission or staff eligibility is unavailable.' : response.status === 409 ? 'Version or retry conflict. Refresh the current profile before changing input.' : 'No verified result. Check bounded fields and saved version.', response.status);
  const envelope: unknown = await response.json();
  const data = (envelope as { data?: unknown })?.data;
  if (!data || typeof data !== 'object') throw new Error('Outcome uncertain. Retry unchanged with its retained key.');
  let record: StaffRevision | StaffAvailabilityProfile;
  if (body || parsed.pathname.includes('/versions/')) {
    record = revision(data, kind);
    if (body && canonical(inputOf(record)) !== canonical(body)) throw new Error('Saved content did not match the request. Retry unchanged with retained key.');
    if (!body && record.version !== Number(parsed.pathname.split('/').at(-1))) invalid();
  } else {
    projection(data, ['profileId', 'principalId', 'schoolId', 'timezone', 'own', 'planningOnly', 'canManageAvailability', 'canManageQualifications', 'availability', 'qualifications']);
    scope(data);
    if ((data.profileId !== null && (typeof data.profileId !== 'string' || !UUID.test(data.profileId))) || typeof data.own !== 'boolean' || typeof data.canManageAvailability !== 'boolean' || typeof data.canManageQualifications !== 'boolean') invalid();
    for (const k of ['AVAILABILITY', 'QUALIFICATIONS'] as const) {
      const stream = data[k === 'AVAILABILITY' ? 'availability' : 'qualifications'];
      if (stream !== null) { const r = revision(stream, k); if (r.profileId !== data.profileId || r.principalId !== data.principalId || r.schoolId !== data.schoolId) invalid(); }
    }
    record = data as unknown as StaffAvailabilityProfile;
  }
  const target = parsed.pathname.slice(base.length + 1).split('/')[0];
  if (target !== 'self' && record.principalId.toLowerCase() !== target?.toLowerCase()) invalid();
  if (target === 'self' && 'own' in record && !record.own) invalid();
  return record as T;
}
