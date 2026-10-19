import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CrmGuardianChildMembershipDraftWorkbench, crmGuardianChildMembershipDraftActivationHref } from '../src/components/crm-guardian-child-membership-draft-workbench';
import StaffCrmGuardianChildMembershipDraftsPage, { dynamic, metadata } from '../src/app/staff/billing/crm-guardian-child-membership-drafts/page';

const studentProfileId = '33333333-3333-4333-8333-333333333333';
const receipt = { membershipId: '55555555-5555-4555-8555-555555555555', state: 'DRAFT' as const, planCode: 'CHILD-OPAQUE', termStartedAt: null, termEndsAt: null, recordedAt: '2026-10-18T20:00:00.000Z' };

describe('source-bound guardian-child membership DRAFT workbench and route', () => {
  it('keeps a valid payer-designation selector inert on first render with no scope lookup, preparation, command, or idempotency key', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); const key = vi.spyOn(crypto, 'randomUUID');
    try { const html = renderToStaticMarkup(<CrmGuardianChildMembershipDraftWorkbench initialStudentProfileId={studentProfileId} />); expect(html).toContain('Create or confirm a child membership DRAFT'); expect(html).toContain(`value="${studentProfileId}"`); expect(html).toContain('Load child membership DRAFT readiness'); expect(html).toContain('No verified guardian-child membership readiness or current DRAFT confirmation is shown.'); expect(html).not.toContain('Verified child:'); expect(html).not.toContain('Create child membership DRAFT only'); expect(fetcher).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled(); } finally { fetcher.mockRestore(); key.mockRestore(); }
  });

  it('offers activation only after a separately verified current DRAFT confirmation and passes exactly one membership selector', () => {
    const href = crmGuardianChildMembershipDraftActivationHref({ state: 'RECORDED_DRAFT', receipt }); expect(href).toBe(`/staff/billing/memberships?membershipId=${receipt.membershipId}`); const query = new URL(`https://hon.test${href}`).searchParams; expect([...query.keys()]).toEqual(['membershipId']); expect(query.get('membershipId')).toBe(receipt.membershipId);
    expect(crmGuardianChildMembershipDraftActivationHref(undefined)).toBeUndefined(); expect(crmGuardianChildMembershipDraftActivationHref({ state: 'UNAVAILABLE', receipt } as never)).toBeUndefined(); expect(crmGuardianChildMembershipDraftActivationHref({ state: 'RECORDED_DRAFT', receipt: { ...receipt, membershipId: 'not-a-uuid' } } as never)).toBeUndefined();
    const source = readFileSync('src/components/crm-guardian-child-membership-draft-workbench.tsx', 'utf8'); const helper = source.slice(source.indexOf('export function crmGuardianChildMembershipDraftActivationHref'), source.indexOf('/** Separate direct-human guardian-child'));
    expect(helper).toContain("confirmation?.state === 'RECORDED_DRAFT'"); expect(helper).toContain('new URLSearchParams({ membershipId: membershipId.toLowerCase() })'); expect(helper).not.toMatch(/URLSearchParams\(\{[^}]*?(?:organizationId|schoolId|studentProfileId|guardian|family|account|planCode|termStartedAt|termEndsAt|recordedAt)/);
    const historical = source.slice(source.indexOf('Historical child membership DRAFT creation receipt'), source.indexOf('{!readiness')); expect(historical).not.toContain('href='); expect(historical).toContain('does not prove the membership remains DRAFT');
  });

  it('admits one scalar through the protected noindex dynamic route and rejects invalid/repeated selectors without I/O', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); const key = vi.spyOn(crypto, 'randomUUID');
    try { const page = await StaffCrmGuardianChildMembershipDraftsPage({ searchParams: Promise.resolve({ studentProfileId }) }); expect(page.type).toBe(CrmGuardianChildMembershipDraftWorkbench); expect(page.props).toEqual({ initialStudentProfileId: studentProfileId }); expect(dynamic).toBe('force-dynamic'); expect(metadata.robots).toEqual({ index: false, follow: false }); for (const value of [undefined, '', 'not-a-uuid', '33333333-3333-0333-8333-333333333333', [studentProfileId], [studentProfileId, '44444444-4444-4444-8444-444444444444']]) { const params = value === undefined ? {} : { studentProfileId: value as string | string[] }; expect((await StaffCrmGuardianChildMembershipDraftsPage({ searchParams: Promise.resolve(params) })).props).toEqual({}); } expect(fetcher).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled(); } finally { fetcher.mockRestore(); key.mockRestore(); }
  });

  it('uses only dedicated guardian-child transport paths and clears derived current/receipt/retry state on selector, scope, visibility, and discard changes', () => {
    const source = readFileSync('src/components/crm-guardian-child-membership-draft-workbench.tsx', 'utf8'); const http = readFileSync('src/components/crm-guardian-child-membership-draft-http.ts', 'utf8'); const route = readFileSync('src/app/staff/billing/crm-guardian-child-membership-drafts/page.tsx', 'utf8');
    expect(source).toContain('function clearCommand'); expect(source).toContain('function clearDerived'); expect(source).toContain('function edit'); expect(source).toContain('function editCommand'); expect(source).toContain('function discard'); expect(source).toContain("window.addEventListener('focus', stale)"); expect(source).toContain("document.addEventListener('visibilitychange', stale)"); expect(source).toContain('retained.current === command'); expect(source).toContain('crypto.randomUUID()');
    expect(source).not.toContain('fetch('); expect(http.match(/fetch\(/g)).toHaveLength(2); expect(http).toContain('/billing/crm-guardian-child-membership-drafts'); expect(http).not.toMatch(/\/billing\/accounts|\/billing\/memberships|payer-lookup|localStorage|sessionStorage|invokeLLM|executeAction|sendMessage|PaymentService|ProviderService|checkout/); expect(route).toContain('normalizeInitialStudentProfileId'); expect(route).toContain("key={initialStudentProfileId ?? 'empty'}"); expect(route).not.toMatch(/fetch\(|loadCrm|prepareCrm|organizationId|schoolId|accountId|personId|familyId|currency|recordedAt/);
  });
});
