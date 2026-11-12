import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CreativeAvatar, CreativeAvatarInput, CreativeGeneration } from '@hon/contracts';
import { CreativeGenerationError, createCreativeAvatar, listCreativeAvatars, prepareCreativeAvatar } from '../src/components/creative-studio/generation-http';
import { matchesPendingAvatar, matchesPendingAvatarGeneration, outcomeFromAvatarReceipt } from '../src/components/creative-studio/creative-studio';
import { studioWallet, type AvatarsState, type CreateOutcome } from '../src/components/creative-studio/model';
import { CreativeStudioView } from '../src/components/creative-studio/view';
import { id, rawWallet, reply, scope } from './account-status-fixtures';

// A1 Creative Studio avatars (0276): one avatar = one avatar.create generation at the HQ rate.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const input: CreativeAvatarInput = { name: 'Master Kim', style: 'REALISTIC', description: 'Friendly taekwondo master in a black dobok' };
const key = id(950);
const STATUS = { GENERATING: 'CREATING', SUCCEEDED: 'READY', UNDER_REVIEW: 'UNDER_REVIEW', FAILED: 'NOT_CREATED', RESOLVED_CHARGED: 'NOT_CREATED', RESOLVED_NOT_CHARGED: 'NOT_CREATED' } as const;
function generation(status: CreativeGeneration['status'], extra: Partial<CreativeGeneration> = {}): CreativeGeneration {
  const done = status !== 'GENERATING', charged = status === 'SUCCEEDED' || status === 'RESOLVED_CHARGED';
  return { generationId: id(960), schoolId: scope.schoolId, operationCode: 'avatar.create', mediaKind: 'IMAGE', units: 1, format: 'PORTRAIT', prompt: input.description,
    status, failureReason: status === 'FAILED' ? 'PROVIDER_REJECTED' : status === 'UNDER_REVIEW' ? 'PROVIDER_UNKNOWN' : null, reservedCredits: 100,
    chargedCredits: charged ? 100 : null, createdAt: '2026-11-12T06:00:00.000Z', completedAt: done ? '2026-11-12T06:00:05.000Z' : null,
    assets: status === 'SUCCEEDED' ? [{ assetId: id(961), ordinal: 1, mediaType: 'image/png', width: 1080, height: 1920, durationSeconds: null, origin: 'SYNTHETIC' }] : [], ...extra };
}
function avatar(status: CreativeGeneration['status'] = 'SUCCEEDED', extra: Partial<CreativeAvatar> = {}, g: Partial<CreativeGeneration> = {}): CreativeAvatar {
  const gen = generation(status, g);
  return { avatarId: id(970), schoolId: scope.schoolId, ...input, status: STATUS[status], createdAt: gen.createdAt, generation: gen, ...extra };
}
const receipt = (a = avatar()) => ({ avatar: a, balance: rawWallet().balance, replayed: false });
const signal = () => new AbortController().signal;

it('lists avatars with a fixed same-origin GET and refuses avatars of another school', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply({ provider: 'NOT_CONNECTED', avatars: [avatar()], limit: 50 }));
  const list = await listCreativeAvatars(scope.schoolId, signal());
  expect(list.avatars).toHaveLength(1);
  const [path, init] = f.mock.calls[0]!;
  expect(path).toBe(`/api/v1/schools/${scope.schoolId}/creative-studio/avatars`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
  const other = avatar('SUCCEEDED', { schoolId: id(9) }, { schoolId: id(9) });
  f.mockResolvedValue(reply({ provider: 'CONNECTED', avatars: [other], limit: 50 }));
  await expect(listCreativeAvatars(scope.schoolId, signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
  f.mockResolvedValue(reply({}, 403));
  await expect(listCreativeAvatars(scope.schoolId, signal())).rejects.toMatchObject({ kind: 'DENIED' });
});

it('creates with exactly the closed request, the avatar command header and the key; bad input is never sent', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(receipt()));
  expect((await createCreativeAvatar(scope.schoolId, input, key, signal())).avatar.status).toBe('READY');
  const [path, init] = f.mock.calls[0]!;
  expect(path).toBe(`/api/v1/schools/${scope.schoolId}/creative-studio/avatars`);
  expect((init as RequestInit).headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'saas-creative-avatar-create', 'Idempotency-Key': key });
  expect(JSON.parse(String((init as RequestInit).body))).toEqual(input);
  f.mockClear();
  for (const bad of [{ ...input, name: '' }, { ...input, name: 'x'.repeat(41) }, { ...input, style: 'ANIME' }, { ...input, description: '' }, { ...input, operationCode: 'avatar.create' }]) {
    expect(() => prepareCreativeAvatar(bad as CreativeAvatarInput)).toThrow(CreativeGenerationError);
    await expect(createCreativeAvatar(scope.schoolId, bad as CreativeAvatarInput, key, signal())).rejects.toMatchObject({ kind: 'INVALID' });
  }
  expect(f).not.toHaveBeenCalled();
});

