const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { gzipSync, deflateSync, brotliCompressSync } = require('node:zlib');
const express = require('express');
const { generalJsonTransport } = require('../dist/foundation/general-json-transport.js');
const { transportErrorHandler } = require('../dist/observability/http-telemetry.js');

async function withServer(run) {
  const app = express();
  app.use(generalJsonTransport());
  app.use(transportErrorHandler());
  app.post('/echo', (req, res) => res.json({ body: req.body }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try { await run(`http://127.0.0.1:${server.address().port}/echo`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

test('general JSON parser accepts ordinary uncompressed JSON', async () => {
  await withServer(async url => {
    const res = await post(url, JSON.stringify({ hello: 'world' }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { body: { hello: 'world' } });
    const identity = await post(url, JSON.stringify({ a: 1 }), { 'content-encoding': 'identity' });
    assert.equal(identity.status, 200);
  });
});

test('general JSON parser refuses every compressed body with 415 and keeps serving (GHSA-27r3-jxmh-p828)', async () => {
  const payload = Buffer.from(JSON.stringify({ hello: 'world' }));
  const truncatedGzip = gzipSync(payload).subarray(0, 12);
  await withServer(async url => {
    for (const [encoding, body] of [['gzip', gzipSync(payload)], ['deflate', deflateSync(payload)], ['br', brotliCompressSync(payload)], ['gzip', truncatedGzip], ['gzip', Buffer.from('not gzip at all')]]) {
      const res = await post(url, body, { 'content-encoding': encoding });
      assert.equal(res.status, 415, `${encoding} must be refused`);
      const answer = await res.json();
      assert.equal(answer.message, 'The request body could not be accepted.');
      assert.equal(JSON.stringify(answer).includes('hello'), false);
    }
    const after = await post(url, JSON.stringify({ still: 'up' }));
    assert.equal(after.status, 200, 'process keeps serving after refused compressed bodies');
  });
});

test('general JSON parser keeps strict mode and the 2mb cap', async () => {
  await withServer(async url => {
    assert.equal((await post(url, '"scalar"')).status, 400);
    assert.equal((await post(url, JSON.stringify({ big: 'x'.repeat(2 * 1024 * 1024) }))).status, 413);
  });
});

test('API entry point mounts the shared general parser, not an inline json() with inflation on', () => {
  const main = readFileSync(require.resolve('../src/main.ts'), 'utf8');
  assert.match(main, /app\.use\(generalJsonTransport\(\)\);/);
  assert.doesNotMatch(main, /\bjson\(\{/);
  const transport = readFileSync(require.resolve('../src/foundation/general-json-transport.ts'), 'utf8');
  assert.match(transport, /inflate: false/);
});

test('locked body-parser is the patched 2.4+ line', () => {
  const lock = readFileSync(require.resolve('../../../pnpm-lock.yaml'), 'utf8');
  const versions = [...lock.matchAll(/^ {2}body-parser@(\d+)\.(\d+)\.(\d+):/gm)].map(m => m.slice(1).map(Number));
  assert.ok(versions.length > 0);
  for (const [major, minor] of versions) assert.ok(major > 2 || (major === 2 && minor >= 4), `body-parser ${major}.${minor} is below 2.4.0`);
});
