import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CrmAdultMembershipDraftWorkbench } from '../src/components/crm-adult-membership-draft-workbench';
import StaffCrmAdultMembershipDraftsPage, { dynamic, metadata } from '../src/app/staff/billing/crm-adult-membership-drafts/page';

const studentProfileId = '33333333-3333-4333-8333-333333333333';
afterEach(() => vi.restoreAllMocks());
describe('adult CRM membership DRAFT workbench and route', () => {
  it('keeps a valid registration selector inert on first render', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); const key = vi.spyOn(crypto, 'randomUUID');
    const html = renderToStaticMarkup(<CrmAdultMembershipDraftWorkbench initialStudentProfileId={studentProfileId} />);
    expect(html).toContain('Create an adult CRM membership draft'); expect(html).toContain(`value="${studentProfileId}"`);
    expect(html).toContain('Load adult CRM membership readiness'); expect(html).toContain('No verified adult CRM membership readiness is shown.');
    expect(html).not.toContain('Verified adult:'); expect(html).not.toContain('Create membership DRAFT only');
    expect(fetcher).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
  });

  it('keeps the workbench isolated from directories, persistence, generic membership creation, and downstream effects', () => {
    const source = readFileSync('src/components/crm-adult-membership-draft-workbench.tsx', 'utf8');
    const http = readFileSync('src/components/crm-adult-membership-draft-http.ts', 'utf8');
    expect(source).toContain('Load adult CRM membership readiness'); expect(source).toContain('Create membership DRAFT only');
    expect(source + http).not.toMatch(/localStorage|sessionStorage|setInterval|setTimeout|providerClient|invokeLLM|executeAction|sendMessage|MembershipService|PaymentService|OwnerLaunch/);
    expect(source).not.toMatch(/fetch\(/); expect(http.match(/fetch\(/g)).toHaveLength(2);
    expect(http).toContain("'X-HON-Human-Command': 'crm-adult-membership-prepare'"); expect(http).toContain("'X-HON-Human-Command': 'crm-adult-membership-draft'");
    expect(http).not.toContain('/billing/memberships'); expect(http).not.toContain('MembershipService');
    expect(source).toContain('retained.current === command'); expect(source).toContain('crypto.randomUUID()');
  });

  it('admits only one inert student selector through the protected dynamic route', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); const key = vi.spyOn(crypto, 'randomUUID');
    const page = await StaffCrmAdultMembershipDraftsPage({ searchParams: Promise.resolve({ studentProfileId }) });
    expect(page.type).toBe(CrmAdultMembershipDraftWorkbench); expect(page.props).toEqual({ initialStudentProfileId: studentProfileId });
    expect(dynamic).toBe('force-dynamic'); expect(metadata.robots).toEqual({ index: false, follow: false }); expect(fetcher).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
    for (const value of [undefined, '', 'not-a-uuid', '33333333-3333-0333-8333-333333333333', [studentProfileId], [studentProfileId, '44444444-4444-4444-8444-444444444444']]) {
      const params = value === undefined ? {} : { studentProfileId: value as string | string[] };
      expect((await StaffCrmAdultMembershipDraftsPage({ searchParams: Promise.resolve(params) })).props).toEqual({});
    }
    const route = readFileSync('src/app/staff/billing/crm-adult-membership-drafts/page.tsx', 'utf8');
    expect(route).toContain('normalizeInitialStudentProfileId'); expect(route).toContain("key={initialStudentProfileId ?? 'empty'}");
    expect(route).not.toMatch(/fetch\(|loadCurrent|loadCrmAdultMembership|prepareCrmAdultMembership|organizationId|schoolId|accountId|personId|conversionId/);
  });

  it('declares the isolated route once and keeps the route manifest synchronized', () => {
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: Array<{ path: string; title: string }> };
    expect(manifest.routes.filter((route) => route.path === '/staff/billing/crm-adult-membership-drafts')).toEqual([{ path: '/staff/billing/crm-adult-membership-drafts', title: 'HON | Adult CRM membership DRAFT' }]);
    const paths: string[] = [];
    function walk(dir: string, segments: string[]): void { for (const entry of readdirSync(dir, { withFileTypes: true })) { if (entry.isDirectory() && entry.name !== 'api') walk(join(dir, entry.name), entry.name.startsWith('(') ? segments : [...segments, entry.name.replace(/^\[(?:\.\.\.)?(.+)\]$/, ':$1')]); else if (entry.name === 'page.tsx') paths.push('/' + segments.join('/')); } }
    walk('src/app', []);
    expect(new Set(manifest.routes.map((route) => route.path)).size).toBe(manifest.routes.length);
    expect(manifest.routes.map((route) => route.path).sort()).toEqual(paths.sort());
  });
});
