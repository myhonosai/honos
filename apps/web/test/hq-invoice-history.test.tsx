import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateSaasInvoiceList, validateSaasInvoiceDetail, validateSaasOrganizationSubscription, validateSaasPaymentStanding, validateSaasRefundEligibility, validateSaasRefundRequestList } from '@hon/contracts';
import { invoiceId, saasId, invoiceFixture, invoiceListFixture, invoiceAccountFixture, invoiceRefundFixture } from '../scripts/fixtures/hq-invoice-history.mjs';
import { loadHqInvoiceList, loadHqInvoiceAccount, loadHqInvoiceRefunds } from '../src/components/hq-modern/invoice-history-http';
import { HqInvoiceHistory, InvoiceListResults } from '../src/components/hq-modern/invoice-history';
import { HqInvoiceDetail, InvoiceDetailResults, InvoiceRefundResults } from '../src/components/hq-modern/invoice-detail';
import { invoiceAmount } from '../src/components/hq-modern/invoice-history-shared';
import { hqPageLabel } from '../src/components/hq-modern/catalog';

const ok = (data: unknown) => ({ ok: true, json: async () => ({ data }) } as Response);
function mocks(id = 1) {
  const account = invoiceAccountFixture(id), refunds = invoiceRefundFixture(id);
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => {
    const value = String(path), resource = value.split('/').at(-1)!;
    return ok(value.includes('/invoices/') ? account.invoice : resource.startsWith('invoices') ? invoiceListFixture({ status: new URL(value, 'https://hon.invalid').searchParams.get('status') as never })
      : resource === 'subscription' ? account.account : resource === 'payment-standing' ? account.standing : resource === 'refund-eligibility' ? refunds.eligibility : refunds.requests);
  });
}
afterEach(() => vi.restoreAllMocks());

