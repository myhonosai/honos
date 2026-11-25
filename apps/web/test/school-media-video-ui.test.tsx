import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { formatSchoolVideoDuration, schoolVideoTypeOf, verifySchoolMediaAsset } from '@hon/contracts';
import { MediaError, isVideoFile, keepForRetry, mediaApi, putVideo, videoFileProblem, videoPageLink } from '../src/components/school-media/http';
import { MEDIA_COPY } from '../src/components/school-media/copy';
import { SchoolMediaView, type SchoolMediaViewProps } from '../src/components/school-media/view';
import { readVideoPage } from '../src/components/school-video/public-video';
import { id } from './account-status-fixtures';

// 0654: videos in the media library. The browser PUTs the file to a one-time storage link; HON makes a 720p copy and a poster,
// and only those are ever shown (/m/<token>, /m/<token>/poster, the page /v/<token>).
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), key = id(77), assetId = id(31), scope = { organizationId: org, schoolId: school };
const meta = { requestId: id(5), correlationId: id(5) };
const TOKEN = 'V'.repeat(43);
const UPLOAD = 'https://store.example.test/storage/v1/object/upload/sign/hon-media/media/abc?token=t.k-1';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as MediaError; } throw new Error('expected a failure'); };
const at = { createdAt: '2026-11-22T08:00:00.000Z', updatedAt: '2026-11-22T08:00:01.000Z' };
const video = (over: Record<string, unknown> = {}) => ({ assetId, kind: 'VIDEO', mediaType: 'video/mp4', title: 'Kicks', byteSize: 4096, width: 1280, height: 720,
  copyState: 'DONE', durationMs: 65_000, state: 'READY', version: 3, linkToken: TOKEN, readyAt: '2026-11-22T08:00:01.000Z', ...at, ...over });
const pending = () => video({ state: 'PENDING', version: 1, linkToken: null, readyAt: null, copyState: null, durationMs: null, width: null, height: null });
const queued = () => video({ version: 2, linkToken: null, copyState: 'QUEUED', durationMs: null, width: null, height: null });
const usage = { storedBytes: 4096, storedLimitBytes: 5368709120, monthBytes: 4096, monthLimitBytes: 10737418240 };
function props(assets: unknown[], over: Partial<SchoolMediaViewProps> = {}): SchoolMediaViewProps {
  return { language: 'en', waiting: false, concealed: false, hasSchool: true, library: { state: 'READY', library: { assets: assets as never, usage } },
    editing: null, outcome: null, locked: false, canRetry: false, ...over };
}

/** A stand-in XMLHttpRequest that records the PUT and answers with `status`. */
function fakeXhr(status: number) {
  const sent: { method?: string; url?: string; headers: Record<string, string>; body?: unknown; withCredentials?: boolean } = { headers: {} };
  class Fake {
    status = 0; withCredentials = true; upload = { onprogress: null as null | ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) };
    onload: null | (() => void) = null; onerror: null | (() => void) = null; onabort: null | (() => void) = null;
    open(method: string, url: string) { sent.method = method; sent.url = url; }
    setRequestHeader(k: string, v: string) { sent.headers[k] = v; }
    abort() { this.onabort?.(); }
    send(body: unknown) {
      sent.body = body; sent.withCredentials = this.withCredentials;
      this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 });
      this.status = status; queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal('XMLHttpRequest', Fake);
  return sent;
}

it('a picked video is told apart by type or extension, and checked for size', () => {
  expect(schoolVideoTypeOf('clip.MOV', '')).toBe('video/quicktime');
  expect(videoFileProblem({ name: 'a.mp4', type: 'video/mp4', size: 10 })).toEqual({ mediaType: 'video/mp4' });
  expect(videoFileProblem({ name: 'a.webm', type: '', size: 10 })).toEqual({ mediaType: 'video/webm' });
  expect(videoFileProblem({ name: 'a.avi', type: 'video/x-msvideo', size: 10 })).toEqual({ problem: 'NOT_VIDEO' });
  expect(videoFileProblem({ name: 'a.mp4', type: 'video/mp4', size: 5 * 1024 ** 3 + 1 })).toEqual({ problem: 'VIDEO_TOO_LARGE' });
  expect(isVideoFile({ name: 'a.mov', type: '' })).toBe(true); expect(isVideoFile({ name: 'a.png', type: 'image/png' })).toBe(false);
  expect(formatSchoolVideoDuration(65_000)).toBe('1:05');
  expect(videoPageLink('https://app.example.test/', TOKEN)).toBe(`https://app.example.test/v/${TOKEN}`);
});

