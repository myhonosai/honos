import { NextRequest, NextResponse } from 'next/server';
import { emitWebTelemetry } from '../../../server/web-telemetry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Browser error reports (from the global error boundary). Same-origin only, tiny, fixed schema:
// an error name, a Next.js digest and the page path. Messages are not accepted from browsers.
const MAX_BYTES = 2048;
const PER_MINUTE = 120;
let budget = { start: 0, count: 0 };

const accepted = () => new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Browsers mark cross-site requests; refuse anything that is not explicitly same-origin.
  if (request.headers.get('sec-fetch-site') !== 'same-origin') return new NextResponse(null, { status: 403 });
  const now = Date.now();
  if (now - budget.start >= 60_000) budget = { start: now, count: 0 };
  if (++budget.count > PER_MINUTE) return accepted();
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isFinite(declared) || declared > MAX_BYTES) return new NextResponse(null, { status: 413 });
  const raw = await request.text();
  if (raw.length > MAX_BYTES) return new NextResponse(null, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return new NextResponse(null, { status: 400 }); }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return new NextResponse(null, { status: 400 });
  const report = body as Record<string, unknown>;
  const allowed = new Set(['kind', 'name', 'digest', 'path']);
  if (Object.keys(report).some((key) => !allowed.has(key)) || (report.kind !== 'render' && report.kind !== 'unhandled')) return new NextResponse(null, { status: 400 });
  emitWebTelemetry('error', 'web.client_error', {
    source: report.kind,
    route: typeof report.path === 'string' ? report.path : 'unknown',
    ...(typeof report.digest === 'string' ? { digest: report.digest } : {}),
    ...(typeof report.name === 'string' ? { errorName: report.name } : {}),
  });
  return accepted();
}
