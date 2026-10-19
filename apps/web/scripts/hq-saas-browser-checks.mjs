/** Temporary synthetic transport and actual-browser checks; not application code. */
import assert from 'node:assert/strict';
import {
  validateSaasCatalogView, validateSaasSubscriptionList, validateSaasSubscriptionStatusFilter, validateSaasCreditProgramView,
  validateSaasOrganizationSubscription, validateSaasPaymentStanding, validateSaasOrganizationCredits,
} from '@hon/contracts';
import { saasId, saasOverviewFixture, saasAccountFixture } from './fixtures/hq-saas-review.mjs';

export const saasState = { overview: 'ready', account: 'ready', delay: 0, updated: false };
const fixed = ['/v1/hq/saas/catalog', '/v1/hq/saas/subscriptions', '/v1/hq/saas/credits'];
const accountPaths = [1, 2, 3, 4].flatMap((id) => ['subscription', 'payment-standing', 'credits'].map((resource) => `/v1/hq/saas/organizations/${saasId(id)}/${resource}`));
export const isSaasFixturePath = (path) => fixed.includes(path) || accountPaths.includes(path);
export function respondSaasFixture(request, response, url) {
  const isAccount = url.pathname.includes('/organizations/');
  const resource = url.pathname.split('/').at(-1);
  let status = null;
  try {
    if (request.method !== 'GET' || request.headers['content-length'] && request.headers['content-length'] !== '0') throw Error();
    if (resource !== 'subscriptions') { if (url.search) throw Error(); }
    else {
      if ([...url.searchParams.keys()].some((key) => key !== 'status') || url.searchParams.getAll('status').length > 1) throw Error();
      status = validateSaasSubscriptionStatusFilter(url.searchParams.get('status') ?? undefined);
    }
  } catch { response.writeHead(400); response.end('{}'); return; }
  const mode = isAccount ? saasState.account : saasState.overview;
  if (['401', '403', '503'].includes(mode) || mode === `${resource}-denied`) {
    response.writeHead(mode.endsWith('-denied') ? 403 : Number(mode)); response.end('{"private":"private-billing-note"}'); return;
  }
  const o = saasOverviewFixture({ status, empty: mode === 'empty', updated: saasState.updated });
  const a = saasAccountFixture({ organizationId: url.pathname.split('/')[5], empty: mode === 'empty', updated: saasState.updated, mismatch: mode === 'alignment' });
  const data = isAccount ? resource === 'subscription' ? validateSaasOrganizationSubscription(a.subscription)
    : resource === 'payment-standing' ? validateSaasPaymentStanding(a.standing) : validateSaasOrganizationCredits(a.credits)
    : resource === 'catalog' ? validateSaasCatalogView(o.catalog) : resource === 'subscriptions' ? validateSaasSubscriptionList(o.subscriptions) : validateSaasCreditProgramView(o.credits);
  const body = mode === 'invalid-json' ? 'unreadable' : JSON.stringify({ data: mode === 'malformed' ? { ...data, privateNote: 'private-billing-note' }
    : isAccount && mode === 'wrong-org' ? { ...data, organizationId: saasId(2) }
    : isAccount && mode === 'subscription-race' && resource !== 'subscription' ? { ...data, subscriptionId: saasId(999) } : data });
  const finish = () => { if (!response.destroyed) response.end(body); };
  if (saasState.delay) setTimeout(finish, saasState.delay); else finish();
}

