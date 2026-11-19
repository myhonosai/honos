import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import {
  applyWebsiteEdit, buildSchoolSitePolicy, buildWebsiteFromTemplate, findSiteContact, validateCreateSchoolWebsiteInput,
  validateSaveSchoolWebsiteDraftInput, validateWebsiteDocument, verifyPublishedSchoolWebsite, WEBSITE_BUILT_IN_PAGE_SLUGS, type WebsiteDocument,
} from '@hon/contracts';
import { SiteView } from '../src/components/school-site/site-view';
import { SitePolicyView } from '../src/components/school-site/site-policy';
import { SitePolicyNote } from '../src/components/school-website/site-policy-note';

const base = (): WebsiteDocument => buildWebsiteFromTemplate('MODERN_CLEAN', { schoolName: 'Tiger Dojo' });
const withContact = (doc: WebsiteDocument, props: Record<string, string>): WebsiteDocument => {
  const copy = structuredClone(doc) as WebsiteDocument;
  for (const page of copy.pages) page.sections = page.sections.filter(s => s.type !== 'CONTACT');
  copy.pages[0]!.sections.push({ id: 'contact-x', type: 'CONTACT', props: { heading: 'Visit', address: '', phone: '', email: '', hours: '', ...props } } as never);
  return validateWebsiteDocument(copy);
};
const noContact = (doc: WebsiteDocument): WebsiteDocument => {
  const copy = structuredClone(doc) as WebsiteDocument;
  for (const page of copy.pages) page.sections = page.sections.filter(s => s.type !== 'CONTACT');
  return validateWebsiteDocument(copy);
};

it('reads the contact details from the same CONTACT block the site shows', () => {
  const doc = withContact(base(), { address: '1 Main St\nAustin TX', phone: '+1 (555) 010-0000', email: 'hello@tiger-dojo-sample.com' });
  expect(findSiteContact(doc)).toEqual({ address: '1 Main St\nAustin TX', phone: '+1 (555) 010-0000', email: 'hello@tiger-dojo-sample.com' });
  // An email the renderer would not show as a link is not used either.
  expect(findSiteContact(withContact(base(), { email: 'not an email', phone: '' }))).toEqual({ address: '', phone: '', email: '' });
  expect(findSiteContact(noContact(base()))).toEqual({ address: '', phone: '', email: '' });
});

it('writes a privacy policy with the carrier-required texting clauses and the school contact', () => {
  const policy = buildSchoolSitePolicy('privacy', { schoolName: 'Tiger Dojo', contact: { address: '1 Main St', phone: '555-0100', email: 'hello@tiger-dojo-sample.com' } });
  const text = JSON.stringify(policy);
  expect(policy.title).toBe('Privacy policy');
  expect(text).toContain('Tiger Dojo');
  expect(text).toContain('We do not sell or share your mobile phone number or your text message consent with third parties or affiliates for marketing or promotional purposes');
  expect(text).toContain('Message frequency varies');
  expect(text).toContain('Message and data rates may apply');
  expect(text).toMatch(/Reply STOP/);
  expect(text).toMatch(/HELP/);
  expect(text).toContain('hello@tiger-dojo-sample.com');
  expect(text).toContain('555-0100');
});

it('writes terms with a texting program section that never makes consent a condition of buying', () => {
  const terms = buildSchoolSitePolicy('terms', { schoolName: 'Tiger Dojo', contact: { address: '', phone: '', email: 'hello@tiger-dojo-sample.com' } });
  const text = JSON.stringify(terms);
  expect(terms.title).toBe('Terms of use');
  expect(text).toContain('Text messages');
  expect(text).toContain('not a condition of any purchase');
  expect(text).toMatch(/Reply STOP/);
  expect(text).toContain('Carriers are not liable for delayed or undelivered messages');
  expect(text).toContain('privacy policy, linked at the bottom of every page');
});

