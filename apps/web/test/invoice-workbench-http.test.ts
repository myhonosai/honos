import { afterEach, describe, expect, it, vi } from 'vitest';
import { ISO_4217_CURRENCIES } from '@hon/contracts';
import { InvoiceAccessError, InvoiceRejectedError, InvoiceUncertainError, prepareInvoiceDraft, prepareInvoiceIssue, submitInvoiceCommand, validateInvoiceDraft, type DraftInvoiceReceipt, type PreparedInvoiceCommand } from '../src/components/invoice-workbench-http';
const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const scope = { organizationId: id('1'), schoolId: id('2') };
const input = { billingAccountId: id('3'), membershipId: id('4'), currency: 'USD' as const, subtotalMinor: 1250, dueAt: '2030-05-01T09:15:30-07:00' };
const draft = { id: id('6'), billingAccountId: input.billingAccountId, membershipId: input.membershipId, status: 'DRAFT', currency: 'USD', subtotalMinor: 1250, discountMinor: 0, totalMinor: 1250, dueAt: '2030-05-01T16:15:30.000Z', version: 1, createdAt: '2026-10-17T00:00:00.000Z' };
const issued = { ...draft, status: 'ISSUED', version: 2 };
const envelope = (data: unknown = draft, replayed = false) => ({ data, meta: { requestId: id('7'), correlationId: id('7'), replayed } });
const response = (data: unknown = draft, status = 201, replayed = status === 200) => Response.json(envelope(data, replayed), { status });
const create = () => prepareInvoiceDraft(scope, input, id('5'));
afterEach(() => vi.restoreAllMocks());

