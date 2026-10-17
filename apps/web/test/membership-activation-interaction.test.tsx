import React from 'react';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const harness = vi.hoisted(() => ({ slots: [] as any[], cursor: 0 }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  const hooks = {
    useState(initial: any) { const i = harness.cursor++; if (!harness.slots[i]) harness.slots[i] = { value: typeof initial === 'function' ? initial() : initial }; return [harness.slots[i].value, (value: any) => { harness.slots[i].value = typeof value === 'function' ? value(harness.slots[i].value) : value; }]; },
    useRef(initial: any) { const i = harness.cursor++; return harness.slots[i] ?? (harness.slots[i] = { current: initial }); },
  };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
import { MembershipActivationWorkbench } from '../src/components/membership-activation-workbench';
const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const scope = { organizationId: id('1'), schoolId: id('2'), membershipId: id('3') };
const current = { ...scope, state: 'DRAFT', version: 1 };
const saved = { id: scope.membershipId, billingAccountId: id('4'), participantPersonId: id('5'), planCode: 'KNOWN_DRAFT', state: 'ACTIVE', version: 2, createdAt: '2026-10-16T00:00:00.000Z' };
const envelope = (data: unknown, replayed = false) => Response.json({ data, meta: { requestId: id('6'), correlationId: id('6'), replayed } });
const render = () => { harness.cursor = 0; return MembershipActivationWorkbench(); };
const nodes = (tree: any, type: string): any[] => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(value => nodes(value, type)) : [...(tree.type === type ? [tree] : []), ...nodes(tree.props?.children, type)];
const html = () => renderToStaticMarkup(render());
const button = (name: string) => nodes(render(), 'button').find(node => node.props.children === name);
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
async function load() {
  let tree = render(); Object.values(scope).forEach((value, i) => nodes(tree, 'input')[i].props.onChange({ target: { value } }));
  nodes(render(), 'form')[0].props.onSubmit({ preventDefault: vi.fn() }); await flush();
}
function confirm() { nodes(render(), 'input').find(node => node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); }
beforeEach(() => { harness.slots = []; harness.cursor = 0; });
afterEach(() => vi.restoreAllMocks());

describe('membership activation human UI lifecycle', () => {
  it('does nothing on mount, activates DRAFT only after explicit confirmation, then shows a saved result not current/payment/agreement status', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(current)).mockResolvedValueOnce(envelope(saved));
    render(); expect(fetcher).not.toHaveBeenCalled(); await load();
    expect(html()).toContain('DRAFT'); expect(button('Activate membership only').props.disabled).toBe(true);
    confirm(); expect(button('Activate membership only').props.disabled).toBe(false);
    button('Activate membership only').props.onClick(); await flush();
    expect(fetcher).toHaveBeenCalledTimes(2); expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string)).toEqual({ expectedVersion: 1 });
    expect(html()).toContain('Saved activation result: ACTIVE at version 2'); expect(html()).toContain('Reload to observe current state');
    expect(html()).not.toContain('Current membership observation'); expect(html()).not.toContain(saved.billingAccountId);
    expect(button('Activate membership only')).toBeUndefined();
  });
  it('retains exactly the same version/key/known IDs across uncertain retries, never resubmitting automatically', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(current)).mockRejectedValueOnce(new Error('Uncertain result')).mockResolvedValueOnce(envelope(saved, true));
    await load(); confirm(); button('Activate membership only').props.onClick(); await flush();
    expect(html()).toContain('No activation is assumed'); expect(button('Retry exact retained activation')).toBeDefined(); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(nodes(render(), 'fieldset')[0].props.disabled).toBe(true);
    button('Retry exact retained activation').props.onClick(); await flush();
    expect(fetcher.mock.calls[1]).toEqual(fetcher.mock.calls[2]); expect(html()).toContain('idempotent replay');
    expect(button('Retry exact retained activation')).toBeUndefined();
  });
  it('clears observations and retained retries after 403/409, and shows ACTIVE as no-action rather than signed/paid', async () => {
    for (const status of [403, 409]) {
      harness.slots = []; const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(current)).mockResolvedValueOnce(new Response('', { status }));
      await load(); confirm(); button('Activate membership only').props.onClick(); await flush();
      expect(button('Retry exact retained activation')).toBeUndefined(); expect(button('Activate membership only')).toBeUndefined(); expect(html()).not.toContain('Current membership observation'); fetcher.mockRestore();
    }
    harness.slots = []; const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope({ ...current, state: 'ACTIVE', version: 2 }));
    await load(); expect(html()).toContain('Already ACTIVE'); expect(button('Activate membership only')).toBeUndefined(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('clears a prior observation on ID edits and ignores a late read for a different known membership', async () => {
    let resolve!: (response: Response) => void; const pending = new Promise<Response>(done => { resolve = done; });
    const fetcher = vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(pending);
    await load(); nodes(render(), 'input')[2].props.onChange({ target: { value: id('9') } });
    resolve(envelope(current)); await flush(); expect(html()).not.toContain('Current membership observation'); expect(button('Activate membership only')).toBeUndefined(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
