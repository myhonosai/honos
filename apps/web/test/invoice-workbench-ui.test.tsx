import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual,
    useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = initial; return [hooks.cells[i], (value: unknown) => { hooks.cells[i] = typeof value === 'function' ? (value as (v: unknown) => unknown)(hooks.cells[i]) : value; }]; },
    useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = { current: initial }; return hooks.cells[i]; },
    useEffect: (effect: () => (() => void) | void) => { const i = hooks.cursor++; if (!(i in hooks.cells)) { hooks.cells[i] = {}; hooks.effects.push(() => { (hooks.cells[i] as { cleanup?: (() => void) | undefined }).cleanup = effect() || undefined; }); } },
  };
});
import { InvoiceWorkbench } from '../src/components/invoice-workbench';
const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const values = { organizationId: id('1'), schoolId: id('2'), billingAccountId: id('3'), membershipId: id('4'), currency: 'USD', subtotalMinor: '1250', dueAt: '2030-05-01T09:15:30-07:00' };
const draft = { id: id('6'), billingAccountId: values.billingAccountId, membershipId: values.membershipId, status: 'DRAFT', currency: 'USD', subtotalMinor: 1250, discountMinor: 0, totalMinor: 1250, dueAt: '2030-05-01T16:15:30.000Z', version: 1, createdAt: '2026-10-17T00:00:00.000Z' };
const issued = { ...draft, status: 'ISSUED', version: 2 };
const response = (data: unknown = draft, status = 201, replayed = status === 200) => Response.json({ data, meta: { requestId: id('7'), correlationId: id('7'), replayed } }, { status });
type Element = ReactElement<Record<string, any>>;
function elements(node: unknown): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (!React.isValidElement(node)) return []; const e = node as Element; return [e, ...elements(e.props.children)]; }
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(' '); if (React.isValidElement(node)) return text((node as Element).props.children); return typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
function render(): Element { hooks.cursor = 0; const tree = InvoiceWorkbench() as Element; hooks.effects.splice(0).forEach(run => run()); return tree; }
function unmount(): void { for (const cell of hooks.cells) if (cell && typeof cell === 'object' && 'cleanup' in cell) (cell as { cleanup?: () => void }).cleanup?.(); }
const button = (label: string) => elements(render()).find(e => e.type === 'button' && text(e) === label);
const field = (name: string) => elements(render()).find(e => e.props.name === name)!;
function edit(name: string, value: string): void { field(name).props.onChange({ target: { value } }); }
function submit(which = 0): void { elements(render()).filter(e => e.type === 'form')[which]!.props.onSubmit({ preventDefault() {} }); }
function confirm(name = 'createConfirmed'): void { field(name).props.onChange({ target: { checked: true } }); }
function fill(): void { for (const [name, value] of Object.entries(values)) edit(name, value); }
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
beforeEach(() => { hooks.cells = []; hooks.cursor = 0; hooks.effects = []; });
afterEach(() => { unmount(); vi.restoreAllMocks(); });

