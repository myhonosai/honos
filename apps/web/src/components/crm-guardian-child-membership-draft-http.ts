'use client';

import {
  CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_CONFIRMATION,
  CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_UUID,
  validateCrmGuardianChildMembershipDraftConfirmationInput,
  validateCrmGuardianChildMembershipDraftInput,
  validateCrmGuardianChildMembershipPreparationInput,
  verifyCrmGuardianChildMembershipDraftApiResponse,
  verifyCrmGuardianChildMembershipDraftConfirmationApiResponse,
  verifyCrmGuardianChildMembershipPreparationApiResponse,
  type CrmGuardianChildMembershipDraftConfirmation,
  type CrmGuardianChildMembershipDraftInput,
  type CrmGuardianChildMembershipDraftReceipt,
  type CrmGuardianChildMembershipPreparation,
} from '@hon/contracts';

export { CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_CONFIRMATION, CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_UUID } from '@hon/contracts';

const RESPONSE_MAX = 12_000;
export type CrmGuardianChildMembershipDraftScope = Readonly<{ organizationId: string; schoolId: string }>;
export type PreparedCrmGuardianChildMembershipDraft = Readonly<{ path: string; organizationId: string; schoolId: string; key: string; body: string }>;

export class CrmGuardianChildMembershipDraftRejectedError extends Error {
  constructor(message = 'Guardian-child membership DRAFT readiness, current confirmation, or command is unavailable. No membership, activation, payment, invoice, schedule, or provider result is assumed.') { super(message); }
}
export class CrmGuardianChildMembershipDraftAccessError extends CrmGuardianChildMembershipDraftRejectedError {
  constructor(readonly status: 401 | 403) { super('Current verified human session, exact school billing permission, or active entitlement is unavailable. Guardian-child membership preparation and confirmation were cleared.'); }
}
export class CrmGuardianChildMembershipDraftUncertainError extends Error {
  constructor() { super('The guardian-child membership DRAFT result is uncertain. No membership draft is assumed. Retry only the exact retained request or discard and explicitly reload readiness.'); }
}

