import type { MembershipActivationContext } from '@hon/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const states = ['DRAFT', 'ACTIVE', 'FROZEN', 'CANCELLATION_PENDING', 'CANCELLED', 'EXPIRED'];
export type KnownMembership = Pick<MembershipActivationContext, 'organizationId' | 'schoolId' | 'membershipId'>;
export class MembershipActivationError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
function invalid(): never { throw new Error('Unverified membership result. No activation is assumed; retry the exact retained request or reload current state.'); }
function uuid(value: unknown): asserts value is string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); }
function closed(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
}
function version(value: unknown): asserts value is number { if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 2147483647) invalid(); }
function known(input: KnownMembership): KnownMembership {
  closed(input, ['organizationId', 'schoolId', 'membershipId']);
  uuid(input.organizationId); uuid(input.schoolId); uuid(input.membershipId);
  return { organizationId: input.organizationId.toLowerCase(), schoolId: input.schoolId.toLowerCase(), membershipId: input.membershipId.toLowerCase() };
}
export function membershipActivationPath(input: KnownMembership): string {
  const scope = known(input);
  return `/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/billing/memberships/${scope.membershipId}`;
}
async function result(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    const message = response.status === 401 ? 'Sign in with a verified human staff session.'
      : response.status === 403 ? 'Current membership activation permission or billing entitlement is unavailable. Reload after access is restored.'
      : response.status === 404 ? 'The membership is unavailable in this school.'
      : response.status === 409 ? 'Version, state or idempotency conflict. Reload current membership state before a new command.'
      : 'No verified activation result. Check the bounded input; retry unchanged if the outcome is uncertain.';
    throw new MembershipActivationError(message, response.status);
  }
  const envelope: unknown = await response.json();
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) invalid();
  return envelope as Record<string, unknown>;
}
export async function loadMembershipActivationContext(input: KnownMembership): Promise<MembershipActivationContext> {
  const scope = known(input);
  const envelope = await result(await fetch(`${membershipActivationPath(scope)}/activation-context`, {
    method: 'GET', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer',
  }));
  const data = envelope.data;
  closed(data, ['organizationId', 'schoolId', 'membershipId', 'state', 'version']);
  if (data.organizationId !== scope.organizationId || data.schoolId !== scope.schoolId || data.membershipId !== scope.membershipId || !states.includes(String(data.state))) invalid();
  version(data.version);
  return { ...scope, state: data.state as MembershipActivationContext['state'], version: data.version };
}
export async function activateKnownMembership(input: KnownMembership, expectedVersion: number, key: string): Promise<{ membership: MembershipActivationContext; replayed: boolean }> {
  const scope = known(input); version(expectedVersion);
  if (typeof key !== 'string' || !key || key.length > 200 || key !== key.trim() || /[\u0000-\u001f\u007f]/.test(key)) invalid();
  const envelope = await result(await fetch(`${membershipActivationPath(scope)}/activate`, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer',
    headers: { 'Content-Type': 'application/json', 'X-HON-Human-Command': 'billing.membership.activate', 'Idempotency-Key': key },
    body: JSON.stringify({ expectedVersion }),
  }));
  const data = envelope.data;
  // Preserve the existing canonical response contract, but never retain/display related identifiers.
  closed(data, ['id', 'billingAccountId', 'participantPersonId', 'planCode', 'state', 'version', 'createdAt']);
  uuid(data.billingAccountId); uuid(data.participantPersonId);
  if (data.id !== scope.membershipId || data.state !== 'ACTIVE' || data.version !== expectedVersion + 1 || typeof data.planCode !== 'string' || typeof data.createdAt !== 'string' || !Number.isFinite(Date.parse(data.createdAt))) invalid();
  version(data.version);
  const meta = envelope.meta;
  closed(meta, ['requestId', 'correlationId', 'replayed']); uuid(meta.requestId); uuid(meta.correlationId);
  if (typeof meta.replayed !== 'boolean') invalid();
  return { membership: { ...scope, state: 'ACTIVE', version: data.version }, replayed: meta.replayed };
}
