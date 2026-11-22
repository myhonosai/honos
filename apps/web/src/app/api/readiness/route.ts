import { authReadiness } from '@hon/auth';
import { NextResponse } from 'next/server';
import { NO_STORE } from '../../../server/auth-http';
import { probeApiReadiness } from '../../../server/api-readiness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Hosting health check (review [24]): ready only when sign-in is configured AND the private API answers its own
 * readiness, which requires a verified runtime-database connection. Identity is checked first and, when it is not
 * configured, no network request is made. The answer holds closed codes only.
 */
export async function GET(): Promise<NextResponse> {
  const identity = authReadiness();
  const api = identity.ready ? await probeApiReadiness() : 'NOT_CHECKED';
  const ready = identity.ready && api === 'READY';
  return NextResponse.json({ data: { ready, identity: identity.code, api } }, { status: ready ? 200 : 503, headers: NO_STORE });
}
