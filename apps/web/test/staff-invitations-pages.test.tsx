import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ token: 'synthetic-a', subject: 'staff-a', invalid: false }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: h.token }) }) }));
vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw new Error('REDIRECT ' + path); } }));
vi.mock('@hon/auth', () => ({ HON_SESSION_COOKIE: 'hon_session', sessionConfig: () => ({}), verifySession: () => { if (h.invalid) throw Error('invalid'); return { externalSubject: h.subject }; } }));
import ManagePage from '../src/app/staff/team/invitations/page';
import AcceptPage from '../src/app/account/staff-invitation/page';
import { StaffInvitations } from '../src/components/staff-invitations/workbench';
afterEach(() => { h.token = 'synthetic-a'; h.subject = 'staff-a'; h.invalid = false; vi.restoreAllMocks(); });
it.each([ManagePage, AcceptPage])('gates the page and passes identity continuity only without domain reads', async Page => {
  const f = vi.spyOn(globalThis, 'fetch'); const result = await Page({}) as React.ReactElement<{ sessionSubject: string; acceptance?: boolean }>; expect(result.type).toBe(StaffInvitations); expect(result.props.sessionSubject).toBe('staff-a');
  expect(result.props).not.toHaveProperty('organizationId'); expect(result.props).not.toHaveProperty('schoolId'); expect(String(result.key)).not.toContain(h.token); expect(f).not.toHaveBeenCalled();
});
it.each([ManagePage, AcceptPage])('an expired session redirects before rendering protected components', async Page => {
  h.invalid = true; await expect(Page({})).rejects.toThrow('REDIRECT /auth/login');
});
it.each([ManagePage, AcceptPage])('a new authenticated document gets a new private component lifetime', async Page => {
  const a = await Page({}); h.token = 'synthetic-b'; h.subject = 'staff-b'; const b = await Page({}) as React.ReactElement<{ sessionSubject: string }>; expect(b.key).not.toBe(a.key); expect(b.props.sessionSubject).toBe('staff-b');
});
const organizationId = '00000000-0000-4000-8000-000000000001', schoolId = '00000000-0000-4000-8000-000000000002';
it('passes only an inert complete school selector pair without reading records or changing the identity lifetime', async () => {
  const f = vi.spyOn(globalThis, 'fetch'), idle = await ManagePage({});
  const selected = await ManagePage({ searchParams: Promise.resolve({ organizationId, schoolId }) }) as React.ReactElement<Record<string, unknown>>;
  expect(selected.props).toEqual({ sessionSubject: 'staff-a', initialOrganizationId: organizationId, initialSchoolId: schoolId });
  expect(selected.key).toBe(idle.key); expect(f).not.toHaveBeenCalled();
});
it.each([
  { organizationId }, { organizationId, schoolId: 'school' }, { organizationId, schoolId: [schoolId, schoolId] },
  { organizationId, schoolId, roleId: schoolId }, { organizationId, schoolId, token: 'private' },
])('does not pass partial, duplicate, malformed or expanded query selectors: %j', async query => {
  const f = vi.spyOn(globalThis, 'fetch');
  const selected = await ManagePage({ searchParams: Promise.resolve(query) }) as React.ReactElement<Record<string, unknown>>;
  expect(selected.props).toEqual({ sessionSubject: 'staff-a' }); expect(f).not.toHaveBeenCalled();
});
