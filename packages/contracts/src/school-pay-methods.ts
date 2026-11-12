/**
 * B-TUI-2 piece 3 (0265): a payer's saved cards and US bank accounts at the school's own processor (Stripe, Square),
 * TEST mode only. HON keeps only the provider reference, brand, last four, card expiry and the consent version the payer
 * agreed to: never a card number, bank number, token secret or CVC. Nothing here charges anyone, and HON takes no fee.
 */
export const SCHOOL_PAY_METHOD_KINDS = ['CARD', 'US_BANK_ACCOUNT'] as const;
export type SchoolPayMethodKind = (typeof SCHOOL_PAY_METHOD_KINDS)[number];
export const SCHOOL_PAY_CARD_BRANDS = ['VISA', 'MASTERCARD', 'AMEX', 'DISCOVER', 'JCB', 'DINERS', 'UNIONPAY', 'OTHER'] as const;
export type SchoolPayCardBrand = (typeof SCHOOL_PAY_CARD_BRANDS)[number];
export type SchoolPayMethodBrand = SchoolPayCardBrand | 'BANK';
export const SCHOOL_PAY_SETUP_STATES = ['PENDING', 'COMPLETED', 'SUPERSEDED'] as const;
export type SchoolPaySetupState = (typeof SCHOOL_PAY_SETUP_STATES)[number];
/** The consent text version the staff member showed the payer before the setup (the web copy carries the same id). */
export const SCHOOL_PAY_CONSENT_VERSION = /^[a-z0-9][a-z0-9._-]{0,39}$/;

export interface SchoolPayMethod {
  methodId: string; billingAccountId: string; connectionId: string; kind: SchoolPayMethodKind; brand: SchoolPayMethodBrand; last4: string;
  expMonth: number | null; expYear: number | null; status: 'ACTIVE' | 'REMOVED'; isDefault: boolean; consentTextVersion: string;
  version: number; createdAt: string; removedAt: string | null; removeReason: string | null;
}
export interface SchoolPayMethodSetup {
  setupId: string; billingAccountId: string; connectionId: string; state: SchoolPaySetupState; setupRef: string;
  methodKinds: SchoolPayMethodKind[]; consentTextVersion: string; expiresAt: string; methodId: string | null; version: number; createdAt: string;
}
export interface SchoolPayMethodConnection {
  connectionId: string; providerCode: string; displayName: string; accountRef: string; isDefault: boolean; storedCard: true; bankDebit: boolean; customerRef: string | null;
}
export interface SchoolPayPayerMethods {
  billingAccountId: string; canManage: boolean; platformFee: 'NONE'; payerName: string;
  connections: SchoolPayMethodConnection[]; methods: SchoolPayMethod[];
  /** Unexpired pending setups, and setups completed in the last hour (so a retried finish can replay). */
  setups: SchoolPayMethodSetup[];
}
export interface SchoolPayExpiringMethod {
  methodId: string; billingAccountId: string; payerName: string; connectionId: string; brand: SchoolPayCardBrand; last4: string;
  expMonth: number; expYear: number; isDefault: boolean; expired: boolean;
}
export interface SchoolPayExpiringMethods { asOfMonth: string; methods: SchoolPayExpiringMethod[] }
/** One authenticated retrieval of a completed provider setup, as the adapter reports it. */
export interface SchoolPayMethodObservation {
  customerRef: string; methodRef: string; kind: SchoolPayMethodKind; brand: SchoolPayMethodBrand; last4: string; expMonth: number | null; expYear: number | null;
}
export interface SchoolPaySetupReceipt { setup: SchoolPayMethodSetup }
export interface SchoolPayMethodReceipt { method: SchoolPayMethod }
/** The database's remove answer: the provider references go to the API only, to detach the method. */
export interface SchoolPayMethodRemoval extends SchoolPayMethodReceipt { providerMethodRef: string; connectionId: string }

