import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTENDANCE_CATEGORIES, type ClassSessionRosterEntry, type CurrentSchoolClassSession } from '@hon/contracts';
// Inside the shell: the verified school fills the organization and school; the page picks the rest by name.
const h = vi.hoisted(() => ({ school: null as null | { organizationId: string; schoolId: string }, applied: false }));
vi.mock('../src/components/school-shell/page-school', () => ({
  useShellSchool: () => h.school,
  useShellSchoolInto: (apply: (school: { organizationId: string; schoolId: string }) => void) => { if (h.school && !h.applied) { h.applied = true; apply(h.school); } return h.school; },
  ManualSchoolFields: ({ children }: { children?: unknown }) => children,
}));
const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0 }));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual,
    useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial; return [hooks.cells[i], (value: unknown) => { hooks.cells[i] = typeof value === 'function' ? (value as (v: unknown) => unknown)(hooks.cells[i]) : value; }]; },
    useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = { current: initial }; return hooks.cells[i]; },
  };
});
import { AttendanceWorkbench } from '../src/components/attendance-workbench';
import { ClassChoice, ProgramChoice, StudentChoice, browserToday, classLabel, loadClassChoices, loadProgramChoices, loadStudentChoices } from '../src/components/attendance-correction-pickers';
import { RosterError, type RosterApi, type SessionPage } from '../src/components/class-roster/http';
import { IdFields } from '../src/components/school-pickers/pickers';

const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const school = { organizationId: id('1'), schoolId: id('2') };
const program = id('3'), session = id('4'), student = id('5'), recordId = id('6');
const meta = { requestId: id('8'), correlationId: id('8') };
const record = { id: recordId, classSessionId: session, studentProfileId: student, status: 'PRESENT', category: 'REGULAR_PARTICIPANT', progressionPolicyVersion: 1, progressionEnabled: true, progressionWeightMilli: 1000, progressionCreditMilli: 1000, recordedAt: '2026-11-16T18:00:00.000Z', version: 3, createdAt: '2026-11-16T18:00:00.000Z', updatedAt: '2026-11-16T18:00:00.000Z', note: 'Arrived late from school.' };
const categories = ATTENDANCE_CATEGORIES.map((category) => ({ category, operationalAllowed: true, progressionEnabled: false, weightMilli: 1000 }));

type Element = ReactElement<Record<string, any>>;
function elements(node: unknown): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (!React.isValidElement(node)) return []; const e = node as Element; return [e, ...elements(e.props.children)]; }
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(' '); if (React.isValidElement(node)) return text((node as Element).props.children); return typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
function render(): Element { hooks.cursor = 0; return AttendanceWorkbench() as Element; }
const of = (type: unknown) => elements(render()).find((e) => e.type === type);
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const calls = (fetcher: { mock: { calls: unknown[][] } }) => fetcher.mock.calls.map(([path, init]) => `${(init as RequestInit).method} ${String(path)}`);
const base = `/api/v1/organizations/${school.organizationId}/schools/${school.schoolId}`;

beforeEach(() => { hooks.cells = []; hooks.cursor = 0; h.school = school; h.applied = false; });
afterEach(() => { vi.restoreAllMocks(); });

