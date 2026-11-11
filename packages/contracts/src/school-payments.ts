/**
 * B-TUI-2 piece 1 (0258): the school's own payment processor connections (Stripe, Square; HON's own processor later),
 * TEST mode only. HON takes no fee on any payment a school collects, and nothing here charges, refunds or stores a card.
 */
export const SCHOOL_PAY_PROVIDER_CODES = ['STRIPE_CONNECT', 'SQUARE'] as const;
export type SchoolPayProviderCode = (typeof SCHOOL_PAY_PROVIDER_CODES)[number];
export const SCHOOL_PAY_CONNECTION_STATES = [
  'PENDING_ONBOARDING', 'CONNECTED_RESTRICTED', 'CONNECTED_ACTIVE', 'REAUTHORIZATION_REQUIRED', 'DISCONNECTED', 'ABANDONED',
] as const;
export type SchoolPayConnectionState = (typeof SCHOOL_PAY_CONNECTION_STATES)[number];
export const SCHOOL_PAY_CAPABILITY_KEYS = ['bankDebit', 'offSessionRecurring', 'oneTimeCard', 'refunds', 'storedCard'] as const;
export type SchoolPayCapabilityKey = (typeof SCHOOL_PAY_CAPABILITY_KEYS)[number];
export type SchoolPayCapabilities = Record<SchoolPayCapabilityKey, boolean>;

/** One authenticated provider status retrieval, as the adapter reports it. The database derives the state from it. */
export interface SchoolPayObservation {
  accountRef: string; chargesEnabled: boolean; payoutsEnabled: boolean; requirementsDue: boolean; reauthorizationRequired: boolean;
  capabilities: SchoolPayCapabilities;
}
export interface SchoolPayProvider { providerCode: string; displayName: string; testSupported: boolean; liveAllowed: false }
export interface SchoolPayConnection {
  connectionId: string; providerCode: string; mode: 'TEST'; state: SchoolPayConnectionState; accountRef: string | null;
  chargesEnabled: boolean; payoutsEnabled: boolean; requirementsDue: boolean; capabilities: SchoolPayCapabilities; isDefault: boolean;
  onboardingPending: boolean; version: number; statusObservedAt: string | null; startedAt: string; endedAt: string | null; endReason: string | null;
}
export interface SchoolPaymentProcessors {
  canManage: boolean; platformFee: 'NONE'; providers: SchoolPayProvider[]; connections: SchoolPayConnection[];
}
export interface SchoolPayConnectionReceipt { connection: SchoolPayConnection }

export interface StartSchoolPayConnectionInput { providerCode: SchoolPayProviderCode }
export interface SchoolPayVersionInput { expectedVersion: number }
export interface FinishSchoolPayOnboardingInput { expectedVersion: number; state: string; authorizationCode?: string }
export interface DisconnectSchoolPayInput { expectedVersion: number; reason: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ACCOUNT_REF = /^[A-Za-z0-9_-]{3,100}$/;
const PROVIDER_CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
/** The one-time onboarding state HON puts in the provider return URL. */
export const SCHOOL_PAY_ONBOARDING_STATE = /^[A-Za-z0-9_-]{32,128}$/;
const AUTHORIZATION_CODE = /^[A-Za-z0-9_.-]{1,512}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const ENDED: readonly SchoolPayConnectionState[] = ['DISCONNECTED', 'ABANDONED'];

function invalid(): never { throw new Error('Invalid school payment data.'); }
function record(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !keys.includes(key) && !optional.includes(key)) || keys.some(key => !(key in row))) invalid();
  return row;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value; }
function count(value: unknown, minimum: number, maximum = 999_999_999): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
function instant(value: unknown): string {
  if (typeof value !== 'string' || !INSTANT.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}
function text(value: unknown, maximum = 1000): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || value.trim() !== value || CONTROL.test(value)) invalid();
  return value;
}
function matching(value: unknown, pattern: RegExp): string { if (typeof value !== 'string' || !pattern.test(value)) invalid(); return value; }
function nullable<T>(value: unknown, read: (value: unknown) => T): T | null { return value === null ? null : read(value); }
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T { if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(); return value as T; }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }

export function verifySchoolPayCapabilities(value: unknown): SchoolPayCapabilities {
  const row = record(value, SCHOOL_PAY_CAPABILITY_KEYS);
  return Object.fromEntries(SCHOOL_PAY_CAPABILITY_KEYS.map(key => [key, bool(row[key])])) as SchoolPayCapabilities;
}
export const NO_SCHOOL_PAY_CAPABILITIES: SchoolPayCapabilities = Object.freeze({
  bankDebit: false, offSessionRecurring: false, oneTimeCard: false, refunds: false, storedCard: false,
});
/** The capabilities a connection may use: the adapter's static manifest narrowed by what the provider reports. */
export function narrowSchoolPayCapabilities(manifest: SchoolPayCapabilities, reported: SchoolPayCapabilities): SchoolPayCapabilities {
  return Object.fromEntries(SCHOOL_PAY_CAPABILITY_KEYS.map(key => [key, manifest[key] && reported[key]])) as SchoolPayCapabilities;
}
export function verifySchoolPayObservation(value: unknown): SchoolPayObservation {
  const row = record(value, ['accountRef', 'chargesEnabled', 'payoutsEnabled', 'requirementsDue', 'reauthorizationRequired', 'capabilities']);
  return {
    accountRef: matching(row.accountRef, ACCOUNT_REF), chargesEnabled: bool(row.chargesEnabled), payoutsEnabled: bool(row.payoutsEnabled),
    requirementsDue: bool(row.requirementsDue), reauthorizationRequired: bool(row.reauthorizationRequired),
    capabilities: verifySchoolPayCapabilities(row.capabilities),
  };
}

