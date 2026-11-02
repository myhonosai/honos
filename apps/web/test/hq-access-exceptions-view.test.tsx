import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOCALE, formatLocaleDateTime } from '@hon/design-system';
import { SAAS_PLAN_CAPABILITIES, validateSaasAccessExceptionGrantReceipt, validateSaasAccessExceptionsView, validateSaasExceptionPolicyView, validateSaasOrganizationSubscription, type SaasAccessException } from '@hon/contracts';
import { AccessExceptionController } from '../src/components/hq-access-exceptions/controller';
import { ExceptionError, type Capsule, type Receipt, type Snapshot } from '../src/components/hq-access-exceptions/http';
import { AccessExceptionView, HqAccessExceptions, HqAccessExceptionsLink } from '../src/components/hq-access-exceptions/workbench';
import { exceptionCatalog } from '../src/components/hq-access-exceptions/catalog';

const presentation = vi.hoisted(() => ({ language: 'en' as 'en' | 'ko' | 'es', view: 'modern' }));
vi.mock('../src/components/hq-modern/shell', () => ({ useHqModern: () => ({ view: presentation.view }) }));
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ preferences: { ...DEFAULT_LOCALE, language: presentation.language, timeZone: 'Asia/Seoul' }, number: String }) }));
const owner = '10000000-0000-4000-8000-000000000001';
const selected = { organizationId: '20000000-0000-4000-8000-000000000001', schoolId: '30000000-0000-4000-8000-000000000001' };
const exceptionId = '40000000-0000-4000-8000-000000000001', approvalId = '50000000-0000-4000-8000-000000000001';
const at = '2026-11-01T12:00:00.000Z', startsAt = '2026-11-02T12:00:00.000Z', expiresAt = '2026-11-09T12:00:00.000Z';
const privateName = 'SYNTHETIC PRIVATE ORGANIZATION', reason = 'INTERNAL_TESTING';
const entitlement = () => ({ tier: 'COMPLETE' as const, status: 'SUSPENDED' as const, version: 3, effectiveFrom: at, effectiveUntil: null, inEffect: false });
function snapshot(): Snapshot {
  const decision = { approvalId, revision: 4, status: 'APPROVED', termsVersion: 1, maxDays: 7, validFrom: '2026-10-01T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', reason: 'Synthetic policy for isolated presentation tests.', actorPrincipalId: owner, recordedAt: at };
  return {
    policy: validateSaasExceptionPolicyView({ scope: 'ACCESS_EXCEPTIONS_ONLY', current: decision, effectiveStatus: 'ACTIVE', history: [decision], historyLimit: 100, asOf: at, termsStatus: 'PROPOSED', paidAccessProgram: 'INACTIVE', aiCreditProgram: 'INACTIVE' }),
    exceptions: validateSaasAccessExceptionsView({ organizationId: selected.organizationId, access: { organizationId: selected.organizationId, state: 'PROVISIONED', source: 'NONE', entitlement: entitlement(), capabilities: [], paidAccessProgram: 'INACTIVE' }, exceptions: [], asOf: at }),
    subscription: validateSaasOrganizationSubscription({ organizationId: selected.organizationId, organizationName: privateName, organizationStatus: 'ACTIVE', entitlement: { tier: 'COMPLETE', status: 'SUSPENDED', version: 3, effectiveFrom: at, effectiveUntil: null }, current: null, alignment: 'NO_SUBSCRIPTION', history: [], founderReservations: [], chargesEnabled: false }),
  };
}
function record(): SaasAccessException {
  return { exceptionId, ...selected, purpose: 'INTERNAL_TESTING', reason: 'Private <script>justification</script>', scopeTier: 'COMPLETE', capabilities: [...SAAS_PLAN_CAPABILITIES.COMPLETE], aiCredits: 'NONE', startsAt, expiresAt, policyVersion: 1, maxDays: 7, status: 'GRANTED', lifecycle: 'SCHEDULED', grantedByPrincipalId: owner, grantedAt: at, priorEntitlement: entitlement(), grantedEntitlement: { tier: 'COMPLETE', status: 'ACTIVE', version: 4, effectiveFrom: startsAt, effectiveUntil: expiresAt, inEffect: false }, endReason: null, endNote: null, endEntitlement: null, endedByPrincipalId: null, endedAt: null, governingPolicy: { approvalId, revision: 4, termsVersion: 1, maxDays: 7 } };
}
function setup(data = snapshot()) {
  const api = { owner: vi.fn(async () => owner), read: vi.fn(async () => data), send: vi.fn(async (request: Capsule): Promise<Receipt> => {
    const { expectedEntitlementVersion: _version, ...input } = JSON.parse(request.body);
    return { kind: 'grant', data: validateSaasAccessExceptionGrantReceipt({ exception: { ...record(), ...input }, access: data.exceptions.access, replayed: false }) };
  }) };
  const c = new AccessExceptionController(api); c.start();
  return { c, api, data, html: () => renderToStaticMarkup(<AccessExceptionView controller={c} />) };
}
async function load(s: ReturnType<typeof setup>) { s.c.editSelector('organizationId', selected.organizationId); s.c.editSelector('schoolId', selected.schoolId); await s.c.load(); }
async function prepare(s: ReturnType<typeof setup>) { await load(s); s.c.editDraft('reason', reason); s.c.editDraft('startsAt', '2026-11-02T12:00'); s.c.editDraft('expiresAt', '2026-11-09T12:00'); s.c.confirm(true); }
afterEach(() => { presentation.language = 'en'; presentation.view = 'modern'; vi.restoreAllMocks(); });

