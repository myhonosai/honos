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
  const f = vi.spyOn(globalThis, 'fetch'); const result = await Page() as React.ReactElement<{ sessionSubject: string; acceptance?: boolean }>; expect(result.type).toBe(StaffInvitations); expect(result.props.sessionSubject).toBe('staff-a');
  expect(result.props).not.toHaveProperty('organizationId'); expect(result.props).not.toHaveProperty('schoolId'); expect(String(result.key)).not.toContain(h.token); expect(f).not.toHaveBeenCalled();
});
it.each([ManagePage, AcceptPage])('an expired session redirects before rendering protected components', async Page => {
  h.invalid = true; await expect(Page()).rejects.toThrow('REDIRECT /auth/login');
});
it.each([ManagePage, AcceptPage])('a new authenticated document gets a new private component lifetime', async Page => {
  const a = await Page(); h.token = 'synthetic-b'; h.subject = 'staff-b'; const b = await Page() as React.ReactElement<{ sessionSubject: string }>; expect(b.key).not.toBe(a.key); expect(b.props.sessionSubject).toBe('staff-b');
});
