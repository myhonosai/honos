import React, { type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClassSessionRosterEntry, CurrentSchoolClassSession } from '@hon/contracts';
const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, effects: [] as (() => void)[], mock: false }));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  const deps = (a: unknown[] | undefined, b: unknown[] | undefined) => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
  return { ...actual,
    useId: () => (hooks.mock ? 'id' : actual.useId()),
    useState: (initial: unknown) => { if (!hooks.mock) return actual.useState(initial); const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial; return [hooks.cells[i], (value: unknown) => { hooks.cells[i] = typeof value === 'function' ? (value as (v: unknown) => unknown)(hooks.cells[i]) : value; }]; },
    useRef: (initial: unknown) => { if (!hooks.mock) return actual.useRef(initial); const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = { current: initial }; return hooks.cells[i]; },
    useEffect: (effect: () => (() => void) | void, list?: unknown[]) => {
      if (!hooks.mock) return actual.useEffect(effect, list);
      const i = hooks.cursor++; const cell = hooks.cells[i] as { deps?: unknown[]; cleanup?: () => void } | undefined;
      if (!cell || deps(cell.deps, list)) { const next = { deps: list, cleanup: cell?.cleanup }; hooks.cells[i] = next; hooks.effects.push(() => { next.cleanup?.(); next.cleanup = effect() || undefined; }); }
    },
  };
});
import { CheckInPanel, checkInStudent, loadTodaysClasses } from '../src/components/attendance-check-in/check-in';
import { CHECK_IN_OPENS_MS, classForNow } from '../src/components/attendance-check-in/class-by-time';
import { ScanView } from '../src/components/attendance-cards/scan';
import { FaceScanView } from '../src/components/face-check-in/scan';
import { StudentPicker } from '../src/components/school-pickers/pickers';
import type { RosterApi, SessionPage } from '../src/components/class-roster/http';

const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const school = { organizationId: id('1'), schoolId: id('2') };
const base = `/api/v1/organizations/${school.organizationId}/schools/${school.schoolId}`;
const meta = { requestId: id('8'), correlationId: id('8') };
const at = (iso: string) => Date.parse(iso);
const row = (n: string, name: string, startsAt: string, minutes = 60, extra: Partial<CurrentSchoolClassSession> = {}): CurrentSchoolClassSession => ({
  sessionId: id(n), name, startsAt, endsAt: new Date(at(startsAt) + minutes * 60_000).toISOString(), roomName: null, capacity: 20, bookingPolicy: 'WALK_IN', status: 'SCHEDULED', createdAt: '2026-11-01T00:00:00.000Z', ...extra,
});
const record = (status: string, version = 2) => ({ id: id('6'), classSessionId: id('a'), studentProfileId: id('5'), status, category: 'REGULAR_PARTICIPANT', progressionPolicyVersion: 1, progressionEnabled: true, progressionWeightMilli: 1000, progressionCreditMilli: 0, recordedAt: '2026-11-17T17:00:00.000Z', version, createdAt: '2026-11-17T17:00:00.000Z', updatedAt: '2026-11-17T17:00:00.000Z', note: 'Called in sick.' });
const calls = (fetcher: { mock: { calls: unknown[][] } }) => fetcher.mock.calls.map(([path, init]) => `${(init as RequestInit).method} ${String(path)}`);
const body = (fetcher: { mock: { calls: unknown[][] } }, n: number) => JSON.parse((fetcher.mock.calls[n]![1] as RequestInit).body as string);
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
afterEach(() => { vi.restoreAllMocks(); hooks.mock = false; });

describe('choosing the class by the time of day', () => {
  const kids = row('a', 'Kids', '2026-11-17T17:00:00.000Z'), teens = row('b', 'Teens', '2026-11-17T18:00:00.000Z'), adults = row('c', 'Adults', '2026-11-17T20:00:00.000Z');
  const day = [adults, kids, teens];
  it('opens check-in 30 minutes early, follows the class that is on, then the next one', () => {
    expect(CHECK_IN_OPENS_MS).toBe(30 * 60_000);
    expect(classForNow(day, at('2026-11-17T15:00:00.000Z'))).toBe(kids.sessionId); // before any class: the next one
    expect(classForNow(day, at('2026-11-17T16:35:00.000Z'))).toBe(kids.sessionId);
    expect(classForNow(day, at('2026-11-17T17:20:00.000Z'))).toBe(kids.sessionId);
    expect(classForNow(day, at('2026-11-17T17:35:00.000Z'))).toBe(kids.sessionId); // a late arrival still joins kids
    expect(classForNow(day, at('2026-11-17T17:45:00.000Z'))).toBe(teens.sessionId); // teens takes over 15 minutes before it starts
    expect(classForNow(day, at('2026-11-17T19:10:00.000Z'))).toBe(adults.sessionId); // between classes: the next one
    expect(classForNow(day, at('2026-11-17T23:00:00.000Z'))).toBe(adults.sessionId); // after the last: the last one
  });
  it('never chooses a cancelled class and is empty with no classes', () => {
    expect(classForNow([{ ...kids, status: 'CANCELLED' }, teens], at('2026-11-17T17:10:00.000Z'))).toBe(teens.sessionId);
    expect(classForNow([], Date.now())).toBe('');
  });
});

