import { verifyCrmLeadMemberships, type CrmLeadMemberships } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from './session-invalidation';

export type LeadMembershipScope = Readonly<{ organizationId: string; schoolId: string; leadId: string }>;
export type DiscoveryFailure = 'SESSION' | 'DENIED' | 'NOT_FOUND' | 'CONFLICT' | 'UNAVAILABLE' | 'INVALID';
export class LeadMembershipReadError extends Error {
  constructor(readonly kind: DiscoveryFailure, readonly status = 0) { super(kind); }
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function invalid(): never { throw new LeadMembershipReadError('INVALID'); }
function closed(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) invalid();
}
export function leadMembershipScope(value: LeadMembershipScope): LeadMembershipScope {
  closed(value, ['organizationId', 'schoolId', 'leadId']);
  if (Object.values(value).some(v => typeof v !== 'string' || !UUID.test(v))) invalid();
  return Object.freeze({ organizationId: value.organizationId.toLowerCase(), schoolId: value.schoolId.toLowerCase(), leadId: value.leadId.toLowerCase() });
}
export function leadMembershipPath(value: LeadMembershipScope): string {
  const s = leadMembershipScope(value);
  return `/api/v1/organizations/${s.organizationId}/schools/${s.schoolId}/crm/leads/${s.leadId}/memberships`;
}
export function leadMembershipHref(value: LeadMembershipScope): string {
  return `/staff/crm/lead-memberships?${new URLSearchParams(leadMembershipScope(value))}`;
}
export function leadWorkflowHref(value: LeadMembershipScope): string {
  return `/staff/crm/journey?${new URLSearchParams(leadMembershipScope(value))}`;
}
/** One lead only. No fallback lookup, read-side writes, query, body, key or provider call. */
export async function readLeadMemberships(value: LeadMembershipScope, signal: AbortSignal): Promise<CrmLeadMemberships> {
  const scope = leadMembershipScope(value);
  let response: Response;
  try {
    response = await fetch(leadMembershipPath(scope), { method: 'GET', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal });
  } catch { throw new LeadMembershipReadError('UNAVAILABLE'); }
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new LeadMembershipReadError('SESSION', 401); }
  if (!response.ok) {
    const kind: DiscoveryFailure = response.status === 403 ? 'DENIED' : response.status === 404 ? 'NOT_FOUND' : response.status === 409 ? 'CONFLICT' : response.status === 400 ? 'INVALID' : 'UNAVAILABLE';
    throw new LeadMembershipReadError(kind, response.status); // Never consume or expose raw server errors.
  }
  try {
    const cache = response.headers.get('cache-control')?.toLowerCase().split(',').map(x => x.trim());
    if (response.status !== 200 || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !cache?.includes('private') || !cache.includes('no-store')) invalid();
    const raw = await response.text(); if (raw.length > 30_000) invalid();
    const envelope: unknown = JSON.parse(raw); closed(envelope, ['data', 'meta']); closed(envelope.meta, ['requestId', 'correlationId']);
    if (typeof envelope.meta.requestId !== 'string' || !UUID.test(envelope.meta.requestId) || envelope.meta.requestId !== envelope.meta.correlationId) invalid();
    return verifyCrmLeadMemberships(envelope.data, scope.leadId);
  } catch { throw new LeadMembershipReadError('INVALID'); }
}
