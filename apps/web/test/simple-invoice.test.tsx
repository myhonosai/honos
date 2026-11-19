import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { verifyInvoiceDetail, type InvoiceDetail } from '@hon/contracts';
import {
  addItemRow, buildCreateInput, emptyForm, formTotal, invoiceLines, invoiceMessage, lineTotal, parsePrice, parseQuantity, removeItemRow, updateItemRow, addDays,
} from '../src/components/simple-invoice/simple-invoice-model';
import { SimpleInvoiceError, simpleInvoiceApi, simpleInvoiceErrorFor } from '../src/components/simple-invoice/simple-invoice-http';
import { InvoiceBuilderView, InvoiceDetailView, InvoicesListView, sendFailureText } from '../src/components/simple-invoice/simple-invoices';
import { ComposeRefusal, ComposeUncertain } from '../src/components/family-messages/compose-http';
import { id } from './account-status-fixtures';

// SI1 (0540): the simple staff invoice: form math, the calls it makes, and what staff see.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), scope = { organizationId: org, schoolId: school }, account = id(41), person = id(60), invoiceId = id(40);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...responses: Response[]) => { const f = vi.fn(async () => responses.shift()!); vi.stubGlobal('fetch', f); return f; };
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as SimpleInvoiceError; } throw new Error('expected a failure'); };
const listed = (over: Record<string, unknown> = {}) => ({ invoiceId, billingAccountId: account, membershipId: null, payerName: 'Jordan Rivera', status: 'ISSUED', version: 2,
  currency: 'USD', totalMinor: 13900, paidMinor: 0, balanceMinor: 13900, dueAt: '2026-12-04T07:59:59.000Z', overdue: false, createdAt: '2026-11-19T05:00:00.000Z', ...over });
const detailBody = (over: Record<string, unknown> = {}, invoice: Record<string, unknown> = {}) => ({
  invoice: listed(invoice), number: invoiceId.slice(0, 8).toUpperCase(), localToday: '2026-11-18', timezone: 'America/Los_Angeles', canIssue: true,
  items: [{ position: 1, description: 'Monthly tuition', quantity: 1, unitAmountMinor: 12900, amountMinor: 12900 },
    { position: 2, description: 'Belt test fee', quantity: 2, unitAmountMinor: 500, amountMinor: 1000 }],
  note: 'Thanks for training with us!', billTo: { personId: person, name: 'Jordan Rivera', email: 'jordan@example.test', phone: '555-0100' },
  from: { schoolName: 'Example Dojo', addressLines: ['1 Main St', 'Springfield'], phone: '555-0199', email: 'front@example.test' },
  howToPay: { inApp: true, otherWays: 'Cash or check at the front desk' }, ...over });
const detail = (over: Record<string, unknown> = {}, invoice: Record<string, unknown> = {}): InvoiceDetail => verifyInvoiceDetail(detailBody(over, invoice));
const filled = () => {
  let f = emptyForm('2026-12-03');
  f = updateItemRow(f, f.items[0]!.rowId, { description: ' Monthly tuition ', quantity: '1', price: '129' });
  f = addItemRow(f);
  return updateItemRow(f, f.items[1]!.rowId, { description: 'Belt test fee', quantity: '2', price: '$5.00' });
};

it('parses quantities and prices the way staff type them', () => {
  expect(parseQuantity('3')).toBe(3); expect(parseQuantity('0')).toBeNull(); expect(parseQuantity('1001')).toBeNull(); expect(parseQuantity('1.5')).toBeNull();
  expect(parsePrice('49.5', 'USD')).toBe(4950); expect(parsePrice('$1,200.00', 'USD')).toBe(120000); expect(parsePrice('0', 'USD')).toBe(0);
  expect(parsePrice('4.999', 'USD')).toBeNull(); expect(parsePrice('', 'USD')).toBeNull(); expect(parsePrice('-5', 'USD')).toBeNull();
  expect(parsePrice('49000', 'KRW')).toBe(49000); expect(parsePrice('1000001', 'USD')).toBeNull();
});

it('shows line totals and the total as staff type, and keeps 1 to 30 rows', () => {
  const f = filled();
  expect(f.items.map((row) => lineTotal(row, 'USD'))).toEqual([12900, 1000]);
  expect(formTotal(f, 'USD')).toBe(13900);
  expect(formTotal(updateItemRow(f, f.items[1]!.rowId, { price: 'abc' }), 'USD')).toBeNull();
  expect(removeItemRow(removeItemRow(f, f.items[0]!.rowId), f.items[1]!.rowId).items).toHaveLength(1);
  let many = emptyForm('');
  for (let n = 0; n < 40; n++) many = addItemRow(many);
  expect(many.items).toHaveLength(30);
  expect(addDays('2026-12-25', 14)).toBe('2027-01-08');
});

