import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GRANT_NOTE_MS, rememberGrant, shopifyGrantUrl, takeGrant } from '../src/components/school-shopify/grant';
import { id } from './account-status-fixtures';
import { SHOPIFY_FINANCE_SCOPES } from '@hon/contracts';

// Allow finance / Allow orders: Shopify grants optional permissions only on its own request page (checked on the test
// store 2026-11-22), so the button goes there first and the Commerce page finishes with the usual approval.
const school = id(2), SHOP = 'ima-test.myshopify.com', CLIENT = '0123456789abcdef0123456789abcdef';
const authorize = `https://${SHOP}/admin/oauth/authorize?client_id=${CLIENT}&scope=read_products&state=s`;
let store: Map<string, string>;
beforeEach(() => {
  store = new Map();
  vi.stubGlobal('window', { sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } } });
});
afterEach(() => { vi.unstubAllGlobals(); });

it('builds Shopify\'s request page from the approval address, and nothing for any other address', () => {
  expect(shopifyGrantUrl(authorize, SHOP, ['read_shopify_payments_accounts']))
    .toBe(`https://admin.shopify.com/store/ima-test/oauth/install?client_id=${CLIENT}&optional_scopes=read_shopify_payments_accounts`);
  expect(shopifyGrantUrl(authorize, SHOP, SHOPIFY_FINANCE_SCOPES)).toContain('optional_scopes=read_shopify_payments_accounts%2Cread_shopify_payments_payouts');
  expect(shopifyGrantUrl(authorize, SHOP, ['write_orders', 'read_shopify_payments_accounts'])).toContain('optional_scopes=write_orders%2Cread_shopify_payments_accounts');
  // Development: the fake sends the browser straight to HON's return page, so there is no first hop.
  expect(shopifyGrantUrl('https://app.hon.test/staff/billing/shopify/return?code=c&state=s', SHOP, ['write_orders'])).toBeNull();
  for (const bad of [authorize.replace(SHOP, 'evil.example'), authorize.replace('https:', 'http:'), authorize.replace('/admin/oauth/authorize', '/admin/other'),
    authorize.replace(CLIENT, 'x'), 'not a url']) expect(shopifyGrantUrl(bad, SHOP, ['write_orders'])).toBeNull();
  expect(shopifyGrantUrl(authorize, SHOP, [])).toBeNull();
  expect(shopifyGrantUrl(authorize, SHOP, ['write orders&x=1'])).toBeNull();
  expect(shopifyGrantUrl(authorize.replace(SHOP, 'ima-test.example.com'), 'ima-test.example.com', ['write_orders'])).toBeNull();
});

it('keeps the owed second hop for ten minutes, for the same school and shop, and uses it once', () => {
  expect(rememberGrant('allowFinance', school, SHOP, 1000)).toBe(true);
  expect(takeGrant(school, SHOP, 2000)).toBe('allowFinance');
  expect(takeGrant(school, SHOP, 2000)).toBeNull();
  rememberGrant('allowOrders', school, SHOP, 1000);
  expect(takeGrant(school, SHOP, 1000 + GRANT_NOTE_MS + 1)).toBeNull();
  expect(store.size).toBe(0);
  rememberGrant('allowOrders', school, SHOP, 1000);
  expect(takeGrant(id(3), SHOP, 2000)).toBeNull();
  rememberGrant('allowOrders', school, SHOP, 1000);
  expect(takeGrant(school, 'other.myshopify.com', 2000)).toBeNull();
  rememberGrant('allowStock', school, SHOP, 1000);
  expect(takeGrant(school, SHOP, 2000)).toBe('allowStock');
  rememberGrant('allowOrders', school, SHOP, 5000);
  expect(takeGrant(school, SHOP, 2000)).toBeNull();
  for (const raw of ['{', '[]', JSON.stringify({ action: 'connect', schoolId: school, shopDomain: SHOP, at: 1000 }), 'x'.repeat(500)]) {
    store.set('hon.shopify.grant', raw);
    expect(takeGrant(school, SHOP, 2000)).toBeNull();
    expect(store.size).toBe(0);
  }
});

it('says so when the browser cannot keep the note, so the caller skips the first hop', () => {
  vi.stubGlobal('window', { sessionStorage: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => undefined } });
  expect(rememberGrant('allowFinance', school, SHOP)).toBe(false);
  expect(takeGrant(school, SHOP)).toBeNull();
});
