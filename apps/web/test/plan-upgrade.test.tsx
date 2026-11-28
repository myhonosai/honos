import React from 'react';
import { readFileSync } from 'node:fs';
import { randomUUID as K } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SAAS_COMMANDS, honOsLaunchScheduleTerms } from '@hon/contracts';
import { prepareCheckoutTerms, readSchoolPriceSchedules, subscribe, UpgradeError } from '../src/components/plan-upgrade/http';
import { SubscribeToPlan } from '../src/components/school-subscription/subscribe';
import { PLAN_UPGRADE_HREF } from '../src/components/school-shell/plan-features';
// @ts-expect-error synthetic fixture module without types
import { sampleGeneration } from '../../../packages/database/scripts/subscription-generation-fixture.mjs';

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
const fail = (status: number, code: string) => new Response(JSON.stringify({ code }), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => vi.restoreAllMocks());

function chain() {
  const g = sampleGeneration(honOsLaunchScheduleTerms('REGULAR_MONTHLY'));
  const r = g.acceptance.schedule;
  const requirements = { generationId: g.generationId, generationDigest: g.generationDigest, organizationId: g.organizationId, schoolId: g.schoolId,
    acceptanceId: g.acceptance.acceptanceId, acceptanceDigest: g.acceptance.acceptanceDigest, scheduleDigest: r.scheduleDigest, offerId: r.offerId,
    renewalOfferId: r.renewalOfferId, offerSetId: r.offerSetId, offerSetVersion: 1, acceptedOfferDigest: r.acceptedOfferDigest, disclosureVersion: r.disclosureVersion,
    disclosureText: r.disclosureText, termsReference: r.termsReference, refundTerms: r.refundTerms, cancellationTerms: r.cancellationTerms, lockedPriceMinor: 24900,
    currency: 'USD', billingInterval: 'MONTHLY', priceRule: 'LOCKED_WHILE_SUBSCRIBED', periodCountingRule: 'DISTINCT_VERIFIED_PAID_PERIODS',
    automaticCalendarTransition: false, automaticCollectionEnabled: false };
  const binding = { bindingId: K(), bindingKey: K(), generationId: g.generationId, generationDigest: g.generationDigest, organizationId: g.organizationId, schoolId: g.schoolId,
    requirements, provider: 'STRIPE_SIMULATED', mode: 'TEST', status: 'PENDING_PROVIDER_BINDING', statusReason: 'BINDING_REQUESTED', version: 1,
    providerAccountReference: null, providerSubscriptionReference: null, providerScheduleReference: null, requirementsDigest: 'e'.repeat(64), qualifyingPaidPeriodCount: 0,
    unresolvedReconciliation: false, accessDecidedSeparately: true, checkoutAvailable: false, billingEnabled: false, createdAt: '2031-01-01T00:00:00.000Z', boundAt: null, activatedAt: null, terminalAt: null };
  const preview = { organizationId: g.organizationId, schoolId: g.schoolId, schedule: r, acceptanceDigest: g.acceptance.acceptanceDigest, canAcknowledge: true, blockers: [],
    purchaseAvailable: false, paymentAuthorized: false, accessGranted: false, asOf: '2031-01-01T00:00:00.000Z' };
  return { g, binding, preview };
}

