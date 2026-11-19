import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ language: 'en' as 'en' | 'ko' | 'es' }));
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ preferences: { language: h.language } }) }));
import { HomeLanding } from '../src/components/home/home-landing';
import { GET as privacy } from '../src/app/privacy/route';
import { GET as terms } from '../src/app/terms/route';
import { websiteOrigin } from '../src/server/website-origin';

const saved = process.env.HON_WEBSITE_ORIGIN;
afterEach(() => { if (saved === undefined) delete process.env.HON_WEBSITE_ORIGIN; else process.env.HON_WEBSITE_ORIGIN = saved; h.language = 'en'; });

describe('sign-in landing legal links', () => {
  it.each(['en', 'ko', 'es'] as const)('links to the privacy policy and terms in %s', language => {
    h.language = language;
    const html = renderToStaticMarkup(<HomeLanding />);
    expect(html).toMatch(/<a href="\/privacy"[^>]*>[^<]+<\/a>/);
    expect(html).toMatch(/<a href="\/terms"[^>]*>[^<]+<\/a>/);
  });
});

describe('/privacy and /terms', () => {
  it('redirect permanently to the website pages', () => {
    delete process.env.HON_WEBSITE_ORIGIN;
    for (const [route, path] of [[privacy, '/privacy/'], [terms, '/terms/']] as const) {
      const response = route();
      expect(response.status).toBe(308);
      expect(response.headers.get('location')).toBe(`https://myhonos.com${path}`);
    }
  });

  it('use the configured website origin', () => {
    process.env.HON_WEBSITE_ORIGIN = 'https://www.example.test/';
    const response = privacy();
    expect(response.headers.get('location')).toBe('https://www.example.test/privacy/');
  });

  it.each(['javascript:alert(1)', 'https://user:pw@evil.test', 'https://example.test/path', 'ftp://example.test', ' https://example.test', 'not a url'])(
    'refuses a website origin that is not a plain http(s) origin: %s', bad => {
      process.env.HON_WEBSITE_ORIGIN = bad;
      expect(websiteOrigin()).toBe('https://myhonos.com');
    });
});
