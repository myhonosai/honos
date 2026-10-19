import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual,
    useState: (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.cells)) hooks.cells[index] = initial; return [hooks.cells[index], (value: unknown) => { hooks.cells[index] = typeof value === 'function' ? (value as (previous: unknown) => unknown)(hooks.cells[index]) : value; }]; },
    useRef: (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.cells)) hooks.cells[index] = { current: initial }; return hooks.cells[index]; },
    useEffect: (effect: () => (() => void) | void, _deps: unknown[]) => { const index = hooks.cursor++; if (!(index in hooks.cells)) { hooks.cells[index] = {}; hooks.effects.push(() => { (hooks.cells[index] as { cleanup?: (() => void) | undefined }).cleanup = effect() || undefined; }); } },
  };
});
import { CurriculumEnrollmentWorkbench } from '../src/components/curriculum-enrollment-workbench';

const id = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const ids = { organizationId: id('1'), schoolId: id('2'), curriculumId: id('3'), studentProfileId: id('4'), currentRankId: '' };
type Element = ReactElement<Record<string, any>>;
function elements(node: unknown): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (!React.isValidElement(node)) return []; const element = node as Element; return [element, ...elements(element.props.children)]; }
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(' '); if (React.isValidElement(node)) return text((node as Element).props.children); return typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
function render(initialStudentProfileId?: string): Element { hooks.cursor = 0; const tree = CurriculumEnrollmentWorkbench(initialStudentProfileId === undefined ? {} : { initialStudentProfileId }) as Element; hooks.effects.splice(0).forEach(run => run()); return tree; }
function unmount(): void { for (const cell of hooks.cells) if (cell && typeof cell === 'object' && 'cleanup' in cell) (cell as { cleanup?: () => void }).cleanup?.(); }
const field = (name: string) => elements(render()).find(element => element.props.name === name);
const button = (label: string) => elements(render()).find(element => element.type === 'button' && text(element) === label);
function edit(name: string, value: string): void { field(name)!.props.onChange({ target: { value } }); }
function fill(): void { for (const [name, value] of Object.entries(ids)) edit(name, value); }
function confirm(): void { field('confirmEnrollment')!.props.onChange({ target: { checked: true } }); }
function submit(): void { elements(render()).find(element => element.type === 'form')!.props.onSubmit({ preventDefault() {} }); }
const settle = async () => { for (let index = 0; index < 35; index++) await Promise.resolve(); };

beforeEach(() => { hooks.cells = []; hooks.cursor = 0; hooks.effects = []; });
afterEach(() => { unmount(); vi.restoreAllMocks(); });
describe('human curriculum enrollment workbench', () => {
  it('starts idle and requires four exact known IDs, an optional known rank, and explicit confirmation', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); const key = vi.spyOn(crypto, 'randomUUID');
    expect(text(render())).toContain('This page starts idle'); expect(fetcher).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
    expect(button('Submit human curriculum enrollment')!.props.disabled).toBe(true); fill(); expect(button('Submit human curriculum enrollment')!.props.disabled).toBe(true); confirm(); expect(button('Submit human curriculum enrollment')!.props.disabled).toBe(false);
  });
  it('allocates one UUID only after valid confirmation and retains only the exact in-memory uncertain command for human retry', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network')).mockRejectedValueOnce(new Error('network'));
    const key = vi.spyOn(crypto, 'randomUUID').mockReturnValue(id('9')); fill(); confirm(); submit(); await settle();
    expect(key).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1); const retry = button('Retry exact unchanged enrollment command')!; expect(retry).toBeDefined();
    const first = fetcher.mock.calls[0]; retry.props.onClick(); await settle(); expect(key).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[1]).toEqual(first);
    edit('studentProfileId', id('5')); expect(button('Retry exact unchanged enrollment command')).toBeUndefined();
  });
  it('adds no persistence, selector discovery, automatic transport, or downstream route/client', () => {
    const ui = readFileSync('src/components/curriculum-enrollment-workbench.tsx', 'utf8'); const http = readFileSync('src/components/curriculum-enrollment-workbench-http.ts', 'utf8');
    expect(ui + http).not.toMatch(/localStorage|sessionStorage|setInterval|setTimeout|\/people|\/roster|\/search|\/families|\/testing|\/booking|\/billing|\/payment|invokeLLM|executeAction|sendMessage|providerClient/);
    expect(ui).not.toMatch(/fetch\(/); expect(http.match(/fetch\(/g)).toHaveLength(1); expect(http).toContain("method: 'POST'"); expect(http).not.toContain("method: 'GET'"); expect(ui.match(/crypto\.randomUUID\(\)/g)).toHaveLength(1);
  });
  it('treats a valid registration handoff as inert student-profile form text and clears it on access loss', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'ignored' }), { status: 403 })); const key = vi.spyOn(crypto, 'randomUUID').mockReturnValue(id('9'));
    render(ids.studentProfileId);
    expect(field('studentProfileId')!.props.value).toBe(ids.studentProfileId); expect(field('organizationId')!.props.value).toBe(''); expect(field('schoolId')!.props.value).toBe(''); expect(field('curriculumId')!.props.value).toBe(''); expect(field('currentRankId')!.props.value).toBe('');
    expect(button('Submit human curriculum enrollment')!.props.disabled).toBe(true); expect(fetcher).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
    edit('organizationId', ids.organizationId); edit('schoolId', ids.schoolId); edit('curriculumId', ids.curriculumId); confirm(); submit(); await settle();
    expect(fetcher).toHaveBeenCalledTimes(1); expect(key).toHaveBeenCalledTimes(1);
    expect(field('studentProfileId')!.props.value).toBe(''); expect(field('organizationId')!.props.value).toBe(''); expect(field('schoolId')!.props.value).toBe(''); expect(field('curriculumId')!.props.value).toBe(''); expect(field('currentRankId')!.props.value).toBe('');
    expect(button('Submit human curriculum enrollment')!.props.disabled).toBe(true);
  });
});
