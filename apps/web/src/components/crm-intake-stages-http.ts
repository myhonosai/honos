import { crmIntakeStageUuid, verifyCrmIntakeStages, type CrmIntakeStage } from '@hon/contracts';

const RESPONSE_MAX = 16_000;
export class CrmIntakeStagesAccessError extends Error {
  constructor(readonly status: 401 | 403) { super('Current human CRM intake access is unavailable. No school or stage is selected.'); }
}
export class CrmIntakeStagesRejectedError extends Error {
  constructor() { super('The exact CRM intake-stage read was rejected. No stage is selected.'); }
}
function invalid(): never { throw new Error('The CRM intake-stage result could not be verified. No stage is selected.'); }
function closed(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) invalid();
}
export function crmIntakeStagesPath(organizationId: string, schoolId: string): string {
  return `/api/v1/organizations/${crmIntakeStageUuid(organizationId)}/schools/${crmIntakeStageUuid(schoolId)}/crm/intake-stages`;
}
export function parseCrmIntakeStages(value: unknown): CrmIntakeStage[] {
  closed(value, ['data', 'meta']); closed(value.meta, ['requestId', 'correlationId']);
  const requestId = crmIntakeStageUuid(value.meta.requestId);
  if (value.meta.correlationId !== requestId) invalid();
  return verifyCrmIntakeStages(value.data);
}
/** Explicit same-origin GET only; exact path selectors remain untrusted until every server check passes. */
export async function loadCrmIntakeStages(organizationId: string, schoolId: string): Promise<CrmIntakeStage[]> {
  const path = crmIntakeStagesPath(organizationId, schoolId);
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'X-HON-Human-Read': 'crm-intake-stages' },
    });
  } catch { throw new Error('CRM intake stages are unavailable. No stage is selected or retried automatically.'); }
  if (response.status === 401 || response.status === 403) throw new CrmIntakeStagesAccessError(response.status);
  if ([400, 404, 405, 413, 415, 422].includes(response.status)) throw new CrmIntakeStagesRejectedError();
  try {
    if (!response.ok || response.status !== 200 || response.redirected
      || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
      || !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('cache-control') ?? '')) invalid();
    const text = await response.text(); if (text.length > RESPONSE_MAX) invalid();
    return parseCrmIntakeStages(JSON.parse(text));
  } catch { throw new Error('CRM intake stages returned no verified bounded result. No stage is selected.'); }
}
