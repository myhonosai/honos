import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'src', 'index.html'), 'utf8');
const siteJs = readFileSync(join(root, 'src', 'site.js'), 'utf8');
const section = html.match(/<section id="pricing"[\s\S]*?<\/section>/)?.[0] ?? '';
const plain = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** Returns the plan card markup for data-plan="name". */
function card(name) {
  const m = section.match(new RegExp(`<article[^>]*data-plan="${name}"[^>]*>[\\s\\S]*?</article>`));
  assert.ok(m, `${name} card exists`);
  return m[0];
}
/** Returns the price block for one billing period inside a card. */
function price(name, period) {
  const m = card(name).match(new RegExp(`<div class="price" data-show="${period}">[\\s\\S]*?<!-- /price -->`));
  assert.ok(m, `${name} has a ${period} price`);
  return m[0];
}

test('billing switch offers Yearly first and Monthly, with Yearly selected', () => {
  const sw = section.match(/<div class="seg" role="group" aria-label="Billing period">[\s\S]*?<\/div>/)?.[0] ?? '';
  const buttons = [...sw.matchAll(/<button type="button" data-period="(y|m)" aria-pressed="(true|false)">([^<]+)<\/button>/g)];
  assert.deepEqual(buttons.map((b) => [b[1], b[2], b[3]]), [['y', 'true', 'Yearly'], ['m', 'false', 'Monthly']]);
  assert.doesNotMatch(section, /quarter/i, 'HON has no quarterly price');
  assert.match(section, /<div class="plans" data-period="y">/, 'yearly prices show first, even without JavaScript');
});

test('the save line rounds the best yearly saving down (37.5% -> 37%)', () => {
  assert.match(plain(section), /Save up to 37% on a yearly subscription/);
  assert.doesNotMatch(plain(section), /Save (up to )?(38|40|50)%/);
});

test('yearly prices are the approved yearly price divided by 12', () => {
  for (const [name, year, perMonth] of [['founder', '$1,494', '$124.50'], ['standard', '$2,097', '$174.75']]) {
    const p = plain(price(name, 'y'));
    assert.ok(p.includes(perMonth), `${name} shows ${perMonth}`);
    assert.ok(p.includes(year), `${name} shows the ${year} yearly total`);
    assert.match(p, /per month billed yearly/);
    assert.equal(Number(year.replace(/[$,]/g, '')) / 12, Number(perMonth.slice(1)));
  }
});

test('monthly prices are the approved monthly prices', () => {
  assert.match(plain(price('founder', 'm')), /\$199\.20 per month billed monthly/);
  assert.match(plain(price('standard', 'm')), /\$249 per month billed monthly/);
});

test('the struck price is the standard $249 and each badge is the saving against it, rounded down', () => {
  const cases = [['founder', 'y', '-50%'], ['founder', 'm', '-20%'], ['standard', 'y', '-29%']];
  for (const [name, period, badge] of cases) {
    const p = price(name, period);
    assert.match(p, /<s class="was"><span class="sr">Standard monthly price<\/span> \$249<\/s>/, `${name} ${period} strikes $249`);
    assert.match(card(name), new RegExp(`<span class="pill" data-show="${period}">${badge}</span>`), `${name} ${period} badge ${badge}`);
    const now = Number(plain(p).match(/\$([\d.]+) per month/)[1]);
    assert.equal(`-${Math.floor((1 - now / 249) * 100)}%`, badge, `${badge} is not rounded up`);
  }
  assert.doesNotMatch(price('standard', 'm'), /<s class="was">/, 'nothing struck when there is no discount');
  assert.doesNotMatch(card('standard'), /data-show="m">-/, 'no badge when there is no discount');
});

test('Founder 50 is marked "Best value", never "Popular" (no customer data to back it)', () => {
  assert.match(card('founder'), /<span class="pill best">Best value<\/span>/);
  assert.doesNotMatch(section, /popular|most chosen|bestseller/i);
});

test('each card has a big rounded start button and the same eight-item checklist', () => {
  const lists = ['founder', 'standard'].map((name) => {
    const c = card(name);
    assert.match(c, /<a class="btn cta( primary)?" href="\{\{APP_URL\}\}\/account\/start">Start a new school<\/a>/);
    const items = [...c.matchAll(/<li>([^<]+)<\/li>/g)].map((m) => m[1]);
    assert.equal(items.length, 8, `${name} lists eight features`);
    return items;
  });
  assert.deepEqual(lists[0], lists[1]);
  const all = lists[0].join(' | ');
  for (const must of [/12,000 Creative Studio credits/, /no per-message charges/, /No HON fee on tuition/, /14-day free trial/, /30-day money-back guarantee/]) {
    assert.match(all, must);
  }
  assert.match(plain(section), /Top-ups are \$30, \$60 or \$120/);
});

test('the banner shows the founder discount that really applies today', () => {
  const banner = section.match(/<div class="offer"[\s\S]*?<\/div>/)?.[0] ?? '';
  assert.match(banner, /role="note"/);
  assert.match(plain(banner), /first 50 schools get 20% off/);
  assert.match(plain(banner), /standard price/);
  assert.equal(19920 / 24900, 0.8, 'founder monthly is exactly 20% off the standard price');
});

/** Runs site.js's offer helper in a sandbox (the page script is a plain browser IIFE). */
function offerHelper() {
  const sandbox = { window: {}, document: { documentElement: { lang: 'en' } } };
  const helper = siteJs.match(/\/\/ offer banner start[\s\S]*?\/\/ offer banner end/)?.[0];
  assert.ok(helper, 'site.js has the offer banner helper');
  vm.runInNewContext(`${helper}\n window.offerText = offerText; window.OFFER = OFFER; window.OFFER_TEXT = OFFER_TEXT;`, sandbox);
  return sandbox.window;
}

test('the promo/referral banner variant stays off until a billing path applies the discount', () => {
  assert.equal(offerHelper().OFFER, null);
});

test('the promo/referral banner variant renders in every language when switched on', () => {
  const w = offerHelper();
  assert.equal(w.offerText({ by: 'A partner school', pct: 20 }, 'en'), 'A partner school has applied a 20% discount on your first year of HON OS.');
  for (const lang of ['ko', 'es']) {
    const s = w.offerText({ by: 'X', pct: 20 }, lang);
    assert.ok(s.includes('X') && s.includes('20%') && s.includes('HON OS'), `${lang}: ${s}`);
  }
  assert.equal(w.offerText({ by: '<b>x</b>', pct: 20 }, 'en').includes('<'), true, 'returns text; the page sets it with textContent');
  assert.equal(w.offerText({ by: 'X', pct: 0 }, 'en'), null, 'no banner without a real percentage');
  assert.equal(w.offerText({ by: 'X', pct: 101 }, 'en'), null);
  assert.equal(w.offerText(null, 'en'), null);
});

test('the switch only flips which period is shown', () => {
  assert.match(siteJs, /data-period/);
  assert.doesNotMatch(siteJs, /dataset\[p\]|\.amt"\)\.textContent/, 'old price-rewriting toggle is gone');
  assert.doesNotMatch(siteJs, /innerHTML\s*=\s*[^;]*offer/i, 'offer text is never written as HTML');
});
