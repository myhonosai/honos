import { authReadiness } from '@hon/auth';
import { NextResponse } from 'next/server';
import { NO_STORE } from '../../../../server/auth-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const readiness = authReadiness();
  return NextResponse.json({ data: readiness }, { status: readiness.ready ? 200 : 503, headers: NO_STORE });
}
