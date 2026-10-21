import React, { type ReactElement } from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { CrmLeadsWorkbench } from '../src/components/crm-leads-workbench';
import { CrmAdultFlow } from '../src/components/crm-adult-flow';
import { CrmAdultRecoveryPending } from '../src/components/crm-adult-recovery-pending';
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock('react', async () => { const actual = await vi.importActual<typeof import('react')>('react'); return { ...actual,
  useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = initial; return [hooks.values[i], (v: unknown) => { hooks.values[i] = typeof v === 'function' ? (v as Function)(hooks.values[i]) : v; }]; },
  useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = { current: initial }; return hooks.values[i]; },
  useEffect: (effect: () => (() => void) | void, deps: unknown[]) => { const i = hooks.cursor++, prior = hooks.values[i] as { deps: unknown[]; cleanup?: (() => void) | undefined } | undefined; if (!prior || deps.some((v, j) => v !== prior.deps[j])) { prior?.cleanup?.(); hooks.values[i] = { deps }; hooks.effects.push(() => { (hooks.values[i] as { cleanup?: (() => void) | undefined }).cleanup = effect() || undefined; }); } },
}; });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { organizationId: id(1), schoolId: id(2) };
const row = { id: id(3), primaryPersonId: id(4), status: 'WON', pipelineStageId: id(8), version: 1, createdAt: '2026-10-20T00:00:00.000Z', givenName: 'Ari', familyName: 'Stone' };
const ready = { leadId: id(3), workflowState: 'BILLING_ACCOUNT_REQUIRED', historicalRegistrationReceipt: { outcome: 'REGISTERED', leadId: id(3), sourceContactPersonId: id(4), registrationPath: 'ADULT', studentProfileId: id(5), familyId: null, recordedAt: '2026-10-20T09:00:00.000Z' } };
const response = (data: unknown, status = 200) => new Response(JSON.stringify({ data, meta: { requestId: id(8), correlationId: id(8), replayed: false } }), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
type Element = ReactElement<Record<string, any>>;
function elements(node: unknown): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (React.isValidElement(node)) { const e = node as Element; return [e, ...elements(e.props.children)]; } return []; }
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(''); if (React.isValidElement(node)) return text((node as Element).props.children); return typeof node === 'string' ? node : ''; }
function render(): Element { hooks.cursor = 0; const t = CrmLeadsWorkbench({ initialScope: scope }) as Element; hooks.effects.splice(0).forEach(run => run()); return t; }
function unmount(): void { for (const v of hooks.values) if (v && typeof v === 'object' && 'cleanup' in v) (v as { cleanup?: (() => void) | undefined }).cleanup?.(); }
const button = (t: Element, label: string) => elements(t).find(e => e.type === 'button' && text(e) === label)!;
const panel = () => elements(render()).find(e => e.type === CrmAdultFlow);
const pending = () => elements(render()).find(e => e.type === CrmAdultRecoveryPending)!;
const settle = async () => { for (let i = 0; i < 55; i++) await Promise.resolve(); };
async function load(): Promise<void> { elements(render()).find(e => e.type === 'form')!.props.onSubmit({ preventDefault() {} }); await settle(); }
beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; vi.clearAllMocks(); vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('document', new EventTarget()); });
afterEach(() => { unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('performs no recovery on mount/list load, then one explicit read despite duplicate clicks', async () => {
  let resolve!: (r: Response) => void;
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response([row])).mockImplementationOnce(() => new Promise(yes => { resolve = yes; }));
  render(); expect(f).not.toHaveBeenCalled(); await load(); expect(f).toHaveBeenCalledTimes(1);
  const t = render(), resume = button(t, 'Resume setup'); resume.props.onClick(); resume.props.onClick(); expect(f).toHaveBeenCalledTimes(2);
  expect(pending().props.busy).toBe(true); resolve(response(ready)); await settle();
  expect(panel()?.props.initialRecovery).toEqual(ready); expect(f).toHaveBeenCalledTimes(2);
});
it.each([409, 503])('retains no state after %s and retries only after another explicit read action', async status => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response([row])).mockResolvedValueOnce(response({ private: 'canary' }, status)).mockResolvedValueOnce(response(ready));
  await load(); button(render(), 'Resume setup').props.onClick(); await settle(); expect(panel()).toBeUndefined();
  expect(pending().props.error).not.toContain('canary'); expect(pending().props.busy).toBe(false); expect(f).toHaveBeenCalledTimes(2);
  pending().props.onRetry(); await settle(); expect(panel()?.props.initialRecovery).toEqual(ready); expect(f).toHaveBeenCalledTimes(3);
});
it.each([401, 403])('discards scope/list/recovery on %s without displaying private details', async status => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response([row])).mockResolvedValueOnce(response({ private: 'canary' }, status));
  await load(); button(render(), 'Resume setup').props.onClick(); await settle();
  expect(panel()).toBeUndefined(); expect(pending()).toBeUndefined(); expect(text(render())).toContain('Scoped list, draft, retry and receipt discarded');
  expect(text(render())).not.toContain('canary'); expect(elements(render()).filter(e => e.type === 'input').map(e => e.props.value)).toEqual(['', '']);
});
it('returns to the list on 404 and requires an explicit reload before another selection', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response([row])).mockResolvedValueOnce(response({}, 404));
  await load(); button(render(), 'Resume setup').props.onClick(); await settle();
  expect(panel()).toBeUndefined(); expect(pending()).toBeUndefined(); expect(text(render())).toContain('This lead is unavailable');
  expect(button(render(), 'Resume setup').props.disabled).toBe(true); expect(button(render(), 'Load CRM leads').props.disabled).toBe(false); expect(f).toHaveBeenCalledTimes(2);
});
it.each(['school', 'blur', 'pagehide', 'close', 'unmount'])('aborts and ignores a late recovery after %s', async reason => {
  let resolve!: (r: Response) => void;
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response([row])).mockImplementationOnce(() => new Promise(yes => { resolve = yes; }));
  await load(); button(render(), 'Resume setup').props.onClick(); render();
  if (reason === 'school') elements(render()).find(e => e.type === 'input' && e.props.value === scope.schoolId)!.props.onChange({ target: { value: id(99) } });
  else if (reason === 'close') pending().props.onCancel();
  else if (reason === 'unmount') unmount();
  else window.dispatchEvent(new Event(reason));
  expect(f.mock.calls[1]![1]!.signal!.aborted).toBe(true); resolve(response(ready)); await settle();
  expect(panel()).toBeUndefined(); expect(text(render())).not.toContain(id(5));
});
it('discards recovered state before an explicit refresh and never reuses it after a failed read', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response([row])).mockResolvedValueOnce(response(ready)).mockResolvedValueOnce(response({}, 503));
  await load(); button(render(), 'Resume setup').props.onClick(); await settle(); expect(panel()).toBeDefined();
  panel()!.props.onRecover(); expect(panel()).toBeUndefined(); await settle(); expect(panel()).toBeUndefined(); expect(pending().props.error).toContain('No workflow state is assumed');
});