function invalid(): never { throw new Error('The guardian-child membership DRAFT response could not be verified. No membership, payer, account, payment, invoice, schedule, activation, or provider result is assumed.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); const row = value as Record<string, unknown>; if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key))) invalid(); return row; }
function uuid(value: unknown): string { if (typeof value !== 'string' || !CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_UUID.test(value)) invalid(); return value.toLowerCase(); }
function scope(value: CrmGuardianChildMembershipDraftScope): CrmGuardianChildMembershipDraftScope { return { organizationId: uuid(value.organizationId), schoolId: uuid(value.schoolId) }; }
function responseMeta(value: unknown, replayed: boolean | undefined): void { const envelope = record(value, ['data', 'meta']); const meta = record(envelope.meta, ['requestId', 'correlationId', 'replayed']); if (uuid(meta.requestId) !== uuid(meta.correlationId) || typeof meta.replayed !== 'boolean' || (replayed !== undefined && meta.replayed !== replayed)) invalid(); }
function basePath(value: CrmGuardianChildMembershipDraftScope): string { const selected = scope(value); return `/api/v1/organizations/${selected.organizationId}/schools/${selected.schoolId}/billing/crm-guardian-child-membership-drafts`; }
function contentType(response: Response): boolean { return /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''); }

export function crmGuardianChildMembershipDraftPreparationPath(value: CrmGuardianChildMembershipDraftScope): string { return `${basePath(value)}/preparation`; }
export function crmGuardianChildMembershipDraftConfirmationPath(value: CrmGuardianChildMembershipDraftScope): string { return `${basePath(value)}/confirmation`; }
export function crmGuardianChildMembershipDraftPath(value: CrmGuardianChildMembershipDraftScope): string { return basePath(value); }
export function parseCrmGuardianChildMembershipDraftPreparation(value: unknown): CrmGuardianChildMembershipPreparation { responseMeta(value, false); return verifyCrmGuardianChildMembershipPreparationApiResponse(value).data; }
export function parseCrmGuardianChildMembershipDraftConfirmation(value: unknown): CrmGuardianChildMembershipDraftConfirmation { responseMeta(value, false); return verifyCrmGuardianChildMembershipDraftConfirmationApiResponse(value).data; }
export function prepareCrmGuardianChildMembershipDraftCommand(value: CrmGuardianChildMembershipDraftScope, valueInput: CrmGuardianChildMembershipDraftInput, key: string): PreparedCrmGuardianChildMembershipDraft { const selected = scope(value); const normalized = validateCrmGuardianChildMembershipDraftInput(valueInput); return Object.freeze({ path: crmGuardianChildMembershipDraftPath(selected), organizationId: selected.organizationId, schoolId: selected.schoolId, key: uuid(key), body: JSON.stringify(normalized) }); }
export function parseCrmGuardianChildMembershipDraftResult(value: unknown, command: PreparedCrmGuardianChildMembershipDraft): { receipt: CrmGuardianChildMembershipDraftReceipt; replayed: boolean } { record(command, ['path', 'organizationId', 'schoolId', 'key', 'body']); if (command.path !== crmGuardianChildMembershipDraftPath({ organizationId: command.organizationId, schoolId: command.schoolId })) invalid(); uuid(command.key); const input = validateCrmGuardianChildMembershipDraftInput(JSON.parse(command.body)); responseMeta(value, undefined); const parsed = verifyCrmGuardianChildMembershipDraftApiResponse(value, input); return { receipt: parsed.data, replayed: parsed.meta.replayed }; }
async function explicitRead<T>(path: string, studentProfileId: string, command: string, parse: (value: unknown) => T): Promise<T> { let response: Response; try { response = await fetch(path, { method: 'POST', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': command }, body: JSON.stringify({ studentProfileId }) }); } catch { throw new CrmGuardianChildMembershipDraftRejectedError(); } if (response.status === 401 || response.status === 403) throw new CrmGuardianChildMembershipDraftAccessError(response.status); if ([400, 404, 405, 409, 413, 415, 422].includes(response.status)) throw new CrmGuardianChildMembershipDraftRejectedError(); try { if (!response.ok || response.status !== 200 || response.redirected || !contentType(response)) invalid(); const raw = await response.text(); if (raw.length > RESPONSE_MAX) invalid(); return parse(JSON.parse(raw)); } catch { throw new CrmGuardianChildMembershipDraftRejectedError(); } }
/** One deliberate source-bound readiness request. It never allocates an idempotency key. */
export async function loadCrmGuardianChildMembershipDraftPreparation(value: CrmGuardianChildMembershipDraftScope, studentProfileId: string): Promise<CrmGuardianChildMembershipPreparation> { const selected = scope(value); const input = validateCrmGuardianChildMembershipPreparationInput({ studentProfileId }); return explicitRead(crmGuardianChildMembershipDraftPreparationPath(selected), input.studentProfileId, 'crm-guardian-child-membership-prepare', parseCrmGuardianChildMembershipDraftPreparation); }
/** One deliberate current observation, not a historical creation receipt or retry. */
export async function loadCrmGuardianChildMembershipDraftConfirmation(value: CrmGuardianChildMembershipDraftScope, studentProfileId: string): Promise<CrmGuardianChildMembershipDraftConfirmation> { const selected = scope(value); const input = validateCrmGuardianChildMembershipDraftConfirmationInput({ studentProfileId }); return explicitRead(crmGuardianChildMembershipDraftConfirmationPath(selected), input.studentProfileId, 'crm-guardian-child-membership-confirmation', parseCrmGuardianChildMembershipDraftConfirmation); }
/** The caller retains this frozen command only after an uncertain transport outcome. */
export async function submitCrmGuardianChildMembershipDraft(command: PreparedCrmGuardianChildMembershipDraft): Promise<{ receipt: CrmGuardianChildMembershipDraftReceipt; replayed: boolean }> { record(command, ['path', 'organizationId', 'schoolId', 'key', 'body']); if (command.path !== crmGuardianChildMembershipDraftPath({ organizationId: command.organizationId, schoolId: command.schoolId })) invalid(); uuid(command.key); validateCrmGuardianChildMembershipDraftInput(JSON.parse(command.body)); let response: Response; try { response = await fetch(command.path, { method: 'POST', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': command.key, 'X-HON-Human-Command': 'crm-guardian-child-membership-draft' }, body: command.body }); } catch { throw new CrmGuardianChildMembershipDraftUncertainError(); } if (response.status === 401 || response.status === 403) throw new CrmGuardianChildMembershipDraftAccessError(response.status); if ([400, 404, 405, 409, 413, 415, 422].includes(response.status)) throw new CrmGuardianChildMembershipDraftRejectedError(); try { if (!response.ok || response.status !== 200 || response.redirected || !contentType(response)) invalid(); const raw = await response.text(); if (raw.length > RESPONSE_MAX) invalid(); return parseCrmGuardianChildMembershipDraftResult(JSON.parse(raw), command); } catch { throw new CrmGuardianChildMembershipDraftUncertainError(); } }