describe('plan upgrade (0707): Upgrade -> Subscribe on the 0230 schedule path', () => {
  it('the Upgrade button lands on the Subscribe section', () => {
    expect(PLAN_UPGRADE_HREF).toBe('/staff/subscription#subscribe');
    expect(readFileSync('src/components/school-subscription/subscribe.tsx', 'utf8')).toContain('id="subscribe"');
  });
  it('subscribes with three exact server commands, one key each, and reports the provider-unavailable state', async () => {
    const { g, binding, preview } = chain();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => {
      const p = String(path);
      if (p.endsWith('hon-os-price-acceptances')) return ok({ acceptance: g.acceptance, replayed: false });
      if (p.endsWith('hon-os-subscription-generations')) return ok({ generation: g, replayed: false });
      return ok({ binding, replayed: false });
    });
    const keys = { accept: K(), generation: K(), binding: K() };
    const result = await subscribe(g.schoolId, preview as never, keys);
    expect(result.bindingId).toBe(binding.bindingId);
    expect(fetch.mock.calls.map(c => String(c[0]))).toEqual([`/api/v1/schools/${g.schoolId}/hon-os-price-acceptances`,
      `/api/v1/schools/${g.schoolId}/hon-os-subscription-generations`, `/api/v1/schools/${g.schoolId}/hon-os-subscription-schedule-bindings`]);
    const sent = fetch.mock.calls.map(c => c[1] as RequestInit & { headers: Record<string, string> });
    expect(sent.map(i => [i.method, i.headers['X-HON-Human-Command'], i.headers['Idempotency-Key']])).toEqual([
      ['POST', SAAS_COMMANDS.acceptPriceSchedule, keys.accept], ['POST', SAAS_COMMANDS.recordSubscriptionGeneration, keys.generation],
      ['POST', SAAS_COMMANDS.startScheduleBinding, keys.binding]]);
    for (const i of sent) expect(i).toMatchObject({ credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
    expect(JSON.parse(String(sent[0]!.body))).toEqual({ scheduleId: preview.schedule.scheduleId, scheduleDigest: preview.schedule.scheduleDigest,
      acceptanceDigest: preview.acceptanceDigest, confirmation: 'ACCEPT_INITIAL_AND_SCHEDULED_RENEWAL_PRICES' });
    expect(JSON.parse(String(sent[2]!.body))).toEqual({ generationId: g.generationId, generationDigest: g.generationDigest, confirmation: 'BIND_TEST_ONLY_SCHEDULE_NO_COLLECTION' });
    fetch.mockImplementation(async (path) => String(path).endsWith('schedule-bindings') ? fail(503, 'SAAS_SCHEDULE_PROVIDER_UNAVAILABLE')
      : String(path).endsWith('generations') ? ok({ generation: g, replayed: true }) : ok({ acceptance: g.acceptance, replayed: true }));
    await expect(subscribe(g.schoolId, preview as never, keys)).rejects.toMatchObject({ code: 'SAAS_SCHEDULE_PROVIDER_UNAVAILABLE', status: 503 });
    fetch.mockImplementation(async () => ok({ acceptance: { ...g.acceptance, schoolId: K() }, replayed: false }));
    await expect(subscribe(g.schoolId, preview as never, keys)).rejects.toBeInstanceOf(UpgradeError);
  });
  it('reads only the exact school schedules and refuses drift', async () => {
    const school = K(), list = { schoolId: school, schedules: [{ offerId: K(), scheduleId: K(), version: 1 }], asOf: '2031-01-01T00:00:00.000Z' };
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ok(list));
    await expect(readSchoolPriceSchedules(school)).resolves.toEqual(list);
    expect(fetch.mock.calls[0]![0]).toBe(`/api/v1/schools/${school}/hon-os-price-schedules`);
    expect((fetch.mock.calls[0]![1] as RequestInit).method).toBe('GET');
    fetch.mockImplementation(async () => ok({ ...list, schoolId: K() }));
    await expect(readSchoolPriceSchedules(school)).rejects.toBeInstanceOf(UpgradeError);
  });
  it('HQ prepares checkout terms once per published price (expected version 0); a second try is a 409', async () => {
    const { g } = chain(), s = g.acceptance.schedule;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ok({ schedule: s, replayed: false }));
    const key = K();
    await expect(prepareCheckoutTerms(s.offerId, 3, key)).resolves.toMatchObject({ scheduleId: s.scheduleId });
    const [path, init] = fetch.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(path).toBe('/api/v1/hq/saas/price-schedules');
    expect([init.headers['X-HON-Human-Command'], init.headers['Idempotency-Key']]).toEqual([SAAS_COMMANDS.recordPriceSchedule, key]);
    expect(JSON.parse(String(init.body))).toMatchObject({ offerId: s.offerId, renewalOfferId: s.offerId, expectedOfferSetRevision: 3, expectedVersion: 0 });
    fetch.mockImplementation(async () => fail(409, 'SAAS_VERSION_CONFLICT'));
    await expect(prepareCheckoutTerms(s.offerId, 3, K())).rejects.toMatchObject({ code: 'SAAS_VERSION_CONFLICT', status: 409, uncertain: false });
  });
  it('while payments are not connected the Subscribe section says so and starts nothing', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const account = { context: { organizationId: K(), schoolId: K() }, plan: { payments: { status: 'DISABLED', mode: null } } } as never;
    const html = renderToStaticMarkup(<SubscribeToPlan account={account} offers={[]}/>);
    expect(html).toContain('data-subscribe-unavailable');
    expect(html).toContain('Subscribing is not available yet');
    expect(html).not.toContain('data-subscribe-confirm');
    expect(fetch).not.toHaveBeenCalled();
  });
});
