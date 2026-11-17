import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SCHOOL_SHELL_NAV, schoolShellActiveRoute } from '../src/components/school-shell/catalog';
import { DemoError, demoDataApi, demoErrorFor, keepForRetry } from '../src/components/school-demo-data/http';
import { DEMO_COPY } from '../src/components/school-demo-data/copy';
import { SchoolDemoDataSettingsView, type SchoolDemoDataSettingsViewProps } from '../src/components/school-demo-data/view';
import { SchoolShellFrame } from '../src/components/school-shell/frame';
import { id } from './account-status-fixtures';

// 0459: Settings > Demo data. Load and remove are each one human command; remove asks once first.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), key = id(77), setId = id(9), scope = { organizationId: org, schoolId: school };
const meta = { requestId: id(5), correlationId: id(5) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as DemoError; } throw new Error('expected a failure'); };
const counts = { adultStudents: 8, attendance: 310, classSessions: 18, classes: 3, families: 28, guardians: 20, invoices: 114, leads: 15, memberships: 38,
  overdueInvoices: 2, payments: 74, programs: 3, students: 38 };
const none = { status: 'NONE', setId: null, version: null, loadedAt: null, counts: null, lastRemovedAt: null };
const loaded = (over: Record<string, unknown> = {}) => ({ status: 'LOADED', setId, version: 1, loadedAt: '2026-11-17T08:00:00.000Z', counts, lastRemovedAt: null, ...over });

