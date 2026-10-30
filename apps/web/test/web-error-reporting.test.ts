import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '../src/app/api/client-errors/route';
import { onRequestError } from '../src/instrumentation';
import { resetWebTelemetryForTests } from '../src/server/web-telemetry';

const LEAKS = /jane\.parent|4242 4242|eyJhbGci|sk_test_51|SESSION_TOKEN|email=/;
const report = (body: unknown, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }) =>
  POST(new NextRequest('https://hon.example/api/client-errors', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } }));

describe('web error reporting', () => {
  afterEach(() => { vi.restoreAllMocks(); resetWebTelemetryForTests(); });

  it('accepts a minimal same-origin browser report and logs only fixed, redacted fields', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; });
    const response = await report({ kind: 'render', name: 'TypeError', digest: '2914826419', path: '/parent/jane.parent@example.com?email=jane.parent@example.com' });
    expect(response.status).toBe(204);
    expect(writes).toHaveLength(1);
    const record = JSON.parse(writes[0]!);
    expect(record).toMatchObject({ service: 'hon-web', event: 'web.client_error', source: 'render', errorName: 'TypeError', digest: '2914826419', route: '/parent/:value' });
    expect(writes[0]).not.toMatch(LEAKS);
  });

  it('refuses cross-site, oversized, malformed and free-text reports', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; });
    expect((await report({ kind: 'render' }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await report({ kind: 'render' }, {})).status).toBe(403);
    expect((await report({ kind: 'render', name: 'x'.repeat(4000) })).status).toBe(413);
    expect((await report('{not json')).status).toBe(400);
    expect((await report({ kind: 'render', message: 'card 4242 4242 4242 4242' })).status).toBe(400);
    expect((await report({ kind: 'other' })).status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it('records server rendering failures from the Next.js hook without the URL query or secrets', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; });
    const error = Object.assign(new Error('fetch failed for jane.parent@example.com with Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl and sk_test_51TESTONLYabcdefgh'), { digest: 'abc123' });
    await onRequestError(error, { path: '/staff/leads?email=jane.parent@example.com', method: 'GET' }, { routePath: '/staff/leads', routeType: 'render' });
    expect(writes).toHaveLength(1);
    const record = JSON.parse(writes[0]!);
    expect(record).toMatchObject({ event: 'web.request_error', route: '/staff/leads', method: 'GET', digest: 'abc123', errorName: 'Error', routeType: 'render' });
    expect(writes[0]).not.toMatch(LEAKS);
  });

  const streamed = (chunks: Uint8Array[], headers: Record<string, string> = {}) => {
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks[pulled];
        if (next === undefined) { controller.close(); return; }
        pulled += 1;
        controller.enqueue(next);
      },
      cancel() { cancelled = true; },
    });
    const request = new NextRequest('https://hon.example/api/client-errors', { method: 'POST', body, duplex: 'half', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers } } as ConstructorParameters<typeof NextRequest>[1]);
    return { request, pulled: () => pulled, cancelled: () => cancelled };
  };

  it('stops reading and cancels an oversized body that has no Content-Length', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(1024));
    const upload = streamed(Array.from({ length: 32 }, () => chunk));
    expect((await POST(upload.request)).status).toBe(413);
    expect(upload.cancelled()).toBe(true);
    expect(upload.pulled()).toBeLessThanOrEqual(4);
  });

  it('enforces the limit in bytes even when Content-Length understates the body', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(1024));
    const upload = streamed(Array.from({ length: 32 }, () => chunk), { 'content-length': '10' });
    expect((await POST(upload.request)).status).toBe(413);
    expect(upload.pulled()).toBeLessThanOrEqual(4);
    expect((await report({ kind: 'render' }, { 'sec-fetch-site': 'same-origin', 'content-length': 'abc' })).status).toBe(413);
  });

  it('counts multibyte characters as bytes, and accepts a small streamed report', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; });
    // 1,000 UTF-16 code units, about 3,000 UTF-8 bytes: over the 2 KiB limit.
    const multibyte = JSON.stringify({ kind: 'render', path: `/${'\u20ac'.repeat(1000)}` });
    expect(multibyte.length).toBeLessThan(2048);
    expect(new TextEncoder().encode(multibyte).byteLength).toBeGreaterThan(2048);
    expect((await POST(streamed([new TextEncoder().encode(multibyte)]).request)).status).toBe(413);
    expect((await POST(streamed([new Uint8Array([0x7b, 0xff, 0x7d])]).request)).status).toBe(400);
    const small = new TextEncoder().encode(JSON.stringify({ kind: 'unhandled', name: 'TypeError' }));
    expect((await POST(streamed([small.slice(0, 5), small.slice(5)]).request)).status).toBe(204);
    expect(writes).toHaveLength(1);
  });

  it('never records exception text from the Next.js hook, even unquoted student or medical details', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; });
    const error = Object.assign(new Error('Unable to load student Maya Park medical allergy peanut for guardian Robin Park'), { digest: 'd1' });
    await onRequestError(error, { path: '/staff/students/x', method: 'GET' }, { routePath: '/staff/students/[studentId]', routeType: 'render' });
    expect(writes).toHaveLength(1);
    expect(writes[0]).not.toMatch(/Maya|Park|allerg|peanut|Robin|medical|Unable to load/);
    expect(JSON.parse(writes[0]!)).not.toHaveProperty('message');
  });
});
