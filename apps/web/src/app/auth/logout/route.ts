import { AUTH_TRANSACTION_COOKIE, HON_SESSION_COOKIE, MANUS_SESSION_COOKIE, oidcLogoutUrl, publicOrigin } from '@hon/auth';
import { NextRequest, NextResponse } from 'next/server';
import { NO_STORE, authError, cookieOptions, webAuthConfig } from '../../../server/auth-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The application's own origin, taken from protected configuration (never from the request) in OIDC mode,
 * and the provider logout address to continue to, if one is configured.
 */
function signOutTarget(request: NextRequest): { origin: string; providerLogout: string | null } {
  try {
    const config = webAuthConfig();
    if (config.mode !== 'OIDC') return { origin: publicOrigin(request.headers), providerLogout: null };
    return { origin: new URL(config.redirectUri).origin, providerLogout: oidcLogoutUrl(config)?.href ?? null };
  } catch {
    // Sign-out must still work when sign-in is misconfigured; publicOrigin has its own validation.
    return { origin: publicOrigin(request.headers), providerLogout: null };
  }
}

/**
 * Ends the HON session in this browser by expiring the session cookies. POST only (a link or image
 * cannot sign someone out) and only from HON's own pages: the browser-set Origin must match, or be
 * null/absent with Sec-Fetch-Site: same-origin (no-referrer pages).
 * When HON_OIDC_END_SESSION_ENDPOINT is configured, the browser then continues to the provider's logout,
 * which returns to HON's home page; otherwise the provider session stays and the next sign-in may skip
 * the provider prompt (and silently sign the same account back in).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let origin: string;
  let providerLogout: string | null;
  try {
    ({ origin, providerLogout } = signOutTarget(request));
  } catch {
    return authError('SIGN_OUT_REJECTED', 'HON could not verify this sign-out request.', 400);
  }
  // Pages with Referrer-Policy no-referrer make the browser send `Origin: null` even for same-origin
  // form posts. Fetch Metadata is browser-set and unaffected by referrer policy, so accept a null or
  // missing Origin only when the browser itself reports the request as same-origin.
  const requestOrigin = request.headers.get('origin');
  const sameOrigin = requestOrigin === origin
    || ((requestOrigin === null || requestOrigin === 'null') && request.headers.get('sec-fetch-site') === 'same-origin');
  if (!sameOrigin) {
    return authError('SIGN_OUT_REJECTED', 'Sign out from a HON page.', 403);
  }
  // Neither Location can be influenced by Host, forwarding headers or query input: the provider logout
  // comes from protected config, and the fallback is a fixed relative path.
  const response = new NextResponse(null, { status: 303, headers: { ...NO_STORE, Location: providerLogout ?? '/' } });
  response.cookies.set(HON_SESSION_COOKIE, '', { ...cookieOptions(origin), maxAge: 0 });
  response.cookies.set(MANUS_SESSION_COOKIE, '', { ...cookieOptions(origin), maxAge: 0 });
  response.cookies.set(AUTH_TRANSACTION_COOKIE, '', { ...cookieOptions(origin, '/auth'), maxAge: 0 });
  return response;
}
