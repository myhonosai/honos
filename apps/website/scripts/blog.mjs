// Builds the blog: /blog/ (list) and /blog/<slug>/ (post) in every language, from
// src/blog/posts/<slug>/<lang>.md. Each post must exist in English, Korean and Spanish.
// The header and footer are taken from the built home page of the same language, so the
// navigation, language switcher and app links stay identical to the rest of the site.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const BLOG_LANGS = ['en', 'ko', 'es'];

/** Blog-only text, per language. Everything else on a blog page comes from the home page. */
export const STRINGS = {
  en: {
    blog: 'Blog',
    indexTitle: 'The HON OS blog',
    indexLede: 'Practical ideas for running and growing a martial arts school.',
    indexDescription: 'Practical ideas for martial arts school owners on classes, students, belt testing, tuition and marketing, from the HON OS team.',
    readTime: (n) => `${n} min read`,
    back: 'All posts',
    endTitle: 'Run your whole school in one app.',
    endText: 'HON OS brings leads, students, classes, belts, tuition and marketing together, with an AI team included.',
    start: 'Start a new school',
    pricing: 'See pricing',
    locale: 'en-US',
  },
  ko: {
    blog: '블로그',
    indexTitle: 'HON OS 블로그',
    indexLede: '도장을 운영하고 키우는 데 바로 쓸 수 있는 실용적인 아이디어.',
    indexDescription: 'HON OS 팀이 도장 관장님을 위해 쓴 수업, 수련생, 승급 심사, 수강료, 마케팅에 관한 실용적인 글.',
    readTime: (n) => `${n}분 분량`,
    back: '모든 글',
    endTitle: '도장 운영을 앱 하나로.',
    endText: 'HON OS는 상담, 수련생, 수업, 띠, 수강료, 마케팅을 한곳에 모으고 AI 팀까지 포함합니다.',
    start: '새 도장 시작하기',
    pricing: '요금 보기',
    locale: 'ko-KR',
  },
  es: {
    blog: 'Blog',
    indexTitle: 'El blog de HON OS',
    indexLede: 'Ideas prácticas para dirigir y hacer crecer una escuela de artes marciales.',
    indexDescription: 'Ideas prácticas para dueños de escuelas de artes marciales sobre clases, alumnos, exámenes de cinturón, cuotas y marketing, del equipo de HON OS.',
    readTime: (n) => `${n} min de lectura`,
    back: 'Todas las publicaciones',
    endTitle: 'Dirige toda tu escuela en una sola app.',
    endText: 'HON OS reúne prospectos, alumnos, clases, cinturones, cuotas y marketing, con un equipo de IA incluido.',
    start: 'Empezar una escuela nueva',
    pricing: 'Ver precios',
    locale: 'es-ES',
  },
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const base = (lang) => (lang === 'en' ? '' : `/${lang}`);

/** Inline Markdown: **bold**, *italic*, [text](/path). Links may only point inside this site. */
function inline(text, where) {
  return esc(text)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
      if (!/^\/(?!\/)[A-Za-z0-9/_#.-]*$/.test(href)) throw new Error(`${where}: links must be site paths like /#pricing, got ${href}`);
      return `<a href="${href}">${label}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

/** A small, strict Markdown subset: ## and ### headings, paragraphs, - and 1. lists, > quotes. */
export function markdown(src, where = 'post') {
  const out = [];
  for (const block of src.trim().split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim());
    const h = lines[0].match(/^(#{2,3}) (.+)$/);
    if (h && lines.length === 1) { out.push(`<h${h[1].length}>${inline(h[2], where)}</h${h[1].length}>`); continue; }
    if (lines.every((l) => /^- /.test(l))) { out.push(`<ul>${lines.map((l) => `<li>${inline(l.slice(2), where)}</li>`).join('')}</ul>`); continue; }
    if (lines.every((l) => /^\d+\. /.test(l))) { out.push(`<ol>${lines.map((l) => `<li>${inline(l.replace(/^\d+\. /, ''), where)}</li>`).join('')}</ol>`); continue; }
    if (lines.every((l) => /^> ?/.test(l))) { out.push(`<blockquote><p>${inline(lines.map((l) => l.replace(/^> ?/, '')).join(' '), where)}</p></blockquote>`); continue; }
    if (lines.some((l) => /^(#|- |\d+\. |>)/.test(l))) throw new Error(`${where}: put a blank line around headings, lists and quotes`);
    out.push(`<p>${inline(lines.join(' '), where)}</p>`);
  }
  return out.join('\n');
}

const FIELDS = ['title', 'description', 'date', 'author'];

/** Reads one post file: front matter between --- lines, then Markdown. */
export function parsePost(text, where) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${where}: starts with front matter between --- lines`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) throw new Error(`${where}: bad front matter line "${line}"`);
    meta[kv[1]] = kv[2].trim();
  }
  for (const f of FIELDS) if (!meta[f]) throw new Error(`${where}: front matter needs ${f}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.date) || Number.isNaN(Date.parse(`${meta.date}T00:00:00Z`))) throw new Error(`${where}: date must be YYYY-MM-DD`);
  if (meta.description.length > 200) throw new Error(`${where}: description is over 200 characters`);
  return { ...meta, body: m[2] };
}

/** Every post in every language, newest first. */
export function loadPosts(postsDir) {
  if (!existsSync(postsDir)) return [];
  const posts = readdirSync(postsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map(({ name: slug }) => {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw new Error(`blog post folder "${slug}" must be lowercase words joined by -`);
    const byLang = {};
    for (const lang of BLOG_LANGS) {
      const file = join(postsDir, slug, `${lang}.md`);
      if (!existsSync(file)) throw new Error(`blog post "${slug}" has no ${lang}.md; every post needs English, Korean and Spanish`);
      byLang[lang] = parsePost(readFileSync(file, 'utf8'), `${slug}/${lang}.md`);
    }
    const dates = new Set(BLOG_LANGS.map((l) => byLang[l].date));
    if (dates.size !== 1) throw new Error(`blog post "${slug}" has different dates per language`);
    return { slug, date: byLang.en.date, byLang };
  });
  return posts.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.slug.localeCompare(b.slug)));
}

function minutes(body, lang) {
  const text = body.replace(/[#>*\-[\]()]/g, ' ');
  const n = lang === 'ko' ? text.replace(/\s/g, '').length / 500 : text.split(/\s+/).filter(Boolean).length / 220;
  return Math.max(1, Math.ceil(n));
}

function niceDate(date, lang) {
  return new Intl.DateTimeFormat(STRINGS[lang].locale, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${date}T00:00:00Z`));
}

