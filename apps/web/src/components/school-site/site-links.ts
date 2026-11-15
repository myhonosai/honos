import { websiteHrefOk, websiteImageOk } from '@hon/contracts';

/**
 * WB3: where a site link goes. Documents only hold '', '/', '/page', '#section' or https URLs (validated in contracts and
 * SQL); anything else resolves to nothing, so a renderer bug can never turn document text into a script URL.
 */
export type SiteLink = { href: string; external: boolean } | null;

export function siteHref(value: unknown, base: string): SiteLink {
  if (typeof value !== 'string' || value === '' || !websiteHrefOk(value)) return null;
  if (value === '/') return { href: base, external: false };
  if (value.startsWith('/')) return { href: `${base}/${value.slice(1)}`, external: false };
  if (value.startsWith('#')) return { href: value, external: false };
  return { href: value, external: true };
}

export function siteImage(value: unknown): string | null {
  return typeof value === 'string' && value !== '' && websiteImageOk(value) ? value : null;
}

/** Only YouTube (privacy-enhanced host) and Vimeo players, built from a validated id. */
export function siteVideoUrl(provider: unknown, id: unknown): string | null {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{6,20}$/.test(id)) return null;
  if (provider === 'YOUTUBE') return `https://www.youtube-nocookie.com/embed/${id}`;
  if (provider === 'VIMEO' && /^[0-9]{6,20}$/.test(id)) return `https://player.vimeo.com/video/${id}`;
  return null;
}

/** UTM tags from the page address become the form's 80-character "how did you hear" note; nothing else is read. */
export function siteSourceNote(search: string, pageSlug: string): string {
  const params = new URLSearchParams(search);
  const clean = (v: string | null) => (v ?? '').replace(/[^A-Za-z0-9 _.-]/g, '').trim().slice(0, 30);
  const parts = [clean(params.get('utm_source')), clean(params.get('utm_campaign'))].filter(Boolean);
  const note = ['Website', pageSlug === 'home' ? '' : pageSlug, ...parts].filter(Boolean).join(' / ');
  return note.slice(0, 80);
}

/** Paragraph text becomes plain paragraphs on blank lines and line breaks inside; always escaped by React. */
export function siteParagraphs(text: unknown): string[][] {
  if (typeof text !== 'string' || !text.trim()) return [];
  return text.split(/\n{2,}/).map(p => p.split('\n')).filter(lines => lines.some(l => l.trim()));
}
