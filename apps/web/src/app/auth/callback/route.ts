import { timingSafeEqual } from 'node:crypto';
import { sign } from 'jsonwebtoken';
import { NextRequest, NextResponse } from 'next/server';

interface OAuthTokenResponse { accessToken?: string; }
interface UserInfoResponse { openId?: string; name?: string; email?: string; }

function publicOrigin(request: NextRequest): string {
  const forwardedHost = request.headers.get('x-forwarded-host');
  const host = forwardedHost ?? request.headers.get('host');
  const protocol = request.headers.get('x-forwarded-proto') ?? 'https';
  if (!host || !/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(host)) throw new Error('HON could not determine a safe application origin.');
  return `${protocol === 'http' ? 'http' : 'https'}://${host}`;
}

function validNonce(expected: string | undefined, received: unknown): boolean {
  if (!expected || typeof received !== 'string') return false;
  const left = Buffer.from(expected); const right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const encodedState = url.searchParams.get('state');
  const projectId = process.env.MANUS_PROJECT_ID;
  const apiUrl = process.env.MANUS_OAUTH_API_URL;
  const jwtSecret = process.env.MANUS_JWT_SECRET;
  if (!code || !encodedState || !projectId || !apiUrl || !jwtSecret) return NextResponse.json({ code: 'OAUTH_CALLBACK_INVALID', detail: 'HON could not complete the account sign-in.' }, { status: 400 });
  let state: { redirectUri?: unknown; nonce?: unknown };
  try { state = JSON.parse(Buffer.from(encodedState, 'base64url').toString('utf8')) as { redirectUri?: unknown; nonce?: unknown }; } catch { return NextResponse.json({ code: 'OAUTH_STATE_INVALID', detail: 'HON rejected an invalid sign-in state.' }, { status: 400 }); }
  const expectedRedirect = `${publicOrigin(request)}/auth/callback`;
  if (state.redirectUri !== expectedRedirect || !validNonce(request.cookies.get('hon_oauth_nonce')?.value, state.nonce)) return NextResponse.json({ code: 'OAUTH_STATE_INVALID', detail: 'HON rejected an unbound sign-in request.' }, { status: 400 });
  try {
    const tokenResponse = await fetch(`${apiUrl}/webdev.v1.WebDevAuthPublicService/ExchangeToken`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify({ clientId: projectId, grantType: 'authorization_code', code, redirectUri: expectedRedirect }) });
    if (!tokenResponse.ok) throw new Error('Token exchange failed.');
    const tokens = await tokenResponse.json() as OAuthTokenResponse;
    if (!tokens.accessToken) throw new Error('OAuth token response did not contain an access token.');
    const infoResponse = await fetch(`${apiUrl}/webdev.v1.WebDevAuthPublicService/GetUserInfo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify({ accessToken: tokens.accessToken }) });
    if (!infoResponse.ok) throw new Error('User info lookup failed.');
    const info = await infoResponse.json() as UserInfoResponse;
    if (!info.openId || !info.email || !info.name) throw new Error('Verified account profile is incomplete.');
    const session = sign({ appId: projectId, openId: info.openId, name: info.name, email: info.email }, jwtSecret, { algorithm: 'HS256', expiresIn: '12h' });
    const response = NextResponse.redirect(new URL('/hq', expectedRedirect));
    response.cookies.set('webdev_app_session', session, { httpOnly: true, secure: true, sameSite: 'none', path: '/', maxAge: 43_200 });
    response.cookies.set('hon_oauth_nonce', '', { httpOnly: true, secure: true, sameSite: 'none', path: '/', maxAge: 0 });
    return response;
  } catch {
    return NextResponse.json({ code: 'OAUTH_IDENTITY_UNAVAILABLE', detail: 'HON could not verify the Manus account. Return to /auth/login and try again.' }, { status: 503 });
  }
}
