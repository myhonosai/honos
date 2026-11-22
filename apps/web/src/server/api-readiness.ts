/**
 * Review [24]: hosting readiness through the real web -> private API -> runtime database path.
 * One bounded probe of the API's `GET /v1/health/ready` (which opens a verified runtime-database connection):
 * a fixed destination (HON_API_BASE_URL, validated), a short timeout, no redirects, a small body cap and an exact
 * answer shape. Concurrent callers share one probe and an answer is reused for a moment, so a public health URL
 * cannot turn into a database load generator. The result is a closed state; no address, error or body is exposed.
 */
export type ApiReadiness = 'READY' | 'NOT_READY' | 'UNREACHABLE';

const TIMEOUT_MS = 2500;
const REUSE_MS = 2000;
const MAX_BYTES = 4096;

function apiBase(): string | null {
  const configured = process.env.HON_API_BASE_URL ?? 'http://127.0.0.1:3001';
  try {
    const parsed = new URL(configured);
    if (configured !== configured.trim() || !['http:', 'https:'].includes(parsed.protocol)
      || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return parsed.href.replace(/\/$/, '');
  } catch { return null; }
}

async function probe(fetcher: typeof fetch): Promise<ApiReadiness> {
  const base = apiBase();
  if (!base) return 'UNREACHABLE';
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const response = await fetcher(`${base}/v1/health/ready`, { method: 'GET', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json' }, signal: abort.signal });
    if (response.status !== 200 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '') || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      return 'NOT_READY';
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) { await reader.cancel().catch(() => undefined); return 'NOT_READY'; }
      chunks.push(chunk.value);
    }
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort().join(',') : '';
    const view = body as { status?: unknown; persistence?: unknown };
    return keys === 'persistence,status' && view.status === 'ready' && view.persistence === 'configured' ? 'READY' : 'NOT_READY';
  } catch {
    return 'UNREACHABLE';
  } finally { clearTimeout(timer); }
}

let inFlight: Promise<ApiReadiness> | null = null;
let last: { at: number; state: ApiReadiness } | null = null;

export function probeApiReadiness(fetcher: typeof fetch = fetch, now: () => number = Date.now): Promise<ApiReadiness> {
  if (last && now() - last.at < REUSE_MS && now() >= last.at) return Promise.resolve(last.state);
  if (inFlight) return inFlight;
  inFlight = probe(fetcher).then((state) => { last = { at: now(), state }; return state; }).finally(() => { inFlight = null; });
  return inFlight;
}

/** Test seam: forget a reused answer. */
export function resetApiReadinessForTest(): void { inFlight = null; last = null; }
