import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { HON_SESSION_COOKIE, issueSession, sessionConfig } from '@hon/auth';
vi.mock('server-only', () => ({}));
import { GET } from '../src/app/auth/continue/route';

const environment = { NODE_ENV: 'production', HON_AUTH_MODE: 'OIDC', HON_SESSION_JWT_SECRET: 'TEST_ONLY_POST_LOGIN_KEY_123456789012345678901234', HON_SESSION_AUDIENCE: 'hon-post-login-test', HON_PUBLIC_ORIGIN: 'https://hon.example', HON_API_BASE_URL: 'http://127.0.0.1:3001' };
const uuid = '00000000-0000-4000-8000-000000000001';
const hq = { data: { principalId: uuid, hqRole: 'HON_HQ_OWNER' } };
const staff = { data: { state: 'RESOLVED', organizationId: uuid, schoolId: '00000000-0000-4000-8000-000000000002' } };
const manual = { data: { state: 'MANUAL_ENTRY_REQUIRED' } };
let saved: NodeJS.ProcessEnv;
beforeEach(() => { saved = { ...process.env }; Object.assign(process.env, environment); });
afterEach(() => { process.env = saved; vi.restoreAllMocks(); vi.useRealTimers(); });
const token = (subject = 'owner-a', patch: Parameters<typeof issueSession>[1] = sessionConfig(), now?: number) => issueSession({ externalSubject: subject, displayName: 'PRIVATE_NAME_CANARY', email: 'private@example.invalid' }, patch, now);
const request = (value: string | undefined = token(), query = '', headers: Record<string, string> = {}) => new NextRequest(`https://untrusted-host.example/auth/continue${query}`, { headers: { ...(value ? { cookie: `${HON_SESSION_COOKIE}=${value}; unrelated=PRIVATE_COOKIE_CANARY` } : {}), ...headers } });
const json = (value: unknown, status = 200) => Response.json(value, { status });
const location = async (req = request()) => {
  const response = await GET(req);
  expect(response.status).toBe(303);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(await response.text()).toBe('');
  expect(response.headers.get('location')).not.toMatch(/PRIVATE|@|organizationId|schoolId|https?:/);
  return response.headers.get('location');
};

