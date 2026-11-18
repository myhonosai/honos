import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { validateWebsiteDocument, type WebsiteDocument } from '@hon/contracts';
vi.mock('server-only', () => ({}));
import { SiteView } from '../src/components/school-site/site-view';
import { siteHref, siteSourceNote, siteVideoUrl, siteParagraphs } from '../src/components/school-site/site-links';
import { readPublicSite } from '../src/server/public-site';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const FORM = 'a'.repeat(48), BOOK = 'b'.repeat(48);
const doc = (): WebsiteDocument => validateWebsiteDocument({ schemaVersion: 1,
  theme: { template: 'BOLD_POWERFUL', font: 'BOLD', logoUrl: 'https://cdn.example.invalid/logo.png', palette: { primary: '#111111', accent: '#ff5500', background: '#ffffff', surface: '#eeeeee', text: '#222222' } },
  pages: [
    { slug: 'home', kind: 'HOME', title: 'Home', inNav: true, seo: { title: 'Tiger Dojo', description: 'Karate for families' }, campaignId: null, sections: [
      { id: 'promo', type: 'PROMO_BANNER', props: { text: 'Halloween special', ctaLabel: 'See offer', ctaHref: '/halloween' } },
      { id: 'hero', type: 'HERO', props: { heading: '<script>alert(1)</script> Tiger Dojo', subheading: 'Line one\nLine two', ctaLabel: 'Book a free class', ctaHref: '#trial', imageUrl: 'https://cdn.example.invalid/hero.jpg', layout: 'SPLIT' } },
      { id: 'programs', type: 'PROGRAMS', props: { heading: 'Programs', intro: '', items: [{ name: 'Little Tigers', ages: '4-6', description: 'Fun.', imageUrl: '' }] } },
      { id: 'schedule', type: 'SCHEDULE', props: { heading: 'Schedule', note: 'Closed on holidays.', items: [{ day: 'Mon', time: '4:00 PM', className: 'Kids' }] } },
      { id: 'trial', type: 'TRIAL_CTA', props: { heading: 'Try a class', body: 'Free.', ctaLabel: 'Visit us', ctaHref: 'https://maps.example.invalid/dojo' } },
      { id: 'form', type: 'LEAD_FORM', props: { heading: 'Ask us', body: '', publicFormId: FORM } },
      { id: 'noform', type: 'LEAD_FORM', props: { heading: 'Not connected', body: '', publicFormId: '' } },
      { id: 'book', type: 'BOOKING', props: { heading: 'Book an evaluation', body: '', ctaLabel: 'Pick a time', bookingPublicId: BOOK } },
      { id: 'faq', type: 'FAQ', props: { heading: 'FAQ', items: [{ question: 'Age?', answer: 'Four and up.' }] } },
      { id: 'quotes', type: 'TESTIMONIALS', props: { heading: 'Families say', items: [{ quote: 'Great!', author: 'A parent' }] } },
      { id: 'team', type: 'INSTRUCTORS', props: { heading: 'Instructors', items: [{ name: 'Master Kim', title: '5th Dan', bio: '', imageUrl: '' }] } },
      { id: 'text', type: 'TEXT', props: { heading: 'About', body: 'Para one.\n\nPara two.' } },
      { id: 'image', type: 'IMAGE', props: { imageUrl: 'https://cdn.example.invalid/dojo.jpg', alt: 'Our dojo', caption: 'Main floor' } },
      { id: 'video', type: 'VIDEO', props: { provider: 'YOUTUBE', videoId: 'dQw4w9WgXcQ', title: 'Tour' } },
      { id: 'contact', type: 'CONTACT', props: { heading: 'Visit', address: '1 Main St', phone: '+1 (555) 010-0000', email: 'hello@example.invalid', hours: 'Mon-Fri' } },
      { id: 'chat', type: 'CHAT', props: { heading: '', body: '' } }] },
    { slug: 'halloween', kind: 'PROMOTION', title: 'Halloween', inNav: false, seo: { title: '', description: '' }, campaignId: null, sections: [
      { id: 'hero', type: 'HERO', props: { heading: 'Halloween camp', subheading: '', ctaLabel: 'Home', ctaHref: '/', imageUrl: '', layout: 'CENTER' } }] },
    { slug: 'black-belt', kind: 'PROGRAM', title: 'Black Belt', inNav: true, seo: { title: '', description: '' }, campaignId: null, sections: [
      { id: 'text', type: 'TEXT', props: { heading: 'Black Belt Program', body: 'Train hard.' } }] },
  ] });