describe('safe direct-human invoice workbench', () => {
  it('starts blank and idle with only the seven permitted inputs and no issue; valid explicit confirmation generates one key/create only', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response()); const allocate = vi.spyOn(crypto, 'randomUUID');
    expect(elements(render()).filter(e => e.type === 'input' && e.props.type !== 'checkbox').map(e => [e.props.name, e.props.value])).toEqual(Object.keys(values).map(name => [name, '']));
    expect(button('Issue verified DRAFT invoice')).toBeUndefined(); submit(); confirm(); submit(); await settle();
    expect(fetcher).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled();
    fill(); submit(); await settle(); expect(fetcher).not.toHaveBeenCalled();
    confirm(); submit(); submit(); await settle();
    expect(fetcher).toHaveBeenCalledTimes(1); expect(allocate).toHaveBeenCalledTimes(1);
    expect(text(render())).toContain('Returned invoice receipt:  DRAFT');
    expect(button('Issue verified DRAFT invoice')!.props.disabled).toBe(true);
    submit(); submit(1); await settle(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('only separately confirmed verified DRAFT may issue; sends solely the receipt ID/version with a different v4 key and displays exact ISSUED facts', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response()).mockResolvedValueOnce(response(issued, 200, false));
    const allocate = vi.spyOn(crypto, 'randomUUID');
    fill(); confirm(); submit(); await settle();
    submit(1); await settle(); expect(fetcher).toHaveBeenCalledTimes(1);
    confirm('issueConfirmed'); submit(1); await settle();
    expect(fetcher.mock.calls[1]![0]).toBe(`${fetcher.mock.calls[0]![0]}/${draft.id}/issue`);
    expect(fetcher.mock.calls[1]![1]!.body).toBe('{"expectedVersion":1}');
    const createKey = (fetcher.mock.calls[0]![1]!.headers as Record<string, string>)['Idempotency-Key'];
    const issueKey = (fetcher.mock.calls[1]![1]!.headers as Record<string, string>)['Idempotency-Key'];
    expect(issueKey).not.toBe(createKey); expect(issueKey![14]).toBe('4'); expect(allocate).toHaveBeenCalledTimes(2);
    expect(text(render())).toContain('Returned invoice receipt:  ISSUED'); expect(text(render())).not.toContain('Returned invoice receipt:  DRAFT');
    expect(button('Issue verified DRAFT invoice')).toBeUndefined(); expect(button('Retry exact unchanged invoice command')).toBeUndefined();
    for (const value of [issued.id, issued.billingAccountId, issued.membershipId, issued.currency, issued.dueAt, issued.createdAt]) expect(text(render())).toContain(value);
  });
  it('retains identical uncertain CREATE only for separate retry, blocks fresh submit/issue, uses same key and invalidates stale retry after edits', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('NETWORK_SECRET')).mockResolvedValueOnce(response(draft, 200));
    const allocate = vi.spyOn(crypto, 'randomUUID'); fill(); confirm(); submit(); await settle();
    const retry = button('Retry exact unchanged invoice command')!; expect(retry).toBeDefined();
    expect(text(render())).not.toContain('NETWORK_SECRET'); expect(button('Issue verified DRAFT invoice')).toBeUndefined();
    submit(); await settle(); expect(fetcher).toHaveBeenCalledTimes(1);
    retry.props.onClick(); retry.props.onClick(); await settle();
    expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1]); expect(allocate).toHaveBeenCalledTimes(1);
    retry.props.onClick(); await settle(); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(text(render())).toContain('Replayed command receipt.');
    edit('currency', 'USD'); expect(text(render())).not.toContain(draft.id); expect(field('createConfirmed').props.checked).toBe(false);
    fetcher.mockRejectedValueOnce(new Error('network')); confirm(); submit(); await settle();
    const old = button('Retry exact unchanged invoice command')!; edit('dueAt', values.dueAt); old.props.onClick(); await settle();
    expect(fetcher).toHaveBeenCalledTimes(3); expect(button('Retry exact unchanged invoice command')).toBeUndefined();
  });
  it('uncertain ISSUE hides stale DRAFT/issue action and retries only retained receipt-bound path/body/key, never a fresh issue', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(response(issued, 200, true));
    const allocate = vi.spyOn(crypto, 'randomUUID'); fill(); confirm(); submit(); await settle();
    confirm('issueConfirmed'); const oldIssue = elements(render()).filter(e => e.type === 'form')[1]!;
    submit(1); await settle(); expect(button('Issue verified DRAFT invoice')).toBeUndefined(); expect(text(render())).not.toContain(draft.id);
    const retry = button('Retry exact unchanged invoice command')!; expect(retry).toBeDefined();
    oldIssue.props.onSubmit({ preventDefault() {} }); submit(); await settle(); expect(fetcher).toHaveBeenCalledTimes(2);
    retry.props.onClick(); retry.props.onClick(); await settle();
    expect(fetcher.mock.calls[1]).toEqual(fetcher.mock.calls[2]); expect(allocate).toHaveBeenCalledTimes(2);
    expect(text(render())).toContain('Returned invoice receipt:  ISSUED');
    retry.props.onClick(); oldIssue.props.onSubmit({ preventDefault() {} }); await settle(); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('every input edit clears draft or issued receipt, both confirmations and uncertain ISSUE retry including stale handlers', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const [name, value] of Object.entries(values)) {
      fill(); fetcher.mockResolvedValueOnce(response()); confirm(); submit(); await settle(); confirm('issueConfirmed');
      const oldIssue = elements(render()).filter(e => e.type === 'form')[1]!;
      const count = fetcher.mock.calls.length; edit(name, value); oldIssue.props.onSubmit({ preventDefault() {} }); await settle();
      expect(fetcher).toHaveBeenCalledTimes(count); expect(text(render())).not.toContain(draft.id); expect(field('createConfirmed').props.checked).toBe(false);
      fetcher.mockResolvedValueOnce(response()); confirm(); submit(); await settle();
      fetcher.mockRejectedValueOnce(new Error('network')); confirm('issueConfirmed'); submit(1); await settle();
      const oldRetry = button('Retry exact unchanged invoice command')!; expect(oldRetry).toBeDefined();
      const nextCount = fetcher.mock.calls.length; edit(name, value); oldRetry.props.onClick(); await settle();
      expect(fetcher).toHaveBeenCalledTimes(nextCount); expect(button('Retry exact unchanged invoice command')).toBeUndefined();
    }
    fill(); fetcher.mockResolvedValueOnce(response()); confirm(); submit(); await settle();
    fetcher.mockResolvedValueOnce(response(issued, 200, false)); confirm('issueConfirmed'); submit(1); await settle();
    edit('billingAccountId', values.billingAccountId); expect(text(render())).not.toContain(issued.id);
  });
  it('clears invalid facts on definite CREATE/ISSUE conflict and requires an edited or discarded new explicit draft attempt', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ detail: 'SECRET' }, { status: 409 }));
    fill(); confirm(); submit(); await settle();
    expect(button('Retry exact unchanged invoice command')).toBeUndefined(); expect(text(render())).not.toContain('SECRET'); expect(field('createConfirmed').props.checked).toBe(false);
    confirm(); submit(); await settle(); expect(fetcher).toHaveBeenCalledTimes(1);
    edit('subtotalMinor', values.subtotalMinor); fetcher.mockResolvedValueOnce(response()); confirm(); submit(); await settle();
    fetcher.mockResolvedValueOnce(Response.json({ code: 'VERSION_CONFLICT', detail: 'SECRET' }, { status: 409 })); confirm('issueConfirmed'); submit(1); await settle();
    expect(text(render())).not.toContain(draft.id); expect(button('Issue verified DRAFT invoice')).toBeUndefined(); expect(button('Retry exact unchanged invoice command')).toBeUndefined();
    submit(); await settle(); expect(fetcher).toHaveBeenCalledTimes(3);
    button('Discard inputs / start over')!.props.onClick(); expect(field('billingAccountId').props.value).toBe('');
  });
  it('401/403 on either command clears all private input, receipts, confirmations and retries', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const status of [401, 403]) for (const operation of ['CREATE', 'ISSUE']) for (const retrying of [false, true]) {
      fill();
      if (operation === 'ISSUE') { fetcher.mockResolvedValueOnce(response()); confirm(); submit(); await settle(); confirm('issueConfirmed'); }
      else confirm();
      let oldRetry: Element | undefined;
      if (retrying) {
        fetcher.mockRejectedValueOnce(new Error('network')); submit(operation === 'ISSUE' ? 1 : 0); await settle();
        oldRetry = button('Retry exact unchanged invoice command')!; expect(oldRetry).toBeDefined();
      }
      fetcher.mockResolvedValueOnce(Response.json({ detail: 'PRIVATE_SECRET' }, { status }));
      if (oldRetry) oldRetry.props.onClick(); else submit(operation === 'ISSUE' ? 1 : 0);
      await settle();
      for (const name of Object.keys(values)) expect(field(name).props.value).toBe('');
      expect(field('createConfirmed').props.checked).toBe(false); expect(button('Issue verified DRAFT invoice')).toBeUndefined(); expect(button('Retry exact unchanged invoice command')).toBeUndefined();
      expect(text(render())).not.toContain(draft.id); expect(text(render())).not.toContain('PRIVATE_SECRET'); expect(text(render())).toContain('All inputs, receipts and retries were cleared');
      const count = fetcher.mock.calls.length; oldRetry?.props.onClick(); await settle(); expect(fetcher).toHaveBeenCalledTimes(count);
    }
  });
  it('does not render malformed or private provider/payer facts, treats malformed CREATE/ISSUE as uncertain and explains no effects', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({ ...draft, payer: 'PAYER_SECRET', provider: 'PROVIDER_SECRET' }));
    fill(); confirm(); submit(); await settle();
    expect(text(render())).not.toContain('PAYER_SECRET'); expect(text(render())).not.toContain('PROVIDER_SECRET'); expect(button('Issue verified DRAFT invoice')).toBeUndefined(); expect(button('Retry exact unchanged invoice command')).toBeDefined();
    button('Discard inputs / start over')!.props.onClick(); fill(); fetcher.mockResolvedValueOnce(response()); confirm(); submit(); await settle();
    fetcher.mockResolvedValueOnce(response({ ...issued, version: 3 }, 200, false)); confirm('issueConfirmed'); submit(1); await settle();
    expect(text(render())).not.toContain('Returned invoice receipt:'); expect(button('Retry exact unchanged invoice command')).toBeDefined();
    for (const phrase of ['issuing is not delivery or collection', 'payment authorization or a payment attempt', 'checkout or card capture', 'recurring schedule', 'provider execution or reconciliation', 'financial adjustment, refund, credit or discount', 'agreement', 'membership change', 'communications', 'schedule or attendance changes', 'AI, Action Engine or automation effect', 'cannot undo a command']) expect(text(render())).toContain(phrase);
  });
  it('locks pending inputs, deduplicates rapid commands, ignores stale handlers and delayed results after unmount/remount', async () => {
    let finish!: (value: Response) => void;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    fill(); confirm(); submit(); submit();
    expect(elements(render()).find(e => e.type === 'fieldset')!.props.disabled).toBe(true);
    edit('billingAccountId', id('9')); expect(field('billingAccountId').props.value).toBe(values.billingAccountId);
    unmount(); const snapshot = hooks.cells.slice(); finish(response()); await settle(); expect(hooks.cells).toEqual(snapshot); expect(fetcher).toHaveBeenCalledTimes(1);
    hooks.cells = []; hooks.effects = []; render(); expect(field('billingAccountId').props.value).toBe(''); expect(button('Issue verified DRAFT invoice')).toBeUndefined(); expect(button('Retry exact unchanged invoice command')).toBeUndefined();
  });
  it('has no persistence, polling, auto transport, arbitrary invoice, authority inputs, lookup or downstream executors', () => {
    const ui = readFileSync('src/components/invoice-workbench.tsx', 'utf8'), http = readFileSync('src/components/invoice-workbench-http.ts', 'utf8');
    expect(ui + http).not.toMatch(/localStorage|sessionStorage|setInterval|setTimeout|invokeLLM|executeAction|sendMessage|providerClient|load[A-Z]|\/people|\/search|\/payers|\/billing-accounts|\/memberships/);
    expect(ui).not.toMatch(/fetch\(|searchParams|window\.location/); expect(http.match(/fetch\(/g)).toHaveLength(1); expect(http).not.toContain("method: 'GET'");
    for (const name of ['invoiceId', 'totalMinor', 'discountMinor', 'status', 'expectedVersion', 'version', 'actor', 'principalId', 'source', 'actionRequestId', 'delegatedByPrincipalId', 'outbox', 'audit']) expect(ui).not.toContain(`name="${name}"`);
    expect(ui).toContain('currentReceipt.current !== draft'); expect(ui).toContain('retained.current !== command');
  });
});
