import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ token: 'synthetic-a', subject: 'owner-a', invalid: false }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: h.token }) }) }));
vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw Error('REDIRECT ' + path); } }));
vi.mock('@hon/auth', () => ({ HON_SESSION_COOKIE: 'hon_session', sessionConfig: () => ({}), verifySession: () => { if (h.invalid) throw Error('expired'); return { externalSubject: h.subject }; } }));
import Page from '../src/app/staff/account-status/page';
import { SchoolAccountStatus } from '../src/components/account-status/workbench';
import { scope } from './account-status-fixtures';
afterEach(() => { h.token = 'synthetic-a'; h.subject = 'owner-a'; h.invalid = false; vi.restoreAllMocks(); });
it('uses only the signed session gate and passes inert school-only or checked-pair selectors without reads', async () => {
  const f = vi.spyOn(globalThis, 'fetch'), idle = await Page({}); expect(idle.type).toBe(SchoolAccountStatus);
  const school = await Page({ searchParams: Promise.resolve({ schoolId: scope.schoolId }) }) as React.ReactElement<Record<string, unknown>>;
  expect(school.props).toEqual({ sessionSubject: 'owner-a', initialSchoolId: scope.schoolId }); expect(school.key).toBe(idle.key);
  const pair = await Page({ searchParams: Promise.resolve(scope) }) as React.ReactElement<Record<string, unknown>>;
  expect(pair.props).toEqual({ sessionSubject: 'owner-a', initialSchoolId: scope.schoolId, initialOrganizationId: scope.organizationId }); expect(f).not.toHaveBeenCalled();
});
it.each([{ organizationId: scope.organizationId }, { schoolId: [scope.schoolId] }, { ...scope, token: 'secret' }])('rejects invalid or expanded query selectors %j', async query => {
  const page = await Page({ searchParams: Promise.resolve(query) }) as React.ReactElement<Record<string, unknown>>; expect(page.props).toEqual({ sessionSubject: 'owner-a' });
});
it('redirects an expired session before rendering and changes lifetime only for a new session', async () => {
  const first = await Page({}); h.token = 'synthetic-b'; const second = await Page({}); expect(second.key).not.toBe(first.key); h.invalid = true;
  await expect(Page({ searchParams: Promise.resolve(scope) })).rejects.toThrow('REDIRECT /auth/login');
});
