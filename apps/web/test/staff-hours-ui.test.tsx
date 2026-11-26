import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SCHOOL_SHELL_NAV, schoolShellActiveRoute } from '../src/components/school-shell/catalog';
import { PERMISSION_LABELS, areaOf } from '../src/components/staff-permissions/catalog';
import { HoursError, hoursApi, hoursErrorFor, keepForRetry } from '../src/components/staff-hours/http';
import { HOURS_COPY } from '../src/components/staff-hours/copy';
import { entryDraftOf, entryInput, entryProblems, localDateTime, newEntryDraft, timesheetCsv } from '../src/components/staff-hours/format';
import { StaffHoursView, type StaffHoursViewProps } from '../src/components/staff-hours/view';
import { id } from './account-status-fixtures';

// 0478: Staff > Hours. Staff clock in and out at the server's clock; managers review, fix, approve and export.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), key = id(77), sam = id(10), lee = id(11), entryId = id(20), scope = { organizationId: org, schoolId: school };
const meta = { requestId: id(5), correlationId: id(5) };
const LA = 'America/Los_Angeles';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as HoursError; } throw new Error('expected a failure'); };
const entry = (over: Record<string, unknown> = {}) => ({ entryId, staffPrincipalId: sam, localDate: '2026-11-18', clockInAt: '2026-11-18T17:00:00.000Z', clockOutAt: null,
  origin: 'CLOCK', version: 1, workedMinutes: null, updatedAt: '2026-11-18T17:00:00.000Z', ...over });
const closed = (over: Record<string, unknown> = {}) => entry({ clockOutAt: '2026-11-19T01:00:00.000Z', workedMinutes: 480, version: 4, ...over });
const clock = (over: Record<string, unknown> = {}) => ({ timezone: LA, now: '2026-11-18T18:00:00.000Z', weekStart: '2026-11-16', open: entry(), todayShifts: [], entries: [entry()], approval: null, ...over });
const week = (over: Record<string, unknown> = {}) => ({ weekStart: '2026-11-16', timezone: LA, people: [
  { principalId: sam, displayName: 'Sam Park', scheduledMinutes: 480, approval: null, entries: [closed()] },
  { principalId: lee, displayName: '=Lee Kim', scheduledMinutes: 0, approval: { status: 'APPROVED', version: 1, decidedAt: '2026-11-23T10:00:00.000Z' }, entries: [] }], ...over });
const fix = (over: Record<string, unknown> = {}) => ({ entryId: null, expectedVersion: 0, staffPrincipalId: sam, clockIn: '2026-11-18T09:00', clockOut: '2026-11-18T17:00',
  reason: 'Forgot to clock in', ...over }) as never;

