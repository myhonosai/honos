const DEFAULT_WEBSITE_ORIGIN = 'https://myhonos.com';

/**
 * The public HON OS website, where the Privacy Policy and Terms of Service live. Set HON_WEBSITE_ORIGIN to a plain
 * http(s) origin to change it; anything else (a path, credentials, another scheme, stray spaces) falls back to the default.
 */
export function websiteOrigin(): string {
  const raw = process.env.HON_WEBSITE_ORIGIN;
  if (!raw || !/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?\/?$/.test(raw)) return DEFAULT_WEBSITE_ORIGIN;
  try { return new URL(raw).origin; } catch { return DEFAULT_WEBSITE_ORIGIN; }
}

/** A permanent redirect to one page of the website. */
export function websiteRedirect(path: '/privacy/' | '/terms/'): Response {
  return new Response(null, { status: 308, headers: { Location: `${websiteOrigin()}${path}`, 'Cache-Control': 'public, max-age=3600' } });
}
