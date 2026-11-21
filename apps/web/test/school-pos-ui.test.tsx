import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PosItem, PosRead, PosSale, PosShopify, PosShopifyItem } from '@hon/contracts';
import { PosError, posApi, posErrorFor, keepPosForRetry } from '../src/components/school-pos/http';
import { EMPTY_CART, addItem, addQuick, addShopify, cartTotals, changeDue, formatMoney, parseMoney, percentToBps, refreshCart, saleInput, setQuantity } from '../src/components/school-pos/model';
import { PosHistory, PosInventory, PosRegister, Receipt, SaleShopifyNote, itemInput } from '../src/components/school-pos/views';
import { id } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const school = id(2), key = id(77);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as PosError; } throw new Error('expected a failure'); };
const item = (n: number, o: Partial<PosItem> = {}): PosItem => ({ itemId: id(100 + n), name: 'Item ' + n, sku: null, category: 'UNIFORMS', priceMinor: 10000, taxable: true,
  trackStock: true, stock: 5, lowStockAt: 2, lowStock: false, active: true, version: 1, ...o });
const NO_SHOP: PosShopify = { state: 'NOT_CONNECTED', shopName: null, items: [], unsent: { waiting: 0, failed: 0 } };
const variant = (n: number, o: Partial<PosShopifyItem> = {}): PosShopifyItem => ({ variantId: String(7000 + n), productId: String(900 + n), name: 'Dojo tee - M', sku: 'TEE-M', priceMinor: 2500, tracked: true, stock: 3, imageUrl: null, ...o });
const shop = (o: Partial<PosShopify> = {}): PosShopify => ({ state: 'READY', shopName: 'Synthetic Dojo Shop', items: [variant(1), variant(2, { name: 'Gift card', sku: null, tracked: false, stock: null })], unsent: { waiting: 0, failed: 0 }, ...o });
const read = (o: Partial<PosRead> = {}): PosRead => ({ schoolId: school, timezone: 'America/Los_Angeles', today: '2026-11-16', canManage: true,
  settings: { currency: 'USD', taxRateBps: 825, version: 1 }, items: [item(1), item(2, { name: 'Belt test', category: 'TESTING', priceMinor: 7500, taxable: false, trackStock: false, stock: null, lowStockAt: null })],
  todaySales: { count: 2, totalMinor: 30000 }, shopify: NO_SHOP, ...o });
const sale: PosSale = { saleId: id(300), receiptNumber: 'POS-20261116-0001', soldAt: '2026-11-16T18:00:00.000Z', localDate: '2026-11-16', customer: { personId: id(30), name: 'Mina Park' },
  firstItem: 'Item 1', itemCount: 2, currency: 'USD', totalMinor: 21650, refundedMinor: 0, method: 'CASH', status: 'PAID', schoolName: 'Synthetic Dojo', soldBy: 'Front desk',
  lines: [{ lineId: id(301), itemId: id(101), name: 'Item 1', sku: null, category: 'UNIFORMS', unitPriceMinor: 10000, quantity: 2, lineTotalMinor: 20000, taxable: true, stockTracked: true, restockedQuantity: 0, shopifyVariantId: null }],
  subtotalMinor: 20000, discount: null, taxRateBps: 825, taxMinor: 1650, reference: null, note: null, refunds: [], shopifyStock: { waiting: 0, done: 0, failed: 0 } };

it('builds the cart like the front desk does and sends the total the screen shows', () => {
  let cart = addItem(addItem(EMPTY_CART, item(1)), item(1));
  cart = addItem(cart, read().items[1] as PosItem);
  cart = addQuick(cart, id(9), 'Parents night', 1500);
  expect(cart.lines.map(l => l.quantity)).toEqual([2, 1, 1]);
  cart = { ...cart, discount: { kind: 'PERCENT', value: 10, reason: 'Family' } };
  expect(cartTotals(cart, 825)).toEqual({ subtotalMinor: 29000, discountMinor: 2900, taxMinor: 1485, totalMinor: 27585 });
  const input = saleInput(school, { ...cart, customer: { kind: 'WALK_IN', name: '  Guest  ' } }, 825, 'CASH', '', ' ');
  expect(input).toMatchObject({ personId: null, walkInName: 'Guest', reference: null, note: null, expectedTotalMinor: 27585 });
  expect(input.lines[2]).toEqual({ description: 'Parents night', unitPriceMinor: 1500, quantity: 1 });
  expect(setQuantity(cart, id(101), 0).lines).toHaveLength(2);
  // A price change or a removed item is taken into the cart before paying.
  const updated = refreshCart(cart, [item(1, { priceMinor: 12000 })]);
  expect(updated.lines.map(l => l.unitPriceMinor)).toEqual([12000, 1500]);
});

