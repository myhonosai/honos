import { afterEach, expect, it, vi } from 'vitest';
import { MEMBERSHIP_PLAN_CHANGE_CONFIRMATION, CRM_ADULT_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION } from '@hon/contracts';
import { createPlanRequest, revisePlanRequest, draftFromPlanRequest, sendPlanRequest, readPlanCatalog, readAdultPlanOptions, PlanAccessError, PlanUnknownError, PlanRejectedError, PlanReadError } from '../src/components/membership-plans/http';
import { priceMinorFromText, priceTextFromMinor } from '../src/components/membership-plans/presentation';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { organizationId: id(1), schoolId: id(2) }, date = '2026-10-21T09:00:00.000Z';
const terms = { displayName: 'Adult Monthly', description: null, programId: null, availability: 'AVAILABLE' as const, currency: 'USD', priceMinor: 14900, billingFrequency: 'MONTHLY' as const, termKind: 'OPEN_ENDED' as const, termMonths: null };
const input = { ...terms, planCode: 'ADULT', confirmation: MEMBERSHIP_PLAN_CHANGE_CONFIRMATION };
const plan = { ...terms, planCode: 'ADULT', planId: id(3), version: 1, publishedAt: date };
const listing = { ...plan, programName: null };
const draftInput = { studentProfileId: id(4), membershipPlanId: id(3), membershipPlanVersion: 1, confirmation: CRM_ADULT_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION };
const receipt = { membershipId: id(5), state: 'DRAFT', planCode: 'ADULT', termStartedAt: null, termEndsAt: null, recordedAt: date };
const response = (data: unknown, status = 200, replayed = false, meta = {}) => new Response(JSON.stringify(status === 200 ? { data, meta: { requestId: id(9), correlationId: id(9), replayed, ...meta } } : data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
afterEach(() => vi.restoreAllMocks());
it('uses the five exact 0175 endpoints, markers, closed shared contracts and keys only for commands', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({ plans: [listing], programs: [] })).mockResolvedValueOnce(response({ plans: [listing] }))
    .mockResolvedValueOnce(response(plan)).mockResolvedValueOnce(response({ ...plan, version: 2, priceMinor: 15900 })).mockResolvedValueOnce(response({ receipt, plan }));
  await readPlanCatalog(scope); await readAdultPlanOptions(scope);
  const requests = [createPlanRequest(scope, input, id(10)), revisePlanRequest(scope, id(3), { ...terms, priceMinor: 15900, expectedVersion: 1, confirmation: MEMBERSHIP_PLAN_CHANGE_CONFIRMATION }, id(11)), draftFromPlanRequest(scope, draftInput, id(12))];
  for (const r of requests) await sendPlanRequest(r);
  expect(f.mock.calls.map(c => String(c[0]).split('/billing/')[1])).toEqual(['membership-plans/catalog', 'crm-adult-membership-drafts/plan-options', 'membership-plans', `membership-plans/${id(3)}/revisions`, 'crm-adult-membership-drafts/from-plan']);
  expect(f.mock.calls.map(c => (c[1]!.headers as any)['X-HON-Human-Command'])).toEqual(['membership-plan-catalog-read','crm-adult-membership-plan-options','membership-plan-create','membership-plan-revise','crm-adult-membership-draft-from-plan']);
  for (const [i, call] of f.mock.calls.entries()) { expect(call[1]).toMatchObject({ method: 'POST', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' }); expect((call[1]!.headers as any)['Idempotency-Key']).toBe(i < 2 ? undefined : requests[i - 2]!.key); }
  expect(f.mock.calls[0]![1]!.body).toBe('{}'); expect(Object.isFrozen(requests[0])).toBe(true);
});
it('refuses arbitrary scope, paths, additional fields and modified command bodies before fetch', async () => {
  const f = vi.spyOn(globalThis, 'fetch'), request = createPlanRequest(scope, input, id(10));
  expect(() => createPlanRequest({ ...scope, schoolId: '../foreign' }, input, id(10))).toThrow();
  expect(() => createPlanRequest(scope, { ...input, discount: 1 } as any, id(10))).toThrow();
  for (const patch of [{ path: 'https://evil.test' }, { kind: 'activate' }, { body: JSON.stringify({ ...input, priceMinor: '1' }) }, { path: request.path + '?school=foreign' }]) await expect(sendPlanRequest({ ...request, ...patch } as any)).rejects.toThrow();
  expect(f).not.toHaveBeenCalled();
});
it.each([401,403])('denies %s at catalog, picker and command boundaries without echoing response data', async status => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ code: 'private-canary' }, status));
  for (const work of [() => readPlanCatalog(scope), () => readAdultPlanOptions(scope), () => sendPlanRequest(createPlanRequest(scope, input, id(10)))]) await expect(work()).rejects.toBeInstanceOf(PlanAccessError);
});
it.each([['MEMBERSHIP_PLAN_VERSION_STALE',409],['MEMBERSHIP_PLAN_CODE_TAKEN',409],['MEMBERSHIP_PLAN_UNAVAILABLE',404],['MEMBERSHIP_PLAN_CURRENCY_MISMATCH',409],['MEMBERSHIP_PLAN_UNCHANGED',400]] as const)('classifies %s as a definite rejection without an automatic retry', async (code,status) => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ code, detail: 'private-canary' }, status));
  const error = await sendPlanRequest(createPlanRequest(scope, input, id(10))).catch(e => e);
  expect(error).toBeInstanceOf(PlanRejectedError); expect(error.code).toBe(code); expect(error.message).not.toContain('private-canary'); expect(f).toHaveBeenCalledTimes(1);
});
it('keeps the immutable exact command for an unknown outcome and accepts its historical replay after a later price change', async () => {
  const request = draftFromPlanRequest(scope, draftInput, id(10));
  const f = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(response({ receipt, plan }, 200, true));
  await expect(sendPlanRequest(request)).rejects.toBeInstanceOf(PlanUnknownError);
  expect(await sendPlanRequest(request)).toMatchObject({ replayed: true, draft: { plan: { version: 1, priceMinor: 14900 } } });
  expect(f.mock.calls[0]![0]).toBe(f.mock.calls[1]![0]); expect(f.mock.calls[0]![1]!.body).toBe(f.mock.calls[1]![1]!.body); expect(f.mock.calls[0]![1]!.headers).toEqual(f.mock.calls[1]![1]!.headers);
});
it('fails closed on drifted receipts, unreviewed versions/terms, cross-selection responses and replayed reads', async () => {
  const f = vi.spyOn(globalThis, 'fetch');
  for (const data of [{ ...plan, priceMinor: 1 }, { ...plan, planCode: 'OTHER' }, { ...plan, version: 2 }]) { f.mockResolvedValue(response(data)); await expect(sendPlanRequest(createPlanRequest(scope, input, id(10)))).rejects.toBeInstanceOf(PlanUnknownError); }
  for (const data of [{ receipt, plan: { ...plan, planId: id(99) } }, { receipt: { ...receipt, state: 'ACTIVE' }, plan }, { receipt, plan: { ...plan, version: 2 } }]) { f.mockResolvedValue(response(data)); await expect(sendPlanRequest(draftFromPlanRequest(scope, draftInput, id(10)))).rejects.toBeInstanceOf(PlanUnknownError); }
  f.mockResolvedValue(response({ plans: [] }, 200, true)); await expect(readAdultPlanOptions(scope)).rejects.toBeInstanceOf(PlanReadError);
  f.mockResolvedValue(response({ plans: [{ ...listing, availability: 'UNAVAILABLE' }] })); await expect(readAdultPlanOptions(scope)).rejects.toBeInstanceOf(PlanReadError);
  f.mockResolvedValue(response(plan, 200, false, { correlationId: id(88) })); await expect(sendPlanRequest(createPlanRequest(scope, input, id(10)))).rejects.toBeInstanceOf(PlanUnknownError);
});
it('forwards cancellation and never exposes arbitrary or prototype error text', async () => {
  const abort = new AbortController(), f = vi.spyOn(globalThis, 'fetch').mockImplementation((_path, options) => new Promise((_yes, no) => options!.signal!.addEventListener('abort', () => no(new Error('aborted')))));
  const result = readPlanCatalog(scope, abort.signal); abort.abort(); await expect(result).rejects.toBeInstanceOf(PlanReadError); expect(f.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  f.mockResolvedValue(response({ code: '__proto__', message: 'private-canary' }, 409)); const error = await sendPlanRequest(createPlanRequest(scope, input, id(10))).catch(e => e); expect(error.message).not.toMatch(/private-canary|\[object|function/);
});
it('converts entered prices exactly for USD, KRW and three-decimal currencies without floating rounding or FX', () => {
  expect(priceMinorFromText('149.01','USD')).toBe(14901); expect(priceMinorFromText('14900','KRW')).toBe(14900); expect(priceMinorFromText('0.001','BHD')).toBe(1);
  expect(priceTextFromMinor(14901,'USD')).toBe('149.01'); expect(priceTextFromMinor(14900,'KRW')).toBe('14900'); expect(priceMinorFromText('1000000.00','USD')).toBe(100000000);
  for (const [price,currency] of [['1.1','KRW'],['-1','USD'],['1e3','USD'],['0.001','USD'],['1000000.01','USD'],['1,000','USD']]) expect(() => priceMinorFromText(price!,currency!)).toThrow();
});
