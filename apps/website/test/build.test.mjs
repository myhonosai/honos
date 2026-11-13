import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildSite } from '../scripts/build.mjs';

function build(env) {
  const out = mkdtempSync(join(tmpdir(), 'hon-website-'));
  buildSite({ outDir: out, env });
  return out;
}

test('puts the app address into every app link and leaves no placeholder', () => {
  const out = build({ HON_WEBSITE_APP_URL: 'https://app.example.test/' });
  try {
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    assert.ok(html.includes('href="https://app.example.test/account/start"'));
    assert.ok(html.includes('href="https://app.example.test/auth/login"'));
    assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/);
    for (const f of ['styles.css', 'site.js', 'flow.js', 'favicon.svg', 'assets/front-desk-1168.webp']) {
      assert.ok(existsSync(join(out, f)), `${f} copied`);
    }
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('keeps search engines out unless the build says the site is live', () => {
  const hidden = build({ HON_WEBSITE_APP_URL: 'https://app.example.test' });
  const open = build({ HON_WEBSITE_APP_URL: 'https://app.example.test', HON_WEBSITE_INDEXABLE: '1' });
  try {
    assert.match(readFileSync(join(hidden, 'index.html'), 'utf8'), /<meta name="robots" content="noindex, nofollow">/);
    assert.match(readFileSync(join(open, 'index.html'), 'utf8'), /<meta name="robots" content="index, follow">/);
  } finally {
    rmSync(hidden, { recursive: true, force: true });
    rmSync(open, { recursive: true, force: true });
  }
});

test('uses the local app address when none is given', () => {
  const out = build({});
  try {
    assert.ok(readFileSync(join(out, 'index.html'), 'utf8').includes('href="http://localhost:3000/account/start"'));
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('refuses an app address that is not a plain http(s) origin', () => {
  for (const bad of ['javascript:alert(1)', 'app.example.test', 'https://app.example.test/x"><script>', 'https://user@app.example.test', 'ftp://app.example.test']) {
    assert.throws(() => buildSite({ outDir: join(tmpdir(), 'never'), env: { HON_WEBSITE_APP_URL: bad } }), /HON_WEBSITE_APP_URL/, bad);
  }
});

test('versions CSS, scripts and fonts by content so browsers can cache them for a long time', () => {
  const out = build({ HON_WEBSITE_APP_URL: 'https://app.example.test' });
  try {
    const short = (f) => createHash('sha256').update(readFileSync(join(out, f))).digest('hex').slice(0, 10);
    const css = readFileSync(join(out, 'styles.css'), 'utf8');
    for (const [, font] of css.matchAll(/url\("\/(fonts\/[^"?]+)(\?v=[0-9a-f]{10})?"\)/g)) {
      assert.ok(css.includes(`url("/${font}?v=${short(font)}")`), `${font} is versioned in the CSS`);
    }
    for (const page of ['index.html', 'ko/index.html', 'es/index.html']) {
      const html = readFileSync(join(out, page), 'utf8');
      for (const f of ['styles.css', 'site.js', 'flow.js']) {
        assert.ok(html.includes(`"/${f}?v=${short(f)}"`), `${page} loads versioned ${f}`);
      }
      for (const [, href] of html.matchAll(/<link rel="preload" href="([^"]+)" as="font"/g)) {
        assert.match(href, /\?v=[0-9a-f]{10}$/, `${page} preload ${href} is versioned`);
        assert.ok(css.includes(`url("${href}")`), `${page} preload ${href} matches the CSS font URL`);
      }
    }
  } finally { rmSync(out, { recursive: true, force: true }); }
});
