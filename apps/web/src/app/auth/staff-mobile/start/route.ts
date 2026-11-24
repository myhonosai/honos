import type { NextRequest, NextResponse } from 'next/server';
import { STAFF_APP, mobileStart } from '../../../../server/mobile-handoff';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** S0: the HON Staff app's sign-in start. Shared logic in server/mobile-handoff.ts. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return mobileStart(STAFF_APP, request);
}