const render = (mode: 'public' | 'preview', page = 'home', d = doc()) => renderToStaticMarkup(<SiteView schoolName="Tiger Dojo" document={d} pageSlug={page} base="/sites/tiger-dojo" mode={mode} />);

it('renders every section type as escaped text with site links, theme variables and navigation', () => {
  const html = render('public');
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; Tiger Dojo');
  for (const type of ['PROMO_BANNER', 'HERO', 'PROGRAMS', 'SCHEDULE', 'TRIAL_CTA', 'LEAD_FORM', 'BOOKING', 'FAQ', 'TESTIMONIALS', 'INSTRUCTORS', 'TEXT', 'IMAGE', 'VIDEO', 'CONTACT'])
    expect(html, type).toContain(`data-section="${type}"`);
  expect(html).toContain('href="/sites/tiger-dojo/halloween"');
  expect(html).toContain('href="#trial"');
  expect(html).toContain('href="https://maps.example.invalid/dojo" rel="noopener noreferrer" target="_blank"');
  expect(html).toContain('href="/book/' + BOOK + '"');
  expect(html).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"');
  expect(html).toContain('href="tel:+15550100000"');
  expect(html).toContain('--site-primary:#111111');
  expect(html).toContain('Line one<br/>Line two');
  // Nav lists in-nav pages only; the promotion page is reachable by link, not the menu.
  expect(html).toContain('href="/sites/tiger-dojo/black-belt"');
  expect(html).not.toContain('>Halloween</a>');
  // Unconnected form and the chat placeholder are invisible to visitors.
  expect(html).not.toContain('Not connected');
  expect(html).not.toContain('data-section="CHAT"');
  // Empty list or contact sections are hidden from visitors but stay visible to the owner in preview.
  const empty = doc(); const home = empty.pages[0]!.sections;
  (home.find(s => s.id === 'quotes')!.props as Record<string, unknown>).items = [];
  Object.assign(home.find(s => s.id === 'contact')!.props, { address: '', phone: '', email: '', hours: '' });
  const hidden = render('public', 'home', empty);
  expect(hidden).not.toContain('data-section="TESTIMONIALS"');
  expect(hidden).not.toContain('data-section="CONTACT"');
  expect(render('preview', 'home', empty)).toContain('data-section="TESTIMONIALS"');
});

it('lays out proven school-site blocks: top announcement bar, offer band, form beside the hero, find-us actions', () => {
  const d = doc(); const home = d.pages[0]!.sections;
  // The leading promo banner sits above the header.
  const html = render('public', 'home', d);
  expect(html.indexOf('data-section="PROMO_BANNER"')).toBeLessThan(html.indexOf('<header'));
  // Find-us: call, directions (address encoded, opens safely) and email buttons.
  expect(html).toContain('href="https://www.google.com/maps/search/?api=1&amp;query=1%20Main%20St" rel="noopener noreferrer" target="_blank"');
  expect(html).toContain('>Call +1 (555) 010-0000</a>');
  // Program ages sit on the card picture; testimonial authors get an initial.
  expect(html).toMatch(/<span class="[^"]*ages[^"]*">4-6<\/span>/);
  // A form right after the hero becomes an offer band; in HIGH_CONVERSION it moves into the hero itself.
  const form = home.splice(home.findIndex(s => s.id === 'form'), 1)[0]!;
  home.splice(2, 0, form);
  expect(render('public', 'home', d)).toMatch(/<section id="form" data-section="LEAD_FORM" class="[^"]*offerBand/);
  d.theme.template = 'HIGH_CONVERSION';
  const conv = render('public', 'home', d);
  expect(conv).toMatch(/<section id="hero" data-section="HERO"[^>]*>(?:(?!<\/section>).)*<div id="form" data-section="LEAD_FORM"/s);
  expect(conv.match(/data-section="LEAD_FORM"/g)).toHaveLength(1);
  // An unconnected form never moves into the hero.
  (form.props as Record<string, unknown>).publicFormId = '';
  expect(render('public', 'home', d)).not.toContain('data-section="LEAD_FORM"');
});

