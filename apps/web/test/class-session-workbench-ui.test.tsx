import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { CLASS_SESSION_BOOKING_POLICIES } from '@hon/contracts';

const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual,
    useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = initial; return [hooks.cells[i], (value: unknown) => { hooks.cells[i] = typeof value === 'function' ? (value as (v: unknown) => unknown)(hooks.cells[i]) : value; }]; },
    useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = { current: initial }; return hooks.cells[i]; },
    useEffect: (effect: () => (() => void) | void) => { const i = hooks.cursor++; if (!(i in hooks.cells)) { hooks.cells[i] = { setup: effect }; hooks.effects.push(() => { (hooks.cells[i] as { cleanup?: (() => void) | undefined }).cleanup = effect() || undefined; }); } },
  };
});
import { ClassSessionWorkbench } from '../src/components/class-session-workbench';
const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const ids = { organizationId: id('1'), schoolId: id('2'), programId: id('3') };
const draft = { name: 'Morning fundamentals', roomName: 'Dojo A', startsAt: '2026-10-16T12:00:00.000Z', endsAt: '2026-10-16T13:00:00.000Z', capacity: '12', bookingPolicy: 'REQUIRED_BOOKING' };
const session = { id: id('4'), programId: ids.programId, name: draft.name, roomName: draft.roomName, startsAt: draft.startsAt, endsAt: draft.endsAt, capacity: 12, bookingPolicy: draft.bookingPolicy, status: 'SCHEDULED', version: 1, createdAt: '2026-10-16T10:00:00.000Z' };
const response = (data: unknown = session, status = 201) => Response.json({ data, meta: { requestId: id('5'), correlationId: id('5'), replayed: status === 200 } }, { status });
type Element = ReactElement<Record<string, any>>;
function elements(node: unknown): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (!React.isValidElement(node)) return []; const e = node as Element; return [e, ...elements(e.props.children)]; }
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(' '); if (React.isValidElement(node)) return text((node as Element).props.children); return typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
function render(): Element { hooks.cursor = 0; const tree = ClassSessionWorkbench() as Element; hooks.effects.splice(0).forEach((run) => run()); return tree; }
function unmount(): void { for (const cell of hooks.cells) if (cell && typeof cell === 'object' && 'cleanup' in cell) (cell as { cleanup?: () => void }).cleanup?.(); }
const button = (label: string) => elements(render()).find((e) => e.type === 'button' && text(e) === label);
const field = (name: string) => elements(render()).find((e) => e.props.name === name)!;
function edit(name: string, value: string): void { field(name).props.onChange({ target: { value } }); }
function submit(): void { elements(render()).find((e) => e.type === 'form')!.props.onSubmit({ preventDefault() {} }); }
function confirm(): void { field('confirmSession').props.onChange({ target: { checked: true } }); }
function fill(withRoom = true): void { for (const [name, value] of Object.entries(ids)) edit(name, value); for (const [name, value] of Object.entries(draft)) edit(name, name === 'roomName' && !withRoom ? '' : value); }
const settle = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
beforeEach(() => { hooks.cells = []; hooks.cursor = 0; hooks.effects = []; });
afterEach(() => { unmount(); vi.restoreAllMocks(); });

