import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { OwnerLaunch } from '../src/components/owner-launch';
import { loadInterfaceThemePreference, interfaceThemePreferencePath, saveInterfaceThemePreference } from '../src/components/interface-theme-preference';
import { postOwnerLaunch } from '../src/components/owner-launch-http';
import type { OwnerLaunchProjection } from '@hon/contracts';

const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const scope = { organizationId: id('1'), schoolId: id('2') };
const preference = { interfaceTheme: 'classic' as const, selectedVia: 'ONBOARDING' as const, updatedAt: '2026-10-16T00:00:00.000Z' };
const response = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data, meta: {} }) }) as Response;
const projection: OwnerLaunchProjection = { organizationId: scope.organizationId, schoolId: scope.schoolId, schoolName: 'Local', tier: 'ESSENTIAL', program: { id: id('3'), version: 1, status: 'DRAFT' }, classSession: { id: id('4'), programId: id('3'), version: 1, status: 'SCHEDULED' }, registration: null, guardianChildRegistration: null };
const studentInput = { programId: id('3'), expectedProgramVersion: 1, classSessionId: id('4'), expectedClassSessionVersion: 1, givenName: 'Adult', familyName: 'Student', birthDate: '1990-02-03', attestation: 'NEW_ADULT_NO_GUARDIAN_REQUIRED' };
const studentReceipt = { registrationId: id('5'), studentProfileId: id('6'), enrollmentId: id('7'), programId: id('3'), classSessionId: id('4'), status: 'REGISTERED_NO_BOOKING' as const, createdAt: '2026-10-16T00:00:00.000Z' };

describe('owner launch interface mode selection', () => {
  it('uses the existing fixed current-user preference transport with no selector, tier, role, feature, or authority input', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({ interfaceTheme: 'modern', selectedVia: 'DEFAULT' })).mockResolvedValueOnce(response(preference));
    try {
      expect(await loadInterfaceThemePreference(scope)).toEqual({ interfaceTheme: 'modern', selectedVia: 'DEFAULT' });
      expect(await saveInterfaceThemePreference(scope, 'classic', id('8'))).toEqual(preference);
      const path = `/api/v1/organizations/${id('1')}/schools/${id('2')}/interface-theme`;
      expect(fetch.mock.calls[0]).toEqual([path, { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' }]);
      expect(fetch.mock.calls[1]).toEqual([path, { method: 'PUT', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': id('8') }, body: JSON.stringify({ interfaceTheme: 'classic', selectedVia: 'ONBOARDING' }), credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' }]);
    } finally { fetch.mockRestore(); }
    expect(interfaceThemePreferencePath(scope)).toBe(`/api/v1/organizations/${id('1')}/schools/${id('2')}/interface-theme`);
    const blocked = vi.spyOn(globalThis, 'fetch');
    try { expect(() => interfaceThemePreferencePath({ organizationId: 'https://evil.test', schoolId: scope.schoolId })).toThrow(); expect(blocked).not.toHaveBeenCalled(); } finally { blocked.mockRestore(); }
    const transport = readFileSync('src/components/interface-theme-preference.ts', 'utf8');
    expect(transport).toContain("selectedVia: 'ONBOARDING'");
    expect(transport).toContain("body: JSON.stringify({ interfaceTheme: theme, selectedVia: 'ONBOARDING' })");
    expect(transport).not.toMatch(/localStorage|sessionStorage|https?:\/\//);
  });

  it('renders exactly the three shared, keyboard-pressable interface cards with optional/current-user-only guidance', () => {
    const html = renderToStaticMarkup(<OwnerLaunch />);
    expect(html).toContain('Choose your interface mode');
    expect(html).toContain('Big-Button / Phone');
    expect(html).toContain('Modern HON');
    expect(html).toContain('Classic CRM');
    expect(html).toContain('Large touch targets');
    expect(html).toContain('Balanced visual quality');
    expect(html).toContain('Higher-density CRM controls');
    expect(html).toContain('current-user presentation preference only');
    expect(html).toContain('You can change it later');
    expect((html.match(/aria-pressed=/g) ?? []).length).toBe(3);
    expect((html.match(/disabled=""/g) ?? []).length).toBe(3);
    expect(html).not.toContain('<select');
  });

  it('leaves every owner launch command on its exact pre-existing input/path and keeps interface mode out of command bodies', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(studentReceipt));
    try {
      await expect(postOwnerLaunch(projection, 'student', studentInput, id('8'))).resolves.toEqual(studentReceipt);
      expect(fetch.mock.calls[0]![0]).toBe(`/api/v1/organizations/${id('1')}/schools/${id('2')}/student-registrations`);
      expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual(studentInput);
      expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).not.toHaveProperty('interfaceTheme');
      expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'POST', headers: { 'X-HON-Human-Command': 'owner-launch-student-registration' } });
    } finally { fetch.mockRestore(); }
    const source = readFileSync('src/components/owner-launch.tsx', 'utf8');
    expect(source).toContain("await postOwnerLaunch(context,fixedOperation,input,retry.current.key)");
    expect(source).toContain('saveInterfaceThemePreference({organizationId:context.organizationId,schoolId:context.schoolId},next,crypto.randomUUID())');
    expect(source).not.toContain('input={...input,interfaceTheme');
    expect(source).not.toContain('input.interfaceTheme');
  });
});
