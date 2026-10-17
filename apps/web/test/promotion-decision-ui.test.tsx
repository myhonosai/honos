import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual,
    useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = initial; return [hooks.cells[i], (value: unknown) => { hooks.cells[i] = typeof value === 'function' ? (value as (v: unknown) => unknown)(hooks.cells[i]) : value; }]; },
    useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = { current: initial }; return hooks.cells[i]; },
    useEffect: (effect: () => (() => void) | void) => { const i = hooks.cursor++; if (!(i in hooks.cells)) { hooks.cells[i] = { setup: effect }; hooks.effects.push(() => { (hooks.cells[i] as { cleanup?: (() => void) | undefined }).cleanup = effect() || undefined; }); } },
  };
});
import { PromotionDecisionWorkbench } from '../src/components/promotion-decision-workbench';
const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const ids = { organizationId: id('1'), schoolId: id('2'), candidateId: id('a') };
const decision = { id: id('3'), testingCandidateId: ids.candidateId, studentCurriculumEnrollmentId: id('4'), priorRankId: id('5'), targetRankId: id('6'), status: 'PROMOTED', instructorPrincipalId: id('7'), rationale: 'PRIVATE_RATIONALE', decidedAt: '2026-10-16T12:00:00.123456+00:00', version: 1, createdAt: '2026-10-16T12:00:00.123456+00:00' };
const response = (data: unknown = decision, replayed = false) => Response.json({ data, meta: { requestId: id('8'), correlationId: id('8'), replayed } }, { status: replayed ? 200 : 201 });
type Element = ReactElement<Record<string, any>>;
function elements(node: unknown): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (!React.isValidElement(node)) return []; const e = node as Element; return [e, ...elements(e.props.children)]; }
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(' '); if (React.isValidElement(node)) return text((node as Element).props.children); return typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
function render(): Element { hooks.cursor = 0; const tree = PromotionDecisionWorkbench() as Element; hooks.effects.splice(0).forEach(run => run()); return tree; }
function unmount(): void { for (const cell of hooks.cells) if (cell && typeof cell === 'object' && 'cleanup' in cell) (cell as { cleanup?: () => void }).cleanup?.(); }
const button = (label: string) => elements(render()).find(e => e.type === 'button' && text(e) === label);
const field = (name: string) => elements(render()).find(e => e.props.name === name);
function edit(name: string, value: string): void { field(name)!.props.onChange({ target: { value } }); }
function submit(): void { elements(render()).find(e => e.type === 'form')!.props.onSubmit({ preventDefault() {} }); }
function confirm(checked = true): void { field('confirmPromotionDecision')!.props.onChange({ target: { checked } }); }
function fill(status = 'PROMOTED'): void { for (const [name, value] of Object.entries(ids)) edit(name, value); edit('expectedVersion', '3'); edit('status', status); edit('rationale', 'PRIVATE_RATIONALE'); }
const settle = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
beforeEach(() => { hooks.cells = []; hooks.cursor = 0; hooks.effects = []; });
afterEach(() => { unmount(); vi.restoreAllMocks(); });

