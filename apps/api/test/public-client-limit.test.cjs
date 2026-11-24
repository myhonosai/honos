const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PublicClientLimit, publicClientAddress, publicClientIpHops, PUBLIC_CLIENT_LIMITS } = require('../dist/schedule/public-client-limit.js');
const { publicBookingTypeTransport } = require('../dist/schedule/public-booking-type-transport.js');
const { publicEventTransport } = require('../dist/schedule/public-event-transport.js');

// Per-client limiter in front of the anonymous booking links: only trusted proxy positions are read, a misconfiguration
// never pools every family into one bucket, and one sender cannot use up a link for everyone.

test('the client address comes only from the trusted position of X-Forwarded-For', () => {
  assert.equal(publicClientIpHops({}), null);
  for (const v of ['0', '6', 'x', '2 ', '']) assert.equal(publicClientIpHops({ HON_PUBLIC_CLIENT_IP_HOPS: v }), null, v);
  assert.equal(publicClientIpHops({ HON_PUBLIC_CLIENT_IP_HOPS: '2' }), 2);
  // The client can write anything left of the entries the proxies append.
  assert.equal(publicClientAddress('6.6.6.6, 203.0.113.9, 10.0.0.4', 2), '203.0.113.9');
  assert.equal(publicClientAddress('203.0.113.9, 10.0.0.4', 2), '203.0.113.9');
  assert.equal(publicClientAddress('10.0.0.4', 2), null, 'too few entries');
  assert.equal(publicClientAddress('203.0.113.9, 10.0.0.4', null), null, 'not configured');
  assert.equal(publicClientAddress(undefined, 2), null);
  assert.equal(publicClientAddress(['203.0.113.9', '10.0.0.4'], 2), null, 'a repeated header is not trusted');
  assert.equal(publicClientAddress('nope, 10.0.0.4', 2), null, 'not an address');
  assert.equal(publicClientAddress('::ffff:203.0.113.9, 10.0.0.4', 2), '203.0.113.9');
  assert.equal(publicClientAddress('2001:db8:a:b:1:2:3:4, 10.0.0.4', 2), '2001:db8:a:b::/64');
  assert.equal(publicClientAddress('2001:DB8:a:b::9, 10.0.0.4', 2), '2001:db8:a:b::/64', 'one /64 counts once');
  assert.equal(publicClientAddress('x'.repeat(3000), 1), null);
});

test('each client has its own allowance per action and window', () => {
  let now = 0;
  const limit = new PublicClientLimit(2, () => now);
  const a = '9.9.9.9, 203.0.113.9, 10.0.0.4', b = '203.0.113.10, 10.0.0.4';
  for (let i = 0; i < PUBLIC_CLIENT_LIMITS.book.max; i++) assert.equal(limit.admit('book', a), 0);
  assert.equal(limit.admit('book', a), 3600, 'over the hourly booking limit');
  assert.equal(limit.admit('book', '1.2.3.4, 203.0.113.9, 10.0.0.4'), 3600, 'rotating the client-written part does not help');
  assert.equal(limit.admit('book', b), 0, 'another family is not affected');
  assert.equal(limit.admit('cancel', a), 0, 'cancels have their own allowance');
  now = 1_800_000; assert.equal(limit.admit('book', a), 1800);
  now = 3_600_000; assert.equal(limit.admit('book', a), 0, 'the window rolls over');
  const off = new PublicClientLimit(null, () => 0);
  for (let i = 0; i < 100; i++) assert.equal(off.admit('book', a), 0, 'no per-client limit without the setting');
});

function run(middleware, req) {
  return new Promise((resolve) => {
    const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body, headers: this.headers }); }, on() {}, once() {}, emit() {} };
    middleware({ headers: {}, originalUrl: req.path, ...req }, res, () => resolve({ next: true, headers: res.headers }));
  });
}

test('both public transports answer 429 once a client is over its limit', async () => {
  const id = 'c'.repeat(48), xff = '203.0.113.9, 10.0.0.4';
  for (const [make, base] of [[publicBookingTypeTransport, '/v1/public/booking-types'], [publicEventTransport, '/v1/public/events']]) {
    const mw = make(new PublicClientLimit(2, () => 0));
    for (let i = 0; i < PUBLIC_CLIENT_LIMITS.read.max; i++) assert.equal((await run(mw, { method: 'GET', path: `${base}/${id}`, headers: { 'x-forwarded-for': xff } })).next, true);
    const over = await run(mw, { method: 'GET', path: `${base}/${id}`, headers: { 'x-forwarded-for': xff } });
    assert.equal(over.status, 429); assert.deepEqual(over.body, { result: 'RATE_LIMITED' }); assert.equal(over.headers['retry-after'], '60');
    assert.equal((await run(mw, { method: 'GET', path: `${base}/${id}`, headers: { 'x-forwarded-for': '203.0.113.10, 10.0.0.4' } })).next, true, 'another client still reads');
    const post = { method: 'POST', path: `${base}/${id}/bookings`, headers: { 'x-forwarded-for': xff, 'content-type': 'text/plain' } };
    for (let i = 0; i < PUBLIC_CLIENT_LIMITS.book.max; i++) assert.equal((await run(mw, post)).status, 400, 'counted, then refused for its body');
    const full = await run(mw, post);
    assert.equal(full.status, 429); assert.equal(full.headers['retry-after'], '3600');
  }
});
