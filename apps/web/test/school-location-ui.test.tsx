import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FaceCheckInNotice } from '@hon/contracts';
import { SCHOOL_SHELL_NAV, schoolShellActiveRoute } from '../src/components/school-shell/catalog';
import { LocationError, locationApi, locationErrorFor, keepForRetry } from '../src/components/school-location/http';
import { EMPTY_LOCATION_DRAFT, draftFrom, draftLocation, draftProblems, locationFrom, sameDraft, saveInput } from '../src/components/school-location/draft';
import { LOCATION_COPY, locationCopy } from '../src/components/school-location/copy';
import { FaceCheckInNoticeView } from '../src/components/school-location/notice';
import { SchoolLocationSettingsView, type SchoolLocationSettingsViewProps } from '../src/components/school-location/view';
import { id } from './account-status-fixtures';

// 0392: the school address decides which face check-in notice HON shows. Information only; nothing is turned on.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), key = id(77), scope = { organizationId: org, schoolId: school };
const meta = { requestId: id(5), correlationId: id(5) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as LocationError; } throw new Error('expected a failure'); };
const address = { country: 'US', region: 'IL', city: 'Chicago', postalCode: '60601', addressLine1: '1 Synthetic Way', addressLine2: null };
const saved = (over: Record<string, unknown> = {}) => ({ ...address, version: 3, updatedAt: '2026-11-16T10:00:00.000Z', ...over });
const illinois = { profile: 'US_IL_BIPA', status: 'AVAILABLE_WITH_CONSENT', laws: ['Illinois Biometric Information Privacy Act (740 ILCS 14)'],
  addOns: ['WRITTEN_RELEASE', 'PUBLIC_RETENTION_SCHEDULE', 'PRIVATE_RIGHT_OF_ACTION'], reviewStatus: 'TEST_ONLY_DRAFT', rulesVersion: 1 } as unknown as FaceCheckInNotice;
const portland = { profile: 'US_PORTLAND_BAN', status: 'BLOCKED', laws: ['City of Portland ban'], addOns: ['CITY_BAN'], reviewStatus: 'TEST_ONLY_DRAFT', rulesVersion: 1 } as unknown as FaceCheckInNotice;
const none = { profile: null, status: 'LOCATION_REQUIRED', laws: [], addOns: [], reviewStatus: 'TEST_ONLY_DRAFT', rulesVersion: 1 } as unknown as FaceCheckInNotice;
const view = (over: Record<string, unknown> = {}) => ({ location: saved(), faceCheckInNotice: illinois, ...over });

