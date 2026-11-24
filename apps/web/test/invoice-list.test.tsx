import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { verifySchoolInvoiceList } from '@hon/contracts';
import { InvoiceListError, InvoiceListView, invoiceListApi, listErrorFor, schoolDay, type ListState } from '../src/components/invoice-list/invoice-list';
import { id } from './account-status-fixtures';

// Full-build weak spot 5 (0280): a DRAFT invoice not issued at once can be found again in the school's invoice list and issued.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), scope = { organizationId: org, schoolId: school }, key = id(77);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as InvoiceListError; } throw new Error('expected a failure'); };
const row = (over: Record<string, unknown> = {}) => ({ invoiceId: id(40), billingAccountId: id(41), membershipId: id(42), payerName: 'Jordan Rivera', status: 'DRAFT', version: 1,
  currency: 'USD', totalMinor: 4900, paidMinor: 0, balanceMinor: 4900, dueAt: '2026-12-02T07:59:59.000Z', overdue: false, createdAt: '2026-11-12T01:20:33.869Z', ...over });
const page = (over: Record<string, unknown> = {}) => ({ localToday: '2026-11-11', timezone: 'America/Los_Angeles', status: 'ALL', canIssue: true, canRecord: false,
  items: [row(), row({ invoiceId: id(43), status: 'ISSUED', version: 2, createdAt: '2026-11-11T09:00:00.000Z' })], nextAfter: null, ...over });

it('lists with a plain same-origin GET, status and cursor in the query, no key and no command header', async () => {
  const f = stub(json({ data: page(), meta: {} }));
  const read = await invoiceListApi.list({ organizationId: org.toUpperCase(), schoolId: school }, 'ALL', null, signal(), () => true);
  expect(read.items.map((i) => i.status)).toEqual(['DRAFT', 'ISSUED']);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/billing/invoices?status=ALL`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
  expect(Object.keys(init.headers as object).some((k) => /^x-hon|idempotency/i.test(k))).toBe(false);
  const g = stub(json({ data: page({ status: 'DRAFT', items: [row()] }), meta: {} }));
  await invoiceListApi.list(scope, 'DRAFT', id(50), signal(), () => true);
  expect((g.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/organizations/${org}/schools/${school}/billing/invoices?status=DRAFT&after=${id(50)}`);
});

it('refuses drifted lists: another status, out of order, the cursor row again, a draft with payments, extra fields', () => {
  const q = { status: 'ALL' as const };
  expect(() => verifySchoolInvoiceList(page(), q)).not.toThrow();
  expect(() => verifySchoolInvoiceList(page({ status: 'DRAFT' }), q)).toThrow();
  expect(() => verifySchoolInvoiceList(page({ items: [row({ createdAt: '2026-11-10T00:00:00.000Z' }), row({ invoiceId: id(43), createdAt: '2026-11-11T00:00:00.000Z' })] }), q)).toThrow();
  expect(() => verifySchoolInvoiceList(page(), { status: 'ALL', after: id(40) })).toThrow();
  expect(() => verifySchoolInvoiceList(page({ items: [row({ paidMinor: 100, balanceMinor: 4800 })] }), q)).toThrow();
  expect(() => verifySchoolInvoiceList(page({ items: [row({ status: 'ISSUED' })] }), { status: 'DRAFT' })).toThrow();
  expect(() => verifySchoolInvoiceList({ ...page(), extra: 1 }, q)).toThrow();
  expect(() => verifySchoolInvoiceList(page({ nextAfter: id(40) }), q)).toThrow();
});

