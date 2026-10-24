import type { LeadListItem } from '@hon/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUS = ['OPEN', 'WON', 'LOST', 'ARCHIVED'] as const;
export type CrmLeadStatus = typeof STATUS[number];

export class CrmLeadAccessError extends Error {}
function invalid(): never { throw new Error('Unverified CRM lead list. No lead, permission, or scheduling result is assumed.'); }
function closed(value: unknown, keys: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value as Record<string, unknown>).some((key) => !keys.includes(key) && !optional.includes(key)) || keys.some((key) => !Object.hasOwn(value, key))) invalid(); }
function uuid(value: unknown): asserts value is string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); }
function text(value: unknown, max: number, required = true): asserts value is string | null { if (value === null && !required) return; if (typeof value !== 'string' || !value.trim() || value.trim() !== value || value.length > max) invalid(); }
function instant(value: unknown, nullable = false): asserts value is string | null { if (value === null && nullable) return; if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) invalid(); }

export function crmLeadListPath(organizationId: string, schoolId: string, status?: CrmLeadStatus): string {
  uuid(organizationId); uuid(schoolId);
  if (status !== undefined && !STATUS.includes(status)) invalid();
  const query = new URLSearchParams({ limit: '50', ...(status === undefined ? {} : { status }) });
  return `/api/v1/organizations/${organizationId.toLowerCase()}/schools/${schoolId.toLowerCase()}/crm/leads?${query.toString()}`;
}

function verifyLead(value: unknown): LeadListItem {
  closed(value, ['id', 'status', 'pipelineStageId', 'primaryPersonId', 'version', 'createdAt', 'givenName', 'familyName'], ['email', 'phoneE164', 'nextFollowUpAt']);
  uuid(value.id); uuid(value.pipelineStageId); uuid(value.primaryPersonId); text(value.givenName, 120); text(value.familyName, 120); instant(value.createdAt);
  if (!STATUS.includes(value.status as CrmLeadStatus) || !Number.isSafeInteger(value.version) || Number(value.version) < 1) invalid();
  if (value.email !== undefined) text(value.email, 254, false);
  if (value.phoneE164 !== undefined) text(value.phoneE164, 16, false);
  if (value.nextFollowUpAt !== undefined) instant(value.nextFollowUpAt, true);
  return { id: value.id as string, status: value.status as LeadListItem['status'], pipelineStageId: value.pipelineStageId as string, primaryPersonId: value.primaryPersonId as string, version: value.version as number, createdAt: value.createdAt as string, givenName: value.givenName as string, familyName: value.familyName as string, ...(typeof value.email === 'string' ? { email: value.email } : {}), ...(typeof value.phoneE164 === 'string' ? { phoneE164: value.phoneE164 } : {}), ...(typeof value.nextFollowUpAt === 'string' ? { nextFollowUpAt: value.nextFollowUpAt } : {}) };
}

export async function loadCrmLeads(organizationId: string, schoolId: string, status?: CrmLeadStatus, signal?: AbortSignal): Promise<LeadListItem[]> {
  const response = await fetch(crmLeadListPath(organizationId, schoolId, status), { method: 'GET', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}) });
  if (!response.ok) {
    const message = response.status === 401 ? 'Sign in with a verified human school session.' : response.status === 403 ? 'Current CRM lead permission or exact school scope is unavailable.' : 'CRM lead list is unavailable. No list result is assumed.';
    throw new (response.status === 401 || response.status === 403 ? CrmLeadAccessError : Error)(message);
  }
  const envelope: unknown = await response.json();
  closed(envelope, ['data', 'meta']);
  if (!Array.isArray(envelope.data) || envelope.data.length > 50) invalid();
  const leads = envelope.data.map(verifyLead);
  if (new Set(leads.map((lead) => lead.id)).size !== leads.length) invalid();
  return leads;
}
