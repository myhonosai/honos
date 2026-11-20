import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JourneyRecommendationsAccessError, JourneyRecommendationsRefusal, attemptFor, loadJourneyRecommendations, saveJourneyRecommendation, setJourneyRecommendationStatus,
} from '../src/components/journey-recommendations/http';
import { JourneyRecommendationsPanel, draftInput, whenText } from '../src/components/journey-recommendations/journey-recommendations-panel';

// 0603 journey recommendations staff panel: fixed same-origin calls, verified answers, and a form that only sends complete rules.
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const R = '44444444-4444-4444-8444-444444444444', K = '55555555-5555-4555-8555-555555555555', P = '66666666-6666-4666-8666-666666666666';
const scope = { organizationId: A, schoolId: B };
const rec = { recommendationId: R, curriculumId: C, program: 'Kids', triggerKind: 'RANK_REACHED', rankId: K, rank: 'Yellow', threshold: null, title: 'Try camp',
  message: 'Camp is fun.', targetKind: 'CHECKOUT', targetCheckoutId: P, targetEventId: null, targetLabel: 'Summer camp', targetLive: true, skipEnrolled: true,
  status: 'ON', version: 1, updatedAt: '2026-11-20T17:00:00.000Z' };
const read = { recommendations: [rec], programs: [{ curriculumId: C, name: 'Kids', ranks: [{ rankId: K, name: 'Yellow', order: 1 }] }],
  checkouts: [{ checkoutId: P, title: 'Summer camp' }], events: [] };
const input = { recommendationId: null, expectedVersion: null, curriculumId: C, triggerKind: 'RANK_REACHED' as const, rankId: K, threshold: null, title: 'Try camp',
  message: 'Camp is fun.', targetKind: 'CHECKOUT' as const, targetCheckoutId: P, targetEventId: null, skipEnrolled: true };
const draft = { recommendationId: null, expectedVersion: null, triggerKind: 'RANK_REACHED' as const, rankId: K, threshold: '', title: 'Try camp', message: 'Camp is fun.',
  targetKind: 'CHECKOUT' as const, targetId: P, skipEnrolled: true };
afterEach(() => vi.restoreAllMocks());

describe('journey recommendations http', () => {
  it('reads under the school scope with no other selector', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { data: read }));
    expect((await loadJourneyRecommendations(scope)).recommendations[0]!.title).toBe('Try camp');
    expect(fetcher.mock.calls[0]![0]).toBe(`/api/v1/organizations/${A}/schools/${B}/journey-recommendations`);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store' });
    fetcher.mockResolvedValue(json(200, { data: { ...read, families: [] } }));
    await expect(loadJourneyRecommendations(scope)).rejects.toThrow();
  });
  it('saves as a human command with a key, and refuses an answer for another recommendation', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(201, { data: { recommendation: rec } }))
      .mockResolvedValueOnce(json(201, { data: { recommendation: { ...rec, title: 'Other' } } }));
    expect((await saveJourneyRecommendation(scope, input, 'key-1')).recommendation.recommendationId).toBe(R);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`/api/v1/organizations/${A}/schools/${B}/journey-recommendations`);
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify(input) });
    expect((init as RequestInit).headers).toMatchObject({ 'X-HON-Human-Command': 'journey_recommendations.save', 'Idempotency-Key': 'key-1' });
    await expect(saveJourneyRecommendation(scope, input, 'key-2')).rejects.toThrow();
  });
  it('refuses an incomplete rule before any call', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await expect(saveJourneyRecommendation(scope, { ...input, rankId: null }, 'k')).rejects.toThrow();
    await expect(saveJourneyRecommendation(scope, { ...input, title: 'a\nb' }, 'k')).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('changes status at the version it saw and checks the answer', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(200, { data: { recommendation: { ...rec, status: 'OFF', version: 2 } } }))
      .mockResolvedValueOnce(json(200, { data: { recommendation: rec } }));
    expect((await setJourneyRecommendationStatus(scope, R, 1, 'OFF', 'k')).recommendation.status).toBe('OFF');
    expect(fetcher.mock.calls[0]![0]).toBe(`/api/v1/organizations/${A}/schools/${B}/journey-recommendations/${R}/status`);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ body: JSON.stringify({ expectedVersion: 1, status: 'OFF' }) });
    expect((fetcher.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ 'X-HON-Human-Command': 'journey_recommendations.status' });
    await expect(setJourneyRecommendationStatus(scope, R, 1, 'OFF', 'k')).rejects.toThrow();
  });
  it('tells definite refusals from unknown outcomes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(422, { code: 'JOURNEY_RECOMMENDATIONS_LIMIT' })).mockResolvedValueOnce(json(503, { code: 'JOURNEY_RECOMMENDATIONS_UNAVAILABLE' }))
      .mockResolvedValueOnce(json(403, { code: 'JOURNEY_RECOMMENDATIONS_FORBIDDEN' }));
    await expect(saveJourneyRecommendation(scope, input, 'k')).rejects.toBeInstanceOf(JourneyRecommendationsRefusal);
    const unknown = saveJourneyRecommendation(scope, input, 'k');
    await expect(unknown).rejects.toThrow(/may or may not/);
    await expect(loadJourneyRecommendations(scope)).rejects.toBeInstanceOf(JourneyRecommendationsAccessError);
  });
  it('reuses the key only for the same command', () => {
    const first = attemptFor('a', null, () => 'k1');
    expect(attemptFor('a', first, () => 'k2').key).toBe('k1');
    expect(attemptFor('b', first, () => 'k2').key).toBe('k2');
  });
});

describe('journey recommendations panel', () => {
  it('builds a save only from a complete rule', () => {
    expect(draftInput(C, draft)).toEqual(input);
    expect(draftInput(C, { ...draft, rankId: '' })).toBeNull();
    expect(draftInput(C, { ...draft, targetId: '' })).toBeNull();
    expect(draftInput(C, { ...draft, title: '' })).toBeNull();
    expect(draftInput(C, { ...draft, triggerKind: 'CLASSES_ATTENDED', threshold: '0' })).toBeNull();
    expect(draftInput(C, { ...draft, triggerKind: 'CLASSES_ATTENDED', threshold: '10', targetKind: 'PRO_SHOP', targetId: '' }))
      .toMatchObject({ rankId: null, threshold: 10, targetCheckoutId: null, targetEventId: null, skipEnrolled: false });
    expect(draftInput(C, { ...draft, triggerKind: 'REQUIREMENTS_MET', threshold: '101' })).toBeNull();
  });
  it('says each rule in plain words', () => {
    expect(whenText({ triggerKind: 'RANK_REACHED', rank: 'Yellow', threshold: null })).toBe('Reaches Yellow');
    expect(whenText({ triggerKind: 'TEST_BOOKED', rank: 'Yellow', threshold: null })).toBe('Booked for the Yellow test');
    expect(whenText({ triggerKind: 'REQUIREMENTS_MET', rank: 'Yellow', threshold: 1 })).toBe('1 requirement met on Yellow');
    expect(whenText({ triggerKind: 'CLASSES_ATTENDED', rank: null, threshold: 10 })).toBe('After 10 classes attended');
  });
  it('starts loading with no school id on screen and no message sent', () => {
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise(() => undefined));
    const html = renderToStaticMarkup(<JourneyRecommendationsPanel organizationId={A} schoolId={B} curriculum={{ id: C, name: 'Kids', ranks: [{ id: K, name: 'Yellow' }] }} />);
    expect(html).toContain('Recommendations');
    expect(html).toContain('Nothing is texted, emailed or charged.');
    expect(html).not.toContain(B);
  });
});
