// Builds the static HON OS marketing site: copies src/ to dist/ and fills in the build-time values.
//   HON_WEBSITE_APP_URL   origin of the HON OS app (default http://localhost:3000)
//   HON_WEBSITE_INDEXABLE set to 1 only when the site is approved to go live; otherwise pages are noindex.
import { cpSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { localize, markLanguage } from './i18n.mjs';

export const LANGUAGES = ['ko', 'es'];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Accepts only a bare http(s) origin (optional trailing slash) and returns it without the slash. */
export function appOrigin(value) {
  const raw = value === undefined || value === '' ? 'http://localhost:3000' : String(value);
  let url;
  try { url = new URL(raw); } catch { throw new Error(`HON_WEBSITE_APP_URL is not a URL: ${raw}`); }
  const okShape = /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?\/?$/.test(raw);
  if (!['http:', 'https:'].includes(url.protocol) || !okShape || url.username || url.password) {
    throw new Error(`HON_WEBSITE_APP_URL must be a plain http(s) origin such as https://app.example.com, got: ${raw}`);
  }
  return url.origin;
}

/** First 10 hex characters of the file's SHA-256: changes whenever the file changes. */
function contentVersion(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 10);
}

/**
 * Adds ?v=<content hash> to the font URLs in the built CSS and to the CSS, script and font URLs in a page,
 * so the host can tell browsers to keep these files for a year and a new deploy still reaches everyone.
 */
function versionCss(out) {
  const cssPath = join(out, 'styles.css');
  const css = readFileSync(cssPath, 'utf8').replace(/url\("\/(fonts\/[^"?]+)"\)/g,
    (_, font) => `url("/${font}?v=${contentVersion(join(out, font))}")`);
  writeFileSync(cssPath, css);
}

function versionPage(html, out) {
  return html.replace(/(href|src)="\/((?:fonts\/[^"?]+\.woff2)|styles\.css|site\.js|flow\.js)"/g,
    (_, attr, file) => `${attr}="/${file}?v=${contentVersion(join(out, file))}"`);
}

export function buildSite({ outDir = join(root, 'dist'), env = process.env } = {}) {
  const app = appOrigin(env.HON_WEBSITE_APP_URL);
  const robots = env.HON_WEBSITE_INDEXABLE === '1' ? 'index, follow' : 'noindex, nofollow';
  const out = resolve(outDir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(root, 'src'), out, { recursive: true });
  rmSync(join(out, 'i18n'), { recursive: true, force: true });
  versionCss(out);
  const fill = (html, name) => {
    const done = versionPage(html.replaceAll('{{APP_URL}}', app).replaceAll('{{ROBOTS}}', robots), out);
    if (/\{\{[A-Z_]+\}\}/.test(done)) throw new Error(`${name} still has an unfilled {{PLACEHOLDER}}`);
    return done;
  };
  const english = readFileSync(join(root, 'src', 'index.html'), 'utf8');
  writeFileSync(join(out, 'index.html'), fill(markLanguage(english, 'en'), 'index.html'));
  for (const lang of LANGUAGES) {
    const dict = JSON.parse(readFileSync(join(root, 'src', 'i18n', `${lang}.json`), 'utf8'));
    mkdirSync(join(out, lang), { recursive: true });
    writeFileSync(join(out, lang, 'index.html'), fill(localize(english, dict, lang), `${lang}/index.html`));
  }
  return { outDir: out, app, robots };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { outDir, app, robots } = buildSite();
  console.log(`HON OS website built to ${outDir} (app ${app}, robots "${robots}")`);
}
