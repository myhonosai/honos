'use client';

import {
  CRM_ADULT_MEMBERSHIP_DRAFT_UUID,
  validateCrmAdultMembershipDraftInput,
  validateCrmAdultMembershipPreparationInput,
  verifyCrmAdultMembershipDraftReceipt,
  verifyCrmAdultMembershipPreparation,
  type CrmAdultMembershipDraftInput,
  type CrmAdultMembershipDraftReceipt,
  type CrmAdultMembershipPreparation,
} from '@hon/contracts';

const RESPONSE_MAX = 12_000;

export type CrmAdultMembershipDraftScope = Readonly<{ organizationId: string; schoolId: string }>;
export type PreparedCrmAdultMembershipDraft = Readonly<{
  path: string;
  organizationId: string;
  schoolId: string;
  key: string;
  body: string;
}>;

export class CrmAdultMembershipDraftRejectedError extends Error {
  constructor(message = 'Adult CRM membership draft readiness or command is unavailable. No membership draft was recorded.') { super(message); }
}

export class CrmAdultMembershipDraftAccessError extends CrmAdultMembershipDraftRejectedError {
  constructor(readonly status: 401 | 403) {
    super('Current verified human session, exact school billing permission, or active entitlement is unavailable. Adult CRM membership readiness was cleared.');
  }
}

export class CrmAdultMembershipDraftUncertainError extends Error {
  constructor() { super('The membership draft result is uncertain. No membership draft is assumed. Retry only the exact retained request or discard and explicitly reload readiness.'); }
}

function invalid(): never { throw new Error('The adult CRM membership draft response could not be verified. No membership, payer, account, payment, activation, or provider result is assumed.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key))) invalid();
  return row;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !CRM_ADULT_MEMBERSHIP_DRAFT_UUID.test(value)) invalid();
  return value.toLowerCase();
}
function scope(value: CrmAdultMembershipDraftScope): CrmAdultMembershipDraftScope {
  return { organizationId: uuid(value.organizationId), schoolId: uuid(value.schoolId) };
}
function responseMeta(value: unknown, replayed: boolean | undefined): void {
  const envelope = record(value, ['data', 'meta']);
  const meta = record(envelope.meta, ['requestId', 'correlationId', 'replayed']);
  if (uuid(meta.requestId) !== uuid(meta.correlationId) || typeof meta.replayed !== 'boolean' || (replayed !== undefined && meta.replayed !== replayed)) invalid();
}
function basePath(value: CrmAdultMembershipDraftScope): string {
  const selected = scope(value);
  return `/api/v1/organizations/${selected.organizationId}/schools/${selected.schoolId}/billing/crm-adult-membership-drafts`;
}
function contentType(response: Response): boolean { return /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''); }

export function crmAdultMembershipDraftPreparationPath(value: CrmAdultMembershipDraftScope): string { return `${basePath(value)}/preparation`; }
export function crmAdultMembershipDraftPath(value: CrmAdultMembershipDraftScope): string { return basePath(value); }

export function parseCrmAdultMembershipDraftPreparation(value: unknown): CrmAdultMembershipPreparation {
  responseMeta(value, false);
  return verifyCrmAdultMembershipPreparation((value as { data: unknown }).data);
}

export function prepareCrmAdultMembershipDraftCommand(
  value: CrmAdultMembershipDraftScope,
  input: CrmAdultMembershipDraftInput,
  key: string,
): PreparedCrmAdultMembershipDraft {
  const selected = scope(value);
  const normalized = validateCrmAdultMembershipDraftInput(input);
  const idempotencyKey = uuid(key);
  return Object.freeze({
    path: crmAdultMembershipDraftPath(selected),
    organizationId: selected.organizationId,
    schoolId: selected.schoolId,
    key: idempotencyKey,
    body: JSON.stringify(normalized),
  });
}

export function parseCrmAdultMembershipDraftResult(value: unknown, command: PreparedCrmAdultMembershipDraft): { receipt: CrmAdultMembershipDraftReceipt; replayed: boolean } {
  record(command, ['path', 'organizationId', 'schoolId', 'key', 'body']);
  if (command.path !== crmAdultMembershipDraftPath({ organizationId: command.organizationId, schoolId: command.schoolId })) invalid();
  uuid(command.key);
  const input = validateCrmAdultMembershipDraftInput(JSON.parse(command.body));
  const envelope = record(value, ['data', 'meta']);
  const meta = record(envelope.meta, ['requestId', 'correlationId', 'replayed']);
  if (uuid(meta.requestId) !== uuid(meta.correlationId) || typeof meta.replayed !== 'boolean') invalid();
  return { receipt: verifyCrmAdultMembershipDraftReceipt(envelope.data, input), replayed: meta.replayed };
}

/** One deliberate, read-only readiness request. It never allocates an idempotency key. */
export async function loadCrmAdultMembershipDraftPreparation(
  value: CrmAdultMembershipDraftScope,
  studentProfileId: string,
): Promise<CrmAdultMembershipPreparation> {
  const selected = scope(value);
  const input = validateCrmAdultMembershipPreparationInput({ studentProfileId });
  let response: Response;
  try {
    response = await fetch(crmAdultMembershipDraftPreparationPath(selected), {
      method: 'POST', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'crm-adult-membership-prepare' },
      body: JSON.stringify(input),
    });
  } catch { throw new CrmAdultMembershipDraftRejectedError(); }
  if (response.status === 401 || response.status === 403) throw new CrmAdultMembershipDraftAccessError(response.status);
  if ([400, 404, 405, 409, 413, 415, 422].includes(response.status)) throw new CrmAdultMembershipDraftRejectedError();
  try {
    if (!response.ok || response.status !== 200 || response.redirected || !contentType(response)) invalid();
    const raw = await response.text();
    if (raw.length > RESPONSE_MAX) invalid();
    return parseCrmAdultMembershipDraftPreparation(JSON.parse(raw));
  } catch { throw new CrmAdultMembershipDraftRejectedError(); }
}

/** The caller retains this frozen command only after an uncertain transport outcome. */
export async function submitCrmAdultMembershipDraft(command: PreparedCrmAdultMembershipDraft): Promise<{ receipt: CrmAdultMembershipDraftReceipt; replayed: boolean }> {
  record(command, ['path', 'organizationId', 'schoolId', 'key', 'body']);
  if (command.path !== crmAdultMembershipDraftPath({ organizationId: command.organizationId, schoolId: command.schoolId })) invalid();
  uuid(command.key);
  validateCrmAdultMembershipDraftInput(JSON.parse(command.body));
  let response: Response;
  try {
    response = await fetch(command.path, {
      method: 'POST', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': command.key, 'X-HON-Human-Command': 'crm-adult-membership-draft' },
      body: command.body,
    });
  } catch { throw new CrmAdultMembershipDraftUncertainError(); }
  if (response.status === 401 || response.status === 403) throw new CrmAdultMembershipDraftAccessError(response.status);
  if ([400, 404, 405, 409, 413, 415, 422].includes(response.status)) throw new CrmAdultMembershipDraftRejectedError();
  try {
    if (!response.ok || response.status !== 200 || response.redirected || !contentType(response)) invalid();
    const raw = await response.text();
    if (raw.length > RESPONSE_MAX) invalid();
    return parseCrmAdultMembershipDraftResult(JSON.parse(raw), command);
  } catch { throw new CrmAdultMembershipDraftUncertainError(); }
}
