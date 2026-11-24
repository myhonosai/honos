import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CreativeAvatar, CreativeAvatarVideo, CreativeAvatarVideoInput, CreativeGeneration } from '@hon/contracts';
import { CreativeGenerationError, createCreativeAvatarVideo, listCreativeAvatarVideos, prepareCreativeAvatarVideo } from '../src/components/creative-studio/generation-http';
import { matchesPendingVideo, matchesPendingVideoGeneration, outcomeFromVideoReceipt } from '../src/components/creative-studio/creative-studio';
import { studioWallet, type AvatarsState, type CreateOutcome, type VideosState } from '../src/components/creative-studio/model';
import { CreativeStudioView } from '../src/components/creative-studio/view';
import { id, rawWallet, reply, scope } from './account-status-fixtures';

// A2 Creative Studio avatar videos (0277): a READY avatar speaks a script as one avatar.video generation, charged per second.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const avatarId = id(970);
const input: CreativeAvatarVideoInput = { avatarId, script: 'Join our free trial class this Saturday!', seconds: 15, format: 'PORTRAIT' };
const key = id(951);
const STATUS = { GENERATING: 'CREATING', SUCCEEDED: 'READY', UNDER_REVIEW: 'UNDER_REVIEW', FAILED: 'NOT_CREATED', RESOLVED_CHARGED: 'NOT_CREATED', RESOLVED_NOT_CHARGED: 'NOT_CREATED' } as const;
function generation(status: CreativeGeneration['status'], extra: Partial<CreativeGeneration> = {}): CreativeGeneration {
  const done = status !== 'GENERATING', charged = status === 'SUCCEEDED' || status === 'RESOLVED_CHARGED';
  return { generationId: id(962), schoolId: scope.schoolId, operationCode: 'avatar.video', mediaKind: 'VIDEO', units: 15, format: 'PORTRAIT', prompt: input.script,
    status, failureReason: status === 'FAILED' ? 'PROVIDER_REJECTED' : status === 'UNDER_REVIEW' ? 'PROVIDER_UNKNOWN' : null, reservedCredits: 750,
    chargedCredits: charged ? 750 : null, createdAt: '2026-11-12T06:00:00.000Z', completedAt: done ? '2026-11-12T06:00:05.000Z' : null,
    assets: status === 'SUCCEEDED' ? [{ assetId: id(963), ordinal: 1, mediaType: 'video/mp4', width: 1080, height: 1920, durationSeconds: 15, origin: 'SYNTHETIC' }] : [], ...extra };
}
function video(status: CreativeGeneration['status'] = 'SUCCEEDED', extra: Partial<CreativeAvatarVideo> = {}, g: Partial<CreativeGeneration> = {}): CreativeAvatarVideo {
  const gen = generation(status, g);
  return { videoId: id(980), schoolId: scope.schoolId, avatarId, script: gen.prompt, seconds: gen.units, format: gen.format, status: STATUS[status], createdAt: gen.createdAt, generation: gen, ...extra };
}
function avatar(status: CreativeAvatar['status'] = 'READY', extra: Partial<CreativeAvatar> = {}): CreativeAvatar {
  const g: CreativeGeneration = { generationId: id(964), schoolId: scope.schoolId, operationCode: 'avatar.create', mediaKind: 'IMAGE', units: 1, format: 'PORTRAIT',
    prompt: 'Friendly master', status: status === 'READY' ? 'SUCCEEDED' : 'GENERATING', failureReason: null, reservedCredits: 100, chargedCredits: status === 'READY' ? 100 : null,
    createdAt: '2026-11-12T05:00:00.000Z', completedAt: status === 'READY' ? '2026-11-12T05:00:05.000Z' : null, assets: [] };
  return { avatarId, schoolId: scope.schoolId, name: 'Master Kim', style: 'REALISTIC', description: 'Friendly master', status, createdAt: g.createdAt, generation: g, ...extra };
}
const receipt = (v = video()) => ({ video: v, balance: rawWallet().balance, replayed: false });
const signal = () => new AbortController().signal;