export interface StartSchoolPayMethodSetupInput { connectionId: string; methodKinds: SchoolPayMethodKind[]; consentTextVersion: string }
export interface FinishSchoolPayMethodSetupInput { expectedVersion: number; setupState: string }
export interface SchoolPayMethodVersionInput { expectedVersion: number }
export interface RemoveSchoolPayMethodInput { expectedVersion: number; reason: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PROVIDER_REF = /^[A-Za-z0-9_:-]{3,100}$/;
const PROVIDER_CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
const LAST4 = /^[0-9]{4}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
/** The one-time setup state HON puts in the provider return URL. */
export const SCHOOL_PAY_SETUP_STATE = /^[A-Za-z0-9_-]{32,128}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function invalid(): never { throw new Error('Invalid school payment method data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !(key in row))) invalid();
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
function text(value: unknown, maximum = 1000, minimum = 1): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || value.trim() !== value || CONTROL.test(value)) invalid();
  return value;
}
function matching(value: unknown, pattern: RegExp): string { if (typeof value !== 'string' || !pattern.test(value)) invalid(); return value; }
function nullable<T>(value: unknown, read: (value: unknown) => T): T | null { return value === null ? null : read(value); }
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T { if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(); return value as T; }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function kinds(value: unknown): SchoolPayMethodKind[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) invalid();
  const list = value.map(kind => oneOf(kind, SCHOOL_PAY_METHOD_KINDS));
  if (new Set(list).size !== list.length) invalid();
  return [...list].sort();
}
/** Brand, last four and expiry together: a card has a card brand and an expiry; a bank account has neither. */
function methodFacts(row: Record<string, unknown>): Pick<SchoolPayMethod, 'kind' | 'brand' | 'last4' | 'expMonth' | 'expYear'> {
  const kind = oneOf(row.kind, SCHOOL_PAY_METHOD_KINDS);
  const last4 = matching(row.last4, LAST4);
  if (kind === 'CARD') {
    return { kind, brand: oneOf(row.brand, SCHOOL_PAY_CARD_BRANDS), last4, expMonth: count(row.expMonth, 1, 12), expYear: count(row.expYear, 2000, 2100) };
  }
  if (row.brand !== 'BANK' || row.expMonth !== null || row.expYear !== null) invalid();
  return { kind, brand: 'BANK', last4, expMonth: null, expYear: null };
}

// Input validators (the database validates the same rules again).
export function validateStartSchoolPayMethodSetupInput(value: unknown): StartSchoolPayMethodSetupInput {
  const row = record(value, ['connectionId', 'methodKinds', 'consentTextVersion']);
  return { connectionId: uuid(row.connectionId), methodKinds: kinds(row.methodKinds), consentTextVersion: matching(row.consentTextVersion, SCHOOL_PAY_CONSENT_VERSION) };
}
export function validateFinishSchoolPayMethodSetupInput(value: unknown): FinishSchoolPayMethodSetupInput {
  const row = record(value, ['expectedVersion', 'setupState']);
  return { expectedVersion: count(row.expectedVersion, 1), setupState: matching(row.setupState, SCHOOL_PAY_SETUP_STATE) };
}
export function validateSchoolPayMethodVersionInput(value: unknown): SchoolPayMethodVersionInput {
  const row = record(value, ['expectedVersion']);
  return { expectedVersion: count(row.expectedVersion, 1) };
}
export function validateRemoveSchoolPayMethodInput(value: unknown): RemoveSchoolPayMethodInput {
  const row = record(value, ['expectedVersion', 'reason']);
  return { expectedVersion: count(row.expectedVersion, 1), reason: text(row.reason) };
}