it('issues one listed draft at its version with a key and the invoice command header; the answer must be that invoice one version later', async () => {
  const f = stub(json({ data: { id: id(40), status: 'ISSUED', version: 2 }, meta: {} }));
  await expect(invoiceListApi.issue(scope, { invoiceId: id(40), version: 1 }, key, signal(), () => true)).resolves.toEqual({ invoiceId: id(40), version: 2 });
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/billing/invoices/${id(40)}/issue`);
  expect(init).toMatchObject({ method: 'POST', headers: { 'Idempotency-Key': key, 'X-HON-Human-Command': 'billing-invoice' } });
  expect(JSON.parse(init.body as string)).toEqual({ expectedVersion: 1 });
  stub(json({ data: { id: id(40), status: 'ISSUED', version: 3 }, meta: {} }));
  expect((await fails(invoiceListApi.issue(scope, { invoiceId: id(40), version: 1 }, key, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: { id: id(44), status: 'ISSUED', version: 2 }, meta: {} }));
  expect((await fails(invoiceListApi.issue(scope, { invoiceId: id(40), version: 1 }, key, signal(), () => true))).kind).toBe('UNKNOWN');
  const g = stub(json({}));
  expect((await fails(invoiceListApi.issue(scope, { invoiceId: id(40), version: 1 }, 'bad', signal(), () => true))).kind).toBe('INVALID');
  expect(g).not.toHaveBeenCalled();
});

it('reads refusals; only an unknown outcome may be sent again; 401 ends the session only for the shown request', async () => {
  expect(listErrorFor(403, null).kind).toBe('DENIED');
  expect(listErrorFor(409, 'VERSION_CONFLICT').kind).toBe('CHANGED');
  expect(listErrorFor(409, 'IDEMPOTENCY_IN_PROGRESS').kind).toBe('UNKNOWN');
  expect(listErrorFor(400, null).kind).toBe('INVALID');
  expect(listErrorFor(502, null).kind).toBe('UNKNOWN');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network'); }));
  expect((await fails(invoiceListApi.issue(scope, { invoiceId: id(40), version: 1 }, key, signal(), () => true))).kind).toBe('UNKNOWN');
  const seen = vi.fn(); window.addEventListener('hon:session-invalidated', seen);
  stub(new Response(null, { status: 401 }));
  expect((await fails(invoiceListApi.list(scope, 'ALL', null, signal(), () => false))).kind).toBe('SESSION');
  expect(seen).not.toHaveBeenCalled();
  stub(new Response(null, { status: 401 }));
  expect((await fails(invoiceListApi.list(scope, 'ALL', null, signal(), () => true))).kind).toBe('SESSION');
  expect(seen).toHaveBeenCalledTimes(1);
});

it('shows payer, money, school-day dates and Issue only on drafts the reader may issue', () => {
  const read = verifySchoolInvoiceList(page(), { status: 'ALL' });
  const ready: ListState = { state: 'READY', read, items: read.items };
  const html = renderToStaticMarkup(<InvoiceListView list={ready} status="ALL" issue={null} busy={false}/>);
  expect(html).toContain('Jordan Rivera · $49.00'); expect(html).toContain('Draft · due Dec 1, 2026'); expect(html).toContain('created Nov 11, 2026');
  expect(html.match(/>Issue</g)?.length).toBe(1);
  const noIssue = verifySchoolInvoiceList(page({ canIssue: false }), { status: 'ALL' });
  expect(renderToStaticMarkup(<InvoiceListView list={{ state: 'READY', read: noIssue, items: noIssue.items }} status="ALL" issue={null} busy={false}/>)).not.toContain('>Issue<');
  const confirm = renderToStaticMarkup(<InvoiceListView list={ready} status="ALL" issue={{ invoiceId: id(40), phase: 'CONFIRM' }} busy={false}/>);
  expect(confirm).toContain('Confirm: issue this invoice');
  const kept = renderToStaticMarkup(<InvoiceListView list={ready} status="ALL" issue={{ invoiceId: id(40), phase: 'FAILED', kind: 'UNKNOWN', kept: true }} busy={false}/>);
  expect(kept).toContain('Try again'); expect(kept).toContain('never be issued twice');
  expect(renderToStaticMarkup(<InvoiceListView list={{ state: 'FAILED', kind: 'DENIED' }} status="ALL" issue={null} busy={false}/>)).toContain('does not include invoices');
  expect(schoolDay('2026-12-02T07:59:59.000Z', 'America/Los_Angeles')).toBe('Dec 1, 2026');
  expect(schoolDay('2026-12-02T07:59:59.000Z', 'Not/AZone')).toBe('2026-12-02');
});
