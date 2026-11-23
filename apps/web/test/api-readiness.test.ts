import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probeApiReadiness, resetApiReadinessForTest } from '../src/server/api-readiness';
import { GET as healthCheck } from '../src/app/api/readiness/route';

// Review [24]: the hosting health check goes through the real web -> private API -> runtime database path, bounded.
const json = (body: unknown, status = 200, type = 'application/json; charset=utf-8') => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': type } });
const ready = () => json({ status: 'ready', persistence: 'configured' });
const configuredEnv = { NODE_ENV: 'production', HON_AUTH_MODE: 'OIDC', HON_SESSION_JWT_SECRET: 'TEST_ONLY_HON_KEY_123456789012345678901234', HON_SESSION_AUDIENCE: 'hon-web-test', HON_PUBLIC_ORIGIN: 'https://hon.example', HON_OIDC_ISSUER: 'https://provider.example/issuer', HON_OIDC_AUTHORIZATION_ENDPOINT: 'https://provider.example/authorize', HON_OIDC_TOKEN_ENDPOINT: 'https://provider.example/token', HON_OIDC_JWKS_URI: 'https://provider.example/jwks', HON_OIDC_CLIENT_ID: 'hon-web-client', HON_OIDC_SCOPES: 'openid profile email', HON_OIDC_REDIRECT_URI: 'https://hon.example/auth/callback', HON_OIDC_TOKEN_ENDPOINT_AUTH_METHOD: 'none' };
let saved: NodeJS.ProcessEnv;
beforeEach(() => { saved = { ...process.env }; resetApiReadinessForTest();
  for (const key of Object.keys(process.env)) if (/^(MANUS_|HON_AUTH_|HON_SESSION_|HON_OIDC_|HON_PUBLIC_ORIGIN$)/.test(key)) delete process.env[key]; process.env.HON_API_BASE_URL = 'http://hon-api.internal:3001'; });
afterEach(() => { process.env = saved; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('API readiness probe', () => {
  it('asks only the configured API readiness URL, without redirects or caching, and accepts only the exact answer', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => ready());
    expect(await probeApiReadiness(f as unknown as typeof fetch)).toBe('READY');
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]![0]).toBe('http://hon-api.internal:3001/v1/health/ready');
    expect(f.mock.calls[0]![1]).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'error' });
    expect(f.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['a 503 from the API (database unavailable)', () => json({ code: 'PERSISTENCE_UNAVAILABLE' }, 503), 'NOT_READY'],
    ['a 200 with another shape', () => json({ status: 'ready' }), 'NOT_READY'],
    ['a 200 with an extra key', () => json({ status: 'ready', persistence: 'configured', x: 1 }), 'NOT_READY'],
    ['a 200 that is not JSON', () => json({ status: 'ready', persistence: 'configured' }, 200, 'text/html'), 'NOT_READY'],
    ['an oversized answer', () => json({ status: 'ready', persistence: 'configured', pad: 'x'.repeat(5000) }), 'NOT_READY'],
    ['a refused connection', () => Promise.reject(new TypeError('fetch failed')), 'UNREACHABLE'],
  ] as const)('%s is not ready', async (_label, answer, state) => {
    expect(await probeApiReadiness(vi.fn(answer) as unknown as typeof fetch)).toBe(state);
  });

  it('a hung API is cut off by the timeout', async () => {
    vi.useFakeTimers();
    try {
      const f = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_ok, fail) => init!.signal!.addEventListener('abort', () => fail(new DOMException('aborted', 'AbortError')))));
      const pending = probeApiReadiness(f as unknown as typeof fetch);
      await vi.advanceTimersByTimeAsync(2600);
      expect(await pending).toBe('UNREACHABLE');
    } finally { vi.useRealTimers(); }
  });

  it.each(['ftp://hon-api:21', 'http://user:pw@hon-api:3001', 'http://hon-api:3001/?x=1', ' http://hon-api:3001', 'not a url'])('a malformed API address %s is refused with no request', async (base) => {
    process.env.HON_API_BASE_URL = base;
    const f = vi.fn(async () => ready());
    expect(await probeApiReadiness(f as unknown as typeof fetch)).toBe('UNREACHABLE');
    expect(f).not.toHaveBeenCalled();
  });

  it('concurrent and repeated checks share one probe for a moment, then probe again', async () => {
    let clock = 1_000_000; const now = () => clock;
    let release!: (r: Response) => void;
    const f = vi.fn(() => new Promise<Response>((ok) => { release = ok; }));
    const a = probeApiReadiness(f as unknown as typeof fetch, now), b = probeApiReadiness(f as unknown as typeof fetch, now);
    release(ready());
    expect([await a, await b]).toEqual(['READY', 'READY']);
    expect(await probeApiReadiness(f as unknown as typeof fetch, now)).toBe('READY');
    expect(f).toHaveBeenCalledTimes(1);
    clock += 2001;
    f.mockImplementationOnce(async () => json({}, 503));
    expect(await probeApiReadiness(f as unknown as typeof fetch, now)).toBe('NOT_READY');
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe('hosting health check route', () => {
  it('is 200 only when identity is configured and the API reports a ready database', async () => {
    Object.assign(process.env, configuredEnv);
    vi.stubGlobal('fetch', vi.fn(async () => ready()));
    const ok = await healthCheck();
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(await ok.json()).toEqual({ data: { ready: true, identity: 'AUTH_READY', api: 'READY' } });
  });

  it('is 503 when the API database is unavailable, and exposes only closed codes', async () => {
    Object.assign(process.env, configuredEnv);
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'PERSISTENCE_UNAVAILABLE', detail: 'secret detail hon-api.internal' }, 503)));
    const down = await healthCheck();
    expect(down.status).toBe(503);
    const text = await down.text();
    expect(JSON.parse(text)).toEqual({ data: { ready: false, identity: 'AUTH_READY', api: 'NOT_READY' } });
    expect(text).not.toMatch(/internal|secret|3001/);
  });

  it('is 503 without any network request when identity is not configured', async () => {
    delete process.env.HON_AUTH_MODE;
    const f = vi.fn(async () => ready()); vi.stubGlobal('fetch', f);
    const down = await healthCheck();
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ data: { ready: false, identity: 'AUTH_NOT_CONFIGURED', api: 'NOT_CHECKED' } });
    expect(f).not.toHaveBeenCalled();
  });
});
