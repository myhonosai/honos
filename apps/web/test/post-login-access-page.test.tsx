import React, { type ReactElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
const session = vi.hoisted(() => ({ require: vi.fn() }));
vi.mock('../src/server/require-web-session', () => ({ requireVerifiedWebSession: session.require }));
import AccessPage from '../src/app/auth/access/page';
type El = ReactElement<Record<string, unknown>>;
const nodes = (v: unknown): El[] => Array.isArray(v) ? v.flatMap(nodes) : React.isValidElement(v) ? [v as El, ...nodes((v as El).props.children)] : [];
const text = (v: unknown): string => Array.isArray(v) ? v.map(text).join('') : React.isValidElement(v) ? text((v as El).props.children) : typeof v === 'string' ? v : '';
afterEach(() => { vi.clearAllMocks(); });
it('requires a verified session and offers ordinary independently authorized workspace links without a missing-role assertion', async () => {
  session.require.mockResolvedValue(undefined);
  const fetcher = vi.spyOn(globalThis, 'fetch');
  const page = await AccessPage(); expect(session.require).toHaveBeenCalledTimes(1);
  expect(text(page)).toContain('Access not verified'); expect(text(page)).toContain('This does not establish that your account has no access.');
  expect(nodes(page).filter(e => e.type === 'a').map(e => e.props.href)).toEqual(['/hq','/staff/dashboard','/parent','/auth/continue','/auth/login']);
  expect(fetcher).not.toHaveBeenCalled(); fetcher.mockRestore();
});
it('does not render a neutral workspace page when the session guard redirects', async () => {
  session.require.mockRejectedValue(new Error('SIGN_IN_REDIRECT'));
  await expect(AccessPage()).rejects.toThrow('SIGN_IN_REDIRECT');
});
