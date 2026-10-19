/** Synthetic localhost transport and actual production-UI checks. No application import. */
import assert from 'node:assert/strict';
import { validateSaasInvoiceDetail, validateSaasInvoiceList, validateSaasInvoiceStatusFilter, validateSaasOrganizationSubscription, validateSaasPaymentStanding, validateSaasRefundEligibility, validateSaasRefundRequestList } from '@hon/contracts';
import { invoiceId, saasId, invoiceListFixture, invoiceAccountFixture, invoiceRefundFixture } from './fixtures/hq-invoice-history.mjs';

export const invoiceState = { enabled: false, list: 'ready', detail: 'ready', refund: 'ready', updated: false, delay: 0 };
const root = '/v1/hq/saas/';
const invoicePaths = [1, 2, 3, 4, 5].map((id) => `${root}invoices/${invoiceId(id)}`);
const eligibilityPaths = [1, 2, 3].map((id) => `${root}organizations/${saasId(id)}/refund-eligibility`);
const accountPaths = [1, 2, 3].flatMap((id) => ['subscription', 'payment-standing'].map((resource) => `${root}organizations/${saasId(id)}/${resource}`));
export const isInvoiceFixturePath = (path) => [`${root}invoices`, `${root}refunds`, ...invoicePaths, ...eligibilityPaths].includes(path) || invoiceState.enabled && accountPaths.includes(path);
export function respondInvoiceFixture(request, response, url) {
  const resource = url.pathname.split('/').at(-1), isList = resource === 'invoices';
  const isRefund = resource === 'refunds' || resource === 'refund-eligibility';
  const isInvoice = invoicePaths.includes(url.pathname);
  let status = null;
  try {
    if (request.method !== 'GET' || request.headers['content-length'] && request.headers['content-length'] !== '0') throw Error();
    if (!isList) { if (url.search) throw Error(); }
    else { if ([...url.searchParams.keys()].some((key) => key !== 'status') || url.searchParams.getAll('status').length > 1) throw Error(); status = validateSaasInvoiceStatusFilter(url.searchParams.get('status') ?? undefined); }
  } catch { response.writeHead(400); response.end('{}'); return; }
  const mode = isList ? invoiceState.list : isRefund ? invoiceState.refund : invoiceState.detail;
  if (['401', '403', '503'].includes(mode) || mode === `${isInvoice ? 'invoice' : resource}-denied`) {
    response.writeHead(mode.endsWith('-denied') ? 403 : Number(mode)); response.end('{"private":"private-invoice-failure"}'); return;
  }
  const selected = isInvoice ? [1, 2, 3, 4, 5].find((id) => invoiceId(id) === resource) : [1, 2, 3].find((id) => saasId(id) === url.pathname.split('/')[5]) ?? 1;
  const account = invoiceAccountFixture(selected, { updated: invoiceState.updated, empty: invoiceState.detail === 'empty', historical: mode === 'historical' });
  const refund = invoiceRefundFixture(selected, { updated: invoiceState.updated, empty: mode === 'empty' });
  const data = isList ? validateSaasInvoiceList(invoiceListFixture({ status, updated: invoiceState.updated, empty: mode === 'empty' }))
    : isInvoice ? validateSaasInvoiceDetail(account.invoice) : resource === 'subscription' ? validateSaasOrganizationSubscription(account.account)
    : resource === 'payment-standing' ? validateSaasPaymentStanding(account.standing) : resource === 'refund-eligibility' ? validateSaasRefundEligibility(refund.eligibility)
    : validateSaasRefundRequestList(refund.requests);
  const changed = mode === 'malformed' ? { ...data, privateNote: 'private-invoice-failure' }
    : isInvoice && mode === 'wrong-invoice' ? { ...data, invoiceId: invoiceId(2) }
    : isInvoice && mode === 'cross-evidence' ? { ...data, evidence: data.evidence.map((e) => ({ ...e, invoiceId: invoiceId(2) })) }
    : isInvoice && mode === 'collection-enabled' ? { ...data, collection: 'ENABLED' }
    : resource === 'subscription' && mode === 'wrong-organization' ? { ...data, organizationId: saasId(2) }
    : resource === 'payment-standing' && mode === 'subscription-race' ? { ...data, subscriptionId: saasId(999) }
    : resource === 'refund-eligibility' && mode === 'wrong-organization' ? { ...data, organizationId: saasId(2) }
    : resource === 'refunds' && mode === 'wrong-request' ? { ...data, refundRequests: data.refundRequests.map((r) => r.invoiceId === invoiceId(1) ? { ...r, subscriptionId: saasId(999) } : r) }
    : resource === 'refunds' && mode === 'execution-drift' ? { ...data, execution: 'AVAILABLE' }
    : resource === 'refunds' && mode === 'no-matches' ? { ...data, refundRequests: [] } : data;
  const body = mode === 'invalid-json' ? 'unreadable' : JSON.stringify({ data: changed });
  const finish = () => { if (!response.destroyed) response.end(body); };
  if (invoiceState.delay) setTimeout(finish, invoiceState.delay); else finish();
}

