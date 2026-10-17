import { CRM_LEAD_CLOSE_UUID, validateCloseCrmLeadInput, validateCrmLeadCloseNote, type CloseCrmLeadInput, type CrmLeadCloseReceipt, type LeadListItem } from '@hon/contracts';

export class CrmLeadCloseUncertainError extends Error {}
export class CrmLeadCloseRejectedError extends Error {}
export type PreparedCrmLeadClose = Readonly<{ path: string; organizationId: string; schoolId: string; leadId: string; key: string; body: string }>;
export type CrmLeadCloseResult = { receipt: CrmLeadCloseReceipt; replayed: boolean };
function invalid(): never { throw new Error('Unverified CRM-only close contract. No lead or enrollment/payment outcome is assumed.'); }
function uuid(v: unknown): asserts v is string { if (typeof v !== 'string' || !CRM_LEAD_CLOSE_UUID.test(v)) invalid(); }
function closed(v: unknown, keys: string[]): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) invalid();
}
export function crmLeadClosePath(organizationId: string, schoolId: string, leadId: string): string {
  uuid(organizationId); uuid(schoolId); uuid(leadId);
  return `/api/v1/organizations/${organizationId.toLowerCase()}/schools/${schoolId.toLowerCase()}/crm/leads/${leadId.toLowerCase()}/close`;
}
/** Called only from a live independently authorized list row, never URL prefill. */
export function prepareCrmLeadClose(organizationId: string, schoolId: string, row: LeadListItem, input: CloseCrmLeadInput, key: string): PreparedCrmLeadClose {
  uuid(key); validateCloseCrmLeadInput(input);
  if (row.status !== 'OPEN' || row.version !== input.expectedVersion) invalid();
  const path = crmLeadClosePath(organizationId, schoolId, row.id);
  return Object.freeze({ path, organizationId: organizationId.toLowerCase(), schoolId: schoolId.toLowerCase(), leadId: row.id.toLowerCase(), key, body: JSON.stringify(input) });
}
export function parseCrmLeadCloseResult(value: unknown, request: PreparedCrmLeadClose): CrmLeadCloseResult {
  closed(value, ['data','meta']); closed(value.meta, ['requestId','correlationId','replayed']);
  uuid(value.meta.requestId); uuid(value.meta.correlationId);
  if (value.meta.requestId !== value.meta.correlationId || typeof value.meta.replayed !== 'boolean') invalid();
  closed(value.data, ['organizationId','schoolId','leadId','status','priorVersion','version','closedAt','closeNote','crmOnly']);
  const data = value.data, input: unknown = JSON.parse(request.body); validateCloseCrmLeadInput(input);
  uuid(data.organizationId); uuid(data.schoolId); uuid(data.leadId);
  if (data.organizationId !== request.organizationId || data.schoolId !== request.schoolId || data.leadId !== request.leadId
    || data.status !== input.status || data.priorVersion !== input.expectedVersion || data.version !== input.expectedVersion + 1
    || data.crmOnly !== true || data.closeNote !== (input.closeNote ?? null)
    || typeof data.closedAt !== 'string' || !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(data.closedAt)
    || !Number.isFinite(Date.parse(data.closedAt)) || new Date(data.closedAt).toISOString() !== data.closedAt) invalid();
  if (data.closeNote !== null) validateCrmLeadCloseNote(data.closeNote);
  return { receipt: data as unknown as CrmLeadCloseReceipt, replayed: value.meta.replayed };
}
/** Caller retains this exact frozen request only on an uncertain result. No auto retry. */
export async function submitCrmLeadClose(request: PreparedCrmLeadClose): Promise<CrmLeadCloseResult> {
  closed(request, ['path','organizationId','schoolId','leadId','key','body']); uuid(request.key);
  if (request.path !== crmLeadClosePath(request.organizationId,request.schoolId,request.leadId)) invalid();
  validateCloseCrmLeadInput(JSON.parse(request.body));
  let response: Response;
  try {
    response = await fetch(request.path, { method: 'POST', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': request.key, 'X-HON-Human-Command': 'crm-lead-close' }, body: request.body });
  } catch { throw new CrmLeadCloseUncertainError('Close request outcome is uncertain. Retry only the exact retained request or explicitly reload; no success is assumed.'); }
  if ([400,401,403,404,409,413,415,422].includes(response.status)) {
    throw new CrmLeadCloseRejectedError('Close command rejected or current authority/version unavailable. Explicitly reload the authorized list before a new command.');
  }
  try {
    if (response.status !== 200 || !response.ok || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
    const raw = await response.text(); if (raw.length > 24000) invalid();
    return parseCrmLeadCloseResult(JSON.parse(raw), request);
  } catch { throw new CrmLeadCloseUncertainError('No verified close receipt. Outcome is uncertain; only the exact retained request may be retried.'); }
}
