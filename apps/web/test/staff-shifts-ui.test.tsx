import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SCHOOL_SHELL_NAV, schoolShellActiveRoute } from '../src/components/school-shell/catalog';
import { PERMISSION_LABELS, areaOf } from '../src/components/staff-permissions/catalog';
import { ShiftError, shiftApi, shiftErrorFor, keepForRetry } from '../src/components/staff-shifts/http';
import { SHIFT_COPY } from '../src/components/staff-shifts/copy';
import { draftOf, draftProblems, newDraft, saveInput } from '../src/components/staff-shifts/draft';
import { StaffShiftsView, type StaffShiftsViewProps } from '../src/components/staff-shifts/view';
import { id } from './account-status-fixtures';

// 0467: Staff > Shifts. Managers schedule the week; staff with view_own see their own row.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), key = id(77), sam = id(10), lee = id(11), shiftId = id(20), scope = { organizationId: org, schoolId: school };
const meta = { requestId: id(5), correlationId: id(5) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ShiftError; } throw new Error('expected a failure'); };
const shift = (over: Record<string, unknown> = {}) => ({ shiftId, staffPrincipalId: sam, date: '2026-11-18', start: '09:00', end: '13:00', startsAt: '2026-11-18T17:00:00.000Z',
  endsAt: '2026-11-18T21:00:00.000Z', position: 'Front desk', note: null, status: 'SCHEDULED', version: 1, updatedAt: '2026-11-17T10:00:00.000Z', ...over });
const week = (over: Record<string, unknown> = {}) => ({ mode: 'MANAGE', weekStart: '2026-11-16', timezone: 'America/Los_Angeles',
  staff: [{ principalId: sam, displayName: 'Sam Park' }, { principalId: lee, displayName: 'Lee Kim' }], shifts: [shift()],
  availability: [{ principalId: sam, windows: [{ weekday: 3, start: '10:00', end: '18:00' }] }], ...over });
const input = (over: Record<string, unknown> = {}) => ({ shiftId: null, expectedVersion: 0, staffPrincipalId: sam, date: '2026-11-18', start: '09:00', end: '13:00',
  position: 'Front desk', note: null, status: 'SCHEDULED', ...over }) as never;

