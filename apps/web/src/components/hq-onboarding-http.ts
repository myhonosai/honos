import { reportConfirmedSessionInvalidation } from './session-invalidation';

export type SchoolCreationForm = Readonly<{
  legalName: string; displayName: string; schoolName: string; schoolSlug: string; timezone: string;
}>;
export type SchoolCreationRequest = Readonly<{ principalId: string; key: string; body: string }>;
export type SchoolCreationReceipt = Readonly<{
  organizationId: string; schoolId: string; ownerRoleId: string; replayed: boolean;
  actorPrincipalId: string; entitlementStatus: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
}>;
export interface SchoolCreationApi {
  authorize(signal: AbortSignal): Promise<string>;
  send(request: SchoolCreationRequest): Promise<SchoolCreationReceipt>;
}
export class SchoolCreationError extends Error {
  constructor(readonly status: number, readonly code: 'HQ_EXPECTED_PRINCIPAL_MISMATCH' | null = null) { super('School creation could not be verified.'); }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNSAFE = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new SchoolCreationError(0);
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new SchoolCreationError(0);
  return value.toLowerCase();
}

/** Only existing DTO fields. COMPLETE is an internal suspended placeholder, not a public plan. */
export function createSchoolRequest(form: SchoolCreationForm, principalId: string): SchoolCreationRequest {
  const body = {
    legalName: form.legalName.trim(), displayName: form.displayName.trim(), schoolName: form.schoolName.trim(),
    schoolSlug: form.schoolSlug.trim().toLowerCase(), timezone: form.timezone.trim(), initialTier: 'COMPLETE',
  };
  for (const [key, max] of [['legalName', 180], ['displayName', 120], ['schoolName', 120], ['schoolSlug', 80], ['timezone', 64]] as const) {
    if (!body[key] || body[key].length > max || UNSAFE.test(body[key])) throw new SchoolCreationError(400);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.schoolSlug)) throw new SchoolCreationError(400);
  try { new Intl.DateTimeFormat('en', { timeZone: body.timezone }); } catch { throw new SchoolCreationError(400); }
  return Object.freeze({ principalId: id(principalId), key: crypto.randomUUID(), body: JSON.stringify(body) });
}

/** Dependent on #141: legacy receipts cannot establish the expected-actor binding. */
export function verifySchoolCreationReceipt(value: unknown, status: number, expectedPrincipalId: string): SchoolCreationReceipt {
  const root = closed(value, ['data', 'meta']);
  const data = closed(root.data, ['organizationId', 'schoolId', 'ownerRoleId', 'replayed', 'actorPrincipalId', 'entitlementStatus']);
  const meta = closed(root.meta, ['replayed']);
  if (typeof data.replayed !== 'boolean' || meta.replayed !== data.replayed
    || status !== (data.replayed ? 200 : 201)) throw new SchoolCreationError(0);
  if (data.entitlementStatus !== 'ACTIVE' && data.entitlementStatus !== 'SUSPENDED' && data.entitlementStatus !== 'ARCHIVED') throw new SchoolCreationError(0);
  if ((!data.replayed && data.entitlementStatus !== 'SUSPENDED') || id(data.actorPrincipalId) !== id(expectedPrincipalId)) throw new SchoolCreationError(0);
  const receipt: SchoolCreationReceipt = { organizationId: id(data.organizationId), schoolId: id(data.schoolId), ownerRoleId: id(data.ownerRoleId), replayed: data.replayed,
    actorPrincipalId: id(data.actorPrincipalId), entitlementStatus: data.entitlementStatus };
  if (new Set([receipt.organizationId, receipt.schoolId, receipt.ownerRoleId]).size !== 3) throw new SchoolCreationError(0);
  return Object.freeze(receipt);
}

const options = { credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' } as const;
function requireSuccess(response: Response, reportSession = true) {
  if (response.status === 401 && reportSession) reportConfirmedSessionInvalidation();
  if (!response.ok) throw new SchoolCreationError(response.status);
}
export const schoolCreationApi: SchoolCreationApi = {
  async authorize(signal) {
    signal.throwIfAborted();
    const response = await fetch('/api/v1/hq/session', { ...options, method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
    signal.throwIfAborted();
    requireSuccess(response);
    const root = closed(await response.json(), ['data']);
    signal.throwIfAborted();
    const scope = closed(root.data, ['principalId', 'hqRole']);
    // Session does not expose onboarding permission codes. Owner is the only provable UI capability.
    if (scope.hqRole !== 'HON_HQ_OWNER') throw new SchoolCreationError(403);
    return id(scope.principalId);
  },
  async send(request) {
    const expectedPrincipalId = id(request.principalId);
    const response = await fetch('/api/v1/hq/organizations', { ...options, method: 'POST',
      // #141 independently resolves authority and atomically compares this selector to the actor.
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'hq-school-provisioning',
        'X-HON-Expected-Principal': expectedPrincipalId, 'Idempotency-Key': request.key },
      body: request.body, signal: AbortSignal.timeout(15000) });
    if (response.status === 409) {
      let mismatch = false;
      try { mismatch = closed(await response.json(), ['code']).code === 'HQ_EXPECTED_PRINCIPAL_MISMATCH'; } catch { /* Unverified conflicts retain the unknown outcome. */ }
      throw new SchoolCreationError(409, mismatch ? 'HQ_EXPECTED_PRINCIPAL_MISMATCH' : null);
    }
    // Consequential requests outlive concealment/unmount. Only the controller
    // owning the current command may invalidate a session after settlement.
    requireSuccess(response, false);
    return verifySchoolCreationReceipt(await response.json(), response.status, expectedPrincipalId);
  },
};
