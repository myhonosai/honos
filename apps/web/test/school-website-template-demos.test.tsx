import React from 'react';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import {
  WEBSITE_DEMO_SCHOOL, WEBSITE_TEMPLATES, WEBSITE_TEMPLATE_FOCUS, buildWebsiteFromTemplate, buildWebsiteTemplateDemo, validateWebsiteDocument, websiteStarterArtUrl,
} from '@hon/contracts';
vi.mock('server-only', () => ({}));
import { SiteView } from '../src/components/school-site/site-view';
import { websiteText } from '../src/components/school-website/copy';

it('offers five proven school looks and three modern ones, each with its own hero art', () => {
  expect(WEBSITE_TEMPLATES).toEqual(['MODERN_CLEAN', 'FAMILY_FRIENDLY', 'BOLD_POWERFUL', 'TRADITIONAL', 'HIGH_CONVERSION', 'NEON_GRID', 'EDITORIAL', 'BENTO']);
  const heroes = WEBSITE_TEMPLATES.map(t => buildWebsiteFromTemplate(t, { schoolName: 'x' }).pages[0]!.sections.find(s => s.type === 'HERO')!.props.imageUrl as string);
  expect(new Set(heroes).size).toBe(WEBSITE_TEMPLATES.length);
  for (const url of heroes) expect(existsSync(join(__dirname, '..', 'public', url))).toBe(true);
  expect(heroes).toContain(websiteStarterArtUrl('hero-neon'));
});

it('every template demo is a complete valid site: every page filled, sample reviews and team labelled as samples', () => {
  for (const template of WEBSITE_TEMPLATES) {
    const demo = buildWebsiteTemplateDemo(template);
    expect(validateWebsiteDocument(demo)).toEqual(demo);
    expect(demo.theme.template).toBe(template);
    expect(demo.pages.map(p => p.slug)).toEqual(['home', 'about', 'schedule']);
    const all = demo.pages.flatMap(p => p.sections);
    for (const s of all) if (Array.isArray(s.props.items)) expect((s.props.items as unknown[]).length, `${template} ${s.id}`).toBeGreaterThan(0);
    for (const s of all.filter(x => x.type === 'TESTIMONIALS')) for (const r of s.props.items as { author: string }[]) expect(r.author).toMatch(/^Sample /);
    const contact = all.find(s => s.type === 'CONTACT')!;
    expect(contact.props.email).toBe('hello@example.com');
    expect(all.find(s => s.type === 'HERO')!.props.heading).not.toContain('{name}');
  }
});

it('the created site keeps the demo layout but none of the sample reviews, team, times or contact details', () => {
  for (const template of WEBSITE_TEMPLATES) {
    const site = buildWebsiteFromTemplate(template, { schoolName: 'Tiger Dojo' }), demo = buildWebsiteTemplateDemo(template);
    const ids = (d: typeof site) => d.pages.map(p => `${p.slug}:${p.sections.map(s => `${s.id}/${s.type}`).join(',')}`);
    expect(ids(site)).toEqual(ids(demo));
    const text = JSON.stringify(site);
    expect(text).not.toContain('Sample');
    expect(text).not.toContain(WEBSITE_DEMO_SCHOOL);
    expect(text).not.toContain('example.com');
  }
});

it('the demo renders a sample form and booking button, no owner notes, and its nav switches pages in place', () => {
  for (const template of WEBSITE_TEMPLATES) {
    const html = renderToStaticMarkup(<SiteView schoolName={WEBSITE_DEMO_SCHOOL} document={buildWebsiteTemplateDemo(template)} pageSlug="home" base="#demo" mode="demo" onNavigate={() => undefined} />);
    expect(html).toContain('data-mode="demo"');
    expect(html).toContain('data-demo-form="true"');
    expect(html).not.toContain('Choose a published form');
    expect(html).not.toContain('Choose an active booking page');
    expect(html).not.toContain('appears here on the live site');
    expect(html).not.toMatch(/<form[^>]*action=/);
  }
  const bento = renderToStaticMarkup(<SiteView schoolName="x" document={buildWebsiteTemplateDemo('BENTO')} pageSlug="home" base="#demo" mode="demo" />);
  expect(bento).toContain('data-section="SCHEDULE"');
  expect(bento).toContain('4:00 PM');
});

it('each template says what it is built for, in every language', () => {
  for (const language of ['en', 'ko', 'es'] as const) for (const template of WEBSITE_TEMPLATES) {
    expect(websiteText(language, `t_${template}`)).not.toBe(`t_${template}`);
    expect(websiteText(language, `td_${template}`).length).toBeGreaterThan(40);
    expect(websiteText(language, `fo_${WEBSITE_TEMPLATE_FOCUS[template]}`)).not.toMatch(/^fo_/);
  }
  expect(websiteText('en', 'fo_CONVERSION')).toBe('Conversion focus');
  expect(websiteText('en', 'fo_DESIGN')).toBe('Design focus');
});
