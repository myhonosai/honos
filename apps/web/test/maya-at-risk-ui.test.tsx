import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SCHOOL_SHELL_NAV, schoolShellActiveRoute } from '../src/components/school-shell/catalog';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
import { MayaError, mayaApi, mayaErrorFor } from '../src/components/maya-at-risk/http';
import { MayaAtRiskView, factorText, type MayaAtRiskViewProps } from '../src/components/maya-at-risk/view';
import { id } from './account-status-fixtures';

// Maya M1 (0259): the staff "Students at risk" page reads the school's at-risk list. Nothing is sent or changed.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), scope = { organizationId: org, schoolId: school };
const meta = { requestId: id(5), correlationId: id(5) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as MayaError; } throw new Error('expected a failure'); };
const student = (over: Record<string, unknown> = {}) => ({ membershipId: id(30), givenName: 'Sam', familyName: 'Lee', membershipState: 'ACTIVE', score: 70, level: 'HIGH',
  suggestedNextStep: 'CALL_TO_CHECK_IN', factors: [{ code: 'LONG_ABSENCE', points: 45, daysSinceLastAttendance: 35, neverAttended: false }, { code: 'ATTENDANCE_DROP', points: 25, last28Days: 0, previous28Days: 5 }], ...over });
const raw = (over: Record<string, unknown> = {}) => ({ schemaVersion: 'MAYA_AT_RISK_V1', asOf: '2026-11-11T18:00:00.000Z', localToday: '2026-11-11', tuitionChecked: true,
  counts: { HIGH: 1, MEDIUM: 0, WATCH: 0 }, items: [student()], nextAfter: null, ...over });

it('reads the list as a plain same-origin GET with no key and no x-hon header, and pages by cursor', async () => {
  const f = stub(json({ data: raw(), meta }));
  const read = await mayaApi.atRisk({ organizationId: org.toUpperCase(), schoolId: school }, null, signal(), () => true);
  expect(read.items[0]?.score).toBe(70);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/retention/at-risk`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
  const g = stub(json({ data: raw(), meta }));
  await mayaApi.atRisk(scope, `45:${id(9)}`, signal(), () => true);
  expect((g.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/organizations/${org}/schools/${school}/retention/at-risk?after=45%3A${id(9)}`);
});

it('refuses drifted or unsafe answers and maps refusals', async () => {
  for (const bad of [raw({ items: [student({ score: 60 })] }), raw({ items: [student({ phone: '+15550000000' })] }), raw({ tuitionChecked: false, items: [student({ score: 20, level: 'WATCH', suggestedNextStep: 'REVIEW_TUITION_BALANCE', factors: [{ code: 'TUITION_OVERDUE', points: 20, overdueInvoiceCount: 1 }] })] })]) {
    stub(json({ data: bad, meta }));
    expect((await fails(mayaApi.atRisk(scope, null, signal(), () => true))).kind).toBe('UNKNOWN');
  }
  stub(json({ code: 'MAYA_AT_RISK_FORBIDDEN' }, 403));
  expect((await fails(mayaApi.atRisk(scope, null, signal(), () => true))).kind).toBe('DENIED');
  expect(mayaErrorFor(503).kind).toBe('UNKNOWN'); expect(mayaErrorFor(400).kind).toBe('INVALID');
  await expect(fails(mayaApi.atRisk(scope, 'nope', signal(), () => true))).resolves.toMatchObject({ kind: 'INVALID' });
  await expect(fails(mayaApi.atRisk({ organizationId: 'x', schoolId: school }, null, signal(), () => true))).resolves.toMatchObject({ kind: 'INVALID' });
});

it('a 401 ends the session only for the request still shown', async () => {
  const events: string[] = []; (globalThis.window as EventTarget).addEventListener(HON_SESSION_INVALIDATED_EVENT, () => events.push('ended'));
  stub(json({ code: 'UNAUTHENTICATED' }, 401));
  expect((await fails(mayaApi.atRisk(scope, null, signal(), () => false))).kind).toBe('SESSION');
  expect(events).toEqual([]);
  stub(json({ code: 'UNAUTHENTICATED' }, 401));
  expect((await fails(mayaApi.atRisk(scope, null, signal(), () => true))).kind).toBe('SESSION');
  expect(events).toEqual(['ended']);
});

const props = (over: Partial<MayaAtRiskViewProps> = {}): MayaAtRiskViewProps => ({ language: 'en', waiting: false, concealed: false, hasSchool: true,
  list: { state: 'READY', read: raw() as never, items: raw().items as never, nextAfter: null, more: 'IDLE' }, ...over });

it('shows each student with plain reasons and one suggested next step', () => {
  const html = renderToStaticMarkup(<MayaAtRiskView {...props()}/>);
  expect(html).toContain('Sam Lee'); expect(html).toContain('High risk (70/100)');
  expect(html).toContain('No class attended in 35 days.'); expect(html).toContain('0 classes in the last 4 weeks, 5 in the 4 weeks before');
  expect(html).toContain('Call the family to check in'); expect(html).toContain('not a prediction');
  expect(html).toContain('1 high risk · 0 medium risk · 0 to watch');
  const noBilling = renderToStaticMarkup(<MayaAtRiskView {...props({ list: { state: 'READY', read: raw({ tuitionChecked: false }) as never, items: [], nextAfter: null, more: 'IDLE' } })}/>);
  expect(noBilling).toContain('Tuition is not included');
  expect(factorText('en', { code: 'TERM_ENDING', points: 20, cancellationPending: false, termEndsOn: '2026-12-01' })).toContain('Dec 1, 2026');
  expect(factorText('en', { code: 'LONG_ABSENCE', points: 30, daysSinceLastAttendance: null, neverAttended: true })).toBe('Has not attended a class since joining.');
  expect(factorText('en', { code: 'TUITION_OVERDUE', points: 20, overdueInvoiceCount: 2 })).toBe('2 invoices are overdue.');
});

it('hides names when concealed, denied or unavailable', () => {
  for (const over of [{ concealed: true }, { list: { state: 'DENIED' } }, { list: { state: 'UNAVAILABLE' } }, { waiting: true }, { hasSchool: false }] as Partial<MayaAtRiskViewProps>[]) {
    expect(renderToStaticMarkup(<MayaAtRiskView {...props(over)}/>)).not.toContain('Sam Lee');
  }
  expect(renderToStaticMarkup(<MayaAtRiskView {...props({ list: { state: 'DENIED' } })}/>)).toContain('retention review permission');
});

it('is reachable from the AI team menu', () => {
  const team = SCHOOL_SHELL_NAV.find((group) => group.key === 'aiTeam');
  expect(team?.routes.some((route) => route.href === '/staff/retention/at-risk')).toBe(true);
  expect(schoolShellActiveRoute('/staff/retention/at-risk')?.href).toBe('/staff/retention/at-risk');
});
