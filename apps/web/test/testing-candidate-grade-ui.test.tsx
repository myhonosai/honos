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
import { TestingCandidateGradeWorkbench } from '../src/components/testing-candidate-grade-workbench';
const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const ids = { organizationId: id('1'), schoolId: id('2'), candidateId: id('a') };
const candidate = { id: ids.candidateId, testingEventId: id('3'), studentCurriculumEnrollmentId: id('4'), targetRankId: id('5'), result: 'PASSED', instructorNotes: 'PRIVATE_NOTE', version: 4, createdAt: '2026-10-16T12:00:00.123456+00:00' };
const response = (data: unknown = candidate, replayed = false) => Response.json({ data, meta: { requestId: id('8'), correlationId: id('8'), replayed } }, { status: 200 });
type Element = ReactElement<Record<string, any>>;
function elements(node: unknown): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (!React.isValidElement(node)) return []; const e = node as Element; return [e, ...elements(e.props.children)]; }
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(' '); if (React.isValidElement(node)) return text((node as Element).props.children); return typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
function render(): Element { hooks.cursor = 0; const tree = TestingCandidateGradeWorkbench() as Element; hooks.effects.splice(0).forEach(run => run()); return tree; }
function unmount(): void { for (const cell of hooks.cells) if (cell && typeof cell === 'object' && 'cleanup' in cell) (cell as { cleanup?: () => void }).cleanup?.(); }
const button = (label: string) => elements(render()).find(e => e.type === 'button' && text(e) === label);
const field = (name: string) => elements(render()).find(e => e.props.name === name);
function edit(name: string, value: string): void { field(name)!.props.onChange({ target: { value } }); }
function submit(): void { elements(render()).find(e => e.type === 'form')!.props.onSubmit({ preventDefault() {} }); }
function confirm(checked = true): void { field('confirmOutcome')!.props.onChange({ target: { checked } }); }
function fill(result = 'PASSED'): void { for (const [name, value] of Object.entries(ids)) edit(name, value); edit('expectedVersion', '3'); edit('result', result); edit('instructorNotes', 'PRIVATE_NOTE'); }
const settle = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
beforeEach(() => { hooks.cells = []; hooks.cursor = 0; hooks.effects = []; });
afterEach(() => { unmount(); vi.restoreAllMocks(); });

