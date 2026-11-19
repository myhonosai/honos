const { test } = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('@hon/contracts');
const adapter = require('../dist/commerce/shopify/shopify-adapter.js');
const { runShopifySync } = require('../dist/commerce/shopify/shopify-sync-engine.js');
const { ShopifyWorkerSql } = require('../dist/commerce/shopify/shopify-worker.js');

// SH-F1 (0597) Shopify finance: everything here is local (the fake store, parsed sample answers). Nothing calls Shopify.
const SHOP = 'ima-finance.myshopify.com';
const CONN = '22222222-2222-4222-8222-222222222222';
const SECRET = 's'.repeat(40);

const ACCOUNT = {
  activated: true,
  balance: [{ amount: '245.18', currencyCode: 'USD' }, { amount: '-3.5', currencyCode: 'CAD' }],
  payouts: { nodes: [{ id: 'gid://shopify/ShopifyPaymentsPayout/725076685', status: 'PAID', transactionType: 'DEPOSIT', issuedAt: '2026-11-18T05:00:00Z',
    net: { amount: '128.31', currencyCode: 'USD' } }] },
  balanceTransactions: { nodes: [{ id: 'gid://shopify/ShopifyPaymentsBalanceTransaction/854848137', type: 'TRANSFER', test: false,
    transactionDate: '2026-11-18T05:00:00Z', amount: { amount: '-41.9', currencyCode: 'USD' }, fee: { amount: '0.0' }, net: { amount: '-41.9' },
    associatedPayout: { id: 'gid://shopify/ShopifyPaymentsPayout/725076685', status: 'PAID' } },
  { id: 'gid://shopify/ShopifyPaymentsBalanceTransaction/854848138', type: 'CHARGE', test: true, transactionDate: '2026-11-17T01:02:03.456Z',
    amount: { amount: '140.73', currencyCode: 'USD' }, fee: { amount: '4.38123' }, net: { amount: '136.35' }, associatedPayout: { id: null } }] },
};

test('SH-F1 the Shopify Payments answer becomes ids, statuses, instants and signed amounts only', () => {
  const f = adapter.financeFromAccount(ACCOUNT);
  assert.deepEqual(f, {
    paymentsActive: true,
    balances: [{ currency: 'USD', amount: '245.18' }, { currency: 'CAD', amount: '-3.5' }],
    payouts: [{ id: '725076685', status: 'PAID', direction: 'DEPOSIT', issuedAt: '2026-11-18T05:00:00.000Z', currency: 'USD', net: '128.31' }],
    transactions: [
      { id: '854848137', type: 'TRANSFER', at: '2026-11-18T05:00:00.000Z', currency: 'USD', amount: '-41.9', fee: '0.0', net: '-41.9', test: false, payoutId: '725076685' },
      { id: '854848138', type: 'CHARGE', at: '2026-11-17T01:02:03.456Z', currency: 'USD', amount: '140.73', fee: '4.3812', net: '136.35', test: true, payoutId: null }],
  });
  assert.deepEqual(contracts.verifyShopifyFinanceSnapshot(f), f, 'the contract accepts exactly what the adapter makes');
  assert.deepEqual(adapter.financeFromAccount(null), { paymentsActive: false, balances: [], payouts: [], transactions: [] }, 'no account: payments off');
  assert.equal(adapter.financeFromAccount({ ...ACCOUNT, activated: false }).paymentsActive, false);
  for (const [why, bad] of [
    ['payout gid of another type', { ...ACCOUNT, payouts: { nodes: [{ ...ACCOUNT.payouts.nodes[0], id: 'gid://shopify/Order/1' }] } }],
    ['unknown payout status', { ...ACCOUNT, payouts: { nodes: [{ ...ACCOUNT.payouts.nodes[0], status: 'LOST' }] } }],
    ['money that is not a decimal', { ...ACCOUNT, balance: [{ amount: '1e3', currencyCode: 'USD' }] }],
    ['repeated transaction', { ...ACCOUNT, balanceTransactions: { nodes: [ACCOUNT.balanceTransactions.nodes[0], ACCOUNT.balanceTransactions.nodes[0]] } }],
    ['lower-case type', { ...ACCOUNT, balanceTransactions: { nodes: [{ ...ACCOUNT.balanceTransactions.nodes[0], type: 'charge' }] } }],
  ]) assert.throws(() => adapter.financeFromAccount(bad), e => e instanceof adapter.ShopifyProviderError && e.failure === 'INVALID_RESPONSE', why);
});

