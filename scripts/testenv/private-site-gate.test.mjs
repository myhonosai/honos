import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createPrivateSiteGate } from './private-site-gate.mjs';

// Synthetic credentials/origin only. These mocks do not prove native browser
// HTTPS, __Host cookie storage, SameSite enforcement or edge integration.
const ORIGIN = 'https://private-gate.invalid:8443';
const PASSCODE = 'synthetic-test-only-32-plus-characters';
const COOKIE = '__Host-hon_lab_gate';
const ACCESS = '/__private-access';
const TTL = 7_200_000;
const form = (passcode = PASSCODE) => `passcode=${encodeURIComponent(passcode)}`;

class Response {
  constructor() {
    this.statusCode = 200;
    this.headers = new Map();
    this.body = '';
    this.headersSent = false;
    this.writableEnded = false;
    this.destroyed = false;
  }
  setHeader(name, value) { this.headers.set(name.toLowerCase(), value); }
  getHeader(name) { return this.headers.get(name.toLowerCase()); }
  getHeaderNames() { return [...this.headers.keys()]; }
  removeHeader(name) { this.headers.delete(name.toLowerCase()); }
  end(body = '') { this.body = String(body); this.headersSent = true; this.writableEnded = true; }
  destroy() { this.destroyed = true; }
}

function fixture(extra = {}) {
  let clock = 1_800_000_000_000;
  const calls = [];
  const proxy = async (req, res) => {
    calls.push(req);
    res.end('SYNTHETIC_UPSTREAM');
  };
  const gate = createPrivateSiteGate({ origin: ORIGIN, passcode: PASSCODE, proxy, now: () => clock, ...extra });
  const send = async ({ method = 'GET', url = '/', headers = {}, body = '', chunks, rawHeaders } = {}) => {
    const input = chunks ?? (body ? [Buffer.from(body)] : []);
    const req = Readable.from(input);
    req.method = method;
    req.url = url;
    req.headers = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
    if (rawHeaders) req.rawHeaders = rawHeaders;
    const res = new Response();
    await gate.handler(req, res);
    req.destroy();
    return res;
  };
  const unlock = (extra = {}) => send({
    method: 'POST', url: ACCESS,
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', ...extra.headers },
    body: form(), ...Object.fromEntries(Object.entries(extra).filter(([name]) => name !== 'headers')),
  });
  return { gate, calls, send, unlock, setClock: (value) => { clock = value; }, advance: (value) => { clock += value; } };
}

function cookieFrom(res) {
  const header = res.getHeader('set-cookie');
  assert.ok(typeof header === 'string', 'expected only the separate gate cookie');
  return header.split(';')[0];
}
function privateResponse(res, referrerPolicy = 'no-referrer') {
  assert.equal(res.getHeader('cache-control'), 'private, no-store');
  assert.equal(res.getHeader('pragma'), 'no-cache');
  assert.equal(res.getHeader('vary'), 'Cookie');
  assert.equal(res.getHeader('referrer-policy'), referrerPolicy);
}
function absentSensitive(res, candidates) {
  const rendered = `${res.body} ${[...res.headers.values()].join(' ')}`;
  for (const candidate of candidates) assert.ok(!rendered.includes(candidate), 'must not reflect sensitive input');
}

test('configuration requires bare HTTPS origin and at least 32 passcode characters', () => {
  for (const origin of ['http://private-gate.invalid', 'https://user:password@private-gate.invalid', 'https://private-gate.invalid/', 'https://private-gate.invalid/path', 'https://private-gate.invalid?x=1', 'https://private-gate.invalid#x', '//private-gate.invalid', undefined]) {
    assert.throws(() => fixture({ origin }), { name: 'TypeError', message: 'A bare HTTPS origin is required.' });
  }
  for (const passcode of ['', 'short', 'x'.repeat(31), undefined]) {
    assert.throws(() => fixture({ passcode }), { name: 'TypeError', message: 'A passcode of at least 32 characters is required.' });
  }
  assert.doesNotThrow(() => fixture({ origin: 'https://private-gate.invalid:9443', passcode: 'x'.repeat(32) }));
  assert.throws(() => fixture({ proxy: undefined }), TypeError);
  assert.throws(() => fixture({ now: null }), TypeError);
});

