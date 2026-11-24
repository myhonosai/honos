import type { NextRequest, NextResponse } from 'next/server';
import { FAMILY_APP, mobileStart } from '../../../../server/mobile-handoff';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** M2: the HON Family app's sign-in start. Shared logic in server/mobile-handoff.ts. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return mobileStart(FAMILY_APP, request);
}
