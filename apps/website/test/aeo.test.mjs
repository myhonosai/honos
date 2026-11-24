// Answer-engine and AI-search readiness: structured data, /llms.txt, initial-HTML content,
// internal links and what must never appear in public files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite } from '../scripts/build.mjs';
import { PLANS, faqFromHtml } from '../scripts/structured.mjs';

const ORIGIN = 'https://site.example.test';
const APP = 'https://app.example.test';
const out = mkdtempSync(join(tmpdir(), 'hon-website-aeo-'));
buildSite({ outDir: out, env: { HON_WEBSITE_APP_URL: APP, HON_WEBSITE_INDEXABLE: '1', HON_WEBSITE_ORIGIN: ORIGIN } });
process.on('exit', () => rmSync(out, { recursive: true, force: true }));
const read = (f) => readFileSync(join(out, f), 'utf8');

function htmlFiles(dir = out, rel = '') {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return htmlFiles(p, `${rel}${n}/`);
    return n.endsWith('.html') ? [`${rel}${n}`] : [];
  });
}
const PAGES = htmlFiles();

function graph(f) {
  const blocks = [...read(f).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 1, `${f} has exactly one JSON-LD block`);
  const data = JSON.parse(blocks[0][1]);
  assert.equal(data['@context'], 'https://schema.org', `${f} context`);
  return data['@graph'];
}
const byType = (g, t) => g.filter((n) => n['@type'] === t);