describe('closed canonical direct-human invoice transport', () => {
  it('uses the exact unchanged draft body and closed relative same-origin human-marked POST options', async () => {
    const command = create(); const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response());
    const receipt = await submitInvoiceCommand(command);
    expect(receipt).toEqual({ invoice: draft, replayed: false });
    expect(Object.isFrozen(command)).toBe(true); expect(Object.isFrozen(receipt)).toBe(true); expect(Object.isFrozen(receipt.invoice)).toBe(true);
    expect(fetcher.mock.calls).toEqual([[`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/billing/invoices`, {
      method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': id('5'), 'X-HON-Human-Command': 'billing-invoice' },
      body: JSON.stringify(input),
    }]]);
  });
  it('rejects selector, authority, money, currency and timezone violations before fetch and accepts bounded canonical inputs', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const name of Object.keys(scope)) for (const value of ['', 'name', `${id('1')}?x=1`, ' '+id('1'), `https://evil.test/${id('1')}`, null, []]) expect(() => validateInvoiceDraft({ ...scope, [name]: value } as typeof scope, input)).toThrow();
    for (const patch of [{ billingAccountId: 'name' }, { membershipId: null }, { membershipId: undefined }, { membershipId: '' }, { subtotalMinor: -1 }, { subtotalMinor: 2147483648 }, { subtotalMinor: 1.1 }, { subtotalMinor: '1250' }, { currency: 'usd' }, { currency: 'ZZZ' }, { dueAt: '2030-05-01T09:15:30' }, { dueAt: '2030-02-30T09:15:30Z' }, { dueAt: '2030-05-01T24:00:00Z' }, { dueAt: '2030-05-01T09:15:30+25:00' }, { dueAt: ' 2030-05-01T09:15:30Z' }]) expect(() => validateInvoiceDraft(scope, { ...input, ...patch } as typeof input)).toThrow();
    for (const field of ['invoiceId', 'organizationId', 'schoolId', 'totalMinor', 'discountMinor', 'status', 'expectedVersion', 'version', 'principalId', 'actor', 'source', 'actionRequestId', 'delegatedByPrincipalId', 'audit', 'outbox']) expect(() => validateInvoiceDraft(scope, { ...input, [field]: id('9') })).toThrow();
    expect(() => validateInvoiceDraft({ ...scope, permission: 'billing.invoice.create' } as typeof scope, input)).toThrow();
    for (const subtotalMinor of [0, 2147483647]) for (const currency of ISO_4217_CURRENCIES) expect(() => validateInvoiceDraft(scope, { ...input, subtotalMinor, currency })).not.toThrow();
    for (const key of ['', 'legacy-key', id('5').replace('-4', '-1')]) expect(() => prepareInvoiceDraft(scope, input, key)).toThrow();
    const command = create();
    for (const patch of [{ path: 'https://evil.test'+command.path }, { path: '//evil.test'+command.path }, { path: command.path+'?x=1' }, { body: JSON.stringify({ ...input, totalMinor: 0 }) }, { body: command.body+' ' }, { operation: 'ISSUE' }, { key: id('9') }, { method: 'GET' }]) await expect(submitInvoiceCommand({ ...command, ...patch } as PreparedInvoiceCommand)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('only a fully verified immutable in-memory DRAFT grants issue preparation; issue uses solely its ID/version and a new key', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response()).mockResolvedValueOnce(response(issued, 200, false));
    const receipt = await submitInvoiceCommand(create()) as DraftInvoiceReceipt;
    for (const fake of [{ invoice: draft, replayed: false }, { ...receipt }, { invoice: { ...draft }, replayed: false }, { invoice: { ...issued }, replayed: false }]) expect(() => prepareInvoiceIssue(fake as DraftInvoiceReceipt, id('8'))).toThrow();
    expect(() => prepareInvoiceIssue(receipt, id('5'))).toThrow();
    const command = prepareInvoiceIssue(receipt, id('8'));
    expect(command.path).toBe(`${create().path}/${draft.id}/issue`); expect(command.body).toBe('{"expectedVersion":1}'); expect(command.key).toBe(id('8'));
    const result = await submitInvoiceCommand(command); expect(result).toEqual({ invoice: issued, replayed: false });
    expect(() => prepareInvoiceIssue(result as DraftInvoiceReceipt, id('9'))).toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('supports omitted optional membership, zero/max subtotal, UTC and offset inputs, and exact create/issue replays', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const { membershipId: _, ...withoutMembership } = input;
    const { membershipId: __, ...withoutReceiptMembership } = draft;
    for (const subtotalMinor of [0, 2147483647]) {
      const body = { ...withoutMembership, subtotalMinor, dueAt: draft.dueAt };
      const data = { ...withoutReceiptMembership, subtotalMinor, totalMinor: subtotalMinor };
      fetcher.mockResolvedValueOnce(response(data, 200, true));
      const receipt = await submitInvoiceCommand(prepareInvoiceDraft(scope, body, id('5'))) as DraftInvoiceReceipt;
      expect(receipt.replayed).toBe(true); expect(receipt.invoice).not.toHaveProperty('membershipId');
      fetcher.mockResolvedValueOnce(response({ ...data, status: 'ISSUED', version: 2 }, 200, true));
      expect((await submitInvoiceCommand(prepareInvoiceIssue(receipt, id('8')))).replayed).toBe(true);
    }
  });
  it('rejects every missing, extra, malformed, mismatched and non-DRAFT create receipt without granting issue capability', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const patches = [{ id: 'name' }, { billingAccountId: id('9') }, { membershipId: id('9') }, { membershipId: null }, { status: 'ISSUED' }, { status: 'PAID' }, { status: 'OPEN' }, { currency: 'EUR' }, { subtotalMinor: 1200 }, { discountMinor: 1 }, { totalMinor: 1249 }, { dueAt: '2030-05-02T16:15:30.000Z' }, { dueAt: '2030-05-01T16:15:30Z' }, { createdAt: '2026-02-30T00:00:00.000Z' }, { version: 2 }, { version: '1' }, { payer: 'SECRET' }, { contact: 'SECRET' }, { paymentMethod: 'SECRET' }, { provider: 'SECRET' }, { organizationId: scope.organizationId }];
    const candidates: unknown[] = patches.map(patch => envelope({ ...draft, ...patch }));
    for (const field of Object.keys(draft).filter(field => field !== 'membershipId')) { const data: Record<string, unknown> = { ...draft }; delete data[field]; candidates.push(envelope(data)); }
    candidates.push(null, [], { data: draft }, { ...envelope(), extra: 'SECRET' }, { ...envelope(), meta: { ...envelope().meta, scope } }, { ...envelope(), meta: { ...envelope().meta, correlationId: id('9') } }, { ...envelope(), meta: { ...envelope().meta, replayed: 'false' } });
    for (const value of candidates) { fetcher.mockResolvedValueOnce(Response.json(value, { status: 201 })); await expect(submitInvoiceCommand(create())).rejects.toBeInstanceOf(InvoiceUncertainError); }
  });
  it('issue verifies all returned facts against the retained draft, exact status and version increment', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response());
    const receipt = await submitInvoiceCommand(create()) as DraftInvoiceReceipt;
    const command = prepareInvoiceIssue(receipt, id('8'));
    for (const patch of [{ id: id('9') }, { billingAccountId: id('9') }, { membershipId: id('9') }, { status: 'DRAFT' }, { status: 'PAID' }, { version: 1 }, { version: 3 }, { totalMinor: 1251 }, { discountMinor: 1 }, { dueAt: undefined }, { createdAt: '2026-10-18T00:00:00.000Z' }, { provider: 'SECRET' }]) { fetcher.mockResolvedValueOnce(response({ ...issued, ...patch }, 200, false)); await expect(submitInvoiceCommand(command)).rejects.toBeInstanceOf(InvoiceUncertainError); }
    fetcher.mockResolvedValueOnce(response(issued, 201, false)); await expect(submitInvoiceCommand(command)).rejects.toBeInstanceOf(InvoiceUncertainError);
  });
  it('classifies only exact in-progress as uncertainty, clears access and definite rejection, and never echoes raw problems', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const status of [401, 403]) { fetcher.mockResolvedValue(Response.json({ detail: 'SQL_SECRET' }, { status })); await expect(submitInvoiceCommand(create())).rejects.toBeInstanceOf(InvoiceAccessError); }
    for (const status of [400, 404, 409, 413, 415, 422]) { fetcher.mockResolvedValue(Response.json({ code: 'VERSION_CONFLICT', detail: 'SQL_SECRET' }, { status })); await expect(submitInvoiceCommand(create())).rejects.toBeInstanceOf(InvoiceRejectedError); await expect(submitInvoiceCommand(create())).rejects.not.toThrow('SQL_SECRET'); }
    fetcher.mockResolvedValue(Response.json({ code: 'IDEMPOTENCY_IN_PROGRESS', detail: 'SQL_SECRET' }, { status: 409 })); await expect(submitInvoiceCommand(create())).rejects.toBeInstanceOf(InvoiceUncertainError);
    for (const extra of [{ extra: true }, { detail: null }]) { fetcher.mockResolvedValueOnce(Response.json({ code: 'IDEMPOTENCY_IN_PROGRESS', detail: 'x', ...extra }, { status: 409 })); await expect(submitInvoiceCommand(create())).rejects.toBeInstanceOf(InvoiceRejectedError); }
  });
  it('never auto-retries network/server/redirect/non-JSON/oversized or wrong status/replay outcomes', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('NETWORK_SECRET'));
    await expect(submitInvoiceCommand(create())).rejects.toBeInstanceOf(InvoiceUncertainError);
    const candidates = [new Response('bad', { status: 201, headers: { 'Content-Type': 'application/json' } }), new Response('x'.repeat(4001), { status: 201, headers: { 'Content-Type': 'application/json' } }), new Response(JSON.stringify(envelope()), { status: 201, headers: { 'Content-Type': 'text/html' } }), response(draft, 200, false), response(draft, 201, true), new Response(null, { status: 202 }), new Response(null, { status: 302 }), new Response(null, { status: 503 })];
    const redirected = response(); Object.defineProperty(redirected, 'redirected', { value: true }); candidates.push(redirected);
    for (const candidate of candidates) { fetcher.mockResolvedValueOnce(candidate); await expect(submitInvoiceCommand(create())).rejects.toBeInstanceOf(InvoiceUncertainError); }
    expect(fetcher).toHaveBeenCalledTimes(candidates.length + 1);
  });
});