export async function verifySaasViewport({ page, origin, label, check, screenshot, noOverflow, accessibility }) {
  await check(`${label}: real subscription overview, founder inventory, status/search and private evidence`, async () => {
    Object.assign(saasState, { overview: 'ready', account: 'ready', delay: 0, updated: false });
    const calls = [];
    const listener = (request) => { if (request.url().includes('/api/v1/hq/saas/organizations/')) calls.push(request.url()); };
    page.on('request', listener);
    try {
      await page.goto(`${origin}/hq/revenue?organizationId=${saasId(1)}&status=SUSPENDED&role=OWNER`, { waitUntil: 'domcontentloaded' });
      await page.locator('[data-saas-inventory]').waitFor();
      assert.equal(await page.getByLabel('Subscription status', { exact: true }).inputValue(), '');
      assert.equal(calls.length, 0, 'URL values must not select an organization');
      await page.getByText('Paid founder lifetime', { exact: true }).first().waitFor();
      assert.equal(await page.locator('[data-founder-available="monthly"]').textContent(), '26');
      const costs = page.getByText('Verified provider-cost evidence and premium program', { exact: true });
      await costs.focus(); await page.keyboard.press('Enter'); await page.getByText('USD 50.000000', { exact: true }).waitFor();
      await noOverflow(page, `${label} provider evidence`); await page.keyboard.press('Enter');
      await page.getByLabel('Subscription status', { exact: true }).selectOption('SUSPENDED');
      await page.locator('[data-saas-inventory]').waitFor();
      assert.equal(await page.getByRole('button', { name: /^Review HON .* account$/ }).count(), 1);
      assert.equal(await page.locator('[data-founder-available="monthly"]').textContent(), '26');
      await page.getByLabel('Subscription status', { exact: true }).selectOption(''); await page.locator('[data-saas-inventory]').waitFor();
      await page.getByLabel('Find organization in returned records', { exact: true }).fill('does-not-match');
      await page.getByText('No subscription records in the returned window match this selection.', { exact: true }).waitFor();
      await page.getByLabel('Find organization in returned records', { exact: true }).fill('');
      for (const name of ['Big Button', 'Classic', 'Modern']) { await page.getByRole('group', { name: 'Platform view' }).getByRole('button', { name, exact: true }).click(); await noOverflow(page, `${label} subscriptions ${name}`); }
      await costs.focus(); await page.keyboard.press('Enter'); await page.getByText('USD 50.000000', { exact: true }).waitFor();
      await screenshot(page, `${label}-subscription-overview`);
      await accessibility(page, `${label}-subscription-overview`);
    } finally { page.off('request', listener); }
  });
  await check(`${label}: selected organization entitlements, payment strength, AI balances and keyboard controls`, async () => {
    await page.getByRole('button', { name: 'Review HON Cedar Organization · fixture account', exact: true }).focus(); await page.keyboard.press('Enter');
    await page.locator(`[data-saas-account="${saasId(1)}"]`).waitFor();
    assert(await page.getByRole('heading', { name: 'Selected organization', exact: true }).evaluate((node) => node === document.activeElement));
    await page.locator('[data-saas-account] dd').filter({ hasText: /^3,800$/ }).waitFor();
    await page.getByRole('heading', { name: 'Provider-verified standing', exact: true }).waitFor();
    await page.getByText(/Provider usage cost not recorded/, { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: /charge|collect|grant|activate|reserve|publish|resolve|purchase|refund/i }).count(), 0);
    await noOverflow(page, `${label} subscription account`);
    const heading = await page.getByRole('heading', { name: 'Selected organization', exact: true }).boundingBox();
    assert(heading && heading.y >= 18 && heading.y + heading.height < (page.viewportSize().height - 64), 'Selected account heading must be visible above mobile navigation after keyboard entry');
    if (label === 'mobile') await screenshot(page, 'mobile-subscription-viewport', false, true);
    await screenshot(page, `${label}-subscription-account`);
    await accessibility(page, `${label}-subscription-account`);
    await page.getByRole('button', { name: 'Close account review', exact: true }).click();
    assert.equal(await page.locator('[data-saas-account]').count(), 0);
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Review HON Cedar Organization · fixture account');
  });
}

