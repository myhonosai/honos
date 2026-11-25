// Search and share tags for every built page, plus robots.txt and sitemap.xml.
// Pages keep relative links in src/; the build adds the absolute addresses search engines and
// link previews need, using the site's public origin (HON_WEBSITE_ORIGIN, default https://myhonos.com).

import { jsonLdTag } from './structured.mjs';

export const OG_IMAGE = '/assets/og-hon-os-1200.jpg';
const LOCALES = { en: 'en_US', ko: 'ko_KR', es: 'es_US' };

/** Accepts only a bare http(s) origin and returns it without a trailing slash. */
export function siteOrigin(value) {
  const raw = value === undefined || value === '' ? 'https://myhonos.com' : String(value);
  let url;
  try { url = new URL(raw); } catch { throw new Error(`HON_WEBSITE_ORIGIN is not a URL: ${raw}`); }
  if (!['http:', 'https:'].includes(url.protocol) || !/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?\/?$/.test(raw) || url.username || url.password) {
    throw new Error(`HON_WEBSITE_ORIGIN must be a plain http(s) origin such as https://myhonos.com, got: ${raw}`);
  }
  return url.origin;
}

/** URL path of a built file: "ko/blog/index.html" -> "/ko/blog/". */
export function urlPath(file) {
  return `/${file.replace(/(^|\/)index\.html$/, '$1')}`.replace(/\/+/g, '/');
}

const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/**
 * Adds the canonical address, absolute hreflang alternates, Open Graph URL/locale/image and a large
 * Twitter card to one page, plus its structured data (graph, from structured.mjs) when given.
 */
export function seoHead(html, { origin, path, lang, graph }) {
  const url = origin + path;
  const title = html.match(/<meta property="og:title" content="([^"]*)"/)?.[1] ?? 'HON OS';
  let out = html.replace(/(<link rel="alternate" hreflang="[^"]+" href=")\//g, `$1${origin}/`);
  const tags = [
    `<link rel="canonical" href="${url}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:site_name" content="HON OS">`,
    `<meta property="og:locale" content="${LOCALES[lang] ?? LOCALES.en}">`,
    `<meta property="og:image" content="${origin}${OG_IMAGE}">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    `<meta property="og:image:alt" content="${escAttr('HON OS: Run the school. Grow the school.')}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:image" content="${origin}${OG_IMAGE}">`,
  ];
  if (graph) tags.push(jsonLdTag(graph));
  const at = out.search(/<meta property="og:type"[^>]*>/);
  if (at < 0) throw new Error(`${path} has no og:type tag to add search tags after`);
  const end = out.indexOf('>', at) + 1;
  return out.slice(0, end) + '\n' + tags.join('\n') + out.slice(end);
}

export function robotsTxt({ origin, indexable }) {
  return indexable
    ? `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`
    : 'User-agent: *\nDisallow: /\n';
}

/** pages: [{ path, lastmod?: 'YYYY-MM-DD', alternates?: { lang: path } }] */
export function sitemapXml({ origin, pages }) {
  const rows = pages.map(({ path, lastmod, alternates }) => {
    const alt = alternates ? Object.entries(alternates)
      .map(([l, p]) => `\n    <xhtml:link rel="alternate" hreflang="${l}" href="${origin}${p}"/>`).join('') : '';
    const mod = lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : '';
    return `  <url>\n    <loc>${origin}${path}</loc>${mod}${alt}\n  </url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${rows.join('\n')}\n</urlset>\n`;
}