it('reads as a plain same-origin GET with no key and no x-hon header, and refuses drift', async () => {
  const f = stub(json({ data: loaded(), meta }));
  expect((await demoDataApi.read({ organizationId: org.toUpperCase(), schoolId: school }, signal(), () => true)).status).toBe('LOADED');
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/settings/demo-data`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
  for (const bad of [{ ...none, extra: 1 }, { ...none, setId }, loaded({ counts: { ...counts, leads: -1 } }), loaded({ version: 0 }), loaded({ loadedAt: 'soon' }), { data: 1 }]) {
    stub(json({ data: bad, meta }));
    expect((await fails(demoDataApi.read(scope, signal(), () => true))).kind).toBe('UNKNOWN');
  }
});

it('load sends {} with its own command and key and must answer LOADED; remove sends the read set and must answer NONE', async () => {
  const f = stub(json({ data: loaded(), meta: { ...meta, replayed: false } }));
  expect((await demoDataApi.load(scope, key, signal(), () => true)).status).toBe('LOADED');
  let [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/settings/demo-data/load`);
  expect(init).toMatchObject({ method: 'POST', headers: { 'X-HON-Human-Command': 'school.demo_data.load', 'Idempotency-Key': key } });
  expect(JSON.parse(String(init.body))).toEqual({});
  stub(json({ data: none, meta }));
  expect((await fails(demoDataApi.load(scope, key, signal(), () => true))).kind).toBe('UNKNOWN');

  const g = stub(json({ data: { ...none, lastRemovedAt: '2026-11-17T09:00:00.000Z' }, meta }));
  expect((await demoDataApi.remove(scope, { setId, expectedVersion: 1 }, key, signal(), () => true)).status).toBe('NONE');
  [path, init] = g.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/settings/demo-data/remove`);
  expect(init).toMatchObject({ method: 'POST', headers: { 'X-HON-Human-Command': 'school.demo_data.remove', 'Idempotency-Key': key } });
  expect(JSON.parse(String(init.body))).toEqual({ setId, expectedVersion: 1 });
  stub(json({ data: loaded(), meta }));
  expect((await fails(demoDataApi.remove(scope, { setId, expectedVersion: 1 }, key, signal(), () => true))).kind).toBe('UNKNOWN');
  const silent = stub(json({}));
  expect((await fails(demoDataApi.remove(scope, { setId: 'x', expectedVersion: 1 }, key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(demoDataApi.load(scope, 'not-a-key', signal(), () => true))).kind).toBe('INVALID');
  expect(silent).not.toHaveBeenCalled();
});

it('maps only exact refusals; in-use carries the verified table names; busy keeps the same-key retry', async () => {
  expect(demoErrorFor(403, { code: 'DEMO_DATA_FORBIDDEN' }).kind).toBe('DENIED');
  expect(demoErrorFor(409, { code: 'DEMO_DATA_ALREADY_LOADED' }).kind).toBe('CHANGED');
  expect(demoErrorFor(409, { code: 'VERSION_CONFLICT' }).kind).toBe('CHANGED');
  expect(demoErrorFor(404, { code: 'DEMO_DATA_NOT_LOADED' }).kind).toBe('CHANGED');
  expect(demoErrorFor(409, { code: 'IDEMPOTENCY_KEY_REUSED' }).kind).toBe('INVALID');
  const inUse = demoErrorFor(409, { code: 'DEMO_DATA_IN_USE', tables: ['class_bookings', 'class_bookings'] });
  expect([inUse.kind, inUse.tables]).toEqual(['IN_USE', ['class_bookings']]);
  expect(demoErrorFor(409, { code: 'DEMO_DATA_IN_USE', tables: ['DROP TABLE x'] }).tables).toEqual([]);
  expect(demoErrorFor(409, { code: 'DEMO_DATA_CONFLICT' }).kind).toBe('UNKNOWN');
  expect(demoErrorFor(503, null).kind).toBe('UNKNOWN');
  expect(keepForRetry(new DemoError('UNKNOWN'))).toBe(true);
  expect(keepForRetry(new DemoError('IN_USE'))).toBe(false);
  stub(json({ code: 'DEMO_DATA_IN_USE', tables: ['crm_lead_notes'] }, 409));
  expect((await fails(demoDataApi.remove(scope, { setId, expectedVersion: 1 }, key, signal(), () => true))).tables).toEqual(['crm_lead_notes']);
});

const props = (over: Partial<SchoolDemoDataSettingsViewProps> = {}): SchoolDemoDataSettingsViewProps => ({ language: 'en', waiting: false, concealed: false, hasSchool: true,
  read: { state: 'READY', read: loaded() as never }, outcome: null, locked: false, canRetry: false, confirming: false, ...over });

it('settings page: load when empty, counts and a confirm step when loaded, and plain states', () => {
  const empty = renderToStaticMarkup(<SchoolDemoDataSettingsView {...props({ read: { state: 'READY', read: none as never } })} />);
  expect(empty).toContain('Load demo data'); expect(empty).toContain('@example.com'); expect(empty).not.toContain('Remove demo data');
  const page = renderToStaticMarkup(<SchoolDemoDataSettingsView {...props()} />);
  expect(page).toContain('Demo data is loaded'); expect(page).toContain('data-count="leads"'); expect(page).toContain('Remove demo data');
  expect(page).not.toContain('data-testid="demo-confirm"');
  const confirm = renderToStaticMarkup(<SchoolDemoDataSettingsView {...props({ confirming: true })} />);
  expect(confirm).toContain('Yes, remove demo data'); expect(confirm).toContain('cannot be undone');
  const blocked = renderToStaticMarkup(<SchoolDemoDataSettingsView {...props({ outcome: { kind: 'IN_USE', tables: ['class_bookings'] } })} />);
  expect(blocked).toContain('class bookings'); expect(blocked).toContain('Nothing was removed');
  expect(renderToStaticMarkup(<SchoolDemoDataSettingsView {...props({ read: { state: 'DENIED' } })} />)).toContain('Only a school owner');
  expect(renderToStaticMarkup(<SchoolDemoDataSettingsView {...props({ concealed: true })} />)).not.toContain('data-count');
  expect(renderToStaticMarkup(<SchoolDemoDataSettingsView {...props({ outcome: { kind: 'UNKNOWN' }, canRetry: true })} />)).toContain('Try again');
  expect(renderToStaticMarkup(<SchoolDemoDataSettingsView {...props({ locked: true })} />)).toMatch(/disabled=""[^>]*data-demo-action="remove"/);
  for (const language of ['ko', 'es']) expect(renderToStaticMarkup(<SchoolDemoDataSettingsView {...props({ language })} />)).toContain(DEMO_COPY[language as 'ko'].loadedTitle);
});

it('the staff banner shows only for a verified school with demo data loaded, linking to the page', () => {
  const frame = (over: Record<string, unknown>) => renderToStaticMarkup(<SchoolShellFrame path="/staff/contacts" language="en" phase="READY" selection={scope as never} schoolName="Synthetic School"
    choices={[]} mode="modern" viewState="LOCAL" menuOpen={false} onMode={() => {}} onMenu={() => {}} onSwitch={() => {}} onChoose={() => {}} onRestore={() => {}} {...over} />);
  expect(frame({ demoLoaded: true })).toContain('data-demo-banner');
  expect(frame({ demoLoaded: true })).toContain('href="/staff/settings/demo-data"');
  expect(frame({ demoLoaded: false })).not.toContain('data-demo-banner');
  expect(frame({ demoLoaded: true, phase: 'CONCEALED', selection: null })).not.toContain('data-demo-banner');
});

it('the page is in the school shell under Settings and in the route manifest, and keeps nothing on the device', () => {
  expect(schoolShellActiveRoute('/staff/settings/demo-data')).toBeTruthy();
  expect(JSON.stringify(SCHOOL_SHELL_NAV)).toContain('/staff/settings/demo-data');
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
  expect(manifest.routes.filter((r: { path: string }) => r.path === '/staff/settings/demo-data')).toHaveLength(1);
  for (const file of ['src/components/school-demo-data/view.tsx', 'src/components/school-demo-data/school-demo-data.tsx', 'src/components/school-demo-data/http.ts']) {
    expect(readFileSync(file, 'utf8')).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  }
});

it('the page lists every count the server sends', async () => {
  const { SCHOOL_DEMO_DATA_COUNT_KEYS } = await import('@hon/contracts');
  const page = renderToStaticMarkup(<SchoolDemoDataSettingsView {...props()} />);
  for (const key of SCHOOL_DEMO_DATA_COUNT_KEYS) expect(page).toContain(`data-count="${key}"`);
});
