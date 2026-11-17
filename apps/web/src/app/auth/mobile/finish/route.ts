import { HON_SESSION_COOKIE, MOBILE_START_COOKIE, cookieValue, issueMobileHandoff, mobileHandoffForBrowser } from '@hon/auth';
import { NextRequest, NextResponse } from 'next/server';
import { NO_STORE, authError, cookieOptions, redirectUri, webAuthConfig } from '../../../../server/auth-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The app's fixed return address (app.json "scheme"). Never taken from the request. */
const APP_RETURN = 'honparent://auth';
const PAGE_HEADERS = {
  ...NO_STORE,
  'Content-Type': 'text/html; charset=utf-8',
  'X-Frame-Options': 'DENY',
  // form-action also governs the POST's redirect, so the app scheme must be named.
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' honparent:; frame-ancestors 'none'; base-uri 'none'",
};

type Checked = { response: NextResponse } | { identity: ReturnType<typeof mobileHandoffForBrowser>['identity']; challenge: string; callback: string };

function check(request: NextRequest): Checked {
  let config;
  let callback: string;
  try { config = webAuthConfig(); callback = redirectUri(request, config); }
  catch { return { response: authError('IDENTITY_NOT_CONFIGURED', 'HON authentication is not configured. Contact the application operator.', 503) }; }
  const cookies = request.headers.get('cookie');
  try {
    const { identity, challenge } = mobileHandoffForBrowser(cookieValue(cookies, HON_SESSION_COOKIE), cookieValue(cookies, MOBILE_START_COOKIE), config);
    return { identity, challenge, callback };
  } catch {
    return { response: authError('MOBILE_SIGN_IN_INVALID', 'Open sign-in again from the HON Parent app.', 401) };
  }
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/**
 * M2: after the normal web sign-in the parent sees who they are signed in as and must press Continue. A GET never
 * hands anything to the app, so a link to /auth/mobile/start cannot silently send a code to whatever app claims the
 * custom scheme (RFC 8252 section 8.1).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const checked = check(request);
  if ('response' in checked) return checked.response;
  const name = escapeHtml(checked.identity.displayName ?? checked.identity.email ?? 'your HON account');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Continue to the HON Parent app</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#111}button{font:inherit;padding:.75rem 1.25rem;border-radius:.5rem;border:0;background:#111;color:#fff}p.small{color:#555;font-size:.9rem}</style></head>
<body><h1>Continue to the HON Parent app?</h1><p>You are signed in as <strong>${name}</strong>.</p>
<form method="post" action="/auth/mobile/finish"><button type="submit">Continue</button></form>
<p class="small">Only continue if you just tapped Sign in in the HON Parent app on this phone. If you did not, close this page.</p></body></html>`;
  return new NextResponse(html, { status: 200, headers: PAGE_HEADERS });
}

/**
 * The parent pressed Continue on HON's own page: hand the identity back to the app as a one-minute code bound to the
 * app's PKCE challenge. Only the app holding the verifier can exchange it (POST /v1/auth/mobile/session).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const checked = check(request);
  if ('response' in checked) return checked.response;
  // Same rule as sign-out: the browser-set Origin must be HON's own, or null/absent only when Fetch Metadata says
  // same-origin (the confirmation page uses Referrer-Policy no-referrer). Session cookies are SameSite=None.
  const origin = new URL(checked.callback).origin;
  const requestOrigin = request.headers.get('origin');
  const sameOrigin = requestOrigin === origin
    || ((requestOrigin === null || requestOrigin === 'null') && request.headers.get('sec-fetch-site') === 'same-origin');
  if (!sameOrigin) return authError('MOBILE_SIGN_IN_INVALID', 'Continue from the HON sign-in page.', 403);
  try {
    const code = issueMobileHandoff(checked.identity, checked.challenge, webAuthConfig());
    const response = new NextResponse(null, { status: 303, headers: { ...NO_STORE, Location: `${APP_RETURN}?code=${encodeURIComponent(code)}` } });
    response.cookies.set(MOBILE_START_COOKIE, '', { ...cookieOptions(checked.callback, '/auth'), maxAge: 0 });
    return response;
  } catch {
    return authError('IDENTITY_NOT_CONFIGURED', 'HON authentication is not configured. Contact the application operator.', 503);
  }
}
