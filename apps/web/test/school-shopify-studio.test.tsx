import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { buildDraft } from '../src/components/school-shopify/editor';
import { shopifyText } from '../src/components/school-shopify/copy';
import { MERCH_KINDS, MERCH_STYLES, STUDIO_LANGUAGES } from '../src/components/school-shopify/studio-copy';
import {
  DEFAULT_BRIEF, MerchStudio, PRINT_CHECKS, StudioIdeas, merchConcepts, parseColors, skuFor, suggestedPrice, type StudioProps,
} from '../src/components/school-shopify/studio';
import { SHOPIFY_SECTIONS } from '../src/components/school-shopify/view';

const ctx = (currency: string | null = 'USD') => ({ t: (k: Parameters<typeof shopifyText>[1], v?: Record<string, string>) => shopifyText('en', k, v), locale: 'en-US', domain: 'ima-test.myshopify.com', currency });
const props = (over: Partial<StudioProps> = {}): StudioProps => ({ ctx: ctx(), language: 'en', school: 'Ideal Martial Arts', brand: { state: 'NONE' }, canEdit: true, locked: false,
  onPropose: vi.fn(), creativeHref: '/staff/creative-studio', ...over });

it('writes one starter idea per chosen look, in a fixed order, as valid Shopify drafts', () => {
  const ideas = merchConcepts('en', DEFAULT_BRIEF, 'Ideal Martial Arts', 'USD');
  expect(ideas.map(i => i.style)).toEqual(['MINIMAL', 'ATHLETIC', 'STREETWEAR']);
  expect(ideas[0]!.fields).toMatchObject({ title: 'Ideal Martial Arts Minimalist Hoodie', productType: 'Hoodie', vendor: 'Ideal Martial Arts', price: '50.00', sku: 'IMA-HOODIE-MIN',
    compareAtPrice: '', unitCost: '' });
  expect(ideas[0]!.fields.description).toContain('Ideal Martial Arts logo');
  expect(ideas.every(i => i.source === 'TEMPLATE' && i.sizes.length === 2)).toBe(true);
  // The same brief always writes the same ideas.
  expect(merchConcepts('en', DEFAULT_BRIEF, 'Ideal Martial Arts', 'USD')).toEqual(ideas);
  // Never more than three looks, even if more are passed.
  expect(merchConcepts('en', { ...DEFAULT_BRIEF, styles: [...MERCH_STYLES] }, 'X', 'USD')).toHaveLength(3);
});

it('every kind, look and language builds a draft the server would accept', () => {
  for (const language of Object.keys(STUDIO_LANGUAGES)) for (const kind of MERCH_KINDS) {
    const ideas = merchConcepts(language, { kind, styles: [...MERCH_STYLES].slice(0, 3), colors: 'Black, Navy', notes: '' }, 'Ideal Martial Arts', 'USD');
    for (const i of ideas) expect(buildDraft(i.fields), `${language} ${kind} ${i.style}`).not.toBe('INVALID');
  }
  for (const [language, table] of Object.entries(STUDIO_LANGUAGES)) for (const [key, value] of Object.entries(table)) expect(value.trim(), `${language}.${key}`).not.toBe('');
  // A very long school name is cut to fit Shopify's limits.
  const long = merchConcepts('en', DEFAULT_BRIEF, 'A'.repeat(400), 'USD')[0]!;
  expect(long.fields.title.length).toBeLessThanOrEqual(255);
  expect(buildDraft(long.fields)).not.toBe('INVALID');
});

it('suggests US dollar prices only, and premium a little higher', () => {
  expect(suggestedPrice('HOODIE', 'MINIMAL', 'USD')).toBe('50.00');
  expect(suggestedPrice('HOODIE', 'PREMIUM', 'USD')).toBe('60.00');
  expect(suggestedPrice('STICKER', 'PREMIUM', 'USD')).toBe('6.00');
  expect(suggestedPrice('HOODIE', 'MINIMAL', 'CAD')).toBe('');
  expect(suggestedPrice('HOODIE', 'MINIMAL', null)).toBe('');
  const cad = merchConcepts('en', DEFAULT_BRIEF, 'Dojo', 'CAD')[0]!;
  expect(cad.priceSuggested).toBe(false);
  // No price means the person must type one before it can be saved.
  expect(buildDraft(cad.fields)).toBe('INVALID');
});

