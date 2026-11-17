import { MOBILE_START_COOKIE, MOBILE_START_SECONDS, issueMobileStart } from '@hon/auth';
import { NextRequest, NextResponse } from 'next/server';
import { NO_STORE, authError, cookieOptions, redirectUri, webAuthConfig } from '../../../../server/auth-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * M2: the HON Parent app opens this in the system browser with its PKCE challenge. Only the challenge is kept
 * (signed, 10 minutes, path /auth); the parent then signs in through the normal web OIDC flow.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const values = request.nextUrl.searchParams.getAll('challenge');
  if (values.length !== 1 || [...request.nextUrl.searchParams.keys()].length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(values[0]!)) {
    return authError('MOBILE_SIGN_IN_INVALID', 'Open sign-in again from the HON Parent app.', 400);
  }
  try {
    const config = webAuthConfig();
    const callback = redirectUri(request, config);
    const response = NextResponse.redirect(new URL('/auth/login?for=mobile', callback), { headers: NO_STORE });
    response.cookies.set(MOBILE_START_COOKIE, issueMobileStart(values[0]!, config), { ...cookieOptions(callback, '/auth'), maxAge: MOBILE_START_SECONDS });
    return response;
  } catch {
    return authError('IDENTITY_NOT_CONFIGURED', 'HON authentication is not configured. Contact the application operator.', 503);
  }
}