it('builds the create command (trimmed, blanks left out) or names the first problem', () => {
  const built = buildCreateInput(filled(), account, 'USD', true);
  expect(built).toEqual({ ok: true, input: { billingAccountId: account, dueDate: '2026-12-03', issue: true,
    items: [{ description: 'Monthly tuition', quantity: 1, unitAmountMinor: 12900 }, { description: 'Belt test fee', quantity: 2, unitAmountMinor: 500 }] } });
  const extra = buildCreateInput({ ...filled(), payToPhone: ' 555-0199 ', payToEmail: 'front@example.test', otherWaysToPay: 'Cash', note: 'Hi' }, account, 'USD', false);
  expect(extra.ok && extra.input).toMatchObject({ payToPhone: '555-0199', payToEmail: 'front@example.test', otherWaysToPay: 'Cash', note: 'Hi', issue: false });
  const f = filled();
  expect(buildCreateInput(updateItemRow(f, f.items[0]!.rowId, { description: '  ' }), account, 'USD', true)).toEqual({ ok: false, problem: 'ITEM_DESCRIPTION' });
  expect(buildCreateInput(updateItemRow(f, f.items[0]!.rowId, { quantity: '0' }), account, 'USD', true)).toEqual({ ok: false, problem: 'ITEM_QUANTITY' });
  expect(buildCreateInput(updateItemRow(f, f.items[0]!.rowId, { price: 'x' }), account, 'USD', true)).toEqual({ ok: false, problem: 'ITEM_PRICE' });
  const free = updateItemRow(updateItemRow(f, f.items[0]!.rowId, { price: '0' }), f.items[1]!.rowId, { price: '0' });
  expect(buildCreateInput(free, account, 'USD', true)).toEqual({ ok: false, problem: 'TOTAL' });
  expect(buildCreateInput({ ...f, dueDate: '' }, account, 'USD', true)).toEqual({ ok: false, problem: 'DUE_DATE' });
  expect(buildCreateInput({ ...f, payToPhone: 'call me' }, account, 'USD', true)).toEqual({ ok: false, problem: 'PHONE' });
  expect(buildCreateInput({ ...f, payToEmail: 'nope' }, account, 'USD', true)).toEqual({ ok: false, problem: 'EMAIL' });
  expect(buildCreateInput({ ...f, note: 'x'.repeat(1001) }, account, 'USD', true)).toEqual({ ok: false, problem: 'TEXT' });
});

it('writes the email and the text from the saved invoice, with the parent app link only when the school takes card payments', () => {
  const d = detail();
  const email = invoiceMessage(d, 'EMAIL', 'https://app.example.test/parent/billing');
  expect(email).toContain(`Here is invoice ${d.number} from Example Dojo.`);
  expect(email).toContain('- Belt test fee (2 x $5.00): $10.00');
  expect(email).toContain('Balance due: $139.00 by Dec 3, 2026');
  expect(email).toContain('Pay online in the HON parent app: https://app.example.test/parent/billing');
  expect(email).toContain('Other ways to pay:\nCash or check at the front desk');
  expect(email.startsWith('Hi Jordan,')).toBe(true);
  const text = invoiceMessage(d, 'SMS', 'https://app.example.test/parent/billing');
  expect(text).toBe(`Example Dojo: invoice ${d.number} for $139.00. Balance due $139.00 by Dec 3, 2026. Pay online in the HON parent app: https://app.example.test/parent/billing Other ways to pay: Cash or check at the front desk Questions: 555-0199 · front@example.test`);
  const offline = invoiceMessage(detail({ howToPay: { inApp: false, otherWays: null } }), 'SMS', 'https://app.example.test/parent/billing');
  expect(offline).not.toContain('parent app');
});

it('shows an older invoice (no items) as one "Invoice amount" line', () => {
  expect(invoiceLines(detail({ items: [] }))).toEqual([{ description: 'Invoice amount', quantity: 1, unitAmountMinor: 13900, amountMinor: 13900 }]);
});

