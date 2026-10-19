'use client';

import {
  CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_UUID,
  CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION,
  validateCrmGuardianChildPayerDesignationInput,
  validateCrmGuardianChildPayerDesignationPreparationInput,
  verifyCrmGuardianChildPayerDesignationApiResponse,
  verifyCrmGuardianChildPayerDesignationPreparationApiResponse,
  type CrmGuardianChildPayerDesignationInput,
  type CrmGuardianChildPayerDesignationPreparation,
  type CrmGuardianChildPayerDesignationReceipt,
} from '@hon/contracts';

export { CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_UUID, CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION } from '@hon/contracts';

const RESPONSE_MAX = 12_000;
export type CrmGuardianChildPayerDesignationScope = Readonly<{ organizationId: string; schoolId: string }>;
export type PreparedCrmGuardianChildPayerDesignation = Readonly<{ path: string; organizationId: string; schoolId: string; key: string; body: string }>;

export class CrmGuardianChildPayerDesignationRejectedError extends Error {
  constructor(message = 'Guardian-child payer designation readiness or command is unavailable. No payer, account, membership, payment, invoice, schedule, activation, or provider result is assumed.') { super(message); }
}
export class CrmGuardianChildPayerDesignationAccessError extends CrmGuardianChildPayerDesignationRejectedError {
  constructor(readonly status: 401 | 403) { super('Current verified human session, exact school permission, or active entitlement is unavailable. Guardian-child payer-designation state was cleared.'); }
}
export class CrmGuardianChildPayerDesignationUncertainError extends Error {
  constructor() { super('The payer-designation result is uncertain. No payer designation is assumed. Retry only the exact retained request or discard and explicitly reload readiness.'); }
}

function invalid(): never { throw new Error('The guardian-child payer-designation response could not be verified. No payer, account, membership, payment, invoice, schedule, activation, or provider result is assumed.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key))) invalid();
  return row;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_UUID.test(value)) invalid(); return value.toLowerCase(); }
function scope(value: CrmGuardianChildPayerDesignationScope): CrmGuardianChildPayerDesignationScope { return { organizationId: uuid(value.organizationId), schoolId: uuid(value.schoolId) }; }
function responseMeta(value: unknown, replayed: boolean | undefined): void {
  const envelope = record(value, ['data', 'meta']); const meta = record(envelope.meta, ['requestId', 'correlationId', 'replayed']);
  if (uuid(meta.requestId) !== uuid(meta.correlationId) || typeof meta.replayed !== 'boolean' || (replayed !== undefined && meta.replayed !== replayed)) invalid();
}
function basePath(value: CrmGuardianChildPayerDesignationScope): string { const selected = scope(value); return `/api/v1/organizations/${selected.organizationId}/schools/${selected.schoolId}/billing/crm-guardian-child-payer-designations`; }
function contentType(response: Response): boolean { return /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''); }

export function crmGuardianChildPayerDesignationPreparationPath(value: CrmGuardianChildPayerDesignationScope): string { return `${basePath(value)}/preparation`; }
export function crmGuardianChildPayerDesignationPath(value: CrmGuardianChildPayerDesignationScope): string { return basePath(value); }
export function parseCrmGuardianChildPayerDesignationPreparation(value: unknown): CrmGuardianChildPayerDesignationPreparation {
  responseMeta(value, false); return verifyCrmGuardianChildPayerDesignationPreparationApiResponse(value).data;
}
export function prepareCrmGuardianChildPayerDesignationCommand(value: CrmGuardianChildPayerDesignationScope, valueInput: CrmGuardianChildPayerDesignationInput, key: string): PreparedCrmGuardianChildPayerDesignation {
  const selected = scope(value); const normalized = validateCrmGuardianChildPayerDesignationInput(valueInput); const idempotencyKey = uuid(key);
  return Object.freeze({ path: crmGuardianChildPayerDesignationPath(selected), organizationId: selected.organizationId, schoolId: selected.schoolId, key: idempotencyKey, body: JSON.stringify(normalized) });
}
export function parseCrmGuardianChildPayerDesignationResult(value: unknown, command: PreparedCrmGuardianChildPayerDesignation): { receipt: CrmGuardianChildPayerDesignationReceipt; replayed: boolean } {
  record(command, ['path', 'organizationId', 'schoolId', 'key', 'body']); if (command.path !== crmGuardianChildPayerDesignationPath({ organizationId: command.organizationId, schoolId: command.schoolId })) invalid(); uuid(command.key); validateCrmGuardianChildPayerDesignationInput(JSON.parse(command.body));
  responseMeta(value, undefined); const parsed = verifyCrmGuardianChildPayerDesignationApiResponse(value);
  return { receipt: parsed.data, replayed: parsed.meta.replayed };
}
/** One deliberate readiness request. It never allocates an idempotency key. */
export async function loadCrmGuardianChildPayerDesignationPreparation(value: CrmGuardianChildPayerDesignationScope, studentProfileId: string): Promise<CrmGuardianChildPayerDesignationPreparation> {
  const selected = scope(value); const input = validateCrmGuardianChildPayerDesignationPreparationInput({ studentProfileId }); let response: Response;
  try { response = await fetch(crmGuardianChildPayerDesignationPreparationPath(selected), { method: 'POST', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'crm-guardian-child-payer-designation-prepare' }, body: JSON.stringify(input) }); }
  catch { throw new CrmGuardianChildPayerDesignationRejectedError(); }
  if (response.status === 401 || response.status === 403) throw new CrmGuardianChildPayerDesignationAccessError(response.status);
  if ([400, 404, 405, 409, 413, 415, 422].includes(response.status)) throw new CrmGuardianChildPayerDesignationRejectedError();
  try { if (!response.ok || response.status !== 200 || response.redirected || !contentType(response)) invalid(); const raw = await response.text(); if (raw.length > RESPONSE_MAX) invalid(); return parseCrmGuardianChildPayerDesignationPreparation(JSON.parse(raw)); }
  catch { throw new CrmGuardianChildPayerDesignationRejectedError(); }
}
/** The caller retains this frozen command only after an uncertain transport outcome. */
export async function submitCrmGuardianChildPayerDesignation(command: PreparedCrmGuardianChildPayerDesignation): Promise<{ receipt: CrmGuardianChildPayerDesignationReceipt; replayed: boolean }> {
  record(command, ['path', 'organizationId', 'schoolId', 'key', 'body']); if (command.path !== crmGuardianChildPayerDesignationPath({ organizationId: command.organizationId, schoolId: command.schoolId })) invalid(); uuid(command.key); validateCrmGuardianChildPayerDesignationInput(JSON.parse(command.body)); let response: Response;
  try { response = await fetch(command.path, { method: 'POST', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': command.key, 'X-HON-Human-Command': 'crm-guardian-child-payer-designation' }, body: command.body }); }
  catch { throw new CrmGuardianChildPayerDesignationUncertainError(); }
  if (response.status === 401 || response.status === 403) throw new CrmGuardianChildPayerDesignationAccessError(response.status);
  if ([400, 404, 405, 409, 413, 415, 422].includes(response.status)) throw new CrmGuardianChildPayerDesignationRejectedError();
  try { if (!response.ok || response.status !== 200 || response.redirected || !contentType(response)) invalid(); const raw = await response.text(); if (raw.length > RESPONSE_MAX) invalid(); return parseCrmGuardianChildPayerDesignationResult(JSON.parse(raw), command); }
  catch { throw new CrmGuardianChildPayerDesignationUncertainError(); }
}
