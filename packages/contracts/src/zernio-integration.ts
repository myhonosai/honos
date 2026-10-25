export const ZERNIO_VERIFY_CONFIRMATION = 'VERIFY_ZERNIO_CREDENTIAL' as const;
export const ZERNIO_CREDENTIAL_STATES = ['MISSING', 'PRESENT', 'INVALID'] as const;
export const ZERNIO_VERIFICATION_STATES = ['VALID', 'REJECTED', 'DENIED', 'RATE_LIMITED', 'UNKNOWN', 'UNAVAILABLE'] as const;
export type ZernioVerificationState = typeof ZERNIO_VERIFICATION_STATES[number];
export interface ZernioConfiguration {
  readonly provider: 'ZERNIO';
  readonly credential: typeof ZERNIO_CREDENTIAL_STATES[number];
  readonly secretStorage: 'API_SERVER_ENVIRONMENT';
  readonly verificationEnabled: boolean;
  readonly externalActions: 'DISABLED';
  readonly schoolConnections: 'NOT_CONFIGURED';
}
export interface ZernioVerification {
  readonly provider: 'ZERNIO';
  readonly status: ZernioVerificationState;
  readonly checkedAt: string;
  readonly externalActions: 'DISABLED';
}
function invalid(): never { throw new Error('INVALID_ZERNIO_CONTRACT'); }
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return invalid();
  return value as Record<string, unknown>;
}
export function validateZernioConfirmation(value: unknown): void {
  if (closed(value, ['confirmation']).confirmation !== ZERNIO_VERIFY_CONFIRMATION) invalid();
}
export function validateZernioConfiguration(value: unknown): ZernioConfiguration {
  const v = closed(value, ['provider', 'credential', 'secretStorage', 'verificationEnabled', 'externalActions', 'schoolConnections']);
  if (v.provider !== 'ZERNIO' || !ZERNIO_CREDENTIAL_STATES.includes(v.credential as ZernioConfiguration['credential'])
    || v.secretStorage !== 'API_SERVER_ENVIRONMENT' || typeof v.verificationEnabled !== 'boolean'
    || v.verificationEnabled && v.credential !== 'PRESENT'
    || v.externalActions !== 'DISABLED' || v.schoolConnections !== 'NOT_CONFIGURED') return invalid();
  return Object.freeze({ provider: 'ZERNIO', credential: v.credential as ZernioConfiguration['credential'],
    secretStorage: 'API_SERVER_ENVIRONMENT', verificationEnabled: v.verificationEnabled,
    externalActions: 'DISABLED', schoolConnections: 'NOT_CONFIGURED' });
}
export function validateZernioVerification(value: unknown): ZernioVerification {
  const v = closed(value, ['provider', 'status', 'checkedAt', 'externalActions']);
  if (v.provider !== 'ZERNIO' || !ZERNIO_VERIFICATION_STATES.includes(v.status as ZernioVerificationState)
    || v.externalActions !== 'DISABLED' || typeof v.checkedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.checkedAt)
    || !Number.isFinite(Date.parse(v.checkedAt)) || new Date(v.checkedAt).toISOString() !== v.checkedAt) return invalid();
  return Object.freeze({ provider: 'ZERNIO', status: v.status as ZernioVerificationState,
    checkedAt: v.checkedAt, externalActions: 'DISABLED' });
}
