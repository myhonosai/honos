import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CrmGuardianChildPayerDesignationWorkbench, crmGuardianChildMembershipDraftHref } from '../src/components/crm-guardian-child-payer-designation-workbench';
import StaffCrmGuardianChildPayerDesignationsPage, { dynamic, metadata } from '../src/app/staff/billing/crm-guardian-child-payer-designations/page';

const studentProfileId = '33333333-3333-4333-8333-333333333333';
const receipt = { studentDisplayName: 'Avery Kim', guardianDisplayName: 'Morgan Kim', currency: 'USD', state: 'PAYER_DESIGNATED' as const, recordedAt: '2026-10-18T20:00:00.000Z' };

describe('guardian-child payer designation workbench and route', () => {
  it('keeps a valid child selector inert on first render with no scope lookup, preparation, command, or idempotency key', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); const key = vi.spyOn(crypto, 'randomUUID');
    try {
      const html = renderToStaticMarkup(<CrmGuardianChildPayerDesignationWorkbench initialStudentProfileId={studentProfileId} />);
      expect(html).toContain('Designate the source guardian as payer'); expect(html).toContain(`value="${studentProfileId}"`); expect(html).toContain('Load payer-designation readiness'); expect(html).toContain('No verified guardian-child payer-designation readiness or receipt is shown.');
      expect(html).not.toContain('Verified child:'); expect(html).not.toContain('Designate source guardian as payer</button>'); expect(fetcher).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
    } finally { fetcher.mockRestore(); key.mockRestore(); }
  });

  it('offers only a verified historical designation one child selector for the equally inert DRAFT route', () => {
    const href = crmGuardianChildMembershipDraftHref(receipt, studentProfileId);
    expect(href).toBe(`/staff/billing/crm-guardian-child-membership-drafts?studentProfileId=${studentProfileId}`);
    const query = new URL(`https://hon.test${href}`).searchParams; expect([...query.keys()]).toEqual(['studentProfileId']); expect(query.get('studentProfileId')).toBe(studentProfileId);
    expect(crmGuardianChildMembershipDraftHref({ ...receipt, state: 'DRAFT' } as never, studentProfileId)).toBeUndefined(); expect(crmGuardianChildMembershipDraftHref(receipt, 'not-a-uuid')).toBeUndefined();
    const source = readFileSync('src/components/crm-guardian-child-payer-designation-workbench.tsx', 'utf8'); const helper = source.slice(source.indexOf('export function crmGuardianChildMembershipDraftHref'), source.indexOf('/** Separate direct-human payer-designation'));
    expect(helper).toContain("receipt?.state !== 'PAYER_DESIGNATED'"); expect(helper).toContain('new URLSearchParams({ studentProfileId: studentProfileId.toLowerCase() })'); expect(helper).not.toMatch(/URLSearchParams\(\{[^}]*?(?:organizationId|schoolId|guardian|family|account|currency|recordedAt)/);
  });

  it('admits one scalar through the protected noindex dynamic route and rejects invalid/repeated selectors without I/O', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); const key = vi.spyOn(crypto, 'randomUUID');
    try {
      const page = await StaffCrmGuardianChildPayerDesignationsPage({ searchParams: Promise.resolve({ studentProfileId }) }); expect(page.type).toBe(CrmGuardianChildPayerDesignationWorkbench); expect(page.props).toEqual({ initialStudentProfileId: studentProfileId }); expect(dynamic).toBe('force-dynamic'); expect(metadata.robots).toEqual({ index: false, follow: false });
      for (const value of [undefined, '', 'not-a-uuid', '33333333-3333-0333-8333-333333333333', [studentProfileId], [studentProfileId, '44444444-4444-4444-8444-444444444444']]) { const params = value === undefined ? {} : { studentProfileId: value as string | string[] }; expect((await StaffCrmGuardianChildPayerDesignationsPage({ searchParams: Promise.resolve(params) })).props).toEqual({}); }
      expect(fetcher).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
    } finally { fetcher.mockRestore(); key.mockRestore(); }
  });

  it('keeps the workbench source-bound, memory-only, stale-clearing, and manifest synchronized without forbidden endpoints or effects', () => {
    const source = readFileSync('src/components/crm-guardian-child-payer-designation-workbench.tsx', 'utf8'); const http = readFileSync('src/components/crm-guardian-child-payer-designation-http.ts', 'utf8'); const route = readFileSync('src/app/staff/billing/crm-guardian-child-payer-designations/page.tsx', 'utf8');
    expect(source).toContain('function clearCommand'); expect(source).toContain('function clearDerived'); expect(source).toContain('function edit'); expect(source).toContain("window.addEventListener('focus', stale)"); expect(source).toContain("document.addEventListener('visibilitychange', stale)"); expect(source).toContain('retained.current === command'); expect(source).toContain('crypto.randomUUID()');
    expect(source + http).not.toMatch(/localStorage|sessionStorage|setInterval|setTimeout|invokeLLM|executeAction|sendMessage|PaymentService|ProviderService|checkout|payer-lookup|\/billing\/accounts|\/billing\/memberships/); expect(source).not.toContain('fetch('); expect(http.match(/fetch\(/g)).toHaveLength(2);
    expect(route).toContain('normalizeInitialStudentProfileId'); expect(route).toContain("key={initialStudentProfileId ?? 'empty'}"); expect(route).not.toMatch(/fetch\(|loadCrm|prepareCrm|organizationId|schoolId|accountId|personId|familyId|currency|recordedAt/);
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: Array<{ path: string; title: string }> }; expect(manifest.routes.filter((entry) => entry.path === '/staff/billing/crm-guardian-child-payer-designations')).toEqual([{ path: '/staff/billing/crm-guardian-child-payer-designations', title: 'HON | Guardian-child source-guardian payer designation' }]);
    const paths: string[] = []; function walk(dir: string, segments: string[]): void { for (const entry of readdirSync(dir, { withFileTypes: true })) { if (entry.isDirectory() && entry.name !== 'api') walk(join(dir, entry.name), entry.name.startsWith('(') ? segments : [...segments, entry.name.replace(/^\[(?:\.\.\.)?(.+)\]$/, ':$1')]); else if (entry.name === 'page.tsx') paths.push('/' + segments.join('/')); } } walk('src/app', []); expect(new Set(manifest.routes.map((entry) => entry.path)).size).toBe(manifest.routes.length); expect(manifest.routes.map((entry) => entry.path).sort()).toEqual(paths.sort());
  });
});
