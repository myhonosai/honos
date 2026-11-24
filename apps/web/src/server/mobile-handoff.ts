import {
  HON_SESSION_COOKIE, MOBILE_START_COOKIE, MOBILE_START_SECONDS, STAFF_MOBILE_START_COOKIE, cookieValue, issueMobileHandoff,
  issueMobileStart, issueStaffMobileHandoff, issueStaffMobileStart, mobileHandoffForBrowser, staffMobileHandoffForBrowser, type NormalizedIdentity,
} from '@hon/auth';
import { NextRequest, NextResponse } from 'next/server';
import { NO_STORE, authError, cookieOptions, redirectUri, webAuthConfig } from './auth-http';

/**
 * The web side of native app sign-in, shared by the HON Family app (M2, /auth/mobile/*) and the HON Staff app
 * (S0, /auth/staff-mobile/*). Each app has its own start cookie, token family, login intent and fixed return
 * address, so a sign-in started by one app can never finish in the other.
 */
type MobileApp = {
  name: string;
  basePath: '/auth/mobile' | '/auth/staff-mobile';
  intent: 'mobile' | 'staff-mobile';
  startCookie: string;
  /** The app's fixed return address (app.json "scheme"). Never taken from the request. */
  scheme: 'honparent' | 'honstaff';
  issueStart: (challenge: string, config: ReturnType<typeof webAuthConfig>) => string;
  forBrowser: (session: string | undefined, start: string | undefined, config: ReturnType<typeof webAuthConfig>) => { identity: NormalizedIdentity; challenge: string };
  issueHandoff: (identity: NormalizedIdentity, challenge: string, config: ReturnType<typeof webAuthConfig>) => string;
};

export const FAMILY_APP: MobileApp = {
  name: 'HON Family', basePath: '/auth/mobile', intent: 'mobile', startCookie: MOBILE_START_COOKIE, scheme: 'honparent',
  issueStart: (c, config) => issueMobileStart(c, config), forBrowser: (s, t, config) => mobileHandoffForBrowser(s, t, config),
  issueHandoff: (i, c, config) => issueMobileHandoff(i, c, config),
};
export const STAFF_APP: MobileApp = {
  name: 'HON Staff', basePath: '/auth/staff-mobile', intent: 'staff-mobile', startCookie: STAFF_MOBILE_START_COOKIE, scheme: 'honstaff',
  issueStart: (c, config) => issueStaffMobileStart(c, config), forBrowser: (s, t, config) => staffMobileHandoffForBrowser(s, t, config),
  issueHandoff: (i, c, config) => issueStaffMobileHandoff(i, c, config),
};

const NOT_CONFIGURED = () => authError('IDENTITY_NOT_CONFIGURED', 'HON authentication is not configured. Contact the application operator.', 503);

/** The app opens this in the system browser with its PKCE challenge. Only the challenge is kept (signed, 10 minutes, path /auth). */
export function mobileStart(app: MobileApp, request: NextRequest): NextResponse {
  const values = request.nextUrl.searchParams.getAll('challenge');
  if (values.length !== 1 || [...request.nextUrl.searchParams.keys()].length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(values[0]!)) {
    return authError('MOBILE_SIGN_IN_INVALID', `Open sign-in again from the ${app.name} app.`, 400);
  }
  try {
    const config = webAuthConfig();
    const callback = redirectUri(request, config);
    const response = NextResponse.redirect(new URL(`/auth/login?for=${app.intent}`, callback), { headers: NO_STORE });
    response.cookies.set(app.startCookie, app.issueStart(values[0]!, config), { ...cookieOptions(callback, '/auth'), maxAge: MOBILE_START_SECONDS });
    return response;
  } catch {
    return NOT_CONFIGURED();
  }
}

type Checked = { response: NextResponse } | { identity: NormalizedIdentity; challenge: string; callback: string };

function check(app: MobileApp, request: NextRequest): Checked {
  let config;
  let callback: string;
  try { config = webAuthConfig(); callback = redirectUri(request, config); }
  catch { return { response: NOT_CONFIGURED() }; }
  const cookies = request.headers.get('cookie');
  try {
    const { identity, challenge } = app.forBrowser(cookieValue(cookies, HON_SESSION_COOKIE), cookieValue(cookies, app.startCookie), config);
    return { identity, challenge, callback };
  } catch {
    return { response: authError('MOBILE_SIGN_IN_INVALID', `Open sign-in again from the ${app.name} app.`, 401) };
  }
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const pageHeaders = (app: MobileApp) => ({
  ...NO_STORE,
  'Content-Type': 'text/html; charset=utf-8',
  'X-Frame-Options': 'DENY',
  // form-action also governs the POST's redirect, so the app scheme must be named.
  'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${app.scheme}:; frame-ancestors 'none'; base-uri 'none'`,
});

/**
 * After the normal web sign-in the person sees who they are signed in as and must press Continue. A GET never hands
 * anything to the app, so a link to the start page cannot silently send a code to whatever app claims the custom
 * scheme (RFC 8252 section 8.1).
 */
export function mobileFinishPage(app: MobileApp, request: NextRequest): NextResponse {
  const checked = check(app, request);
  if ('response' in checked) return checked.response;
  const name = escapeHtml(checked.identity.displayName ?? checked.identity.email ?? 'your HON account');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Continue to the ${app.name} app</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#111}button{font:inherit;padding:.75rem 1.25rem;border-radius:.5rem;border:0;background:#111;color:#fff}p.small{color:#555;font-size:.9rem}</style></head>
<body><h1>Continue to the ${app.name} app?</h1><p>You are signed in as <strong>${name}</strong>.</p>
<form method="post" action="${app.basePath}/finish"><button type="submit">Continue</button></form>
<p class="small">Only continue if you just tapped Sign in in the ${app.name} app on this phone. If you did not, close this page.</p></body></html>`;
  return new NextResponse(html, { status: 200, headers: pageHeaders(app) });
}

/**
 * The person pressed Continue on HON's own page: hand the identity back to the app as a one-minute code bound to the
 * app's PKCE challenge. Only the app holding the verifier can exchange it.
 */
export function mobileFinishContinue(app: MobileApp, request: NextRequest): NextResponse {
  const checked = check(app, request);
  if ('response' in checked) return checked.response;
  // Same rule as sign-out: the browser-set Origin must be HON's own, or null/absent only when Fetch Metadata says
  // same-origin (the confirmation page uses Referrer-Policy no-referrer). Session cookies are SameSite=None.
  const origin = new URL(checked.callback).origin;
  const requestOrigin = request.headers.get('origin');
  const sameOrigin = requestOrigin === origin
    || ((requestOrigin === null || requestOrigin === 'null') && request.headers.get('sec-fetch-site') === 'same-origin');
  if (!sameOrigin) return authError('MOBILE_SIGN_IN_INVALID', 'Continue from the HON sign-in page.', 403);
  try {
    const code = app.issueHandoff(checked.identity, checked.challenge, webAuthConfig());
    const response = new NextResponse(null, { status: 303, headers: { ...NO_STORE, Location: `${app.scheme}://auth?code=${encodeURIComponent(code)}` } });
    response.cookies.set(app.startCookie, '', { ...cookieOptions(checked.callback, '/auth'), maxAge: 0 });
    return response;
  } catch {
    return NOT_CONFIGURED();
  }
}
