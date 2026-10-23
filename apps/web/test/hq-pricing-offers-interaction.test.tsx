import React from 'react';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const harness = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, role: 'OWNER' }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  const hooks = { useState(initial: any) { const i = harness.cursor++; if (!harness.slots[i]) harness.slots[i] = { value: typeof initial === 'function' ? initial() : initial }; return [harness.slots[i].value, (value: any) => { harness.slots[i].value = typeof value === 'function' ? value(harness.slots[i].value) : value; }]; }, useRef(initial: any) { const i = harness.cursor++; return harness.slots[i] ?? (harness.slots[i] = { current: initial }); }, useEffect() {} };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
vi.mock('../src/components/hq-modern/shell', () => ({ useHqModern: () => ({ overview: { callerHqRole: harness.role } }) }));
vi.mock('../src/components/localization/provider', async () => { const { translate } = await import('@hon/design-system'); return { useLocale: () => ({ t: (key: any, params: any) => translate('en', key, params), formattingLocale: 'en-US', number: (n: number) => String(n) }) }; });
import { HqPricingOffers } from '../src/components/hq-modern/pricing-offers';
const render = () => { harness.cursor = 0; return HqPricingOffers(); };
const nodes = (tree: any, type: string): any[] => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(value => nodes(value, type)) : [...(tree.type === type ? [tree] : []), ...nodes(tree.props?.children, type)];
const text = (tree: any): string => typeof tree === 'string' ? tree : Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : '';
const html = () => renderToStaticMarkup(render());
const button = (name: string) => nodes(render(), 'button').find(node => text(node).startsWith(name));
const field = (id: string) => [...nodes(render(), 'input'), ...nodes(render(), 'select'), ...nodes(render(), 'textarea')].find(node => node.props.id === 'offer-' + id);
const fill = (id: string, value: string) => field(id).props.onChange({ target: { value } });
beforeEach(() => { harness.slots = []; harness.cursor = 0; harness.role = 'OWNER'; vi.stubGlobal('requestAnimationFrame', (f: () => void) => f()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('HQ owner presentation interaction, no backend assumptions', () => {
  it('validates and retains an in-memory design, previews one product and never performs network activity', () => {
    const fetch = vi.spyOn(globalThis, 'fetch'); button('Offer editor').props.onClick(); nodes(render(), 'form')[0].props.onSubmit({ preventDefault: vi.fn() }); expect(html()).toContain('Complete the highlighted draft requirements');
    fill('amount', '249.01'); fill('terms', 'Draft terms for owner review.'); fill('renewal', 'Draft monthly renewal conditions.'); fill('credits', '12000'); fill('usageLimits', 'Draft limits pending verified costs.');
    nodes(render(), 'form')[0].props.onSubmit({ preventDefault: vi.fn() }); expect(html()).toContain('It was not saved to HON');
    button('Customer pricing preview').props.onClick(); expect(html()).toContain('249.01'); expect(html()).toContain('One HON OS product'); expect(html()).not.toContain('Founder monthly'); expect(button('Checkout unavailable').props.disabled).toBe(true); expect(fetch).not.toHaveBeenCalled();
  });
  it('shows founder and lifetime configuration separately, hides founder prices in customer preview and publishes nothing', () => {
    const fetch = vi.spyOn(globalThis, 'fetch'); button('Offer editor').props.onClick(); fill('layout', 'founder-lifetime'); fill('amount', '3576'); fill('founderLimit', '20'); fill('eligibility', 'Draft eligibility'); fill('serviceTerms', 'Draft service terms'); fill('fairUse', 'Draft fair-use terms');
    expect(html()).toContain('Lifetime configuration'); expect(field('renewal')).toBeUndefined();
    button('Review publication requirements').props.onClick(); expect(html()).toContain('Publication review · unavailable'); expect(button('Publish unavailable').props.disabled).toBe(true);
    const checkbox = nodes(render(), 'input').find(n => n.props.type === 'checkbox'); checkbox.props.onChange({ target: { checked: true } }); expect(button('Publish unavailable').props.disabled).toBe(true);
    button('Customer pricing preview').props.onClick(); expect(html()).not.toContain('3,576'); expect(html()).not.toContain('Founder lifetime'); expect(html()).toContain('Founder prices are hidden'); expect(fetch).not.toHaveBeenCalled();
  });
  it('clears publication acknowledgement after edits and does not present local history as a server audit', () => {
    button('Offer editor').props.onClick(); button('Review publication requirements').props.onClick(); fill('amount', '99'); expect(html()).not.toContain('offer-publication-title'); button('Versions & audit').props.onClick(); expect(html()).toContain('audit records are unavailable'); expect(html()).not.toMatch(/Published version [0-9]|Price updated successfully/);
  });
  it('denies editor controls to a verified HQ operator without inventing pricing permission', () => {
    harness.role = 'OPERATOR'; button('Offer editor').props.onClick(); expect(html()).toContain('Only the verified HQ owner'); expect(nodes(render(), 'fieldset').every(f => f.props.disabled)).toBe(true); expect(button('Keep local design draft').props.disabled).toBe(true);
    fill('amount', '999'); expect(field('amount').props.value).toBe(''); nodes(render(), 'form')[0].props.onSubmit({ preventDefault: vi.fn() }); expect(html()).not.toContain('Local design draft retained');
  });
  it('requires an explicit choice and preserves incomplete founder, annual, price and usage edits on Continue Editing and Escape', () => {
    button('Offer editor').props.onClick(); fill('layout', 'founder-annual');
    const values = { name: 'Custom name', amount: 'not finished', currency: 'KRW', saleStart: '2026-11-01', saleEnd: '2027-01-01', terms: 'Terms in progress', eligibility: 'Owner review', founderLimit: '13', annualDiscount: '7.25', renewal: 'Unfinished renewal', credits: '12345', usageLimits: 'Limit notes' };
    for (const [key, value] of Object.entries(values)) fill(key, value);
    fill('layout', 'monthly'); expect(nodes(render(), 'dialog')).toHaveLength(1); expect(field('layout').props.value).toBe('founder-annual');
    button('Continue Editing').props.onClick(); expect(nodes(render(), 'dialog')).toHaveLength(0);
    for (const [key, value] of Object.entries(values)) expect(field(key).props.value).toBe(value);
    fill('layout', 'lifetime'); const preventDefault = vi.fn(); nodes(render(), 'dialog')[0].props.onCancel({ preventDefault }); expect(preventDefault).toHaveBeenCalled();
    for (const [key, value] of Object.entries(values)) expect(field(key).props.value).toBe(value);
    // Selecting the same option must not reload its older retained copy.
    fill('layout', 'founder-annual'); expect(nodes(render(), 'dialog')).toHaveLength(0); expect(field('amount').props.value).toBe('not finished');
  });
  it('Save Local Draft retains every partial lifetime field across switches without validation or network/storage writes', () => {
    const fetch = vi.spyOn(globalThis, 'fetch'); button('Offer editor').props.onClick(); fill('layout', 'founder-lifetime');
    fill('amount', '0.'); fill('founderLimit', '10'); fill('eligibility', 'Eligibility notes'); fill('serviceTerms', 'Service notes'); fill('fairUse', 'Fair use notes'); fill('credits', '5'); fill('usageLimits', 'Usage notes');
    fill('layout', 'monthly'); button('Save Local Draft').props.onClick(); expect(field('layout').props.value).toBe('monthly'); expect(html()).toContain('including incomplete fields'); expect(html()).toContain('Nothing was saved to HON');
    fill('layout', 'founder-lifetime'); expect(nodes(render(), 'dialog')).toHaveLength(0);
    for (const [key, value] of Object.entries({ amount: '0.', founderLimit: '10', eligibility: 'Eligibility notes', serviceTerms: 'Service notes', fairUse: 'Fair use notes', credits: '5', usageLimits: 'Usage notes' })) expect(field(key).props.value).toBe(value);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('Discard Changes restores the last local copy, and overview cards cannot silently discard unsaved edits', () => {
    button('Offer editor').props.onClick(); fill('amount', '101'); fill('layout', 'annual'); button('Save Local Draft').props.onClick();
    fill('layout', 'monthly'); fill('amount', '202'); button('Offer overview').props.onClick();
    button('Design this option · Regular annual').props.onClick({ currentTarget: undefined }); expect(nodes(render(), 'dialog')).toHaveLength(1);
    button('Discard Changes').props.onClick(); expect(field('layout').props.value).toBe('annual'); fill('layout', 'monthly'); expect(field('amount').props.value).toBe('101');
    fill('layout', 'annual'); fill('terms', 'Unsaved only'); fill('layout', 'lifetime'); button('Discard Changes').props.onClick(); fill('layout', 'annual'); expect(field('terms').props.value).toBe('');
  });
});
