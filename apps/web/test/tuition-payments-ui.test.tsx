import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SCHOOL_SHELL_NAV, schoolShellActiveRoute } from '../src/components/school-shell/catalog';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
import { TuitionError, keepForRetry, tuitionApi, tuitionErrorFor } from '../src/components/tuition-payments/http';
import { tuitionBody } from '../src/components/tuition-payments/tuition-payments';
import { TuitionPaymentsView, type TuitionPaymentsViewProps } from '../src/components/tuition-payments/view';
import { id } from './account-status-fixtures';

// B-TUI-1 (0240): the staff tuition balances page reads unpaid balances and records/voids payments received outside HON.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), invoiceId = id(30), paymentId = id(40), key = id(77), scope = { organizationId: org, schoolId: school };
const meta = { requestId: id(5), correlationId: id(5) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as TuitionError; } throw new Error('expected a failure'); };
const balance = (over: Record<string, unknown> = {}) => ({ invoiceId, billingAccountId: id(31), membershipId: null, payerName: 'Sam Lee', status: 'ISSUED', version: 2,
  currency: 'USD', totalMinor: 10000, paidMinor: 4000, balanceMinor: 6000, dueAt: '2026-11-01T08:00:00.000Z', overdue: true, ...over });
const payment = (over: Record<string, unknown> = {}) => ({ paymentId, invoiceId, amountMinor: 4000, currency: 'USD', receivedOn: '2026-11-08', method: 'CASH',
  reference: 'R-1', note: null, recordedAt: '2026-11-08T18:00:00.000Z', void: null, ...over });
const receivablesRaw = (over: Record<string, unknown> = {}) => ({ localToday: '2026-11-09', filter: 'OPEN', canRecord: true,
  totals: [{ currency: 'USD', count: 1, balanceMinor: 6000 }], items: [balance()], nextAfter: null, ...over });
const paymentsRaw = (over: Record<string, unknown> = {}) => ({ localToday: '2026-11-09', canRecord: true, invoice: balance(), payments: [payment()], ...over });