describe('today’s classes and the check-in command', () => {
  it('reads today’s classes in the school zone, skips cancelled ones and stops at tomorrow', async () => {
    const page = (items: CurrentSchoolClassSession[], nextCursor: string | null): SessionPage => ({ items, nextCursor, schoolTimezone: 'America/Los_Angeles', localToday: '2026-11-17', fromDate: '2026-11-17' });
    const sessions = vi.fn<RosterApi['sessions']>()
      .mockResolvedValueOnce(page([row('a', 'Kids', '2026-11-17T17:00:00.000Z'), row('b', 'Gone', '2026-11-17T18:00:00.000Z', 60, { status: 'CANCELLED' })], 'next'))
      .mockResolvedValueOnce(page([row('c', 'Late adults', '2026-11-18T05:00:00.000Z'), row('d', 'Tomorrow', '2026-11-18T17:00:00.000Z')], 'more'));
    const read = await loadTodaysClasses({ sessions }, school, new AbortController().signal, () => true);
    expect(read.items.map((s) => s.name)).toEqual(['Kids', 'Late adults']); // 9 PM on the 17th in Los Angeles
    expect(read).toMatchObject({ timeZone: 'America/Los_Angeles', localToday: '2026-11-17' });
    expect(sessions.mock.calls.map((c) => [c[1], c[2]])).toEqual([[null, null], [null, 'next']]);
  });

  it('checks in a student with no booking as a regular participant, and a booked trial as a trial', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ data: null, meta }))
      .mockResolvedValueOnce(Response.json({ data: record('PRESENT', 1), meta: { ...meta, replayed: false } }));
    await expect(checkInStudent(school, id('a'), id('5'), null, 'key-1')).resolves.toBe('CHECKED_IN');
    expect(calls(fetcher)).toEqual([`GET ${base}/schedule/sessions/${id('a')}/attendance?studentProfileId=${id('5')}`, `POST ${base}/schedule/sessions/${id('a')}/attendance`]);
    expect(body(fetcher, 1)).toEqual({ studentProfileId: id('5'), status: 'PRESENT', category: 'REGULAR_PARTICIPANT', note: '' });
    expect((fetcher.mock.calls[1]![1] as RequestInit).headers).toMatchObject({ 'Idempotency-Key': 'key-1' });
    fetcher.mockResolvedValueOnce(Response.json({ data: null, meta })).mockResolvedValueOnce(Response.json({ data: { ...record('PRESENT', 1), category: 'TRIAL_STUDENT' }, meta: { ...meta, replayed: false } }));
    const trial = { booking: { id: id('7'), kind: 'TRIAL', status: 'BOOKED', source: 'STAFF', bookedAt: '2026-11-16T00:00:00.000Z', cancelledAt: null, version: 1 }, attendance: null } as Pick<ClassSessionRosterEntry, 'booking' | 'attendance'>;
    await checkInStudent(school, id('a'), id('5'), trial, 'key-2');
    expect(body(fetcher, 3).category).toBe('TRIAL_STUDENT');
  });

  it('changes an absence to Present keeping its note and version, and leaves an existing check-in alone', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ data: record('UNEXCUSED_ABSENCE', 4), meta }))
      .mockResolvedValueOnce(Response.json({ data: record('PRESENT', 5), meta: { ...meta, replayed: false } }))
      .mockResolvedValueOnce(Response.json({ data: record('LATE', 5), meta }));
    await expect(checkInStudent(school, id('a'), id('5'), null, 'key-3')).resolves.toBe('CHECKED_IN');
    expect(body(fetcher, 1)).toEqual({ studentProfileId: id('5'), status: 'PRESENT', category: 'REGULAR_PARTICIPANT', note: 'Called in sick.', expectedVersion: 4 });
    await expect(checkInStudent(school, id('a'), id('5'), null, 'key-4')).resolves.toBe('ALREADY');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('turns refusals into plain kinds', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ code: 'FORBIDDEN' }, { status: 403 })).mockResolvedValueOnce(new Response('busy', { status: 503 }));
    await expect(checkInStudent(school, id('a'), id('5'), null, 'k')).rejects.toMatchObject({ kind: 'DENIED' });
    await expect(checkInStudent(school, id('a'), id('5'), null, 'k')).rejects.toMatchObject({ kind: 'UNKNOWN' });
  });
});

