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
import { TestingCandidateRegistrationWorkbench } from '../src/components/testing-candidate-registration-workbench';
const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const ids = { organizationId: id('1'), schoolId: id('2'), testingEventId: id('3'), studentCurriculumEnrollmentId: id('4'), targetRankId: id('5') };
const candidate = { id: id('a'), testingEventId: ids.testingEventId, studentCurriculumEnrollmentId: ids.studentCurriculumEnrollmentId, targetRankId: ids.targetRankId, result: 'PENDING', instructorNotes: 'PRIVATE_NOTE', version: 1, createdAt: '2026-10-16T12:00:00.123456+00:00' };
const response = (data: unknown = candidate, replayed = false) => Response.json({ data, meta: { requestId: id('8'), correlationId: id('8'), replayed } }, { status: replayed ? 200 : 201 });
type Element = ReactElement<Record<string, any>>;
function elements(node: unknown): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (!React.isValidElement(node)) return []; const e = node as Element; return [e, ...elements(e.props.children)]; }
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(' '); if (React.isValidElement(node)) return text((node as Element).props.children); return typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
function render(): Element { hooks.cursor = 0; const tree = TestingCandidateRegistrationWorkbench() as Element; hooks.effects.splice(0).forEach(run => run()); return tree; }
function unmount(): void { for (const cell of hooks.cells) if (cell && typeof cell === 'object' && 'cleanup' in cell) (cell as { cleanup?: () => void }).cleanup?.(); }
const button = (label: string) => elements(render()).find(e => e.type === 'button' && text(e) === label);
const field = (name: string) => elements(render()).find(e => e.props.name === name);
function edit(name: string, value: string): void { field(name)!.props.onChange({ target: { value } }); }
function submit(): void { elements(render()).find(e => e.type === 'form')!.props.onSubmit({ preventDefault() {} }); }
function confirm(checked = true): void { field('confirmRegistration')!.props.onChange({ target: { checked } }); }
function fill(): void { for (const [name, value] of Object.entries(ids)) edit(name, value); edit('instructorNotes', 'PRIVATE_NOTE'); }
const settle = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
beforeEach(() => { hooks.cells = []; hooks.cursor = 0; hooks.effects = []; });
afterEach(() => { unmount(); vi.restoreAllMocks(); });

