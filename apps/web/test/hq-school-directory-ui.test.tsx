import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
const shell = vi.hoisted(() => ({ view: 'modern' as 'big-button' | 'modern' | 'classic' }));
vi.mock('../src/components/hq-modern/shell', () => ({ useHqModern: () => ({ view: shell.view }) }));
import { HqSchoolDirectory } from '../src/components/hq-school-directory';
import { HqSchoolDirectoryAccessError, loadHqSchoolDirectory, verifyHqSchoolDirectorySnapshot } from '../src/components/hq-school-directory-http';

function directory() {
  return { schools: [
    { schoolId: '00000000-0000-4000-8000-000000000001', organizationDisplayName: 'Harbor Organization', schoolDisplayName: 'Harbor School', organizationOperationalStatus: 'ACTIVE', schoolOperationalStatus: 'ACTIVE', entitlementTier: 'CORE', createdAt: '2026-10-16T08:00:00.000Z' },
    { schoolId: '00000000-0000-4000-8000-000000000002', organizationDisplayName: 'Summit Organization', schoolDisplayName: 'Summit School', organizationOperationalStatus: 'SUSPENDED', schoolOperationalStatus: 'ARCHIVED', entitlementTier: null, createdAt: '2026-10-16T08:01:00.000Z' },
  ] };
}

const response = (value: unknown) => ({ ok: true, json: async () => ({ data: { directory: value } }) }) as Response;

describe('HQ school directory UI', () => {
  it('loads exactly one fixed same-origin GET directory with no-store and redirect errors', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(directory()));
    try {
      await expect(loadHqSchoolDirectory()).resolves.toEqual(directory());
      expect(fetchSpy).toHaveBeenCalledWith('/api/v1/hq/schools', expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' }));
    } finally { fetchSpy.mockRestore(); }
  });

  it('fails closed on raw rows, contacts, identities, private operations, or augmented response fields', () => {
    for (const patch of [
      { organizationId: 'private' }, { userId: 'private' }, { ownerName: 'private' }, { email: 'private@example.test' },
      { studentId: 'private' }, { familyId: 'private' }, { attendance: [] }, { curriculum: [] }, { invoice: {} }, { payment: {} },
      { providerId: 'private' }, { credentialSecretRef: 'private' }, { usageCost: 1 }, { supportSessionId: 'private' }, { actionPayload: {} },
    ]) expect(() => verifyHqSchoolDirectorySnapshot({ schools: [{ ...directory().schools[0], ...patch }] })).toThrow();
    expect(() => verifyHqSchoolDirectorySnapshot({ schools: [...directory().schools].reverse() })).toThrow();
  });

  it('maps 401 and 403 to access errors and never substitutes unavailable data', async () => {
    for (const status of [401, 403] as const) {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status } as Response);
      try { await expect(loadHqSchoolDirectory()).rejects.toEqual(expect.any(HqSchoolDirectoryAccessError)); } finally { fetchSpy.mockRestore(); }
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503 } as Response);
    try { await expect(loadHqSchoolDirectory()).rejects.toThrow('No result is shown'); } finally { fetchSpy.mockRestore(); }
  });

  it('renders the loading state only until the fixed projection verifies, follows the shared HQ view and shows no fixture rows', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const html = renderToStaticMarkup(<HqSchoolDirectory />);
      expect(fetchSpy).not.toHaveBeenCalled();
      for (const text of ['School directory', 'VERIFYING HQ ACCESS', 'Customer-account facts only.']) expect(html).toContain(text);
      // The HQ shell owns navigation, the page heading and the View control; the directory repeats none of them.
      expect(html).not.toMatch(/aria-pressed=|<nav|<main|<h1/);
      for (const view of ['big-button', 'classic'] as const) {
        shell.view = view;
        expect(renderToStaticMarkup(<HqSchoolDirectory />)).toMatch(new RegExp(`class="[^"]*presentation_${view}`));
      }
      shell.view = 'modern';
      expect(html).not.toMatch(/Harbor Organization|Harbor School|private@example|Working|Your AI team/i);
    } finally { fetchSpy.mockRestore(); }
  });

  it('uses the dedicated dynamic no-index route and imports no execution, provider, payment, messaging, or mutation client', () => {
    const route = readFileSync('src/app/hq/schools/page.tsx', 'utf8');
    const component = readFileSync('src/components/hq-school-directory.tsx', 'utf8');
    const http = readFileSync('src/components/hq-school-directory-http.ts', 'utf8');
    expect(route).toContain('HqSchoolDirectory'); expect(route).toContain('force-dynamic'); expect(route).toContain('index: false');
    expect(component).toContain('const { view } = useHqModern();');
    expect(http).toContain("const PATH = '/api/v1/hq/schools'");
    expect(http).not.toMatch(/method:\s*'POST'|Idempotency-Key|invokeLLM|executeAction|sendMessage|provider-runtime|payment/i);
  });
});
