import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { issueSession, SESSION_SECONDS } from '@hon/auth';
import Page from '../src/app/staff/billing/memberships/page';
const state = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => state.token ? { value: state.token } : undefined }) }));
vi.mock('next/navigation', () => ({ redirect: (path: string): never => { throw new Error(`Redirect:${path}`); } }));
const config = { mode: 'OIDC' as const, audience: 'e1a-page-proof', secret: 'synthetic-e1a-session-secret-123456789' };
beforeEach(() => { state.token = undefined; vi.stubEnv('HON_AUTH_MODE', config.mode); vi.stubEnv('HON_SESSION_AUDIENCE', config.audience); vi.stubEnv('HON_SESSION_JWT_SECRET', config.secret); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it.each(['missing', 'invalid', 'expired', 'wrong-signature', 'unconfigured'])('fails closed for a %s activation page session', async kind => {
  state.token = kind === 'missing' ? undefined : kind === 'invalid' ? 'invalid-session' : issueSession({ externalSubject: 'synthetic' }, kind === 'wrong-signature' ? { ...config, secret: 'another-synthetic-session-secret-123456789' } : config, kind === 'expired' ? Math.floor(Date.now() / 1000) - SESSION_SECONDS - 1 : undefined);
  if (kind === 'unconfigured') vi.stubEnv('HON_SESSION_JWT_SECRET', '');
  await expect(Page()).rejects.toThrow('Redirect:/auth/login');
});
it('passes verified identity continuity and remounts memory after a changed session without exposing its cookie', async () => {
  state.token = issueSession({ externalSubject: 'synthetic' }, config); const result = await Page();
  expect(result).toMatchObject({ props: { sessionSubject: 'synthetic' } }); expect(result.key).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(result)).not.toContain(state.token);
});
