import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { validateSaasCreativeSchoolWallet } from '@hon/contracts';
import { CREATIVE_STUDIO_API } from '../src/components/creative-studio/creative-studio';
import { STUDIO_HISTORY_LIMIT, studioWallet, type StudioState } from '../src/components/creative-studio/model';
import { CreativeStudioView, type CreativeStudioViewProps } from '../src/components/creative-studio/view';
import { SCHOOL_SHELL_NAV } from '../src/components/school-shell/catalog';
import { AccountStatusError } from '../src/components/account-status/http';
import { at, id, rawWallet, reply, scope } from './account-status-fixtures';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function activeWallet(historyCount = 2) {
  const raw = rawWallet();
  return validateSaasCreativeSchoolWallet({ ...raw, walletVersion: 3, program: { ...raw.program, status: 'ACTIVE' },
    eligibility: { eligible: true, reason: null, window: { index: 1, startsAt: '2026-11-01T00:00:00.000Z', endsAt: '2026-12-01T00:00:00.000Z' } },
    balance: { availableCredits: 11640, heldCredits: 120, byKind: raw.balance.byKind.map(kind => kind.kind === 'INCLUDED_MONTHLY'
      ? { ...kind, grantedCredits: 12000, availableCredits: 11640, heldCredits: 120, consumedCredits: 240 } : kind) },
    rates: { rateVersionId: id(40), rateVersion: 1, termsReference: 'terms-v1', publishedAt: at, rates: [
      { operationCode: 'image.standard', mediaKind: 'IMAGE', displayName: 'Standard image', billingUnit: 'IMAGE', creditsPerUnit: 40, maxUnitsPerRequest: 4, rateBasis: 'PROVISIONAL' },
      { operationCode: 'video.short', mediaKind: 'VIDEO', displayName: 'Short video', billingUnit: 'VIDEO_SECOND', creditsPerUnit: 60, maxUnitsPerRequest: 15, rateBasis: 'VERIFIED_COST' }] },
    history: Array.from({ length: historyCount }, (_, n) => ({ entryId: id(100 + n), lotId: id(50), lotKind: 'INCLUDED_MONTHLY', entryKind: n % 2 ? 'FINALIZE' : 'GRANT',
      credits: n % 2 ? 40 : 12000, reservationId: null, adjustmentId: null, occurredAt: new Date(Date.UTC(2026, 10, 1, n)).toISOString() })) });
}
const ready = (wallet = studioWallet(activeWallet())): StudioState => ({ state: 'READY', wallet });
const view = (props: Partial<CreativeStudioViewProps> = {}) => renderToStaticMarkup(<CreativeStudioView language="en" waiting={false} concealed={false} hasSchool studio={ready()} {...props}/>);

it('projects only school-facing wallet facts, newest history first and capped', () => {
  const wallet = studioWallet(activeWallet(STUDIO_HISTORY_LIMIT + 5));
  expect(wallet.history).toHaveLength(STUDIO_HISTORY_LIMIT);
  expect(wallet.history[0]!.occurredAt > wallet.history[1]!.occurredAt).toBe(true);
  expect(wallet.rates?.map(rate => rate.provisional)).toEqual([true, false]);
  expect(Object.keys(wallet).sort()).toEqual(['available', 'eligible', 'held', 'history', 'monthlyIncluded', 'packages', 'programActive', 'rates', 'reason', 'websiteRate', 'window']);
  expect(JSON.stringify(wallet)).not.toMatch(/providerCost|providerId|modelCode|lotId|reservationId/);
});

it('always shows creation as not connected, with no prompt, create control or purchase control', () => {
  for (const studio of [ready(), { state: 'LOADING' } as const, { state: 'DENIED' } as const, { state: 'UNAVAILABLE' } as const]) {
    const html = view({ studio });
    expect(html).toContain('Not connected yet');
    expect(html).toContain('nothing can be created here and nothing is charged');
    expect(html).not.toMatch(/<textarea|<input|<select|<form/);
    expect(html).not.toMatch(/>(Create|Generate|Buy)[^<]*<\/button>/);
  }
});

