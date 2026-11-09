import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OWNERSHIP_LANGUAGES, ownershipText } from '../src/components/school-ownership/copy';
import { OwnershipError, keepForRetry, ownershipApi, ownershipErrorFor } from '../src/components/school-ownership/http';
import { HqOwnershipView, OwnerOwnershipView, type HqOwnershipViewProps, type OwnerOwnershipViewProps } from '../src/components/school-ownership/view';
import { SCHOOL_SHELL_NAV, schoolShellActiveRoute } from '../src/components/school-shell/catalog';
import { HQ_NAV_GROUPS } from '../src/components/hq-modern/catalog';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
import { id } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const school = id(2), org = id(1), at = '2026-11-08T12:00:00.000Z';
const owner = (n: number, primary = false, over: Record<string, unknown> = {}) => ({ ownerGrantId: id(100 + n), displayName: `Owner ${n}`, email: `owner${n}@example.test`,
  since: '2026-10-01T09:00:00.000Z', primary, viaInvitation: n !== 1, ...over });
const notices = [
  { noticeId: id(900), kind: 'PRIMARY_OWNER_CHANGED', occurredAt: '2026-11-08T11:00:00.000Z', invitedEmail: null },
  { noticeId: id(901), kind: 'OWNER_ADDED', occurredAt: '2026-11-07T11:00:00.000Z', invitedEmail: 'owner2@example.test' },
  { noticeId: id(902), kind: 'OWNER_INVITED', occurredAt: '2026-11-06T11:00:00.000Z', invitedEmail: 'owner2@example.test' },
];
const hqRaw = (over: Record<string, unknown> = {}) => ({ schoolId: school, organizationId: org, owners: [owner(1, true), owner(2)], primaryOwnerGrantId: id(101),
  primaryNeeded: false, hqOwnerGrantIds: [id(50), id(51)], notices, asOf: at, ...over });
const ownerRaw = (over: Record<string, unknown> = {}) => ({ schoolId: school, owners: [owner(1, true), owner(2)], yourOwnerGrantId: id(102), primaryOwnerGrantId: id(101), notices, asOf: at, ...over });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as OwnershipError; } throw new Error('expected a failure'); };