describe('attendance correction inside the school shell', () => {
  it('picks the class and student by name, loads their record without any program, and saves it', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ data: null, meta }))
      .mockResolvedValueOnce(Response.json({ data: { ...record, note: undefined, status: 'LATE' }, meta: { ...meta, replayed: false } }));
    const html = text(render());
    expect(html).toContain('Choose the day, the class and the student');
    expect(html).not.toContain('UUID');
    expect(of(ClassChoice)!.props.date).toBe(browserToday());
    expect(of(StudentChoice)).toBeUndefined();
    expect(of(IdFields)!.props.manual).toBe(false);

    of(ClassChoice)!.props.onPick({ id: session, label: 'Kids BJJ · 5:00 PM' });
    expect(of(StudentChoice)!.props.sessionId).toBe(session);
    expect(fetcher).not.toHaveBeenCalled();
    of(StudentChoice)!.props.onPick({ id: student, label: 'Avery Lane' });
    await settle();
    expect(calls(fetcher)).toEqual([`GET ${base}/schedule/sessions/${session}/attendance?studentProfileId=${student}`]);
    expect(text(render())).toContain('Avery Lane has no attendance recorded for this class yet.');
    expect(text(render())).toContain('Avery Lane · Kids BJJ · 5:00 PM');

    const selects = elements(render()).filter((e) => e.type === 'select');
    selects[0]!.props.onChange({ target: { value: 'LATE' } });
    selects[1]!.props.onChange({ target: { value: 'REGULAR_PARTICIPANT' } });
    elements(render()).find((e) => e.type === 'form')!.props.onSubmit({ preventDefault() {} });
    await settle();
    expect(calls(fetcher)[1]).toBe(`POST ${base}/schedule/sessions/${session}/attendance`);
    expect(JSON.parse((fetcher.mock.calls[1]![1] as RequestInit).body as string)).toEqual({ studentProfileId: student, status: 'LATE', category: 'REGULAR_PARTICIPANT', note: '' });
    const after = text(render());
    expect(after).toContain('Saved Avery Lane’s attendance.');
    for (const hidden of [session, student, recordId, 'Verified', 'exact']) expect(after).not.toContain(hidden);
  });

  it('picks the program by name and loads its rules without a class or student', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ data: { programId: program, version: 2, categories }, meta }));
    render(); // the shell school is applied on the first render, as the real hook does in its effect
    of(ProgramChoice)!.props.onPick({ id: program, label: 'Kids Program' });
    await settle();
    expect(calls(fetcher)).toEqual([`GET ${base}/programs/${program}/attendance-policy`]);
    const after = text(render());
    expect(after).toContain('Loaded the attendance rules for Kids Program.');
    expect(after).toContain('Save rules');
    expect(after).not.toContain(program);
  });

  it('opens the ID fields only when a list is refused or unavailable, and says refusals in plain words', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ code: 'FORBIDDEN' }, { status: 403 }));
    of(ClassChoice)!.props.onState('DENIED');
    expect(elements(render()).filter((e) => e.type === IdFields).map((e) => e.props.manual)).toEqual([true, false]);
    of(ClassChoice)!.props.onPick({ id: session, label: 'Kids BJJ · 5:00 PM' });
    of(StudentChoice)!.props.onPick({ id: student, label: 'Avery Lane' });
    await settle();
    expect(text(render())).toContain('Your access does not include this at this school. Nothing was changed.');
    expect(text(render())).not.toContain('No success, credit');
  });

  it('a program pick keeps a loaded student record, and a class pick keeps loaded rules', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ data: record, meta }))
      .mockResolvedValueOnce(Response.json({ data: { programId: program, version: 2, categories }, meta }));
    render();
    of(ClassChoice)!.props.onTimeZone('America/Los_Angeles');
    of(ClassChoice)!.props.onPick({ id: session, label: 'Kids BJJ · 5:00 PM' });
    of(StudentChoice)!.props.onPick({ id: student, label: 'Avery Lane' });
    await settle();
    of(ProgramChoice)!.props.onPick({ id: program, label: 'Kids Program' });
    await settle();
    let after = text(render());
    expect(after).toContain('Current attendance');
    expect(after).toContain('Save rules');
    expect(after).toContain(new Date(record.recordedAt).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: 'America/Los_Angeles' }));
    of(ClassChoice)!.props.onPick({ id: session, label: 'Kids BJJ · 5:00 PM' });
    after = text(render());
    expect(after).not.toContain('Current attendance');
    expect(after).toContain('Save rules');
  });

  it('a new class date clears the class and student', () => {
    of(ClassChoice)!.props.onPick({ id: session, label: 'Kids BJJ · 5:00 PM' });
    elements(render()).find((e) => e.type === 'input' && e.props.type === 'date')!.props.onChange({ target: { value: '2026-11-10' } });
    expect(of(ClassChoice)!.props.date).toBe('2026-11-10');
    expect(of(ClassChoice)!.props.value).toBe('');
    expect(of(StudentChoice)).toBeUndefined();
  });
});