describe('bounded direct-human PENDING candidate UI', () => {
  it('starts with exactly five blank UUIDs and optional note, idle until a locally valid explicit confirmed submit', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response()); const allocate = vi.spyOn(crypto, 'randomUUID');
    expect(elements(render()).filter(e => e.type === 'input' && e.props.type !== 'checkbox').map(e => e.props.value)).toEqual(['', '', '', '', '']); expect(field('instructorNotes')!.props.value).toBe('');
    confirm(); submit(); await settle(); expect(fetcher).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled();
    fill(); await settle(); expect(fetcher).not.toHaveBeenCalled(); submit(); expect(allocate).not.toHaveBeenCalled();
    confirm(); submit(); submit(); await settle(); expect(fetcher).toHaveBeenCalledTimes(1); expect(allocate).toHaveBeenCalledTimes(1); expect(text(render())).toContain('Returned candidate: PENDING');
    expect(field('instructorNotes')!.props.value).toBe(''); expect(field('confirmRegistration')!.props.checked).toBe(false); expect(button('Retry exact unchanged registration')).toBeUndefined();
    confirm(); submit(); await settle(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('shows only canonical PENDING candidate facts and explicit no-effect distinctions, never private notes or inferred status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response()); fill(); confirm(); submit(); await settle(); const copy = text(render());
    for (const fact of [candidate.id, ids.testingEventId, ids.studentCurriculumEnrollmentId, ids.targetRankId, candidate.createdAt, 'PENDING']) expect(copy).toContain(fact);
    expect(copy).not.toContain('PRIVATE_NOTE'); expect(copy).not.toMatch(/\d+%|ready to test|grade awarded/);
    for (const phrase of ['not eligibility or testing completion', 'PENDING candidate, canonical audit and inert outbox evidence', 'eligibility or readiness, a roster, place or capacity', 'score, grade, pass/fail/defer', 'promotion, rank, belt or certificate', 'family or parent access', 'attendance, billing, payment, message, provider, AI, Action Engine, automation or external effect', 'No outbox consumer is activated', 'command-response snapshot, not live status']) expect(copy).toContain(phrase);
    expect(elements(render()).filter(e => e.type === 'select' || e.type === 'option')).toEqual([]); expect(elements(render()).filter(e => e.type === 'input').map(e => e.props.name)).toEqual([...Object.keys(ids), 'confirmRegistration']);
  });
  it('blocks invalid UUIDs/notes and clears confirmation on every edit before allocating a key', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); const allocate = vi.spyOn(crypto, 'randomUUID'); fill();
    for (const [name, value] of [...Object.keys(ids).map(name => [name, 'Name']), ['instructorNotes', 'x'.repeat(2001)], ['instructorNotes', '\u0000']]) {
      fill(); edit(name!, value!); confirm(); submit(); await settle(); expect(fetcher).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled();
    }
    for (const [name, value] of [...Object.entries(ids), ['instructorNotes', 'Changed']]) { fill(); confirm(); edit(name!, value!); expect(field('confirmRegistration')!.props.checked).toBe(false); expect(button('Register PENDING candidate')!.props.disabled).toBe(true); }
  });
  it('retains one immutable exact command only after uncertainty and requires separate human retry with no fresh key or stale/rapid resubmission', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('NETWORK_SECRET')).mockResolvedValueOnce(response(candidate, true)); const allocate = vi.spyOn(crypto, 'randomUUID');
    fill(); confirm(); submit(); await settle(); const retry = button('Retry exact unchanged registration')!; expect(retry).toBeDefined(); expect(text(render())).not.toMatch(/NETWORK_SECRET|PRIVATE_NOTE/);
    expect(text(render())).toContain('earlier uncertain command may still have created a candidate'); confirm(); submit(); await settle(); expect(fetcher).toHaveBeenCalledTimes(1);
    retry.props.onClick(); retry.props.onClick(); await settle(); expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1]); expect(allocate).toHaveBeenCalledTimes(1);
    expect(text(render())).toContain('Replayed or previously recorded candidate receipt'); expect(button('Retry exact unchanged registration')).toBeUndefined(); retry.props.onClick(); await settle(); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('clears uncertainty/receipt and confirmation on every ID/note edit or discard, preventing stale retry and submit handlers', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); const allocate = vi.spyOn(crypto, 'randomUUID');
    for (const [name, value] of [...Object.entries(ids), ['instructorNotes', 'Changed']]) {
      fill(); confirm(); const oldSubmit = elements(render()).find(e => e.type === 'form')!.props.onSubmit;
      edit(name!, value!); const before = fetcher.mock.calls.length; oldSubmit({ preventDefault() {} }); await settle(); expect(fetcher).toHaveBeenCalledTimes(before);
      fill(); confirm(); fetcher.mockRejectedValueOnce(new Error('network')); submit(); await settle(); const oldRetry = button('Retry exact unchanged registration')!;
      edit(name!, value!); oldRetry.props.onClick(); await settle(); expect(fetcher).toHaveBeenCalledTimes(before + 1); expect(button('Retry exact unchanged registration')).toBeUndefined();
      fill(); confirm(); fetcher.mockResolvedValueOnce(response()); submit(); await settle(); expect(text(render())).toContain('Returned candidate: PENDING'); edit(name!, value!); expect(text(render())).not.toContain('Returned candidate: PENDING');
    }
    fill(); confirm(); fetcher.mockRejectedValueOnce(new Error('network')); submit(); await settle(); const retry = button('Retry exact unchanged registration')!;
    button('Discard inputs / start over')!.props.onClick(); retry.props.onClick(); await settle(); expect(field('organizationId')!.props.value).toBe(''); expect(button('Retry exact unchanged registration')).toBeUndefined(); expect(allocate.mock.calls.length).toBe(fetcher.mock.calls.length);
  });
  it('invalidates old confirmation and confirmed submit handlers including revoked confirmation', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); const allocate = vi.spyOn(crypto, 'randomUUID'); fill(); const oldConfirm = field('confirmRegistration')!;
    edit('schoolId', ids.schoolId); oldConfirm.props.onChange({ target: { checked: true } }); expect(field('confirmRegistration')!.props.checked).toBe(false);
    confirm(); const oldSubmit = elements(render()).find(e => e.type === 'form')!.props.onSubmit; confirm(false); oldSubmit({ preventDefault() {} }); await settle(); expect(fetcher).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled();
  });
  it('shows no success or retry after definite duplicate/reused-key rejection and never echoes server details', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const status of [400, 404, 409, 413, 415, 422]) {
      fill(); confirm(); fetcher.mockResolvedValueOnce(Response.json({ code: 'TESTING_CANDIDATE_ALREADY_REGISTERED', detail: 'SQL_SECRET' }, { status })); submit(); await settle();
      expect(text(render())).toContain('No success or retry is retained'); expect(text(render())).not.toMatch(/Returned candidate: PENDING|SQL_SECRET/); expect(button('Retry exact unchanged registration')).toBeUndefined(); confirm(); submit(); await settle();
    }
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
  it('never partially displays unverified envelopes, wrong IDs/results/notes or unexpected private facts', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const patch of [{ testingEventId: id('b') }, { studentCurriculumEnrollmentId: id('b') }, { targetRankId: id('b') }, { result: 'PASSED' }, { instructorNotes: 'PRIVATE_OTHER' }, { actor: 'PRIVATE_ACTOR' }, { version: 2 }]) {
      fill(); confirm(); fetcher.mockResolvedValueOnce(response({ ...candidate, ...patch })); submit(); await settle(); expect(text(render())).not.toMatch(/Returned candidate: PENDING|PRIVATE_OTHER|PRIVATE_ACTOR/); expect(button('Retry exact unchanged registration')).toBeDefined();
    }
  });
  it('keeps only an explicit exact retry for canonical in-progress responses', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ code: 'IDEMPOTENCY_IN_PROGRESS', detail: 'SECRET' }, { status: 409 }));
    fill(); confirm(); submit(); await settle(); expect(text(render())).toContain('matching candidate command is still in progress'); expect(text(render())).not.toContain('SECRET'); expect(button('Retry exact unchanged registration')).toBeDefined(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('clears every ID/note/receipt/retry on initial or retained-replay 401/403', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const status of [401, 403]) for (const replay of [false, true]) {
      fill(); confirm(); if (replay) { fetcher.mockRejectedValueOnce(new Error('network')); submit(); await settle(); }
      fetcher.mockResolvedValueOnce(Response.json({ detail: 'SECRET' }, { status })); if (replay) button('Retry exact unchanged registration')!.props.onClick(); else submit(); await settle();
      expect(Object.keys(ids).map(name => field(name)!.props.value)).toEqual(['', '', '', '', '']); expect(field('instructorNotes')!.props.value).toBe(''); expect(field('confirmRegistration')!.props.checked).toBe(false); expect(button('Retry exact unchanged registration')).toBeUndefined(); expect(text(render())).not.toMatch(/SECRET|Returned candidate: PENDING/); expect(text(render())).toContain('Inputs, note, receipt and retry were cleared');
    }
  });
  it('locks pending I/O, deduplicates rapid actions and ignores late completion after unmount/remount', async () => {
    let finish!: (value: Response) => void; const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); const allocate = vi.spyOn(crypto, 'randomUUID');
    fill(); confirm(); submit(); submit(); expect(elements(render()).filter(e => e.type === 'fieldset').every(e => e.props.disabled)).toBe(true);
    edit('schoolId', id('b')); button('Discard inputs / start over')!.props.onClick(); expect(field('schoolId')!.props.value).toBe(ids.schoolId);
    unmount(); const before = hooks.cells.slice(); finish(response()); await settle(); expect(hooks.cells).toEqual(before); expect(fetcher).toHaveBeenCalledTimes(1); expect(allocate).toHaveBeenCalledTimes(1);
    hooks.cells = []; hooks.effects = []; expect(field('organizationId')!.props.value).toBe(''); expect(button('Retry exact unchanged registration')).toBeUndefined(); expect(text(render())).not.toContain('Returned candidate: PENDING');
  });
  it('remains idle and usable after React Strict Mode initial cleanup/setup replay', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response()); const allocate = vi.spyOn(crypto, 'randomUUID');
    const initial = render(); const initialOrganizationField = elements(initial).find(e => e.props.name === 'organizationId')!;
    unmount();
    for (const cell of hooks.cells) if (cell && typeof cell === 'object' && 'setup' in cell) (cell as { setup: () => void }).setup();
    initialOrganizationField.props.onChange({ target: { value: ids.organizationId } }); expect(field('organizationId')!.props.value).toBe(ids.organizationId);
    expect(fetcher).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled(); fill(); confirm(); submit(); await settle(); expect(fetcher).toHaveBeenCalledTimes(1); expect(allocate).toHaveBeenCalledTimes(1);
  });
  it('adds no directory/list/read, persistence, URL prefill, timers, automatic work or downstream clients/routes', () => {
    const ui = readFileSync('src/components/testing-candidate-registration-workbench.tsx', 'utf8'); const http = readFileSync('src/components/testing-candidate-registration-http.ts', 'utf8');
    expect(ui + http).not.toMatch(/localStorage|sessionStorage|indexedDB|setInterval|setTimeout|invokeLLM|executeAction|sendMessage|providerClient|searchParams|window\.location|dangerouslySetInnerHTML|\/people|\/roster|\/search|\/billing|\/parent|\/ranks|\/enrollments|\/grades|\/promotion|\/certificates|method: 'GET'/);
    expect(ui).not.toMatch(/fetch\(/); expect(http.match(/fetch\(/g)).toHaveLength(1); expect(ui.match(/crypto\.randomUUID\(\)/g)).toHaveLength(1); expect(http).not.toMatch(/crypto\.randomUUID/); expect(ui).toContain('retained.current !== command');
  });
});