it('reads balances and one invoice as plain same-origin GETs with no key and no x-hon header', async () => {
  const f = stub(json({ data: receivablesRaw(), meta }));
  const read = await tuitionApi.receivables({ organizationId: org.toUpperCase(), schoolId: school }, 'OPEN', null, signal(), () => true);
  expect(read.items[0]?.balanceMinor).toBe(6000);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/billing/receivables?filter=OPEN`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
  const after = id(10);
  const g = stub(json({ data: receivablesRaw({ filter: 'OVERDUE' }), meta }));
  await tuitionApi.receivables(scope, 'OVERDUE', after, signal(), () => true);
  expect((g.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/organizations/${org}/schools/${school}/billing/receivables?filter=OVERDUE&after=${after}`);
  const h = stub(json({ data: paymentsRaw(), meta }));
  await expect(tuitionApi.payments(scope, invoiceId, signal(), () => true)).resolves.toMatchObject({ payments: [{ reference: 'R-1' }] });
  expect((h.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/organizations/${org}/schools/${school}/billing/invoices/${invoiceId}/payments`);
});

it('refuses drifted reads: another invoice, a wrong filter, a broken balance, a paid row in the list', async () => {
  stub(json({ data: paymentsRaw({ invoice: balance({ invoiceId: id(33) }) }), meta }));
  expect((await fails(tuitionApi.payments(scope, invoiceId, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: receivablesRaw({ filter: 'OVERDUE' }), meta }));
  expect((await fails(tuitionApi.receivables(scope, 'OPEN', null, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: receivablesRaw({ items: [balance({ balanceMinor: 5000 })] }), meta }));
  expect((await fails(tuitionApi.receivables(scope, 'OPEN', null, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: receivablesRaw({ items: [balance({ status: 'PAID', balanceMinor: 0, overdue: false })] }), meta }));
  expect((await fails(tuitionApi.receivables(scope, 'OPEN', null, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: paymentsRaw({ extra: 1 }), meta }));
  expect((await fails(tuitionApi.payments(scope, invoiceId, signal(), () => true))).kind).toBe('UNKNOWN');
  await expect(fails(tuitionApi.payments(scope, 'nope', signal(), () => true))).resolves.toMatchObject({ kind: 'INVALID' });
  await expect(fails(tuitionApi.receivables(scope, 'PAID' as never, null, signal(), () => true))).resolves.toMatchObject({ kind: 'INVALID' });
});

it('sends record and void each with its own human-command header and key, and verifies the receipt', async () => {
  const recordInput = { expectedInvoiceVersion: 2, amountMinor: 6000, currency: 'USD', receivedOn: '2026-11-09', method: 'CHECK' as const, reference: 'Check 12' };
  const f = stub(json({ data: { payment: payment({ amountMinor: 6000, method: 'CHECK', reference: 'Check 12', paymentId: id(41) }),
    invoice: balance({ status: 'PAID', version: 3, paidMinor: 10000, balanceMinor: 0, overdue: false }) }, meta: { ...meta, replayed: false } }));
  await expect(tuitionApi.record(scope, invoiceId, recordInput, key, signal(), () => true)).resolves.toMatchObject({ invoice: { status: 'PAID' } });
  let [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/billing/invoices/${invoiceId}/payments`);
  expect(init).toMatchObject({ method: 'POST', headers: { 'X-HON-Human-Command': 'billing.invoice.payment.record', 'Idempotency-Key': key, 'Content-Type': 'application/json' } });
  expect(JSON.parse(String(init.body))).toEqual(recordInput);
  const g = stub(json({ data: { payment: payment({ void: { voidedAt: '2026-11-09T19:00:00.000Z', reason: 'Wrong invoice' } }), invoice: balance({ version: 3, paidMinor: 0, balanceMinor: 10000 }) }, meta }));
  await tuitionApi.voidPayment(scope, paymentId, { expectedInvoiceVersion: 2, reason: 'Wrong invoice' }, key, signal(), () => true);
  [path, init] = g.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/billing/invoice-payments/${paymentId}/void`);
  expect(init).toMatchObject({ method: 'POST', headers: { 'X-HON-Human-Command': 'billing.invoice.payment.void', 'Idempotency-Key': key } });
  // A void receipt that is not voided, or a record receipt for another invoice, is never accepted as success.
  stub(json({ data: { payment: payment(), invoice: balance() }, meta }));
  expect((await fails(tuitionApi.voidPayment(scope, paymentId, { expectedInvoiceVersion: 2, reason: 'x' }, key, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: { payment: payment({ invoiceId: id(34) }), invoice: balance({ invoiceId: id(34) }) }, meta }));
  expect((await fails(tuitionApi.record(scope, invoiceId, recordInput, key, signal(), () => true))).kind).toBe('UNKNOWN');
  // Bad input or key never reaches the network.
  const none = stub(json({}, 500));
  expect((await fails(tuitionApi.record(scope, invoiceId, { ...recordInput, amountMinor: 0 }, key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(tuitionApi.record(scope, invoiceId, recordInput, 'not-a-key', signal(), () => true))).kind).toBe('INVALID');
  expect(none).not.toHaveBeenCalled();
});

it('maps only exact refusals to definite kinds; anything else keeps the key for an identical retry', async () => {
  expect(tuitionErrorFor(409, 'VERSION_CONFLICT').kind).toBe('CHANGED');
  expect(tuitionErrorFor(409, 'INVOICE_NOT_PAYABLE').kind).toBe('NOT_PAYABLE');
  expect(tuitionErrorFor(409, 'INVOICE_PAYMENT_ALREADY_VOIDED').kind).toBe('ALREADY_VOIDED');
  expect(tuitionErrorFor(422, 'INVOICE_CURRENCY_MISMATCH').kind).toBe('CURRENCY');
  expect(tuitionErrorFor(422, 'INVOICE_PAYMENT_EXCEEDS_BALANCE').kind).toBe('EXCEEDS');
  expect(tuitionErrorFor(403, null).kind).toBe('DENIED');
  expect(tuitionErrorFor(404, 'INVOICE_NOT_FOUND').kind).toBe('GONE');
  expect(tuitionErrorFor(409, 'TUITION_PAYMENT_CONFLICT').kind).toBe('UNKNOWN');
  expect(tuitionErrorFor(503, null).kind).toBe('UNKNOWN');
  expect(keepForRetry(new TuitionError('UNKNOWN'))).toBe(true);
  expect(keepForRetry(new TuitionError('EXCEEDS'))).toBe(false);
  stub(json({ code: 'VERSION_CONFLICT' }, 409));
  expect((await fails(tuitionApi.record(scope, invoiceId, { expectedInvoiceVersion: 2, amountMinor: 1, currency: 'USD', receivedOn: '2026-11-09', method: 'CASH' }, key, signal(), () => true))).kind).toBe('CHANGED');
  const events: string[] = []; (globalThis.window as EventTarget).addEventListener(HON_SESSION_INVALIDATED_EVENT, () => events.push('ended'));
  stub(json({}, 401));
  expect((await fails(tuitionApi.receivables(scope, 'OPEN', null, signal(), () => true))).kind).toBe('SESSION');
  stub(json({}, 401));
  expect((await fails(tuitionApi.receivables(scope, 'OPEN', null, signal(), () => false))).kind).toBe('SESSION');
  expect(events).toEqual(['ended']);
});

it('builds bodies from the verified invoice only: its version and currency, no future date, no more than the balance', () => {
  const read = paymentsRaw() as never;
  expect(tuitionBody('record', { amount: '25.50', receivedOn: '2026-11-09', method: 'BANK_TRANSFER', reference: ' T-9 ', note: '' }, read))
    .toEqual({ expectedInvoiceVersion: 2, amountMinor: 2550, currency: 'USD', receivedOn: '2026-11-09', method: 'BANK_TRANSFER', reference: 'T-9' });
  for (const fields of [{ amount: '60.01', receivedOn: '2026-11-09', method: 'CASH' }, { amount: '0', receivedOn: '2026-11-09', method: 'CASH' },
    { amount: '1.234', receivedOn: '2026-11-09', method: 'CASH' }, { amount: '10', receivedOn: '2026-11-10', method: 'CASH' }, { amount: '10', receivedOn: '2026-11-09', method: 'CRYPTO' }]) {
    expect(() => tuitionBody('record', fields, read)).toThrow();
  }
  expect(tuitionBody('void', { reason: '  Entered twice ' }, read)).toEqual({ expectedInvoiceVersion: 2, reason: 'Entered twice' });
  expect(() => tuitionBody('void', { reason: '   ' }, read)).toThrow();
});

const props = (over: Partial<TuitionPaymentsViewProps> = {}): TuitionPaymentsViewProps => ({ language: 'en-US', waiting: false, concealed: false, hasSchool: true,
  list: { state: 'READY', read: receivablesRaw() as never, items: [balance() as never], nextAfter: null, more: 'IDLE' }, filter: 'OPEN', selected: null,
  detail: { state: 'IDLE' }, form: null, outcome: null, locked: false, canRetry: false, ...over });

it('shows balances with totals, the invoice with its payments, and recording only for staff who may record', () => {
  const list = renderToStaticMarkup(<TuitionPaymentsView {...props()}/>);
  expect(list).toContain('$60.00 across 1 invoice');
  expect(list).toContain('Sam Lee: $60.00 left of $100.00');
  expect(list).toContain('overdue');
  expect(list).toContain('HON moves no money');
  const detail = renderToStaticMarkup(<TuitionPaymentsView {...props({ selected: invoiceId, detail: { state: 'READY', read: paymentsRaw() as never } })}/>);
  expect(detail).toContain('$60.00 left to pay');
  expect(detail).toContain('Record a payment');
  expect(detail).toContain('Void this payment');
  expect(detail).toContain('ref R-1');
  const readOnly = renderToStaticMarkup(<TuitionPaymentsView {...props({ selected: invoiceId, detail: { state: 'READY', read: paymentsRaw({ canRecord: false }) as never } })}/>);
  expect(readOnly).not.toContain('Record a payment');
  expect(readOnly).not.toContain('Void this payment');
  expect(readOnly).toContain('needs the tuition payment permission');
  const paid = renderToStaticMarkup(<TuitionPaymentsView {...props({ selected: invoiceId, detail: { state: 'READY', read: paymentsRaw({ invoice: balance({ status: 'PAID', paidMinor: 10000, balanceMinor: 0, overdue: false }) }) as never } })}/>);
  expect(paid).toContain('Paid in full');
  expect(paid).not.toContain('Record a payment');
  const form = renderToStaticMarkup(<TuitionPaymentsView {...props({ selected: invoiceId, detail: { state: 'READY', read: paymentsRaw() as never }, form: { kind: 'record' } })}/>);
  expect(form).toContain('data-testid="record-form"');
  expect(form).toContain('max="2026-11-09"');
  expect(form).toContain('Amount (USD)');
  const voidForm = renderToStaticMarkup(<TuitionPaymentsView {...props({ selected: invoiceId, detail: { state: 'READY', read: paymentsRaw() as never }, form: { kind: 'void', paymentId } })}/>);
  expect(voidForm).toContain('data-testid="void-form"');
  expect(voidForm).toContain('does not refund anyone');
  const voided = renderToStaticMarkup(<TuitionPaymentsView {...props({ selected: invoiceId, detail: { state: 'READY', read: paymentsRaw({ payments: [payment({ void: { voidedAt: '2026-11-09T19:00:00.000Z', reason: 'Wrong invoice' } })] }) as never } })}/>);
  expect(voided).toContain('Wrong invoice');
  expect(voided).not.toContain('Void this payment');
});

it('shows each refusal plainly and offers Try again only for a kept request', () => {
  expect(renderToStaticMarkup(<TuitionPaymentsView {...props({ list: { state: 'DENIED' } })}/>)).toContain('permission at this school');
  expect(renderToStaticMarkup(<TuitionPaymentsView {...props({ concealed: true })}/>)).not.toContain('Sam Lee');
  expect(renderToStaticMarkup(<TuitionPaymentsView {...props({ hasSchool: false })}/>)).toContain('Choose a school');
  const unknown = renderToStaticMarkup(<TuitionPaymentsView {...props({ outcome: { kind: 'UNKNOWN', action: 'record' }, canRetry: true })}/>);
  expect(unknown).toContain('never be recorded twice'); expect(unknown).toContain('Try again');
  const exceeds = renderToStaticMarkup(<TuitionPaymentsView {...props({ outcome: { kind: 'EXCEEDS', action: 'record' } })}/>);
  expect(exceeds).toContain('more than what is left'); expect(exceeds).not.toContain('Try again');
});

it('is a protected dynamic noindex page in the billing menu and the route manifest', () => {
  const page = readFileSync('src/app/staff/billing/receivables/page.tsx', 'utf8');
  expect(page).toContain("export const dynamic = 'force-dynamic'"); expect(page).toContain('requireVerifiedWebSession'); expect(page).toContain('index: false');
  expect(page).not.toMatch(/searchParams|organizationId|schoolId|fetch\(/);
  expect(schoolShellActiveRoute('/staff/billing/receivables')?.href).toBe('/staff/billing/receivables');
  expect(SCHOOL_SHELL_NAV.find((n) => n.key === 'billing')?.routes.some((r) => r.href === '/staff/billing/receivables')).toBe(true);
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
  expect(manifest.routes.filter((r: { path: string }) => r.path === '/staff/billing/receivables')).toEqual([{ path: '/staff/billing/receivables', title: 'HON | Tuition balances' }]);
});
