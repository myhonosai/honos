// Translates the English page into another language from a phrase dictionary (src/i18n/<lang>.json).
// Keys are the exact English text (whitespace collapsed). Three kinds of keys:
//   - a text segment between tags, e.g. "Pricing"
//   - an attribute value (alt, aria-label, meta content, title text)
//   - the whole inner HTML of an element marked data-t, for sentences with inline markup
// Every English segment with a Latin letter must have a translation; build and tests fail otherwise,
// so English copy can't change without the Korean and Spanish pages being updated too.

const LETTER = /[A-Za-z]/;
const TRANSLATED_ATTRS = ['alt', 'aria-label'];
const META_NAMES = /^(description|og:title|og:description)$/;
const DATA_T = /<(\w+)(\s[^>]*?\sdata-t(?:\s[^>]*)?|\sdata-t(?:\s[^>]*)?)>([\s\S]*?)<\/\1>/g;

const norm = (s) => s.replace(/\s+/g, ' ').trim();

/** Calls visit(kind, key, replaceFn) for every translatable piece and returns the rewritten HTML. */
function walk(html, visit) {
  const blocks = [];
  // 1. whole-element translations
  let out = html.replace(DATA_T, (m, tag, attrs, inner) => {
    const key = norm(inner);
    const val = visit('html', key);
    blocks.push(`<${tag}${attrs}>${val ?? inner}</${tag}>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  // 2. protect scripts and styles
  const raw = [];
  out = out.replace(/<(script|style)\b[\s\S]*?<\/\1>/g, (m) => { raw.push(m); return `\u0001${raw.length - 1}\u0001`; });
  // 3. <title>
  out = out.replace(/<title>([^<]*)<\/title>/, (m, t) => { raw.push(`<title>${visit('attr', norm(t)) ?? t}</title>`); return `\u0001${raw.length - 1}\u0001`; });
  // 4. attributes and meta content
  out = out.replace(/<[a-zA-Z][^>]*>/g, (tag) => {
    let t = tag;
    for (const a of TRANSLATED_ATTRS) {
      t = t.replace(new RegExp(`(\\s${a}=")([^"]*)(")`), (m, p, v, q) => (LETTER.test(v) ? p + (visit('attr', norm(v)) ?? v) + q : m));
    }
    if (/^<meta\b/.test(t)) {
      const name = t.match(/\s(?:name|property)="([^"]+)"/)?.[1] ?? '';
      if (META_NAMES.test(name)) t = t.replace(/(\scontent=")([^"]*)(")/, (m, p, v, q) => p + (visit('attr', norm(v)) ?? v) + q);
    }
    return t;
  });
  // 5. text nodes
  out = out.replace(/>([^<\u0000\u0001]+)</g, (m, text) => {
    if (!LETTER.test(text)) return m;
    const lead = text.match(/^\s*/)[0], trail = text.match(/\s*$/)[0];
    const val = visit('text', norm(text));
    return `>${lead}${val ?? norm(text)}${trail}<`;
  });
  out = out.replace(/\u0001(\d+)\u0001/g, (m, i) => raw[Number(i)]);
  out = out.replace(/\u0000(\d+)\u0000/g, (m, i) => blocks[Number(i)]);
  return out;
}

/** English keys the page needs translated. */
export function phrases(html) {
  const keys = new Set();
  walk(html, (kind, key) => { if (LETTER.test(key)) keys.add(key); return undefined; });
  return [...keys];
}

/** Returns the page in `lang`, or throws listing every phrase the dictionary lacks. */
export function localize(html, dict, lang) {
  const missing = [];
  let out = walk(html, (kind, key) => {
    if (!LETTER.test(key)) return undefined;
    if (!(key in dict)) { missing.push(key); return undefined; }
    return dict[key];
  });
  if (missing.length) throw new Error(`${lang}: ${missing.length} untranslated phrase(s):\n  ${missing.join('\n  ')}`);
  out = out.replace(/<html lang="en">/, `<html lang="${lang}">`);
  return markLanguage(out, lang);
}

/** Marks the current language in the switcher. */
export function markLanguage(html, lang) {
  return html.replace(new RegExp(`(<a\\b[^>]*\\sdata-lang="${lang}")`, 'g'), '$1 aria-current="page"');
}
