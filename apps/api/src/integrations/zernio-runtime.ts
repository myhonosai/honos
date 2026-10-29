import type { ZernioConfiguration, ZernioVerificationState } from '@hon/contracts';

export const ZERNIO_RUNTIME = Symbol('ZERNIO_RUNTIME');
const endpoint = 'https://zernio.com/api/v1/auth/verify';
const keyFormat = /^(?:sk_|zrk_)[a-fA-F0-9]{64}$/;
export interface ZernioReadRuntime {
  configuration(): ZernioConfiguration;
  verifyCredential(): Promise<ZernioVerificationState>;
}

/** The only implemented provider operation is an explicitly gated credential GET. No generic request method. */
export class ZernioCredentialRuntime implements ZernioReadRuntime {
  constructor(private readonly environment = () => process.env,
    private readonly send: typeof fetch = (...args) => fetch(...args)) {}

  configuration(): ZernioConfiguration {
    const env = this.environment(), key = env.ZERNIO_API_KEY;
    const credential = !key ? 'MISSING' : keyFormat.test(key) ? 'PRESENT' : 'INVALID';
    return Object.freeze({ provider: 'ZERNIO', credential, secretStorage: 'API_SERVER_ENVIRONMENT',
      verificationEnabled: credential === 'PRESENT' && env.HON_ZERNIO_VERIFICATION_APPROVED === 'true',
      externalActions: 'DISABLED', schoolConnections: 'NOT_CONFIGURED' });
  }

  async verifyCredential(): Promise<ZernioVerificationState> {
    if (!this.configuration().verificationEnabled) return 'UNAVAILABLE';
    const key = this.environment().ZERNIO_API_KEY;
    if (!key || !keyFormat.test(key) || this.environment().HON_ZERNIO_VERIFICATION_APPROVED !== 'true') return 'UNAVAILABLE';
    const finish = (state: ZernioVerificationState): ZernioVerificationState =>
      this.environment().ZERNIO_API_KEY === key && this.environment().HON_ZERNIO_VERIFICATION_APPROVED === 'true' ? state : 'UNKNOWN';
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 8000);
    try {
      const response = await this.send(endpoint, { method: 'GET', redirect: 'error',
        credentials: 'omit', referrerPolicy: 'no-referrer', signal: abort.signal,
        headers: { Accept: 'application/json', Authorization: `Bearer ${key}` } });
      if (response.status !== 200) {
        await response.body?.cancel();
        if (response.status === 401) return finish('REJECTED');
        if (response.status === 403) return finish('DENIED');
        if (response.status === 429) return finish('RATE_LIMITED');
        return finish('UNAVAILABLE');
      }
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel(); return 'UNKNOWN';
      }
      const reader = response.body?.getReader();
      if (!reader) return 'UNKNOWN';
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          length += value.byteLength;
          if (length > 8192) { await reader.cancel(); return 'UNKNOWN'; }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      // Drop name/email/userId/scope and every other upstream field. Validity is not a grant to act.
      if (!value || typeof value !== 'object' || Array.isArray(value)) return 'UNKNOWN';
      const valid = (value as Record<string, unknown>).valid;
      return finish(valid === true ? 'VALID' : valid === false ? 'REJECTED' : 'UNKNOWN');
    } catch { return 'UNKNOWN'; } // Never propagate provider bodies, request headers, token or raw errors.
    finally { clearTimeout(timer); }
  }
}
