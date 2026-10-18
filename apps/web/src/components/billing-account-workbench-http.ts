import { validateCreateBillingAccountInput, type BillingAccountClassification, type CreateBillingAccountInput } from '@hon/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESPONSE_MAX = 12_000;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
export type BillingAccountScope = Readonly<{ organizationId: string; schoolId: string }>;
export type BillingAccountPayerChoice = Readonly<{ id: string; displayName: string }>;
export type BillingAccountReceipt = Readonly<{ account: Readonly<{ id: string; responsiblePersonId: string; currency: string; classification: BillingAccountClassification; reused: boolean }>; replayed: boolean }>;
export type PreparedBillingAccountCommand = Readonly<{ path: string; key: string; body: string }>;
export type PreparedBillingAccountPayerLookup = Readonly<{ path: string; body: string }>;

export class BillingAccountUncertainError extends Error {}
export class BillingAccountRejectedError extends Error {}
export class BillingAccountAccessError extends BillingAccountRejectedError {}
export class BillingAccountCurrencyConflictError extends BillingAccountRejectedError {}
type NormalizedBillingAccountInput = { responsiblePersonId: string; currency: string; createAdditional: boolean; additionalReason?: string };

function invalid(): never { throw new Error('Unverified billing-account workbench contract. No account outcome is assumed.'); }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function uuid(value: unknown): asserts value is string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); }
function key(value: unknown): asserts value is string { uuid(value); if (value[14] !== '4') invalid(); }
function time(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
}
function scope(value: BillingAccountScope): void { record(value, ['organizationId', 'schoolId']); uuid(value.organizationId); uuid(value.schoolId); }
function normalized(input: CreateBillingAccountInput): NormalizedBillingAccountInput {
  validateCreateBillingAccountInput(input);
  return Object.freeze({ responsiblePersonId: input.responsiblePersonId.toLowerCase(), currency: (input.currency ?? 'USD').toUpperCase(),
    createAdditional: input.createAdditional === true, ...(input.createAdditional ? { additionalReason: input.additionalReason } : {}) });
}
function accountPath(value: BillingAccountScope): string { return `/api/v1/organizations/${value.organizationId.toLowerCase()}/schools/${value.schoolId.toLowerCase()}/billing/accounts`; }

/** A key is supplied only at an explicit confirmation, never on mount or payer lookup. */
export function prepareBillingAccountCommand(value: BillingAccountScope, input: CreateBillingAccountInput, idempotencyKey: string): PreparedBillingAccountCommand {
  scope(value); key(idempotencyKey); const body = normalized(input);
  return Object.freeze({ path: accountPath(value), key: idempotencyKey, body: JSON.stringify(body) });
}

export function prepareBillingAccountPayerLookup(value: BillingAccountScope, query: string): PreparedBillingAccountPayerLookup {
  scope(value);
  if (typeof query !== 'string' || query.length < 2 || query.length > 20 || query.trim() !== query || UNSAFE.test(query)) invalid();
  return Object.freeze({ path: `${accountPath(value)}/payer-lookup`, body: JSON.stringify({ query }) });
}

function verifiedCommand(command: PreparedBillingAccountCommand): CreateBillingAccountInput {
  record(command, ['path', 'key', 'body']); key(command.key);
  if (typeof command.path !== 'string' || !/^\/api\/v1\/organizations\/[0-9a-f-]{36}\/schools\/[0-9a-f-]{36}\/billing\/accounts$/i.test(command.path)
    || typeof command.body !== 'string' || command.body.length > 1_500) invalid();
  let value: unknown; try { value = JSON.parse(command.body); } catch { invalid(); }
  const input = normalized(value as CreateBillingAccountInput);
  if (command.body !== JSON.stringify(input)) invalid();
  return input;
}
function verifiedLookup(command: PreparedBillingAccountPayerLookup): string {
  record(command, ['path', 'body']);
  if (typeof command.path !== 'string' || !/^\/api\/v1\/organizations\/[0-9a-f-]{36}\/schools\/[0-9a-f-]{36}\/billing\/accounts\/payer-lookup$/i.test(command.path)
    || typeof command.body !== 'string' || command.body.length > 100) invalid();
  let value: unknown; try { value = JSON.parse(command.body); } catch { invalid(); }
  record(value, ['query']);
  if (typeof value.query !== 'string' || value.query.length < 2 || value.query.length > 20 || value.query.trim() !== value.query || UNSAFE.test(value.query)
    || command.body !== JSON.stringify({ query: value.query })) invalid();
  return value.query;
}
async function readJson(response: Response): Promise<unknown> {
  if (response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
    || !/^private,\s*no-store$/i.test(response.headers.get('cache-control') ?? '')) invalid();
  const text = await response.text(); if (text.length > RESPONSE_MAX) invalid();
  return JSON.parse(text);
}
async function conflict(response: Response): Promise<string | null> {
  try { const value = await readJson(response); record(value, ['code', 'detail']); return typeof value.code === 'string' && typeof value.detail === 'string' && value.detail.length <= 500 ? value.code : null; }
  catch { return null; }
}