// Input validators (the database validates the same rules again).
export function validateStartSchoolPayConnectionInput(value: unknown): StartSchoolPayConnectionInput {
  const row = record(value, ['providerCode']);
  return { providerCode: oneOf(row.providerCode, SCHOOL_PAY_PROVIDER_CODES) };
}
export function validateSchoolPayVersionInput(value: unknown): SchoolPayVersionInput {
  const row = record(value, ['expectedVersion']);
  return { expectedVersion: count(row.expectedVersion, 1) };
}
export function validateFinishSchoolPayOnboardingInput(value: unknown): FinishSchoolPayOnboardingInput {
  const row = record(value, ['expectedVersion', 'state'], ['authorizationCode']);
  const input: FinishSchoolPayOnboardingInput = { expectedVersion: count(row.expectedVersion, 1), state: matching(row.state, SCHOOL_PAY_ONBOARDING_STATE) };
  if ('authorizationCode' in row) input.authorizationCode = matching(row.authorizationCode, AUTHORIZATION_CODE);
  return input;
}
export function validateDisconnectSchoolPayInput(value: unknown): DisconnectSchoolPayInput {
  const row = record(value, ['expectedVersion', 'reason']);
  return { expectedVersion: count(row.expectedVersion, 1), reason: text(row.reason) };
}

// Output verifiers: every database response is checked strictly before it reaches a client.
export function verifySchoolPayConnection(value: unknown, connectionId?: string): SchoolPayConnection {
  const row = record(value, ['connectionId', 'providerCode', 'mode', 'state', 'accountRef', 'chargesEnabled', 'payoutsEnabled', 'requirementsDue',
    'capabilities', 'isDefault', 'onboardingPending', 'version', 'statusObservedAt', 'startedAt', 'endedAt', 'endReason']);
  const connection: SchoolPayConnection = {
    connectionId: uuid(row.connectionId), providerCode: matching(row.providerCode, PROVIDER_CODE), mode: oneOf(row.mode, ['TEST'] as const),
    state: oneOf(row.state, SCHOOL_PAY_CONNECTION_STATES), accountRef: nullable(row.accountRef, v => matching(v, ACCOUNT_REF)),
    chargesEnabled: bool(row.chargesEnabled), payoutsEnabled: bool(row.payoutsEnabled), requirementsDue: bool(row.requirementsDue),
    capabilities: verifySchoolPayCapabilities(row.capabilities), isDefault: bool(row.isDefault), onboardingPending: bool(row.onboardingPending),
    version: count(row.version, 1), statusObservedAt: nullable(row.statusObservedAt, instant), startedAt: instant(row.startedAt),
    endedAt: nullable(row.endedAt, instant), endReason: nullable(row.endReason, v => text(v)),
  };
  const ended = ENDED.includes(connection.state);
  const usable = connection.state === 'CONNECTED_ACTIVE';
  if (ended !== (connection.endedAt !== null) || ended !== (connection.endReason !== null)
    || (connection.isDefault && !usable) || (connection.onboardingPending && connection.state !== 'PENDING_ONBOARDING')
    || (!usable && SCHOOL_PAY_CAPABILITY_KEYS.some(key => connection.capabilities[key]))
    || (!['PENDING_ONBOARDING', 'ABANDONED'].includes(connection.state) && connection.accountRef === null)) invalid();
  if (connectionId !== undefined && connection.connectionId !== connectionId.toLowerCase()) invalid();
  return connection;
}
export function verifySchoolPayConnectionReceipt(value: unknown, expect: { connectionId?: string; providerCode?: string; states?: readonly SchoolPayConnectionState[] } = {}): SchoolPayConnectionReceipt {
  const row = record(value, ['connection']);
  const connection = verifySchoolPayConnection(row.connection, expect.connectionId);
  if ((expect.providerCode !== undefined && connection.providerCode !== expect.providerCode)
    || (expect.states !== undefined && !expect.states.includes(connection.state))) invalid();
  return { connection };
}
export function verifySchoolPaymentProcessors(value: unknown): SchoolPaymentProcessors {
  const row = record(value, ['canManage', 'platformFee', 'providers', 'connections']);
  if (!Array.isArray(row.providers) || row.providers.length > 20 || !Array.isArray(row.connections) || row.connections.length > 100) invalid();
  const providers = row.providers.map(entry => {
    const p = record(entry, ['providerCode', 'displayName', 'testSupported', 'liveAllowed']);
    if (p.liveAllowed !== false) invalid();
    return { providerCode: matching(p.providerCode, PROVIDER_CODE), displayName: text(p.displayName, 60), testSupported: bool(p.testSupported), liveAllowed: false as const };
  });
  const connections = row.connections.map(entry => verifySchoolPayConnection(entry));
  const codes = new Set(providers.map(p => p.providerCode));
  const open = connections.filter(c => !ENDED.includes(c.state));
  if (codes.size !== providers.length || new Set(connections.map(c => c.connectionId)).size !== connections.length
    || connections.some(c => !codes.has(c.providerCode)) || new Set(open.map(c => c.providerCode)).size !== open.length
    || connections.filter(c => c.isDefault).length > 1) invalid();
  return { canManage: bool(row.canManage), platformFee: oneOf(row.platformFee, ['NONE'] as const), providers, connections };
}
