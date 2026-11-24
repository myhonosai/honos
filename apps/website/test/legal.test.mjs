import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite } from '../scripts/build.mjs';
import { LEGAL_PAGES, loadLegal } from '../scripts/legal.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = mkdtempSync(join(tmpdir(), 'hon-website-legal-'));
buildSite({ outDir: out, env: { HON_WEBSITE_APP_URL: 'https://app.example.test' } });
process.on('exit', () => rmSync(out, { recursive: true, force: true }));

const read = (file) => readFileSync(join(out, file), 'utf8');
const visible = (html) => html.replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ');

const BANNED = [/\$149\b/, /\bEssential\b/, /lifetime/i, /free months?/i, /available now/i, /\$15\b/, /payment processor of our own|hon pay\b/i,
  /HIPAA[- ]compliant|SOC ?2 (certified|compliant)|ISO ?27001 certified|PCI[- ]DSS certified/i, /we (never|do not) (ever )?(get|have) (breached|hacked)/i,
  /do not allow them to (use|train)|providers (may not|must not|cannot) (use|train)/i];

test('builds /privacy/ and /terms/ as English pages with the site header and footer', () => {
  for (const slug of LEGAL_PAGES) {
    const file = `${slug}/index.html`;
    assert.ok(existsSync(join(out, file)), `${file} built`);
    const html = read(file);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<title>[^<]+ \| HON OS<\/title>/);
    assert.match(html, /<meta name="description" content="[^"]{40,}"/);
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/, 'same robots rule as the rest of the site');
    assert.match(html, /<header>/);
    assert.match(html, /<footer>/);
    assert.doesNotMatch(html, /<script\b(?! type="application\/ld\+json")/, 'legal pages run no script');
    assert.doesNotMatch(html, /<form\b|<input\b/i, 'legal pages collect no data');
    assert.match(html, /<time datetime="\d{4}-\d{2}-\d{2}">/, 'shows the last-updated date');
  }
});

test('the published pages are complete: no blanks and no draft banner', () => {
  for (const slug of LEGAL_PAGES) {
    const html = read(`${slug}/index.html`);
    assert.doesNotMatch(html, /legal-draft|<mark class="placeholder">/, `${slug} is final`);
    assert.doesNotMatch(html, /\[\[|\]\]/, 'no raw placeholder markers reach the page');
  }
});

