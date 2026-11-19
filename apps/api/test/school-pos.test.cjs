const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { SchoolPosService } = require('../dist/pos/school-pos.service.js');
const { computePosTotals, validatePosSaleInput } = require('@hon/contracts');

// Mocked boundary tests for the 0539 Point of Sale API. Authority, school scope, pricing, stock and refunds are proven
// against PostgreSQL by test-pos-integrity.mjs.
const status = (value, code) => (error) => { assert.equal(error.getStatus(), value); if (code) assert.equal(error.getResponse().code, code); return true; };
const req = { honIdentity: { externalSubject: 'subject-1' } };
const school = randomUUID(), item = randomUUID();
function fakeDatabase(answer) {
  const calls = [];
  return { calls, async callSchoolPos(op, params) { calls.push({ op, params }); if (answer instanceof Error) throw answer; return typeof answer === 'function' ? answer(op, params) : answer; } };
}
const sqlError = (message, code) => Object.assign(new Error(message), { code });
const saleBody = (o = {}) => ({ schoolId: school, personId: null, walkInName: null, lines: [{ itemId: item, quantity: 1 }], discount: null, method: 'CASH', reference: null, note: null, expectedTotalMinor: 1000, ...o });

test('the register arithmetic matches the database rules: discount, taxable share, half-up rounding', () => {
  assert.deepEqual(computePosTotals([{ unitPriceMinor: 10000, quantity: 2, taxable: true }, { unitPriceMinor: 7500, quantity: 1, taxable: false }], { kind: 'PERCENT', value: 10 }, 825),
    { subtotalMinor: 27500, discountMinor: 2750, taxMinor: 1485, totalMinor: 26235 });
  assert.deepEqual(computePosTotals([{ unitPriceMinor: 999, quantity: 1, taxable: true }], null, 1000), { subtotalMinor: 999, discountMinor: 0, taxMinor: 100, totalMinor: 1099 });
  assert.deepEqual(computePosTotals([{ unitPriceMinor: 500, quantity: 1, taxable: false }], { kind: 'AMOUNT', value: 900 }, 0).totalMinor, 0);
});

test('a sale goes to the database with the session subject, the exact key and a closed body', async () => {
  const db = fakeDatabase(new Error('stop'));
  const service = new SchoolPosService(db);
  const key = randomUUID();
  await assert.rejects(() => service.command(req, 'record', saleBody(), key), status(503, 'POS_UNAVAILABLE'));
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].op, 'record');
  assert.equal(db.calls[0].params[0], 'subject-1');
  assert.deepEqual(JSON.parse(db.calls[0].params[1]), saleBody());
  assert.equal(db.calls[0].params[2], key);
});

test('bad input never reaches the database', async () => {
  const db = fakeDatabase({});
  const service = new SchoolPosService(db);
  for (const body of [saleBody({ extra: 1 }), saleBody({ lines: [] }), saleBody({ personId: randomUUID(), walkInName: 'Guest' }), saleBody({ method: 'CARD' }),
    saleBody({ discount: { kind: 'PERCENT', value: 101, reason: 'x' } }), saleBody({ lines: [{ description: ' padded', unitPriceMinor: 1, quantity: 1 }] })]) {
    await assert.rejects(() => service.command(req, 'record', body, randomUUID()), status(400, 'POS_INVALID'));
  }
  await assert.rejects(() => service.command(req, 'record', saleBody(), 'not-a-key'), status(400, 'POS_INVALID'));
  await assert.rejects(() => service.sales(req, school, '2026-01-01', '2027-06-01'), status(400, 'POS_INVALID'));
  assert.equal(db.calls.length, 0);
  assert.throws(() => validatePosSaleInput(saleBody({ lines: Array.from({ length: 51 }, () => ({ itemId: item, quantity: 1 })) })));
});

test('database refusals become plain, safe answers', async () => {
  const cases = [['POS_TOTAL_CHANGED', '40001', 409], ['POS_OUT_OF_STOCK', '22023', 409], ['POS_FORBIDDEN', '42501', 403], ['POS_NOT_FOUND', 'P0002', 404],
    ['POS_REFUND_TOO_LARGE', '22023', 400], ['POS_KEY_REUSED', '23505', 409], ['POS_BUSY', '55P03', 503]];
  for (const [message, code, http] of cases) {
    const service = new SchoolPosService(fakeDatabase(sqlError(message, code)));
    await assert.rejects(() => service.command(req, 'record', saleBody(), randomUUID()), (e) => {
      assert.equal(e.getStatus(), http); assert.equal(e.getResponse().code, message);
      assert(!JSON.stringify(e.getResponse()).match(/SQLSTATE|hon\.|subject/)); return true;
    });
  }
  const unknown = new SchoolPosService(fakeDatabase(sqlError('relation hon.pos_sales does not exist', '42P01')));
  await assert.rejects(() => unknown.read(req, school), status(503, 'POS_UNAVAILABLE'));
});

test('a malformed database answer is never passed to the screen', async () => {
  const service = new SchoolPosService(fakeDatabase({ schoolId: randomUUID(), timezone: 'UTC', today: '2026-11-16', canManage: false, settings: { currency: 'USD', taxRateBps: 0, version: null }, items: [], todaySales: { count: 0, totalMinor: 0 } }));
  await assert.rejects(() => service.read(req, school), status(503, 'POS_UNAVAILABLE'));
});