it('shows the real balance, published rates, recent activity and top-ups that are not connected', () => {
  const html = view();
  expect(html).toContain('11,640'); expect(html).toContain('12,000'); expect(html).toContain('120');
  expect(html).toContain('Standard image'); expect(html).toContain('credits per image'); expect(html).toContain('Provisional');
  expect(html).toContain('credits per second of video'); expect(html).toContain('Up to 15 per request');
  expect(html).toContain('Credits added'); expect(html).toContain('Used by a creation');
  expect(html).toContain('Buying top-ups is not connected yet. No card is charged.'); expect(html).toContain('$120.00');
  expect(html).toContain('Conversations with HON and the AI team never use them');
});

it('says when the program is off or the school is not eligible, and when nothing is published', () => {
  const off = view({ studio: ready(studioWallet(rawWallet())) });
  expect(off).toContain('Creative credits are not switched on for HON OS yet');
  expect(off).toContain('No creative rates are published yet.'); expect(off).toContain('No credit activity is recorded yet.');
  const raw = activeWallet();
  const blocked = view({ studio: ready(studioWallet({ ...raw, eligibility: { eligible: false, reason: 'VERIFIED_PAYMENT_REQUIRED', window: null } })) });
  expect(blocked).toContain('Your school cannot use creative credits right now');
});

it('shows no numbers while waiting, concealed, without a school, denied or unavailable', () => {
  const cases: [Partial<CreativeStudioViewProps>, string][] = [
    [{ waiting: true }, 'Checking your school'], [{ concealed: true }, 'Creative Studio is hidden'], [{ hasSchool: false }, 'Choose a school'],
    [{ studio: { state: 'DENIED' } }, 'does not include creative credits'], [{ studio: { state: 'UNAVAILABLE' } }, 'could not be read or checked'],
    [{ studio: { state: 'LOADING' } }, 'Reading your school'] ];
  for (const [props, notice] of cases) {
    const html = view(props);
    expect(html).toContain(notice);
    expect(html).not.toContain('11,640'); expect(html).not.toContain('Standard image');
  }
  expect(view({ concealed: true })).not.toContain('Refresh');
});

it('renders Korean and Spanish copy', () => {
  expect(view({ language: 'ko' })).toContain('크리에이티브 스튜디오');
  expect(view({ language: 'es' })).toContain('Estudio creativo');
  expect(view({ language: 'es' })).toContain('Aún no conectado');
});

it('reads only the fixed school wallet GET and refuses a response for another school', async () => {
  vi.stubGlobal('window', new EventTarget());
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(activeWallet()));
  const wallet = await CREATIVE_STUDIO_API.wallet(scope, new AbortController().signal);
  expect(wallet.available).toBe(11640);
  expect(f).toHaveBeenCalledTimes(1);
  const [path, init] = f.mock.calls[0]!;
  expect(path).toBe(`/api/v1/schools/${scope.schoolId}/creative-credits`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
  expect(Object.keys((init as RequestInit).headers as Record<string, string>)).toEqual(['Accept']);
  f.mockResolvedValue(reply({ ...activeWallet(), schoolId: id(9) }));
  await expect(CREATIVE_STUDIO_API.wallet(scope, new AbortController().signal)).rejects.toBeInstanceOf(AccountStatusError);
  f.mockResolvedValue(reply({}, 403));
  await expect(CREATIVE_STUDIO_API.wallet(scope, new AbortController().signal)).rejects.toMatchObject({ kind: 'DENIED' });
});

it('lists Creative Studio under Marketing in the school navigation', () => {
  const marketing = SCHOOL_SHELL_NAV.find(item => item.key === 'marketing');
  expect(marketing?.routes.map(route => route.href)).toContain('/staff/creative-studio');
});
