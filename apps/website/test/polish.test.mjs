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