describe('bounded direct-human class-session creation UI', () => {
  it('starts blank and idle, accepts only known IDs and closed bounded fields, and allocates no key/I-O before explicit valid confirmation', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response()); const allocate = vi.spyOn(crypto, 'randomUUID');
    expect(elements(render()).filter((e) => e.type === 'input' && e.props.type !== 'checkbox').map((e) => e.props.value)).toEqual(['', '', '', '', '', '', '', '']);
    expect(elements(render()).filter((e) => e.type === 'option').map((e) => e.props.value)).toEqual(['', ...CLASS_SESSION_BOOKING_POLICIES]);
    expect(text(render())).toContain('No verified class-session receipt'); submit(); confirm(); submit(); await settle();
    expect(fetcher).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled();
    fill(); submit(); await settle(); expect(fetcher).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled();
    confirm(); submit(); submit(); await settle(); expect(fetcher).toHaveBeenCalledTimes(1); expect(allocate).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(`/api/v1/organizations/${ids.organizationId}/schools/${ids.schoolId}/schedule/sessions`);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { 'X-HON-Human-Command': 'class-session' } });
    expect(JSON.parse((fetcher.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ programId: ids.programId, name: draft.name, roomName: draft.roomName, startsAt: draft.startsAt, endsAt: draft.endsAt, capacity: 12, bookingPolicy: draft.bookingPolicy });
    expect(text(render())).toContain('Returned class-session receipt');
  });
  it('requires canonical UTC time ordering, bounded positive capacity and exact policies before a key or request', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); const allocate = vi.spyOn(crypto, 'randomUUID');
    for (const [name, value] of [['organizationId', 'Organization name'], ['programId', 'not-a-uuid'], ['name', ' '], ['name', 'x'.repeat(161)], ['roomName', 'x'.repeat(161)], ['startsAt', '2026-10-16T12:00:00'], ['endsAt', '2026-10-16T12:00:00.000Z'], ['capacity', '0'], ['capacity', '1.1'], ['capacity', '2147483648'], ['bookingPolicy', 'OPEN']]) {
      fill(); edit(name!, value!); confirm(); submit(); await settle(); expect(fetcher).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled();
    }
  });
  it('shows only a closed response-backed canonical record, including the optional-room omission, and declares no downstream guarantee', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response()).mockResolvedValueOnce(response(({ id: session.id, programId: ids.programId, name: draft.name, startsAt: draft.startsAt, endsAt: draft.endsAt, capacity: 12, bookingPolicy: 'WALK_IN', status: 'SCHEDULED', version: 1, createdAt: session.createdAt })));
    fill(); confirm(); submit(); await settle(); let copy = text(render());
    for (const phrase of ['Returned class-session receipt', session.id, 'Morning fundamentals', 'Dojo A', 'SCHEDULED', 'not a recurring calendar, instructor availability, booking, attendance, roster or capacity guarantee', 'ClassPass allowance, payment or membership outcome', 'provider, AI, Action Engine, automation or communication effects']) expect(copy).toContain(phrase);
    expect(copy).not.toContain('seat guaranteed');
    fill(false); edit('bookingPolicy', 'WALK_IN'); confirm(); submit(); await settle(); copy = text(render()); expect(copy).toContain('WALK_IN'); expect(copy).not.toContain('Returned room');
  });
  it('retains only the immutable exact path/body/v4 key after uncertainty, clears it on edits and never renders malformed/broader receipts', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(response(session, 200)); const allocate = vi.spyOn(crypto, 'randomUUID');
    fill(); confirm(); submit(); await settle(); const retry = button('Retry exact unchanged class-session command')!; expect(retry).toBeDefined(); expect(text(render())).toContain('earlier uncertain command may already have created a class session');
    retry.props.onClick(); retry.props.onClick(); await settle(); expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1]); expect(allocate).toHaveBeenCalledTimes(1); expect(text(render())).toContain('Replayed or previously recorded class-session receipt.');
    fill(); confirm(); fetcher.mockResolvedValueOnce(response({ ...session, extra: 'SECRET' })); submit(); await settle(); expect(text(render())).not.toContain('SECRET'); expect(text(render())).not.toContain('Returned class-session receipt'); expect(button('Retry exact unchanged class-session command')).toBeDefined();
    const old = button('Retry exact unchanged class-session command')!; const calls = fetcher.mock.calls.length; edit('capacity', '13'); old.props.onClick(); await settle(); expect(fetcher).toHaveBeenCalledTimes(calls); expect(button('Retry exact unchanged class-session command')).toBeUndefined();
  });
  it('drops retry after definite rejection and clears all input, receipt and retry on 401/403', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(session, 409)); fill(); confirm(); submit(); await settle();
    expect(button('Retry exact unchanged class-session command')).toBeUndefined(); expect(text(render())).toContain('No verified receipt or retry is retained');
    for (const status of [401, 403]) { fill(); confirm(); fetcher.mockResolvedValueOnce(response(session, status)); submit(); await settle();
      expect(elements(render()).filter((e) => e.type === 'input' && e.props.type !== 'checkbox').map((e) => e.props.value)).toEqual(['', '', '', '', '', '', '', '']);
      expect(field('bookingPolicy').props.value).toBe(''); expect(field('confirmSession').props.checked).toBe(false); expect(text(render())).not.toContain(session.id); expect(text(render())).toContain('Inputs, receipt and retry were cleared'); }
  });
  it('adds no persistence, auto-I/O, query/directory/calendar/instructor/booking/attendance/roster/capacity guarantee or downstream executor', () => {
    const ui = readFileSync('src/components/class-session-workbench.tsx', 'utf8'); const http = readFileSync('src/components/class-session-workbench-http.ts', 'utf8');
    expect(ui + http).not.toMatch(/localStorage|sessionStorage|indexedDB|setInterval|setTimeout|invokeLLM|executeAction|sendMessage|providerClient|searchParams|window\.location|dangerouslySetInnerHTML|\/people|\/roster|\/search|\/calendar|\/instructors|\/bookings|\/billing|\/classpass|method: 'GET'/);
    expect(ui).not.toMatch(/fetch\(/); expect(http.match(/fetch\(/g)).toHaveLength(1); expect(ui.match(/crypto\.randomUUID\(\)/g)).toHaveLength(1); expect(http).not.toMatch(/crypto\.randomUUID/); expect(ui).toContain('retained.current !== command');
  });
});