describe('bounded final human promotion-decision UI', () => {
  it('starts blank and idle and requires explicit confirmation before one generated key and request', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response()); const allocate = vi.spyOn(crypto, 'randomUUID');
    expect(elements(render()).filter(e => e.type === 'input' && e.props.type !== 'checkbox').map(e => e.props.value)).toEqual(['', '', '', '']); expect(field('rationale')!.props.value).toBe(''); expect(field('status')!.props.value).toBe('');
    expect(elements(render()).filter(e => e.type === 'option').map(e => e.props.value)).toEqual(['', 'PROMOTED', 'DEFERRED', 'NOT_PROMOTED']);
    confirm(); submit(); await settle(); expect(fetcher).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled();
    fill(); submit(); await settle(); expect(fetcher).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled();
    confirm(); submit(); submit(); await settle(); expect(fetcher).toHaveBeenCalledTimes(1); expect(allocate).toHaveBeenCalledTimes(1); expect(text(render())).toContain('Returned final decision: PROMOTED'); expect(text(render())).not.toContain('PRIVATE_RATIONALE'); expect(text(render())).not.toContain(decision.instructorPrincipalId);
  });
  it('accepts each closed final status as a human decision only and never claims an external effect', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const status of ['PROMOTED', 'DEFERRED', 'NOT_PROMOTED']) { fetcher.mockResolvedValueOnce(response({ ...decision, status })); fill(status); confirm(); submit(); await settle(); const copy = text(render());
      expect(copy).toContain(`Returned final decision: ${status}`); for (const phrase of ['final human instructor decision', 'terminal candidate, current enrollment, target rank and promotion prerequisites', 'No external certificate, parent notice, attendance record, billing/payment change, message, provider, AI, Action Engine, automation or effect consumer', 'not live candidate status, readiness, eligibility or a certificate/notification claim', 'No instructor/actor, authority, audit or outbox data is displayed']) expect(copy).toContain(phrase);
      expect(copy).not.toContain('PRIVATE_RATIONALE'); expect(elements(render()).filter(e => e.type === 'a').map(e => e.props.href)).toEqual(['/staff/dashboard']); }
  });
  it('clears confirmation, receipt and retry on every edit and permits only an exact in-memory retry after uncertainty', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('NETWORK_SECRET')).mockResolvedValueOnce(response(decision, true)); const allocate = vi.spyOn(crypto, 'randomUUID');
    fill(); confirm(); submit(); await settle(); const retry = button('Retry exact unchanged promotion decision')!; expect(retry).toBeDefined(); expect(text(render())).not.toMatch(/NETWORK_SECRET|PRIVATE_RATIONALE/);
    confirm(); submit(); await settle(); expect(fetcher).toHaveBeenCalledTimes(1); retry.props.onClick(); retry.props.onClick(); await settle(); expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1]); expect(allocate).toHaveBeenCalledTimes(1); expect(text(render())).toContain('Replayed or previously recorded final-decision receipt');
    fill(); confirm(); fetcher.mockRejectedValueOnce(new Error('network')); submit(); await settle(); const staleRetry = button('Retry exact unchanged promotion decision')!; edit('status', 'DEFERRED'); staleRetry.props.onClick(); await settle(); expect(button('Retry exact unchanged promotion decision')).toBeUndefined();
  });
  it('clears all command state and no retained retry on 401/403, including a replay', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const status of [401, 403]) for (const replay of [false, true]) { fill(); confirm(); if (replay) { fetcher.mockRejectedValueOnce(new Error('network')); submit(); await settle(); }
      fetcher.mockResolvedValueOnce(Response.json({ detail: 'SECRET' }, { status })); if (replay) button('Retry exact unchanged promotion decision')!.props.onClick(); else submit(); await settle();
      expect([...Object.keys(ids), 'expectedVersion', 'status', 'rationale'].map(name => field(name)!.props.value)).toEqual(['', '', '', '', '', '']); expect(field('confirmPromotionDecision')!.props.checked).toBe(false); expect(button('Retry exact unchanged promotion decision')).toBeUndefined(); expect(text(render())).not.toMatch(/SECRET|PRIVATE_RATIONALE|Returned final decision:/); expect(text(render())).toContain('Inputs, rationale, receipt and retry were cleared'); }
  });
  it('adds no read/list/search, persistence, URL prefill, timer, generic navigation or downstream client/action', () => {
    const ui = readFileSync('src/components/promotion-decision-workbench.tsx', 'utf8'); const http = readFileSync('src/components/promotion-decision-http.ts', 'utf8');
    expect(ui + http).not.toMatch(/localStorage|sessionStorage|indexedDB|setInterval|setTimeout|invokeLLM|executeAction|sendMessage|providerClient|searchParams|window\.location|dangerouslySetInnerHTML|\/people|\/roster|\/search|\/billing|\/parent|\/ranks|\/enrollments|\/certificates|\/scorecards|method: 'GET'/);
    expect(ui).not.toMatch(/fetch\(/); expect(http.match(/fetch\(/g)).toHaveLength(1); expect(ui.match(/crypto\.randomUUID\(\)/g)).toHaveLength(1); expect(http).not.toMatch(/crypto\.randomUUID/); expect(ui).toContain('retained.current !== command');
  });
});
