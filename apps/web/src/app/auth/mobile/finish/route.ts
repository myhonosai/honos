import type { NextRequest, NextResponse } from 'next/server';
import { FAMILY_APP, mobileFinishContinue, mobileFinishPage } from '../../../../server/mobile-handoff';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** M2: the HON Family app's confirmation page (GET) and Continue (POST). Shared logic in server/mobile-handoff.ts. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return mobileFinishPage(FAMILY_APP, request);
}
export async function POST(request: NextRequest): Promise<NextResponse> {
  return mobileFinishContinue(FAMILY_APP, request);
}