it('looks up payers and reuses the account with same-origin commands and the account marker', async () => {
  const f = stub(json({ data: [{ id: person.toUpperCase(), displayName: 'Jordan Rivera' }] }),
    json({ data: { id: account, responsiblePersonId: person, currency: 'USD', classification: 'CANONICAL', version: 1, createdAt: '2026-11-01T00:00:00.000Z', reused: true }, meta: {} }));
  expect(await simpleInvoiceApi.findPayers(scope, ' Riv ')).toEqual([{ id: person, displayName: 'Jordan Rivera' }]);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/billing/accounts/payer-lookup`);
  expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', body: JSON.stringify({ query: 'Riv' }) });
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': 'billing.account.create' });
  expect(Object.keys(init.headers as object)).not.toContain('Idempotency-Key');
  expect(await simpleInvoiceApi.payerAccount(scope, person, id(70))).toEqual({ billingAccountId: account, currency: 'USD' });
  const [, second] = f.mock.calls[1] as unknown as [string, RequestInit];
  expect(second.headers).toMatchObject({ 'Idempotency-Key': id(70) }); expect(second.body).toBe(JSON.stringify({ responsiblePersonId: person }));
  stub(json({ data: { id: account, responsiblePersonId: id(61), currency: 'USD' } }));
  expect((await fails(simpleInvoiceApi.payerAccount(scope, person, id(70)))).kind).toBe('UNKNOWN');
  expect((await fails(simpleInvoiceApi.findPayers(scope, 'R'))).kind).toBe('INVALID');
});

it('creates with its own command marker and key and checks the new invoice is exactly what was asked', async () => {
  const built = buildCreateInput(filled(), account, 'USD', true); if (!built.ok) throw new Error('form'); const input = built.input;
  const fresh = detailBody({ note: null, howToPay: { inApp: true, otherWays: null }, from: { schoolName: 'Example Dojo', addressLines: [], phone: null, email: null } });
  const f = stub(json({ data: fresh, meta: { replayed: false } }, 201));
  const made = await simpleInvoiceApi.create(scope, input, id(71));
  expect(made.replayed).toBe(false); expect(made.detail.items).toHaveLength(2);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/billing/invoices/simple`);
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': 'billing.invoice.simple.create', 'Idempotency-Key': id(71) });
  // A different total, status or note than asked is not accepted as the result.
  stub(json({ data: { ...fresh, note: 'other' }, meta: { replayed: false } }, 201));
  expect((await fails(simpleInvoiceApi.create(scope, input, id(71)))).kind).toBe('UNKNOWN');
  stub(json({ data: detailBody({}, { status: 'DRAFT', version: 1 }), meta: { replayed: false } }, 201));
  expect((await fails(simpleInvoiceApi.create(scope, input, id(71)))).kind).toBe('UNKNOWN');
  // A replay (200) shows the invoice as it is now, possibly paid since.
  stub(json({ data: detailBody({}, { status: 'PAID', paidMinor: 13900, balanceMinor: 0, version: 3 }), meta: { replayed: true } }, 200));
  expect((await simpleInvoiceApi.create(scope, input, id(71))).replayed).toBe(true);
  stub(json({ code: 'IDEMPOTENCY_KEY_REUSED' }, 409));
  expect((await fails(simpleInvoiceApi.create(scope, input, id(71)))).kind).toBe('KEY_REUSED');
  stub(json({ code: 'IDEMPOTENCY_IN_PROGRESS' }, 409));
  expect((await fails(simpleInvoiceApi.create(scope, input, id(71)))).kind).toBe('UNKNOWN');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
  expect((await fails(simpleInvoiceApi.create(scope, input, id(71)))).kind).toBe('UNKNOWN');
});

it('reads the detail with a plain GET and refuses a different invoice', async () => {
  const f = stub(json({ data: detailBody(), meta: {} }));
  expect((await simpleInvoiceApi.detail(scope, invoiceId)).number).toBe(invoiceId.slice(0, 8).toUpperCase());
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/billing/invoices/${invoiceId}/detail`);
  expect(init.method).toBe('GET'); expect(Object.keys(init.headers as object).some((k) => /^x-hon|idempotency/i.test(k))).toBe(false);
  stub(json({ data: detailBody(), meta: {} }));
  expect((await fails(simpleInvoiceApi.detail(scope, id(99)))).kind).toBe('UNKNOWN');
  stub(json({ code: 'INVOICE_NOT_FOUND' }, 404));
  expect((await fails(simpleInvoiceApi.detail(scope, invoiceId))).kind).toBe('NOT_FOUND');
  expect(simpleInvoiceErrorFor(403, null).kind).toBe('DENIED'); expect(simpleInvoiceErrorFor(503, null).kind).toBe('UNKNOWN');
});

it('lists invoices with number, payer, status, due date, total and balance', () => {
  const read = { localToday: '2026-11-18', timezone: 'America/Los_Angeles', status: 'ALL' as const, canIssue: true, canRecord: false, nextAfter: null,
    items: [listed(), listed({ invoiceId: id(43), status: 'DRAFT', version: 1, overdue: false }), listed({ invoiceId: id(44), overdue: true })] };
  const html = renderToStaticMarkup(<InvoicesListView list={{ state: 'READY', read: read as never, items: read.items as never }} status="ALL"/>);
  expect(html).toContain(`#${invoiceId.slice(0, 8).toUpperCase()}`); expect(html).toContain('Jordan Rivera'); expect(html).toContain('$139.00');
  expect(html).toContain('Draft'); expect(html).toContain('Overdue'); expect(html).toContain('+ New invoice');
  expect(renderToStaticMarkup(<InvoicesListView list={{ state: 'READY', read: { ...read, items: [] } as never, items: [] }} status="ALL"/>)).toContain('Create your first invoice');
});