it('preview shows owner notes and never loads the live form; other pages render on their own address', () => {
  const html = render('preview');
  expect(html).toContain('Choose a published form to show it here.');
  expect(html).toContain('data-preview-form="true"');
  expect(html).toContain('Website chat will appear here once Conversation AI is connected.');
  const page = render('public', 'black-belt');
  expect(page).toContain('Black Belt Program');
  expect(page).toContain('aria-current="page"');
  expect(render('public', 'missing')).toBe('');
});

it('link helpers never produce script, data or http URLs even from an unvalidated value', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'http://x.example', '//evil.example', '/Bad Slug', 'mailto:x@y.z', 7, null])
    expect(siteHref(bad, '/sites/x'), String(bad)).toBeNull();
  const unsafe = doc(); (unsafe.pages[0]!.sections[1]!.props as Record<string, unknown>).ctaHref = 'javascript:alert(1)';
  expect(render('public', 'home', unsafe)).not.toContain('javascript:');
  expect(siteVideoUrl('VIMEO', 'abc123')).toBeNull();
  expect(siteVideoUrl('VIMEO', '123456789')).toBe('https://player.vimeo.com/video/123456789');
  expect(siteVideoUrl('OTHER', 'dQw4w9WgXcQ')).toBeNull();
  expect(siteParagraphs('a\n\n\nb\nc')).toEqual([['a'], ['b', 'c']]);
});

it('the form source note keeps only safe UTM text within 80 characters', () => {
  expect(siteSourceNote('?utm_source=facebook&utm_campaign=fall<script>', 'halloween')).toBe('Website / halloween / facebook / fallscript');
  expect(siteSourceNote('', 'home')).toBe('Website');
  expect(siteSourceNote('?utm_source=' + 'x'.repeat(200) + '&utm_campaign=' + 'y'.repeat(200), 'a'.repeat(40)).length).toBeLessThanOrEqual(80);
});

it('the public read verifies the published copy and separates missing from unavailable', async () => {
  const published = { publicSlug: 'tiger-dojo', schoolName: 'Tiger Dojo', version: 3, document: doc() };
  const reply = (body: unknown, status = 200, type = 'application/json') => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': type } }));
  const ok = reply({ data: published });
  const result = await readPublicSite('tiger-dojo', ok as unknown as typeof fetch);
  expect(result.kind).toBe('site');
  expect((ok.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe('http://127.0.0.1:3001/v1/public/sites/tiger-dojo');
  expect((ok.mock.calls[0] as unknown as [string, RequestInit])[1]).toMatchObject({ cache: 'no-store', redirect: 'error' });
  expect((await readPublicSite('tiger-dojo', reply({ result: 'invalid' }, 404) as unknown as typeof fetch)).kind).toBe('missing');
  expect((await readPublicSite('tiger-dojo', reply({ result: 'unavailable' }, 503) as unknown as typeof fetch)).kind).toBe('unavailable');
  expect((await readPublicSite('tiger-dojo', reply({ data: { ...published, publicSlug: 'other-dojo' } }) as unknown as typeof fetch)).kind).toBe('unavailable');
  expect((await readPublicSite('tiger-dojo', reply({ data: published, extra: 1 }) as unknown as typeof fetch)).kind).toBe('unavailable');
  expect((await readPublicSite('tiger-dojo', reply({ data: published }, 200, 'text/html') as unknown as typeof fetch)).kind).toBe('unavailable');
  const never = vi.fn();
  expect((await readPublicSite('../etc', never as unknown as typeof fetch)).kind).toBe('missing');
  expect((await readPublicSite('admin', never as unknown as typeof fetch)).kind).toBe('missing');
  expect(never).not.toHaveBeenCalled();
});