describe('verified post-login routing', () => {
  it.each(['HON_HQ_OWNER', 'HON_HQ_OPERATOR', 'HON_HQ_SUPPORT'])('routes verified %s scope to HQ, without probing staff or parent content', async hqRole => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ data: { principalId: uuid, hqRole } }));
    expect(await location()).toBe('/hq');
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['http://127.0.0.1:3001/v1/hq/session']);
  });

  it('routes only a verified RESOLVED school to the ordinary dashboard, with no scope in the redirect', async () => {
    const current = token();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({}, 403)).mockResolvedValueOnce(json(staff));
    expect(await location(request(current, '', { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https', 'x-hon-role': 'HON_HQ_OWNER', 'x-school-id': uuid, authorization: 'Bearer FORGED' }))).toBe('/staff/dashboard');
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['http://127.0.0.1:3001/v1/hq/session', 'http://127.0.0.1:3001/v1/staff/current-reporting-school']);
    for (const [, options] of fetcher.mock.calls) {
      expect(options).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json', Cookie: `${HON_SESSION_COOKIE}=${current}` } });
      expect(Object.keys(options!.headers!)).toEqual(['Accept', 'Cookie']);
      expect(options?.body).toBeUndefined();
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it.each([{ data: { state: 'DENIED' } }, { data: { state: 'GUARDIAN' } }, { data: { state: 'SELECTION_REQUIRED', schools: [staff.data] } }])('keeps missing and unsupported staff classifications neutral: %j', async body => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({}, 403)).mockResolvedValueOnce(json(body));
    expect(await location()).toBe('/auth/access'); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('routes a bounded verified multi-school choice to school entry without choosing the first school', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({}, 403)).mockResolvedValueOnce(json(manual)).mockResolvedValueOnce(json({ data: { state: 'SELECTION_REQUIRED', schools: [
      { organizationId: uuid, schoolId: staff.data.schoolId, organizationName: 'Synthetic A', schoolName: 'A' },
      { organizationId: uuid, schoolId: '00000000-0000-4000-8000-000000000003', organizationName: 'Synthetic A', schoolName: 'B' },
    ] } }));
    expect(await location()).toBe('/staff/entry');
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['http://127.0.0.1:3001/v1/hq/session', 'http://127.0.0.1:3001/v1/staff/current-reporting-school', 'http://127.0.0.1:3001/v1/staff/reporting-schools']);
  });
  it.each([401, 403, 503])('school-choice HTTP %s fails closed without an entitlement shortcut', async status => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({}, 403)).mockResolvedValueOnce(json(manual)).mockResolvedValueOnce(json({}, status));
    expect(await location()).toBe(status === 401 ? '/auth/login' : '/auth/access'); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('keeps suspended or unresolved school access neutral', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({}, 403)).mockResolvedValueOnce(json(manual)).mockResolvedValueOnce(json(manual));
    expect(await location()).toBe('/auth/access');
  });
  it('accepts all twenty canonical choices with maximal escaped Unicode names without publishing those names in the redirect', async () => {
    const data = { data: { state: 'SELECTION_REQUIRED', schools: Array.from({ length: 20 }, (_, i) => ({ organizationId: uuid,
      schoolId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, organizationName: '😀'.repeat(120), schoolName: '😀'.repeat(120) })) } };
    const escaped = JSON.stringify(data).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    expect(new TextEncoder().encode(escaped).length).toBeGreaterThan(32768);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({}, 403)).mockResolvedValueOnce(json(manual)).mockResolvedValueOnce(new Response(escaped, { headers: { 'Content-Type': 'application/json' } }));
    expect(await location()).toBe('/staff/entry');
  });

  it.each([undefined, '', 'FORGED', 'a.b.c'])('requires a valid HON cookie before any protected read: %s', async value => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const req = new NextRequest('https://hon.example/auth/continue', { headers: { ...(value === undefined ? {} : { cookie: `${HON_SESSION_COOKIE}=${value}` }), authorization: 'Bearer FORGED', 'x-role': 'HON_HQ_OWNER' } });
    expect(await location(req)).toBe('/auth/login'); expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects expired, cross-audience, forged-signature, duplicate and malformed HON sessions', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); const config = sessionConfig();
    for (const value of [token('owner', config, Math.floor(Date.now() / 1000) - 43201), token('owner', { ...config, audience: 'other-app' }), token('owner', { ...config, secret: 'FORGED_SECRET_123456789012345678901234' })]) expect(await location(request(value))).toBe('/auth/login');
    expect(await location(request(token(), '', { cookie: `${HON_SESSION_COOKIE}=${token()}; ${HON_SESSION_COOKIE}=${token('other')}` }))).toBe('/auth/login');
    expect(await location(request(token(), '', { cookie: `${HON_SESSION_COOKIE}=%GG` }))).toBe('/auth/login');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails closed before I/O when session verification is not configured', async () => {
    const current = token(); delete process.env.HON_SESSION_JWT_SECRET;
    const fetcher = vi.spyOn(globalThis, 'fetch');
    expect(await location(request(current))).toBe('/auth/login'); expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['?returnTo=https://evil.example', '?next=//evil.example', '?role=HON_HQ_OWNER', `?schoolId=${uuid}`, '?familyId=forged', '?x=1&x=2'])('accepts no query selectors or redirect instructions: %s', async query => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); expect(await location(request(token(), query))).toBe('/auth/access'); expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([401, 403, 500, 503])('handles HQ HTTP %s without inventing scope or retrying', async status => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({}, status));
    expect(await location()).toBe(status === 401 ? '/auth/login' : '/auth/access');
    expect(fetcher).toHaveBeenCalledTimes(status === 403 ? 2 : 1);
  });

  it.each([401, 403, 500, 503])('handles staff HTTP %s without parent probes or retries', async status => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({}, 403)).mockResolvedValueOnce(json({}, status));
    expect(await location()).toBe(status === 401 ? '/auth/login' : '/auth/access'); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([{}, { data: hq.data, extra: true }, { data: { ...hq.data, role: 'OWNER' } }, { data: { ...hq.data, principalId: 'forged' } }, { data: { ...hq.data, hqRole: 'OWNER' } }, { data: { schoolId: uuid } }])('rejects malformed or enhanced HQ DTOs, without falling through: %j', async body => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(body));
    expect(await location()).toBe('/auth/access'); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { data: staff.data, meta: {} }, { data: { ...staff.data, schoolId: 'forged' } }, { data: { ...staff.data, role: 'OWNER' } }, { data: { ...manual.data, organizationId: uuid } }, { data: { state: 'RESOLVED' } }])('rejects malformed or enhanced staff DTOs: %j', async body => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({}, 403)).mockResolvedValueOnce(json(body));
    expect(await location()).toBe('/auth/access'); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(['https://api.example/?secret=x', 'https://api.example/#secret', 'https://user:pass@api.example', 'file:///tmp/private', ' https://api.example'])('refuses invalid deployment API configuration without I/O: %s', async base => {
    process.env.HON_API_BASE_URL = base;
    const fetcher = vi.spyOn(globalThis, 'fetch'); expect(await location()).toBe('/auth/access'); expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses the deployment API base, including its fixed path prefix, independently of browser origin', async () => {
    process.env.HON_API_BASE_URL = 'https://internal-api.example/private/';
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(hq)); expect(await location()).toBe('/hq');
    expect(fetcher.mock.calls[0]![0]).toBe('https://internal-api.example/private/v1/hq/session');
  });

  it('does not follow redirects, accept another response URL, HTML or invalid JSON, or retry transport errors', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const redirected = json(hq); Object.defineProperty(redirected, 'redirected', { value: true });
    const foreign = json(hq); Object.defineProperty(foreign, 'url', { value: 'https://evil.example/role' });
    for (const response of [new Response(null, { status: 302, headers: { Location: 'https://evil.example' } }), redirected, foreign, new Response('<html>PRIVATE</html>'), new Response('{', { headers: { 'Content-Type': 'application/json' } })]) {
      fetcher.mockReset().mockResolvedValue(response); expect(await location()).toBe('/auth/access'); expect(fetcher).toHaveBeenCalledTimes(1);
    }
    fetcher.mockReset().mockRejectedValue(new Error('PRIVATE_COOKIE_CANARY upstream exception'));
    expect(await location()).toBe('/auth/access'); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('bounds the whole access read and rejects a late result after abort', async () => {
    const controller = new AbortController(); vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => { expect(ms).toBe(8000); return controller.signal; });
    let finish!: (response: Response) => void;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const result = location(); controller.abort(); finish(json(hq));
    expect(await result).toBe('/auth/access'); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('accepts a valid body at the 64 KB limit and refuses an oversized stream despite a small claimed length', async () => {
    const valid = JSON.stringify(hq), bytes = new TextEncoder().encode(valid).byteLength;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(valid + ' '.repeat(65536 - bytes), { headers: { 'Content-Type': 'application/json' } }));
    expect(await location()).toBe('/hq');
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(valid)); controller.enqueue(new Uint8Array(65537)); },
      cancel() { cancelled = true; },
    });
    fetcher.mockReset().mockResolvedValue(new Response(stream, { headers: { 'Content-Type': 'application/json', 'Content-Length': '1' } }));
    expect(await location()).toBe('/auth/access'); expect(fetcher).toHaveBeenCalledTimes(1); expect(cancelled).toBe(true);
  });

  it('cancels a stalled body read on deadline and rejects partial content without retry', async () => {
    const controller = new AbortController(); vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    let cancelled = false, opened!: () => void;
    const bodyOpened = new Promise<void>(resolve => { opened = resolve; });
    const stream = new ReadableStream<Uint8Array>({ start(reader) { reader.enqueue(new TextEncoder().encode('{"data":')); }, cancel() { cancelled = true; } });
    const getReader = stream.getReader.bind(stream);
    vi.spyOn(stream, 'getReader').mockImplementation(() => { opened(); return getReader(); });
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream, { headers: { 'Content-Type': 'application/json' } }));
    const result = location(); await bodyOpened; controller.abort();
    expect(await result).toBe('/auth/access'); expect(cancelled).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not expose a body stream error or accept invalid UTF-8 JSON', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const broken = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('PRIVATE_UPSTREAM_TOKEN')); } });
    for (const response of [new Response(broken, { headers: { 'Content-Type': 'application/json' } }), new Response(new Uint8Array([0xff, 0xfe]), { headers: { 'Content-Type': 'application/json' } })]) {
      fetcher.mockReset().mockResolvedValue(response); expect(await location()).toBe('/auth/access'); expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('does not reuse another identity’s routing result or forward unrelated cookies', async () => {
    const a = token('owner-a'), b = token('owner-b');
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      const cookie = (options?.headers as Record<string, string>).Cookie;
      expect([`${HON_SESSION_COOKIE}=${a}`, `${HON_SESSION_COOKIE}=${b}`]).toContain(cookie);
      return String(url).endsWith('/hq/session') ? cookie === `${HON_SESSION_COOKIE}=${a}` ? json({}, 403) : json(hq) : json(staff);
    });
    expect(await Promise.all([location(request(a)), location(request(b))])).toEqual(['/staff/dashboard', '/hq']);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('checks expiry again after protected reads settle', async () => {
    vi.useFakeTimers(); const start = new Date('2026-11-01T12:00:00Z'); vi.setSystemTime(start);
    const current = token('owner', sessionConfig(), Math.floor(start.getTime() / 1000) - 43199);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { vi.setSystemTime(new Date(start.getTime() + 2000)); return json(hq); });
    expect(await location(request(current))).toBe('/auth/login');
  });
});