describe('HQ access exception production view', () => {
  it('renders inert initial navigation and explicit selectors without a fetch or command form', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const html = renderToStaticMarkup(<><HqAccessExceptionsLink /><HqAccessExceptions /></>);
    expect(fetch).not.toHaveBeenCalled(); expect(html).toContain('href="/hq/access-exceptions"');
    expect(html).toContain('name="organizationId"'); expect(html).toContain('name="schoolId"');
    expect(html).toContain('role="status" aria-live="polite" aria-atomic="true"');
    expect(html).not.toMatch(/<textarea|<select|type="checkbox"/); expect(html).not.toContain(privateName);
  });
  it('keeps the same idle/manual behavior and complete copy in three languages and modes', () => {
    const s = setup(), keys = Object.keys(exceptionCatalog.en);
    for (const language of ['en','ko','es'] as const) {
      expect(Object.keys(exceptionCatalog[language]).sort()).toEqual([...keys].sort());
      for (const value of Object.values(exceptionCatalog[language])) expect(value.trim()).not.toBe('');
      for (const view of ['modern','classic','big-button']) {
        presentation.language = language; presentation.view = view; const html = s.html();
        expect(html).toContain(exceptionCatalog[language].title); expect(html).toContain(exceptionCatalog[language].load);
        expect(html).toContain('role="status"'); expect(s.api.owner).not.toHaveBeenCalled(); expect(s.api.read).not.toHaveBeenCalled();
      }
    }
  });
  it('shows the actual seven-day approval separately from proposed terms and inactive programs, using UTC', async () => {
    const s = setup(); await load(s); const html = s.html();
    expect(html).toContain('Approved maximum days</dt><dd>7</dd>'); expect(html).toContain('Broader paid-access terms</dt><dd>Proposed</dd>');
    expect(html).toContain('Paid-access program</dt><dd>Inactive</dd>'); expect(html).toContain('AI credit program</dt><dd>Inactive</dd>');
    expect(html).toContain(formatLocaleDateTime(DEFAULT_LOCALE, s.data.policy.current!.validFrom) + ' UTC');
    expect(html).toContain('These reads do not prove full eligibility.'); expect(html).toContain('pending checkouts');
    expect(html).not.toContain('90'); expect(html).not.toMatch(/[$€₩]|Approve policy|name="price"/);
  });
  it('labels a proposed decision as a decision limit and disables grants without implying approval', async () => {
    const data = snapshot(); data.policy.current!.status = 'PROPOSED'; data.policy.effectiveStatus = 'PROPOSED';
    validateSaasExceptionPolicyView(data.policy); const s = setup(data); await load(s); const html = s.html();
    expect(html).toContain('Maximum days in this decision</dt><dd>7</dd>'); expect(html).not.toContain('Approved maximum days</dt>');
    expect(html).toContain('No current effective APPROVED exception-only policy permits a new grant.');
    expect(html).toMatch(/<fieldset disabled=""/); expect(s.c.canGrant()).toBe(false);
  });
  it('filters the bounded organization history by the explicit school and escapes untrusted reasons', async () => {
    const data = snapshot(); data.exceptions.exceptions = [{ ...record(), governingPolicy: null, lifecycle: 'EXPIRED' }, { ...record(), exceptionId: '40000000-0000-4000-8000-000000000002', schoolId: '30000000-0000-4000-8000-000000000002', reason: 'OTHER SCHOOL PRIVATE REASON', status: 'ENDED', lifecycle: 'EXPIRED', endReason: 'EXPIRED', endedAt: expiresAt, endedByPrincipalId: owner, endEntitlement: entitlement() }];
    validateSaasAccessExceptionsView(data.exceptions); const s = setup(data); await load(s); const html = s.html();
    expect(html).toContain('Historical policy binding unverified'); expect(html).toContain('not complete history');
    expect(html).toContain('&lt;script&gt;justification&lt;/script&gt;'); expect(html).not.toContain('<script>'); expect(html).not.toContain('OTHER SCHOOL PRIVATE REASON');
  });
  it('uses a distinct revoke review and clears confirmation when returning to grant review', async () => {
    const data = snapshot(); data.exceptions.exceptions = [record()]; const s = setup(data); await load(s);
    s.c.selectRevoke(exceptionId); s.c.editRevokeReason('Explicit synthetic revocation.'); s.c.confirm(true); const revoke = s.html();
    expect(revoke).toContain('id="exception-revoke"'); expect(revoke).not.toContain('id="exception-grant"'); expect(revoke.match(/type="checkbox"/g)).toHaveLength(1);
    s.c.cancelRevoke(); const grant = s.html(); expect(grant).toContain('id="exception-grant"'); expect(grant).not.toContain('id="exception-revoke"'); expect(s.c.snapshot().confirmed).toBe(false);
  });
  it('renders an unknown request exactly only after same-owner restoration; concealed memory stays out of markup', async () => {
    const s = setup(); await prepare(s); s.api.send.mockRejectedValueOnce(new Error('lost response')); await s.c.grant();
    const request = s.c.snapshot().pending!; expect(s.html()).toContain('Recorded reason</dt><dd>INTERNAL_TESTING</dd>'); expect(s.html()).not.toContain(request.key);
    s.c.conceal(); const hidden = s.html(); expect(s.c.retainsRequest()).toBe(true);
    for (const value of [privateName, selected.organizationId, selected.schoolId, reason, approvalId, request.key]) expect(hidden).not.toContain(value);
    expect(hidden).toMatch(/data-access-exceptions-facts/); expect(hidden).toContain('hidden="" inert=""'); expect(hidden).toContain('role="status"');
    await s.c.restore(); expect(s.html()).toContain('Original request retained'); expect(s.html()).toContain('Recorded reason</dt><dd>INTERNAL_TESTING</dd>'); expect(s.api.send).toHaveBeenCalledTimes(1);
  });
  it('shows only historical receipt evidence after success and requires a fresh read for current state', async () => {
    const s = setup(); await prepare(s); await s.c.grant(); const html = s.html();
    expect(html).toContain('Verified command receipt'); expect(html).toContain('historical command receipt');
    expect(html).toContain('Read the organization again for current access'); expect(html).not.toContain('id="exception-current"');
    expect(html).not.toContain('id="exception-grant"'); expect(html).not.toContain('id="exception-revoke"');
  });
  it('keeps a signed-out message and recovery control outside the private inert region without an automatic read', async () => {
    const s = setup(); s.api.owner.mockRejectedValue(new ExceptionError('SIGNED_OUT', 401)); await load(s); const html = s.html();
    expect(html).toContain('href="/auth/login"'); expect(html).toContain('Sign in again before verifying owner access.');
    expect(html.indexOf('role="status"')).toBeLessThan(html.indexOf('data-access-exceptions-facts'));
    expect(html.indexOf('Verify owner and restore')).toBeLessThan(html.indexOf('data-access-exceptions-facts')); expect(s.api.read).not.toHaveBeenCalled();
  });
});