describe('HON HQ invoice and payment-history integration', () => {
  it('keeps every synthetic B1/B2/B4 projection inside canonical closed contracts', () => {
    for (const status of [null, 'DRAFT', 'ISSUED', 'VOID'] as const) expect(validateSaasInvoiceList(invoiceListFixture({ status }))).toEqual(invoiceListFixture({ status }));
    for (const id of [1, 2, 3, 4, 5]) for (const empty of [false, true]) for (const updated of [false, true]) {
      const data = invoiceAccountFixture(id, { empty, updated }), refund = invoiceRefundFixture(id, { empty, updated });
      expect(validateSaasInvoiceDetail(data.invoice)).toEqual(data.invoice); expect(validateSaasOrganizationSubscription(data.account)).toEqual(data.account); expect(validateSaasPaymentStanding(data.standing)).toEqual(data.standing);
      expect(validateSaasRefundEligibility(refund.eligibility)).toEqual(refund.eligibility); expect(validateSaasRefundRequestList(refund.requests)).toEqual(refund.requests);
    }
  });
  it('uses only six fixed no-store authenticated GET resources with cancellation and closed status filters', async () => {
    const fetch = mocks(), controller = new AbortController();
    await loadHqInvoiceList('ISSUED', controller.signal); const data = await loadHqInvoiceAccount(invoiceId(1), controller.signal); await loadHqInvoiceRefunds(data.invoice, controller.signal);
    expect(fetch).toHaveBeenCalledTimes(6);
    for (const path of ['invoices?status=ISSUED', `invoices/${invoiceId(1)}`, `organizations/${saasId(1)}/subscription`, `organizations/${saasId(1)}/payment-standing`, `organizations/${saasId(1)}/refund-eligibility`, 'refunds']) expect(fetch).toHaveBeenCalledWith(`/api/v1/hq/saas/${path}`, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal: controller.signal,
    });
  });
  it('rejects injected selectors before any read and binds returned status windows', async () => {
    const fetch = mocks();
    for (const value of ['', '../refunds', `${invoiceId(1)}?role=OWNER`, 'HON-2026-000001']) await expect(loadHqInvoiceAccount(value)).rejects.toMatchObject({ kind: 'INVALID_SELECTION' });
    await expect(loadHqInvoiceRefunds({ ...invoiceFixture(), organizationId: '../school' })).rejects.toMatchObject({ kind: 'INVALID_SELECTION' });
    await expect(loadHqInvoiceList('ISSUED&organizationId=x' as never)).rejects.toMatchObject({ kind: 'INVALID_SELECTION' }); expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValue(ok(invoiceListFixture())); await expect(loadHqInvoiceList('DRAFT')).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    const duplicate = invoiceListFixture(); duplicate.invoices.push(duplicate.invoices[0]!); fetch.mockResolvedValue(ok(duplicate)); await expect(loadHqInvoiceList(null)).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
  });
  it('independently fails each denied read without reading or echoing private error bodies', async () => {
    for (const resource of ['invoices', invoiceId(1), 'subscription', 'payment-standing', 'refund-eligibility', 'refunds']) for (const [status, kind] of [[401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [404, 'UNAVAILABLE'], [503, 'UNAVAILABLE']] as const) {
      const fetch = mocks(), fallback = fetch.getMockImplementation()!, json = vi.fn(async () => ({ customerPrivate: 'must-not-leak' }));
      fetch.mockImplementation(async (path, init) => String(path).split('/').at(-1) === resource ? { ok: false, status, json } as unknown as Response : fallback(path, init));
      await expect(resource === 'invoices' ? loadHqInvoiceList(null) : ['refunds', 'refund-eligibility'].includes(resource) ? loadHqInvoiceRefunds(invoiceFixture()) : loadHqInvoiceAccount(invoiceId(1))).rejects.toMatchObject({ kind });
      expect(json).not.toHaveBeenCalled(); fetch.mockRestore();
    }
  });
  it('binds invoice identity and every payment/reversal evidence entry before organization reads', async () => {
    const fetch = mocks();
    for (const change of [
      (i: ReturnType<typeof invoiceFixture>) => { i.invoiceId = invoiceId(2); },
      (i: ReturnType<typeof invoiceFixture>) => { i.evidence[0]!.invoiceId = invoiceId(2); },
      (i: ReturnType<typeof invoiceFixture>) => { i.evidence[1]!.relatedEvidenceId = saasId(999); },
      (i: ReturnType<typeof invoiceFixture>) => { i.evidence[1]!.relatedEvidenceId = i.evidence[2]!.evidenceId; },
      (i: ReturnType<typeof invoiceFixture>) => { i.evidence.push(i.evidence[0]!); },
    ]) { const invoice = invoiceFixture(); change(invoice); fetch.mockResolvedValue(ok(invoice)); fetch.mockClear(); await expect(loadHqInvoiceAccount(invoiceId(1))).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' }); expect(fetch).toHaveBeenCalledTimes(1); }
  });
  it('binds organization/current subscription but preserves invoices from historical subscriptions', async () => {
    const fetch = mocks();
    for (const resource of ['subscription', 'payment-standing']) { const data = invoiceAccountFixture();
      fetch.mockImplementation(async (path) => ok(String(path).includes('/invoices/') ? data.invoice : String(path).endsWith('/subscription') ? { ...data.account, ...(resource === 'subscription' ? { organizationId: saasId(2) } : {}) } : { ...data.standing, ...(resource === 'payment-standing' ? { subscriptionId: saasId(999) } : {}) }));
      await expect(loadHqInvoiceAccount(invoiceId(1))).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    }
    const history = invoiceAccountFixture(1, { historical: true }); fetch.mockImplementation(async (path) => ok(String(path).includes('/invoices/') ? history.invoice : String(path).endsWith('/subscription') ? history.account : history.standing));
    await expect(loadHqInvoiceAccount(invoiceId(1))).resolves.toEqual(history);
    const html = renderToStaticMarkup(<InvoiceDetailResults data={history}/>); expect(html).toContain('Invoice is not the current subscription record'); expect(html).toContain('USD 45.10');
  });
  it('rejects collection, verification, line, private-field and envelope drift through canonical contracts', async () => {
    const fetch = mocks();
    const bad = [
      { ...invoiceFixture(), collection: 'ENABLED' }, { ...invoiceFixture(), delivery: 'SENT' }, { ...invoiceFixture(), privateEmail: 'private' },
      { ...invoiceFixture(), evidence: invoiceFixture().evidence.map((entry) => ({ ...entry, providerVerified: true })) },
      { ...invoiceFixture(), lines: invoiceFixture().lines.map((line) => line.lineKind === 'ACCOUNT_CREDIT' ? { ...line, amountMinor: 10000 } : line) },
      { ...invoiceFixture(), settlement: { ...invoiceFixture().settlement, state: 'PAID_VERIFIED', verifiedNetMinor: 4510 } },
    ];
    for (const value of bad) { fetch.mockResolvedValue(ok(value)); await expect(loadHqInvoiceAccount(invoiceId(1))).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' }); }
    for (const value of [null, [], { data: invoiceFixture(), role: 'OWNER' }]) { fetch.mockResolvedValue({ ok: true, json: async () => value } as Response); await expect(loadHqInvoiceAccount(invoiceId(1))).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' }); }
  });
  it('binds B4 eligibility/request scope and never exposes unrelated global-window refund records', async () => {
    const fetch = mocks(); const data = await loadHqInvoiceRefunds(invoiceFixture()); expect(data.matchingRequests).toHaveLength(1);
    const html = renderToStaticMarkup(<InvoiceRefundResults data={data} invoiceId={invoiceId(1)}/>); expect(html).toContain('SYNTHETIC-CUSTOMER-REQUEST'); expect(html).not.toContain('UNRELATED-PRIVATE-REFUND-REFERENCE'); expect(html).toContain('not complete invoice or school history'); expect(html).not.toMatch(/<button|<form/);
    for (const scope of ['eligibility', 'request', 'verified', 'execution']) { const r = invoiceRefundFixture();
      if (scope === 'eligibility') r.eligibility.organizationId = saasId(2);
      else if (scope === 'request') r.requests.refundRequests.find((v) => v.invoiceId === invoiceId(1))!.subscriptionId = saasId(999);
      else if (scope === 'verified') r.eligibility.evidenceStrength = 'PROVIDER_VERIFIED';
      else r.requests.refundRequests[0]!.executionStatus = 'EXECUTED' as never;
      fetch.mockImplementation(async (path) => ok(String(path).endsWith('/refunds') ? r.requests : r.eligibility)); await expect(loadHqInvoiceRefunds(invoiceFixture())).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    }
  });
  it('handles network/JSON failure privately and propagates aborted reads', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('private network')); await expect(loadHqInvoiceList(null)).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
    fetch.mockResolvedValue({ ok: true, json: async () => { throw Error('private body'); } } as unknown as Response); await expect(loadHqInvoiceAccount(invoiceId(1))).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    const controller = new AbortController(); controller.abort(); const abort = Error('abort'); fetch.mockRejectedValue(abort); await expect(loadHqInvoiceAccount(invoiceId(1), controller.signal)).rejects.toBe(abort);
  });
  it('renders exact signed authoritative amounts, lifetime and empty states without financial commands', () => {
    expect(invoiceAmount(-10001)).toBe('−USD 100.01'); expect(invoiceAmount(-1)).toBe('−USD 0.01'); expect(invoiceAmount(null)).toBe('Unavailable / tax unresolved'); expect(invoiceAmount(Number.MAX_SAFE_INTEGER)).toBe('USD 90,071,992,547,409.91');
    const detail = renderToStaticMarkup(<InvoiceDetailResults data={invoiceAccountFixture()}/>); for (const text of ['−USD 100.00', 'USD 45.10', 'USD 15.00', 'HQ attestation', 'not processor', 'CHARGEBACK', 'Subscription account-credit adjustment']) expect(detail.toLowerCase()).toContain(text.toLowerCase()); expect(detail).not.toMatch(/<button|<form/);
    const lifetime = renderToStaticMarkup(<InvoiceDetailResults data={invoiceAccountFixture(3)}/>); expect(lifetime).toContain('One-time paid-lifetime offer'); expect(lifetime).toContain('USD 1,896.00'); expect(lifetime).toContain('Reversed in recorded evidence');
    const empty = renderToStaticMarkup(<InvoiceDetailResults data={invoiceAccountFixture(1, { empty: true })}/>); expect(empty).toContain('No payment-evidence entries'); expect(empty).toContain('No subscription status-history events');
    const list = renderToStaticMarkup(<InvoiceListResults data={invoiceListFixture()} organizationId={saasId(3)} query=""/>); expect(list).toContain('HON Harbor'); expect(list).not.toContain('HON Cedar');
    expect(renderToStaticMarkup(<InvoiceListResults data={invoiceListFixture({ empty: true })} organizationId="" query=""/>)).toContain('No invoice records');
  });
  it('distinguishes first-purchase previews and incomplete request history from approval or execution', async () => {
    const fetch = mocks(4); const data = await loadHqInvoiceRefunds(invoiceFixture(4)); expect(data.matchingRequests).toHaveLength(0);
    const html = renderToStaticMarkup(<InvoiceRefundResults data={data} invoiceId={invoiceId(4)}/>); expect(html).toContain('A different invoice'); expect(html).toContain('Complete refund history is unavailable'); expect(html).toContain('not record a customer request'); expect(fetch).toHaveBeenCalledTimes(2);
    const r = invoiceRefundFixture(1, { empty: true }); const empty = renderToStaticMarkup(<InvoiceRefundResults data={{ eligibility: r.eligibility, matchingRequests: [], limit: 200 }} invoiceId={invoiceId(1)}/>); expect(empty).toContain('No recorded paid purchase');
  });
  it('keeps route selectors inert, shared HQ authentication intact and approved appearance labels separate', () => {
    const fetch = vi.spyOn(globalThis, 'fetch'); const html = renderToStaticMarkup(<><HqInvoiceHistory/><HqInvoiceDetail invoiceId={invoiceId(1)}/></>); expect(fetch).not.toHaveBeenCalled(); expect(html).toContain('Load invoice and payment history'); expect(html).not.toContain('HON Cedar');
    expect(renderToStaticMarkup(<HqInvoiceDetail invoiceId="../refunds"/>)).toContain('Invalid invoice selector'); expect(fetch).not.toHaveBeenCalled();
    for (const file of ['src/app/hq/revenue/invoices/page.tsx', 'src/app/hq/revenue/invoices/[invoiceId]/page.tsx']) { const source = readFileSync(file, 'utf8'); expect(source).toContain("'force-dynamic'"); expect(source).toContain('index: false'); expect(source).not.toMatch(/fetch\(|process\.env|schoolId|role:/); }
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')); for (const path of ['/hq/revenue/invoices', '/hq/revenue/invoices/[invoiceId]']) expect(manifest.routes.filter((r: { path: string }) => r.path === path)).toHaveLength(1);
    expect(hqPageLabel(`/hq/revenue/invoices/${invoiceId(1)}`)).toBe('Invoice detail'); expect(hqPageLabel(`/hq/revenue/invoices/${invoiceId(1)}?role=OWNER`)).toBe('HQ workspace');
  });
});