const sessionRow = (n: string, name: string, startsAt: string, extra: Partial<CurrentSchoolClassSession> = {}): CurrentSchoolClassSession => ({
  sessionId: id(n), name, startsAt, endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(), roomName: null, capacity: 20, bookingPolicy: 'WALK_IN', status: 'SCHEDULED', createdAt: '2026-11-01T00:00:00.000Z', ...extra,
});
const page = (items: CurrentSchoolClassSession[], nextCursor: string | null = null): SessionPage => ({ items, nextCursor, schoolTimezone: 'America/Los_Angeles', localToday: '2026-11-17', fromDate: '2026-11-16' });
const entry = (n: string, givenName: string, familyName: string): ClassSessionRosterEntry => ({ studentProfileId: id(n), personId: id('9'), givenName, familyName, studentStatus: 'ACTIVE', booking: null, attendance: { id: id('a'), status: 'PRESENT', category: 'REGULAR_PARTICIPANT', recordedAt: '2026-11-16T18:00:00.000Z', version: 1 } });
const never = new AbortController().signal, owned = () => true;

describe('attendance correction lists', () => {
  it('lists only the classes on the chosen school day, by name and school-local start time', async () => {
    const sessions = vi.fn<RosterApi['sessions']>().mockResolvedValue(page([
      sessionRow('a', 'Kids BJJ', '2026-11-17T01:00:00.000Z', { roomName: 'Mat 1' }), // 5:00 PM on 11-16 in Los Angeles
      sessionRow('b', 'Adults', '2026-11-17T03:30:00.000Z', { status: 'CANCELLED' }),
      sessionRow('c', 'Next day', '2026-11-17T17:00:00.000Z'),
    ]));
    await expect(loadClassChoices({ sessions }, school, '2026-11-16', never, owned)).resolves.toEqual({ items: [
      { id: id('a'), label: 'Kids BJJ · 5:00 PM · Mat 1' }, { id: id('b'), label: 'Adults · 7:30 PM · Cancelled' },
    ], truncated: false, timeZone: 'America/Los_Angeles' });
    sessions.mockResolvedValueOnce(page([sessionRow('a', 'Kids BJJ', '2026-11-17T01:00:00.000Z', { sessionId: id('a').toUpperCase() })]));
    await expect(loadClassChoices({ sessions }, school, '2026-11-16', never, owned)).resolves.toMatchObject({ items: [{ id: id('a') }] });
    expect(sessions).toHaveBeenCalledWith(school, '2026-11-16', null, never, owned);
    await expect(loadClassChoices({ sessions }, school, '16/11/2026', never, owned)).rejects.toBeInstanceOf(RosterError);
    expect(classLabel(sessionRow('d', 'Teens', '2026-11-16T18:00:00.000Z'), 'UTC')).toBe('Teens · 6:00 PM');
  });

  it('reads every roster page and names each student once', async () => {
    const roster = vi.fn<RosterApi['roster']>()
      .mockResolvedValueOnce({ entries: [entry('b', 'Avery', 'Lane')], nextCursor: 'next' })
      .mockResolvedValueOnce({ entries: [entry('b', 'Avery', 'Lane'), entry('c', 'Sam', 'Ortiz')], nextCursor: null });
    await expect(loadStudentChoices({ roster }, school, session, never, owned)).resolves.toEqual({ items: [{ id: id('b'), label: 'Avery Lane' }, { id: id('c'), label: 'Sam Ortiz' }], truncated: false });
    expect(roster.mock.calls.map((c) => c[2])).toEqual([null, 'next']);
  });

  it('says when a roster has more than ten pages instead of hiding the rest', async () => {
    const roster = vi.fn<RosterApi['roster']>().mockResolvedValue({ entries: [entry('b', 'Avery', 'Lane')], nextCursor: 'next' });
    await expect(loadStudentChoices({ roster }, school, session, never, owned)).resolves.toEqual({ items: [{ id: id('b'), label: 'Avery Lane' }], truncated: true });
    expect(roster).toHaveBeenCalledTimes(10);
  });

  it('lists the school’s programs by name', async () => {
    const list = vi.fn().mockResolvedValue({ localToday: '2026-11-17', timezone: 'UTC', fillLimit: '2027-02-09', topUpDue: false, series: [], programs: [{ programId: id('d'), name: 'Teens' }, { programId: id('e'), name: 'Kids' }] });
    await expect(loadProgramChoices({ list }, school, never, owned)).resolves.toEqual({ items: [{ id: id('e'), label: 'Kids' }, { id: id('d'), label: 'Teens' }], truncated: false });
  });
});