it('falls back to the website contact form wording when the site has no contact details', () => {
  const policy = buildSchoolSitePolicy('privacy', { schoolName: 'Tiger Dojo', contact: { address: '', phone: '', email: '' } });
  expect(JSON.stringify(policy)).toContain('using the contact options on this website');
});

it('renders the policy page as escaped text in the school site frame with links back', () => {
  const doc = withContact(base(), { email: 'hello@tiger-dojo-sample.com' });
  const html = renderToStaticMarkup(<SitePolicyView schoolName={'<b>Tiger</b> Dojo'} document={doc} kind="privacy" base="/sites/tiger-dojo" />);
  expect(html).not.toContain('<b>Tiger</b>');
  expect(html).toContain('&lt;b&gt;Tiger&lt;/b&gt; Dojo');
  expect(html).toContain('data-policy="privacy"');
  expect(html).toContain('<h1>Privacy policy</h1>');
  expect(html).toContain('href="mailto:hello@tiger-dojo-sample.com"');
  expect(html).toContain('href="/sites/tiger-dojo/terms"');
  expect(html).toContain('href="/sites/tiger-dojo"');
});

it('links Privacy and Terms from every page footer', () => {
  const html = renderToStaticMarkup(<SiteView schoolName="Tiger Dojo" document={base()} pageSlug="home" base="/sites/tiger-dojo" mode="public" />);
  expect(html).toContain('href="/sites/tiger-dojo/privacy"');
  expect(html).toContain('href="/sites/tiger-dojo/terms"');
});

it('keeps privacy and terms as built-in page addresses an owner cannot take', () => {
  expect([...WEBSITE_BUILT_IN_PAGE_SLUGS]).toEqual(['privacy', 'terms']);
  for (const slug of WEBSITE_BUILT_IN_PAGE_SLUGS) {
    expect(() => applyWebsiteEdit(base(), { op: 'addPage', slug, title: 'Mine', kind: 'CUSTOM' })).toThrow();
    const doc = structuredClone(base()) as WebsiteDocument;
    doc.pages.push({ slug, kind: 'CUSTOM', title: 'Mine', inNav: false, seo: { title: '', description: '' }, campaignId: null,
      sections: [{ id: 'hero', type: 'HERO', props: { heading: 'x', subheading: '', ctaLabel: '', ctaHref: '', imageUrl: '', layout: 'CENTER' } } as never] });
    expect(() => validateSaveSchoolWebsiteDraftInput({ expectedRevision: 1, name: 'Tiger Dojo', document: doc })).toThrow();
    expect(() => validateCreateSchoolWebsiteInput({ publicSlug: 'tiger-dojo', name: 'Tiger Dojo', document: doc })).toThrow();
    // A site already published with such a page still reads; the built-in page simply takes that address.
    expect(() => verifyPublishedSchoolWebsite({ publicSlug: 'tiger-dojo', schoolName: 'Tiger Dojo', version: 1, document: doc }, 'tiger-dojo')).not.toThrow();
  }
});

it('tells the owner the pages are added automatically and warns when no contact details exist', () => {
  const ok = renderToStaticMarkup(<SitePolicyNote language="en" document={withContact(base(), { phone: '555-0100' })} slug="tiger-dojo" published />);
  expect(ok).toContain('to your website automatically');
  expect(ok).toContain('href="/sites/tiger-dojo/privacy"');
  expect(ok).not.toContain('data-warn');
  const warn = renderToStaticMarkup(<SitePolicyNote language="en" document={noContact(base())} slug="tiger-dojo" published={false} />);
  expect(warn).toContain('data-warn');
  expect(warn).toContain('Contact');
  expect(warn).not.toContain('href="/sites/tiger-dojo/privacy"');
  const ko = renderToStaticMarkup(<SitePolicyNote language="ko" document={noContact(base())} slug="tiger-dojo" published={false} />);
  const es = renderToStaticMarkup(<SitePolicyNote language="es" document={noContact(base())} slug="tiger-dojo" published={false} />);
  expect(ko).not.toEqual(warn);
  expect(es).not.toEqual(warn);
});