test('every built page has valid JSON-LD whose @id links resolve', () => {
  const home = graph('index.html');
  const known = new Set(home.map((n) => n['@id']).filter(Boolean));
  for (const f of PAGES) {
    const g = graph(f);
    for (const n of g) if (n['@id']) known.add(n['@id']);
    const refs = JSON.stringify(g).match(/\{"@id":"[^"]+"\}/g) ?? [];
    for (const r of refs) {
      const id = JSON.parse(r)['@id'];
      const blog = id.replace(/#blog$/, '');
      assert.ok(known.has(id) || (id.endsWith('#blog') && existsSync(join(out, blog.replace(ORIGIN, ''), 'index.html'))), `${f} refers to unknown ${id}`);
      assert.ok(id.startsWith(`${ORIGIN}/`), `${f} id ${id} on this origin`);
    }
    for (const n of g) for (const v of [n.url, n.item].filter(Boolean)) assert.ok(v.startsWith(`${ORIGIN}/`), `${f} ${v} absolute`);
  }
});

test('home pages describe the organization, the product, its public prices and the visible FAQ', () => {
  for (const f of ['index.html', 'ko/index.html', 'es/index.html']) {
    const html = read(f);
    const g = graph(f);
    assert.deepEqual(g.map((n) => n['@type']), ['Organization', 'WebSite', 'WebPage', 'SoftwareApplication', 'FAQPage'], f);
    const faq = byType(g, 'FAQPage')[0].mainEntity;
    const shown = faqFromHtml(html);
    assert.ok(shown.length >= 5, `${f} shows its FAQ`);
    assert.deepEqual(faq.map((q) => q.name), shown.map((q) => q.q), `${f} FAQ data matches the visible questions`);
    assert.deepEqual(faq.map((q) => q.acceptedAnswer.text), shown.map((q) => q.a), `${f} FAQ answers match the page`);
    const offers = byType(g, 'SoftwareApplication')[0].offers;
    assert.equal(offers.length, PLANS.length);
    for (const o of offers) assert.equal(o.priceCurrency, 'USD');
  }
  // The prices in the data are the prices people see.
  const pricing = read('index.html').match(/<section id="pricing"[\s\S]*?<\/section>/)[0];
  for (const p of PLANS) assert.ok(pricing.includes(p.shown), `pricing shows ${p.shown}`);
  const org = byType(graph('index.html'), 'Organization')[0];
  assert.ok(read('terms/index.html').includes(org.legalName), 'legal name is the one the terms use');
  assert.doesNotMatch(JSON.stringify(graph('index.html')), /aggregateRating|"review"|"award"/, 'no ratings, reviews or awards');
});

test('blog posts are BlogPostings with the visible date, headline and breadcrumbs', () => {
  for (const f of PAGES.filter((p) => /blog\/[^/]+\/index\.html$/.test(p))) {
    const html = read(f);
    const g = graph(f);
    const post = byType(g, 'BlogPosting')[0];
    assert.ok(post, `${f} BlogPosting`);
    assert.equal(post.datePublished, html.match(/<time datetime="([^"]+)"/)[1], `${f} date`);
    assert.ok(html.includes(`<h1>${post.headline.replace(/&/g, '&amp;')}</h1>`), `${f} headline is the h1`);
    const crumbs = byType(g, 'BreadcrumbList')[0].itemListElement;
    assert.equal(crumbs.length, 3, `${f} home > blog > post`);
    assert.equal(crumbs[2].item, `${ORIGIN}/${f.replace(/index\.html$/, '')}`);
  }
  assert.ok(byType(graph('blog/index.html'), 'Blog').length === 1);
  assert.ok(byType(graph('privacy/index.html'), 'BreadcrumbList').length === 1);
});

test('the sitemap gives blog posts their published date', () => {
  const map = read('sitemap.xml');
  assert.match(map, /<loc>https:\/\/site\.example\.test\/blog\/trial-class-to-member\/<\/loc>\s*<lastmod>2026-11-13<\/lastmod>/);
});

test('/llms.txt is a Markdown guide with absolute links to real pages', () => {
  const txt = read('llms.txt');
  assert.match(txt, /^# HON OS\n\n> .{40,}\n/);
  assert.match(txt, /\n## Key facts\n/);
  for (const p of PLANS) assert.ok(txt.includes(p.shown), `llms.txt has ${p.shown}`);
  // The hand-written key facts stay true to the home page.
  const home = read('index.html');
  for (const [fact, onPage] of [['Free trial: 14 days', '14-day free trial'], ['within 30 days of the first HON OS payment', 'within 30 days of your first HON OS payment'], ['HON takes no fee on tuition', 'HON takes no fee on your tuition']]) {
    assert.ok(txt.includes(fact), `llms.txt says "${fact}"`);
    assert.ok(home.includes(onPage), `home page backs "${fact}" with "${onPage}"`);
  }
  for (const { q } of faqFromHtml(read('index.html'))) assert.ok(txt.includes(q), `llms.txt has "${q}"`);
  const links = [...txt.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length >= 8);
  const map = read('sitemap.xml');
  for (const l of links) {
    assert.match(l, /^https:\/\//, `${l} absolute`);
    if (l.startsWith(APP)) assert.ok(['/account/start', '/auth/login'].includes(l.slice(APP.length)), `${l} public app page`);
    else assert.ok(map.includes(`<loc>${l}</loc>`), `${l} is a page in the sitemap`);
  }
});

test('key facts are in the initial HTML, without running any script', () => {
  const home = read('index.html').replace(/<script[\s\S]*?<\/script>/g, '');
  for (const s of ['Run the school', 'martial arts', '$249', '$2,097', '14-day free trial', '30-day money-back guarantee', 'Do I pay for AI messages?', 'English, Korean and Spanish']) {
    assert.ok(home.includes(s), `home HTML has "${s}" before scripts run`);
  }
});

test('every internal link points at a built page or file', () => {
  for (const f of PAGES) {
    for (const [, href] of read(f).matchAll(/<a\b[^>]*\bhref="(\/[^"#?]*)/g)) {
      const target = href.endsWith('/') ? join(out, href, 'index.html') : join(out, href);
      assert.ok(existsSync(target), `${f} links to missing ${href}`);
    }
  }
});

test('public discovery files expose nothing private', () => {
  for (const f of ['robots.txt', 'sitemap.xml', 'llms.txt', ...PAGES]) {
    assert.doesNotMatch(read(f), /localhost|127\.0\.0\.1|sk_(live|test)_|service_role|BEGIN [A-Z ]*PRIVATE KEY/i, `${f} has no secret or local address`);
  }
  for (const f of ['robots.txt', 'sitemap.xml', 'llms.txt']) {
    assert.doesNotMatch(read(f), /supabase|onrender\.com|\/api\/|@[a-z0-9-]+\.[a-z]/i, `${f} names no backend or email address`);
  }
  for (const f of PAGES) {
    for (const [, json] of read(f).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      assert.doesNotMatch(json, /@[a-z0-9-]+\.[a-z]|telephone|streetAddress|birthDate/i, `${f} structured data has no personal details`);
    }
  }
  for (const f of ['sitemap.xml', 'llms.txt']) assert.doesNotMatch(read(f), /\/(hq|admin|school|account\/(?!start))\b/i, `${f} lists no app areas`);
});

test('Korean copy uses the right particle after 도장', () => {
  assert.doesNotMatch(readFileSync(new URL('../src/i18n/ko.json', import.meta.url), 'utf8'), /도장[를는가와]/);
});