const reset = () => Object.assign(invoiceState, { enabled: true, list: 'ready', detail: 'ready', refund: 'ready', updated: false, delay: 0 });
export async function verifyInvoiceViewport({ page, origin, label, check, screenshot, noOverflow, accessibility }) {
  reset();
  try {
    await check(`${label}: real invoice navigation, closed status and bounded organization/search filters`, async () => {
      await page.goto(`${origin}/hq/revenue`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('link', { name: 'Review HON invoices & payment history →', exact: true }).click();
      await page.locator('[data-invoice-list]').waitFor();
      assert.equal(new URL(page.url()).pathname, '/hq/revenue/invoices');
      await page.goto(`${origin}/hq/revenue/invoices?status=VOID&organizationId=${saasId(3)}&schoolId=untrusted&role=OWNER`, { waitUntil: 'domcontentloaded' });
      await page.locator('[data-invoice-list]').waitFor(); assert.equal(await page.getByLabel('Invoice status', { exact: true }).inputValue(), '');
      await page.getByLabel('Invoice status', { exact: true }).selectOption('DRAFT'); await page.locator('[data-invoice-list]').waitFor();
      assert.equal(await page.locator('[data-invoice-list] a').count(), 1); await page.getByText('Unnumbered draft record', { exact: true }).waitFor();
      await page.getByLabel('Invoice status', { exact: true }).selectOption(''); await page.locator('[data-invoice-list]').waitFor();
      await page.getByLabel('Billing organization in returned invoices', { exact: true }).selectOption(saasId(3));
      assert.equal(await page.locator('[data-invoice-list] a').count(), 1); await page.getByText('Recorded total: USD 1,896.00', { exact: true }).waitFor();
      await page.getByLabel('Billing organization in returned invoices', { exact: true }).selectOption('');
      await page.getByLabel('Search returned invoice records', { exact: true }).fill('no-match'); await page.getByText('No invoice records in the returned window match this selection.', { exact: true }).waitFor();
      await page.getByLabel('Search returned invoice records', { exact: true }).fill('');
      for (const name of ['Big Button', 'Classic', 'Modern']) { await page.getByRole('group', { name: 'Platform view' }).getByRole('button', { name, exact: true }).click(); await noOverflow(page, `${label} invoice list ${name}`); }
      await screenshot(page, `${label}-invoice-list`); await accessibility(page, `${label}-invoice-list`);
    });
    await check(`${label}: explicit invoice detail, signed adjustments, evidence/refund strength and HON controls`, async () => {
      const reads = []; const listener = (r) => { if (/\/api\/v1\/hq\/saas\/(invoices\/|organizations\/|refunds)/.test(r.url())) reads.push(r.url()); };
      page.on('request', listener);
      try {
        await page.getByRole('link', { name: 'Review HON-2026-000001 for HON Cedar Organization · fixture', exact: true }).click();
        await page.getByRole('button', { name: 'Load invoice and payment history', exact: true }).waitFor();
        assert.equal(reads.length, 0, 'Route selection alone must not read invoice or organization facts');
        await page.getByRole('button', { name: 'Load invoice and payment history', exact: true }).focus(); await page.keyboard.press('Enter');
        await page.locator('[data-invoice-detail]').waitFor(); await page.locator('[data-invoice-refunds]').waitFor();
        await page.waitForFunction(() => document.activeElement?.textContent === 'Verified invoice records');
        const heading = await page.getByRole('heading', { name: 'Verified invoice records', exact: true }).boundingBox();
        assert(heading && heading.y >= 18 && heading.y + heading.height < page.viewportSize().height - 64, 'Loaded detail heading must be visible above navigation');
        await page.getByText('−USD 100.00', { exact: true }).waitFor(); await page.getByRole('heading', { name: 'Chargeback — recorded evidence', exact: true }).waitFor();
        await page.getByRole('heading', { name: 'Approved record · not executed', exact: true }).waitFor();
        assert.equal(await page.getByText('UNRELATED-PRIVATE-REFUND-REFERENCE', { exact: true }).count(), 0);
        assert.equal(await page.getByRole('button', { name: /charge|collect|activate|reserve|publish|fulfill|approve|issue refund/i }).count(), 0);
        await noOverflow(page, `${label} invoice detail`);
        if (label === 'mobile') await screenshot(page, 'mobile-invoice-viewport', false, true);
        const identifiers = page.getByText('Record identifiers', { exact: true }); await identifiers.focus(); await page.keyboard.press('Enter');
        await page.getByText(invoiceId(1), { exact: true }).waitFor(); await page.keyboard.press('Enter');
        await screenshot(page, `${label}-invoice-detail`); await accessibility(page, `${label}-invoice-detail`);
        await page.getByRole('button', { name: page.viewportSize().width <= 600 ? 'Expand HON assistant' : 'Ask HON anywhere', exact: true }).click();
        const assistant = page.getByRole(page.viewportSize().width <= 800 ? 'dialog' : 'complementary', { name: 'HON assistant', exact: true });
        await assistant.getByText('Current page: Invoice detail', { exact: true }).waitFor(); assert(await assistant.getByRole('button', { name: /^Send unavailable/ }).isDisabled());
        await assistant.getByRole('button', { name: 'Minimize HON assistant' }).click(); await assistant.waitFor({ state: 'detached' });
      } finally { page.off('request', listener); }
    });
  } finally { invoiceState.enabled = false; }
}

export async function verifyInvoiceStates({ contextFor, origin, check, delay }) {
  const c = await contextFor({ width: 390, height: 844 }); const page = c.page; reset();
  const list = async () => { await page.goto(`${origin}/hq/revenue/invoices`, { waitUntil: 'domcontentloaded' }); await page.locator('[data-invoice-list]').waitFor(); };
  const detail = async (id = 1) => { await page.goto(`${origin}/hq/revenue/invoices/${invoiceId(id)}?organizationId=${saasId(999)}&role=OWNER`, { waitUntil: 'domcontentloaded' }); await page.getByRole('button', { name: 'Load invoice and payment history', exact: true }).click(); await page.locator('[data-invoice-detail]').waitFor(); await page.locator('[data-invoice-refunds]').waitFor(); };
  try {
    await check('Invoice list refresh and every denied/invalid/empty response clear old records', async () => {
      for (const mode of ['401', '403', '503', 'malformed', 'invalid-json']) {
        invoiceState.list = 'ready'; await list(); invoiceState.list = mode; await page.getByRole('button', { name: 'Refresh invoices', exact: true }).click();
        await page.getByRole('heading', { name: /Sign in to review HON billing records|HON billing access denied|Invoice list could not be verified|Invoice list unavailable/ }).waitFor();
        assert.equal(await page.locator('[data-invoice-list]').count(), 0); assert.equal(await page.getByText(/private-invoice-failure/).count(), 0);
      }
      invoiceState.list = 'empty'; await list(); await page.getByText('No invoice records in the returned window match this selection.', { exact: true }).waitFor(); invoiceState.list = 'ready';
    });
    await check('Invoice/core reads independently fail closed on denial, evidence/scope drift and subscription races', async () => {
      for (const mode of ['invoice-denied', 'subscription-denied', 'payment-standing-denied', '401', '503', 'malformed', 'invalid-json', 'wrong-invoice', 'cross-evidence', 'wrong-organization', 'subscription-race', 'collection-enabled']) {
        invoiceState.detail = 'ready'; await detail(); invoiceState.detail = mode; await page.getByRole('button', { name: 'Refresh invoice records', exact: true }).click();
        await page.getByRole('heading', { name: /Sign in to review HON billing records|HON billing access denied|Invoice records could not be verified|Invoice records unavailable/ }).waitFor();
        assert.equal(await page.locator('[data-invoice-detail]').count(), 0); assert.equal(await page.locator('[data-invoice-refunds]').count(), 0); assert.equal(await page.getByText(/private-invoice-failure/).count(), 0);
      }
      invoiceState.detail = 'ready';
    });
    await check('Refund reads deny independently and never masquerade a bounded matching window as full history', async () => {
      for (const mode of ['refunds-denied', 'refund-eligibility-denied', 'wrong-organization', 'wrong-request', 'execution-drift', 'malformed', 'invalid-json']) {
        invoiceState.refund = 'ready'; await detail(); invoiceState.refund = mode; await page.getByRole('button', { name: 'Refresh invoice records', exact: true }).click(); await page.locator('[data-invoice-detail]').waitFor();
        await page.getByRole('heading', { name: /HON billing access denied|Refund review could not be verified/ }).waitFor(); assert.equal(await page.locator('[data-invoice-refunds]').count(), 0);
        assert.equal(await page.getByText(/private-invoice-failure|UNRELATED-PRIVATE-REFUND-REFERENCE/).count(), 0);
      }
      invoiceState.refund = 'no-matches'; await detail(); await page.getByText('No matching refund-request records in the returned global window. Complete refund history is unavailable.', { exact: true }).waitFor(); invoiceState.refund = 'ready';
    });
    await check('Invoice refresh retrieves changed official evidence and navigation discards delayed facts', async () => {
      await detail(); invoiceState.updated = true; invoiceState.delay = 450;
      await page.getByRole('button', { name: 'Refresh invoice records', exact: true }).click(); assert.equal(await page.locator('[data-invoice-detail]').count(), 0); assert.equal(await page.locator('[data-invoice-refunds]').count(), 0);
      await page.getByText('SYNTHETIC-REFRESH-PAYMENT', { exact: true }).waitFor();
      assert.equal(await page.locator('[data-invoice-detail] dt').filter({ hasText: /^Recorded balance$/ }).locator('..').locator('dd').textContent(), 'USD 10.00');
      await page.getByRole('button', { name: 'Refresh invoice records', exact: true }).click(); await page.getByRole('link', { name: '← Invoice list', exact: true }).click(); await page.locator('[data-invoice-list]').waitFor(); await delay(1100);
      assert.equal(await page.locator('[data-invoice-detail]').count(), 0); assert.equal(await page.locator('[data-invoice-refunds]').count(), 0); invoiceState.delay = 0; invoiceState.updated = false;
    });
    await check('Draft tax, empty evidence, lifetime reversals and historical subscription facts remain distinct', async () => {
      invoiceState.detail = 'empty'; invoiceState.refund = 'empty'; await detail(); await page.getByText('No payment-evidence entries were returned for this invoice. Its settlement state is reported above.', { exact: true }).waitFor(); await page.getByText('No recorded paid purchase', { exact: true }).first().waitFor();
      invoiceState.detail = 'ready'; invoiceState.refund = 'ready'; await detail(4); await page.getByText('A different invoice; this invoice does not restart the window', { exact: true }).waitFor(); await page.getByText('Unavailable / tax unresolved', { exact: true }).first().waitFor();
      await detail(3); await page.getByRole('heading', { name: 'Refund evidence recorded · not executed by HON', exact: true }).waitFor(); await page.getByText('Reversed in recorded evidence', { exact: true }).waitFor();
      invoiceState.detail = 'historical'; await detail(); await page.getByText('Invoice is not the current subscription record', { exact: true }).waitFor(); invoiceState.detail = 'ready';
      await page.goto(`${origin}/hq/revenue/invoices/not-a-uuid`, { waitUntil: 'domcontentloaded' }); await page.getByText('Invalid invoice selector. Choose a record from the authorized invoice list.', { exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: 'Load invoice and payment history', exact: true }).count(), 0);
    });
    await check('Every invoice/refund read independently rejects staff, family, support, non-billing HQ and unsigned sessions', async () => {
      const paths = [`${root}invoices`, `${root}invoices/${invoiceId(1)}`, `${root}organizations/${saasId(1)}/subscription`, `${root}organizations/${saasId(1)}/payment-standing`, eligibilityPaths[0], `${root}refunds`];
      for (const [authenticated, subject, status] of [[true, 'hon-school-fixture', 403], [true, 'hon-family-fixture', 403], [true, 'hon-support-fixture', 403], [true, 'hon-hq-no-billing-fixture', 403], [false, 'unused', 401], [true, 'hon-hq-operator-fixture', 200]]) {
        const actor = await contextFor({ width: 390, height: 844 }, authenticated, 'reduce', subject);
        try { for (const path of paths) assert.equal((await actor.context.request.get(`${origin}/api${path}`)).status(), status); } finally { await actor.context.close(); }
      }
    });
  } finally { reset(); invoiceState.enabled = false; await c.context.close(); }
}
