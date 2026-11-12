import { ISO_4217_CURRENCIES, type CreateInvoiceDraftInput, type InvoiceDraftSummary, type InvoiceIssuedSummary } from '@hon/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MINOR = 2_147_483_647;
const RESPONSE_MAX = 4000;
const CURRENCIES = new Set<string>(ISO_4217_CURRENCIES);
export type InvoiceKnownScope = Readonly<{ organizationId: string; schoolId: string }>;
export type DraftInvoiceReceipt = Readonly<{ invoice: Readonly<InvoiceDraftSummary>; replayed: boolean }>;
export type IssuedInvoiceReceipt = Readonly<{ invoice: Readonly<InvoiceIssuedSummary>; replayed: boolean }>;
export type InvoiceReceipt = DraftInvoiceReceipt | IssuedInvoiceReceipt;
export type PreparedInvoiceCommand = Readonly<{ operation: 'CREATE' | 'ISSUE'; path: string; body: string; key: string }>;
type DraftBinding = { scope: InvoiceKnownScope; input: CreateInvoiceDraftInput; createKey: string };
type CommandBinding = DraftBinding & { prior?: DraftInvoiceReceipt };
// Capability provenance is private, memory-only, and not a server authorization gate.
const commands = new WeakMap<PreparedInvoiceCommand, CommandBinding>();
const drafts = new WeakMap<DraftInvoiceReceipt, DraftBinding>();
export class InvoiceUncertainError extends Error {}
export class InvoiceRejectedError extends Error {}
export class InvoiceAccessError extends InvoiceRejectedError {
  constructor(readonly status: 401 | 403) {
    super('Current verified human session or exact invoice permission is unavailable. All inputs, receipts and retries were cleared.');
  }
}
function invalid(): never { throw new Error('Unverified exact invoice contract. No invoice outcome is assumed.'); }
function closed(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(field => !Object.hasOwn(value, field))
    || Object.keys(value).some(field => !required.includes(field) && !optional.includes(field))) invalid();
}
function uuid(value: unknown): asserts value is string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); }
function key(value: string): void { uuid(value); if (value[14] !== '4') invalid(); }
function integer(value: unknown, minimum: number): void {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > MAX_MINOR) invalid();
}
function canonicalTime(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
}
function dueTime(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 40) invalid();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) invalid();
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  const days = new Date(`${year}-${month}-01T00:00:00Z`);
  days.setUTCMonth(days.getUTCMonth() + 1, 0);
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days.getUTCDate()
    || Number(hour) > 23 || Number(minute) > 59 || Number(second ?? 0) > 59
    || Number(offsetHour ?? 0) > 23 || Number(offsetMinute ?? 0) > 59) invalid();
}
/** Syntax only. The server decides live human/scope/tier/RLS/account/membership authority. */
export function validateInvoiceDraft(scope: InvoiceKnownScope, input: CreateInvoiceDraftInput): void {
  closed(scope, ['organizationId', 'schoolId']); uuid(scope.organizationId); uuid(scope.schoolId);
  closed(input, ['billingAccountId', 'currency', 'subtotalMinor', 'dueAt'], ['membershipId']);
  uuid(input.billingAccountId);
  if (Object.hasOwn(input, 'membershipId')) uuid(input.membershipId);
  if (!CURRENCIES.has(input.currency)) invalid();
  integer(input.subtotalMinor, 0); dueTime(input.dueAt);
}
function path(scope: InvoiceKnownScope): string {
  return `/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/billing/invoices`;
}
export function prepareInvoiceDraft(scope: InvoiceKnownScope, input: CreateInvoiceDraftInput, idempotencyKey: string): PreparedInvoiceCommand {
  validateInvoiceDraft(scope, input); key(idempotencyKey);
  const exactScope = Object.freeze({ organizationId: scope.organizationId.toLowerCase(), schoolId: scope.schoolId.toLowerCase() });
  const exactInput: CreateInvoiceDraftInput = Object.freeze({ billingAccountId: input.billingAccountId.toLowerCase(),
    ...(input.membershipId ? { membershipId: input.membershipId.toLowerCase() } : {}),
    currency: input.currency, subtotalMinor: input.subtotalMinor, dueAt: input.dueAt });
  const command = Object.freeze({ operation: 'CREATE' as const, path: path(exactScope), body: JSON.stringify(exactInput), key: idempotencyKey });
  commands.set(command, { scope: exactScope, input: exactInput, createKey: idempotencyKey });
  return command;
}
/** No invoice ID, scope, version or body input exists for issue: only this verified DRAFT receipt. */
export function prepareInvoiceIssue(receipt: DraftInvoiceReceipt, idempotencyKey: string): PreparedInvoiceCommand {
  const binding = drafts.get(receipt); key(idempotencyKey);
  if (!binding || receipt.invoice.status !== 'DRAFT' || idempotencyKey === binding.createKey) invalid();
  const command = Object.freeze({ operation: 'ISSUE' as const, path: `${path(binding.scope)}/${receipt.invoice.id.toLowerCase()}/issue`,
    body: JSON.stringify({ expectedVersion: receipt.invoice.version }), key: idempotencyKey });
  commands.set(command, { ...binding, prior: receipt });
  return command;
}
function verifyCommand(command: PreparedInvoiceCommand): CommandBinding {
  closed(command, ['operation', 'path', 'body', 'key']);
  const binding = commands.get(command);
  if (!binding || !Object.isFrozen(command)) invalid();
  return binding;
}
function parseReceipt(value: unknown, command: PreparedInvoiceCommand): InvoiceReceipt {
  const binding = verifyCommand(command);
  closed(value, ['data', 'meta']); closed(value.meta, ['requestId', 'correlationId', 'replayed']);
  uuid(value.meta.requestId); uuid(value.meta.correlationId);
  if (value.meta.requestId !== value.meta.correlationId || typeof value.meta.replayed !== 'boolean') invalid();
  closed(value.data, ['id', 'billingAccountId', 'status', 'currency', 'subtotalMinor', 'discountMinor', 'totalMinor', 'dueAt', 'version', 'createdAt'], ['membershipId']);
  const data = value.data;
  uuid(data.id); uuid(data.billingAccountId);
  if (Object.hasOwn(data, 'membershipId')) uuid(data.membershipId);
  integer(data.subtotalMinor, 0); integer(data.discountMinor, 0); integer(data.totalMinor, 0); integer(data.version, 1);
  canonicalTime(data.dueAt); canonicalTime(data.createdAt);
  if (data.billingAccountId.toLowerCase() !== binding.input.billingAccountId
    || (typeof data.membershipId === 'string' ? data.membershipId.toLowerCase() : undefined) !== binding.input.membershipId
    || data.currency !== binding.input.currency || data.subtotalMinor !== binding.input.subtotalMinor
    || data.discountMinor !== 0 || data.totalMinor !== data.subtotalMinor
    || Date.parse(data.dueAt) !== Date.parse(binding.input.dueAt)) invalid();
  const prior = binding.prior?.invoice;
  if (command.operation === 'CREATE') {
    if (data.status !== 'DRAFT' || data.version !== 1) invalid();
  } else if (!prior || data.status !== 'ISSUED' || data.id.toLowerCase() !== prior.id.toLowerCase()
    || data.version !== prior.version + 1 || data.createdAt !== prior.createdAt || data.dueAt !== prior.dueAt) invalid();
  const result = Object.freeze({ invoice: Object.freeze({ ...data }), replayed: value.meta.replayed }) as unknown as InvoiceReceipt;
  return result;
}
async function readJson(response: Response): Promise<unknown> {
  if (response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
  const text = await response.text(); if (text.length > RESPONSE_MAX) invalid();
  return JSON.parse(text);
}
async function inProgress(response: Response): Promise<boolean> {
  try {
    const problem = await readJson(response); closed(problem, ['code', 'detail']);
    return problem.code === 'IDEMPOTENCY_IN_PROGRESS' && typeof problem.detail === 'string' && problem.detail.length <= 1000;
  } catch { return false; }
}
/** Exactly one POST. Only uncertain outcomes permit a separately clicked, identical memory retry. */
export async function submitInvoiceCommand(command: PreparedInvoiceCommand): Promise<InvoiceReceipt> {
  const binding = verifyCommand(command);
  let response: Response;
  try {
    response = await fetch(command.path, {
      method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': command.key, 'X-HON-Human-Command': 'billing-invoice' }, body: command.body,
    });
  } catch { throw new InvoiceUncertainError('Invoice outcome is uncertain. Only the exact retained request may be retried; no result is assumed.'); }
  if (response.status === 401 || response.status === 403) throw new InvoiceAccessError(response.status);
  if (response.status === 409 && await inProgress(response)) {
    throw new InvoiceUncertainError('The exact invoice command is still processing. A retry is a separate human action.');
  }
  if ([400, 404, 409, 413, 415, 422].includes(response.status)) {
    throw new InvoiceRejectedError('Invoice command rejected or conflicted. Invalid receipt and retry facts were cleared. Review the inputs and start a new explicit draft attempt, or issue an earlier draft from the school invoice list.');
  }
  try {
    if (!response.ok || (command.operation === 'CREATE' ? ![200, 201].includes(response.status) : response.status !== 200)) invalid();
    const result = parseReceipt(await readJson(response), command);
    if (command.operation === 'CREATE' && result.replayed !== (response.status === 200)) invalid();
    // Register provenance only after HTTP semantics and the entire envelope verify.
    if (result.invoice.status === 'DRAFT') drafts.set(result as DraftInvoiceReceipt, binding);
    return result;
  } catch { throw new InvoiceUncertainError('No verified exact invoice receipt was returned. Outcome is uncertain; only the unchanged retained request may be retried.'); }
}
