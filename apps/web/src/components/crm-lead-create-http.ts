import { CRM_LEAD_CREATE_UUID, validateCreateHumanCrmLeadInput, type CreateHumanCrmLeadInput, type LeadSummary } from '@hon/contracts';

export class CrmLeadCreateUncertainError extends Error {}
export class CrmLeadCreateRejectedError extends Error {}
export class CrmLeadCreateAccessError extends CrmLeadCreateRejectedError {}
export type PreparedCrmLeadCreate = Readonly<{ path: string; organizationId: string; schoolId: string; key: string; body: string }>;
export type CrmLeadCreateResult = { lead: LeadSummary; replayed: boolean };
function invalid(): never { throw new Error('Unverified CRM lead-create contract. No creation or downstream outcome is assumed.'); }
function uuid(value: unknown): asserts value is string { if (typeof value !== 'string' || !CRM_LEAD_CREATE_UUID.test(value)) invalid(); }
function closed(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
}
export function crmLeadCreatePath(organizationId: string, schoolId: string): string {
  uuid(organizationId); uuid(schoolId);
  return `/api/v1/organizations/${organizationId.toLowerCase()}/schools/${schoolId.toLowerCase()}/crm/leads`;
}
/** Caller supplies a key only during explicit human submit; never during mount/prefill. */
export function prepareCrmLeadCreate(organizationId: string, schoolId: string, input: CreateHumanCrmLeadInput, key: string): PreparedCrmLeadCreate {
  uuid(key); validateCreateHumanCrmLeadInput(input);
  const path = crmLeadCreatePath(organizationId, schoolId);
  return Object.freeze({ path, organizationId: organizationId.toLowerCase(), schoolId: schoolId.toLowerCase(), key, body: JSON.stringify(input) });
}
function verifyRequest(request: PreparedCrmLeadCreate): CreateHumanCrmLeadInput {
  closed(request, ['path', 'organizationId', 'schoolId', 'key', 'body']); uuid(request.key);
  if (request.path !== crmLeadCreatePath(request.organizationId, request.schoolId) || typeof request.body !== 'string' || request.body.length > 12000) invalid();
  const input: unknown = JSON.parse(request.body); validateCreateHumanCrmLeadInput(input); return input;
}
export function parseCrmLeadCreateResult(value: unknown, request: PreparedCrmLeadCreate): CrmLeadCreateResult {
  const input = verifyRequest(request);
  closed(value, ['data', 'meta']); closed(value.meta, ['requestId', 'correlationId', 'replayed']);
  uuid(value.meta.requestId); uuid(value.meta.correlationId);
  if (value.meta.requestId !== value.meta.correlationId || typeof value.meta.replayed !== 'boolean') invalid();
  closed(value.data, ['id', 'status', 'pipelineStageId', 'primaryPersonId', 'version', 'createdAt']);
  const data = value.data;
  uuid(data.id); uuid(data.pipelineStageId); uuid(data.primaryPersonId);
  if (data.status !== 'OPEN' || data.version !== 1 || data.pipelineStageId.toLowerCase() !== input.pipelineStageId.toLowerCase()
    || typeof data.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(data.createdAt)
    || !Number.isFinite(Date.parse(data.createdAt)) || new Date(data.createdAt).toISOString() !== data.createdAt) invalid();
  return { lead: data as unknown as LeadSummary, replayed: value.meta.replayed };
}
/** Retain this exact in-memory body/key only after uncertainty; no automatic retry. */
export async function submitCrmLeadCreate(request: PreparedCrmLeadCreate): Promise<CrmLeadCreateResult> {
  verifyRequest(request);
  let response: Response;
  try {
    response = await fetch(request.path, { method: 'POST', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': request.key, 'X-HON-Human-Command': 'crm-lead-create' }, body: request.body });
  } catch { throw new CrmLeadCreateUncertainError('Creation outcome is uncertain. No success is assumed. Retry only the exact retained request, or discard it deliberately.'); }
  if ([401, 403].includes(response.status)) throw new CrmLeadCreateAccessError('Current human session, exact school permission or entitlement is unavailable. Draft and retry have been discarded.');
  if ([400, 404, 409, 413, 415, 422].includes(response.status)) throw new CrmLeadCreateRejectedError('Lead-create command rejected. No verified creation receipt; review the draft before a new explicit submit.');
  try {
    if (![200, 201].includes(response.status) || !response.ok || response.redirected
      || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
      || !/^private,\s*no-store$/i.test(response.headers.get('cache-control') ?? '')) invalid();
    const raw = await response.text(); if (raw.length > 12000) invalid();
    const result = parseCrmLeadCreateResult(JSON.parse(raw), request);
    if (result.replayed !== (response.status === 200)) invalid();
    return result;
  } catch { throw new CrmLeadCreateUncertainError('No verified creation receipt. Outcome is uncertain; only the exact retained request may be retried.'); }
}