it('an upload begins, PUTs to the signed link with no cookies or HON headers, then finishes with its own command', async () => {
  const f = vi.fn(async (path: string) => path.endsWith('/video/begin') ? json({ data: { asset: pending(), uploadUrl: UPLOAD }, meta }) : json({ data: queued(), meta }));
  vi.stubGlobal('fetch', f);
  const sent = fakeXhr(200), progress: number[] = [];
  const file = new File([new Uint8Array(4096)], 'Kicks.mp4', { type: 'video/mp4' });
  const done = await mediaApi.uploadVideo(scope, { file, title: 'Kicks', mediaType: 'video/mp4' }, key, new AbortController().signal, () => true, (p) => progress.push(p));
  expect(done).toMatchObject({ state: 'READY', copyState: 'QUEUED', linkToken: null });
  const [begin, beginInit] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(begin).toBe(`/api/v1/organizations/${org}/schools/${school}/marketing/media/video/begin`);
  expect(beginInit.headers).toMatchObject({ 'X-HON-Human-Command': 'marketing_media.video_begin', 'Idempotency-Key': key });
  expect(JSON.parse(beginInit.body as string)).toEqual({ title: 'Kicks', mediaType: 'video/mp4', byteSize: 4096 });
  expect(sent).toMatchObject({ method: 'PUT', url: UPLOAD, body: file, withCredentials: false, headers: { 'Content-Type': 'video/mp4', 'x-upsert': 'true' } });
  expect(Object.keys(sent.headers).some(k => /^x-hon|idempotency|authorization|cookie/i.test(k))).toBe(false);
  expect(progress).toEqual([50]);
  const [finish, finishInit] = f.mock.calls[1] as unknown as [string, RequestInit];
  expect(finish).toMatch(/\/video\/finish$/);
  expect(finishInit.headers).toMatchObject({ 'X-HON-Human-Command': 'marketing_media.video_finish' });
  expect(JSON.parse(finishInit.body as string)).toEqual({ assetId });
});

it('a failed PUT explains the missing file; a link that is not a storage upload link is never used', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path.endsWith('/video/begin') ? json({ data: { asset: pending(), uploadUrl: UPLOAD }, meta })
    : json({ code: 'MEDIA_UPLOAD_MISSING' }, 409)));
  fakeXhr(500);
  const file = new File([new Uint8Array(4096)], 'Kicks.mp4', { type: 'video/mp4' });
  const error = await fails(mediaApi.uploadVideo(scope, { file, title: 'Kicks', mediaType: 'video/mp4' }, key, new AbortController().signal, () => true));
  expect(error.kind).toBe('UPLOAD_MISSING'); expect(keepForRetry(error)).toBe(true);
  for (const bad of ['https://evil.example.test/collect?token=x', 'http://store.example.test/storage/v1/object/upload/sign/a?token=t', `${UPLOAD}&x=1`]) {
    expect((await fails(putVideo(bad, file, 'video/mp4', new AbortController().signal, () => undefined))).kind).toBe('INVALID');
  }
  // Begin answers are checked: a READY answer must carry no link, a PENDING one must.
  vi.stubGlobal('fetch', vi.fn(async () => json({ data: { asset: pending(), uploadUrl: null }, meta })));
  expect((await fails(mediaApi.uploadVideo(scope, { file, title: 'Kicks', mediaType: 'video/mp4' }, key, new AbortController().signal, () => true))).kind).toBe('UNKNOWN');
});

