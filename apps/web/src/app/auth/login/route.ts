import { randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

function publicOrigin(request: NextRequest): string {
  const forwardedHost = request.headers.get('x-forwarded-host');
  const host = forwardedHost ?? request.headers.get('host');
  const protocol = request.headers.get('x-forwarded-proto') ?? 'https';
  if (!host || !/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(host)) throw new Error('HON could not determine a safe application origin.');
  return `${protocol === 'http' ? 'http' : 'https'}://${host}`;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const projectId = process.env.MANUS_PROJECT_ID;
  const portalUrl = process.env.MANUS_OAUTH_PORTAL_URL;
  if (!projectId || !portalUrl) return NextResponse.json({ code: 'IDENTITY_NOT_CONFIGURED', detail: 'HON OAuth is not configured.' }, { status: 503 });
  const redirectUri = `${publicOrigin(request)}/auth/callback`;
  const nonce = randomBytes(32).toString('base64url');
  const state = Buffer.from(JSON.stringify({ redirectUri, nonce })).toString('base64url');
  const authorization = new URL('/app-auth', portalUrl);
  authorization.searchParams.set('appId', projectId);
  authorization.searchParams.set('redirectUri', redirectUri);
  authorization.searchParams.set('state', state);
  authorization.searchParams.set('responseType', 'code');
  const response = NextResponse.redirect(authorization);
  response.cookies.set('hon_oauth_nonce', nonce, { httpOnly: true, secure: true, sameSite: 'none', path: '/', maxAge: 600 });
  return response;
}
