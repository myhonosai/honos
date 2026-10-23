import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_LOCALE, en, ko, es, translate } from '@hon/design-system';
const state = vi.hoisted(() => ({ role: 'OWNER', language: 'en' as 'en' | 'ko' | 'es' }));
vi.mock('../src/components/hq-modern/shell', () => ({ useHqModern: () => ({ overview: { callerHqRole: state.role } }) }));
vi.mock('../src/components/localization/provider', async () => {
  const { translate } = await import('@hon/design-system');
  return { useLocale: () => ({ t: (key: any) => translate(state.language, key), formattingLocale: 'en-US', number: (n: number) => String(n), preferences: DEFAULT_LOCALE }) };
});
import { HqPricingOffers } from '../src/components/hq-modern/pricing-offers';
import { DESIGN_OFFER_LAYOUTS, emptyOfferDesign, designPrice, designProblems, customerDesignVisible } from '../src/components/hq-modern/pricing-offers-model';
afterEach(() => { state.role = 'OWNER'; state.language = 'en'; vi.restoreAllMocks(); });
describe('HON OS HQ non-production pricing presentation', () => {
  it('offers six payment layouts for one HON OS product without configured prices, fictitious inventory or product tiers', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const html = renderToStaticMarkup(<HqPricingOffers />);
    for (const text of ['One product. Clear payment choices.', 'Regular monthly', 'Regular annual', 'Founder monthly', 'Founder annual', 'Lifetime', 'Founder lifetime', 'not connected', 'No draft is available for purchase']) expect(html).toContain(text);
    expect(html).not.toMatch(/\$\d|Core|Complete|Essential|12,000|50 slots/); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['en', 'ko', 'es'] as const)('localizes new presentation copy through the shared %s catalog', language => {
    state.language = language; const html = renderToStaticMarkup(<HqPricingOffers />);
    expect(html).toContain(translate(language, 'pricing.heading')); expect(html).toContain(translate(language, 'pricing.notice'));
    for (const key of Object.keys(en).filter(k => k.startsWith('pricing.') || k === 'Pricing & Offers') as (keyof typeof en)[]) { expect(ko[key]).toBeTruthy(); expect(es[key]).toBeTruthy(); }
  });
  it('starts every layout blank rather than importing stale Core/Complete prices or granting credits', () => {
    expect(DESIGN_OFFER_LAYOUTS).toHaveLength(6);
    for (const layout of DESIGN_OFFER_LAYOUTS) { const d = emptyOfferDesign(layout); expect(d.amount).toBe(''); expect(d.credits).toBe(''); expect(d.founderLimit).toBe(''); expect(designProblems(d)).toContain('price'); }
  });
  it('formats currency precisely for local preview and rejects rounding or unsupported input', () => {
    expect(designPrice('249.01', 'USD')).toContain('249.01'); expect(designPrice('150000', 'KRW')).toContain('150,000'); expect(designPrice('1.234', 'BHD')).toContain('1.234');
    for (const [amount, currency] of [['1.001', 'USD'], ['1.1', 'KRW'], ['0', 'USD'], ['-1', 'USD'], ['1e6', 'USD'], ['NaN', 'USD'], ['1234567890', 'USD'], ['249', '../USD']]) expect(designPrice(amount!, currency!)).toBeNull();
  });
  it('checks separate founder, annual, lifetime, credit and date requirements without calculating billing', () => {
    const founder = emptyOfferDesign('founder-annual'); expect(designProblems(founder)).toEqual(expect.arrayContaining(['founder', 'eligibility', 'renewal', 'usage']));
    founder.annualDiscount = '100'; expect(designProblems(founder)).toContain('annual'); founder.annualDiscount = '15.25'; expect(designProblems(founder)).not.toContain('annual');
    const lifetime = emptyOfferDesign('lifetime'); expect(designProblems(lifetime)).toContain('lifetime'); expect(designProblems(lifetime)).not.toContain('renewal');
    lifetime.saleStart = '2026-11-02'; lifetime.saleEnd = '2026-11-01'; expect(designProblems(lifetime)).toContain('dates'); lifetime.saleEnd = '2027-02-30'; expect(designProblems(lifetime)).toContain('dates');
    for (const layout of DESIGN_OFFER_LAYOUTS) expect(customerDesignVisible(emptyOfferDesign(layout))).toBe(!layout.startsWith('founder-'));
  });
  it('keeps all financial, provider, historical, public and persistence source boundaries unchanged', () => {
    const component = readFileSync('src/components/hq-modern/pricing-offers.tsx', 'utf8');
    expect(component).not.toMatch(/fetch\(|localStorage|sessionStorage|document\.cookie|Idempotency-Key|\/api\/|createCheckout|publishOffer/);
    expect(component).toContain('<button type="button" disabled aria-describedby="offer-publish-blocked">');
    const page = readFileSync('src/app/hq/pricing-offers/page.tsx', 'utf8'); expect(page).toContain("dynamic = 'force-dynamic'"); expect(page).toContain('index: false');
    expect(readFileSync('src/app/hq/layout.tsx', 'utf8')).toContain('requireVerifiedWebSession');
    expect(readFileSync('src/components/hq-modern/shell.tsx', 'utf8')).toContain('loadHqOverview()');
  });
});
