import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { CLASS_BOOKING_KINDS } from '@hon/contracts';

const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual,
    useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = initial; return [hooks.cells[i], (value: unknown) => { hooks.cells[i] = typeof value === 'function' ? (value as (v: unknown) => unknown)(hooks.cells[i]) : value; }]; },
    useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = { current: initial }; return hooks.cells[i]; },
    useEffect: (effect: () => (() => void) | void, deps: unknown[]) => { const i = hooks.cursor++; if (!(i in hooks.cells)) { hooks.cells[i] = { deps }; hooks.effects.push(() => { (hooks.cells[i] as { cleanup?: (() => void) | undefined }).cleanup = effect() || undefined; }); } },
  };
});
import { ClassBookingWorkbench } from '../src/components/class-booking-workbench';
const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const ids = { organizationId: id('1'), schoolId: id('2'), sessionId: id('3'), studentProfileId: id('4') };
const booking = { id: id('6'), classSessionId: ids.sessionId, studentProfileId: ids.studentProfileId, bookingKind: 'REGULAR', status: 'BOOKED', source: 'STAFF', bookedAt: '2026-10-16T12:00:00.000Z', version: 1, createdAt: '2026-10-16T12:00:00.000Z', updatedAt: '2026-10-16T12:00:00.000Z', sessionCapacity: 1, activeSeatCount: 3, bookingPolicy: 'WALK_IN' };
const response = (data: unknown = booking, status = 201) => Response.json({ data, meta: { requestId: id('7'), correlationId: id('7'), replayed: status === 200 } }, { status });
type Element = ReactElement<Record<string, any>>;
function elements(node: unknown): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (!React.isValidElement(node)) return []; const e = node as Element; return [e, ...elements(e.props.children)]; }
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(' '); if (React.isValidElement(node)) return text((node as Element).props.children); return typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
function render(props?: { initialPrefill?: unknown }): Element { hooks.cursor = 0; const tree = ClassBookingWorkbench(props) as Element; hooks.effects.splice(0).forEach(run => run()); return tree; }
function unmount(): void { for (const cell of hooks.cells) if (cell && typeof cell === 'object' && 'cleanup' in cell) (cell as { cleanup?: () => void }).cleanup?.(); }
const button = (label: string) => elements(render()).find(e => e.type === 'button' && text(e) === label);
const field = (name: string) => elements(render()).find(e => e.props.name === name)!;
function edit(name: string, value: string): void { field(name).props.onChange({ target: { value } }); }
function submit(): void { elements(render()).find(e => e.type === 'form')!.props.onSubmit({ preventDefault() {} }); }
function confirm(): void { elements(render()).find(e => e.type === 'input' && e.props.type === 'checkbox')!.props.onChange({ target: { checked: true } }); }
function fill(): void { for (const [name, value] of Object.entries(ids)) edit(name, value); edit('bookingKind', 'REGULAR'); }
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
beforeEach(() => { hooks.cells = []; hooks.cursor = 0; hooks.effects = []; });
afterEach(() => { unmount(); vi.restoreAllMocks(); });

