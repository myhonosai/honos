import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { CURRICULUM_PROGRESS_STATUSES } from '@hon/contracts';
const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual,
    useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = initial; return [hooks.cells[i], (value: unknown) => { hooks.cells[i] = typeof value === 'function' ? (value as (v: unknown) => unknown)(hooks.cells[i]) : value; }]; },
    useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = { current: initial }; return hooks.cells[i]; },
    useEffect: (effect: () => (() => void) | void, deps: unknown[]) => { const i = hooks.cursor++; if (!(i in hooks.cells)) { hooks.cells[i] = { deps }; hooks.effects.push(() => { (hooks.cells[i] as { cleanup?: (() => void) | undefined }).cleanup = effect() || undefined; }); } },
  };
});
import { CurriculumProgressWorkbench } from '../src/components/curriculum-progress-workbench';
const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const ids = { organizationId: id('1'), schoolId: id('2'), curriculumId: id('3'), enrollmentId: id('4') };
const requirement = { id: id('6'), rankId: id('5'), code: 'BASICS', kind: 'ATTENDANCE', definition: { label: 'Returned practice', description: 'PRIVATE_DESCRIPTION' }, required: true, version: 2, progressVersion: 7, status: null, recordedAt: null };
const data = { enrollment: { id: ids.enrollmentId, curriculumId: ids.curriculumId, studentProfileId: id('7'), currentRankId: id('5'), version: 3, status: 'ACTIVE', enrolledAt: '2026-10-16T12:00:00.123456+00:00' }, requirements: [requirement] };
const observation = { id: id('a'), enrollmentId: ids.enrollmentId, requirementId: requirement.id, requirementVersion: 2, enrollmentVersion: 3, status: 'MET', version: 8, recordedAt: '2026-10-16T12:00:00.123456+00:00' };
const response = (data: unknown, replayed = false) => Response.json({ data, meta: { requestId: id('8'), correlationId: id('8'), replayed } });
type Element = ReactElement<Record<string, any>>;
function elements(node: unknown): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (!React.isValidElement(node)) return []; const e = node as Element; return [e, ...elements(e.props.children)]; }
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(' '); if (React.isValidElement(node)) return text((node as Element).props.children); return typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
function render(): Element { hooks.cursor = 0; const tree = CurriculumProgressWorkbench() as Element; hooks.effects.splice(0).forEach(run => run()); return tree; }
function unmount(): void { for (const cell of hooks.cells) if (cell && typeof cell === 'object' && 'cleanup' in cell) (cell as { cleanup?: () => void }).cleanup?.(); }
const button = (label: string) => elements(render()).find(e => e.type === 'button' && text(e) === label);
const field = (name: string) => elements(render()).find(e => e.props.name === name);
function edit(name: string, value: string): void { field(name)!.props.onChange({ target: { value } }); }
function submit(): void { elements(render()).find(e => e.type === 'form')?.props.onSubmit({ preventDefault() {} }); }
function confirm(): void { field('confirmObservation')!.props.onChange({ target: { checked: true } }); }
function fill(): void { for (const [name, value] of Object.entries(ids)) edit(name, value); }
const settle = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
async function load(): Promise<void> { button('Load current enrollment')!.props.onClick(); await settle(); }
function draft(): void { edit('requirementId', requirement.id); edit('observationStatus', 'MET'); edit('instructorNote', 'PRIVATE_NOTE'); }
beforeEach(() => { hooks.cells = []; hooks.cursor = 0; hooks.effects = []; });
afterEach(() => { unmount(); vi.restoreAllMocks(); });