it('reads the clock and a week as plain same-origin GETs with no key, and refuses drift', async () => {
  const f = stub(json({ data: clock(), meta }));
  expect((await hoursApi.clock(scope, signal(), () => true)).open?.entryId).toBe(entryId);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/staff/time/clock`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
  for (const bad of [clock({ open: closed() }), clock({ extra: 1 }), clock({ entries: [entry(), closed({ entryId: id(21), staffPrincipalId: lee })] })]) {
    stub(json({ data: bad, meta }));
    expect((await fails(hoursApi.clock(scope, signal(), () => true))).kind).toBe('UNKNOWN');
  }
  stub(json({ data: week(), meta }));
  expect((await hoursApi.timesheet(scope, '2026-11-16', signal(), () => true)).people).toHaveLength(2);
  for (const bad of [week({ weekStart: '2026-11-23' }), week({ people: [{ principalId: sam, displayName: 'Sam', scheduledMinutes: 0, approval: null, entries: [closed({ staffPrincipalId: lee })] }] })]) {
    stub(json({ data: bad, meta }));
    expect((await fails(hoursApi.timesheet(scope, '2026-11-16', signal(), () => true))).kind).toBe('UNKNOWN');
  }
  const silent = stub(json({}));
  expect((await fails(hoursApi.timesheet(scope, '2026-11-17', signal(), () => true))).kind).toBe('INVALID');
  expect(silent).not.toHaveBeenCalled();
});

it('each command sends its own name and key; a punch never carries a time; receipts must be the next version', async () => {
  const f = stub(json({ data: entry(), meta: { ...meta, replayed: false } }));
  expect((await hoursApi.punch(scope, { action: 'CLOCK_IN', expectedVersion: 0 }, key, signal(), () => true)).version).toBe(1);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/staff/time/clock`);
  expect(init).toMatchObject({ method: 'POST', headers: { 'X-HON-Human-Command': 'staff_time.punch', 'Idempotency-Key': key } });
  expect(JSON.parse(String(init.body))).toEqual({ action: 'CLOCK_IN', expectedVersion: 0 });
  stub(json({ data: entry({ version: 4 }), meta: { ...meta, replayed: false } }));
  expect((await fails(hoursApi.punch(scope, { action: 'CLOCK_OUT', expectedVersion: 3 }, key, signal(), () => true))).kind).toBe('UNKNOWN');
  const e = stub(json({ data: closed({ version: 1, origin: 'MANAGER' }), meta: { ...meta, replayed: false } }));
  expect((await hoursApi.saveEntry(scope, fix(), key, signal(), () => true)).origin).toBe('MANAGER');
  expect((e.mock.calls[0] as unknown as [string, RequestInit])[0]).toMatch(/\/staff\/time\/entries$/);
  expect((e.mock.calls[0] as unknown as [string, RequestInit])[1]).toMatchObject({ headers: { 'X-HON-Human-Command': 'staff_time.entry.save' } });
  stub(json({ data: closed({ version: 1, staffPrincipalId: lee }), meta: { ...meta, replayed: false } }));
  expect((await fails(hoursApi.saveEntry(scope, fix(), key, signal(), () => true))).kind).toBe('UNKNOWN');
  const d = stub(json({ data: { status: 'APPROVED', version: 1, decidedAt: '2026-11-23T10:00:00.000Z' }, meta: { ...meta, replayed: false } }));
  expect((await hoursApi.decide(scope, { staffPrincipalId: sam, weekStart: '2026-11-16', action: 'APPROVE', expectedVersion: 0 }, key, signal(), () => true)).status).toBe('APPROVED');
  expect((d.mock.calls[0] as unknown as [string, RequestInit])[1]).toMatchObject({ headers: { 'X-HON-Human-Command': 'staff_timesheet.decide' } });
  const silent = stub(json({}));
  expect((await fails(hoursApi.punch(scope, { action: 'CLOCK_IN', expectedVersion: 1 }, key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(hoursApi.saveEntry(scope, fix({ reason: '' }), key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(hoursApi.punch(scope, { action: 'CLOCK_IN', expectedVersion: 0 }, 'not-a-key', signal(), () => true))).kind).toBe('INVALID');
  expect(silent).not.toHaveBeenCalled();
});

it('maps only exact refusals; busy keeps the same-key retry', () => {
  expect(hoursErrorFor(403, 'STAFF_TIME_FORBIDDEN').kind).toBe('DENIED');
  expect(hoursErrorFor(403, 'TIMESHEET_SELF_APPROVAL').kind).toBe('SELF_APPROVAL');
  expect(hoursErrorFor(409, 'TIME_CLOCK_STATE_CHANGED').kind).toBe('CHANGED');
  expect(hoursErrorFor(409, 'VERSION_CONFLICT').kind).toBe('CHANGED');
  expect(hoursErrorFor(409, 'TIME_ENTRY_OVERLAP').kind).toBe('OVERLAP');
  expect(hoursErrorFor(409, 'TIMESHEET_APPROVED').kind).toBe('APPROVED');
  expect(hoursErrorFor(409, 'TIMESHEET_HAS_OPEN_ENTRY').kind).toBe('OPEN_ENTRY');
  expect(hoursErrorFor(409, 'TIME_ENTRY_TOO_LONG').kind).toBe('TOO_LONG');
  expect(hoursErrorFor(404, 'TIME_ENTRY_NOT_FOUND').kind).toBe('GONE');
  expect(hoursErrorFor(409, 'STAFF_TIME_CONFLICT').kind).toBe('UNKNOWN');
  expect(hoursErrorFor(503, null).kind).toBe('UNKNOWN');
  expect(keepForRetry(new HoursError('UNKNOWN'))).toBe(true);
  expect(keepForRetry(new HoursError('APPROVED'))).toBe(false);
});

it('the fix form uses school-local times, needs a reason, has no break fields; the CSV never runs formulas', () => {
  const c = HOURS_COPY.en;
  expect(localDateTime('2026-11-18T17:00:00.000Z', LA)).toBe('2026-11-18T09:00');
  const d = entryDraftOf(closed() as never, LA);
  expect(d).toMatchObject({ entryId, expectedVersion: 4, clockIn: '2026-11-18T09:00', clockOut: '2026-11-18T17:00', reason: '' });
  expect('breaks' in d).toBe(false);
  expect(entryProblems(d, c)).toEqual([c.problems.reason]);
  expect(entryProblems({ ...d, reason: 'Late start' }, c)).toEqual([]);
  expect(entryProblems({ ...d, reason: 'ok' }, c)).toEqual([c.problems.reason]);
  expect(entryProblems({ ...newEntryDraft(sam, '2026-11-16'), clockOut: '2026-11-16T08:00', reason: 'Missed' }, c)).toEqual([c.problems.times]);
  expect(entryInput({ ...d, reason: '  Late start ' })).toEqual({ entryId, expectedVersion: 4, staffPrincipalId: sam, clockIn: '2026-11-18T09:00', clockOut: '2026-11-18T17:00', reason: 'Late start' });
  const open = entryDraftOf(entry() as never, LA);
  expect(open.clockOut).toBe(open.clockIn);
  const csv = timesheetCsv(week() as never, c);
  expect(csv.split('\r\n')[0]).toBe(c.csv.header.map(h => `"${h}"`).join(','));
  expect(c.csv.header).toEqual(['Staff', 'Date', 'Clock in', 'Clock out', 'Worked hours', 'Scheduled hours', 'Notes']);
  expect(csv).toContain('"Sam Park","2026-11-18","09:00","17:00","8.0","","Time clock"');
  expect(csv).toContain('"Sam Park","Week total","","","8.0","8.0",""');
  expect(csv.toLowerCase()).not.toMatch(/break|overtime/);
  expect(csv).toContain('"\'=Lee Kim"'); expect(csv).not.toContain('"=Lee Kim"');
});

const props = (over: Partial<StaffHoursViewProps> = {}): StaffHoursViewProps => ({ language: 'en', waiting: false, concealed: false, hasSchool: true,
  clock: { state: 'READY', clock: clock() as never }, sheet: { state: 'READY', week: week() as never }, weekStart: '2026-11-16',
  draft: null, problems: [], outcome: null, locked: false, canRetry: false, ...over });

it('the clock shows one state and the right buttons', () => {
  const on = renderToStaticMarkup(<StaffHoursView {...props()} />);
  expect(on).toContain('data-clock="ON"'); expect(on).toContain('On the clock since 9:00'); expect(on).toContain('data-punch="CLOCK_OUT"'); expect(on).not.toContain('BREAK');
  expect(on).not.toContain('data-punch="CLOCK_IN"'); expect(on).toContain('HON’s clock, not your device');
  const off = renderToStaticMarkup(<StaffHoursView {...props({ clock: { state: 'READY', clock: clock({ open: null, entries: [closed()] }) as never } })} />);
  expect(off).toContain('Off the clock'); expect(off).toContain('data-punch="CLOCK_IN"'); expect(off).toContain('This week · 8 h');
  const approved = clock({ open: null, entries: [], approval: { status: 'APPROVED', version: 1, decidedAt: '2026-11-23T10:00:00.000Z' } });
  const a = renderToStaticMarkup(<StaffHoursView {...props({ clock: { state: 'READY', clock: approved as never } })} />);
  expect(a).toContain('data-testid="clock-approved"'); expect(a).not.toContain('data-punch=');
  expect(renderToStaticMarkup(<StaffHoursView {...props({ locked: true })} />)).toMatch(/disabled=""[^>]*data-punch="CLOCK_OUT"/);
});

it('timesheets: totals, scheduled, flags, approve and reopen, fix and add only in open weeks; a clocker sees no timesheet', () => {
  const page = renderToStaticMarkup(<StaffHoursView {...props()} />);
  expect(page).toMatch(new RegExp(`data-worked="${sam}"[^>]*>8 h<`)); expect(page).toMatch(new RegExp(`data-scheduled="${sam}"[^>]*>8 h<`));
  expect(page).toContain(`data-fix="${entryId}"`); expect(page).toContain(`data-add="${sam}"`); expect(page).not.toContain(`data-add="${lee}"`);
  expect(page).toContain(`data-decide="${sam}/APPROVE"`); expect(page).toContain(`data-decide="${lee}/REOPEN"`);
  expect(page).toContain('does not calculate pay'); expect(page).toContain('data-action="export"');
  const long = week({ people: [{ principalId: sam, displayName: 'Sam Park', scheduledMinutes: 0, approval: null,
    entries: [closed({ workedMinutes: 600 }), closed({ entryId: lee, clockInAt: '2026-11-19T17:00:00.000Z', clockOutAt: '2026-11-20T10:00:00.000Z', localDate: '2026-11-19', workedMinutes: 1020 })] }] });
  const flagged = renderToStaticMarkup(<StaffHoursView {...props({ sheet: { state: 'READY', week: long as never } })} />);
  expect(flagged).toContain('data-flag="LONG_ENTRY"'); expect(flagged).toMatch(new RegExp(`data-worked="${sam}"[^>]*>27 h<`));
  expect(flagged).not.toMatch(/overtime|DAY_OVER|WEEK_OVER|data-break/i);
  const clocker = renderToStaticMarkup(<StaffHoursView {...props({ sheet: { state: 'DENIED' } })} />);
  expect(clocker).toContain('data-testid="time-clock"'); expect(clocker).not.toContain('data-testid="timesheets"');
  const manager = renderToStaticMarkup(<StaffHoursView {...props({ clock: { state: 'DENIED' } })} />);
  expect(manager).not.toContain('data-testid="time-clock"'); expect(manager).toContain('data-testid="timesheets"');
  const form = renderToStaticMarkup(<StaffHoursView {...props({ draft: entryDraftOf(closed() as never, LA), problems: ['x'] })} />);
  expect(form).toContain('Fix an entry'); expect(form).toMatch(/disabled=""[^>]*data-field="staffPrincipalId"/); expect(form).toMatch(/disabled=""[^>]*data-entry-action="save"/);
  expect(renderToStaticMarkup(<StaffHoursView {...props({ draft: newEntryDraft(lee, '2026-11-16') })} />)).toContain('Add missed time');
});

it('plain states and languages', () => {
  expect(renderToStaticMarkup(<StaffHoursView {...props({ clock: { state: 'DENIED' }, sheet: { state: 'DENIED' } })} />)).toContain('Clock in and out');
  expect(renderToStaticMarkup(<StaffHoursView {...props({ clock: { state: 'UNAVAILABLE' }, sheet: { state: 'UNAVAILABLE' } })} />)).toContain('could not be read');
  expect(renderToStaticMarkup(<StaffHoursView {...props({ concealed: true })} />)).not.toContain('Sam Park');
  expect(renderToStaticMarkup(<StaffHoursView {...props({ outcome: { kind: 'UNKNOWN' }, canRetry: true })} />)).toContain('Try again');
  expect(renderToStaticMarkup(<StaffHoursView {...props({ outcome: { kind: 'TOO_LONG' } })} />)).toContain('over 24 hours');
  for (const language of ['ko', 'es'] as const) expect(renderToStaticMarkup(<StaffHoursView {...props({ language })} />)).toContain(HOURS_COPY[language].pageTitle);
});

it('the page is under Staff in the shell and the route manifest, the checklist names both permissions, and nothing stays on the device', () => {
  expect(schoolShellActiveRoute('/staff/team/hours')).toBeTruthy();
  expect(JSON.stringify(SCHOOL_SHELL_NAV.find(item => item.key === 'staff'))).toContain('/staff/team/hours');
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
  expect(manifest.routes.filter((r: { path: string }) => r.path === '/staff/team/hours')).toHaveLength(1);
  expect(PERMISSION_LABELS['staff.time.clock']).toBe('Clock in and out');
  expect(PERMISSION_LABELS['staff.timesheet.manage']).toBe('Review and approve timesheets');
  expect(areaOf('staff.time.clock').key).toBe('staff');
  for (const file of ['src/components/staff-hours/view.tsx', 'src/components/staff-hours/staff-hours.tsx', 'src/components/staff-hours/http.ts', 'src/components/staff-hours/format.ts']) {
    expect(readFileSync(file, 'utf8')).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  }
  expect(readFileSync('src/components/staff-hours/http.ts', 'utf8')).not.toMatch(/new Date\(\)|Date\.now/);
});
