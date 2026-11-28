import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8') + readFileSync(new URL('../src/story.css', import.meta.url), 'utf8');

test('labels are sentence case, never forced uppercase', () => {
  const forced = css.split('}').filter(rule => /text-transform:uppercase/.test(rule) && !/::first-letter/.test(rule));
  assert.deepEqual(forced, []);
});

test('gold stars sit still without a glow', () => {
  assert.doesNotMatch(css, /@keyframes twinkle/);
  assert.doesNotMatch(css, /drop-shadow\(0 0 \d+px rgba\(243,207,122/);
});

test('header Sign in is a quiet dark secondary, not a second white button', () => {
  assert.match(css, /header \.btn\.light\{background:rgba\(11,13,20,\.6\);color:#eef1f8/);
});

test('the italic accent word is kept for the hero headline only', () => {
  assert.match(css, /h2 em\.s\{font-style:normal\}/);
});

test('impeccable pass: the hero button passes AA and darkens on hover', () => {
  assert.match(css, /\.feature-btn\{[^}]*background:#4f6fb8;/);
  assert.match(css, /\.feature-btn:hover\{background:#4766ad\}/);
});

test('impeccable pass: the ticker pauses for readers and wraps with motion off (WCAG 2.2.2)', () => {
  assert.match(css, /\.ticker:hover \.track,\.ticker:focus-within \.track\{animation-play-state:paused\}/);
  assert.match(css, /html\.still \.ticker \.track\{[^}]*flex-wrap:wrap[^}]*animation:none\}/);
  assert.match(css, /html\.still \.ticker \.item\[aria-hidden="true"\]\{display:none\}/);
});

test('impeccable pass: the wordmark stays readable over the light chapters, and targets are at least 24px', () => {
  assert.match(css, /header \.brand\{[^}]*background:rgba\(11,13,20,\.6\)/);
  assert.match(css, /\.rail a\{width:24px;height:24px;/);
  assert.match(css, /\.lang a\{padding:10px 12px;/);
  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /<h4>/, 'footer labels are not headings that skip a level');
  assert.match(html, /class="ticker" role="region"/);
});