it('reads the address as a plain same-origin GET with no key and no x-hon header, and refuses drift', async () => {
  const f = stub(json({ data: view(), meta }));
  expect((await locationApi.read({ organizationId: org.toUpperCase(), schoolId: school }, signal(), () => true)).faceCheckInNotice.profile).toBe('US_IL_BIPA');
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/settings/location`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
  expect(Object.keys(init.headers as object).some((k) => /^x-hon|idempotency/i.test(k))).toBe(false);
  stub(json({ data: { location: null, faceCheckInNotice: none }, meta }));
  expect((await locationApi.read(scope, signal(), () => true)).location).toBeNull();
  for (const bad of [view({ extra: 1 }), view({ location: null }), { location: null, faceCheckInNotice: illinois }, view({ location: saved({ region: null }) }),
    view({ faceCheckInNotice: { ...illinois, reviewStatus: 'LAWYER_APPROVED' } }), view({ faceCheckInNotice: { ...illinois, status: 'BLOCKED' } }),
    view({ faceCheckInNotice: { ...portland, addOns: [] } }), view({ location: saved({ updatedAt: 'soon' }) })]) {
    stub(json({ data: bad, meta }));
    expect((await fails(locationApi.read(scope, signal(), () => true))).kind).toBe('UNKNOWN');
  }
});

it('saves with its own human-command header and key, and accepts only the next version', async () => {
  const input = { location: address, expectedVersion: 3 };
  const f = stub(json({ data: view({ location: saved({ version: 4 }) }), meta: { ...meta, replayed: false } }));
  expect((await locationApi.save(scope, input, key, signal(), () => true)).location?.version).toBe(4);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/settings/location`);
  expect(init).toMatchObject({ method: 'POST', referrerPolicy: 'no-referrer', headers: { 'X-HON-Human-Command': 'school_location.save', 'Idempotency-Key': key } });
  expect(JSON.parse(String(init.body))).toEqual(input);
  for (const bad of [saved({ version: 3 }), saved({ version: 5 })]) {
    stub(json({ data: view({ location: bad }), meta }));
    expect((await fails(locationApi.save(scope, input, key, signal(), () => true))).kind).toBe('UNKNOWN');
  }
  const silent = stub(json({}));
  expect((await fails(locationApi.save(scope, { location: { ...address, region: null }, expectedVersion: 3 }, key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(locationApi.save(scope, input, 'not-a-key', signal(), () => true))).kind).toBe('INVALID');
  expect(silent).not.toHaveBeenCalled();
});

it('maps only exact refusals; a lock wait or 5xx keeps the request for the same-key retry', () => {
  expect(locationErrorFor(403, 'SCHOOL_LOCATION_FORBIDDEN').kind).toBe('DENIED');
  expect(locationErrorFor(409, 'VERSION_CONFLICT').kind).toBe('CHANGED');
  expect(locationErrorFor(409, 'SCHOOL_LOCATION_CONFLICT').kind).toBe('UNKNOWN');
  expect(locationErrorFor(503, null).kind).toBe('UNKNOWN');
  expect(keepForRetry(new LocationError('UNKNOWN'))).toBe(true);
  expect(keepForRetry(new LocationError('DENIED'))).toBe(false);
});

it('the draft trims text, keeps a region only where the country has a list, and explains each problem', () => {
  const c = locationCopy('en');
  expect(draftProblems(EMPTY_LOCATION_DRAFT, c)).toEqual([c.problems.country, c.problems.city]);
  const us = { ...EMPTY_LOCATION_DRAFT, country: 'US', city: '  New   York ' };
  expect(draftProblems(us, c)).toEqual([c.problems.region]);
  expect(draftLocation({ ...us, region: 'NY' }, c)).toEqual({ country: 'US', region: 'NY', city: 'New York', postalCode: null, addressLine1: null, addressLine2: null });
  expect(locationFrom({ ...us, country: 'KR', region: 'NY', city: '서울' }).region).toBeNull();
  expect(draftProblems({ ...us, region: 'NY', addressLine2: 'Suite 2' }, c)).toEqual([c.problems.addressLine2]);
  expect(draftProblems({ ...us, region: 'NY', city: '<b>' }, c)).toEqual([c.problems.city]);
  expect(sameDraft(draftFrom(saved()), draftFrom(saved()))).toBe(true);
  expect(saveInput(null, { ...us, region: 'NY' }, c).expectedVersion).toBe(0);
  expect(saveInput(saved(), draftFrom(saved()), c).expectedVersion).toBe(3);
  expect(() => saveInput(null, EMPTY_LOCATION_DRAFT, c)).toThrow();
});

it('the notice says what applies, never claims anything is on, and is always marked as a lawyer-review draft (en, ko, es)', () => {
  for (const language of ['en', 'ko', 'es'] as const) {
    const c = LOCATION_COPY[language];
    const il = renderToStaticMarkup(<FaceCheckInNoticeView notice={illinois} language={language} />);
    expect(il).toContain('740 ILCS 14'); expect(il).toContain(c.addOns.WRITTEN_RELEASE); expect(il).toContain(c.baseline); expect(il).toContain(c.draft);
    expect(il).toContain('data-face-notice="AVAILABLE_WITH_CONSENT"');
    const pdx = renderToStaticMarkup(<FaceCheckInNoticeView notice={portland} language={language} />);
    expect(pdx).toContain(c.status.BLOCKED); expect(pdx).not.toContain(c.baseline); expect(pdx).toContain(c.draft);
    const missing = renderToStaticMarkup(<FaceCheckInNoticeView notice={none} language={language} />);
    expect(missing).toContain(c.status.LOCATION_REQUIRED);
    // Every add-on has text in every language.
    for (const text of Object.values(c.addOns)) expect(text.length).toBeGreaterThan(10);
  }
});

const props = (over: Partial<SchoolLocationSettingsViewProps> = {}): SchoolLocationSettingsViewProps => ({
  language: 'en', waiting: false, concealed: false, hasSchool: true, read: { state: 'READY', read: view() as never }, draft: draftFrom(saved()),
  dirty: false, problems: [], outcome: null, locked: false, canRetry: false, ...over,
});

it('settings page: address fields, the saved notice, and plain states', () => {
  const page = renderToStaticMarkup(<SchoolLocationSettingsView {...props()} />);
  expect(page).toContain('School location'); expect(page).toContain('value="Chicago"'); expect(page).toContain('Version 3');
  expect(page).toContain('data-face-profile="US_IL_BIPA"'); expect(page).toMatch(/<button[^>]*disabled=""[^>]*>Save address/);
  const empty = renderToStaticMarkup(<SchoolLocationSettingsView {...props({ read: { state: 'READY', read: { location: null, faceCheckInNotice: none } as never }, draft: EMPTY_LOCATION_DRAFT })} />);
  expect(empty).toContain('No address yet'); expect(empty).toContain(LOCATION_COPY.en.status.LOCATION_REQUIRED);
  expect(renderToStaticMarkup(<SchoolLocationSettingsView {...props({ read: { state: 'DENIED' } })} />)).toContain('manage school location permission');
  expect(renderToStaticMarkup(<SchoolLocationSettingsView {...props({ concealed: true })} />)).not.toContain('Chicago');
  expect(renderToStaticMarkup(<SchoolLocationSettingsView {...props({ outcome: { kind: 'UNKNOWN' }, canRetry: true })} />)).toContain('Try again');
  const ko = renderToStaticMarkup(<SchoolLocationSettingsView {...props({ language: 'ko' })} />);
  expect(ko).toContain('도장 위치'); expect(ko).toContain(LOCATION_COPY.ko.draft);
});

it('the page is in the school shell under Settings and in the route manifest; nothing on it turns face check-in on', () => {
  expect(schoolShellActiveRoute('/staff/settings/location')).toBeTruthy();
  expect(JSON.stringify(SCHOOL_SHELL_NAV)).toContain('/staff/settings/location');
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
  expect(manifest.routes.filter((r: { path: string }) => r.path === '/staff/settings/location')).toHaveLength(1);
  for (const file of ['src/components/school-location/view.tsx', 'src/components/school-location/notice.tsx', 'src/components/school-location/school-location.tsx']) {
    expect(readFileSync(file, 'utf8')).not.toMatch(/localStorage|sessionStorage|camera|getUserMedia|enableFace/);
  }
});
