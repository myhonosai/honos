// Builds the legal pages, /privacy/ and /terms/, from src/legal/<slug>.md (English only for now).
// Blanks the owner still has to fill are written [[Like this]] and render highlighted. Until the build sets
// HON_WEBSITE_LEGAL_FINAL=1 each page carries a "draft, not yet in effect" banner; the final flag is refused
// while any blank is left, so the banner only comes off once the text is complete.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { markdown, page, base } from './blog.mjs';

export const LEGAL_PAGES = ['privacy', 'terms'];
const FIELDS = ['title', 'description', 'updated'];
const BLANK = /\[\[([^\]]+)\]\]/g;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slugify = (s) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function parse(text, where) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${where}: starts with front matter between --- lines`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) throw new Error(`${where}: bad front matter line "${line}"`);
    meta[kv[1]] = kv[2].trim();
  }
  for (const f of FIELDS) if (!meta[f]) throw new Error(`${where}: front matter needs ${f}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.updated) || Number.isNaN(Date.parse(`${meta.updated}T00:00:00Z`))) throw new Error(`${where}: updated must be YYYY-MM-DD`);
  if (meta.description.length > 200) throw new Error(`${where}: description is over 200 characters`);
  return { ...meta, body: m[2] };
}

/** Body HTML with ids on every ## heading (for the contents list) and highlighted blanks. */
function render(body, where) {
  const toc = [];
  const html = markdown(body, where)
    .replace(/<h2>([\s\S]*?)<\/h2>/g, (m, inner) => {
      const id = slugify(inner);
      if (toc.some((t) => t.id === id)) throw new Error(`${where}: two sections are called "${inner}"`);
      toc.push({ id, label: inner });
      return `<h2 id="${id}">${inner}</h2>`;
    })
    .replace(BLANK, (m, label) => `<mark class="placeholder">${label}</mark>`);
  return { html, toc };
}

function niceDate(date) {
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
}

/** Reads every legal page; with final=true, refuses any blank that is still [[unfilled]]. */
export function loadLegal(dir, { final = false } = {}) {
  return LEGAL_PAGES.map((slug) => {
    const file = join(dir, `${slug}.md`);
    if (!existsSync(file)) throw new Error(`legal page ${slug}.md is missing`);
    const doc = parse(readFileSync(file, 'utf8'), `legal/${slug}.md`);
    const blanks = [...doc.body.matchAll(BLANK)].map((m) => m[1]);
    if (final && blanks.length) {
      throw new Error(`legal/${slug}.md still has ${blanks.length} placeholder(s) (${blanks.slice(0, 3).join('; ')}); fill them before building with HON_WEBSITE_LEGAL_FINAL=1`);
    }
    const { html, toc } = render(doc.body, `legal/${slug}.md`);
    const banner = final ? '' : `<p class="legal-draft" role="note"><strong>Draft for review. These terms are not yet in effect.</strong> This text has not had legal review yet; highlighted blanks are still to be filled in.</p>`;
    const main = `<article class="wrap post legal-doc">
  ${banner}
  <h1>${esc(doc.title)}</h1>
  <p class="mono meta">Last updated <time datetime="${doc.updated}">${esc(niceDate(doc.updated))}</time></p>
  <nav class="legal-toc" aria-label="Contents"><ol>${toc.map((t) => `<li><a href="#${t.id}">${t.label}</a></li>`).join('')}</ol></nav>
  <div class="prose">
${html}
  </div>
</article>`;
    return { slug, title: doc.title, description: doc.description, main };
  });
}

/** Returns [{ file, html }] for the legal pages, wrapped in the English home page's header and footer. */
export function legalPages({ dir, home, final }) {
  return loadLegal(dir, { final }).map(({ slug, title, description, main }) => ({
    file: `${slug}/index.html`,
    html: page({
      lang: 'en', path: `/${slug}/`, title: `${title} | HON OS`, description, ogType: 'website', home, main,
      langs: ['en'], bodyClass: 'blog legal-page', langPath: (l) => `${base(l)}/`,
    }),
  }));
}
