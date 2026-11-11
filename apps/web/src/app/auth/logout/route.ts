import { AUTH_TRANSACTION_COOKIE, HON_SESSION_COOKIE, MANUS_SESSION_COOKIE, publicOrigin } from '@hon/auth';
import { NextRequest, NextResponse } from 'next/server';
import { NO_STORE, authError, cookieOptions, webAuthConfig } from '../../../server/auth-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The application's own origin, taken from protected configuration (never from the request) in OIDC mode. */
function applicationOrigin(request: NextRequest): string {
  try {
    const config = webAuthConfig();
    return config.mode === 'OIDC' ? new URL(config.redirectUri).origin : publicOrigin(request.headers);
  } catch {
    // Sign-out must still work when sign-in is misconfigured; publicOrigin has its own validation.
    return publicOrigin(request.headers);
  }
}

/**
 * Ends the HON session in this browser by expiring the session cookies. POST only (a link or image
 * cannot sign someone out) and only from HON's own pages: the browser-set Origin must match.
 * The identity provider's own session is left alone; the next sign-in may skip the provider prompt.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let origin: string;
  try {
    origin = applicationOrigin(request);
  } catch {
    return authError('SIGN_OUT_REJECTED', 'HON could not verify this sign-out request.', 400);
  }
  if (request.headers.get('origin') !== origin) {
    return authError('SIGN_OUT_REJECTED', 'Sign out from a HON page.', 403);
  }
  // A fixed relative Location cannot be influenced by Host, forwarding headers or query input.
  const response = new NextResponse(null, { status: 303, headers: { ...NO_STORE, Location: '/' } });
  response.cookies.set(HON_SESSION_COOKIE, '', { ...cookieOptions(origin), maxAge: 0 });
  response.cookies.set(MANUS_SESSION_COOKIE, '', { ...cookieOptions(origin), maxAge: 0 });
  response.cookies.set(AUTH_TRANSACTION_COOKIE, '', { ...cookieOptions(origin, '/auth'), maxAge: 0 });
  return response;
}
