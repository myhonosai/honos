import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite } from '../scripts/build.mjs';
import { siteOrigin } from '../scripts/seo.mjs';

function build(env) {
  const out = mkdtempSync(join(tmpdir(), 'hon-website-seo-'));
  buildSite({ outDir: out, env: { HON_WEBSITE_APP_URL: 'https://app.example.test', ...env } });
  return out;
}
const live = build({ HON_WEBSITE_INDEXABLE: '1', HON_WEBSITE_ORIGIN: 'https://site.example.test' });
const hidden = build({});
process.on('exit', () => { rmSync(live, { recursive: true, force: true }); rmSync(hidden, { recursive: true, force: true }); });
const read = (dir, f) => readFileSync(join(dir, f), 'utf8');
const PAGES = ['index.html', 'ko/index.html', 'es/index.html', 'blog/index.html', 'ko/blog/index.html', 'privacy/index.html', 'terms/index.html'];

test('every page has a canonical address, absolute language alternates and a share card', () => {
  for (const f of PAGES) {
    const html = read(live, f);
    const path = `/${f.replace(/index\.html$/, '')}`;
    assert.match(html, new RegExp(`<link rel="canonical" href="https://site\\.example\\.test${path}">`), `${f} canonical`);
    assert.match(html, new RegExp(`<meta property="og:url" content="https://site\\.example\\.test${path}">`), `${f} og:url`);
    assert.match(html, /<meta property="og:image" content="https:\/\/site\.example\.test\/assets\/og-hon-os-1200\.jpg">/, `${f} og:image`);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/, `${f} twitter card`);
    assert.match(html, /<meta name="description" content="[^"]{40,}"/, `${f} description`);
    assert.match(html, /<title>[^<]{10,}<\/title>/, `${f} title`);
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1, `${f} has one h1`);
    for (const [, href] of html.matchAll(/<link rel="alternate" hreflang="[^"]+" href="([^"]+)">/g)) {
      assert.match(href, /^https:\/\/site\.example\.test\//, `${f} alternate ${href} is absolute`);
    }
  }
  assert.match(read(live, 'ko/index.html'), /<meta property="og:locale" content="ko_KR">/);
  assert.match(read(live, 'es/index.html'), /<meta property="og:locale" content="es_US">/);
});

test('the home page describes the organization as structured data', () => {
  for (const f of ['index.html', 'ko/index.html', 'es/index.html']) {
    const json = read(live, f).match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(json, `${f} has JSON-LD`);
    const types = JSON.parse(json)['@graph'].map((n) => n['@type']);
    assert.deepEqual(types.slice(0, 2), ['Organization', 'WebSite']);
  }
});

test('a live build opens the site to search engines and lists every page in the sitemap', () => {
  assert.equal(read(live, 'robots.txt'), 'User-agent: *\nAllow: /\n\nSitemap: https://site.example.test/sitemap.xml\n');
  const map = read(live, 'sitemap.xml');
  for (const f of PAGES) assert.ok(map.includes(`<loc>https://site.example.test/${f.replace(/index\.html$/, '')}</loc>`), `${f} in sitemap`);
  assert.match(map, /hreflang="ko" href="https:\/\/site\.example\.test\/ko\/"/);
  assert.doesNotMatch(map, /localhost|app\.example/);
});

test('a preview build keeps search engines out', () => {
  assert.equal(read(hidden, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  assert.match(read(hidden, 'index.html'), /<meta name="robots" content="noindex, nofollow">/);
  assert.match(read(hidden, 'index.html'), /<link rel="canonical" href="https:\/\/myhonos\.com\/">/, 'default origin is myhonos.com');
});

test('share image and touch icon exist and are small', () => {
  for (const [f, max] of [['assets/og-hon-os-1200.jpg', 150 * 1024], ['apple-touch-icon.png', 20 * 1024]]) {
    assert.ok(existsSync(join(live, f)), `${f} built`);
    assert.ok(statSync(join(live, f)).size <= max, `${f} small`);
  }
});

test('refuses a site origin that is not a plain http(s) origin', () => {
  for (const bad of ['javascript:alert(1)', 'myhonos.com', 'https://myhonos.com/x"><script>', 'https://u@myhonos.com']) {
    assert.throws(() => siteOrigin(bad), /HON_WEBSITE_ORIGIN/, bad);
  }
  assert.equal(siteOrigin('https://myhonos.com/'), 'https://myhonos.com');
});