/** Header, footer and logo sprite of a built home page, with links fixed for a page under /blog/. */
function chrome(home, lang, path) {
  const pick = (re, name) => { const m = home.match(re); if (!m) throw new Error(`home page has no ${name}`); return m[0]; };
  const fix = (html) => html
    .replace(/(<a\b[^>]*\shref=")#([^"]+)"/g, (m, a, id) => `${a}${base(lang)}/#${id}"`)
    .replace(/(<a href=")[^"]*("[^>]*\sdata-lang="(en|ko|es)")/g, (m, a, b, l) => `${a}${base(l)}${path}${b}`);
  return {
    sprite: pick(/<svg width="0" height="0"[\s\S]*?<\/svg>/, 'logo sprite'),
    header: fix(pick(/<header>[\s\S]*?<\/header>/, 'header')),
    footer: fix(pick(/<footer>[\s\S]*?<\/footer>/, 'footer')),
    skip: pick(/<a class="skip"[^>]*>[^<]*<\/a>/, 'skip link'),
    head: pick(/<link rel="icon"[\s\S]*?<link rel="stylesheet"[^>]*>/, 'head links'),
    robots: pick(/<meta name="robots"[^>]*>/, 'robots tag'),
  };
}

function page({ lang, path, title, description, ogType, home, main }) {
  const c = chrome(home, lang, path);
  const alternates = BLOG_LANGS.map((l) => `<link rel="alternate" hreflang="${l}" href="${base(l)}${path}">`).join('\n')
    + `\n<link rel="alternate" hreflang="x-default" href="${path}">`;
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${c.robots}
<meta name="theme-color" content="#0a0b0a">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="${ogType}">
${alternates}
${c.head}
</head>
<body class="blog">
${c.skip}
${c.sprite}
${c.header}
<main id="top">
${main}
</main>
${c.footer}
</body>
</html>
`;
}

function endCard(lang, app) {
  const t = STRINGS[lang];
  return `<aside class="card post-end">
  <h2>${esc(t.endTitle)}</h2>
  <p>${esc(t.endText)}</p>
  <div class="cta-row"><a class="btn primary" href="${app}/account/start">${esc(t.start)}</a><a class="btn" href="${base(lang)}/#pricing">${esc(t.pricing)}</a></div>
</aside>`;
}

/** Returns [{ file, html }] for every blog page in every language. */
export function blogPages({ posts, homes, app }) {
  const files = [];
  for (const lang of BLOG_LANGS) {
    const t = STRINGS[lang];
    const home = homes[lang];
    const list = posts.map(({ slug, date, byLang }) => {
      const p = byLang[lang];
      return `<li><a class="card post-card" href="${base(lang)}/blog/${slug}/">
    <span class="mono"><time datetime="${date}">${esc(niceDate(date, lang))}</time> · ${esc(t.readTime(minutes(p.body, lang)))}</span>
    <h2>${esc(p.title)}</h2>
    <p>${esc(p.description)}</p>
  </a></li>`;
    }).join('\n');
    files.push({
      file: `${lang === 'en' ? '' : `${lang}/`}blog/index.html`,
      html: page({
        lang, path: '/blog/', title: `${t.indexTitle} | HON OS`, description: t.indexDescription, ogType: 'website', home,
        main: `<section class="blog-head wrap">
  <span class="tag"><span class="dot"></span>${esc(t.blog.toLowerCase())}</span>
  <h1>${esc(t.indexTitle)}</h1>
  <p class="lede">${esc(t.indexLede)}</p>
</section>
<section class="wrap"><ul class="posts">
${list}
</ul></section>`,
      }),
    });
    for (const { slug, date, byLang } of posts) {
      const p = byLang[lang];
      files.push({
        file: `${lang === 'en' ? '' : `${lang}/`}blog/${slug}/index.html`,
        html: page({
          lang, path: `/blog/${slug}/`, title: `${p.title} | HON OS`, description: p.description, ogType: 'article', home,
          main: `<article class="wrap post">
  <a class="mono back" href="${base(lang)}/blog/">← ${esc(t.back)}</a>
  <h1>${esc(p.title)}</h1>
  <p class="mono meta"><time datetime="${date}">${esc(niceDate(date, lang))}</time> · ${esc(p.author)} · ${esc(t.readTime(minutes(p.body, lang)))}</p>
  <div class="prose">
${markdown(p.body, `${slug}/${lang}.md`)}
  </div>
  ${endCard(lang, app)}
</article>`,
        }),
      });
    }
  }
  return files;
}
