import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite } from '../scripts/build.mjs';
import { BLOG_LANGS } from '../scripts/blog.mjs';

// The owner-approved HON OS "spirit orbit" logo (2026-11-19): mark + outlined wordmark, from a local sprite.
const out = mkdtempSync(join(tmpdir(), 'hon-website-brand-'));
buildSite({ outDir: out, env: { HON_WEBSITE_APP_URL: 'https://app.example.test' } });
process.on('exit', () => rmSync(out, { recursive: true, force: true }));
const read = (file) => readFileSync(join(out, file), 'utf8');
const SWOOSHES = ['#9BE22B', '#1F6BFF', '#22D3F2', '#FF6A4D', '#FF7A55'];

test('every home and blog page shows the spirit-orbit mark and HON OS wordmark from the local sprite', () => {
  const pages = ['index.html', 'ko/index.html', 'es/index.html', ...BLOG_LANGS.map((l) => `${l === 'en' ? '' : `${l}/`}blog/index.html`)];
  for (const page of pages) {
    const html = read(page);
    const sprite = html.match(/<svg width="0" height="0"[\s\S]*?<\/svg>/)[0];
    for (const colour of SWOOSHES) assert.ok(sprite.includes(colour), `${page}: ${colour}`);
    assert.ok(sprite.includes('<symbol id="wordmark"'), `${page}: wordmark symbol inside the sprite`);
    assert.match(html, /<a class="brand"[^>]*aria-label="[^"]+"><span class="logo-mark"><svg[^>]*><use href="#mark"\/><\/svg><\/span><svg class="brand-name"[^>]*aria-hidden="true"><use href="#wordmark"\/><\/svg><\/a>/, page);
    assert.doesNotMatch(html, /class="ribbon"/, page);
  }
});

test('the favicon is the self-contained spirit-orbit vector', () => {
  const svg = read('favicon.svg');
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  for (const colour of SWOOSHES.slice(0, 4)) assert.ok(svg.includes(colour), colour);
  assert.doesNotMatch(svg, /<script|<image|href=|@import/i);
});