test('SH-F1 the snapshot and view contracts are closed', () => {
  const f = adapter.financeFromAccount(ACCOUNT);
  for (const bad of [{ ...f, extra: 1 }, { ...f, paymentsActive: false }, { ...f, balances: [f.balances[0], f.balances[0]] },
    { ...f, payouts: [{ ...f.payouts[0], net: '1.23456' }] }, { ...f, transactions: [{ ...f.transactions[0], payoutId: 'gid' }] }])
    assert.throws(() => contracts.verifyShopifyFinanceSnapshot(bad), /SHOPIFY_RESPONSE_INVALID/);
  const view = { schoolId: CONN, connected: true, financeAllowed: true, currency: 'USD', finance: { ...f, readAt: '2026-11-19T05:00:00.000Z' } };
  assert.equal(contracts.verifyShopifyFinanceView(view).finance.readAt, '2026-11-19T05:00:00.000Z');
  assert.throws(() => contracts.verifyShopifyFinanceView({ ...view, connected: false }), /SHOPIFY_RESPONSE_INVALID/);
  assert.throws(() => contracts.verifyShopifyFinanceView({ ...view, finance: { ...view.finance, readAt: 'yesterday' } }), /SHOPIFY_RESPONSE_INVALID/);
  assert.equal(contracts.verifyShopifyFinanceView({ ...view, financeAllowed: false, finance: null }).finance, null);
  // Connecting: Allow finance is a separate, optional, boolean switch next to Allow editing.
  const base = { schoolId: CONN, shopDomain: SHOP };
  assert.deepEqual(contracts.validateShopifyConnectInput(base), { ...base, allowEditing: false, allowFinance: false });
  assert.deepEqual(contracts.validateShopifyConnectInput({ ...base, allowEditing: true, allowFinance: true }), { ...base, allowEditing: true, allowFinance: true });
  assert.throws(() => contracts.validateShopifyConnectInput({ ...base, allowFinance: 'yes' }), /SHOPIFY_INPUT_INVALID/);
  assert.throws(() => contracts.validateShopifyConnectInput({ ...base, allowPayouts: true }), /SHOPIFY_INPUT_INVALID/);
  assert.deepEqual([...contracts.SHOPIFY_FINANCE_SCOPES], ['read_shopify_payments_accounts']);
});

async function syncWith(scopes, setup = () => {}) {
  const app = adapter.shopifyAppFromEnvironment({ HON_SHOPIFY_FAKE: '1' });
  const tokens = await app.adapter.exchangeCode(SHOP, new URLSearchParams(app.fake.approve(SHOP, 'S', undefined, scopes)).get('code'));
  setup(app);
  const pair = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, accessExpiresAt: tokens.accessExpiresAt, refreshExpiresAt: tokens.refreshExpiresAt };
  const b = { syncId: 'sync', connectionId: CONN, shopDomain: SHOP, credential: { keyId: app.vault.keyId, sealed: app.vault.seal({ connectionId: CONN, shopDomain: SHOP }, pair), version: 1 } };
  const recorded = [];
  const out = await runShopifySync(app, Date.now, b, {
    rotate: async () => ({}), page: async () => ({}),
    finance: async body => { recorded.push(body.finance); return {}; },
    finish: async (outcome, failureCode) => ({ outcome, failureCode }),
  });
  return { out, recorded, app };
}

test('SH-F1 a sync reads finance after orders when the store allowed it; finance never fails a sync', async () => {
  const allowed = await syncWith([...contracts.SHOPIFY_SCOPES, ...contracts.SHOPIFY_FINANCE_SCOPES]);
  assert.deepEqual(allowed.out, { outcome: 'SUCCEEDED', failureCode: null });
  assert.equal(allowed.recorded.length, 1);
  assert.deepEqual(allowed.recorded[0].balances, [{ currency: 'USD', amount: '245.18' }]);
  assert.deepEqual(allowed.app.fake.calls.filter(c => !c.startsWith('exchange')), ['catalog:' + SHOP, 'orders:' + SHOP, 'finance:' + SHOP]);
  // Not granted: Shopify refuses the read (ACCESS_DENIED), nothing is recorded and the sync still succeeds.
  const notAllowed = await syncWith(contracts.SHOPIFY_SCOPES);
  assert.deepEqual([notAllowed.out.outcome, notAllowed.recorded.length], ['SUCCEEDED', 0]);
  // A refused token on the finance read still ends the connection as Needs reconnect.
  const revoked = await syncWith([...contracts.SHOPIFY_SCOPES, ...contracts.SHOPIFY_FINANCE_SCOPES], app => {
    const finance = app.adapter.finance.bind(app.adapter);
    app.adapter.finance = async (...a) => { app.fake.rejectTokens(SHOP); return finance(...a); };
  });
  assert.deepEqual([revoked.out.outcome, revoked.out.failureCode, revoked.recorded.length], ['NEEDS_RECONNECT', 'TOKEN_REJECTED', 0]);
});

test('SH-F1 the worker records finance only through its lease function', async () => {
  const seen = [];
  const store = new ShopifyWorkerSql(async (sql, values) => { seen.push([sql, values]); return [{ data: { ok: true } }]; });
  await store.finance({ syncId: 's', leaseToken: 'l', finance: { paymentsActive: false, balances: [], payouts: [], transactions: [] } });
  assert.deepEqual(seen.map(s => s[0]), ['SELECT hon.record_shopify_background_finance($1::jsonb) AS data']);
});
