import { HON_SESSION_COOKIE, cookieValue, sessionConfig, verifySession } from '@hon/auth';
import { NextRequest, NextResponse } from 'next/server';
import { NO_STORE } from '../../../server/auth-http';
import { resolvePostLoginDestination, type PostLoginDestination } from '../../../server/post-login-routing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function destination(path: PostLoginDestination): NextResponse {
  // A fixed relative Location cannot be influenced by Host, forwarding headers or query input.
  return new NextResponse(null, { status: 303, headers: { ...NO_STORE, 'X-Robots-Tag': 'noindex, nofollow', Location: path } });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  let token: string;
  try {
    const value = cookieValue(request.headers.get('cookie'), HON_SESSION_COOKIE);
    if (!value) return destination('/auth/login');
    verifySession(value, sessionConfig());
    token = value;
  } catch {
    return destination('/auth/login');
  }
  // No return URL, school, family, role or other selector is accepted by this fixed route.
  if (request.nextUrl.search) return destination('/auth/access');
  const next = await resolvePostLoginDestination(token);
  try { verifySession(token, sessionConfig()); } catch { return destination('/auth/login'); }
  return destination(next);
}
