import React from 'react';
import { expect, it, vi } from 'vitest';
const session = vi.hoisted(() => ({ require: vi.fn<() => Promise<{ externalSubject: string; viewKey: string }>>() }));
vi.mock('../src/server/require-web-session', () => ({ requireVerifiedWebSession: session.require }));
import StaffLayout from '../src/app/staff/layout';
import { SchoolShell } from '../src/components/school-shell/shell';

it('renders nothing without a verified session, then wraps the exact page in the school shell', async () => {
  const child = React.createElement('p', null, 'private');
  session.require.mockRejectedValueOnce(new Error('redirect:/auth/login'));
  await expect(StaffLayout({ children: child })).rejects.toThrow('redirect:/auth/login');
  session.require.mockResolvedValueOnce({ externalSubject: 'synthetic-staff', viewKey: 'a'.repeat(64) });
  const shell = await StaffLayout({ children: child }) as React.ReactElement<{ sessionSubject: string; children: unknown }>;
  expect(shell.type).toBe(SchoolShell);
  expect(shell.props).toEqual({ sessionSubject: 'synthetic-staff', children: child });
  expect(shell.key).toBe('a'.repeat(64));
});

it('a different session gets a fresh shell lifetime, so no school memory crosses sessions', async () => {
  session.require.mockResolvedValueOnce({ externalSubject: 'one', viewKey: '1'.repeat(64) }).mockResolvedValueOnce({ externalSubject: 'two', viewKey: '2'.repeat(64) });
  const a = await StaffLayout({ children: null }) as React.ReactElement, b = await StaffLayout({ children: null }) as React.ReactElement;
  expect(a.key).not.toBe(b.key);
});
