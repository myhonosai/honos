import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CreativeWebsiteDraft, CreativeWebsiteDraftInput } from '@hon/contracts';
import { CreativeGenerationError, createCreativeWebsiteDraft, listCreativeWebsiteDrafts, prepareCreativeWebsiteDraft,
  readCreativeWebsiteDraft } from '../src/components/creative-studio/generation-http';
import { matchesPendingWebsite, outcomeFromWebsiteReceipt } from '../src/components/creative-studio/creative-studio';
import { studioWallet, type CreateOutcome, type OpenDraft, type WebsitesState } from '../src/components/creative-studio/model';
import { CreativeStudioView } from '../src/components/creative-studio/view';
import { id, rawWallet, reply, scope } from './account-status-fixtures';

// WB1 website drafts (0344): pages × the HQ WEBSITE rate from the school's creative credits; text only, never published.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const input: CreativeWebsiteDraftInput = { operationCode: 'website.page', pages: ['HOME', 'FREE_TRIAL'], brief: 'Family taekwondo school with kids and adult classes' };
const key = id(1950);
function draft(status: CreativeWebsiteDraft['status'] = 'SUCCEEDED', extra: Partial<CreativeWebsiteDraft> = {}): CreativeWebsiteDraft {
  const done = status !== 'GENERATING', charged = status === 'SUCCEEDED' || status === 'RESOLVED_CHARGED';
  return { draftId: id(1960), schoolId: scope.schoolId, ...input, status, failureReason: status === 'FAILED' ? 'PROVIDER_REJECTED' : status === 'UNDER_REVIEW' ? 'PROVIDER_UNKNOWN' : null,
    reservedCredits: 60, chargedCredits: charged ? 60 : null, createdAt: '2026-11-13T06:00:00.000Z', completedAt: done ? '2026-11-13T06:00:05.000Z' : null, content: null, ...extra };
}
const content = (): CreativeWebsiteDraft['content'] => [
  { pageKey: 'HOME', title: 'Welcome to our dojang', sections: [{ heading: 'Classes for every age', body: 'Kids and adults train together.' }], origin: 'SYNTHETIC' },
  { pageKey: 'FREE_TRIAL', title: 'Try a free class', sections: [{ heading: 'Book a trial', body: 'Pick a time that suits you.' }], origin: 'SYNTHETIC' }];
const receipt = (d = draft()) => ({ draft: d, balance: rawWallet().balance, replayed: false });
const signal = () => new AbortController().signal;
const path = `/api/v1/schools/${scope.schoolId}/creative-studio/website-drafts`;