it('reads HQ ownership as a plain same-origin GET with no query string and no x-hon header', async () => {
  const f = stub(json({ data: hqRaw() }));
  const view = await ownershipApi.hqRead(school.toUpperCase(), signal(), () => true);
  expect(view.owners.map(o => o.primary)).toEqual([true, false]);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/hq/schools/${school}/ownership`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
  expect(Object.keys(init.headers as object).some(k => k.toLowerCase().startsWith('x-hon'))).toBe(false);
  stub(json({ data: ownerRaw() }));
  await expect(ownershipApi.ownerRead(school, signal(), () => true)).resolves.toMatchObject({ yourOwnerGrantId: id(102) });
  expect(((vi.mocked(fetch).mock.calls[0] as unknown as [string])[0])).toBe(`/api/v1/account/schools/${school}/ownership`);
});

it('refuses an answer about another school, drifted shapes, and an HQ seat listed as an owner', async () => {
  stub(json({ data: hqRaw({ schoolId: id(3) }) }));
  expect((await fails(ownershipApi.hqRead(school, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: hqRaw({ hqOwnerGrantIds: [id(101)] }) }));
  expect((await fails(ownershipApi.hqRead(school, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: hqRaw(), extra: 1 }));
  expect((await fails(ownershipApi.hqRead(school, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: ownerRaw({ yourOwnerGrantId: id(150) }) }));
  expect((await fails(ownershipApi.ownerRead(school, signal(), () => true))).kind).toBe('UNKNOWN');
  await expect(fails(ownershipApi.hqRead('not-a-school', signal(), () => true))).resolves.toMatchObject({ kind: 'INVALID' });
});

it('maps refusals: 403 denied, 404 gone, 401 ends the session only for the current read', async () => {
  stub(json({ code: 'ACCOUNT_FORBIDDEN' }, 403));
  expect((await fails(ownershipApi.ownerRead(school, signal(), () => true))).kind).toBe('DENIED');
  stub(json({ code: 'ACCOUNT_UNAVAILABLE' }, 404));
  expect((await fails(ownershipApi.hqRead(school, signal(), () => true))).kind).toBe('GONE');
  const ended = vi.fn(); window.addEventListener(HON_SESSION_INVALIDATED_EVENT, ended);
  stub(json({ code: 'UNAUTHENTICATED' }, 401));
  expect((await fails(ownershipApi.hqRead(school, signal(), () => false))).kind).toBe('SESSION');
  expect(ended).not.toHaveBeenCalled();
  stub(json({ code: 'UNAUTHENTICATED' }, 401));
  await fails(ownershipApi.hqRead(school, signal(), () => true));
  expect(ended).toHaveBeenCalledTimes(1);
});

it('sends Make primary with the owner-account command header, JSON and an idempotency key, and checks the receipt', async () => {
  const key = id(700);
  const f = stub(json({ data: { operation: 'SET_PRIMARY', schoolId: school, organizationId: org, primaryOwnerGrantId: id(102), changed: true } }));
  await expect(ownershipApi.setPrimary({ schoolId: school, ownerGrantId: id(102) }, key, signal(), () => true)).resolves.toMatchObject({ changed: true });
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/hq/school-ownership/primary-owner');
  expect(init).toMatchObject({ method: 'POST', mode: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-HON-Human-Command': 'school-owner-account', 'Idempotency-Key': key } });
  expect(JSON.parse(init.body as string)).toEqual({ schoolId: school, ownerGrantId: id(102) });
  // A receipt for a different owner is not this command's answer.
  stub(json({ data: { operation: 'SET_PRIMARY', schoolId: school, organizationId: org, primaryOwnerGrantId: id(101), changed: true } }));
  expect((await fails(ownershipApi.setPrimary({ schoolId: school, ownerGrantId: id(102) }, key, signal(), () => true))).kind).toBe('UNKNOWN');
  await expect(fails(ownershipApi.setPrimary({ schoolId: school, ownerGrantId: id(102) }, 'not-a-key', signal(), () => true))).resolves.toMatchObject({ kind: 'INVALID' });
});

it('keeps a command for an exact retry only when its outcome is unknown or it was rate limited', () => {
  expect(ownershipErrorFor(404, 'OWNERSHIP_OWNER_NOT_LIVE').kind).toBe('NOT_LIVE');
  expect(ownershipErrorFor(409, 'ACCOUNT_CONFLICT').kind).toBe('UNKNOWN');
  expect(ownershipErrorFor(503, null).kind).toBe('UNKNOWN');
  expect(ownershipErrorFor(429, null).kind).toBe('RATE');
  for (const [status, code, keep] of [[409, 'ACCOUNT_CONFLICT', true], [503, null, true], [429, null, true], [400, 'ACCOUNT_INPUT_INVALID', false],
    [403, 'ACCOUNT_FORBIDDEN', false], [404, 'OWNERSHIP_OWNER_NOT_LIVE', false]] as const) expect(keepForRetry(ownershipErrorFor(status, code)), `${status}`).toBe(keep);
  expect(keepForRetry(new Error('network'))).toBe(true);
});

const hqView = (raw = hqRaw()) => ({ state: 'READY', view: raw }) as unknown as HqOwnershipViewProps['ownership'];
const hqProps = (over: Partial<HqOwnershipViewProps> = {}): HqOwnershipViewProps => ({ language: 'en', concealed: false,
  schools: { state: 'READY', schools: [{ schoolId: school, label: 'Org — Main school' }] }, selected: school, ownership: hqView(), confirming: null, outcome: null,
  locked: false, canRetry: false, ...over });
const hq = (over: Partial<HqOwnershipViewProps> = {}) => renderToStaticMarkup(<HqOwnershipView {...hqProps(over)}/>);

it('HQ view: owners with the primary badge, Make primary only on others, and HQ seats as a separate HQ access line', () => {
  const html = hq();
  expect(html.match(/data-testid="ownership-owner"/g)).toHaveLength(2);
  expect(html).toContain('Primary owner');
  expect(html.match(/>Make primary</g)).toHaveLength(1);
  expect(html).toContain('2 HQ seat(s) at this school');
  expect(html).not.toContain(id(50)); expect(html).not.toContain(id(51));
  expect(html).toContain('owner2@example.test became an owner.');
  expect(html).toContain('The primary owner changed.');
  expect(html).not.toContain('ownership-primary-needed');
  const needed = hq({ ownership: hqView(hqRaw({ owners: [owner(2)], primaryOwnerGrantId: null, primaryNeeded: true })) });
  expect(needed).toContain('ownership-primary-needed');
  expect(needed).toContain('This school needs a primary owner');
});

it('HQ view: confirmation names the owner, sending locks every action, and only an unknown outcome offers Try again', () => {
  const asking = hq({ confirming: id(102) });
  expect(asking).toContain('Make Owner 2 the primary owner?');
  expect(asking).toContain('Yes, make primary');
  const sending = hq({ confirming: id(102), locked: true, outcome: { kind: 'SENDING', name: 'Owner 2' } });
  expect(sending).toContain('Saving the primary owner');
  expect(sending.match(/<button[^>]*disabled=""[^>]*>(Yes, make primary|Cancel)</g)).toHaveLength(2);
  expect(hq({ outcome: { kind: 'UNKNOWN', name: 'Owner 2' }, locked: true, canRetry: true, onTryAgain: () => {} })).toContain('>Try again<');
  expect(hq({ outcome: { kind: 'NOT_LIVE', name: 'Owner 2' } })).not.toContain('>Try again<');
  expect(hq({ outcome: { kind: 'DONE', name: 'Owner 2' } })).toContain('Owner 2 is now the primary owner.');
});

it('HQ view shows nothing private when concealed, denied, or before a school is chosen', () => {
  for (const html of [hq({ concealed: true }), hq({ ownership: { state: 'DENIED' } }), hq({ selected: null, ownership: { state: 'IDLE' } }),
    hq({ selected: id(3) })]) { expect(html).not.toContain('owner1@example.test'); expect(html).not.toContain('HQ seat'); }
  expect(hq({ concealed: true })).toContain('Show again');
  expect(hq({ ownership: { state: 'DENIED' } })).toContain('Only the HQ owner can see and change school owners.');
});

const ownerProps = (over: Partial<OwnerOwnershipViewProps> = {}): OwnerOwnershipViewProps => ({ language: 'en', waiting: false, concealed: false, schoolId: school,
  state: { state: 'READY', view: ownerRaw() } as unknown as OwnerOwnershipViewProps['state'], ...over });
const ownerHtml = (over: Partial<OwnerOwnershipViewProps> = {}) => renderToStaticMarkup(<OwnerOwnershipView {...ownerProps(over)}/>);

it('owner view: co-owners with You and Primary badges and notices, with no command and no HQ seats', () => {
  const html = ownerHtml();
  expect(html).toContain('>You<'); expect(html).toContain('Primary owner');
  expect(html).not.toContain('Make primary'); expect(html).not.toContain('HQ seat');
  expect(html).toContain('owner2@example.test was invited to be an owner.');
  expect(ownerHtml({ state: { state: 'READY', view: ownerRaw({ owners: [owner(1), owner(2)], primaryOwnerGrantId: null }) } as unknown as OwnerOwnershipViewProps['state'] }))
    .toContain('This school has no primary owner right now.');
  for (const html of [ownerHtml({ concealed: true }), ownerHtml({ waiting: true }), ownerHtml({ state: { state: 'DENIED' } }), ownerHtml({ schoolId: id(3) })])
    expect(html).not.toContain('owner1@example.test');
  expect(ownerHtml({ state: { state: 'DENIED' } })).toContain('Only this school');
});

it('has every label in en, ko and es, and is reachable from both navigations and the route manifest', () => {
  const keys = Object.keys(OWNERSHIP_LANGUAGES.en).sort();
  for (const language of ['ko', 'es'] as const) expect(Object.keys(OWNERSHIP_LANGUAGES[language]).sort()).toEqual(keys);
  expect(ownershipText('ko', 'hqSeats', { n: '2' })).toBe('이 도장의 HQ 좌석 2개');
  expect(SCHOOL_SHELL_NAV.find(g => g.key === 'settings')?.routes.map(r => r.href)).toContain('/staff/owners');
  expect(schoolShellActiveRoute('/staff/owners')?.href).toBe('/staff/owners');
  expect(HQ_NAV_GROUPS['/hq/schools']?.children.map(c => c.path)).toContain('/hq/schools/owners');
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: { path: string }[] };
  for (const path of ['/hq/schools/owners', '/staff/owners']) expect(manifest.routes.some(r => r.path === path)).toBe(true);
  for (const page of ['src/app/hq/schools/owners/page.tsx', 'src/app/staff/owners/page.tsx']) expect(readFileSync(page, 'utf8')).toContain("referrer: 'no-referrer'");
  expect(readFileSync('src/app/staff/owners/page.tsx', 'utf8')).toContain('await requireVerifiedWebSession()');
});
