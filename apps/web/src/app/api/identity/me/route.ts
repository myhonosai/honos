import { HON_SESSION_COOKIE, MANUS_SESSION_COOKIE, SESSION_SECONDS, AuthConfigurationError, cookieValue, issueSession, sessionConfig, verifyManusSession, verifySession, manusConfig, publicOrigin } from '@hon/auth';
import { NextRequest, NextResponse } from 'next/server';
import { NO_STORE, authError, cookieOptions } from '../../../../server/auth-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const config = sessionConfig();
    const token = cookieValue(request.headers.get('cookie'), HON_SESSION_COOKIE);
    if (token) {
      const { emailVerified: _proof, ...identity } = verifySession(token, config);
      return NextResponse.json({ data: identity }, { headers: NO_STORE });
    }
    // Rolling development-session migration only. A present but invalid HON cookie never falls back.
    const legacy = config.mode === 'MANUS_DEVELOPMENT' ? cookieValue(request.headers.get('cookie'), MANUS_SESSION_COOKIE) : undefined;
    if (!legacy) return authError('UNAUTHENTICATED', 'HON requires an authenticated application session.', 401);
    const identity = verifyManusSession(legacy, manusConfig());
    const response = NextResponse.json({ data: identity }, { headers: NO_STORE });
    response.cookies.set(HON_SESSION_COOKIE, issueSession(identity, config), { ...cookieOptions(publicOrigin(request.headers)), maxAge: SESSION_SECONDS });
    return response;
  } catch (error) {
    return error instanceof AuthConfigurationError
      ? authError('IDENTITY_NOT_CONFIGURED', 'HON application identity validation is not configured.', 503)
      : authError('UNAUTHENTICATED', 'HON could not validate the application session.', 401);
  }
}
