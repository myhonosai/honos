const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ParentInvoicePayService } = require('../dist/parent-pay/parent-invoice-pay.service.js');
const { verifyParentInvoicePayments, verifyParentInvoicePayStart, verifyParentInvoicePayResult } = require('@hon/contracts');

const INV = '11111111-1111-4111-8111-111111111111';
const PAY = '22222222-2222-4222-8222-222222222222';
const row = (over = {}) => ({ invoiceId: INV, participantName: 'Mina Park', status: 'ISSUED', currency: 'USD', totalMinor: 12000, balanceMinor: 10000,
  dueAt: '2026-12-01T20:00:00.000Z', payState: 'NONE', autopayInProgress: false, ...over });

function fakes({ list, latest = { paymentId: null, state: null }, open = { paymentId: PAY, amountMinor: 10000, currency: 'USD' }, supports = true, confirm = 'OPEN', fail } = {}) {
  const calls = [];
  const database = { async runParentInvoicePayCall(statement, values) {
    calls.push([statement, values]);
    if (fail) throw fail;
    if (statement.includes('read_parent_invoice_payments')) return list ?? { providerCode: 'STRIPE_CONNECT', invoices: [row()] };
    if (statement.includes('read_parent_invoice_payment(')) return latest;
    return open;
  } };
  const once = {
    supports: () => supports,
    start: async (id, input) => { calls.push(['start', id, input]); return { url: 'https://checkout.stripe.test/pay/cs_1', expiresAt: '2026-12-01T20:30:00.000Z' }; },
    confirm: async (id) => { calls.push(['confirm', id]); return { paymentId: id, state: confirm, amountMinor: 10000, currency: 'USD', settledAt: null }; },
    cancel: async (id) => { calls.push(['cancel', id]); return { paymentId: id, state: 'CANCELED', amountMinor: 10000, currency: 'USD', settledAt: null }; },
  };
  return { service: new ParentInvoicePayService(database, once), calls };
}

test('parent invoice list: no payment id, provider or account reaches the app; payable only when the school can take a hosted card payment', async () => {
  const { service } = fakes();
  const list = await service.list('subject-1');
  assert.deepEqual(list, { canPay: true, testMode: true, invoices: [{ invoiceId: INV, childName: 'Mina Park', currency: 'USD', totalMinor: 12000, balanceMinor: 10000,
    dueAt: '2026-12-01T20:00:00.000Z', payState: 'NONE', payable: true }] });
  assert.doesNotMatch(JSON.stringify(list), /STRIPE|providerCode|paymentId|acct_/);
  assert.equal((await fakes({ supports: false }).service.list('s')).invoices[0].payable, false);
  assert.equal((await fakes({ list: { providerCode: null, invoices: [row()] } }).service.list('s')).canPay, false);
  for (const over of [{ payState: 'PROCESSING' }, { payState: 'SUCCEEDED' }, { autopayInProgress: true }, { balanceMinor: 0 }]) {
    assert.equal((await fakes({ list: { providerCode: 'STRIPE_CONNECT', invoices: [row(over)] } }).service.list('s')).invoices[0].payable, false, JSON.stringify(over));
  }
  await assert.rejects(fakes({ list: { providerCode: 'PAYPAL', invoices: [] } }).service.list('s'));
});

test('start: the payment id comes only from the database; a hosted page returns to the fixed HON page', async () => {
  process.env.HON_PUBLIC_ORIGIN = 'https://app.example.test';
  const { service, calls } = fakes();
  const page = await service.start('subject-1', INV);
  assert.deepEqual(page, { state: 'OPEN', url: 'https://checkout.stripe.test/pay/cs_1', expiresAt: '2026-12-01T20:30:00.000Z', amountMinor: 10000, currency: 'USD' });
  assert.deepEqual(calls.find((c) => c[0] === 'start'), ['start', PAY, { surface: 'HOSTED', returnUrl: 'https://app.example.test/parent/payment-return' }]);
  assert.ok(calls.filter((c) => typeof c[0] === 'string' && c[0].startsWith('SELECT')).every(([, values]) => values[0] === 'subject-1'));
  await assert.rejects(service.start('subject-1', 'not-a-uuid'), (e) => e.getStatus() === 400);
  process.env.HON_PUBLIC_ORIGIN = 'http://evil.example.test';
  const unconfigured = fakes();
  await assert.rejects(unconfigured.service.start('s', INV), (e) => e.getResponse().code === 'PARENT_INVOICE_PAY_NOT_CONFIGURED');
  assert.equal(unconfigured.calls.length, 0, 'an unconfigured return page is refused before anything is read or opened');
  process.env.HON_PUBLIC_ORIGIN = 'https://app.example.test';
});