it('reads colors and SKUs safely', () => {
  expect(parseColors(' Black, navy ,, Navy, \u0007bad, ' + 'x'.repeat(41))).toEqual(['Black', 'navy']);
  expect(parseColors(Array.from({ length: 20 }, (_, i) => `c${i}`).join(','))).toHaveLength(10);
  expect(skuFor('Ideal Martial Arts', 'TSHIRT', 'CLASSIC')).toBe('IMA-TSHIRT-CLA');
  expect(skuFor('태권도', 'HAT', 'PREMIUM')).toBe('HON-HAT-PRE');
  expect(skuFor('Dragon & Tiger Kung-Fu Academy of Arts', 'BAG', 'MINIMAL')).toBe('DTKA-BAG-MIN');
});

it('shows the brief, the Merch Studio tab and the saved branding before any idea is written', () => {
  expect(SHOPIFY_SECTIONS).toContain('studio');
  const html = renderToStaticMarkup(<MerchStudio {...props({ brand: { state: 'READY', logoUrl: 'https://cdn.example.test/logo.png', accentColor: '#c81e1e' } })} />);
  expect(html).toContain('data-studio-brief');
  expect(html).toContain('Your brand color #c81e1e');
  expect(html).toContain('src="https://cdn.example.test/logo.png"');
  expect(html).not.toContain('data-studio-ideas');
  expect(renderToStaticMarkup(<MerchStudio {...props()} />)).toContain('data-studio-brand="none"');
  expect(renderToStaticMarkup(<MerchStudio {...props({ brand: { state: 'LOADING' } })} />)).not.toContain('data-studio-brand');
});

it('labels the ideas as templates, never marks anything ready to print, and edits through the approval form', () => {
  const ideas = merchConcepts('en', { ...DEFAULT_BRIEF, colors: 'Black, Navy' }, 'Ideal Martial Arts', 'USD');
  const html = renderToStaticMarkup(<StudioIdeas {...props()} ideas={ideas} editing={null} onEdit={vi.fn()} />);
  expect(html).toContain('data-studio-source="TEMPLATE"');
  expect(html).toContain('not AI');
  expect(html).toContain('Suggested price $50.00');
  expect(html).toContain('Sizes: Youth S–L, Adult S–XXL');
  expect(html).toContain('Colors: Black, Navy');
  expect((html.match(/data-state="NOT_CHECKED"/g) ?? []).length).toBe(ideas.length * PRINT_CHECKS.length * 2);
  expect(html).not.toMatch(/production-ready|data-state="CHECKED"/i);
  expect((html.match(/data-use-idea=/g) ?? []).length).toBe(3);
  expect(html).toContain('No artwork is attached yet');

  const editing = renderToStaticMarkup(<StudioIdeas {...props()} ideas={ideas} editing={ideas[1]!.key} onEdit={vi.fn()} />);
  expect(editing).toContain('data-shopify-draft');
  expect(editing).toContain('Edit this idea');
  expect(editing).toContain('value="Ideal Martial Arts Athletic Hoodie"');
  expect(editing).toContain('Save for approval');

  // Without the Shopify manage permission nobody can open the draft form.
  const reader = renderToStaticMarkup(<StudioIdeas {...props({ canEdit: false })} ideas={ideas} editing={ideas[0]!.key} onEdit={vi.fn()} />);
  expect(reader).not.toContain('data-shopify-draft');
  expect(reader).not.toContain('data-use-idea');
  expect(reader).toContain('Only someone who can manage Shopify');
});

it('writes Korean and Spanish ideas in those languages', () => {
  const ko = merchConcepts('ko', DEFAULT_BRIEF, '아이디얼 무술', 'USD')[0]!;
  expect(ko.fields.title).toBe('아이디얼 무술 미니멀 후드티');
  const es = merchConcepts('es', DEFAULT_BRIEF, 'Ideal Martial Arts', 'USD')[0]!;
  expect(es.fields.title).toBe('Sudadera con capucha Ideal Martial Arts · Minimalista');
  expect(shopifyText('ko', 'nav_studio')).toBe('굿즈 스튜디오');
});
