import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { issueSession, SESSION_SECONDS } from '@hon/auth';
import CrmLeadsPage from '../src/app/staff/crm/leads/page';

const browser = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => browser.token === undefined ? undefined : { value: browser.token } }) }));
vi.mock('next/navigation', () => ({ redirect: (path: string): never => { throw new Error(`Redirect:${path}`); } }));
const config = { mode: 'OIDC' as const, audience: 'crm-page-session-proof', secret: 'synthetic-crm-page-session-secret-123456789' };
const page = () => CrmLeadsPage({ searchParams: Promise.resolve({ organizationId: 'untrusted-org', schoolId: 'untrusted-school' }) });
beforeEach(() => {
  browser.token = undefined;
  vi.stubEnv('HON_AUTH_MODE', config.mode); vi.stubEnv('HON_SESSION_AUDIENCE', config.audience); vi.stubEnv('HON_SESSION_JWT_SECRET', config.secret);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it.each(['missing', 'invalid', 'expired', 'wrong-signature', 'unconfigured'])('fails closed to sign-in after a %s page session, including expiration after the layout gate', async kind => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  browser.token = kind === 'missing' ? undefined : kind === 'invalid' ? 'invalid-session'
    : issueSession({ externalSubject: 'synthetic-staff' }, kind === 'wrong-signature' ? { ...config, secret: 'another-synthetic-session-secret-123456789' } : config,
      kind === 'expired' ? Math.floor(Date.now() / 1000) - SESSION_SECONDS - 1 : Math.floor(Date.now() / 1000));
  if (kind === 'unconfigured') vi.stubEnv('HON_SESSION_JWT_SECRET', '');
  await expect(page()).rejects.toThrow('Redirect:/auth/login');
  expect(fetcher).not.toHaveBeenCalled();
});
it('renders only a verified subject and an opaque session key, without treating school selectors as authority', async () => {
  browser.token = issueSession({ externalSubject: 'synthetic-staff' }, config);
  const result = await page();
  expect(result.props.sessionSubject).toBe('synthetic-staff');
  expect(result.props.initialScope).toEqual({ organizationId: 'untrusted-org', schoolId: 'untrusted-school' });
  expect(JSON.stringify(result)).not.toContain(browser.token);
});
