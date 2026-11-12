import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite, LANGUAGES } from '../scripts/build.mjs';
import { phrases } from '../scripts/i18n.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const english = readFileSync(join(root, 'src', 'index.html'), 'utf8');
const out = mkdtempSync(join(tmpdir(), 'hon-website-i18n-'));
buildSite({ outDir: out, env: { HON_WEBSITE_APP_URL: 'https://app.example.test' } });
process.on('exit', () => rmSync(out, { recursive: true, force: true }));
const page = (lang) => readFileSync(join(out, lang === 'en' ? '' : lang, 'index.html'), 'utf8');
const visible = (html) => html.replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// Words each language uses for the status labels and for claims the owner has not approved.
const WORDS = {
  ko: { soon: /곧 제공/, launch: /출시와 함께|함께 출시/, banned: [/평생/, /환불/, /30일/, /무료 \d+개월/, /지금 이용 가능/] },
  es: { soon: /próximamente/, launch: /en el lanzamiento|llega con hon os/, banned: [/de por vida/i, /reembolso/i, /30 días/i, /meses gratis/i, /disponible ahora/i] },
};

for (const lang of LANGUAGES) {
  const dict = JSON.parse(readFileSync(join(root, 'src', 'i18n', `${lang}.json`), 'utf8'));

  test(`${lang}: the dictionary covers every English phrase and has no stale entries`, () => {
    const needed = phrases(english);
    assert.deepEqual(needed.filter((k) => !(k in dict)), [], 'missing translations');
    assert.deepEqual(Object.keys(dict).filter((k) => !needed.includes(k)), [], 'stale translations');
  });

  test(`${lang}: whole-sentence translations keep their inline markup`, () => {
    for (const [key, val] of Object.entries(dict)) {
      const tags = (s) => (s.match(/<\/?(em|b)\b/g) ?? []).sort().join();
      assert.equal(tags(val), tags(key), `markup kept in "${val}"`);
    }
  });

  test(`${lang}: page is marked with its language and current link`, () => {
    const html = page(lang);
    assert.match(html, new RegExp(`<html lang="${lang}">`));
    assert.match(html, new RegExp(`data-lang="${lang}" aria-current="page"`));
    assert.doesNotMatch(html, /data-lang="en" aria-current/);
  });

  test(`${lang}: same prices, links and status labels as English`, () => {
    const html = page(lang), text = visible(html);
    for (const price of ['$249', '$2,097', '$199.20', '$1,494', '$30', '$60', '$120', '12,000']) assert.ok(html.includes(price), price);
    assert.ok(html.includes('href="https://app.example.test/account/start"'));
    assert.ok(html.includes('href="https://app.example.test/auth/login"'));
    for (const m of html.matchAll(/<article[^>]*data-status="(soon|launch)"[^>]*>[\s\S]*?<\/article>/g)) {
      assert.match(m[0], WORDS[lang][m[1]], `${lang} card labelled ${m[1]}`);
    }
    for (const bad of [/\$149\b/, /\bCore\b/, /\bComplete\b/, /\bEssential\b/, ...WORDS[lang].banned]) assert.doesNotMatch(text, bad);
    assert.doesNotMatch(html, /<form\b|<input\b/i);
  });
}

test('English page marks English as current', () => {
  assert.match(page('en'), /data-lang="en" aria-current="page"/);
});