describe('bounded direct-human curriculum progress UI', () => {
  it('starts idle with four blank exact-ID inputs and does no I/O or key allocation until valid explicit load / confirmed submit', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(data)).mockResolvedValueOnce(response(observation));
    const allocate = vi.spyOn(crypto, 'randomUUID');
    expect(elements(render()).filter(e => e.type === 'input').map(e => e.props.value)).toEqual(['', '', '', '']);
    expect(field('requirementId')).toBeUndefined(); expect(text(render())).toContain('No verified current enrollment snapshot');
    await load(); expect(fetcher).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled();
    fill(); await settle(); expect(fetcher).not.toHaveBeenCalled();
    await load(); expect(fetcher).toHaveBeenCalledTimes(1); expect(allocate).not.toHaveBeenCalled();
    draft(); submit(); await settle(); expect(fetcher).toHaveBeenCalledTimes(1); expect(allocate).not.toHaveBeenCalled();
    confirm(); submit(); submit(); await settle(); expect(fetcher).toHaveBeenCalledTimes(2); expect(allocate).toHaveBeenCalledTimes(1);
    expect(text(render())).toContain('Returned human observation:  MET'); expect(field('requirementId')).toBeUndefined();
    expect(text(render())).toContain('No verified current enrollment snapshot'); expect(button('Retry exact unchanged observation')).toBeUndefined();
    expect(JSON.parse((fetcher.mock.calls[1]![1] as RequestInit).body as string)).toEqual({ requirementId: requirement.id, expectedRequirementVersion: 2, expectedEnrollmentVersion: 3, expectedProgressVersion: 7, status: 'MET', instructorNote: 'PRIVATE_NOTE' });
  });
  it('renders only verified returned enrollment/current-rank facts and closed status choices, not description, actor, note, history or inferred status/readiness', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(data)); fill(); await load();
    const copy = text(render());
    for (const fact of [ids.enrollmentId, ids.curriculumId, data.enrollment.studentProfileId, requirement.rankId, requirement.id, 'Returned practice', 'ATTENDANCE', 'Unrecorded for the current revision', 'Latest observation sequence']) expect(copy).toContain(fact);
    expect(copy).not.toContain('PRIVATE_DESCRIPTION'); expect(copy).not.toContain('PRIVATE_NOTE');
    expect(elements(render()).filter(e => e.type === 'select' && e.props.name === 'requirementId').flatMap(e => elements(e).filter(x => x.type === 'option').map(x => x.props.value))).toEqual(['', requirement.id]);
    expect(elements(render()).filter(e => e.type === 'select' && e.props.name === 'observationStatus').flatMap(e => elements(e).filter(x => x.type === 'option').map(x => x.props.value))).toEqual(['', ...CURRICULUM_PROGRESS_STATUSES]);
    expect(elements(render()).filter(e => e.type === 'input').map(e => e.props.name)).toEqual([...Object.keys(ids), 'confirmObservation']);
    expect(copy).toContain('MET is a human observation');
    for (const phrase of ['promotion, rank, belt, certificate, testing readiness or eligibility, grade, attendance, booking, membership, payment', 'family or parent access, communication, provider, AI, Action Engine or automation outcome', 'not attendance credit', 'inert curriculum outbox event gains no consumer']) expect(copy).toContain(phrase);
    expect(copy).not.toMatch(/\d+%|ready to test|<progress|grade awarded/);
  });
  it('never permits an arbitrary requirement, unclosed status or oversized note, and edits clear confirmation before any key is made', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(data)); const allocate = vi.spyOn(crypto, 'randomUUID'); fill(); await load();
    for (const [name, value] of [['requirementId', id('b')], ['observationStatus', 'PROMOTION'], ['instructorNote', 'x'.repeat(2001)]]) {
      draft(); edit(name!, value!); confirm(); submit(); await settle(); expect(fetcher).toHaveBeenCalledTimes(1); expect(allocate).not.toHaveBeenCalled();
    }
    for (const [name, value] of [['requirementId', requirement.id], ['observationStatus', 'PRACTICING'], ['instructorNote', 'Changed']]) {
      draft(); confirm(); edit(name!, value!); expect(field('confirmObservation')!.props.checked).toBe(false); expect(button('Record human observation')!.props.disabled).toBe(true);
    }
  });
  it('requires explicit reload after success or definite rejection/conflict and does not update the old snapshot optimistically', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(data)).mockResolvedValueOnce(Response.json({ code: 'VERSION_CONFLICT', detail: 'SQL_SECRET' }, { status: 409 }));
    fill(); await load(); draft(); confirm(); submit(); await settle();
    expect(text(render())).toContain('versions conflicted'); expect(text(render())).not.toContain('SQL_SECRET');
    expect(field('requirementId')).toBeUndefined(); expect(button('Retry exact unchanged observation')).toBeUndefined();
    expect(text(render())).not.toContain('Returned current enrollment'); submit(); await settle(); expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockResolvedValueOnce(response(data)); await load(); draft(); confirm(); fetcher.mockResolvedValueOnce(response(observation)); submit(); await settle();
    expect(text(render())).toContain('command-response snapshot, not a refreshed enrollment'); expect(text(render())).not.toContain('Returned current enrollment');
    fetcher.mockResolvedValueOnce(response(data)); await load(); expect(text(render())).not.toContain('Returned human observation:'); expect(text(render())).toContain('Returned current enrollment');
  });
  it('retains exact uncertain path/body/UUID only for a separate human retry and blocks repeated/stale retries and new commands', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(data)).mockRejectedValueOnce(new Error('NETWORK_SECRET')).mockResolvedValueOnce(response(observation, true));
    const allocate = vi.spyOn(crypto, 'randomUUID'); fill(); await load(); draft(); confirm(); submit(); await settle();
    const retry = button('Retry exact unchanged observation')!; expect(retry).toBeDefined(); expect(text(render())).not.toContain('NETWORK_SECRET');
    expect(text(render())).not.toContain('PRIVATE_NOTE'); expect(field('requirementId')).toBeUndefined();
    submit(); await settle(); expect(fetcher).toHaveBeenCalledTimes(2); expect(allocate).toHaveBeenCalledTimes(1);
    retry.props.onClick(); retry.props.onClick(); await settle(); expect(fetcher.mock.calls[1]).toEqual(fetcher.mock.calls[2]); expect(allocate).toHaveBeenCalledTimes(1);
    expect(text(render())).toContain('Replayed or previously recorded observation receipt'); expect(button('Retry exact unchanged observation')).toBeUndefined();
    retry.props.onClick(); await settle(); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('clears snapshots on every scope edit and clears uncertain retry on scope edit, reload or discard; old handlers cannot send', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); const allocate = vi.spyOn(crypto, 'randomUUID');
    fill();
    for (const name of Object.keys(ids)) {
      fetcher.mockResolvedValueOnce(response(data)); await load(); draft(); confirm(); const oldSubmit = elements(render()).find(e => e.type === 'form')!.props.onSubmit;
      const oldLoad = button('Load current enrollment')!;
      edit(name, ids[name as keyof typeof ids]); oldSubmit({ preventDefault() {} }); oldLoad.props.onClick(); await settle();
      expect(text(render())).not.toContain('Returned current enrollment'); expect(allocate).not.toHaveBeenCalled();
      fetcher.mockResolvedValueOnce(response(data)); await load(); draft(); confirm(); fetcher.mockRejectedValueOnce(new Error('network')); submit(); await settle();
      const oldRetry = button('Retry exact unchanged observation')!; const calls = fetcher.mock.calls.length;
      edit(name, ids[name as keyof typeof ids]); oldRetry.props.onClick(); await settle(); expect(fetcher).toHaveBeenCalledTimes(calls); expect(button('Retry exact unchanged observation')).toBeUndefined();
      allocate.mockClear();
    }
    fetcher.mockResolvedValueOnce(response(data)); await load(); draft(); confirm(); fetcher.mockRejectedValueOnce(new Error('network')); submit(); await settle();
    expect(text(render())).toContain('earlier uncertain command may still have recorded an observation');
    const retry = button('Retry exact unchanged observation')!; fetcher.mockResolvedValueOnce(response(data)); await load(); const calls = fetcher.mock.calls.length; retry.props.onClick(); await settle(); expect(fetcher).toHaveBeenCalledTimes(calls);
    draft(); confirm(); fetcher.mockRejectedValueOnce(new Error('network')); submit(); await settle(); button('Discard inputs / start over')!.props.onClick();
    expect(button('Retry exact unchanged observation')).toBeUndefined(); expect(field('enrollmentId')!.props.value).toBe('');
  });
  it('blocks a stale confirmed submit after draft edits and a stale confirm handler after scope edits', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(data)); const allocate = vi.spyOn(crypto, 'randomUUID'); fill(); await load(); draft(); confirm();
    const oldSubmit = elements(render()).find(e => e.type === 'form')!.props.onSubmit; const oldConfirm = field('confirmObservation')!;
    edit('instructorNote', 'New intent'); oldSubmit({ preventDefault() {} }); await settle(); expect(fetcher).toHaveBeenCalledTimes(1); expect(allocate).not.toHaveBeenCalled();
    edit('schoolId', ids.schoolId); oldConfirm.props.onChange({ target: { checked: true } }); expect(field('confirmObservation')).toBeUndefined();
  });
  it('drops stale facts on every reload failure and declines unknown/extra/private/wrong-rank responses instead of partially rendering', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); fill();
    for (const bad of [{ ...data, actor: 'PRIVATE_ACTOR' }, { ...data, requirements: [{ ...requirement, rankId: id('b') }] }, { ...data, requirements: [{ ...requirement, instructorNote: 'PRIVATE_NOTE' }] }, { ...data, requirements: [{ ...requirement, status: 'READY' }] }]) {
      fetcher.mockResolvedValueOnce(response(data)); await load(); expect(text(render())).toContain('Returned practice');
      fetcher.mockResolvedValueOnce(response(bad)); await load(); expect(text(render())).not.toContain('Returned practice'); expect(field('requirementId')).toBeUndefined();
      expect(text(render())).not.toMatch(/PRIVATE_ACTOR|PRIVATE_NOTE/);
    }
    fetcher.mockResolvedValueOnce(response(data)); await load(); fetcher.mockRejectedValueOnce(new Error('secret')); await load(); expect(text(render())).not.toContain('Returned current enrollment');
  });
  it('clears all IDs, drafts, snapshot, receipt and retry on GET, POST and retained-replay access loss', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const status of [401, 403]) {
      fill(); fetcher.mockResolvedValueOnce(Response.json({ detail: 'SECRET' }, { status })); await load();
      expect(Object.keys(ids).map(name => field(name)!.props.value)).toEqual(['', '', '', '']);
      fill(); fetcher.mockResolvedValueOnce(response(data)); await load(); draft(); confirm(); fetcher.mockResolvedValueOnce(Response.json({ detail: 'SECRET' }, { status })); submit(); await settle();
      expect(Object.keys(ids).map(name => field(name)!.props.value)).toEqual(['', '', '', '']); expect(button('Retry exact unchanged observation')).toBeUndefined(); expect(text(render())).not.toContain('SECRET');
      fill(); fetcher.mockResolvedValueOnce(response(data)); await load(); draft(); confirm(); fetcher.mockRejectedValueOnce(new Error('network')); submit(); await settle();
      fetcher.mockResolvedValueOnce(Response.json({ detail: 'SECRET' }, { status })); button('Retry exact unchanged observation')!.props.onClick(); await settle();
      expect(Object.keys(ids).map(name => field(name)!.props.value)).toEqual(['', '', '', '']); expect(button('Retry exact unchanged observation')).toBeUndefined(); expect(text(render())).toContain('Inputs, snapshot, receipt and retry were cleared');
    }
  });
  it('shows empty/unranked and inactive enrollment facts honestly without placement, inferred status or command controls', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); fill();
    for (const returned of [{ ...data, enrollment: { ...data.enrollment, currentRankId: null }, requirements: [] }, { ...data, requirements: [] }, ...['SUSPENDED', 'ARCHIVED'].map(status => ({ ...data, enrollment: { ...data.enrollment, status } }))]) {
      fetcher.mockResolvedValueOnce(response(returned)); await load(); expect(text(render())).toContain('Returned current enrollment'); expect(field('requirementId')).toBeUndefined(); expect(button('Record human observation')).toBeUndefined();
    }
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('locks pending reads/submits, deduplicates rapid actions and ignores delayed results after unmount/remount', async () => {
    let finish!: (value: Response) => void;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); fill();
    button('Load current enrollment')!.props.onClick(); button('Load current enrollment')!.props.onClick();
    expect(elements(render()).filter(e => e.type === 'fieldset').every(e => e.props.disabled)).toBe(true);
    edit('enrollmentId', id('b')); expect(field('enrollmentId')!.props.value).toBe(ids.enrollmentId);
    unmount(); const before = hooks.cells.slice(); finish(response(data)); await settle(); expect(hooks.cells).toEqual(before); expect(fetcher).toHaveBeenCalledTimes(1);
    hooks.cells = []; hooks.effects = []; fill(); fetcher.mockResolvedValueOnce(response(data)); await load(); draft(); confirm();
    fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); submit(); submit();
    expect(elements(render()).filter(e => e.type === 'fieldset').every(e => e.props.disabled)).toBe(true);
    unmount(); const pending = hooks.cells.slice(); finish(response(observation)); await settle(); expect(hooks.cells).toEqual(pending); expect(fetcher).toHaveBeenCalledTimes(3);
    hooks.cells = []; hooks.effects = []; expect(field('organizationId')!.props.value).toBe(''); expect(button('Retry exact unchanged observation')).toBeUndefined();
  });
  it('adds no persistence, discovery, history editing, placement authoring, automatic work or downstream route/client', () => {
    const ui = readFileSync('src/components/curriculum-progress-workbench.tsx', 'utf8'); const http = readFileSync('src/components/curriculum-progress-workbench-http.ts', 'utf8');
    expect(ui + http).not.toMatch(/localStorage|sessionStorage|setInterval|setTimeout|invokeLLM|executeAction|sendMessage|providerClient|searchParams|window\.location|dangerouslySetInnerHTML|\/people|\/roster|\/search|\/billing|\/testing|\/parent/);
    expect(ui).not.toMatch(/fetch\(/); expect(http.match(/fetch\(/g)).toHaveLength(2);
    expect(http).not.toMatch(/\/current-rank|\/versions|\/ranks|\/requirements/);
    expect(ui.match(/crypto\.randomUUID\(\)/g)).toHaveLength(1); expect(http).not.toMatch(/crypto\.randomUUID/);
    expect(ui).toContain('retained.current !== command'); expect(ui).toContain('currentSnapshot.current !== snapshot');
  });
});
