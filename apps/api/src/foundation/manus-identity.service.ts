// Compatibility export for downstream imports. API authentication is provider-neutral and HON-only.
export { HonIdentityService as ManusIdentityService } from './hon-identity.service.js';
export type { AuthenticatedIdentity, HonRequest } from './hon-identity.service.js';
