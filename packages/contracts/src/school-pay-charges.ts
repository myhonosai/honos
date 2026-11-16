/**
 * B-TUI-2 piece 5a (0337): charging one prepared autopay cycle (0322) with the payer's saved method at the school's own
 * processor, test mode only. An attempt is PENDING until the processor answers; SUCCEEDED records PROVIDER payments and
 * marks the cycle invoices PAID; PROCESSING (a bank debit still clearing) and UNKNOWN stay open until the processor's
 * own answer settles them (reconcile). Nothing is guessed, and HON takes no fee.
 */
import { SCHOOL_PAY_PROVIDER_CODES, type SchoolPayProviderCode } from './school-payments.js';
import { SCHOOL_PAY_METHOD_KINDS, type SchoolPayMethodKind } from './school-pay-methods.js';

export const SCHOOL_PAY_CHARGE_STATES = ['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'UNKNOWN'] as const;
export type SchoolPayChargeState = (typeof SCHOOL_PAY_CHARGE_STATES)[number];
/** States still waiting for the processor's final answer. */
export const SCHOOL_PAY_CHARGE_OPEN_STATES: readonly SchoolPayChargeState[] = ['PENDING', 'PROCESSING', 'UNKNOWN'];
export const SCHOOL_PAY_CHARGE_FAILURE_CLASSES = ['DECLINED', 'AUTHENTICATION_REQUIRED', 'INSUFFICIENT_FUNDS', 'EXPIRED_CARD', 'NOT_SENT', 'OTHER'] as const;
export type SchoolPayChargeFailureClass = (typeof SCHOOL_PAY_CHARGE_FAILURE_CLASSES)[number];
/** What the processor answered: the outcome an adapter reports and the finish command records. */
export const SCHOOL_PAY_CHARGE_OUTCOMES = ['SUCCEEDED', 'PROCESSING', 'FAILED', 'UNKNOWN'] as const;
export type SchoolPayChargeOutcome = (typeof SCHOOL_PAY_CHARGE_OUTCOMES)[number];

export interface SchoolPayChargeAttempt {
  attemptId: string; cycleId: string; billingAccountId: string; planId: string; methodId: string; providerCode: SchoolPayProviderCode;
  amountMinor: number; currency: string; state: SchoolPayChargeState; failureClass: SchoolPayChargeFailureClass | null; platformFee: 'NONE';
  version: number; createdAt: string; updatedAt: string; finishedAt: string | null;
}
export interface SchoolPayPayerCharges { billingAccountId: string; canManage: boolean; platformFee: 'NONE'; attempts: SchoolPayChargeAttempt[] }
/** API-internal: the provider references for one attempt. Never sent to a browser. */
export interface SchoolPayChargeProviderRefs {
  providerCode: SchoolPayProviderCode; accountRef: string; customerRef: string; methodRef: string; methodKind: SchoolPayMethodKind; connectionState: string;
}
export interface SchoolPayChargeContext { attempt: SchoolPayChargeAttempt; provider: SchoolPayChargeProviderRefs }
/** What the processor said about one charge (adapter output, checked before it is recorded). */
export interface SchoolPayChargeObservation {
  outcome: SchoolPayChargeOutcome; chargeRef: string | null; failureClass: SchoolPayChargeFailureClass | null; amountMinor: number; currency: string;
}

export interface StartSchoolPayChargeInput { totalMinor: number; currency: string }
export interface FinishSchoolPayChargeInput {
  expectedVersion: number; outcome: SchoolPayChargeOutcome; amountMinor: number; currency: string; chargeRef?: string; failureClass?: SchoolPayChargeFailureClass;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CURRENCY = /^[A-Z]{3}$/;
const PROVIDER_REF = /^[A-Za-z0-9_:-]{3,100}$/;
const ACCOUNT_REF = /^[A-Za-z0-9_-]{3,100}$/;
const MAX_AMOUNT = 5_000_000_000;

function invalid(): never { throw new Error('Invalid school charge data.'); }
function record(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (keys.some(key => !(key in row)) || Object.keys(row).some(key => !keys.includes(key) && !optional.includes(key))) invalid();
  return row;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value.toLowerCase(); }
function count(value: unknown, minimum: number, maximum = 999_999_999): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
function instant(value: unknown): string {
  if (typeof value !== 'string' || !INSTANT.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}
function matching(value: unknown, pattern: RegExp): string { if (typeof value !== 'string' || !pattern.test(value)) invalid(); return value; }
function nullable<T>(value: unknown, read: (value: unknown) => T): T | null { return value === null ? null : read(value); }
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T { if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(); return value as T; }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function list(value: unknown, maximum: number): unknown[] { if (!Array.isArray(value) || value.length > maximum) invalid(); return value; }

export function validateStartSchoolPayChargeInput(value: unknown): StartSchoolPayChargeInput {
  const row = record(value, ['totalMinor', 'currency']);
  return { totalMinor: count(row.totalMinor, 1, MAX_AMOUNT), currency: matching(row.currency, CURRENCY) };
}

/** An observation as the finish command accepts it: success and processing carry the charge id, failure its class. */
export function verifySchoolPayChargeObservation(value: unknown, expect: { amountMinor?: number; currency?: string } = {}): SchoolPayChargeObservation {
  const row = record(value, ['outcome', 'chargeRef', 'failureClass', 'amountMinor', 'currency']);
  const observation: SchoolPayChargeObservation = {
    outcome: oneOf(row.outcome, SCHOOL_PAY_CHARGE_OUTCOMES), chargeRef: nullable(row.chargeRef, v => matching(v, PROVIDER_REF)),
    failureClass: nullable(row.failureClass, v => oneOf(v, SCHOOL_PAY_CHARGE_FAILURE_CLASSES)), amountMinor: count(row.amountMinor, 1, MAX_AMOUNT),
    currency: matching(row.currency, CURRENCY),
  };
  if ((observation.outcome === 'FAILED') !== (observation.failureClass !== null)) invalid();
  if ((observation.outcome === 'SUCCEEDED' || observation.outcome === 'PROCESSING') && observation.chargeRef === null) invalid();
  if ((expect.amountMinor !== undefined && observation.amountMinor !== expect.amountMinor) || (expect.currency !== undefined && observation.currency !== expect.currency)) invalid();
  return observation;
}

// Output verifiers: every database response is checked strictly before it is used or reaches a client.
export function verifySchoolPayChargeAttempt(value: unknown, expect: { attemptId?: string; billingAccountId?: string; cycleId?: string } = {}): SchoolPayChargeAttempt {
  const row = record(value, ['attemptId', 'cycleId', 'billingAccountId', 'planId', 'methodId', 'providerCode', 'amountMinor', 'currency', 'state', 'failureClass',
    'platformFee', 'version', 'createdAt', 'updatedAt', 'finishedAt']);
  const attempt: SchoolPayChargeAttempt = {
    attemptId: uuid(row.attemptId), cycleId: uuid(row.cycleId), billingAccountId: uuid(row.billingAccountId), planId: uuid(row.planId), methodId: uuid(row.methodId),
    providerCode: oneOf(row.providerCode, SCHOOL_PAY_PROVIDER_CODES), amountMinor: count(row.amountMinor, 1, MAX_AMOUNT), currency: matching(row.currency, CURRENCY),
    state: oneOf(row.state, SCHOOL_PAY_CHARGE_STATES), failureClass: nullable(row.failureClass, v => oneOf(v, SCHOOL_PAY_CHARGE_FAILURE_CLASSES)),
    platformFee: oneOf(row.platformFee, ['NONE'] as const), version: count(row.version, 1), createdAt: instant(row.createdAt), updatedAt: instant(row.updatedAt),
    finishedAt: nullable(row.finishedAt, instant),
  };
  if ((attempt.state === 'FAILED') !== (attempt.failureClass !== null)) invalid();
  if ((attempt.state === 'SUCCEEDED' || attempt.state === 'FAILED') !== (attempt.finishedAt !== null)) invalid();
  if ((attempt.state === 'PENDING') !== (attempt.version === 1)) invalid();
  if ((expect.attemptId !== undefined && attempt.attemptId !== expect.attemptId.toLowerCase())
    || (expect.billingAccountId !== undefined && attempt.billingAccountId !== expect.billingAccountId.toLowerCase())
    || (expect.cycleId !== undefined && attempt.cycleId !== expect.cycleId.toLowerCase())) invalid();
  return attempt;
}
export function verifySchoolPayPayerCharges(value: unknown, billingAccountId?: string): SchoolPayPayerCharges {
  const row = record(value, ['billingAccountId', 'canManage', 'platformFee', 'attempts']);
  const payer = uuid(row.billingAccountId);
  if (billingAccountId !== undefined && payer !== billingAccountId.toLowerCase()) invalid();
  const attempts = list(row.attempts, 24).map(v => verifySchoolPayChargeAttempt(v, { billingAccountId: payer }));
  if (new Set(attempts.map(a => a.attemptId)).size !== attempts.length) invalid();
  // At most one attempt per cycle that is not FAILED.
  const live = attempts.filter(a => a.state !== 'FAILED').map(a => a.cycleId);
  if (new Set(live).size !== live.length) invalid();
  return { billingAccountId: payer, canManage: bool(row.canManage), platformFee: oneOf(row.platformFee, ['NONE'] as const), attempts };
}
export function verifySchoolPayChargeContext(value: unknown, attemptId?: string): SchoolPayChargeContext {
  const row = record(value, ['attempt', 'provider']);
  const attempt = verifySchoolPayChargeAttempt(row.attempt, attemptId === undefined ? {} : { attemptId });
  const p = record(row.provider, ['providerCode', 'accountRef', 'customerRef', 'methodRef', 'methodKind', 'connectionState']);
  const provider: SchoolPayChargeProviderRefs = {
    providerCode: oneOf(p.providerCode, SCHOOL_PAY_PROVIDER_CODES), accountRef: matching(p.accountRef, ACCOUNT_REF), customerRef: matching(p.customerRef, PROVIDER_REF),
    methodRef: matching(p.methodRef, PROVIDER_REF), methodKind: oneOf(p.methodKind, SCHOOL_PAY_METHOD_KINDS),
    connectionState: oneOf(p.connectionState, ['PENDING_ONBOARDING', 'CONNECTED_RESTRICTED', 'CONNECTED_ACTIVE', 'REAUTHORIZATION_REQUIRED', 'DISCONNECTED', 'ABANDONED'] as const),
  };
  if (provider.providerCode !== attempt.providerCode) invalid();
  return { attempt, provider };
}
export function verifySchoolPayChargeReceipt(value: unknown, expect: { attemptId?: string; billingAccountId?: string; cycleId?: string } = {}): { attempt: SchoolPayChargeAttempt } {
  const row = record(value, ['attempt']);
  return { attempt: verifySchoolPayChargeAttempt(row.attempt, expect) };
}