test('a page with a blank left shows a not-in-effect banner and highlights the blank', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hon-website-legal-blank-'));
  try {
    cpSync(join(root, 'src', 'legal'), dir, { recursive: true });
    const file = join(dir, 'terms.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('Los Angeles County, California', '[[County and State]]'));
    const [privacyPage, termsPage] = loadLegal(dir);
    assert.doesNotMatch(privacyPage.main, /legal-draft/, 'a complete page has no banner');
    assert.match(termsPage.main, /class="legal-draft"[^>]*role="note"/);
    assert.match(visible(termsPage.main), /Draft for review\. These terms are not yet in effect\./);
    assert.match(termsPage.main, /<mark class="placeholder">County and State<\/mark>/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('every footer links to Privacy and Terms; Korean and Spanish say the pages are in English', () => {
  for (const file of ['index.html', 'ko/index.html', 'es/index.html', 'blog/index.html', 'privacy/index.html', 'terms/index.html']) {
    const footer = read(file).match(/<footer>[\s\S]*?<\/footer>/)[0];
    assert.match(footer, /<a href="\/privacy\/"[^>]*>/, `${file} footer links to privacy`);
    assert.match(footer, /<a href="\/terms\/"[^>]*>/, `${file} footer links to terms`);
  }
  for (const file of ['ko/index.html', 'es/index.html']) {
    const footer = read(file).match(/<footer>[\s\S]*?<\/footer>/)[0];
    assert.match(footer, /<a href="\/privacy\/" hreflang="en"/);
    assert.match(footer, /<a href="\/terms\/" hreflang="en"/);
  }
});

test('legal links only go to built pages, anchors on the page, or mail placeholders', () => {
  for (const slug of LEGAL_PAGES) {
    const html = read(`${slug}/index.html`);
    const main = html.match(/<main[\s\S]*?<\/main>/)[0];
    for (const [, href] of main.matchAll(/href="([^"]+)"/g)) {
      if (href.startsWith('#')) {
        assert.ok(main.includes(`id="${href.slice(1)}"`), `${slug}: ${href} exists`);
      } else {
        const path = href.split('#')[0];
        assert.ok(path.startsWith('/'), `${slug}: ${href} stays on the site`);
        assert.ok(existsSync(join(out, path, path.endsWith('/') ? 'index.html' : '')), `${slug}: ${href} is built`);
      }
    }
  }
});

test('makes no unapproved or unprovable claim', () => {
  for (const slug of LEGAL_PAGES) {
    const text = visible(read(`${slug}/index.html`));
    for (const bad of BANNED) assert.doesNotMatch(text, bad, `${slug} must not say ${bad}`);
  }
});

const privacy = () => visible(read('privacy/index.html'));
const terms = () => visible(read('terms/index.html'));

test('privacy policy covers what the app stores ask about', () => {
  const text = privacy();
  for (const [topic, re] of [
    ['what data and why', /information we collect/i],
    ['how it is used', /how we use/i],
    ['schools control their data', /on behalf of (the|each) school|school is the controller|school decides/i],
    ['minors and parental consent', /under 13/i],
    ['COPPA', /COPPA|Children's Online Privacy Protection/i],
    ['face check-in consent', /face check-in/i],
    ['camera picture not stored', /camera picture is (never|not) stored/i],
    ['HON Family app', /HON Family/],
    ['AI features', /\bAI\b/],
    ['AI not used to train on school data without permission', /train/i],
    ['payments', /Stripe/],
    ['payments Square', /Square/],
    ['card numbers not stored', /card numbers?/i],
    ['texting STOP/HELP', /STOP/],
    ['texting HELP', /HELP/],
    ['Meta', /Meta|Facebook/],
    ['Google', /Google/],
    ['Zernio', /Zernio/],
    ['Shopify order totals and line items', /Shopify/],
    ['Shopify no customer contact details', /no (Shopify )?customer names, emails, phone numbers or addresses/i],
    ['Shopify 60 days', /60 days/],
    ['Shopify uninstall deletion', /uninstall/i],
    ['no selling', /(do not|never) sell/i],
    ['retention', /retention|how long we keep/i],
    ['security / encryption', /encrypt/i],
    ['subprocessors', /service providers|subprocessors/i],
    ['AI providers the code calls', /OpenRouter[\s\S]*HeyGen[\s\S]*Higgsfield/],
    ['rights / requests', /access, correct|delete/i],
    ['California', /California/],
    ['contact', /contact us/i],
    ['legal entity', /HON OS Labs LLC/],
    ['contact email', /myhonosai@gmail\.com/],
    ['mailing address', /San Gabriel, CA 91776/],
    ['changes', /changes to this/i],
  ]) assert.match(text, re, `privacy policy covers ${topic}`);
});

test('terms cover the school agreement and data processing', () => {
  const text = terms();
  for (const [topic, re] of [
    ['acceptance', /agree/i],
    ['accounts', /account/i],
    ['school responsibilities for consent', /consent/i],
    ['fees and trial', /trial/i],
    ['refund', /refund/i],
    ['cancellation', /cancel/i],
    ['acceptable use', /acceptable use|you will not/i],
    ['texting rules', /STOP/],
    ['AI output review', /\bAI\b/],
    ['third-party services', /third-party/i],
    ['data processing for schools', /data processing/i],
    ['processing on instructions', /instructions/i],
    ['security incident notice', /security incident|breach/i],
    ['subprocessors', /subprocessors/i],
    ['return / delete on termination', /export|delete/i],
    ['disclaimer', /as is/i],
    ['limitation of liability', /limitation of liability/i],
    ['governing law', /laws of the State of California/],
    ['breach notice within 72 hours', /within 72 hours/],
    ['export window', /30 days so you can export/],
    ['contact', /contact/i],
  ]) assert.match(text, re, `terms cover ${topic}`);
});