it('lists avatar videos with a fixed same-origin GET and refuses videos of another school', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply({ videos: [video()], limit: 50 }));
  expect((await listCreativeAvatarVideos(scope.schoolId, signal())).videos).toHaveLength(1);
  const [path, init] = f.mock.calls[0]!;
  expect(path).toBe(`/api/v1/schools/${scope.schoolId}/creative-studio/avatar-videos`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
  f.mockResolvedValue(reply({ videos: [video('SUCCEEDED', { schoolId: id(9) }, { schoolId: id(9) })], limit: 50 }));
  await expect(listCreativeAvatarVideos(scope.schoolId, signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
  f.mockResolvedValue(reply({}, 403));
  await expect(listCreativeAvatarVideos(scope.schoolId, signal())).rejects.toMatchObject({ kind: 'DENIED' });
});

it('creates with exactly the closed request, the video command header and the key; bad input is never sent', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(receipt()));
  expect((await createCreativeAvatarVideo(scope.schoolId, input, key, signal())).video.status).toBe('READY');
  const [path, init] = f.mock.calls[0]!;
  expect(path).toBe(`/api/v1/schools/${scope.schoolId}/creative-studio/avatar-videos`);
  expect((init as RequestInit).headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'saas-creative-avatar-video-create', 'Idempotency-Key': key });
  expect(JSON.parse(String((init as RequestInit).body))).toEqual(input);
  f.mockClear();
  for (const bad of [{ ...input, seconds: 4 }, { ...input, seconds: 61 }, { ...input, seconds: 7.5 }, { ...input, script: '' }, { ...input, avatarId: 'x' }, { ...input, format: 'WIDE' },
    { ...input, operationCode: 'avatar.video' }]) {
    expect(() => prepareCreativeAvatarVideo(bad as CreativeAvatarVideoInput)).toThrow(CreativeGenerationError);
    await expect(createCreativeAvatarVideo(scope.schoolId, bad as CreativeAvatarVideoInput, key, signal())).rejects.toMatchObject({ kind: 'INVALID' });
  }
  expect(f).not.toHaveBeenCalled();
});