it('reads one week as a plain same-origin GET with no key and no x-hon header, and refuses drift', async () => {
  const f = stub(json({ data: week(), meta }));
  expect((await shiftApi.week({ organizationId: org.toUpperCase(), schoolId: school }, '2026-11-16', signal(), () => true)).shifts).toHaveLength(1);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/staff/shifts/weeks/2026-11-16`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
  for (const bad of [week({ weekStart: '2026-11-23' }), week({ extra: 1 }), week({ shifts: [shift({ staffPrincipalId: id(99) })] }), week({ shifts: [shift({ date: '2026-11-23' })] }),
    week({ mode: 'OWN' }), week({ shifts: [shift(), shift()] }), week({ shifts: [shift({ end: '09:05' })] }), week({ staff: [{ principalId: sam, displayName: '' }] })]) {
    stub(json({ data: bad, meta }));
    expect((await fails(shiftApi.week(scope, '2026-11-16', signal(), () => true))).kind).toBe('UNKNOWN');
  }
  const silent = stub(json({}));
  expect((await fails(shiftApi.week(scope, '2026-11-17', signal(), () => true))).kind).toBe('INVALID');
  expect(silent).not.toHaveBeenCalled();
});

it('a save sends its own command and key and must answer the next version of the same person', async () => {
  const f = stub(json({ data: shift(), meta: { ...meta, replayed: false } }));
  expect((await shiftApi.save(scope, input(), key, signal(), () => true)).version).toBe(1);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/staff/shifts`);
  expect(init).toMatchObject({ method: 'POST', headers: { 'X-HON-Human-Command': 'staff_shift.save', 'Idempotency-Key': key } });
  expect(JSON.parse(String(init.body))).toEqual(input());
  for (const bad of [shift({ version: 2 }), shift({ staffPrincipalId: lee }), shift({ status: 'CANCELLED' })]) {
    stub(json({ data: bad, meta: { ...meta, replayed: false } }));
    expect((await fails(shiftApi.save(scope, input(), key, signal(), () => true))).kind).toBe('UNKNOWN');
  }
  stub(json({ data: shift({ shiftId: id(21), version: 2 }), meta: { ...meta, replayed: false } }));
  expect((await fails(shiftApi.save(scope, input({ shiftId, expectedVersion: 1 }), key, signal(), () => true))).kind).toBe('UNKNOWN');
  const silent = stub(json({}));
  expect((await fails(shiftApi.save(scope, input({ end: '08:00' }), key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(shiftApi.save(scope, input(), 'not-a-key', signal(), () => true))).kind).toBe('INVALID');
  expect(silent).not.toHaveBeenCalled();
});

it('maps only exact refusals; busy keeps the same-key retry', () => {
  expect(shiftErrorFor(403, 'STAFF_MEMBER_UNAVAILABLE').kind).toBe('DENIED');
  expect(shiftErrorFor(409, 'SHIFT_OVERLAP').kind).toBe('OVERLAP');
  expect(shiftErrorFor(409, 'VERSION_CONFLICT').kind).toBe('CHANGED');
  expect(shiftErrorFor(409, 'STAFF_SHIFT_CANCELLED').kind).toBe('GONE');
  expect(shiftErrorFor(404, 'STAFF_SHIFT_NOT_FOUND').kind).toBe('GONE');
  expect(shiftErrorFor(409, 'IDEMPOTENCY_KEY_REUSED').kind).toBe('INVALID');
  expect(shiftErrorFor(409, 'STAFF_SHIFT_CONFLICT').kind).toBe('UNKNOWN');
  expect(shiftErrorFor(503, null).kind).toBe('UNKNOWN');
  expect(keepForRetry(new ShiftError('UNKNOWN'))).toBe(true);
  expect(keepForRetry(new ShiftError('OVERLAP'))).toBe(false);
});

it('the form checks times and text before sending, and cancel sends the shift as read', () => {
  const c = SHIFT_COPY.en;
  expect(draftProblems(newDraft(sam, '2026-11-18'), c)).toEqual([]);
  expect(draftProblems({ ...newDraft(sam, '2026-11-18'), end: '09:05' }, c)).toEqual([c.problems.times]);
  expect(draftProblems({ ...newDraft('', '2026-11-31'), position: '<b>' }, c)).toEqual([c.problems.person, c.problems.date, c.problems.position]);
  expect(saveInput({ ...newDraft(sam, '2026-11-18'), position: '  Desk ', note: ' ' })).toMatchObject({ position: 'Desk', note: null, status: 'SCHEDULED', shiftId: null });
  expect(saveInput(draftOf(shift() as never), true)).toMatchObject({ shiftId, expectedVersion: 1, status: 'CANCELLED', start: '09:00', position: 'Front desk' });
});

const props = (over: Partial<StaffShiftsViewProps> = {}): StaffShiftsViewProps => ({ language: 'en', waiting: false, concealed: false, hasSchool: true, today: '2026-11-18',
  weekStart: '2026-11-16', read: { state: 'READY', week: week() as never }, showCancelled: false, draft: null, problems: [], confirmingCancel: false,
  outcome: null, locked: false, canRetry: false, ...over });

it('manager week: a row per person, totals, add buttons, availability warning, the form and a cancel confirm', () => {
  const page = renderToStaticMarkup(<StaffShiftsView {...props()} />);
  expect(page).toContain('Sam Park'); expect(page).toContain('Lee Kim'); expect(page).toContain(`data-shift="${shiftId}"`);
  expect(page).toContain(`data-add="${lee}/2026-11-20"`); expect(page).toContain('Front desk');
  expect(page).toMatch(new RegExp(`data-total="${sam}"[^>]*>4 h<`)); expect(page).toMatch(/data-week-total=""[^>]*>4 h</);
  expect(page).toContain('Outside availability');
  expect(page).toContain('Times in America/Los_Angeles'); expect(page).toContain('href="/staff/roles"');
  const cancelled = week({ shifts: [shift({ status: 'CANCELLED', version: 2 })] });
  expect(renderToStaticMarkup(<StaffShiftsView {...props({ read: { state: 'READY', week: cancelled as never } })} />)).not.toContain(`data-shift="${shiftId}"`);
  const shown = renderToStaticMarkup(<StaffShiftsView {...props({ read: { state: 'READY', week: cancelled as never }, showCancelled: true })} />);
  expect(shown).toContain('Cancelled'); expect(shown).toMatch(/data-week-total=""[^>]*>0 h</);
  const form = renderToStaticMarkup(<StaffShiftsView {...props({ draft: draftOf(shift() as never) })} />);
  expect(form).toContain('Change shift'); expect(form).toContain('Cancel this shift'); expect(form).toMatch(/disabled=""[^>]*data-field="staffPrincipalId"/);
  expect(renderToStaticMarkup(<StaffShiftsView {...props({ draft: newDraft(lee, '2026-11-19') })} />)).not.toContain('Cancel this shift');
  expect(renderToStaticMarkup(<StaffShiftsView {...props({ draft: draftOf(shift() as never), confirmingCancel: true })} />)).toContain('Yes, cancel the shift');
  expect(renderToStaticMarkup(<StaffShiftsView {...props({ draft: newDraft(lee, '2026-11-19'), problems: ['x'] })} />)).toMatch(/disabled=""[^>]*data-shift-action="save"/);
  expect(renderToStaticMarkup(<StaffShiftsView {...props({ draft: { ...newDraft(lee, '2026-11-19'), end: '24:00' } })} />)).toMatch(/data-field="end" value="00:00"/);
});

it('own week: one row, nothing to edit; plain states and languages', () => {
  const own = week({ mode: 'OWN', staff: [{ principalId: sam, displayName: 'Sam Park' }], availability: [] });
  const page = renderToStaticMarkup(<StaffShiftsView {...props({ read: { state: 'READY', week: own as never } })} />);
  expect(page).toContain('Your shifts for the week'); expect(page).not.toContain('data-add='); expect(page).not.toMatch(/<button[^>]*data-shift=/);
  expect(page).not.toContain('Outside availability'); expect(page).not.toContain('href="/staff/roles"');
  expect(renderToStaticMarkup(<StaffShiftsView {...props({ read: { state: 'DENIED' } })} />)).toContain('See their own shifts');
  expect(renderToStaticMarkup(<StaffShiftsView {...props({ concealed: true })} />)).not.toContain('Sam Park');
  expect(renderToStaticMarkup(<StaffShiftsView {...props({ outcome: { kind: 'UNKNOWN' }, canRetry: true })} />)).toContain('Try again');
  expect(renderToStaticMarkup(<StaffShiftsView {...props({ outcome: { kind: 'OVERLAP' } })} />)).toContain('already has a shift');
  expect(renderToStaticMarkup(<StaffShiftsView {...props({ read: { state: 'READY', week: week({ staff: [], shifts: [], availability: [] }) as never } })} />)).toContain('No staff at this school yet');
  for (const language of ['ko', 'es'] as const) expect(renderToStaticMarkup(<StaffShiftsView {...props({ language })} />)).toContain(SHIFT_COPY[language].pageTitle);
});

it('the page is under Staff in the shell and the route manifest, the checklist names both permissions, and nothing stays on the device', () => {
  expect(schoolShellActiveRoute('/staff/team/shifts')).toBeTruthy();
  expect(JSON.stringify(SCHOOL_SHELL_NAV.find(item => item.key === 'staff'))).toContain('/staff/team/shifts');
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
  expect(manifest.routes.filter((r: { path: string }) => r.path === '/staff/team/shifts')).toHaveLength(1);
  expect(PERMISSION_LABELS['staff.shift.manage']).toBe('Schedule staff shifts');
  expect(PERMISSION_LABELS['staff.shift.view_own']).toBe('See their own shifts');
  expect(areaOf('staff.shift.manage').key).toBe('staff');
  for (const file of ['src/components/staff-shifts/view.tsx', 'src/components/staff-shifts/staff-shifts.tsx', 'src/components/staff-shifts/http.ts', 'src/components/staff-shifts/draft.ts']) {
    expect(readFileSync(file, 'utf8')).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  }
});
