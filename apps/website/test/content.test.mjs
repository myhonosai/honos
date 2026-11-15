import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const html = readFileSync(join(src, 'index.html'), 'utf8');
const text = html
  .replace(/<script[\s\S]*?<\/script>/g, ' ')
  .replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ');

/** Returns the markup of the element carrying data-agent="name". */
function agentCard(name) {
  const m = html.match(new RegExp(`<article[^>]*data-agent="${name}"[^>]*>[\\s\\S]*?</article>`));
  assert.ok(m, `card for ${name} is on the page`);
  return m[0];
}

test('shows the owner-approved prices', () => {
  for (const price of ['$249', '$2,097', '$199.20', '$1,494', '$30', '$60', '$120', '12,000']) {
    assert.ok(html.includes(price), `${price} is on the page`);
  }
  assert.match(text, /14-day free trial/i);
  assert.match(text, /no automatic charge/i);
  assert.match(text, /standard price/i, 'says a cancelled founder school returns at the standard price');
});

test('never shows retired plans or prices', () => {
  for (const bad of [/\$149\b/, /\bCore\b/, /\bComplete\b/, /\bEssential\b/, /lifetime/i]) {
    assert.doesNotMatch(text, bad);
  }
});

test('makes no claim the owner has not approved yet', () => {
  for (const bad of [
    /free months?/i, /available now/i, /\b\d+ (videos|images|avatars)\b/i, /\$15\b/,
    /\b\d[\d,]* (schools|students|members) (use|trust|run)/i, /texts? (a|per) month/i,
    /payment processor of our own|hon pay\b/i,
  ]) {
    assert.doesNotMatch(text, bad, `page must not say ${bad}`);
  }
});

test('marks every AI specialist as launching, since all eight answer in the app', () => {
  for (const name of ['chad', 'marcus', 'claire', 'kai', 'maya', 'alex', 'jordan', 'lena']) {
    assert.match(agentCard(name), /data-status="launch"/, `${name} is shown at launch`);
    assert.match(agentCard(name), /at launch/i, `${name} is shown at launch, not as live`);
    assert.doesNotMatch(agentCard(name), /coming soon|class="card mate later"/i, `${name} is no longer coming soon`);
  }
  // Only claim what the specialists do today: no staffing or merchandise work exists.
  assert.doesNotMatch(agentCard('jordan'), /staffing/i);
  assert.doesNotMatch(agentCard('lena'), /merchandise/i);
  assert.match(agentCard('hon'), /launching with hon os/i);
});

test('marks features that are not built as coming soon', () => {
  for (const soon of [/Autopay[^<]*<em>soon/, /AI images and video<em>soon/, /lead ads[^<]*<em>soon/i, /Earn rewards for every school you refer[^<]*<em>soon/, /Event and sale-day slot booking<em>soon/]) {
    assert.match(html, soon);
  }
});

test('collects no data: no forms and no email boxes', () => {
  assert.doesNotMatch(html, /<form\b/i);
  assert.doesNotMatch(html, /<input\b/i);
});

test('drops the design-review controls', () => {
  assert.doesNotMatch(html, /data-accent|class="switch"|Design direction/);
});

test('every link to the app goes through the build placeholder to an allowed page', () => {
  const appLinks = [...html.matchAll(/href="(\{\{APP_URL\}\}[^"]*)"/g)].map((m) => m[1]);
  assert.ok(appLinks.length >= 3, 'has start and sign-in links');
  for (const link of appLinks) {
    assert.ok(['{{APP_URL}}/account/start', '{{APP_URL}}/auth/login'].includes(link), `${link} is allowed`);
  }
  assert.ok(appLinks.includes('{{APP_URL}}/account/start'));
  assert.ok(appLinks.includes('{{APP_URL}}/auth/login'));
  assert.doesNotMatch(html, /(href|src)="(https?:)?\/\//, 'loads nothing from other hosts (fonts are self-hosted)');
  assert.doesNotMatch(html, /href="\/pricing"|\/pricing"/, 'never links the old pricing page');
});

test('every in-page anchor points at an element that exists', () => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const [, id] of html.matchAll(/href="#([^"]*)"/g)) {
    assert.ok(id && ids.has(id), `#${id} exists`);
  }
});

