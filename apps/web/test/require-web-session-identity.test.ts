import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ token: 'synthetic-token' as string | undefined, invalid: false }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => (h.token === undefined ? undefined : { value: h.token }) }) }));
vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw new Error('REDIRECT ' + path); } }));
vi.mock('@hon/auth', () => ({ HON_SESSION_COOKIE: 'hon_session', sessionConfig: () => ({}), verifySession: () => { if (h.invalid) throw new Error('bad'); return { externalSubject: 'synthetic-subject' }; } }));
import { requireVerifiedWebSession } from '../src/server/require-web-session';
afterEach(() => { h.token = 'synthetic-token'; h.invalid = false; });

it('returns only the verified subject and an opaque view key that never contains the token', async () => {
  const identity = await requireVerifiedWebSession();
  expect(identity).toEqual({ externalSubject: 'synthetic-subject', viewKey: createHash('sha256').update('synthetic-token').digest('hex') });
  expect(JSON.stringify(identity)).not.toContain('synthetic-token');
});
it('fails closed for a missing or invalid session', async () => {
  h.token = undefined; await expect(requireVerifiedWebSession()).rejects.toThrow('REDIRECT /auth/login');
  h.token = 'x'; h.invalid = true; await expect(requireVerifiedWebSession()).rejects.toThrow('REDIRECT /auth/login');
});
