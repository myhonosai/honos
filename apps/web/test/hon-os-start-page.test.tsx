import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ token: 'synthetic-a', subject: 'oidc:new-owner-a', invalid: false }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: h.token }) }) }));
vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw new Error('REDIRECT ' + path); } }));
vi.mock('@hon/auth', () => ({ HON_SESSION_COOKIE: 'hon_session', sessionConfig: () => ({}), verifySession: () => { if (h.invalid) throw Error('invalid'); return { externalSubject: h.subject }; } }));
import StartPage, { metadata } from '../src/app/account/start/page';
import { HonOsStart } from '../src/components/hon-os-start/workbench';
afterEach(() => { h.token = 'synthetic-a'; h.subject = 'oidc:new-owner-a'; h.invalid = false; vi.restoreAllMocks(); });
it('gates the page on a signed session and passes identity continuity only, without reads', async () => {
  const f = vi.spyOn(globalThis, 'fetch'); const page = await StartPage() as React.ReactElement<Record<string, unknown>>;
  expect(page.type).toBe(HonOsStart); expect(page.props).toEqual({ sessionSubject: 'oidc:new-owner-a' }); expect(String(page.key)).not.toContain(h.token); expect(f).not.toHaveBeenCalled();
  expect(metadata.robots).toEqual({ index: false, follow: false }); expect(metadata.referrer).toBe('no-referrer');
});
it('a missing or expired session goes to sign-in before anything renders', async () => { h.invalid = true; await expect(StartPage()).rejects.toThrow('REDIRECT /auth/login'); });
it('a new signed session gets a new private page lifetime', async () => {
  const a = await StartPage(); h.token = 'synthetic-b'; h.subject = 'oidc:new-owner-b'; const b = await StartPage() as React.ReactElement<{ sessionSubject: string }>;
  expect(b.key).not.toBe(a.key); expect(b.props.sessionSubject).toBe('oidc:new-owner-b');
});
