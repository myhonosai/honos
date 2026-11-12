// Builds the static HON OS marketing site: copies src/ to dist/ and fills in the build-time values.
//   HON_WEBSITE_APP_URL   origin of the HON OS app (default http://localhost:3000)
//   HON_WEBSITE_INDEXABLE set to 1 only when the site is approved to go live; otherwise pages are noindex.
import { cpSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
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

export function buildSite({ outDir = join(root, 'dist'), env = process.env } = {}) {
  const app = appOrigin(env.HON_WEBSITE_APP_URL);
  const robots = env.HON_WEBSITE_INDEXABLE === '1' ? 'index, follow' : 'noindex, nofollow';
  const out = resolve(outDir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(root, 'src'), out, { recursive: true });
  rmSync(join(out, 'i18n'), { recursive: true, force: true });
  const fill = (html, name) => {
    const done = html.replaceAll('{{APP_URL}}', app).replaceAll('{{ROBOTS}}', robots);
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