test('login form is private, static and explicit about nonproduction and independent HON authority', async () => {
  const f = fixture();
  const res = await f.send({ url: `${ACCESS}?returnUrl=https%3A%2F%2Fevil.invalid&passcode=never-reflect` });
  assert.equal(res.statusCode, 200);
  privateResponse(res, 'same-origin');
  assert.ok(res.body.includes('NONPRODUCTION'));
  assert.ok(res.body.includes('school or HQ authority'));
  assert.ok(res.body.includes('Private site passcode'));
  assert.ok(res.body.includes('Unlock test site'));
  assert.ok(res.body.includes('action="/__private-access"'));
  assert.ok(!/<(?:script|link|img)\b/i.test(res.body));
  assert.ok(res.getHeader('content-security-policy').includes("default-src 'none'"));
  assert.equal(res.getHeader('set-cookie'), undefined);
  absentSensitive(res, [PASSCODE, 'never-reflect', 'evil.invalid']);
  assert.equal(f.calls.length, 0);
});

test('anonymous app, HON login, IdP authorize and static pages redirect only to fixed relative gate', async () => {
  const f = fixture();
  for (const url of ['/', '/login', '/hq/login', '/oidc/authorize?redirect_uri=https://evil.invalid', '/assets/app.js', '/__private-access/unknown', '/?returnUrl=https://evil.invalid', '/%2f%2fevil.invalid']) {
    const res = await f.send({ url });
    assert.equal(res.statusCode, 303);
    assert.equal(res.getHeader('location'), ACCESS);
    privateResponse(res);
    absentSensitive(res, ['evil.invalid']);
  }
  assert.equal(f.calls.length, 0);
});

test('anonymous API, JSON, token and JWKS discovery receive 401 JSON no-store without proxy calls', async () => {
  const f = fixture();
  for (const input of [
    { url: '/api' }, { url: '/api/schools' }, { method: 'POST', url: '/api/commands', body: 'private-body' },
    { url: '/.well-known/openid-configuration' }, { url: '/oidc/token' }, { url: '/oidc/jwks.json' },
    { url: '/another-json-route', headers: { accept: 'application/json' } },
    { url: '/another-json-route', headers: { accept: 'application/problem+json' } },
  ]) {
    const res = await f.send(input);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(JSON.parse(res.body), { error: 'private_access_required' });
    assert.equal(res.getHeader('location'), undefined);
    privateResponse(res);
  }
  assert.equal(f.calls.length, 0);
});

test('unlock issues only opaque 256-bit independent secure gate cookie and fixed root redirect', async () => {
  const f = fixture();
  const first = await f.unlock({ url: `${ACCESS}?returnUrl=https://evil.invalid` });
  assert.equal(first.statusCode, 303);
  assert.equal(first.getHeader('location'), '/');
  privateResponse(first);
  const cookie = first.getHeader('set-cookie');
  assert.ok(new RegExp(`^${COOKIE}=[A-Za-z0-9_-]{43};`).test(cookie));
  assert.ok(/; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=7200; Expires=/.test(cookie));
  assert.ok(!/Domain=/i.test(cookie));
  const rawToken = cookieFrom(first).slice(COOKIE.length + 1);
  assert.equal(Buffer.from(rawToken, 'base64url').length, 32);
  absentSensitive(first, [PASSCODE, 'evil.invalid']);
  const second = await f.unlock();
  assert.ok(cookieFrom(first) !== cookieFrom(second), 'each unlock must use fresh cryptographic entropy');
  assert.equal(f.calls.length, 0);
});

test('authorized proxy receives HON cookies but not the separate gate credential or gate-generated authority', async () => {
  const f = fixture();
  const cookie = cookieFrom(await f.unlock());
  for (const url of ['/login', '/api/schools', '/oidc/token', '/oidc/jwks', '/assets/app.js']) {
    const res = await f.send({ method: 'POST', url, headers: { cookie: `${cookie}; hon_session=synthetic-existing-session`, 'x-hon-role': 'untrusted-school-admin' }, rawHeaders: ['Cookie', `${cookie}; hon_session=synthetic-existing-session`, 'X-Hon-Role', 'untrusted-school-admin'], body: 'unchanged-upstream-body' });
    assert.equal(res.body, 'SYNTHETIC_UPSTREAM');
    assert.equal(res.getHeader('set-cookie'), undefined);
  }
  assert.equal(f.calls.length, 5);
  assert.ok(f.calls.every((req) => req.headers.cookie.includes('hon_session=synthetic-existing-session')));
  assert.ok(f.calls.every((req) => !req.headers.cookie.includes(COOKIE)));
  assert.ok(f.calls.every((req) => !req.rawHeaders.join(' ').includes(COOKIE)));
  assert.ok(f.calls.every((req) => req.rawHeaders.join(' ').includes('hon_session=synthetic-existing-session')));
  assert.ok(f.calls.every((req) => req.headers['x-hon-role'] === 'untrusted-school-admin'));
});

