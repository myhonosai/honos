import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CreativeGeneration, CreativeReviewQueueItem } from '@hon/contracts';
import { CreativeMediaError, deleteCreativeAsset, listCreativeReviewQueue, reviewCreativeAsset, viewCreativeAsset } from '../src/components/creative-studio/media-http';
import { CreativeMediaView, storedAssets, type CreativeMediaViewProps } from '../src/components/creative-studio/media';
import { outcomeFromAttempt } from '../src/components/creative-studio/creative-studio';
import { CreativeGenerationError } from '../src/components/creative-studio/generation-http';
import { outcomeText } from '../src/components/creative-studio/create';
import { id, reply, scope } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const T = '2026-11-15T07:00:00.000Z';
const signal = () => new AbortController().signal;
const asset = (n: number, review: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED', origin: 'PROVIDER' | 'SYNTHETIC' = 'PROVIDER') =>
  ({ assetId: id(700 + n), ordinal: n, mediaType: 'image/png' as const, width: 1080, height: 1350, durationSeconds: null, origin, review });
const generation = (assets: ReturnType<typeof asset>[], status: CreativeGeneration['status'] = 'SUCCEEDED'): CreativeGeneration => ({ generationId: id(600 + assets.length),
  schoolId: scope.schoolId, operationCode: 'image.generate', mediaKind: 'IMAGE', units: assets.length || 1, format: 'PORTRAIT', prompt: 'Adult kickboxing poster', status,
  failureReason: null, reservedCredits: 10, chargedCredits: status === 'SUCCEEDED' ? 10 : null, createdAt: T, completedAt: status === 'GENERATING' ? null : T, assets });
const item = (n: number, patch: Partial<CreativeReviewQueueItem> = {}): CreativeReviewQueueItem => ({ assetId: id(700 + n), generationId: id(600), ordinal: 1, mediaType: 'image/png',
  width: 1080, height: 1350, durationSeconds: null, storedAt: T, requestedBySelf: false, ...patch });
const props = (patch: Partial<CreativeMediaViewProps> = {}): CreativeMediaViewProps => ({ language: 'en', generations: [], queue: { state: 'HIDDEN' }, preview: null, busy: null,
  confirm: null, note: null, onView: () => {}, onDelete: () => {}, onReview: () => {}, onConfirm: () => {}, ...patch });
const html = (patch: Partial<CreativeMediaViewProps> = {}) => renderToStaticMarkup(<CreativeMediaView {...props(patch)}/>);

it('lists only stored provider files of finished generations, with their approval status', () => {
  const gens = [generation([asset(1, 'PENDING_REVIEW'), asset(2, 'APPROVED')]), generation([asset(3, 'REJECTED', 'SYNTHETIC')]), generation([], 'GENERATING')];
  expect(storedAssets(gens).map(s => s.asset.assetId)).toEqual([id(701), id(702)]);
  const out = html({ generations: gens });
  expect(out).toContain('Your images and videos'); expect(out).toContain('Waiting for approval'); expect(out).toContain('Approved');
  expect(out.match(/data-testid="creative-media-item"/g)).toHaveLength(2);
  expect(out).toContain('only the person who made it and your social media managers can see it');
  expect(out).not.toContain('Waiting for your approval'); // not a reviewer: no queue card
  expect(html()).toContain('No finished images or videos yet.');
});

it('shows reviewers the queue with Approve and a two-step Reject, and the preview with its 5-minute note', () => {
  const out = html({ queue: { state: 'READY', items: [item(1, { requestedBySelf: true }), item(2, { mediaType: 'video/mp4', durationSeconds: 8 })] } });
  expect(out).toContain('Waiting for your approval'); expect(out).toContain('You made this'); expect(out).toContain('Video 1080×1350 · 8s');
  expect(out.match(/>Approve</g)).toHaveLength(2); expect(out.match(/>Reject</g)).toHaveLength(2);
  const confirming = html({ queue: { state: 'READY', items: [item(1)] }, confirm: { assetId: id(701), action: 'REJECT' } });
  expect(confirming).toContain('Yes, reject it'); expect(confirming).toContain('Cancel');
  expect(html({ queue: { state: 'READY', items: [] } })).toContain('Nothing is waiting for approval.');
  expect(html({ queue: { state: 'UNAVAILABLE' } })).toContain('The approval list could not be loaded.');
  const shown = html({ generations: [generation([asset(1, 'PENDING_REVIEW')])], preview: { assetId: id(701), url: 'https://project.supabase.co/storage/v1/object/sign/x', mediaType: 'image/png' } });
  expect(shown).toContain('<img src="https://project.supabase.co/storage/v1/object/sign/x"'); expect(shown).toMatch(/referrerpolicy="no-referrer"/i);
  expect(shown).toContain('works for 5 minutes'); expect(shown).toContain('>Hide<');
  const deleting = html({ generations: [generation([asset(1, 'APPROVED')])], confirm: { assetId: id(701), action: 'DELETE' } });
  expect(deleting).toContain('Yes, delete it');
  for (const [language, text] of [['ko', '승인 대기'], ['es', 'Esperando aprobación']] as const) expect(html({ language, generations: [generation([asset(1, 'PENDING_REVIEW')])] })).toContain(text);
});

it('view, delete and review send fixed same-origin requests with their command headers; drifted answers are UNKNOWN', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply({ assetId: id(701), mediaType: 'image/png', url: 'https://project.supabase.co/x', expiresAt: T }));
  await expect(viewCreativeAsset(scope.schoolId, id(701), signal())).resolves.toMatchObject({ url: 'https://project.supabase.co/x' });
  expect(f.mock.calls[0]![0]).toBe(`/api/v1/schools/${scope.schoolId}/creative-studio/assets/${id(701)}/view`);
  expect(f.mock.calls[0]![1]).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
  f.mockResolvedValue(reply({ assetId: id(702), mediaType: 'image/png', url: 'https://project.supabase.co/x', expiresAt: T }));
  await expect(viewCreativeAsset(scope.schoolId, id(701), signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
  f.mockResolvedValue(reply({ assetId: id(701), mediaType: 'image/png', url: 'http://plain.example/x', expiresAt: T }));
  await expect(viewCreativeAsset(scope.schoolId, id(701), signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });

  f.mockResolvedValue(reply({ assetId: id(701), deletedAt: T, fileRemoved: true }));
  await expect(deleteCreativeAsset(scope.schoolId, id(701), signal())).resolves.toMatchObject({ fileRemoved: true });
  const del = f.mock.calls.at(-1)! as unknown as [string, RequestInit];
  expect(del[0]).toBe(`/api/v1/schools/${scope.schoolId}/creative-studio/assets/${id(701)}/delete`);
  expect(del[1]).toMatchObject({ method: 'POST', body: '{}' }); expect(del[1].headers).toMatchObject({ 'X-HON-Human-Command': 'saas-creative-asset-delete' });

  f.mockResolvedValue(reply({ assetId: id(701), review: 'APPROVED', reviewedAt: T, reviewedBySelf: true }));
  await expect(reviewCreativeAsset(scope.schoolId, id(701), 'APPROVED', signal())).resolves.toMatchObject({ review: 'APPROVED' });
  const rev = f.mock.calls.at(-1)! as unknown as [string, RequestInit];
  expect(rev[0]).toBe(`/api/v1/schools/${scope.schoolId}/creative-studio/assets/${id(701)}/review`);
  expect(JSON.parse(String(rev[1].body))).toEqual({ decision: 'APPROVED' }); expect(rev[1].headers).toMatchObject({ 'X-HON-Human-Command': 'saas-creative-asset-review' });
  f.mockResolvedValue(reply({ assetId: id(701), review: 'REJECTED', reviewedAt: T, reviewedBySelf: true }));
  await expect(reviewCreativeAsset(scope.schoolId, id(701), 'APPROVED', signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });

  f.mockResolvedValue(reply({ limit: 50, assets: [item(1)] }));
  await expect(listCreativeReviewQueue(scope.schoolId, signal())).resolves.toMatchObject({ assets: [{ assetId: id(701) }] });
  expect(f.mock.calls.at(-1)![0]).toBe(`/api/v1/schools/${scope.schoolId}/creative-studio/assets/review-queue`);
});

it('maps refusals: not a reviewer, gone, storage not connected, rejection final', async () => {
  const f = vi.spyOn(globalThis, 'fetch');
  const err = (status: number, code: string) => Response.json({ code }, { status });
  for (const [status, code, kind] of [[403, 'SAAS_FORBIDDEN', 'DENIED'], [404, 'SAAS_UNAVAILABLE', 'GONE'], [503, 'CREATIVE_STORAGE_NOT_CONNECTED', 'STORAGE_OFF'],
    [409, 'SAAS_TRANSITION_NOT_ALLOWED', 'NOT_ALLOWED'], [503, 'SAAS_UNAVAILABLE', 'UNKNOWN'], [500, 'X', 'UNKNOWN']] as const) {
    f.mockResolvedValueOnce(err(status, code));
    await expect(reviewCreativeAsset(scope.schoolId, id(701), 'APPROVED', signal())).rejects.toMatchObject({ kind });
  }
  f.mockRejectedValueOnce(new TypeError('network'));
  await expect(viewCreativeAsset(scope.schoolId, id(701), signal())).rejects.toBeInstanceOf(CreativeMediaError);
});

it('a prompt the free check refuses says how to fix it; nothing was charged', () => {
  const refused = outcomeFromAttempt(new CreativeGenerationError('INVALID', 'CREATIVE_PROMPT_NOT_ALLOWED'), false);
  expect(refused).toEqual({ outcome: { kind: 'PROMPT_REFUSED' }, release: true });
  expect(outcomeText('en', refused.outcome)?.text).toContain('Nothing was charged');
  expect(outcomeText('ko', refused.outcome)?.text).toContain('청구된 것은 없습니다');
  // After an unknown attempt, a refusal of the retry says nothing about the first send.
  expect(outcomeFromAttempt(new CreativeGenerationError('INVALID', 'CREATIVE_PROMPT_NOT_ALLOWED'), true).outcome).toMatchObject({ kind: 'RETRY_BLOCKED' });
});