export function parseBillingAccountReceipt(value: unknown, command: PreparedBillingAccountCommand): BillingAccountReceipt {
  const input = verifiedCommand(command);
  record(value, ['data', 'meta']); record(value.meta, ['requestId', 'correlationId', 'replayed']);
  uuid(value.meta.requestId); uuid(value.meta.correlationId);
  if (value.meta.requestId !== value.meta.correlationId || typeof value.meta.replayed !== 'boolean') invalid();
  record(value.data, ['id', 'responsiblePersonId', 'currency', 'classification', 'version', 'createdAt', 'reused']);
  const data = value.data;
  uuid(data.id); uuid(data.responsiblePersonId); time(data.createdAt);
  if (typeof data.currency !== 'string' || !/^[A-Z]{3}$/.test(data.currency) || typeof data.classification !== 'string'
    || typeof data.version !== 'number' || data.responsiblePersonId.toLowerCase() !== input.responsiblePersonId || data.currency !== input.currency
    || !['CANONICAL', 'ADDITIONAL'].includes(data.classification) || data.version !== 1 || typeof data.reused !== 'boolean'
    || (input.createAdditional && (data.classification !== 'ADDITIONAL' || data.reused))
    || (!input.createAdditional && data.classification !== 'CANONICAL')) invalid();
  return Object.freeze({ account: Object.freeze({ id: data.id, responsiblePersonId: data.responsiblePersonId, currency: data.currency,
    classification: data.classification as BillingAccountClassification, reused: data.reused }), replayed: value.meta.replayed });
}

/** Exactly one no-store POST; retry is enabled only by the caller retaining this frozen request after uncertainty. */
export async function submitBillingAccountCommand(command: PreparedBillingAccountCommand): Promise<BillingAccountReceipt> {
  verifiedCommand(command);
  let response: Response;
  try {
    response = await fetch(command.path, { method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': command.key, 'X-HON-Human-Command': 'billing.account.create' }, body: command.body });
  } catch { throw new BillingAccountUncertainError('Billing-account outcome is uncertain. Only the exact retained request may be retried; no account result is assumed.'); }
  if (response.status === 401 || response.status === 403) throw new BillingAccountAccessError('Current human session or billing-account authority is unavailable. Draft, receipt and retry were cleared.');
  if (response.status === 409) {
    const code = await conflict(response);
    if (code === 'CANONICAL_ACCOUNT_CURRENCY_CONFLICT') throw new BillingAccountCurrencyConflictError('A current canonical account has a different currency. No account was created or changed; an explicit documented additional-account request is available.');
    if (code === 'IDEMPOTENCY_IN_PROGRESS') throw new BillingAccountUncertainError('The exact billing-account command is still processing. A retry is a separate human action.');
    throw new BillingAccountRejectedError('Billing-account command rejected or conflicted. No verified account receipt is shown.');
  }
  if ([400, 404, 413, 415, 422].includes(response.status)) throw new BillingAccountRejectedError('Billing-account command rejected. No verified account receipt is shown.');
  try {
    if (!response.ok || ![200, 201].includes(response.status)) invalid();
    const receipt = parseBillingAccountReceipt(await readJson(response), command);
    if ((response.status === 201) !== (!receipt.replayed && !receipt.account.reused)) invalid();
    return receipt;
  } catch { throw new BillingAccountUncertainError('No verified billing-account receipt was returned. Outcome is uncertain; only the unchanged retained request may be retried.'); }
}

/** Explicit query only. This read returns at most ten current-school payer choices and no account data. */
export async function submitBillingAccountPayerLookup(command: PreparedBillingAccountPayerLookup): Promise<BillingAccountPayerChoice[]> {
  verifiedLookup(command);
  let response: Response;
  try {
    response = await fetch(command.path, { method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'billing.account.create' }, body: command.body });
  } catch { throw new BillingAccountRejectedError('Payer lookup is unavailable. No payer was selected.'); }
  if (response.status === 401 || response.status === 403) throw new BillingAccountAccessError('Current human session or billing-account authority is unavailable. No payer was selected.');
  if (!response.ok || response.status !== 200) throw new BillingAccountRejectedError('Payer lookup was rejected. No payer was selected.');
  try {
    const value = await readJson(response); record(value, ['data']);
    if (!Array.isArray(value.data) || value.data.length > 10) invalid();
    const seen = new Set<string>();
    return value.data.map((item) => {
      record(item, ['id', 'displayName']); uuid(item.id);
      if (typeof item.displayName !== 'string' || item.displayName.length < 1 || item.displayName.length > 241 || item.displayName.trim() !== item.displayName || UNSAFE.test(item.displayName)
        || seen.has(item.id.toLowerCase())) invalid();
      seen.add(item.id.toLowerCase()); return Object.freeze({ id: item.id.toLowerCase(), displayName: item.displayName });
    });
  } catch { throw new BillingAccountRejectedError('Payer lookup did not return verified current-school choices. No payer was selected.'); }
}
