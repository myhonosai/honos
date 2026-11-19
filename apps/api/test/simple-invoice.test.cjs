const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SimpleInvoiceService, translateSimpleInvoiceError } = require('../dist/billing/simple-invoice.service.js');

// SI1 (0540): the service runs one protected definer function per call, checks the answer strictly and maps refusals.
const ORG = '11111111-1111-4111-8111-111111111111', SCHOOL = '22222222-2222-4222-8222-222222222222';
const INV = '33333333-3333-4333-8333-333333333333', ACCOUNT = '44444444-4444-4444-8444-444444444444', PERSON = '55555555-5555-4555-8555-555555555555';
const input = { billingAccountId: ACCOUNT, dueDate: '2026-12-03', issue: true, items: [{ description: 'Monthly tuition', quantity: 1, unitAmountMinor: 12900 }, { description: 'Belt test fee', quantity: 2, unitAmountMinor: 500 }] };
const detail = (invoice = {}, over = {}) => ({
  invoice: { invoiceId: INV, billingAccountId: ACCOUNT, membershipId: null, payerName: 'Jordan Rivera', status: 'ISSUED', version: 2, currency: 'USD', totalMinor: 13900, paidMinor: 0,
    balanceMinor: 13900, dueAt: '2026-12-04T07:59:59.000Z', overdue: false, createdAt: '2026-11-19T05:00:00.000Z', ...invoice },
  number: '33333333', localToday: '2026-11-18', timezone: 'America/Los_Angeles', canIssue: true,
  items: [{ position: 1, description: 'Monthly tuition', quantity: 1, unitAmountMinor: 12900, amountMinor: 12900 }, { position: 2, description: 'Belt test fee', quantity: 2, unitAmountMinor: 500, amountMinor: 1000 }],
  note: null, billTo: { personId: PERSON, name: 'Jordan Rivera', email: null, phone: null }, from: { schoolName: 'Example Dojo', addressLines: [], phone: null, email: null },
  howToPay: { inApp: false, otherWays: null }, ...over });
const context = (over = {}) => ({ organizationId: ORG, schoolId: SCHOOL, principalId: PERSON, principalType: 'HUMAN_USER', requestId: INV, correlationId: INV,
  idempotencyKey: 'key-1', source: 'HUMAN_UI', externalSubject: 'staff-subject', ...over });
function fakes(answer) {
  const calls = [];
  const client = { async query(sql, values) { calls.push([sql, values]); if (/hon\.(create_simple_invoice|read_school_invoice_detail)/.test(sql)) { if (answer instanceof Error) throw answer; return { rows: [{ data: answer }] }; } return { rows: [] }; } };
  const database = { withTenantTransaction: async (_c, fn) => fn(client), withTenantReadOnlyTransaction: async (_c, fn) => fn(client) };
  return { service: new SimpleInvoiceService(database), calls };
}
const status = (e) => e.getStatus();
const code = (e) => e.getResponse().code;

test('create: one definer call with the subject, the checked input and the key; a new invoice must match the request exactly', async () => {
  const { service, calls } = fakes({ receipt: detail(), replayed: false });
  const result = await service.create(context(), input);
  assert.equal(result.replayed, false); assert.equal(result.invoice.invoice.totalMinor, 13900);
  const call = calls.find(([sql]) => sql.includes('create_simple_invoice'));
  assert.deepEqual([call[1][0], JSON.parse(call[1][1]), ...call[1].slice(2)], ['staff-subject', input, 'key-1', INV, INV]);
  for (const bad of [detail({ totalMinor: 14000, balanceMinor: 14000 }, { items: [{ position: 1, description: 'Monthly tuition', quantity: 1, unitAmountMinor: 14000, amountMinor: 14000 }] }),
    detail({ status: 'DRAFT', version: 1 }), detail({}, { note: 'surprise' })]) {
    await assert.rejects(fakes({ receipt: bad, replayed: false }).service.create(context(), input), (e) => code(e) === 'SIMPLE_INVOICES_UNAVAILABLE');
  }
  // A replay shows the invoice as it is now (already paid here) and is accepted.
  const paid = await fakes({ receipt: detail({ status: 'PAID', paidMinor: 13900, balanceMinor: 0, version: 3 }), replayed: true }).service.create(context(), input);
  assert.equal(paid.replayed, true);
  await assert.rejects(fakes({ receipt: detail(), replayed: false, extra: 1 }).service.create(context(), input), (e) => code(e) === 'SIMPLE_INVOICES_UNAVAILABLE');
});

test('create: refuses before any database call when the input, key or human context is wrong', async () => {
  for (const [ctx, value, expected] of [[context(), { ...input, items: [] }, 'VALIDATION_FAILED'], [context({ idempotencyKey: '' }), input, 'IDEMPOTENCY_KEY_REQUIRED'],
    [context({ source: 'AI_ACTION' }), input, 'HUMAN_COMMAND_REQUIRED'], [context({ actionRequestId: INV }), input, 'HUMAN_COMMAND_REQUIRED'],
    [context({ principalType: 'SERVICE' }), input, 'HUMAN_COMMAND_REQUIRED']]) {
    const { service, calls } = fakes({ receipt: detail(), replayed: false });
    await assert.rejects(service.create(ctx, value), (e) => code(e) === expected);
    assert.equal(calls.length, 0);
  }
});

test('detail: a read-only call with no key; another school or unknown invoice is 404', async () => {
  const { service, calls } = fakes(detail());
  assert.equal((await service.detail(context({ idempotencyKey: '' }), INV)).number, '33333333');
  assert.ok(calls.some(([sql, values]) => sql.includes('read_school_invoice_detail') && values[1] === INV));
  await assert.rejects(service.detail(context(), INV), (e) => code(e) === 'IDEMPOTENCY_KEY_NOT_ACCEPTED');
  await assert.rejects(fakes(detail()).service.detail(context({ idempotencyKey: '' }), '44444444-4444-4444-8444-444444444444'), (e) => code(e) === 'SIMPLE_INVOICES_UNAVAILABLE');
  await assert.rejects(fakes(Object.assign(new Error('INVOICE_NOT_FOUND'), { code: 'P0002' })).service.detail(context({ idempotencyKey: '' }), INV), (e) => status(e) === 404);
});

test('maps only the exact database refusals; anything else is unavailable, never success', () => {
  const map = (message, sqlState) => { try { translateSimpleInvoiceError(Object.assign(new Error(message), { code: sqlState })); } catch (e) { return [status(e), code(e)]; } };
  assert.deepEqual(map('VALIDATION_FAILED', '22023'), [400, 'VALIDATION_FAILED']);
  assert.deepEqual(map('TUITION_RECEIVABLES_FORBIDDEN', '42501'), [403, 'TUITION_RECEIVABLES_FORBIDDEN']);
  assert.deepEqual(map('BILLING_ACCOUNT_NOT_FOUND', 'P0002'), [404, 'BILLING_ACCOUNT_NOT_FOUND']);
  assert.deepEqual(map('IDEMPOTENCY_KEY_REUSED', '22023'), [409, 'IDEMPOTENCY_KEY_REUSED']);
  assert.deepEqual(map('anything', '40001'), [409, 'SIMPLE_INVOICE_CONFLICT']);
  assert.deepEqual(map('connection lost', '08006'), [503, 'SIMPLE_INVOICES_UNAVAILABLE']);
  assert.deepEqual(map('INVOICE_NOT_FOUND', 'XX000'), [503, 'SIMPLE_INVOICES_UNAVAILABLE']);
});
