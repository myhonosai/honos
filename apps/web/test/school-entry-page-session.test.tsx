import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ subject: 'school-a-owner', token: 'synthetic-session-a', invalid: false }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: h.token }) }) }));
vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw new Error('REDIRECT ' + path); } }));
vi.mock('@hon/auth', () => ({ HON_SESSION_COOKIE: 'hon_session', sessionConfig: () => ({}), verifySession: () => { if (h.invalid) throw new Error('expired'); return { externalSubject: h.subject }; } }));
import Page from '../src/app/staff/entry/page';
import { SchoolEntry } from '../src/components/school-entry/workbench';
afterEach(() => { h.subject = 'school-a-owner'; h.token = 'synthetic-session-a'; h.invalid = false; vi.restoreAllMocks(); });
it('server entry passes verified identity continuity only and performs no domain read while rendering', async () => {
  const f = vi.spyOn(globalThis, 'fetch'), page = await Page(); expect(page.type).toBe(SchoolEntry);
  expect(page.props).toEqual({ sessionSubject: 'school-a-owner' }); expect(String(page.key)).not.toContain(h.token); expect(f).not.toHaveBeenCalled();
});
it('invalid signed sessions fail closed before any private component is rendered', async () => { h.invalid = true; await expect(Page()).rejects.toThrow('REDIRECT /auth/login'); });
it('a new session receives a fresh mounted entry lifetime instead of reusing school A memory', async () => {
  const a = await Page(); h.token = 'synthetic-session-b'; h.subject = 'school-b-owner'; const b = await Page() as React.ReactElement<{ sessionSubject: string }>;
  expect(a.key).not.toEqual(b.key); expect(b.props.sessionSubject).toBe('school-b-owner'); expect(b.props).not.toHaveProperty('schoolId');
});