it('separates definitive avatar refusals from unknown outcomes', async () => {
  const f = vi.spyOn(globalThis, 'fetch');
  const cases: [number, string | null, string][] = [[503, 'CREATIVE_PROVIDER_NOT_CONNECTED', 'NOT_CONNECTED'], [422, 'SAAS_OPERATION_NOT_PRICED', 'REFUSED'],
    [422, 'CREATIVE_AVATAR_LIMIT_REACHED', 'REFUSED'], [422, 'CREATIVE_AVATAR_RATE_INVALID', 'REFUSED'], [422, 'SAAS_CREATIVE_AI_PAUSED_BY_HQ', 'REFUSED'],
    [422, 'CREATIVE_TOO_MANY_IN_PROGRESS', 'REFUSED'], [422, 'SAAS_CREATIVE_LEDGER_MISMATCH', 'UNKNOWN'], [409, 'IDEMPOTENCY_KEY_REUSED', 'INVALID'],
    [409, 'SAAS_TRANSITION_NOT_ALLOWED', 'UNKNOWN'], [400, 'INVALID_SAAS_INPUT', 'INVALID'], [403, 'SAAS_FORBIDDEN', 'DENIED'], [500, null, 'UNKNOWN']];
  for (const [status, code, kind] of cases) {
    f.mockResolvedValueOnce(Response.json(code ? { code } : {}, { status }));
    await expect(createCreativeAvatar(scope.schoolId, input, key, signal()), `${status} ${code}`).rejects.toMatchObject({ kind, code });
  }
  f.mockRejectedValueOnce(new TypeError('network'));
  await expect(createCreativeAvatar(scope.schoolId, input, key, signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
  // A receipt that does not echo this request is not trusted as its outcome.
  f.mockResolvedValueOnce(reply(receipt(avatar('SUCCEEDED', { name: 'Someone else' }))));
  await expect(createCreativeAvatar(scope.schoolId, input, key, signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
});

it('maps the avatar outcome from its creation generation and matches only the pending request', () => {
  expect(outcomeFromAvatarReceipt(receipt(avatar('SUCCEEDED')))).toEqual({ kind: 'DONE' });
  expect(outcomeFromAvatarReceipt(receipt(avatar('UNDER_REVIEW')))).toEqual({ kind: 'HELD' });
  expect(outcomeFromAvatarReceipt(receipt(avatar('FAILED')))).toEqual({ kind: 'FAILED' });
  expect(outcomeFromAvatarReceipt(receipt(avatar('GENERATING')))).toEqual({ kind: 'UNKNOWN' });
  expect(matchesPendingAvatar({ input }, avatar('GENERATING'))).toBe(true);
  expect(matchesPendingAvatar({ input }, avatar('GENERATING', { name: 'Other' }))).toBe(false);
  expect(matchesPendingAvatar(null, avatar('GENERATING'))).toBe(false);
  expect(matchesPendingAvatarGeneration({ input }, generation('GENERATING'))).toBe(true);
  expect(matchesPendingAvatarGeneration({ input }, generation('GENERATING', { operationCode: 'image.standard' }))).toBe(false);
});

function wallet(withAvatarRate = true, available = 500) {
  const raw = rawWallet();
  return studioWallet({ ...raw, walletVersion: 2, program: { ...raw.program, status: 'ACTIVE' }, eligibility: { eligible: true, reason: null, window: null },
    balance: { availableCredits: available, heldCredits: 0, byKind: raw.balance.byKind.map(k => k.kind === 'INCLUDED_MONTHLY' ? { ...k, grantedCredits: available, availableCredits: available } : k) },
    rates: { rateVersionId: id(40), rateVersion: 1, termsReference: 'terms', publishedAt: '2026-11-01T00:00:00.000Z', rates: [
      { operationCode: 'image.standard', mediaKind: 'IMAGE', displayName: 'Standard image', billingUnit: 'IMAGE', creditsPerUnit: 40, maxUnitsPerRequest: 4, rateBasis: 'PROVISIONAL' },
      ...(withAvatarRate ? [{ operationCode: 'avatar.create', mediaKind: 'IMAGE' as const, displayName: 'AI avatar', billingUnit: 'REQUEST' as const, creditsPerUnit: 100, maxUnitsPerRequest: 1, rateBasis: 'PROVISIONAL' as const }] : [])] } });
}
const view = (avatars: AvatarsState, extra: { outcome?: CreateOutcome; language?: string; w?: ReturnType<typeof wallet>; locked?: boolean; hide?: (a: CreativeAvatar) => boolean } = {}) => renderToStaticMarkup(
  <CreativeStudioView language={extra.language ?? 'en'} waiting={false} concealed={false} hasSchool studio={{ state: 'READY', wallet: extra.w ?? wallet() }}
    generations={{ state: 'READY', provider: 'CONNECTED', items: [] }} avatars={avatars} avatarOutcome={extra.outcome ?? null} avatarLocked={extra.locked}
    hideAvatarText={extra.hide} onCreateAvatar={() => {}} onCheckAvatarAgain={() => {}}/>);
const card = (html: string) => html.slice(html.indexOf('creative-avatars-title') - 60, html.indexOf('creative-credits-title'));

it('offers the avatar form only when connected, eligible and priced by HQ; the generic form never offers avatar.*', () => {
  const off = card(view({ state: 'READY', provider: 'NOT_CONNECTED', items: [] }));
  expect(off).toContain('data-avatar-state="NOT_CONNECTED"'); expect(off).toContain('Avatar creation is not connected yet'); expect(off).not.toMatch(/<textarea|<input/);
  const unpriced = card(view({ state: 'READY', provider: 'CONNECTED', items: [] }, { w: wallet(false) }));
  expect(unpriced).toContain('data-avatar-state="NOT_PRICED"'); expect(unpriced).toContain('HQ has not set their price'); expect(unpriced).not.toMatch(/<textarea/);
  const html = view({ state: 'READY', provider: 'CONNECTED', items: [] });
  const open = card(html);
  expect(open).toContain('data-avatar-state="OPEN"'); expect(open).toMatch(/<textarea/); expect(open).toContain('Uses 100 credits. You have 500 available.');
  for (const label of ['Realistic', 'Illustrated', 'Cute (chibi)']) expect(open).toContain(label);
  expect(open).toMatch(/<button type="submit" disabled="">Create avatar<\/button>/);
  const generic = html.slice(html.indexOf('creative-create-title'), html.indexOf('creative-avatars-title'));
  expect(generic).toContain('Standard image'); expect(generic).not.toContain('AI avatar');
  expect(card(view({ state: 'READY', provider: 'CONNECTED', items: [] }, { w: wallet(true, 50) }))).toContain('Not enough credits');
  const ineligible = studioWallet({ ...rawWallet(), program: { status: 'ACTIVE', monthlyIncludedCredits: 12000 } });
  expect(card(view({ state: 'READY', provider: 'CONNECTED', items: [] }, { w: ineligible }))).toContain('data-avatar-state="BLOCKED"');
});

it('lists avatars with status and credits, hides the text of the pending request, and locks the form while unresolved', () => {
  const items = [avatar('SUCCEEDED'), avatar('UNDER_REVIEW', { avatarId: id(971), name: 'Coach Lee', style: 'CHIBI' }), avatar('FAILED', { avatarId: id(972), name: 'Failed one' })];
  const html = card(view({ state: 'READY', provider: 'CONNECTED', items }));
  expect(html).toContain('Master Kim'); expect(html).toContain('Ready'); expect(html).toContain('100 credits');
  expect(html).toContain('Coach Lee'); expect(html).toContain('Held for HQ review'); expect(html).toContain('100 credits held');
  expect(html).toContain('Not created'); expect(html).toContain('2 of 12 avatars');
  expect(html).toContain('Image 1080×1920 · preview not available yet'); expect(html).not.toMatch(/<img|https?:\/\//);
  const hidden = card(view({ state: 'READY', provider: 'CONNECTED', items: [avatar('GENERATING')] }, { hide: () => true }));
  expect(hidden).not.toContain('Master Kim'); expect(hidden).not.toContain('black dobok'); expect(hidden).toContain('data-prompt-hidden');
  expect(card(view({ state: 'READY', provider: 'CONNECTED', items: [] }, { outcome: { kind: 'UNKNOWN' } }))).toContain('Check again');
  expect(card(view({ state: 'READY', provider: 'CONNECTED', items: [] }, { locked: true }))).toMatch(/<textarea[^>]*disabled=""/);
  expect(card(view({ state: 'READY', provider: 'CONNECTED', items: [] }, { outcome: { kind: 'REFUSED', code: 'CREATIVE_AVATAR_LIMIT_REACHED' } }))).toContain('already has 12 avatars');
  const full = Array.from({ length: 12 }, (_, i) => avatar('SUCCEEDED', { avatarId: id(1000 + i), name: `Avatar ${i + 1}` }));
  expect(card(view({ state: 'READY', provider: 'CONNECTED', items: full }))).toMatch(/<textarea[^>]*disabled=""/);
});

it('speaks Korean and Spanish, and shows nothing private while concealed', () => {
  const ko = card(view({ state: 'READY', provider: 'CONNECTED', items: [avatar()] }, { language: 'ko' }));
  expect(ko).toContain('아바타 만들기'); expect(ko).toContain('실사'); expect(ko).toContain('사용 가능');
  const es = card(view({ state: 'READY', provider: 'NOT_CONNECTED', items: [] }, { language: 'es' }));
  expect(es).toContain('Avatares'); expect(es).toContain('La creación de avatares aún no está conectada');
  const hidden = renderToStaticMarkup(<CreativeStudioView language="en" waiting={false} concealed hasSchool studio={{ state: 'READY', wallet: wallet() }}
    avatars={{ state: 'READY', provider: 'CONNECTED', items: [avatar()] }} avatarOutcome={{ kind: 'UNKNOWN' }}/>);
  expect(hidden).not.toContain('Master Kim'); expect(hidden).not.toMatch(/<textarea/); expect(hidden).not.toContain('Check again');
});
