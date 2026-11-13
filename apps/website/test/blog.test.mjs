import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite } from '../scripts/build.mjs';
import { markdown, parsePost, BLOG_LANGS } from '../scripts/blog.mjs';

const out = mkdtempSync(join(tmpdir(), 'hon-website-blog-'));
const { posts } = buildSite({ outDir: out, env: { HON_WEBSITE_APP_URL: 'https://app.example.test' } });
process.on('exit', () => rmSync(out, { recursive: true, force: true }));

const pre = (lang) => (lang === 'en' ? '' : `${lang}/`);
const read = (file) => readFileSync(join(out, file), 'utf8');
const visible = (html) => html.replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const blogPages = () => BLOG_LANGS.flatMap((lang) => [`${pre(lang)}blog/index.html`, ...posts.map((s) => `${pre(lang)}blog/${s}/index.html`)]);

// Claims the owner has not approved, in any language (same rules as the home page tests).
const BANNED = [
  /\$149\b/, /\bCore\b/, /\bComplete\b/, /\bEssential\b/, /lifetime/i, /free months?/i, /available now/i, /unlimited/i,
  /(?<![\d$.,])\d+ (videos|images|avatars)\b/i, /\$15\b/, /\$100|welcome credit/i, /payment processor of our own|hon pay\b/i,
  /평생/, /무료 \d+개월/, /지금 이용 가능/, /무제한/, /de por vida/i, /meses gratis/i, /disponible ahora/i, /ilimitad/i,
];

test('builds a blog list and every post in English, Korean and Spanish', () => {
  assert.ok(posts.length >= 2, 'has the sample posts');
  for (const file of blogPages()) assert.ok(existsSync(join(out, file)), `${file} built`);
});

test('the list shows every post, newest first, linked in the page language', () => {
  for (const lang of BLOG_LANGS) {
    const html = read(`${pre(lang)}blog/index.html`);
    const linked = [...html.matchAll(/class="card post-card" href="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(linked, posts.map((s) => `${lang === 'en' ? '' : `/${lang}`}/blog/${s}/`));
    const dates = [...html.matchAll(/<time datetime="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(dates, [...dates].sort().reverse(), 'newest first');
  }
});

test('each blog page is marked with its language, alternates and current language link', () => {
  for (const lang of BLOG_LANGS) {
    for (const path of ['blog/', ...posts.map((s) => `blog/${s}/`)]) {
      const html = read(`${pre(lang)}${path}index.html`);
      assert.match(html, new RegExp(`<html lang="${lang}">`));
      for (const l of BLOG_LANGS) assert.ok(html.includes(`hreflang="${l}" href="${l === 'en' ? '' : `/${l}`}/${path}"`), `${lang} ${path} alternate ${l}`);
      assert.match(html, new RegExp(`href="${lang === 'en' ? '' : `/${lang}`}/${path}"[^>]*data-lang="${lang}" aria-current="page"`), 'switcher stays on this page');
      assert.equal((html.match(/aria-current="page"/g) ?? []).length, 2, 'header and footer mark one language each');
      assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
      assert.match(html, /<title>[^<]+ \| HON OS<\/title>/);
      assert.match(html, /<meta name="description" content="[^"]{40,}"/);
    }
  }
});

test('every link on every page leads to a built page, an anchor that exists, or an allowed app page', () => {
  const pages = ['index.html', 'ko/index.html', 'es/index.html', ...blogPages()];
  for (const file of pages) {
    const html = read(file);
    assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/, `${file} has no placeholder left`);
    assert.doesNotMatch(html, /<form\b|<input\b/i, `${file} collects no data`);
    for (const [, href] of html.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)) {
      if (href.startsWith('https://app.example.test')) {
        assert.ok(['https://app.example.test/account/start', 'https://app.example.test/auth/login'].includes(href), `${file}: ${href}`);
        continue;
      }
      assert.match(href, /^\/|^#/, `${file}: ${href} stays on this site`);
      const [path, id] = href.split('#');
      const target = path === '' ? file : `${path.replace(/^\//, '')}${path.endsWith('/') ? 'index.html' : ''}`;
      assert.ok(existsSync(join(out, target)), `${file}: ${href} exists`);
      if (id) assert.ok(read(target).includes(` id="${id}"`), `${file}: #${id} exists in ${target}`);
    }
  }
});

test('the home page links to the blog in its own language', () => {
  assert.ok(read('index.html').includes('href="/blog/">Blog</a>'));
  assert.ok(read('ko/index.html').includes('href="/ko/blog/">블로그</a>'));
  assert.ok(read('es/index.html').includes('href="/es/blog/">Blog</a>'));
});

test('blog pages make no claim the owner has not approved', () => {
  for (const file of blogPages()) {
    const text = visible(read(file));
    for (const bad of BANNED) assert.doesNotMatch(text, bad, `${file} must not say ${bad}`);
  }
});

test('blog pages load no animation script and nothing from other hosts', () => {
  for (const file of blogPages()) {
    const html = read(file);
    assert.doesNotMatch(html, /<script\b/, `${file} has no scripts`);
    assert.doesNotMatch(html, /(href|src)="(https?:)?\/\/(?!app\.example\.test)/, `${file} stays on this host`);
    assert.match(html, /href="\/styles\.css\?v=[0-9a-f]{10}"/, `${file} loads versioned CSS`);
  }
});

test('Markdown: escapes HTML and only allows links inside the site', () => {
  assert.equal(markdown('a <b>&</b> **c** *d*'), '<p>a &lt;b&gt;&amp;&lt;/b&gt; <strong>c</strong> <em>d</em></p>');
  assert.equal(markdown('## Hi\n\n- one\n- two\n\n1. x\n\n> q'), '<h2>Hi</h2>\n<ul><li>one</li><li>two</li></ul>\n<ol><li>x</li></ol>\n<blockquote><p>q</p></blockquote>');
  assert.equal(markdown('[pricing](/#pricing)'), '<p><a href="/#pricing">pricing</a></p>');
  for (const bad of ['[x](https://evil.test)', '[x](javascript:alert(1))', '[x](//evil.test)', '[x](/a"onmouseover=1)']) {
    assert.throws(() => markdown(bad), /links must be site paths/, bad);
  }
  assert.throws(() => markdown('text\n- list'), /blank line/);
});

test('post files need front matter with a real date and a short description', () => {
  const ok = '---\ntitle: T\ndescription: D\ndate: 2026-11-13\nauthor: A\n---\nBody';
  assert.equal(parsePost(ok, 'x').title, 'T');
  assert.throws(() => parsePost('Body', 'x'), /front matter/);
  assert.throws(() => parsePost(ok.replace('2026-11-13', '13/11/2026'), 'x'), /YYYY-MM-DD/);
  assert.throws(() => parsePost(ok.replace('author: A\n', ''), 'x'), /needs author/);
  assert.throws(() => parsePost(ok.replace('description: D', `description: ${'d'.repeat(201)}`), 'x'), /over 200/);
});

test('blog pages keep the logo icon and point page links home', () => {
  for (const lang of BLOG_LANGS) {
    const html = read(`${pre(lang)}blog/index.html`);
    assert.ok(html.includes('<use href="#mark"/>'), 'logo icon uses the local sprite');
    assert.ok(html.includes(`href="${lang === 'en' ? '' : `/${lang}`}/#pricing"`), 'nav goes to the home page section');
  }
});