export async function verifySaasStates({ contextFor, origin, check, delay }) {
  const c = await contextFor({ width: 390, height: 844 }); const page = c.page;
  const open = async () => { await page.goto(`${origin}/hq/revenue`, { waitUntil: 'domcontentloaded' }); await page.locator('[data-saas-inventory]').waitFor(); };
  const select = async () => { await page.getByRole('button', { name: 'Review HON Cedar Organization · fixture account', exact: true }).click(); await page.locator('[data-saas-account]').waitFor(); };
  try {
    await check('Billing overview refresh/filter clears facts and selection, ignoring delayed organization reads', async () => {
      Object.assign(saasState, { overview: 'ready', account: 'ready', updated: false, delay: 0 }); await open(); await select();
      saasState.updated = true; saasState.delay = 600;
      await page.getByRole('button', { name: 'Refresh account records', exact: true }).click(); assert.equal(await page.locator('[data-saas-account]').count(), 0);
      await page.locator('[data-saas-account] dd').filter({ hasText: /^3,700$/ }).waitFor();
      await page.getByRole('button', { name: 'Refresh account records', exact: true }).click();
      await page.getByLabel('Subscription status', { exact: true }).selectOption('SUSPENDED');
      await page.locator('[data-saas-inventory]').waitFor(); await delay(750); assert.equal(await page.locator('[data-saas-account]').count(), 0);
      assert.equal(await page.locator('[data-founder-available="monthly"]').textContent(), '25');
      saasState.delay = 0; saasState.updated = false;
    });
    await check('Billing independent overview failures remove inventory, records and cost evidence without private error bodies', async () => {
      for (const mode of ['401', '403', '503', 'catalog-denied', 'subscriptions-denied', 'credits-denied', 'malformed', 'invalid-json']) {
        saasState.overview = 'ready'; await open(); await select(); saasState.overview = mode;
        await page.getByRole('button', { name: 'Refresh subscription overview', exact: true }).click();
        await page.getByRole('heading', { name: mode === '401' ? 'Sign in to review HON subscriptions' : mode === '403' || mode.endsWith('-denied') ? 'HON billing access denied' : mode === '503' ? 'HON subscription records unavailable' : 'Subscription records could not be verified', exact: true }).waitFor();
        assert.equal(await page.locator('[data-saas-account], [data-saas-inventory]').count(), 0); assert(!(await page.locator('body').innerText()).includes('private-billing-note'));
      }
    });
    await check('Billing account failures, wrong organizations and changing current subscriptions clear scoped facts', async () => {
      saasState.overview = 'ready';
      for (const mode of ['401', '403', '503', 'subscription-denied', 'payment-standing-denied', 'credits-denied', 'wrong-org', 'subscription-race', 'malformed', 'invalid-json']) {
        saasState.account = 'ready'; await open(); await select(); saasState.account = mode;
        await page.getByRole('button', { name: 'Refresh account records', exact: true }).click();
        await page.getByRole('heading', { name: mode === '401' ? 'Sign in to review HON subscriptions' : mode === '403' || mode.endsWith('-denied') ? 'HON billing access denied' : mode === '503' ? 'HON subscription records unavailable' : 'Subscription records could not be verified', exact: true }).waitFor();
        assert.equal(await page.locator('[data-saas-account]').count(), 0); assert(!(await page.locator('body').innerText()).includes('private-billing-note'));
      }
    });
    await check('Billing empty and mismatched entitlement records stay explicit; no allowances or costs are invented', async () => {
      saasState.overview = 'empty'; saasState.account = 'ready'; await open();
      await page.getByText('No subscription records in the returned window match this selection.', { exact: true }).waitFor();
      assert.equal(await page.locator('[data-founder-available="monthly"]').textContent(), 'Unavailable / undecided');
      saasState.overview = 'ready'; saasState.account = 'empty'; await open(); await select();
      await page.getByText('No current subscription', { exact: true }).waitFor(); await page.getByText('No allowance records were returned. A planned catalog allowance is not a granted balance.', { exact: true }).waitFor();
      saasState.account = 'alignment'; await page.getByRole('button', { name: 'Refresh account records', exact: true }).click(); await page.locator('dd').filter({ hasText: /^MISMATCH/ }).waitFor();
    });
    await check('Every billing read independently denies school, family, support, non-billing HQ and unsigned sessions', async () => {
      saasState.overview = 'ready'; saasState.account = 'ready';
      const paths = [...fixed, ...accountPaths.filter((p) => p.includes(saasId(1)))].map((p) => `/api${p}`);
      for (const subject of ['hon-school-fixture', 'hon-family-fixture', 'hon-support-fixture', 'hon-hq-no-billing-fixture']) {
        const denied = await contextFor({ width: 390, height: 844 }, true, 'reduce', subject);
        try { for (const path of paths) assert.equal((await denied.context.request.get(`${origin}${path}`)).status(), 403); } finally { await denied.context.close(); }
      }
      for (const [authenticated, subject, status] of [[false, 'unused', 401], [true, 'hon-hq-operator-fixture', 200]]) {
        const actor = await contextFor({ width: 390, height: 844 }, authenticated, 'reduce', subject);
        try { for (const path of paths) assert.equal((await actor.context.request.get(`${origin}${path}`)).status(), status); } finally { await actor.context.close(); }
      }
    });
  } finally { Object.assign(saasState, { overview: 'ready', account: 'ready', updated: false, delay: 0 }); await c.context.close(); }
}