describe('bounded direct-human candidate outcome UI', () => {
  it('starts blank and idle with three UUIDs/version/note and a closed result, requiring exact confirmation before one generated key and request', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response()); const allocate = vi.spyOn(crypto, 'randomUUID');
    expect(elements(render()).filter(e => e.type === 'input' && e.props.type !== 'checkbox').map(e => e.props.value)).toEqual(['', '', '', '']); expect(field('instructorNotes')!.props.value).toBe(''); expect(field('result')!.props.value).toBe('');
    expect(elements(render()).filter(e => e.type === 'option').map(e => e.props.value)).toEqual(['', 'PASSED', 'DEFERRED', 'NOT_PASSED', 'WITHDRAWN']);
    confirm(); submit(); await settle(); expect(fetcher).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled();
    fill(); await settle(); expect(fetcher).not.toHaveBeenCalled(); submit(); expect(allocate).not.toHaveBeenCalled();
    confirm(); submit(); submit(); await settle(); expect(fetcher).toHaveBeenCalledTimes(1); expect(allocate).toHaveBeenCalledTimes(1); expect(text(render())).toContain('Returned candidate outcome: PASSED');
    expect(field('instructorNotes')!.props.value).toBe(''); expect(field('confirmOutcome')!.props.checked).toBe(false); expect(button('Retry exact unchanged outcome')).toBeUndefined(); confirm(); submit(); await settle(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('records each closed result as candidate evidence only, displaying canonical snapshots without notes, scorecards or downstream actions', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const result of ['PASSED', 'DEFERRED', 'NOT_PASSED', 'WITHDRAWN']) {
      fetcher.mockResolvedValueOnce(response({ ...candidate, result })); fill(result); confirm(); submit(); await settle(); const copy = text(render());
      for (const fact of [candidate.id, candidate.testingEventId, candidate.studentCurriculumEnrollmentId, candidate.targetRankId, candidate.createdAt, `Returned candidate outcome: ${result}`]) expect(copy).toContain(fact);
      expect(copy).not.toContain('PRIVATE_NOTE');
      for (const phrase of ['PASSED is neither promotion nor certificate', 'candidate outcome evidence, canonical audit and inert outbox only', 'does not grade a scorecard or score observations', 'readiness or eligibility', 'roster, place or capacity', 'promotion, rank or belt', 'parent or family access', 'attendance', 'billing or payment', 'communication', 'provider, AI, Action Engine or automation', 'No downstream command or outbox consumer is activated', 'original command-response snapshot', 'blank clears its prior note']) expect(copy).toContain(phrase);
      expect(elements(render()).filter(e => e.type === 'a').map(e => e.props.href)).toEqual(['/staff/dashboard']);
    }
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('blocks invalid IDs, versions, results and notes; every edit resets confirmation before any key allocation', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); const allocate = vi.spyOn(crypto, 'randomUUID');
    for (const [name, value] of [...Object.keys(ids).map(name => [name, 'Name']), ...['', '0', '-1', '1.1', '01', ' 3', '3 ', '3\n', '3e0', 'NaN', '9007199254740991'].map(value => ['expectedVersion', value]), ...['', 'PENDING', 'passed', 'READY'].map(value => ['result', value]), ['instructorNotes', 'x'.repeat(2001)], ['instructorNotes', '\u0000']]) {
      fill(); edit(name!, value!); confirm(); submit(); await settle(); expect(fetcher).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled();
    }
    for (const [name, value] of [...Object.entries(ids), ['expectedVersion', '4'], ['result', 'DEFERRED'], ['instructorNotes', 'Changed']]) { fill(); confirm(); edit(name!, value!); expect(field('confirmOutcome')!.props.checked).toBe(false); expect(button('Record candidate outcome')!.props.disabled).toBe(true); }
  });
  it('retains exactly one immutable memory command only after uncertainty and retries identical path/body/key through a separate human action', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('NETWORK_SECRET')).mockResolvedValueOnce(response(candidate, true)); const allocate = vi.spyOn(crypto, 'randomUUID');
    fill(); confirm(); submit(); await settle(); const retry = button('Retry exact unchanged outcome')!; expect(retry).toBeDefined(); expect(text(render())).not.toMatch(/NETWORK_SECRET|PRIVATE_NOTE/);
    expect(text(render())).toContain('earlier uncertain command may already have changed the candidate outcome'); confirm(); submit(); await settle(); expect(fetcher).toHaveBeenCalledTimes(1);
    retry.props.onClick(); retry.props.onClick(); await settle(); expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1]); expect(allocate).toHaveBeenCalledTimes(1);
    expect(text(render())).toContain('Replayed or previously recorded candidate outcome receipt'); expect(button('Retry exact unchanged outcome')).toBeUndefined(); retry.props.onClick(); await settle(); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('clears uncertainty/receipt on every ID/version/result/note edit and discard, invalidating stale retry and confirmed-submit handlers', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); const allocate = vi.spyOn(crypto, 'randomUUID');
    for (const [name, value] of [...Object.entries(ids), ['expectedVersion', '4'], ['result', 'DEFERRED'], ['instructorNotes', 'Changed']]) {
      fill(); confirm(); const oldSubmit = elements(render()).find(e => e.type === 'form')!.props.onSubmit; edit(name!, value!); const before = fetcher.mock.calls.length; oldSubmit({ preventDefault() {} }); await settle(); expect(fetcher).toHaveBeenCalledTimes(before);
      fill(); confirm(); fetcher.mockRejectedValueOnce(new Error('network')); submit(); await settle(); const oldRetry = button('Retry exact unchanged outcome')!;
      edit(name!, value!); oldRetry.props.onClick(); await settle(); expect(fetcher).toHaveBeenCalledTimes(before + 1); expect(button('Retry exact unchanged outcome')).toBeUndefined();
      fill(); confirm(); fetcher.mockResolvedValueOnce(response()); submit(); await settle(); expect(text(render())).toContain('Returned candidate outcome: PASSED'); edit(name!, value!); expect(text(render())).not.toContain('Returned candidate outcome: PASSED');
    }
    fill(); confirm(); fetcher.mockRejectedValueOnce(new Error('network')); submit(); await settle(); const retry = button('Retry exact unchanged outcome')!;
    button('Discard inputs / start over')!.props.onClick(); retry.props.onClick(); await settle(); expect([...Object.keys(ids), 'expectedVersion', 'result', 'instructorNotes'].map(name => field(name)!.props.value)).toEqual(['', '', '', '', '', '']); expect(button('Retry exact unchanged outcome')).toBeUndefined(); expect(allocate.mock.calls.length).toBe(fetcher.mock.calls.length);
  });
  it('invalidates old confirmation handlers and revoked-confirmation submit handlers', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); const allocate = vi.spyOn(crypto, 'randomUUID'); fill(); const oldConfirm = field('confirmOutcome')!;
    edit('schoolId', ids.schoolId); oldConfirm.props.onChange({ target: { checked: true } }); expect(field('confirmOutcome')!.props.checked).toBe(false);
    confirm(); const oldSubmit = elements(render()).find(e => e.type === 'form')!.props.onSubmit; confirm(false); oldSubmit({ preventDefault() {} }); await settle(); expect(fetcher).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled();
  });
  it('keeps no success or retry after definite rejection/conflict and never echoes server details', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const status of [400, 404, 405, 409, 413, 415, 422]) {
      fill(); confirm(); fetcher.mockResolvedValueOnce(Response.json({ code: 'VERSION_CONFLICT', detail: 'SQL_SECRET' }, { status })); submit(); await settle();
      expect(text(render())).toContain('No success or retry is retained'); expect(text(render())).not.toMatch(/Returned candidate outcome:|SQL_SECRET/); expect(button('Retry exact unchanged outcome')).toBeUndefined(); confirm(); submit(); await settle();
    }
    expect(fetcher).toHaveBeenCalledTimes(7);
  });
  it('never partially displays mismatched candidate/results/notes/version or unexpected private fields', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const patch of [{ id: id('b') }, { result: 'PENDING' }, { result: 'DEFERRED' }, { instructorNotes: 'PRIVATE_OTHER' }, { actor: 'PRIVATE_ACTOR' }, { version: 3 }, { version: 5 }]) {
      fill(); confirm(); fetcher.mockResolvedValueOnce(response({ ...candidate, ...patch })); submit(); await settle(); expect(text(render())).not.toMatch(/Returned candidate outcome:|PRIVATE_OTHER|PRIVATE_ACTOR/); expect(button('Retry exact unchanged outcome')).toBeDefined();
    }
  });
  it('provides only exact explicit retry for canonical in-progress responses, never optimistic success', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ code: 'IDEMPOTENCY_IN_PROGRESS', detail: 'SECRET' }, { status: 409 }));
    fill(); confirm(); submit(); await settle(); expect(text(render())).toContain('matching candidate outcome command is still in progress'); expect(text(render())).not.toContain('SECRET'); expect(button('Retry exact unchanged outcome')).toBeDefined(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('clears all IDs/version/result/note/receipt/retry on initial or retained-replay 401/403', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const status of [401, 403]) for (const replay of [false, true]) {
      fill(); confirm(); if (replay) { fetcher.mockRejectedValueOnce(new Error('network')); submit(); await settle(); }
      fetcher.mockResolvedValueOnce(Response.json({ detail: 'SECRET' }, { status })); if (replay) button('Retry exact unchanged outcome')!.props.onClick(); else submit(); await settle();
      expect([...Object.keys(ids), 'expectedVersion', 'result', 'instructorNotes'].map(name => field(name)!.props.value)).toEqual(['', '', '', '', '', '']); expect(field('confirmOutcome')!.props.checked).toBe(false); expect(button('Retry exact unchanged outcome')).toBeUndefined(); expect(text(render())).not.toMatch(/SECRET|Returned candidate outcome:/); expect(text(render())).toContain('Inputs, note, receipt and retry were cleared');
    }
  });
  it('locks pending I/O, deduplicates rapid actions and drops late completion after unmount/remount', async () => {
    let finish!: (value: Response) => void; const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); const allocate = vi.spyOn(crypto, 'randomUUID');
    fill(); confirm(); submit(); submit(); expect(elements(render()).filter(e => e.type === 'fieldset').every(e => e.props.disabled)).toBe(true);
    edit('schoolId', id('b')); edit('expectedVersion', '5'); edit('result', 'WITHDRAWN'); button('Discard inputs / start over')!.props.onClick(); expect(field('schoolId')!.props.value).toBe(ids.schoolId); expect(field('expectedVersion')!.props.value).toBe('3'); expect(field('result')!.props.value).toBe('PASSED');
    unmount(); const before = hooks.cells.slice(); finish(response()); await settle(); expect(hooks.cells).toEqual(before); expect(fetcher).toHaveBeenCalledTimes(1); expect(allocate).toHaveBeenCalledTimes(1);
    hooks.cells = []; hooks.effects = []; expect(field('organizationId')!.props.value).toBe(''); expect(button('Retry exact unchanged outcome')).toBeUndefined(); expect(text(render())).not.toContain('Returned candidate outcome:');
  });
  it('stays idle and usable after Strict Mode initial cleanup/setup replay', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response()); const allocate = vi.spyOn(crypto, 'randomUUID');
    const initial = render(); const initialOrganizationField = elements(initial).find(e => e.props.name === 'organizationId')!; unmount();
    for (const cell of hooks.cells) if (cell && typeof cell === 'object' && 'setup' in cell) (cell as { setup: () => void }).setup();
    initialOrganizationField.props.onChange({ target: { value: ids.organizationId } }); expect(field('organizationId')!.props.value).toBe(ids.organizationId);
    expect(fetcher).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled(); fill(); confirm(); submit(); await settle(); expect(fetcher).toHaveBeenCalledTimes(1); expect(allocate).toHaveBeenCalledTimes(1);
  });
  it('adds no read/list/search, persistence, URL prefill, timers, automatic work, scorecard action or downstream routes/clients', () => {
    const ui = readFileSync('src/components/testing-candidate-grade-workbench.tsx', 'utf8'); const http = readFileSync('src/components/testing-candidate-grade-http.ts', 'utf8');
    expect(ui + http).not.toMatch(/localStorage|sessionStorage|indexedDB|setInterval|setTimeout|invokeLLM|executeAction|sendMessage|providerClient|searchParams|window\.location|dangerouslySetInnerHTML|\/people|\/roster|\/search|\/billing|\/parent|\/ranks|\/enrollments|\/promotion|\/certificates|\/scorecards|method: 'GET'/);
    expect(ui).not.toMatch(/fetch\(/); expect(http.match(/fetch\(/g)).toHaveLength(1); expect(ui.match(/crypto\.randomUUID\(\)/g)).toHaveLength(1); expect(http).not.toMatch(/crypto\.randomUUID/); expect(ui).toContain('retained.current !== command');
  });
});