test('wrong passcode does not echo the secret, input or existing gate token', async () => {
  const f = fixture();
  const cookie = cookieFrom(await f.unlock());
  const wrong = 'synthetic-incorrect-never-echo';
  const res = await f.unlock({ body: form(wrong), headers: { cookie } });
  assert.equal(res.statusCode, 401);
  assert.equal(res.getHeader('set-cookie'), undefined);
  absentSensitive(res, [PASSCODE, wrong, cookie.slice(COOKIE.length + 1)]);
  privateResponse(res, 'same-origin');
  assert.equal(f.calls.length, 0);
});

test('missing, invalid, cross-site, sibling and duplicate Origins fail closed on unlock and logout', async () => {
  const f = fixture();
  const cookie = cookieFrom(await f.unlock());
  for (const origin of [undefined, 'null', 'http://private-gate.invalid:8443', 'https://evil.invalid', `${ORIGIN}/`, 'https://sibling.private-gate.invalid:8443', `${ORIGIN}, https://evil.invalid`]) {
    for (const url of [ACCESS, `${ACCESS}/logout`]) {
      const res = await f.unlock({ url, headers: { origin, cookie } });
      assert.equal(res.statusCode, 403);
      assert.equal(res.getHeader('set-cookie'), undefined);
      privateResponse(res);
    }
  }
  const duplicate = await f.unlock({ rawHeaders: ['Origin', ORIGIN, 'Origin', ORIGIN, 'Content-Type', 'application/x-www-form-urlencoded'] });
  assert.equal(duplicate.statusCode, 403);
  const crossSite = await f.unlock({ headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossSite.statusCode, 403);
  const sameSite = await f.unlock({ headers: { 'sec-fetch-site': 'same-site' } });
  assert.equal(sameSite.statusCode, 403);
  const spoofed = await f.unlock({ headers: { origin: undefined, referer: `${ORIGIN}/`, host: 'private-gate.invalid:8443', 'x-forwarded-proto': 'https' } });
  assert.equal(spoofed.statusCode, 403);
  assert.equal((await f.send({ url: '/api', headers: { cookie } })).body, 'SYNTHETIC_UPSTREAM');
});

test('exact closed passcode form refuses duplicate, additional, absent and malformed fields', async () => {
  for (const body of ['', 'passcode', 'other=value', `${form()}&returnUrl=%2F`, `${form()}&${form()}`, `${form()}&`, 'passcode=%ZZ', 'passcode=%C0%AF']) {
    const f = fixture();
    const res = await f.unlock({ body });
    assert.equal(res.statusCode, 400);
    assert.equal(res.getHeader('set-cookie'), undefined);
    privateResponse(res);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  const badUtf8 = await f.unlock({ chunks: [Buffer.from([0xc0, 0xaf])] });
  assert.equal(badUtf8.statusCode, 400);
  const charset = await f.unlock({ headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' } });
  assert.equal(charset.statusCode, 303);
});

test('form bound is 4096 actual bytes, not just Content-Length; invalid media and encodings refused', async () => {
  const f = fixture();
  const declared = await f.unlock({ headers: { 'content-length': '4097' } });
  assert.equal(declared.statusCode, 413);
  const actual = await f.unlock({ chunks: [Buffer.alloc(2048, 97), Buffer.alloc(2049, 97)] });
  assert.equal(actual.statusCode, 413);
  const exact = await f.unlock({ body: `passcode=${'a'.repeat(4087)}` });
  assert.equal(exact.statusCode, 401);
  const json = await f.unlock({ headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(json.statusCode, 415);
  const compressed = await f.unlock({ headers: { 'content-encoding': 'gzip' } });
  assert.equal(compressed.statusCode, 400);
  const badLength = await f.unlock({ headers: { 'content-length': '-1' } });
  assert.equal(badLength.statusCode, 400);
  const duplicateType = await f.unlock({ rawHeaders: ['Origin', ORIGIN, 'Content-Type', 'application/x-www-form-urlencoded', 'Content-Type', 'application/json'] });
  assert.equal(duplicateType.statusCode, 415);
  assert.equal(f.calls.length, 0);
});

test('bounded aggregate failed-attempt throttle survives client-header rotation and resets after one minute', async () => {
  const f = fixture();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const res = await f.unlock({ body: form('wrong'), headers: { 'x-forwarded-for': `192.0.2.${attempt}` } });
    assert.equal(res.statusCode, 401);
  }
  const limited = await f.unlock();
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.getHeader('retry-after'), '60');
  assert.equal(limited.getHeader('set-cookie'), undefined);
  f.advance(59_999);
  assert.equal((await f.unlock()).statusCode, 429);
  f.advance(1);
  assert.equal((await f.unlock()).statusCode, 303);
  assert.equal(f.calls.length, 0);
});

test('simultaneous failed requests cannot bypass failure limit with already pending correct unlock', async () => {
  const f = fixture();
  const results = await Promise.all([...Array.from({ length: 10 }, () => f.unlock({ body: form('wrong') })), f.unlock()]);
  assert.equal(results.filter((res) => res.statusCode === 401).length, 10);
  assert.equal(results.at(-1).statusCode, 429);
  assert.equal(results.at(-1).getHeader('set-cookie'), undefined);
});

test('forged, empty, wrong-name and caller-asserted bypass cookies or headers never authorize', async () => {
  const f = fixture();
  for (const cookie of [`${COOKIE}=${'A'.repeat(43)}`, `${COOKIE}=`, `${COOKIE}=${'A'.repeat(42)}`, `hon_session=${'A'.repeat(43)}`, '__Secure-hon_lab_gate=anything']) {
    const res = await f.send({ url: '/api', headers: { cookie, authorization: 'Bearer synthetic-forged', 'x-private-access': 'true', 'x-hon-gate-authorized': 'true', 'x-forwarded-host': 'localhost', 'x-forwarded-for': '127.0.0.1' } });
    assert.equal(res.statusCode, 401);
  }
  assert.equal(f.calls.length, 0);
});

test('duplicate gate cookies including separate Cookie header lines fail closed', async () => {
  const f = fixture();
  const cookie = cookieFrom(await f.unlock());
  for (const input of [
    { headers: { cookie: `${cookie}; ${cookie}` } },
    { headers: { cookie: `${cookie}; ${COOKIE}=forged` } },
    { rawHeaders: ['Cookie', cookie, 'Cookie', cookie] },
  ]) {
    const res = await f.send({ url: '/api', ...input });
    assert.equal(res.statusCode, 401);
  }
  const unlock = await f.unlock({ headers: { cookie: `${cookie}; ${cookie}` } });
  assert.equal(unlock.statusCode, 400);
  assert.ok(unlock.getHeader('set-cookie').includes('Max-Age=0'));
  assert.equal(f.calls.length, 0);
});

test('oversized cookie header fails closed without reflecting any cookie', async () => {
  const f = fixture();
  const cookie = cookieFrom(await f.unlock());
  const res = await f.send({ url: '/api', headers: { cookie: `${cookie}; unrelated=${'x'.repeat(8192)}` } });
  assert.equal(res.statusCode, 401);
  absentSensitive(res, [cookie.slice(COOKIE.length + 1)]);
  assert.equal(f.calls.length, 0);
});

test('absolute two-hour expiry is enforced server-side despite retained browser cookie and activity', async () => {
  const f = fixture();
  const cookie = cookieFrom(await f.unlock());
  f.advance(TTL - 1);
  assert.equal((await f.send({ url: '/api', headers: { cookie } })).body, 'SYNTHETIC_UPSTREAM');
  f.advance(1);
  assert.equal((await f.send({ url: '/api', headers: { cookie } })).statusCode, 401);
  assert.equal((await f.send({ headers: { cookie } })).getHeader('location'), ACCESS);
  assert.equal(f.calls.length, 1);
});

test('revokeAll invalidates every issued token immediately; a new instance simulates restart revocation', async () => {
  const f = fixture();
  const cookies = [cookieFrom(await f.unlock()), cookieFrom(await f.unlock()), cookieFrom(await f.unlock())];
  for (const cookie of cookies) assert.equal((await f.send({ url: '/api', headers: { cookie } })).statusCode, 200);
  f.gate.revokeAll();
  f.gate.revokeAll();
  for (const cookie of cookies) assert.equal((await f.send({ url: '/api', headers: { cookie } })).statusCode, 401);
  const newCookie = cookieFrom(await f.unlock());
  assert.equal((await f.send({ url: '/api', headers: { cookie: newCookie } })).statusCode, 200);
  const restarted = fixture();
  assert.equal((await restarted.send({ url: '/api', headers: { cookie: newCookie } })).statusCode, 401);
});

test('same-origin POST logout deletes only matching gate token and relocks with fixed gate redirect', async () => {
  const f = fixture();
  const cookie = cookieFrom(await f.unlock());
  const other = cookieFrom(await f.unlock());
  const logout = await f.send({ method: 'POST', url: `${ACCESS}/logout?returnUrl=https://evil.invalid`, headers: { origin: ORIGIN, cookie: `${cookie}; hon_session=synthetic-existing` } });
  assert.equal(logout.statusCode, 303);
  assert.equal(logout.getHeader('location'), ACCESS);
  assert.ok(logout.getHeader('set-cookie').startsWith(`${COOKIE}=;`));
  assert.ok(logout.getHeader('set-cookie').includes('Max-Age=0'));
  assert.ok(!logout.getHeader('set-cookie').includes('hon_session'));
  privateResponse(logout);
  absentSensitive(logout, [PASSCODE, cookie.slice(COOKIE.length + 1), 'evil.invalid']);
  assert.equal((await f.send({ url: '/api', headers: { cookie } })).statusCode, 401);
  assert.equal((await f.send({ url: '/api', headers: { cookie: other } })).statusCode, 200);
  const getLogout = await f.send({ url: `${ACCESS}/logout`, headers: { cookie: other } });
  assert.equal(getLogout.statusCode, 405);
  assert.equal(getLogout.getHeader('allow'), 'POST');
  const anonLogout = await f.send({ method: 'POST', url: `${ACCESS}/logout`, headers: { origin: ORIGIN } });
  assert.equal(anonLogout.statusCode, 303);
  const invalidBody = await f.send({ method: 'POST', url: `${ACCESS}/logout`, headers: { origin: ORIGIN }, body: 'unexpected=data' });
  assert.equal(invalidBody.statusCode, 400);
});

test('re-unlocking replaces the presented token rather than retaining it', async () => {
  const f = fixture();
  const cookie = cookieFrom(await f.unlock());
  const fresh = cookieFrom(await f.unlock({ headers: { cookie } }));
  assert.ok(cookie !== fresh);
  assert.equal((await f.send({ url: '/api', headers: { cookie } })).statusCode, 401);
  assert.equal((await f.send({ url: '/api', headers: { cookie: fresh } })).statusCode, 200);
});

test('token store is bounded at 1024; revokeAll releases capacity without evicting valid tokens', async () => {
  const f = fixture();
  let first;
  for (let index = 0; index < 1024; index += 1) {
    const res = await f.unlock();
    assert.equal(res.statusCode, 303);
    if (index === 0) first = cookieFrom(res);
  }
  assert.equal((await f.unlock()).statusCode, 503);
  assert.equal((await f.send({ url: '/api', headers: { cookie: first } })).statusCode, 200);
  assert.equal((await f.unlock({ headers: { cookie: first } })).statusCode, 303);
  f.gate.revokeAll();
  assert.equal((await f.unlock()).statusCode, 303);
});

test('absolute/network-path and malformed request targets do not become open redirects', async () => {
  const f = fixture();
  for (const url of ['https://evil.invalid/path', '//evil.invalid/path', '/\\evil.invalid/path', '/path\nheader']) {
    const res = await f.send({ url });
    assert.equal(res.statusCode, 400);
    assert.equal(res.getHeader('location'), undefined);
    absentSensitive(res, ['evil.invalid']);
  }
  assert.equal((await f.send({ method: 'PUT', url: ACCESS })).statusCode, 405);
  assert.equal(f.calls.length, 0);
});

test('invalid clock and proxy exceptions are generic, private and never expose upstream errors or headers', async () => {
  const invalid = fixture({ now: () => Number.NaN });
  assert.equal((await invalid.send()).statusCode, 503);
  const f = fixture({ proxy: async (_req, res) => {
    res.setHeader('set-cookie', 'synthetic-sensitive-upstream-cookie');
    res.setHeader('x-sensitive-error', 'synthetic-sensitive-error');
    throw new Error('synthetic-sensitive-error');
  } });
  const cookie = cookieFrom(await f.unlock());
  const res = await f.send({ url: '/api', headers: { cookie } });
  assert.equal(res.statusCode, 503);
  assert.equal(res.getHeader('set-cookie'), undefined);
  privateResponse(res);
  absentSensitive(res, ['synthetic-sensitive-error', 'synthetic-sensitive-upstream-cookie', PASSCODE, cookie.slice(COOKIE.length + 1)]);
});

test('bounded ephemeral HTTP loopback: chunked oversize receives 413 without socket error', async (t) => {
  const gate = createPrivateSiteGate({ origin: ORIGIN, passcode: PASSCODE, proxy: async (_req, res) => res.end('unused') });
  const server = createServer((req, res) => { void gate.handler(req, res); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const result = await new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.address().port, path: ACCESS, method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(Buffer.alloc(2048, 97));
    req.end(Buffer.alloc(2049, 97));
  });
  assert.equal(result.status, 413);
  assert.equal(result.headers['cache-control'], 'private, no-store');
  assert.equal(result.body, 'Invalid form.');
});