test('every image exists and has alt text', () => {
  const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(imgs.length >= 4);
  for (const img of imgs) {
    const srcAttr = img.match(/src="([^"]+)"/)?.[1];
    assert.ok(srcAttr && !srcAttr.startsWith('data:'), 'image is a file, not inline data');
    assert.ok(existsSync(join(src, srcAttr.replace(/^\//, ''))), `${srcAttr} exists`);
    assert.match(img, /\salt="[^"]*"/, `${srcAttr} has alt`);
    assert.match(img, /\swidth="\d+"\s[^>]*height="\d+"|\sheight="\d+"\s[^>]*width="\d+"/, `${srcAttr} has a size`);
  }
});

test('has the basics a public page needs', () => {
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /<title>HON OS[^<]*<\/title>/);
  assert.match(html, /<meta name="description" content="[^"]{40,}"/);
  assert.match(html, /<meta name="robots" content="\{\{ROBOTS\}\}"/);
  for (const file of ['/fonts/geist-latin-400-normal.woff2']) assert.ok(existsSync(join(src, file)), `${file} exists`);
  for (const face of readFileSync(join(src, 'styles.css'), 'utf8').matchAll(/url\("\/(fonts\/[^"]+)"\)/g)) {
    assert.ok(existsSync(join(src, face[1])), `${face[1]} exists`);
  }
  for (const file of ['styles.css', 'site.js', 'flow.js', 'favicon.svg']) {
    assert.ok(html.includes(file), `${file} is referenced`);
    assert.ok(existsSync(join(src, file)), `${file} exists`);
  }
});

test('presents online family tuition payments as coming soon, not available', () => {
  const pay = html.match(/<section id="payments"[\s\S]*?<\/section>/)?.[0];
  assert.ok(pay, 'payments section exists');
  assert.doesNotMatch(pay, /Families pay you directly/);
  assert.match(pay, /<li class="later">Online tuition payments from families[^<]*<em>soon/);
  assert.match(pay.match(/<div class="card paycard"[\s\S]*?<\/div>\s*<\/div>\s*<\/section>/)?.[0] ?? '', /coming soon/i, 'diagram card is labelled coming soon');
  assert.match(pay, /Record cash, check and card-terminal payments/);
  const faq = html.match(/<summary>Does HON take a cut of my tuition\?<\/summary><p>([^<]*)<\/p>/)?.[1] ?? '';
  assert.match(faq, /coming soon/i);
  assert.doesNotMatch(faq, /goes straight/i);
});

test('yearly savings are stated per plan and never rounded up to a false figure', () => {
  // $2,097 vs 12 x $249 = 29.82%; $1,494 vs 12 x $199.20 = 37.5%.
  assert.doesNotMatch(html, /30% or more|save 30%|30% off/i);
  assert.match(html, /\$2,097 a year, about 30% less than paying monthly/);
  assert.match(html, /\$1,494 a year, about 37% less than paying monthly/);
});

test('states the 30-day money-back guarantee exactly as David decided (2026-11-12)', () => {
  const g = html.match(/<div class="card guarantee"[\s\S]*?<\/div>/)?.[0] ?? '';
  assert.match(g, /30-day money-back guarantee/);
  assert.match(g, /first payment/);
  assert.match(g, /monthly or yearly/);
  assert.match(g, /within 30 days/);
  assert.match(g, /founder spot isn't returned/);
  assert.doesNotMatch(text, /refund (any|every|all)|money back any time|no questions asked/i);
});

test('the trial includes the AI team and Creative Studio, with no promised counts', () => {
  assert.match(text, /Try the full AI team and Creative Studio free for 14 days\./);
});

test('texting is unlimited and shown as coming soon; nothing else is called unlimited', () => {
  assert.match(html, /<li class="later">Unlimited texting included<em>soon<\/em><\/li>/);
  const unlimited = [...text.matchAll(/unlimited[^.]*/gi)].map((m) => m[0]);
  for (const u of unlimited) assert.match(u, /^Unlimited texting included/i, `only texting is unlimited: "${u}"`);
});

test('Champions Club rewards use the general wording only', () => {
  assert.match(html, /<li class="later">Earn rewards for every school you refer, details coming soon<em>soon<\/em><\/li>/);
  assert.doesNotMatch(text, /\$100|free month|welcome credit/i);
});

test('photos are small WebP files with phone-sized copies', () => {
  const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(imgs.length >= 4);
  for (const img of imgs) {
    const srcAttr = img.match(/\ssrc="([^"]+)"/)[1];
    assert.match(srcAttr, /^\/assets\/[a-z0-9-]+-\d+\.webp$/, `${srcAttr} is WebP`);
    const set = img.match(/\ssrcset="([^"]+)"/)?.[1];
    assert.ok(set, `${srcAttr} has a srcset`);
    const entries = set.split(',').map((e) => e.trim().split(/\s+/));
    assert.ok(entries.length >= 2, `${srcAttr} offers more than one size`);
    for (const [file, w] of entries) {
      assert.match(w, /^\d+w$/);
      assert.match(file, /\.webp$/);
      const path = join(src, file.replace(/^\//, ''));
      assert.ok(existsSync(path), `${file} exists`);
      assert.ok(statSync(path).size <= 90 * 1024, `${file} is at most 90 KB`);
    }
    assert.ok(entries.some(([, w]) => parseInt(w, 10) <= 800), `${srcAttr} has a phone-sized copy`);
    assert.match(img, /\ssizes="[^"]+"/, `${srcAttr} tells the browser its display size`);
  }
  const jpgs = readdirSync(join(src, 'assets')).filter((f) => /\.jpe?g$/i.test(f));
  assert.deepEqual(jpgs, [], 'no full-size JPEGs left in the site');
});

test('the headline font is preloaded and no unused font is declared', () => {
  const css = readFileSync(join(src, 'styles.css'), 'utf8');
  const preloads = [...html.matchAll(/<link rel="preload" href="([^"]+)" as="font"/g)].map((m) => m[1]);
  assert.ok(preloads.includes('/fonts/instrument-serif-latin-400-italic.woff2'), 'headline serif preloaded');
  for (const href of preloads) assert.ok(css.includes(`url("${href}")`), `${href} is a font the CSS uses`);
  assert.doesNotMatch(css, /geist-latin-700/, 'unused Geist bold is not declared');
});

test('the background animation does less work on phones', () => {
  const flow = readFileSync(join(src, 'flow.js'), 'utf8');
  assert.match(flow, /N=small\?(\d+):200/, 'strand count is set per screen size');
  assert.ok(Number(flow.match(/N=small\?(\d+):200/)[1]) <= 60, 'phones draw at most 60 strands');
  assert.ok(Number(flow.match(/SEG=small\?(\d+):70/)[1]) <= 30, 'phones use at most 30 segments per strand');
  assert.match(flow, /D=small\?1:/, 'phones draw the canvas at 1x pixel ratio');
  assert.match(flow, /FRAME=small\?\d+:0/, 'phones cap the frame rate');
  assert.match(flow, /visibilityState/, 'animation pauses while the page is hidden');
});
