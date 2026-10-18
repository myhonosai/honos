import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BillingAccountAccessError, BillingAccountCurrencyConflictError, BillingAccountRejectedError, BillingAccountUncertainError,
  parseBillingAccountReceipt, prepareBillingAccountCommand, prepareBillingAccountPayerLookup, submitBillingAccountCommand, submitBillingAccountPayerLookup,
} from '../src/components/billing-account-workbench-http';
const org = '11111111-1111-4111-8111-111111111111', school = '22222222-2222-4222-8222-222222222222', payer = '33333333-3333-4333-8333-333333333333', key = '44444444-4444-4444-8444-444444444444';
const scope = { organizationId: org, schoolId: school };
const normal = () => prepareBillingAccountCommand(scope, { responsiblePersonId: payer, currency: 'USD' }, key);
const additional = () => prepareBillingAccountCommand(scope, { responsiblePersonId: payer, currency: 'EUR', createAdditional: true, additionalReason: 'Separate approved arrangement.' }, key);
const envelope = (reused = false, replayed = false, classification = reused ? 'CANONICAL' : 'CANONICAL') => ({ data: { id: key, responsiblePersonId: payer, currency: 'USD', classification, version: 1, createdAt: '2026-10-18T01:02:03.000Z', reused }, meta: { requestId: org, correlationId: org, replayed } });
const response = (value: unknown, status = 201, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', ...headers } });
afterEach(() => vi.restoreAllMocks());

describe('flexible billing account browser transport', () => {
  it('prepares only closed exact commands and allocates no idempotency key for payer lookup', () => {
    const request = normal(); expect(Object.isFrozen(request)).toBe(true); expect(request.path).toContain(`/organizations/${org}/schools/${school}/billing/accounts`);
    expect(request.body).toBe(JSON.stringify({ responsiblePersonId: payer, currency: 'USD', createAdditional: false }));
    expect(prepareBillingAccountPayerLookup(scope, 'Ar').body).toBe(JSON.stringify({ query: 'Ar' }));
    for (const input of [{ responsiblePersonId: payer, additionalReason: 'no' }, { responsiblePersonId: payer, createAdditional: true }, { responsiblePersonId: payer, currency: 'usd' }, { responsiblePersonId: payer, source: 'AI' }]) expect(() => prepareBillingAccountCommand(scope, input as never, key)).toThrow();
    for (const query of ['', 'A', ' '.repeat(2), 'x'.repeat(21), 'A\nri']) expect(() => prepareBillingAccountPayerLookup(scope, query)).toThrow();
  });
  it('accepts only response-backed account ID/currency/classification/reuse facts matching the exact request', () => {
    expect(parseBillingAccountReceipt(envelope(false, false), normal())).toEqual({ account: { id: key, responsiblePersonId: payer, currency: 'USD', classification: 'CANONICAL', reused: false }, replayed: false });
    expect(parseBillingAccountReceipt(envelope(true, false), normal()).account.reused).toBe(true);
    for (const patch of [{ currency: 'EUR' }, { classification: 'ADDITIONAL' }, { reused: 'false' }, { version: 2 }, { responsiblePersonId: org }, { paymentReceived: true }]) expect(() => parseBillingAccountReceipt({ ...envelope(), data: { ...envelope().data, ...patch } }, normal())).toThrow();
    const data = { ...envelope().data, currency: 'EUR', classification: 'ADDITIONAL', reused: false };
    expect(parseBillingAccountReceipt({ data, meta: envelope().meta }, additional()).account.classification).toBe('ADDITIONAL');
  });
  it('uses fixed same-origin no-store create transport and permits an explicitly called exact retry after uncertainty', async () => {
    const p = normal(); const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(response(envelope(false, true), 200));
    await expect(submitBillingAccountCommand(p)).rejects.toBeInstanceOf(BillingAccountUncertainError); await expect(submitBillingAccountCommand(p)).resolves.toEqual(expect.objectContaining({ replayed: true }));
    expect(fetcher).toHaveBeenCalledWith(p.path, { method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-HON-Human-Command': 'billing.account.create' }, body: p.body });
  });
  it('separates access/known rejection/currency conflict from uncertain results and verifies bounded payer choices', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const code of [401, 403]) { fetcher.mockResolvedValueOnce(response({}, code)); await expect(submitBillingAccountCommand(normal())).rejects.toBeInstanceOf(BillingAccountAccessError); }
    fetcher.mockResolvedValueOnce(response({ code: 'CANONICAL_ACCOUNT_CURRENCY_CONFLICT', detail: 'different currency' }, 409)); await expect(submitBillingAccountCommand(normal())).rejects.toBeInstanceOf(BillingAccountCurrencyConflictError);
    for (const code of [400, 404, 422]) { fetcher.mockResolvedValueOnce(response({}, code)); await expect(submitBillingAccountCommand(normal())).rejects.toBeInstanceOf(BillingAccountRejectedError); }
    fetcher.mockResolvedValueOnce(response(envelope(false, false), 200)); await expect(submitBillingAccountCommand(normal())).rejects.toBeInstanceOf(BillingAccountUncertainError);
    const lookup = prepareBillingAccountPayerLookup(scope, 'Ar'); fetcher.mockResolvedValueOnce(response({ data: [{ id: payer, displayName: 'Ari Stone' }] }, 200)); await expect(submitBillingAccountPayerLookup(lookup)).resolves.toEqual([{ id: payer, displayName: 'Ari Stone' }]);
    expect(fetcher).toHaveBeenLastCalledWith(lookup.path, { method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'billing.account.create' }, body: lookup.body });
  });
});