it('separates definitive video refusals from unknown outcomes', async () => {
  const f = vi.spyOn(globalThis, 'fetch');
  const cases: [number, string | null, string][] = [[503, 'CREATIVE_PROVIDER_NOT_CONNECTED', 'NOT_CONNECTED'], [422, 'SAAS_OPERATION_NOT_PRICED', 'REFUSED'],
    [422, 'CREATIVE_AVATAR_NOT_READY', 'REFUSED'], [422, 'CREATIVE_AVATAR_RATE_INVALID', 'REFUSED'], [422, 'CREATIVE_AVATAR_LIMIT_REACHED', 'UNKNOWN'],
    [422, 'SAAS_CREATIVE_AI_PAUSED_BY_HQ', 'REFUSED'], [422, 'SAAS_CREATIVE_LEDGER_MISMATCH', 'UNKNOWN'], [404, 'SAAS_UNAVAILABLE', 'INVALID'],
    [409, 'IDEMPOTENCY_KEY_REUSED', 'INVALID'], [409, 'SAAS_TRANSITION_NOT_ALLOWED', 'UNKNOWN'], [403, 'SAAS_FORBIDDEN', 'DENIED'], [500, null, 'UNKNOWN']];
  for (const [status, code, kind] of cases) {
    f.mockResolvedValueOnce(Response.json(code ? { code } : {}, { status }));
    await expect(createCreativeAvatarVideo(scope.schoolId, input, key, signal()), `${status} ${code}`).rejects.toMatchObject({ kind, code });
  }
  f.mockRejectedValueOnce(new TypeError('network'));
  await expect(createCreativeAvatarVideo(scope.schoolId, input, key, signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
  f.mockResolvedValueOnce(reply(receipt(video('SUCCEEDED', { script: 'Other words' }, { prompt: 'Other words' }))));
  await expect(createCreativeAvatarVideo(scope.schoolId, input, key, signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
});

it('maps the video outcome from its generation and matches only the pending request', () => {
  expect(outcomeFromVideoReceipt(receipt(video('SUCCEEDED')))).toEqual({ kind: 'DONE' });
  expect(outcomeFromVideoReceipt(receipt(video('UNDER_REVIEW')))).toEqual({ kind: 'HELD' });
  expect(outcomeFromVideoReceipt(receipt(video('FAILED')))).toEqual({ kind: 'FAILED' });
  expect(outcomeFromVideoReceipt(receipt(video('GENERATING')))).toEqual({ kind: 'UNKNOWN' });
  expect(matchesPendingVideo({ input }, video('GENERATING'))).toBe(true);
  expect(matchesPendingVideo({ input }, video('GENERATING', { seconds: 16 }, { units: 16 }))).toBe(false);
  expect(matchesPendingVideo(null, video('GENERATING'))).toBe(false);
  expect(matchesPendingVideoGeneration({ input }, generation('GENERATING'))).toBe(true);
  expect(matchesPendingVideoGeneration({ input }, generation('GENERATING', { operationCode: 'video.generate' }))).toBe(false);
});

function wallet(withVideoRate = true, available = 1000) {
  const raw = rawWallet();
  return studioWallet({ ...raw, walletVersion: 2, program: { ...raw.program, status: 'ACTIVE' }, eligibility: { eligible: true, reason: null, window: null },
    balance: { availableCredits: available, heldCredits: 0, byKind: raw.balance.byKind.map(k => k.kind === 'INCLUDED_MONTHLY' ? { ...k, grantedCredits: available, availableCredits: available } : k) },
    rates: { rateVersionId: id(40), rateVersion: 1, termsReference: 'terms', publishedAt: '2026-11-01T00:00:00.000Z', rates: [
      { operationCode: 'avatar.create', mediaKind: 'IMAGE', displayName: 'AI avatar', billingUnit: 'REQUEST', creditsPerUnit: 100, maxUnitsPerRequest: 1, rateBasis: 'PROVISIONAL' },
      ...(withVideoRate ? [{ operationCode: 'avatar.video', mediaKind: 'VIDEO' as const, displayName: 'AI avatar video', billingUnit: 'VIDEO_SECOND' as const, creditsPerUnit: 50, maxUnitsPerRequest: 30, rateBasis: 'PROVISIONAL' as const }] : [])] } });
}
const view = (avatars: AvatarsState, videos: VideosState, extra: { outcome?: CreateOutcome; language?: string; w?: ReturnType<typeof wallet>; locked?: boolean; hide?: (v: CreativeAvatarVideo) => boolean } = {}) => renderToStaticMarkup(
  <CreativeStudioView language={extra.language ?? 'en'} waiting={false} concealed={false} hasSchool studio={{ state: 'READY', wallet: extra.w ?? wallet() }}
    generations={{ state: 'READY', provider: 'CONNECTED', items: [] }} avatars={avatars} videos={videos} videoOutcome={extra.outcome ?? null} videoLocked={extra.locked}
    hideVideoText={extra.hide} onCreateVideo={() => {}} onCheckVideoAgain={() => {}}/>);
const card = (html: string) => html.slice(html.indexOf('creative-avatar-videos-title') - 60, html.indexOf('creative-credits-title'));
const connected = (items: CreativeAvatar[] = [avatar()]): AvatarsState => ({ state: 'READY', provider: 'CONNECTED', items });
const none: VideosState = { state: 'READY', items: [] };

it('offers the video form only when connected, eligible, priced by HQ and the school has a ready avatar', () => {
  const off = card(view({ state: 'READY', provider: 'NOT_CONNECTED', items: [] }, none));
  expect(off).toContain('data-avatar-video-state="NOT_CONNECTED"'); expect(off).toContain('Avatar videos are not connected yet'); expect(off).not.toMatch(/<textarea|<select/);
  const unpriced = card(view(connected(), none, { w: wallet(false) }));
  expect(unpriced).toContain('data-avatar-video-state="NOT_PRICED"'); expect(unpriced).not.toMatch(/<textarea/);
  const noAvatar = card(view(connected([avatar('CREATING')]), none));
  expect(noAvatar).toContain('data-avatar-video-state="NO_AVATAR"'); expect(noAvatar).toContain('Create an avatar first');
  const open = card(view(connected([avatar(), avatar('CREATING', { avatarId: id(971), name: 'Not yet' })]), none));
  expect(open).toContain('data-avatar-video-state="OPEN"'); expect(open).toMatch(/<textarea/);
  expect(open).toContain('Master Kim · Realistic'); expect(open).not.toContain('Not yet');
  expect(open).toContain('Length in seconds (5 to 30)'); expect(open).toContain('max="30"');
  expect(open).toContain('Uses 750 credits. You have 1,000 available.');
  expect(open).toMatch(/<button type="submit" disabled="">Make video<\/button>/);
  expect(card(view(connected(), none, { w: wallet(true, 500) }))).toContain('Not enough credits');
  const ineligible = studioWallet({ ...rawWallet(), program: { status: 'ACTIVE', monthlyIncludedCredits: 12000 } });
  expect(card(view(connected(), none, { w: ineligible }))).toContain('data-avatar-video-state="BLOCKED"');
});

it('lists videos with presenter, length, status and credits, hides the script of the pending request, and locks the form while unresolved', () => {
  const items = [video('SUCCEEDED'), video('UNDER_REVIEW', { videoId: id(981) }), video('FAILED', { videoId: id(982) })];
  const html = card(view(connected(), { state: 'READY', items }));
  expect(html).toContain('Presented by Master Kim'); expect(html).toContain('Portrait · 15s'); expect(html).toContain('750 credits');
  expect(html).toContain('Held for HQ review'); expect(html).toContain('750 credits held'); expect(html).toContain('Not created');
  expect(html).toContain('Video 1080×1920 · 15s · preview not available yet'); expect(html).not.toMatch(/<video|<img|https?:\/\//);
  const hidden = card(view(connected(), { state: 'READY', items: [video('GENERATING')] }, { hide: () => true }));
  expect(hidden).not.toContain('free trial class'); expect(hidden).toContain('data-prompt-hidden');
  expect(card(view(connected(), none, { outcome: { kind: 'UNKNOWN' } }))).toContain('Check again');
  expect(card(view(connected(), none, { locked: true }))).toMatch(/<textarea[^>]*disabled=""/);
  expect(card(view(connected(), none, { outcome: { kind: 'REFUSED', code: 'CREATIVE_AVATAR_NOT_READY' } }))).toContain('that avatar is not ready yet');
});

it('speaks Korean and Spanish, and shows nothing private while concealed', () => {
  const ko = card(view(connected(), { state: 'READY', items: [video()] }, { language: 'ko' }));
  expect(ko).toContain('말하는 아바타 동영상'); expect(ko).toContain('동영상 만들기'); expect(ko).toContain('진행: Master Kim');
  const es = card(view({ state: 'READY', provider: 'NOT_CONNECTED', items: [] }, none, { language: 'es' }));
  expect(es).toContain('Videos con avatar que habla'); expect(es).toContain('aún no están conectados');
  const hidden = renderToStaticMarkup(<CreativeStudioView language="en" waiting={false} concealed hasSchool studio={{ state: 'READY', wallet: wallet() }}
    avatars={connected()} videos={{ state: 'READY', items: [video()] }} videoOutcome={{ kind: 'UNKNOWN' }}/>);
  expect(hidden).not.toContain('free trial class'); expect(hidden).not.toMatch(/<textarea/); expect(hidden).not.toContain('Check again');
});
