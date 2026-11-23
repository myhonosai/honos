import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { schoolMediaTitleFromFileName, formatSchoolMediaBytes } from '@hon/contracts';
import { SCHOOL_SHELL_NAV, schoolShellActiveRoute } from '../src/components/school-shell/catalog';
import { PERMISSION_LABELS, areaOf } from '../src/components/staff-permissions/catalog';
import { MediaError, keepForRetry, mediaApi, mediaErrorFor, mediaFileProblem, mediaLink } from '../src/components/school-media/http';
import { MEDIA_COPY } from '../src/components/school-media/copy';
import { SchoolMediaView, type SchoolMediaViewProps } from '../src/components/school-media/view';
import { id } from './account-status-fixtures';

// 0628: Marketing > Media. Staff upload pictures for emails, see storage use, copy a picture's link, rename and delete.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), key = id(77), assetId = id(30), scope = { organizationId: org, schoolId: school };
const meta = { requestId: id(5), correlationId: id(5) };
const TOKEN = 'T'.repeat(43);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as MediaError; } throw new Error('expected a failure'); };
const asset = (over: Record<string, unknown> = {}) => ({ assetId, kind: 'IMAGE', mediaType: 'image/png', title: 'Open house', byteSize: 2048, width: 640, height: 480,
  state: 'READY', version: 2, linkToken: TOKEN, createdAt: '2026-11-22T08:00:00.000Z', readyAt: '2026-11-22T08:00:01.000Z', updatedAt: '2026-11-22T08:00:01.000Z', ...over });
const usage = { storedBytes: 2048, storedLimitBytes: 5368709120, monthBytes: 4096, monthLimitBytes: 10737418240 };
const file = (type = 'image/png', size = 10) => new File([new Uint8Array(size)], 'Open house.png', { type });

function props(over: Partial<SchoolMediaViewProps> = {}): SchoolMediaViewProps {
  return { language: 'en', waiting: false, concealed: false, hasSchool: true, library: { state: 'READY', library: { assets: [asset() as never], usage } },
    editing: null, outcome: null, locked: false, canRetry: false, ...over };
}

it('the list is a plain same-origin GET with no key or command; answers are checked', async () => {
  const f = stub(json({ data: { assets: [asset()], usage }, meta }));
  expect((await mediaApi.library(scope, signal(), () => true)).assets[0]!.linkToken).toBe(TOKEN);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/marketing/media`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
  for (const bad of [{ assets: [asset({ objectKey: 'media/x' })], usage }, { assets: [asset({ linkToken: null })], usage }, { assets: [asset(), asset()], usage }]) {
    stub(json({ data: bad, meta }));
    expect((await fails(mediaApi.library(scope, signal(), () => true))).kind).toBe('UNKNOWN');
  }
});

it('an upload sends the raw picture with its type, its own command, a key and the encoded title', async () => {
  const f = stub(json({ data: asset(), meta: { ...meta, replayed: false } }));
  const picture = file();
  expect((await mediaApi.upload(scope, { file: picture, title: 'Open house — día' }, key, signal(), () => true)).state).toBe('READY');
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/marketing/media/upload`);
  expect(init).toMatchObject({ method: 'POST', body: picture, headers: { 'Content-Type': 'image/png', 'X-HON-Human-Command': 'marketing_media.upload', 'Idempotency-Key': key,
    'X-HON-Media-Title': encodeURIComponent('Open house — día') } });
  const none = stub(json({}));
  expect((await fails(mediaApi.upload(scope, { file: file('image/svg+xml'), title: 'x' }, key, signal(), () => true))).kind).toBe('NOT_PICTURE');
  expect((await fails(mediaApi.upload(scope, { file: file('image/png', 26_214_401), title: 'x' }, key, signal(), () => true))).kind).toBe('TOO_LARGE');
  expect((await fails(mediaApi.upload(scope, { file: file(), title: ' x' }, key, signal(), () => true))).kind).toBe('INVALID');
  expect(none).not.toHaveBeenCalled();
  stub(json({ data: asset({ mediaType: 'image/gif' }), meta }));
  expect((await fails(mediaApi.upload(scope, { file: file(), title: 'x' }, key, signal(), () => true))).kind).toBe('UNKNOWN');
});

it('rename and delete send their own commands and check the answer', async () => {
  const f = stub(json({ data: asset({ title: 'Spring', version: 3 }), meta }));
  expect((await mediaApi.rename(scope, { assetId, expectedVersion: 2, title: 'Spring' }, key, signal(), () => true)).title).toBe('Spring');
  expect((f.mock.calls[0] as unknown as [string, RequestInit])[1]).toMatchObject({ headers: { 'X-HON-Human-Command': 'marketing_media.rename', 'Content-Type': 'application/json' } });
  stub(json({ data: asset({ title: 'Other', version: 3 }), meta }));
  expect((await fails(mediaApi.rename(scope, { assetId, expectedVersion: 2, title: 'Spring' }, key, signal(), () => true))).kind).toBe('UNKNOWN');
  const d = stub(json({ data: { assetId, removed: true }, meta }));
  expect(await mediaApi.remove(scope, { assetId, expectedVersion: 2 }, key, signal(), () => true)).toEqual({ assetId, removed: true });
  expect((d.mock.calls[0] as unknown as [string])[0]).toMatch(/\/marketing\/media\/delete$/);
});