describe('bounded direct-human manual booking UI', () => {
  it('starts idle and blank, has only four IDs and generic kinds, and allocates no I/O/key before an explicit locally valid confirmed submit', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response());
    const allocate = vi.spyOn(crypto, 'randomUUID');
    expect(elements(render()).filter(e => e.type === 'input' && e.props.type !== 'checkbox').map(e => e.props.value)).toEqual(['', '', '', '']);
    expect(elements(render()).filter(e => e.type === 'option').map(e => e.props.value)).toEqual(['', ...CLASS_BOOKING_KINDS]);
    expect(text(render())).toContain('No verified booking receipt');
    submit(); confirm(); submit(); await settle();
    expect(fetcher).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled();
    fill(); submit(); await settle(); expect(fetcher).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled();
    confirm(); submit(); submit(); await settle();
    expect(fetcher).toHaveBeenCalledTimes(1); expect(allocate).toHaveBeenCalledTimes(1);
    expect(text(render())).toContain('Returned booking receipt:  BOOKED');
    submit(); await settle(); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(button('Retry exact unchanged booking command')).toBeUndefined();
  });

  it('accepts only the closed three-selector prefill, leaves student/kind/confirmation blank, and performs no automatic I/O or key allocation', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); const allocate = vi.spyOn(crypto, 'randomUUID');
    const prefilled = elements(render({ initialPrefill: { organizationId: ids.organizationId, schoolId: ids.schoolId, sessionId: ids.sessionId } }));
    expect(prefilled.filter(e => e.type === 'input' && e.props.type !== 'checkbox').map(e => e.props.value)).toEqual([ids.organizationId, ids.schoolId, ids.sessionId, '']);
    expect(prefilled.find(e => e.props.name === 'bookingKind')!.props.value).toBe(''); expect(prefilled.find(e => e.type === 'input' && e.props.type === 'checkbox')!.props.checked).toBe(false);
    expect(fetcher).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled();
    hooks.cells = []; hooks.cursor = 0; hooks.effects = [];
    const cleared = elements(render({ initialPrefill: { organizationId: ids.organizationId, schoolId: ids.schoolId, sessionId: ids.sessionId, studentProfileId: ids.studentProfileId } }));
    expect(cleared.filter(e => e.type === 'input' && e.props.type !== 'checkbox').map(e => e.props.value)).toEqual(['', '', '', '']);
    expect(fetcher).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled();
  });

  it('retains only exact uncertain path/body/key for a separate human retry, blocks fresh submit and stale retry handlers, and clears on every ID or kind edit', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(response(booking, 200));
    const allocate = vi.spyOn(crypto, 'randomUUID');
    fill(); confirm(); submit(); await settle();
    const retry = button('Retry exact unchanged booking command')!; expect(retry).toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(1); submit(); await settle(); expect(fetcher).toHaveBeenCalledTimes(1);
    retry.props.onClick(); retry.props.onClick(); await settle();
    expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1]); expect(allocate).toHaveBeenCalledTimes(1);
    expect(text(render())).toContain('Replayed or previously recorded booking receipt.');
    expect(button('Retry exact unchanged booking command')).toBeUndefined(); retry.props.onClick(); await settle(); expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [name, value] of [...Object.entries(ids), ['bookingKind', 'REGULAR']]) {
      edit(name!, value!); expect(text(render())).not.toContain('Returned booking receipt:');
      expect(button('Submit manual class booking')!.props.disabled).toBe(true);
      fetcher.mockRejectedValueOnce(new Error('network')); confirm(); submit(); await settle();
      const old = button('Retry exact unchanged booking command')!; expect(old).toBeDefined();
      const calls = fetcher.mock.calls.length;
      edit(name!, value!); expect(button('Retry exact unchanged booking command')).toBeUndefined();
      old.props.onClick(); await settle(); expect(fetcher).toHaveBeenCalledTimes(calls);
    }
  });

  it('shows WAITLISTED only from a verified returned receipt and describes both statuses without seat or downstream guarantees', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ ...booking, status: 'WAITLISTED', bookingPolicy: 'REQUIRED_BOOKING' }));
    fill(); confirm(); submit(); await settle();
    const copy = text(render());
    for (const phrase of ['Returned booking receipt:  WAITLISTED', 'WAITLISTED is not a confirmed seat or a future promotion promise.', 'command-response snapshot, not a live booking status', 'Returned session capacity', 'Returned active seat count', 'Returned booking policy', 'REQUIRED_BOOKING', 'Neither status establishes attendance, eligibility, availability, enrollment, identity, makeup approval']) expect(copy).toContain(phrase);
    expect(copy).not.toContain('Returned booking receipt:  BOOKED');
    for (const phrase of ['seat guaranteed', 'eligible student', 'payment confirmed', 'membership active']) expect(copy).not.toContain(phrase);
  });

  it('drops retries after definite rejections and clears all IDs, kind, confirmation, receipt and retry on 401/403', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(booking, 409));
    fill(); confirm(); submit(); await settle();
    expect(button('Retry exact unchanged booking command')).toBeUndefined(); expect(text(render())).toContain('command rejected');
    for (const status of [401, 403]) {
      edit('studentProfileId', ids.studentProfileId); fetcher.mockResolvedValueOnce(response(booking, status)); confirm(); submit(); await settle();
      expect(elements(render()).filter(e => e.type === 'input' && e.props.type !== 'checkbox').map(e => e.props.value)).toEqual(['', '', '', '']);
      expect(field('bookingKind').props.value).toBe(''); expect(button('Retry exact unchanged booking command')).toBeUndefined();
      expect(text(render())).not.toContain(booking.id); expect(text(render())).toContain('Inputs, receipt and retry were cleared');
      fill();
    }
  });

  it('does not render a malformed or broader status receipt, retains uncertainty, and warns that discard cannot undo the earlier command', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ ...booking, status: 'CHECKED_IN', capacityPolicy: 'POLICY_SECRET' }));
    fill(); confirm(); submit(); await settle();
    expect(text(render())).not.toContain('POLICY_SECRET'); expect(text(render())).not.toContain('Returned booking receipt:');
    expect(button('Retry exact unchanged booking command')).toBeDefined();
    expect(text(render())).toContain('earlier uncertain command may still have recorded a booking');
    button('Discard inputs / start over')!.props.onClick();
    expect(button('Retry exact unchanged booking command')).toBeUndefined(); expect(field('sessionId').props.value).toBe('');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('locks inputs while pending, deduplicates rapid submit/retry and ignores receipts after unmount', async () => {
    let finish!: (value: Response) => void;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    fill(); confirm(); submit(); submit();
    expect(elements(render()).find(e => e.type === 'fieldset')!.props.disabled).toBe(true);
    edit('sessionId', id('9')); expect(field('sessionId').props.value).toBe(ids.sessionId);
    unmount(); const snapshot = hooks.cells.slice(); finish(response()); await settle();
    expect(hooks.cells).toEqual(snapshot); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('adds no persistence, automatic transport, selector discovery, session management or downstream executor', () => {
    const ui = readFileSync('src/components/class-booking-workbench.tsx', 'utf8');
    const http = readFileSync('src/components/class-booking-workbench-http.ts', 'utf8');
    expect(ui + http).not.toMatch(/localStorage|sessionStorage|setInterval|setTimeout|invokeLLM|executeAction|sendMessage|providerClient|load[A-Z]|\/people|\/roster|\/search|\/calendar|\/billing|\/classpass/);
    expect(ui).not.toMatch(/fetch\(|searchParams|window\.location/);
    expect(http.match(/fetch\(/g)).toHaveLength(1);
    expect(http).toContain("method: 'POST'"); expect(http).not.toContain("method: 'GET'");
    expect(ui).toContain('crypto.randomUUID()'); expect(ui).toContain('retained.current !== command');
  });
});
