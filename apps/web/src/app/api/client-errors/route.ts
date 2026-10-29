import { NextRequest, NextResponse } from 'next/server';
import { emitWebTelemetry } from '../../../server/web-telemetry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Browser error reports (from the global error boundary). Same-origin only, tiny, fixed schema:
// an error name, a Next.js digest and the page path. Messages are not accepted from browsers.
// The size limit is in bytes and is enforced while reading, not after buffering.
const MAX_BYTES = 2048;
const PER_MINUTE = 120;
let budget = { start: 0, count: 0 };

const accepted = () => new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
const refused = (status: number) => new NextResponse(null, { status });

// Reads at most MAX_BYTES of the body as bytes, whatever Content-Length claims, and cancels the
// stream as soon as the limit is passed. Returns undefined when the body is too large.
async function readBounded(request: NextRequest): Promise<Uint8Array | undefined> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Browsers mark cross-site requests; refuse anything that is not explicitly same-origin.
  if (request.headers.get('sec-fetch-site') !== 'same-origin') return refused(403);
  const now = Date.now();
  if (now - budget.start >= 60_000) budget = { start: now, count: 0 };
  if (++budget.count > PER_MINUTE) return accepted();
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d{1,9}$/.test(declared) || Number(declared) > MAX_BYTES)) return refused(413);
  try {
    const bytes = await readBounded(request);
    if (bytes === undefined) return refused(413);
    let body: unknown;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return refused(400); }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return refused(400);
    const report = body as Record<string, unknown>;
    const allowed = new Set(['kind', 'name', 'digest', 'path']);
    if (Object.keys(report).some((key) => !allowed.has(key)) || (report.kind !== 'render' && report.kind !== 'unhandled')) return refused(400);
    emitWebTelemetry('error', 'web.client_error', {
      source: report.kind,
      route: typeof report.path === 'string' ? report.path : 'unknown',
      ...(typeof report.digest === 'string' ? { digest: report.digest } : {}),
      ...(typeof report.name === 'string' ? { errorName: report.name } : {}),
    });
  } catch {
    // Error reporting is optional: an aborted or broken upload never surfaces as a server error.
    return refused(400);
  }
  return accepted();
}