it('asset answers follow the copy rules: a link only once the copy is done, sizes only then', () => {
  expect(verifySchoolMediaAsset(video()).kind).toBe('VIDEO');
  expect(verifySchoolMediaAsset(queued()).linkToken).toBeNull();
  for (const bad of [video({ linkToken: null }), queued() && { ...queued(), linkToken: TOKEN }, video({ copyState: null }), { ...pending(), copyState: 'QUEUED' }, video({ width: 1920 })]) {
    expect(() => verifySchoolMediaAsset(bad)).toThrow();
  }
});

it('a video card shows its poster once ready, "preparing" or "failed" before that, and copies the /v page link', () => {
  const html = renderToStaticMarkup(<SchoolMediaView {...props([video()])} />);
  expect(html).toContain(`src="/m/${TOKEN}/poster"`); expect(html).toContain('>Video<'); expect(html).toContain('1:05'); expect(html).toContain('1280 × 720');
  expect(html).toContain('never shared');
  const preparing = renderToStaticMarkup(<SchoolMediaView {...props([queued()])} />);
  expect(preparing).toContain('Preparing a smaller copy'); expect(preparing).not.toContain('/m/'); expect(preparing).not.toContain('data-action="copy"');
  const failed = renderToStaticMarkup(<SchoolMediaView {...props([video({ linkToken: null, copyState: 'FAILED', durationMs: null, width: null, height: null })])} />);
  expect(failed).toContain('couldn’t prepare this video');
  expect(renderToStaticMarkup(<SchoolMediaView {...props([], { outcome: { kind: 'UPLOADING_VIDEO', percent: 40 } as never })} />)).toMatch(/40%|Uploading/);
  for (const language of ['en', 'ko', 'es'] as const) { const c = MEDIA_COPY[language]; expect(c.videoPreparing && c.videoFailed && c.videoBadge && c.videoPrivacy).toBeTruthy(); }
  expect(readFileSync('src/components/school-media/view.tsx', 'utf8')).toContain("'.mov', '.mp4', '.m4v', '.webm'");
});

it('the public video page reads only its token, with no cookies, and treats anything odd as unavailable', async () => {
  const page = { schoolName: 'Dojo', title: 'Kicks', width: 1280, height: 720, durationMs: 65_000 };
  const f = vi.fn(async () => json({ data: page }));
  vi.stubGlobal('fetch', f);
  expect(await readVideoPage(TOKEN, new AbortController().signal)).toEqual({ state: 'READY', page });
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/public/media/${TOKEN}/page`);
  expect(init).toMatchObject({ credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
  expect(await readVideoPage('short', new AbortController().signal)).toEqual({ state: 'GONE' });
  vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'NOT_FOUND' }, 404)));
  expect((await readVideoPage(TOKEN, new AbortController().signal)).state).toBe('GONE');
  vi.stubGlobal('fetch', vi.fn(async () => json({ data: { ...page, schoolId: id(2) } })));
  expect((await readVideoPage(TOKEN, new AbortController().signal)).state).toBe('UNAVAILABLE');
  vi.stubGlobal('fetch', vi.fn(async () => json({ data: page }, 503)));
  expect((await readVideoPage(TOKEN, new AbortController().signal)).state).toBe('UNAVAILABLE');
});

it('the poster is served through its own rewrite, the page is in the route manifest, and nothing stays on the device', () => {
  expect(readFileSync('next.config.ts', 'utf8')).toContain("{ source: '/m/:token/poster', destination: `${apiBaseUrl}/v1/public/media/:token/poster` }");
  const route = readFileSync('src/app/v/[token]/page.tsx', 'utf8');
  expect(route).toContain("robots: { index: false, follow: false }"); expect(route).toContain("referrer: 'no-referrer'");
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
  expect(manifest.routes.filter((r: { path: string }) => r.path === '/v/:token')).toHaveLength(1);
  for (const f of ['src/components/school-video/public-video.tsx', 'src/components/school-media/http.ts']) {
    expect(readFileSync(f, 'utf8')).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  }
});