it('lists and reads drafts with fixed same-origin GETs and refuses drafts of another school', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply({ provider: 'CONNECTED', drafts: [draft()], limit: 50 }));
  expect((await listCreativeWebsiteDrafts(scope.schoolId, signal())).drafts).toHaveLength(1);
  expect(f.mock.calls[0]![0]).toBe(path);
  expect(f.mock.calls[0]![1]).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
  f.mockResolvedValue(reply({ provider: 'CONNECTED', drafts: [draft('SUCCEEDED', { schoolId: id(9) })], limit: 50 }));
  await expect(listCreativeWebsiteDrafts(scope.schoolId, signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
  // A list never carries page text.
  f.mockResolvedValue(reply({ provider: 'CONNECTED', drafts: [draft('SUCCEEDED', { content: content() })], limit: 50 }));
  await expect(listCreativeWebsiteDrafts(scope.schoolId, signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
  f.mockResolvedValue(reply({}, 403));
  await expect(listCreativeWebsiteDrafts(scope.schoolId, signal())).rejects.toMatchObject({ kind: 'DENIED' });

  f.mockResolvedValue(reply(draft('SUCCEEDED', { content: content() })));
  expect((await readCreativeWebsiteDraft(scope.schoolId, id(1960), signal())).content).toHaveLength(2);
  expect(f.mock.calls.at(-1)![0]).toBe(`${path}/${id(1960)}`);
  // An answer for another draft is not trusted.
  f.mockResolvedValue(reply(draft('SUCCEEDED', { draftId: id(1961), content: content() })));
  await expect(readCreativeWebsiteDraft(scope.schoolId, id(1960), signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
});

it('creates with exactly the closed request, the website command header and the key; bad input is never sent', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(receipt()));
  expect((await createCreativeWebsiteDraft(scope.schoolId, input, key, signal())).draft.status).toBe('SUCCEEDED');
  const [p, init] = f.mock.calls[0]!;
  expect(p).toBe(path);
  expect((init as RequestInit).headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'saas-creative-website-draft-create', 'Idempotency-Key': key });
  expect(JSON.parse(String((init as RequestInit).body))).toEqual(input);
  f.mockClear();
  for (const bad of [{ ...input, pages: [] }, { ...input, pages: ['FREE_TRIAL', 'HOME'] }, { ...input, pages: ['HOME', 'HOME'] }, { ...input, pages: ['BLOG'] },
    { ...input, brief: '' }, { ...input, schoolId: scope.schoolId }, { ...input, operationCode: 'X' }]) {
    expect(() => prepareCreativeWebsiteDraft(bad as CreativeWebsiteDraftInput)).toThrow(CreativeGenerationError);
    await expect(createCreativeWebsiteDraft(scope.schoolId, bad as CreativeWebsiteDraftInput, key, signal())).rejects.toMatchObject({ kind: 'INVALID' });
  }
  expect(f).not.toHaveBeenCalled();
});

it('separates definitive website refusals from unknown outcomes', async () => {
  const f = vi.spyOn(globalThis, 'fetch');
  const cases: [number, string | null, string][] = [[503, 'CREATIVE_PROVIDER_NOT_CONNECTED', 'NOT_CONNECTED'], [422, 'SAAS_OPERATION_NOT_PRICED', 'REFUSED'],
    [422, 'CREATIVE_WEBSITE_RATE_INVALID', 'REFUSED'], [422, 'SAAS_CREATIVE_AI_PAUSED_BY_HQ', 'REFUSED'], [422, 'CREATIVE_TOO_MANY_IN_PROGRESS', 'REFUSED'],
    [422, 'SAAS_CREATIVE_LEDGER_MISMATCH', 'UNKNOWN'], [409, 'IDEMPOTENCY_KEY_REUSED', 'INVALID'], [409, 'SAAS_TRANSITION_NOT_ALLOWED', 'UNKNOWN'],
    [400, 'INVALID_SAAS_INPUT', 'INVALID'], [403, 'SAAS_FORBIDDEN', 'DENIED'], [500, null, 'UNKNOWN']];
  for (const [status, code, kind] of cases) {
    f.mockResolvedValueOnce(Response.json(code ? { code } : {}, { status }));
    await expect(createCreativeWebsiteDraft(scope.schoolId, input, key, signal()), `${status} ${code}`).rejects.toMatchObject({ kind, code });
  }
  f.mockRejectedValueOnce(new TypeError('network'));
  await expect(createCreativeWebsiteDraft(scope.schoolId, input, key, signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
  // A receipt that does not echo this request (other pages) is not trusted as its outcome.
  f.mockResolvedValueOnce(reply(receipt(draft('SUCCEEDED', { pages: ['HOME'] }))));
  await expect(createCreativeWebsiteDraft(scope.schoolId, input, key, signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
});

it('maps the draft outcome and matches only the pending request', () => {
  expect(outcomeFromWebsiteReceipt(receipt(draft('SUCCEEDED')))).toEqual({ kind: 'DONE' });
  expect(outcomeFromWebsiteReceipt(receipt(draft('UNDER_REVIEW')))).toEqual({ kind: 'HELD' });
  expect(outcomeFromWebsiteReceipt(receipt(draft('FAILED')))).toEqual({ kind: 'FAILED' });
  expect(outcomeFromWebsiteReceipt(receipt(draft('GENERATING')))).toEqual({ kind: 'UNKNOWN' });
  expect(matchesPendingWebsite({ input }, draft('GENERATING'))).toBe(true);
  expect(matchesPendingWebsite({ input }, draft('GENERATING', { pages: ['HOME'] }))).toBe(false);
  expect(matchesPendingWebsite(null, draft('GENERATING'))).toBe(false);
});

function wallet(withWebsiteRate = true, available = 500) {
  const raw = rawWallet();
  return studioWallet({ ...raw, walletVersion: 2, program: { ...raw.program, status: 'ACTIVE' }, eligibility: { eligible: true, reason: null, window: null },
    balance: { availableCredits: available, heldCredits: 0, byKind: raw.balance.byKind.map(k => k.kind === 'INCLUDED_MONTHLY' ? { ...k, grantedCredits: available, availableCredits: available } : k) },
    rates: { rateVersionId: id(40), rateVersion: 1, termsReference: 'terms', publishedAt: '2026-11-01T00:00:00.000Z', rates: [
      { operationCode: 'image.standard', mediaKind: 'IMAGE', displayName: 'Standard image', billingUnit: 'IMAGE', creditsPerUnit: 40, maxUnitsPerRequest: 4, rateBasis: 'PROVISIONAL' },
      ...(withWebsiteRate ? [{ operationCode: 'website.page', mediaKind: 'WEBSITE' as const, displayName: 'Website page', billingUnit: 'PAGE' as const, creditsPerUnit: 30, maxUnitsPerRequest: 8, rateBasis: 'PROVISIONAL' as const }] : [])] } });
}
const view = (websites: WebsitesState, extra: { outcome?: CreateOutcome; language?: string; w?: ReturnType<typeof wallet>; locked?: boolean; hide?: (d: CreativeWebsiteDraft) => boolean;
  open?: OpenDraft; concealed?: boolean } = {}) => renderToStaticMarkup(
  <CreativeStudioView language={extra.language ?? 'en'} waiting={false} concealed={extra.concealed ?? false} hasSchool studio={{ state: 'READY', wallet: extra.w ?? wallet() }}
    generations={{ state: 'READY', provider: 'CONNECTED', items: [] }} websites={websites} websiteOutcome={extra.outcome ?? null} websiteLocked={extra.locked}
    hideWebsiteText={extra.hide} onCreateWebsite={() => {}} onCheckWebsiteAgain={() => {}} openDraft={extra.open ?? null} onViewWebsite={() => {}} onHideWebsite={() => {}}/>);
const card = (html: string) => { const at = html.indexOf('creative-websites-title'); return at < 0 ? '' : html.slice(html.lastIndexOf('<article', at), html.indexOf('</article>', at)); };

it('offers the form only when connected, eligible and priced; cost is pages × the HQ page rate', () => {
  const off = card(view({ state: 'READY', provider: 'NOT_CONNECTED', items: [] }));
  expect(off).toContain('data-website-state="NOT_CONNECTED"'); expect(off).toContain('Website drafts are not connected yet'); expect(off).not.toMatch(/<textarea|<input/);
  const unpriced = card(view({ state: 'READY', provider: 'CONNECTED', items: [] }, { w: wallet(false) }));
  expect(unpriced).toContain('data-website-state="NOT_PRICED"'); expect(unpriced).not.toMatch(/<textarea/);
  const open = card(view({ state: 'READY', provider: 'CONNECTED', items: [] }));
  expect(open).toContain('data-website-state="OPEN"'); expect(open).toMatch(/<textarea/);
  for (const label of ['Home', 'Programs', 'Schedule', 'Free trial', 'Instructors', 'About', 'FAQ', 'Contact']) expect(open).toContain(label);
  expect(open).toContain('This uses 30 credits (30 per page). You have 500.');
  expect(open).toMatch(/<button type="submit" disabled="">Draft pages<\/button>/);
  expect(card(view({ state: 'READY', provider: 'CONNECTED', items: [] }, { w: wallet(true, 10) }))).toContain('Not enough credits');
  const ineligible = studioWallet({ ...rawWallet(), program: { status: 'ACTIVE', monthlyIncludedCredits: 12000 } });
  expect(card(view({ state: 'READY', provider: 'CONNECTED', items: [] }, { w: ineligible }))).toContain('data-website-state="BLOCKED"');
  // A website rate never shows up in the image/video form.
  const html = view({ state: 'READY', provider: 'CONNECTED', items: [] });
  expect(html.slice(html.indexOf('creative-create-title'), html.indexOf('creative-avatars-title'))).not.toContain('Website page');
});

it('lists drafts with status and credits, hides the pending brief, locks while unresolved or generating, and shows opened pages', () => {
  const items = [draft('SUCCEEDED'), draft('UNDER_REVIEW', { draftId: id(1961), brief: 'Second school brief' }), draft('FAILED', { draftId: id(1962) })];
  const html = card(view({ state: 'READY', provider: 'CONNECTED', items }));
  expect(html).toContain('Home, Free trial'); expect(html).toContain('60 credits'); expect(html).toContain('60 credits held'); expect(html).toContain('Show draft');
  expect(html.match(/Show draft/g)).toHaveLength(1);
  expect(html).not.toContain('Welcome to our dojang');
  const hidden = card(view({ state: 'READY', provider: 'CONNECTED', items: [draft('GENERATING')] }, { hide: () => true }));
  expect(hidden).not.toContain('Family taekwondo'); expect(hidden).toContain('data-prompt-hidden');
  expect(card(view({ state: 'READY', provider: 'CONNECTED', items: [draft('GENERATING')] }))).toMatch(/<textarea[^>]*disabled=""/);
  expect(card(view({ state: 'READY', provider: 'CONNECTED', items: [draft('GENERATING')] }))).toContain('A draft is still being made');
  expect(html).not.toContain('A draft is still being made');
  expect(card(view({ state: 'READY', provider: 'CONNECTED', items: [] }, { locked: true }))).toMatch(/<textarea[^>]*disabled=""/);
  expect(card(view({ state: 'READY', provider: 'CONNECTED', items: [] }, { outcome: { kind: 'UNKNOWN' } }))).toContain('Check again');
  const opened = card(view({ state: 'READY', provider: 'CONNECTED', items: [draft()] }, { open: { draftId: id(1960), state: 'READY', draft: draft('SUCCEEDED', { content: content() }) } }));
  expect(opened).toContain('Hide draft'); expect(opened).toContain('Welcome to our dojang'); expect(opened).toContain('Book a trial'); expect(opened).toContain('stand-in provider');
  expect(card(view({ state: 'READY', provider: 'CONNECTED', items: [draft()] }, { open: { draftId: id(1960), state: 'FAILED' } }))).toContain('could not be read');
  expect(card(view({ state: 'UNAVAILABLE' }))).toContain('Website drafts could not be read');
});

it('speaks Korean and Spanish, and shows nothing private while concealed', () => {
  expect(card(view({ state: 'READY', provider: 'CONNECTED', items: [draft()] }, { language: 'ko' }))).toContain('웹사이트 초안');
  expect(card(view({ state: 'READY', provider: 'CONNECTED', items: [draft()] }, { language: 'es' }))).toContain('Borrador de sitio web');
  const concealed = view({ state: 'READY', provider: 'CONNECTED', items: [draft()] }, { concealed: true, open: { draftId: id(1960), state: 'READY', draft: draft('SUCCEEDED', { content: content() }) } });
  expect(concealed).not.toContain('Family taekwondo'); expect(concealed).not.toContain('Welcome to our dojang');
});