// Output verifiers: every adapter and database response is checked strictly before it is used or reaches a client.
export function verifySchoolPayMethodObservation(value: unknown): SchoolPayMethodObservation {
  const row = record(value, ['customerRef', 'methodRef', 'kind', 'brand', 'last4', 'expMonth', 'expYear']);
  return { customerRef: matching(row.customerRef, PROVIDER_REF), methodRef: matching(row.methodRef, PROVIDER_REF), ...methodFacts(row) };
}
export function verifySchoolPayMethod(value: unknown, expect: { methodId?: string; billingAccountId?: string } = {}): SchoolPayMethod {
  const row = record(value, ['methodId', 'billingAccountId', 'connectionId', 'kind', 'brand', 'last4', 'expMonth', 'expYear', 'status', 'isDefault',
    'consentTextVersion', 'version', 'createdAt', 'removedAt', 'removeReason']);
  const method: SchoolPayMethod = {
    methodId: uuid(row.methodId), billingAccountId: uuid(row.billingAccountId), connectionId: uuid(row.connectionId), ...methodFacts(row),
    status: oneOf(row.status, ['ACTIVE', 'REMOVED'] as const), isDefault: bool(row.isDefault),
    consentTextVersion: matching(row.consentTextVersion, SCHOOL_PAY_CONSENT_VERSION), version: count(row.version, 1), createdAt: instant(row.createdAt),
    removedAt: nullable(row.removedAt, instant), removeReason: nullable(row.removeReason, v => text(v)),
  };
  const removed = method.status === 'REMOVED';
  if (removed !== (method.removedAt !== null) || removed !== (method.removeReason !== null) || (removed && method.isDefault)) invalid();
  if ((expect.methodId !== undefined && method.methodId !== expect.methodId.toLowerCase())
    || (expect.billingAccountId !== undefined && method.billingAccountId !== expect.billingAccountId.toLowerCase())) invalid();
  return method;
}
export function verifySchoolPayMethodSetup(value: unknown, expect: { billingAccountId?: string } = {}): SchoolPayMethodSetup {
  const row = record(value, ['setupId', 'billingAccountId', 'connectionId', 'state', 'setupRef', 'methodKinds', 'consentTextVersion', 'expiresAt',
    'methodId', 'version', 'createdAt']);
  const setup: SchoolPayMethodSetup = {
    setupId: uuid(row.setupId), billingAccountId: uuid(row.billingAccountId), connectionId: uuid(row.connectionId),
    state: oneOf(row.state, SCHOOL_PAY_SETUP_STATES), setupRef: matching(row.setupRef, PROVIDER_REF), methodKinds: kinds(row.methodKinds),
    consentTextVersion: matching(row.consentTextVersion, SCHOOL_PAY_CONSENT_VERSION), expiresAt: instant(row.expiresAt),
    methodId: nullable(row.methodId, uuid), version: count(row.version, 1), createdAt: instant(row.createdAt),
  };
  if ((setup.state === 'COMPLETED') !== (setup.methodId !== null) || Date.parse(setup.expiresAt) <= Date.parse(setup.createdAt)
    || Date.parse(setup.expiresAt) - Date.parse(setup.createdAt) > 3_600_000) invalid();
  if (expect.billingAccountId !== undefined && setup.billingAccountId !== expect.billingAccountId.toLowerCase()) invalid();
  return setup;
}
export function verifySchoolPayPayerMethods(value: unknown, billingAccountId?: string): SchoolPayPayerMethods {
  const row = record(value, ['billingAccountId', 'canManage', 'platformFee', 'payerName', 'connections', 'methods', 'setups']);
  const payer = uuid(row.billingAccountId);
  if (billingAccountId !== undefined && payer !== billingAccountId.toLowerCase()) invalid();
  if (!Array.isArray(row.connections) || row.connections.length > 20 || !Array.isArray(row.methods) || row.methods.length > 200
    || !Array.isArray(row.setups) || row.setups.length > 20) invalid();
  const connections = row.connections.map(entry => {
    const c = record(entry, ['connectionId', 'providerCode', 'displayName', 'accountRef', 'isDefault', 'storedCard', 'bankDebit', 'customerRef']);
    if (c.storedCard !== true) invalid();
    return { connectionId: uuid(c.connectionId), providerCode: matching(c.providerCode, PROVIDER_CODE), displayName: text(c.displayName, 60), accountRef: matching(c.accountRef, /^[A-Za-z0-9_-]{3,100}$/),
      isDefault: bool(c.isDefault), storedCard: true as const, bankDebit: bool(c.bankDebit), customerRef: nullable(c.customerRef, v => matching(v, PROVIDER_REF)) };
  });
  const methods = row.methods.map(entry => verifySchoolPayMethod(entry, { billingAccountId: payer }));
  const setups = row.setups.map(entry => verifySchoolPayMethodSetup(entry, { billingAccountId: payer }));
  if (new Set(connections.map(c => c.connectionId)).size !== connections.length || connections.filter(c => c.isDefault).length > 1
    || new Set(methods.map(m => m.methodId)).size !== methods.length || methods.filter(m => m.isDefault).length > 1
    || setups.some(s => s.state === 'SUPERSEDED') || new Set(setups.map(s => s.setupId)).size !== setups.length
    || new Set(setups.filter(s => s.state === 'PENDING').map(s => s.connectionId)).size !== setups.filter(s => s.state === 'PENDING').length) invalid();
  return { billingAccountId: payer, canManage: bool(row.canManage), platformFee: oneOf(row.platformFee, ['NONE'] as const),
    payerName: text(row.payerName, 200, 0), connections, methods, setups };
}
export function verifySchoolPayExpiringMethods(value: unknown): SchoolPayExpiringMethods {
  const row = record(value, ['asOfMonth', 'methods']);
  if (!Array.isArray(row.methods) || row.methods.length > 500) invalid();
  const asOfMonth = matching(row.asOfMonth, MONTH);
  const [year, month] = asOfMonth.split('-').map(Number) as [number, number];
  const now = year * 12 + month;
  const methods = row.methods.map(entry => {
    const m = record(entry, ['methodId', 'billingAccountId', 'payerName', 'connectionId', 'brand', 'last4', 'expMonth', 'expYear', 'isDefault', 'expired']);
    const method: SchoolPayExpiringMethod = {
      methodId: uuid(m.methodId), billingAccountId: uuid(m.billingAccountId), payerName: text(m.payerName, 200, 0), connectionId: uuid(m.connectionId),
      brand: oneOf(m.brand, SCHOOL_PAY_CARD_BRANDS), last4: matching(m.last4, LAST4), expMonth: count(m.expMonth, 1, 12), expYear: count(m.expYear, 2000, 2100),
      isDefault: bool(m.isDefault), expired: bool(m.expired),
    };
    const at = method.expYear * 12 + method.expMonth;
    if (at > now + 1 || method.expired !== (at < now)) invalid();
    return method;
  });
  if (new Set(methods.map(m => m.methodId)).size !== methods.length) invalid();
  return { asOfMonth, methods };
}
export function verifySchoolPaySetupReceipt(value: unknown, expect: { billingAccountId?: string; connectionId?: string } = {}): SchoolPaySetupReceipt {
  const row = record(value, ['setup']);
  const setup = verifySchoolPayMethodSetup(row.setup, expect);
  if (setup.state !== 'PENDING' || (expect.connectionId !== undefined && setup.connectionId !== expect.connectionId.toLowerCase())) invalid();
  return { setup };
}
export function verifySchoolPayMethodReceipt(value: unknown, expect: { methodId?: string; billingAccountId?: string; status?: 'ACTIVE' | 'REMOVED' } = {}): SchoolPayMethodReceipt {
  const row = record(value, ['method']);
  const method = verifySchoolPayMethod(row.method, expect);
  if (expect.status !== undefined && method.status !== expect.status) invalid();
  return { method };
}
export function verifySchoolPayMethodRemoval(value: unknown, expect: { methodId: string; billingAccountId: string }): SchoolPayMethodRemoval {
  const row = record(value, ['method', 'providerMethodRef', 'connectionId']);
  const { method } = verifySchoolPayMethodReceipt({ method: row.method }, { ...expect, status: 'REMOVED' });
  const connectionId = uuid(row.connectionId);
  if (connectionId !== method.connectionId) invalid();
  return { method, providerMethodRef: matching(row.providerMethodRef, PROVIDER_REF), connectionId };
}