it('shows the builder with items, a live total and a live preview, and plain button wording', () => {
  const html = renderToStaticMarkup(<InvoiceBuilderView form={filled()} payer={{ personId: person, name: 'Jordan Rivera' }} payerQuery="" payerResults={{ state: 'IDLE' }}
    currency="USD" schoolName="Example Dojo" busy={false} problem={null}/>);
  expect(html).toContain('data-testid="form-total">$139.00'); expect(html).toContain('data-testid="item-2-amount">$10.00');
  expect(html).toContain('data-testid="invoice-preview"'); expect(html).toContain('Example Dojo'); expect(html).toContain('Jordan Rivera');
  expect(html).toContain('Create invoice'); expect(html).toContain('Save draft'); expect(html).toContain('Monthly tuition');
  expect(html).not.toMatch(/server-owned|confirm.*draft/i);
  const search = renderToStaticMarkup(<InvoiceBuilderView form={emptyForm('')} payer={null} payerQuery="Riv" payerResults={{ state: 'DONE', items: [{ id: person, displayName: 'Jordan Rivera' }] }}
    currency="USD" schoolName={null} busy={false} problem={{ text: 'Choose who pays (Bill to) first.', retry: false }}/>);
  expect(search).toContain('Jordan Rivera'); expect(search).toContain('role="alert"'); expect(search).not.toContain('Try again');
});

it('shows the printable invoice with Print, Email and Text, and Issue only for a draft the user may issue', () => {
  const html = renderToStaticMarkup(<InvoiceDetailView detail={detail()} send={null} busy={false}/>);
  for (const text of ['Print', 'Email', 'Text', 'Bill to', 'Example Dojo', '1 Main St', 'jordan@example.test', 'Belt test fee', 'Balance due', 'Pay online by card in the HON parent app.', 'Cash or check at the front desk', 'Thanks for training with us!']) {
    expect(html).toContain(text);
  }
  expect(html).not.toContain('Issue invoice');
  expect(renderToStaticMarkup(<InvoiceDetailView detail={detail({}, { status: 'DRAFT', version: 1 })} send={null} busy={false}/>)).toContain('Issue invoice');
  expect(renderToStaticMarkup(<InvoiceDetailView detail={detail({ canIssue: false }, { status: 'DRAFT', version: 1 })} send={null} busy={false}/>)).not.toContain('Issue invoice');
  const paid = renderToStaticMarkup(<InvoiceDetailView detail={detail({}, { status: 'PAID', paidMinor: 13900, balanceMinor: 0, version: 3 })} send={null} busy={false}/>);
  expect(paid).toContain('−$139.00'); expect(paid).toContain('data-testid="balance-due">$0.00');
  const sending = renderToStaticMarkup(<InvoiceDetailView detail={detail()} send={{ channel: 'SMS', phase: 'EDIT', text: 'Hello' }} busy={false}/>);
  expect(sending).toContain('Send text'); expect(sending).toContain('555-0100'); expect(sending).toContain('agreed to receive texts');
  const noPayer = renderToStaticMarkup(<InvoiceDetailView detail={detail({ billTo: { personId: null, name: null, email: null, phone: null } })} send={null} busy={false}/>);
  expect(noPayer).toContain('can be printed but not emailed or texted');
});

it('explains a refused message in plain words and allows a retry only when the result is unknown', () => {
  expect(sendFailureText(new ComposeRefusal('CONSENT'), 'SMS', 'Jordan Rivera')).toEqual({ retry: false,
    reason: 'Jordan Rivera has not agreed to receive texts from your school, or has no phone number on file. Nothing was sent.' });
  expect(sendFailureText(new ComposeRefusal('ACCESS'), 'EMAIL', null).retry).toBe(false);
  expect(sendFailureText(new ComposeUncertain('x'), 'EMAIL', null).retry).toBe(true);
});
