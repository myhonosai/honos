import type { ParentFamilyAccessLevel } from './index.js';

export const PARENT_BILLING_UNAVAILABLE = ['READ_UNAVAILABLE', 'PAYER_LINK_UNVERIFIED'] as const;
export const PARENT_BILLING_MEMBERSHIP_STATES = ['DRAFT', 'ACTIVE', 'FROZEN', 'CANCELLATION_PENDING', 'CANCELLED', 'EXPIRED'] as const;
export const PARENT_BILLING_INVOICE_STATUSES = ['DRAFT', 'ISSUED', 'PAID', 'VOID', 'UNCOLLECTIBLE'] as const;
export const PARENT_BILLING_PAYMENT_STATES = ['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'REQUIRES_ACTION', 'UNKNOWN', 'REFUNDED'] as const;

export type ParentBillingList<T> = { status: 'AVAILABLE'; items: T[]; limited: boolean }
  | { status: 'UNAVAILABLE'; reason: (typeof PARENT_BILLING_UNAVAILABLE)[number] };

/** No person, family, account, invoice, payment, provider, token, or method identifier is exposed. */
export interface ParentBillingParticipant {
  displayName: string;
  linkage: 'CURRENT_FAMILY_STUDENT';
}

/** A current-family child membership fact; plan, price/schedule, account and payer identity remain private. */
export interface ParentBillingMembership {
  participant: ParentBillingParticipant;
  payerLinkage: 'CURRENT_FAMILY_DESIGNATED_BILLING_CONTACT';
  state: (typeof PARENT_BILLING_MEMBERSHIP_STATES)[number];
  termStartedAt: string | null;
  termEndsAt: string | null;
}

/** A redacted payment-attempt observation. Provider and payment-method facts never cross this boundary. */
export interface ParentBillingPaymentAttempt {
  state: (typeof PARENT_BILLING_PAYMENT_STATES)[number];
  amountMinor: number;
  currency: string;
  initiatedAt: string;
  reconciledAt: string | null;
}

export interface ParentBillingInvoice {
  participant: ParentBillingParticipant;
  status: (typeof PARENT_BILLING_INVOICE_STATUSES)[number];
  currency: string;
  totalMinor: number;
  dueAt: string | null;
  paymentAttempts: { status: 'AVAILABLE'; items: ParentBillingPaymentAttempt[]; limited: boolean };
}

export interface ParentBillingView {
  generatedAt: string;
  accessLevel: Exclude<ParentFamilyAccessLevel, 'VIEWER'>;
  memberships: ParentBillingList<ParentBillingMembership>;
  invoices: ParentBillingList<ParentBillingInvoice>;
}

function invalid(): never { throw new Error('Parent billing response could not be verified.'); }
function object(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) invalid();
  const value = v as Record<string, unknown>;
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
  return value;
}
function text(v: unknown, max = 2000): string {
  if (typeof v !== 'string' || !v.trim() || [...v].length > max || /[\x00-\x08\x0b-\x1f\x7f]/.test(v)) invalid();
  return v;
}
function integer(v: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) invalid();
  return v as number;
}
function bool(v: unknown): boolean { if (typeof v !== 'boolean') invalid(); return v; }
function values<const T extends readonly string[]>(v: unknown, options: T): T[number] {
  if (typeof v !== 'string' || !options.includes(v)) invalid();
  return v as T[number];
}
function timestamp(v: unknown): string {
  const value = text(v, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value)) || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59
    || new Date(value.slice(0, 10)).toISOString().slice(0, 10) !== value.slice(0, 10)) invalid();
  return new Date(value).toISOString();
}
function nullableTimestamp(v: unknown): string | null { return v === null ? null : timestamp(v); }
function currency(v: unknown): string {
  const value = text(v, 3);
  if (!/^[A-Z]{3}$/.test(value)) invalid();
  return value;
}
function participant(v: unknown): ParentBillingParticipant {
  const value = object(v, ['displayName', 'linkage']);
  return { displayName: text(value.displayName, 400), linkage: values(value.linkage, ['CURRENT_FAMILY_STUDENT']) };
}
function payment(v: unknown): ParentBillingPaymentAttempt {
  const value = object(v, ['state', 'amountMinor', 'currency', 'initiatedAt', 'reconciledAt']);
  const initiatedAt = timestamp(value.initiatedAt), reconciledAt = nullableTimestamp(value.reconciledAt);
  if (reconciledAt !== null && Date.parse(reconciledAt) < Date.parse(initiatedAt)) invalid();
  return { state: values(value.state, PARENT_BILLING_PAYMENT_STATES), amountMinor: integer(value.amountMinor, 1, 2_147_483_647), currency: currency(value.currency), initiatedAt, reconciledAt };
}
function paymentList(v: unknown) {
  const value = object(v, ['status', 'items', 'limited']);
  values(value.status, ['AVAILABLE']);
  if (!Array.isArray(value.items) || value.items.length > 20) invalid();
  return { status: 'AVAILABLE' as const, items: value.items.map(payment), limited: bool(value.limited) };
}
function membership(v: unknown): ParentBillingMembership {
  const value = object(v, ['participant', 'payerLinkage', 'state', 'termStartedAt', 'termEndsAt']);
  const termStartedAt = nullableTimestamp(value.termStartedAt), termEndsAt = nullableTimestamp(value.termEndsAt);
  if (termStartedAt !== null && termEndsAt !== null && Date.parse(termEndsAt) <= Date.parse(termStartedAt)) invalid();
  return { participant: participant(value.participant), payerLinkage: values(value.payerLinkage, ['CURRENT_FAMILY_DESIGNATED_BILLING_CONTACT']), state: values(value.state, PARENT_BILLING_MEMBERSHIP_STATES), termStartedAt, termEndsAt };
}
function invoice(v: unknown): ParentBillingInvoice {
  const value = object(v, ['participant', 'status', 'currency', 'totalMinor', 'dueAt', 'paymentAttempts']);
  return { participant: participant(value.participant), status: values(value.status, PARENT_BILLING_INVOICE_STATUSES), currency: currency(value.currency), totalMinor: integer(value.totalMinor, 0, 2_147_483_647), dueAt: nullableTimestamp(value.dueAt), paymentAttempts: paymentList(value.paymentAttempts) };
}
function list<T>(v: unknown, verify: (item: unknown) => T): ParentBillingList<T> {
  if (v && typeof v === 'object' && !Array.isArray(v) && (v as { status?: unknown }).status === 'UNAVAILABLE') {
    const value = object(v, ['status', 'reason']);
    return { status: 'UNAVAILABLE', reason: values(value.reason, PARENT_BILLING_UNAVAILABLE) };
  }
  const value = object(v, ['status', 'items', 'limited']);
  values(value.status, ['AVAILABLE']);
  if (!Array.isArray(value.items) || value.items.length > 50) invalid();
  return { status: 'AVAILABLE', items: value.items.map(verify), limited: bool(value.limited) };
}

export function verifyParentBillingView(v: unknown): ParentBillingView {
  const value = object(v, ['generatedAt', 'accessLevel', 'memberships', 'invoices']);
  const memberships = list(value.memberships, membership);
  const invoices = list(value.invoices, invoice);
  // A privacy-first projection never mixes a payer-link uncertainty with an
  // allegedly complete sibling section; the function suppresses both together.
  if ((memberships.status === 'UNAVAILABLE') !== (invoices.status === 'UNAVAILABLE')
    || (memberships.status === 'UNAVAILABLE' && invoices.status === 'UNAVAILABLE' && memberships.reason !== invoices.reason)) invalid();
  return { generatedAt: timestamp(value.generatedAt), accessLevel: values(value.accessLevel, ['PRIMARY_GUARDIAN', 'SECONDARY_GUARDIAN']), memberships, invoices };
}