// Browser views: the API keeps the provider account, customer and setup references to itself.
export type SchoolPayMethodSetupView = Omit<SchoolPayMethodSetup, 'setupRef'>;
export type SchoolPayMethodConnectionView = Omit<SchoolPayMethodConnection, 'accountRef' | 'customerRef'> & { hasCustomer: boolean };
export interface SchoolPayPayerMethodsView extends Omit<SchoolPayPayerMethods, 'connections' | 'setups'> {
  connections: SchoolPayMethodConnectionView[]; setups: SchoolPayMethodSetupView[];
}
export interface SchoolPaySetupStartView { setup: SchoolPayMethodSetupView; setupUrl: string | null }
const HIDDEN = 'hidden';
function stripped<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Omit<T, K> {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}
/** Adds placeholders for the hidden references so the full verifier can run, after checking the browser body has none. */
function withHidden(value: unknown, keys: readonly string[], fill: Record<string, unknown>): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || keys.some(key => key in (value as object))) invalid();
  return { ...(value as object), ...fill };
}
export function schoolPaySetupForBrowser(setup: SchoolPayMethodSetup): SchoolPayMethodSetupView { return stripped(setup, ['setupRef']); }
export function schoolPayPayerMethodsForBrowser(view: SchoolPayPayerMethods): SchoolPayPayerMethodsView {
  return { ...view, connections: view.connections.map(c => ({ ...stripped(c, ['accountRef', 'customerRef']), hasCustomer: c.customerRef !== null })),
    setups: view.setups.map(schoolPaySetupForBrowser) };
}
export function verifySchoolPayMethodSetupView(value: unknown, expect: { billingAccountId?: string } = {}): SchoolPayMethodSetupView {
  return schoolPaySetupForBrowser(verifySchoolPayMethodSetup(withHidden(value, ['setupRef'], { setupRef: HIDDEN }), expect));
}
export function verifySchoolPayPayerMethodsView(value: unknown, billingAccountId?: string): SchoolPayPayerMethodsView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.connections) || !Array.isArray(row.setups)) invalid();
  const hasCustomer = row.connections.map(c => { const v = (c as Record<string, unknown> | null)?.hasCustomer; if (typeof v !== 'boolean') invalid(); return v; });
  const full = verifySchoolPayPayerMethods({ ...row,
    connections: row.connections.map((c, i) => { const { hasCustomer: _h, ...rest } = c as Record<string, unknown>;
      return withHidden(rest, ['accountRef', 'customerRef'], { accountRef: HIDDEN, customerRef: hasCustomer[i] ? HIDDEN : null }); }),
    setups: row.setups.map(s => withHidden(s, ['setupRef'], { setupRef: HIDDEN })) }, billingAccountId);
  return schoolPayPayerMethodsForBrowser(full);
}
export function verifySchoolPaySetupStartView(value: unknown, expect: { billingAccountId?: string; connectionId?: string } = {}): SchoolPaySetupStartView {
  const row = record(value, ['setup', 'setupUrl']);
  const { setup } = verifySchoolPaySetupReceipt({ setup: withHidden(row.setup, ['setupRef'], { setupRef: HIDDEN }) }, expect);
  if (row.setupUrl !== null && (typeof row.setupUrl !== 'string' || row.setupUrl.length > 4000)) invalid();
  return { setup: schoolPaySetupForBrowser(setup), setupUrl: row.setupUrl as string | null };
}