test('start: an open or clearing payment is checked at the processor first and never doubled', async () => {
  const paid = fakes({ latest: { paymentId: PAY, state: 'OPEN' }, confirm: 'SUCCEEDED' });
  assert.deepEqual(await paid.service.start('s', INV), { state: 'SUCCEEDED', url: null, expiresAt: null, amountMinor: 10000, currency: 'USD' });
  assert.ok(!paid.calls.some((c) => c[0] === 'start') && !paid.calls.some((c) => String(c[0]).includes('open_parent')));
  const stale = fakes({ latest: { paymentId: PAY, state: 'OPEN' }, confirm: 'EXPIRED' });
  assert.equal((await stale.service.start('s', INV)).state, 'OPEN');
  assert.ok(stale.calls.some((c) => String(c[0]).includes('open_parent')));
});

test('confirm and cancel act only on the latest payment of the parent\'s own invoice', async () => {
  assert.deepEqual(await fakes().service.confirm('s', INV), { state: 'NONE' });
  const f = fakes({ latest: { paymentId: PAY, state: 'OPEN' }, confirm: 'SUCCEEDED' });
  assert.deepEqual(await f.service.confirm('s', INV), { state: 'SUCCEEDED' });
  assert.deepEqual(await f.service.cancel('s', INV), { state: 'CANCELED' });
  assert.deepEqual(f.calls.filter((c) => c[0] === 'confirm' || c[0] === 'cancel').map((c) => c[1]), [PAY, PAY]);
  await assert.rejects(fakes({ latest: { paymentId: 'x', state: 'OPEN' } }).service.confirm('s', INV));
});

test('database refusals map to closed codes; anything else is unavailable, never success', async () => {
  const err = (message, code) => Object.assign(new Error(message), { code });
  const cases = [[err('PARENT_INVOICE_PAY_NOT_FOUND', 'P0002'), 404, 'PARENT_INVOICE_PAY_NOT_FOUND'], [err('PARENT_INVOICE_PAY_FORBIDDEN', '42501'), 403, 'PARENT_INVOICE_PAY_FORBIDDEN'],
    [err('PARENT_INVOICE_PAY_NOT_PAYABLE', '40001'), 409, 'PARENT_INVOICE_PAY_NOT_PAYABLE'], [err('SCHOOL_PAY_ONCE_EXISTS', '40001'), 409, 'PARENT_INVOICE_PAY_IN_PROGRESS'],
    [err('boom', 'XX000'), 503, 'PARENT_INVOICE_PAY_UNAVAILABLE']];
  for (const [fail, status, code] of cases) {
    await assert.rejects(fakes({ fail }).service.list('s'), (e) => e.getStatus() === status && e.getResponse().code === code);
  }
});

test('contracts: closed shapes only', () => {
  assert.throws(() => verifyParentInvoicePayments({ canPay: true, testMode: false, invoices: [] }));
  assert.throws(() => verifyParentInvoicePayments({ canPay: false, testMode: true, invoices: [{ invoiceId: INV, childName: 'A', currency: 'USD', totalMinor: 1, balanceMinor: 1, dueAt: null, payState: 'NONE', payable: true }] }));
  assert.throws(() => verifyParentInvoicePayStart({ state: 'OPEN', url: 'http://x.test', expiresAt: '2026-12-01T20:30:00.000Z', amountMinor: 1, currency: 'USD' }));
  assert.throws(() => verifyParentInvoicePayStart({ state: 'SUCCEEDED', url: 'https://x.test', expiresAt: null, amountMinor: 1, currency: 'USD' }));
  assert.throws(() => verifyParentInvoicePayResult({ state: 'PAID' }));
  assert.deepEqual(verifyParentInvoicePayResult({ state: 'FAILED' }), { state: 'FAILED' });
});
