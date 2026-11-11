import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CurrentSchoolClassSession } from '@hon/contracts';
import { BookingPickersView, bookableSessions, loadBookableStudents, sessionLabel } from '../src/components/class-booking-pickers';
import { id, scope } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
const session = (n: number, over: Partial<CurrentSchoolClassSession> = {}): CurrentSchoolClassSession => ({ sessionId: id(600 + n), name: 'Kids Karate', startsAt: `2026-11-1${n}T01:00:00.000Z`, endsAt: `2026-11-1${n}T02:00:00.000Z`,
  roomName: 'Main mat', capacity: 20, bookingPolicy: 'OPEN', status: 'SCHEDULED', createdAt: '2026-11-01T00:00:00.000Z', ...over } as CurrentSchoolClassSession);
const meta = { requestId: id(5), correlationId: id(5) };

it('reads bookable students of the verified school with an optional bounded search', async () => {
  const f = vi.fn(async () => json({ data: [{ studentProfileId: id(700), givenName: 'Jordan', familyName: 'Rivera' }], meta }));
  vi.stubGlobal('fetch', f);
  await expect(loadBookableStudents(scope, ' Jor ', new AbortController().signal)).resolves.toEqual([{ studentProfileId: id(700), givenName: 'Jordan', familyName: 'Rivera' }]);
  expect((f.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/schedule/bookable-students?search=Jor`);
  vi.stubGlobal('fetch', vi.fn(async () => json({ data: [{ studentProfileId: 'x', givenName: 'a', familyName: 'b' }], meta })));
  await expect(loadBookableStudents(scope, '', new AbortController().signal)).rejects.toThrow();
  vi.stubGlobal('fetch', vi.fn(async () => json({}, 403)));
  await expect(loadBookableStudents(scope, '', new AbortController().signal)).rejects.toMatchObject({ kind: 'DENIED' });
});

it('offers only scheduled sessions that have not ended, soonest first, labelled without IDs', () => {
  const now = Date.parse('2026-11-12T00:00:00.000Z');
  const list = bookableSessions([session(5), session(4), session(3, { status: 'CANCELLED' } as never), session(1)], now);
  expect(list.map((s) => s.sessionId)).toEqual([id(604), id(605)]);
  expect(sessionLabel(session(4), 'en')).toMatch(/^Kids Karate · .+ · Main mat$/);
  expect(sessionLabel(session(4), 'en')).not.toContain(id(604));
});

it('renders labelled class and student pickers with no UUID inputs', () => {
  const html = renderToStaticMarkup(<BookingPickersView language="en" sessions={{ state: 'READY', items: [session(4)] }} students={{ state: 'READY', items: [{ studentProfileId: id(700), givenName: 'Jordan', familyName: 'Rivera' }] }}
    sessionId={id(604)} studentProfileId="" search="" disabled={false}/>);
  for (const label of ['Class', 'Find a student', 'Student']) expect(html).toContain(`>${label}</label>`);
  expect(html).toContain(`<option value="${id(604)}" selected="">Kids Karate`);
  expect(html).toContain('>Rivera, Jordan</option>');
  expect(html).not.toMatch(/UUID/);
  const empty = renderToStaticMarkup(<BookingPickersView language="en" sessions={{ state: 'READY', items: [] }} students={{ state: 'DENIED' }} sessionId="" studentProfileId="" search="" disabled={false}/>);
  expect(empty).toContain('No upcoming classes');
  expect(empty).toContain('does not include booking students');
});
