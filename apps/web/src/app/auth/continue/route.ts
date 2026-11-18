import { HON_SESSION_COOKIE, cookieValue, sessionConfig, verifySession } from '@hon/auth';
import { NextRequest, NextResponse } from 'next/server';
import { NO_STORE, cookieOptions, redirectUri, webAuthConfig } from '../../../server/auth-http';
import { POST_LOGIN_INTENTS, POST_LOGIN_INTENT_COOKIE, postLoginIntent, type PostLoginIntentPath } from '../../../server/post-login-intent';
import { resolvePostLoginDestination, type PostLoginDestination } from '../../../server/post-login-routing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function destination(path: PostLoginDestination | PostLoginIntentPath, request?: NextRequest): NextResponse {
  // A fixed relative Location cannot be influenced by Host, forwarding headers or query input.
  const response = new NextResponse(null, { status: 303, headers: { ...NO_STORE, 'X-Robots-Tag': 'noindex, nofollow', Location: path } });
  // A sign-in intent is used at most once: whatever happens here, it is cleared.
  if (request?.cookies.has(POST_LOGIN_INTENT_COOKIE)) {
    let origin: string | undefined;
    try { origin = redirectUri(request, webAuthConfig()); } catch { origin = undefined; }
    response.cookies.set(POST_LOGIN_INTENT_COOKIE, '', { ...cookieOptions(origin, '/auth'), maxAge: 0 });
  }
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  let token: string;
  try {
    const value = cookieValue(request.headers.get('cookie'), HON_SESSION_COOKIE);
    if (!value) return destination('/auth/login', request);
    verifySession(value, sessionConfig());
    token = value;
  } catch {
    return destination('/auth/login', request);
  }
  // No return URL, school, family, role or other selector is accepted by this fixed route.
  if (request.nextUrl.search) return destination('/auth/access', request);
  // A sign-in that started from a fixed page (the parent portal or a family invitation) returns there.
  // Only the cookie's fixed name is read; that page still authorizes everything itself.
  const intent = postLoginIntent(request.cookies.get(POST_LOGIN_INTENT_COOKIE)?.value);
  if (intent) return destination(POST_LOGIN_INTENTS[intent], request);
  const next = await resolvePostLoginDestination(token);
  try { verifySession(token, sessionConfig()); } catch { return destination('/auth/login', request); }
  return destination(next, request);
}