it('refusals map to plain outcomes; only an unknown outcome or a busy server keeps the key', () => {
  expect(mediaErrorFor(409, 'MEDIA_STORAGE_FULL').kind).toBe('FULL');
  expect(mediaErrorFor(409, 'MEDIA_MONTHLY_LIMIT').kind).toBe('MONTH');
  expect(mediaErrorFor(503, 'MEDIA_STORAGE_OFF').kind).toBe('OFF');
  expect(mediaErrorFor(400, 'MEDIA_IMAGE_REFUSED').kind).toBe('NOT_PICTURE');
  expect(mediaErrorFor(413, 'MEDIA_TOO_LARGE').kind).toBe('TOO_LARGE');
  expect(mediaErrorFor(503, 'MEDIA_STORAGE_FAILED').kind).toBe('UNKNOWN');
  expect(keepForRetry(new MediaError('UNKNOWN'))).toBe(true);
  expect(keepForRetry(new MediaError('OFF'))).toBe(false);
  expect(mediaFileProblem({ type: 'image/webp', size: 1 })).toBe('NOT_PICTURE');
  expect(mediaLink('https://app.example.test/', TOKEN)).toBe(`https://app.example.test/m/${TOKEN}`);
  expect(schoolMediaTitleFromFileName('  IMG_0042\u0007.JPG')).toBe('IMG_0042');
  expect(schoolMediaTitleFromFileName('.png')).toBe('Picture');
  expect(formatSchoolMediaBytes(5368709120)).toBe('5 GB');
  expect(formatSchoolMediaBytes(1536)).toBe('1.5 KB');
});

it('shows storage use, each picture through its /m link, and a confirm step before delete', () => {
  const html = renderToStaticMarkup(<SchoolMediaView {...props()} />);
  expect(html).toContain('2 KB of 5 GB stored'); expect(html).toContain('4 KB of 10 GB uploaded this month');
  expect(html).toContain(`src="/m/${TOKEN}"`); expect(html).toMatch(/referrerpolicy="no-referrer"/i);
  expect(html).toContain('Location and camera details are removed');
  const confirm = renderToStaticMarkup(<SchoolMediaView {...props({ editing: { assetId, mode: 'DELETE' } })} />);
  expect(confirm).toContain('data-action="confirm-delete"'); expect(confirm).toContain('broken picture');
  const pending = renderToStaticMarkup(<SchoolMediaView {...props({ library: { state: 'READY', library: { assets: [asset({ state: 'PENDING', version: 1, linkToken: null, readyAt: null }) as never], usage } } })} />);
  expect(pending).toContain('didn’t finish'); expect(pending).not.toContain('/m/'); expect(pending).not.toContain('data-action="copy"');
  const rename = renderToStaticMarkup(<SchoolMediaView {...props({ editing: { assetId, mode: 'RENAME', title: ' bad' } })} />);
  expect(rename).toContain('no spaces at the start or end');
});

it('plain states and languages', () => {
  expect(renderToStaticMarkup(<SchoolMediaView {...props({ library: { state: 'DENIED' } })} />)).toContain('data-testid="media-denied"');
  expect(renderToStaticMarkup(<SchoolMediaView {...props({ library: { state: 'UNAVAILABLE' } })} />)).toContain('could not be read');
  expect(renderToStaticMarkup(<SchoolMediaView {...props({ concealed: true })} />)).not.toContain('Open house');
  expect(renderToStaticMarkup(<SchoolMediaView {...props({ outcome: { kind: 'OFF' } })} />)).toContain('isn’t switched on');
  expect(renderToStaticMarkup(<SchoolMediaView {...props({ outcome: { kind: 'UNKNOWN' }, canRetry: true })} />)).toContain('won’t be stored twice');
  for (const language of ['ko', 'es'] as const) expect(renderToStaticMarkup(<SchoolMediaView {...props({ language })} />)).toContain(MEDIA_COPY[language].pageTitle);
});

it('the page is under Marketing in the shell and the route manifest, both permissions have names, and nothing stays on the device', () => {
  expect(schoolShellActiveRoute('/staff/marketing/media')).toBeTruthy();
  expect(JSON.stringify(SCHOOL_SHELL_NAV.find(item => item.key === 'marketing'))).toContain('/staff/marketing/media');
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
  expect(manifest.routes.filter((r: { path: string }) => r.path === '/staff/marketing/media')).toHaveLength(1);
  expect(PERMISSION_LABELS['marketing.media.read']).toBe('See media');
  expect(PERMISSION_LABELS['marketing.media.manage']).toBe('Manage media');
  expect(areaOf('marketing.media.manage').key).toBe('marketing');
  expect(readFileSync('next.config.ts', 'utf8')).toContain("{ source: '/m/:token', destination: `${apiBaseUrl}/v1/public/media/:token` }");
  for (const f of ['view.tsx', 'school-media.tsx', 'http.ts']) {
    expect(readFileSync(`src/components/school-media/${f}`, 'utf8')).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  }
});
