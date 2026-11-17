import { HON_SESSION_COOKIE, MOBILE_START_COOKIE, cookieValue, issueMobileHandoff, verifyMobileStart, verifySession } from '@hon/auth';
import { NextRequest, NextResponse } from 'next/server';
import { NO_STORE, authError, cookieOptions, redirectUri, webAuthConfig } from '../../../../server/auth-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The app's fixed return address (app.json "scheme"). Never taken from the request. */
const APP_RETURN = 'honparent://auth';

/**
 * M2: after the normal web sign-in, hand the signed-in identity back to the app as a one-minute code bound to the
 * app's PKCE challenge. Only the app holding the verifier can exchange it (POST /v1/auth/mobile/session).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  let callback = 'https://invalid.example/auth/callback';
  try {
    const config = webAuthConfig();
    callback = redirectUri(request, config);
    const cookies = request.headers.get('cookie');
    let challenge: string;
    try { challenge = verifyMobileStart(cookieValue(cookies, MOBILE_START_COOKIE), config); }
    catch { return authError('MOBILE_SIGN_IN_INVALID', 'Open sign-in again from the HON Parent app.', 400); }
    let identity;
    try {
      const token = cookieValue(cookies, HON_SESSION_COOKIE);
      if (!token) throw new Error();
      const { emailVerified: _drop, ...rest } = verifySession(token, config);
      identity = rest;
    } catch { return authError('MOBILE_SIGN_IN_INVALID', 'Sign in again from the HON Parent app.', 401); }
    const response = NextResponse.redirect(`${APP_RETURN}?code=${encodeURIComponent(issueMobileHandoff(identity, challenge, config))}`, { status: 303, headers: NO_STORE });
    response.cookies.set(MOBILE_START_COOKIE, '', { ...cookieOptions(callback, '/auth'), maxAge: 0 });
    return response;
  } catch {
    return authError('IDENTITY_NOT_CONFIGURED', 'HON authentication is not configured. Contact the application operator.', 503);
  }
}