type Element = ReactElement<Record<string, any>>;
function elements(node: unknown): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (!React.isValidElement(node)) return []; const e = node as Element; return [e, ...elements(e.props.children)]; }
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(' '); if (React.isValidElement(node)) return text((node as Element).props.children); return typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }

describe('check-in panel', () => {
  let api: { sessions: ReturnType<typeof vi.fn>; roster: ReturnType<typeof vi.fn> };
  const render = (): Element => { hooks.cursor = 0; const tree = CheckInPanel({ scope: school, api: api as unknown as RosterApi }) as Element; hooks.effects.splice(0).forEach((run) => run()); return tree; };
  const flush = async () => { for (let i = 0; i < 4; i++) { render(); await settle(); } };
  beforeEach(() => {
    hooks.mock = true; hooks.cells = []; hooks.cursor = 0; hooks.effects = [];
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] }); vi.setSystemTime(new Date('2026-11-17T17:45:00.000Z'));
    api = {
      sessions: vi.fn().mockResolvedValue({ items: [row('a', 'Kids', '2026-11-17T17:00:00.000Z'), row('b', 'Teens', '2026-11-17T18:00:00.000Z')], nextCursor: null, schoolTimezone: 'America/Los_Angeles', localToday: '2026-11-17', fromDate: '2026-11-17' }),
      roster: vi.fn().mockResolvedValue({ entries: [], nextCursor: null }),
    };
  });
  afterEach(() => { vi.useRealTimers(); });

  it('chooses the class by the time, lets staff pick any student by name and checks them in', async () => {
    await flush();
    const select = elements(render()).find((e) => e.type === 'select')!;
    expect(select.props.value).toBe(id('b')); // Teens takes over at 17:45
    expect(elements(render()).find((e) => e.type === 'input' && e.props.type === 'checkbox')!.props.checked).toBe(true);
    const picker = elements(render()).find((e) => e.type === StudentPicker)!;
    expect(picker.props.purpose).toBe('attendance');
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ data: null, meta }))
      .mockResolvedValueOnce(Response.json({ data: { ...record('PRESENT', 1), classSessionId: id('b') }, meta: { ...meta, replayed: false } }));
    picker.props.onPick({ studentProfileId: id('5'), givenName: 'Avery', familyName: 'Lane' });
    const button = elements(render()).find((e) => e.type === 'button')!;
    expect(text(button)).toBe('Check in Avery Lane');
    button.props.onClick();
    await flush();
    expect(calls(fetcher)[1]).toBe(`POST ${base}/schedule/sessions/${id('b')}/attendance`);
    expect(text(render())).toContain('Avery Lane is checked in.');
    expect(api.roster.mock.calls.length).toBeGreaterThanOrEqual(2); // the class list refreshes after a check-in
  });

  it('waits for the chosen class’s list before a check-in can be sent, so a booked trial keeps its category', async () => {
    api.roster.mockReturnValue(new Promise(() => {}));
    await flush();
    elements(render()).find((e) => e.type === StudentPicker)!.props.onPick({ studentProfileId: id('5'), givenName: 'Avery', familyName: 'Lane' });
    expect(elements(render()).find((e) => e.type === 'button')!.props.disabled).toBe(true);
  });

  it('a class chosen by hand turns the time-of-day choice off', async () => {
    await flush();
    elements(render()).find((e) => e.type === 'select')!.props.onChange({ target: { value: id('a') } });
    await flush();
    expect(elements(render()).find((e) => e.type === 'select')!.props.value).toBe(id('a'));
    expect(elements(render()).find((e) => e.type === 'input' && e.props.type === 'checkbox')!.props.checked).toBe(false);
  });
});

describe('scan and face screens offer the time-of-day class choice', () => {
  const sessions = { state: 'READY' as const, sessions: [row('a', 'Kids', '2026-11-17T17:00:00.000Z')] };
  it('renders the switch on both screens', () => {
    const scan = renderToStaticMarkup(<ScanView language="en" sessions={sessions} sessionId={id('a')} status="PRESENT" code="" result={null} locked={false} canRetry={false} camera="OFF" autoClass />);
    expect(scan).toContain('data-testid="scan-auto-class"'); expect(scan).toContain('Choose the class by the time'); expect(scan).toMatch(/<input[^>]*checked=""[^>]*data-testid="scan-auto-class"|<input[^>]*data-testid="scan-auto-class"[^>]*checked=""/);
    const face = renderToStaticMarkup(<FaceScanView language="ko" sessions={sessions} sessionId={id('a')} status="PRESENT" camera="OFF" proposal={null} outcome={null} busy={false} autoClass={false} />);
    expect(face).toContain('data-testid="face-auto-class"'); expect(face).toContain('시간에 맞춰 수업 자동 선택');
  });
});