it('reads money the way staff type it and refuses anything else', () => {
  expect(parseMoney('12.5', 'USD')).toBe(1250); expect(parseMoney('$1,200.00', 'USD')).toBe(120000); expect(parseMoney('12.345', 'USD')).toBeNull();
  expect(parseMoney('-1', 'USD')).toBeNull(); expect(parseMoney('5000', 'KRW')).toBe(5000); expect(parseMoney('50.5', 'JPY')).toBeNull();
  expect(formatMoney(27585, 'USD')).toBe('$275.85'); expect(percentToBps('8.25')).toBe(825); expect(percentToBps('30')).toBeNull();
  expect(changeDue(2500, 3000)).toBe(500); expect(changeDue(2500, 2000)).toBeNull();
});

it('reads the register as a plain same-origin GET and refuses another school', async () => {
  const f = stub(json({ data: read() }));
  expect((await posApi.read(school.toUpperCase(), signal(), () => true)).items).toHaveLength(2);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/school/schools/${school}/pos`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
  stub(json({ data: read({ schoolId: id(3) }) }));
  expect((await fails(posApi.read(school, signal(), () => true))).kind).toBe('UNKNOWN');
});

it('sends a sale as one closed body with the POS command and the key, and maps refusals', async () => {
  const f = stub(json({ data: { sale, replayed: false } }));
  const input = saleInput(school, addItem(EMPTY_CART, item(1)), 825, 'CARD_TERMINAL', '4242', '');
  expect((await posApi.command({ op: 'sale', input }, key, signal(), () => true)).replayed).toBe(false);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/school/pos/sales');
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': 'school-pos', 'Idempotency-Key': key, 'Content-Type': 'application/json' });
  expect(JSON.parse(init.body as string)).toEqual(input);
  expect(posErrorFor(409, { code: 'POS_TOTAL_CHANGED', detail: 'Prices changed.' })).toMatchObject({ kind: 'CHANGED', detail: 'Prices changed.' });
  expect(posErrorFor(409, { code: 'POS_KEY_REUSED' }).kind).toBe('INVALID');
  expect(posErrorFor(500, null).kind).toBe('UNKNOWN');
  expect(keepPosForRetry(new PosError('UNKNOWN'))).toBe(true); expect(keepPosForRetry(new PosError('CHANGED'))).toBe(false);
  const g = stub(json({}));
  expect((await fails(posApi.command({ op: 'sale', input: { ...input, extra: 1 } as never }, key, signal(), () => true))).kind).toBe('INVALID');
  expect(g).not.toHaveBeenCalled();
});

it('shows the register with tiles, stock left, the sale panel and the total to take', () => {
  const html = renderToStaticMarkup(<PosRegister read={read()} cart={addItem(EMPTY_CART, item(1))} receipt={null} outcome={null} locked={false} canRetry={false} found={null}
    onCart={() => {}} onSearchPeople={() => {}} onClearFound={() => {}} onNewSale={() => {}} onPay={() => {}} onTryAgain={() => {}}/>);
  for (const text of ['Item 1', '$100.00', '4 left', 'Belt test', 'Quick amount', 'Walk-in', 'Sales tax (8.25%)', 'Card (our terminal)', 'Take $108.25', 'Today: $300.00 from 2 sales'])
    expect(html).toContain(text);
  const done = renderToStaticMarkup(<PosRegister read={read()} cart={EMPTY_CART} receipt={sale} outcome={{ kind: 'DONE', op: 'sale' }} locked={false} canRetry={false} found={null}
    onCart={() => {}} onSearchPeople={() => {}} onClearFound={() => {}} onNewSale={() => {}} onPay={() => {}} onTryAgain={() => {}}/>);
  for (const text of ['Paid.', 'POS-20261116-0001', 'Mina Park', '2 × Item 1', '$216.50', 'New sale', 'Print receipt']) expect(done).toContain(text);
});

it('shows inventory with the low-stock alert, and only managers get edit and stock buttons', () => {
  const r = read({ items: [item(1, { stock: 1, lowStock: true })] });
  const manager = renderToStaticMarkup(<PosInventory read={r} outcome={null} locked={false} canRetry={false} onRun={() => {}} onTryAgain={() => {}}/>);
  expect(manager).toContain('Low stock:'); expect(manager).toContain('Item 1 (1)'); expect(manager).toContain('Add product'); expect(manager).toContain('One more Item 1 in stock');
  const cashier = renderToStaticMarkup(<PosInventory read={{ ...r, canManage: false }} outcome={null} locked={false} canRetry={false} onRun={() => {}} onTryAgain={() => {}}/>);
  expect(cashier).not.toContain('Add product'); expect(cashier).not.toContain('One more Item 1 in stock'); expect(cashier).toContain('Only managers');
  expect(itemInput(school, { itemId: null, version: null, name: ' Shoe ', sku: 'EQ-SH', category: 'EQUIPMENT', price: '60', taxable: true, trackStock: true, stock: '20', lowStockAt: '3', active: true }, 'USD'))
    .toEqual({ schoolId: school, itemId: null, expectedVersion: null, name: 'Shoe', sku: 'EQ-SH', category: 'EQUIPMENT', priceMinor: 6000, taxable: true, trackStock: true, lowStockAt: 3, startingStock: 20, active: true });
  expect(itemInput(school, { itemId: null, version: null, name: 'Shoe', sku: 'bad sku', category: 'EQUIPMENT', price: '60', taxable: true, trackStock: false, stock: '0', lowStockAt: '', active: true }, 'USD')).toBeNull();
});

it('prints refunds on the receipt', () => {
  const html = renderToStaticMarkup(<Receipt read={read()} sale={{ ...sale, refundedMinor: 10000, status: 'PARTLY_REFUNDED', refunds: [{ refundId: id(400), refundedAt: '2026-11-16T19:00:00.000Z', amountMinor: 10000, method: 'CASH', reason: 'Wrong size', restocked: [], refundedBy: 'Owner' }] }}/>);
  expect(html).toContain('Wrong size'); expect(html).toContain('−$100.00');
});

// ---- 0613: Shopify products at the register ----
const registerHtml = (r: PosRead, extra: Partial<React.ComponentProps<typeof PosRegister>> = {}) => renderToStaticMarkup(<PosRegister read={r} cart={EMPTY_CART} receipt={null} outcome={null} locked={false}
  canRetry={false} found={null} onCart={() => {}} onSearchPeople={() => {}} onClearFound={() => {}} onNewSale={() => {}} onPay={() => {}} onTryAgain={() => {}} {...extra}/>);

it('puts a Shopify product in the cart by its variant, taxed, and sends only the variant and quantity', () => {
  let cart = addShopify(addShopify(addItem(EMPTY_CART, item(1)), variant(1)), variant(1));
  expect(cart.lines.map(l => [l.kind, l.quantity])).toEqual([['ITEM', 1], ['SHOPIFY', 2]]);
  expect(cartTotals(cart, 1000)).toEqual({ subtotalMinor: 15000, discountMinor: 0, taxMinor: 1500, totalMinor: 16500 });
  expect(saleInput(school, cart, 1000, 'CASH', '', '').lines).toEqual([{ itemId: id(101), quantity: 1 }, { shopifyVariantId: '7001', quantity: 2 }]);
  cart = setQuantity(cart, 'shopify:7001', 5);
  expect(cart.lines[1]?.quantity).toBe(5);
  // A new Shopify price is taken before paying; a product no longer for sale leaves the cart.
  expect(refreshCart(cart, [item(1)], [variant(1, { priceMinor: 3000 })]).lines.map(l => l.unitPriceMinor)).toEqual([10000, 3000]);
  expect(refreshCart(cart, [item(1)], []).lines).toHaveLength(1);
});

it('lists Shopify products under the school name, never blocks a sale on the Shopify count, and explains a store it cannot sell from', () => {
  const html = registerHtml(read({ shopify: shop({ items: [variant(1, { stock: 0 }), variant(2, { name: 'Gift card', sku: null, tracked: false, stock: null })] }) }));
  for (const text of ['From your Shopify store: Synthetic Dojo Shop', 'Dojo tee - M', '$25.00', 'Shopify shows none left', 'Gift card', 'Online store']) expect(html).toContain(text);
  expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*data-category="SHOPIFY"|data-category="SHOPIFY"[^>]*disabled=""/);
  expect(registerHtml(read())).not.toContain('Shopify');
  expect(registerHtml(read({ shopify: shop({ state: 'NEEDS_EDITING', items: [] }) }))).toContain('connected for reading only');
  expect(registerHtml(read({ shopify: shop({ state: 'CURRENCY_MISMATCH', items: [] }) }))).toContain('different currency');
  expect(registerHtml(read({ items: [], shopify: shop() }))).not.toContain('No products yet');
});

it('says when Shopify stock is behind; only a manager gets Send again', () => {
  const behind = read({ shopify: shop({ unsent: { waiting: 1, failed: 2 } }) });
  const manager = registerHtml(behind);
  expect(manager).toContain('3 stock changes have not reached Shopify yet'); expect(manager).toContain('The sales are saved here.'); expect(manager).toContain('Send again');
  const cashier = registerHtml({ ...behind, canManage: false });
  expect(cashier).not.toContain('Send again'); expect(cashier).toContain('Ask a manager to send them again.');
  expect(registerHtml(behind, { stockSend: 'SENDING' })).toContain('Sending…');
  expect(registerHtml(behind, { stockSend: 'LEFT' })).toContain('still did not go through');
  expect(registerHtml(read({ shopify: shop() }), { stockSend: 'DONE' })).toContain('Shopify is up to date.');
  expect(registerHtml(read({ shopify: shop() }))).not.toContain('Shopify stock is behind');
});

it('asks for the stock changes again as one POS command for the exact school and reads the answer', async () => {
  const f = stub(json({ data: read({ shopify: shop() }) }));
  expect((await posApi.resendShopifyStock(school.toUpperCase(), signal(), () => true)).shopify.state).toBe('READY');
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/school/pos/shopify-stock');
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': 'school-pos' });
  expect(JSON.parse(init.body as string)).toEqual({ schoolId: school });
  stub(json({ code: 'POS_FORBIDDEN' }, 403));
  expect((await fails(posApi.resendShopifyStock(school, signal(), () => true))).kind).toBe('DENIED');
  stub(json({ data: read({ schoolId: id(3) }) }));
  expect((await fails(posApi.resendShopifyStock(school, signal(), () => true))).kind).toBe('UNKNOWN');
});

it('shows what happened to Shopify stock under a receipt, on the register and in history', () => {
  const line = { ...sale.lines[0]!, lineId: id(302), itemId: null, name: 'Dojo tee - M', category: 'SHOPIFY' as const, shopifyVariantId: '7001' };
  const sold: PosSale = { ...sale, lines: [line] };
  expect(renderToStaticMarkup(<SaleShopifyNote sale={sale}/>)).toBe('');
  expect(renderToStaticMarkup(<SaleShopifyNote sale={{ ...sold, shopifyStock: { waiting: 0, done: 1, failed: 0 } }}/>)).toContain('Shopify stock is updated');
  expect(renderToStaticMarkup(<SaleShopifyNote sale={{ ...sold, shopifyStock: { waiting: 1, done: 0, failed: 0 } }}/>)).toContain('still being sent');
  expect(renderToStaticMarkup(<SaleShopifyNote sale={{ ...sold, shopifyStock: { waiting: 0, done: 0, failed: 1 } }}/>)).toContain('was not updated');
  const history = renderToStaticMarkup(<PosHistory read={read()} range={null} sales={{ state: 'IDLE' }} selected={{ ...sold, shopifyStock: { waiting: 0, done: 1, failed: 0 } }} outcome={null} locked={false}
    canRetry={false} onRange={() => {}} onOpen={() => {}} onClose={() => {}} onRun={() => {}} onTryAgain={() => {}}/>);
  expect(history).toContain('2 × Dojo tee - M'); expect(history).toContain('Shopify stock is updated for this sale.');
});
