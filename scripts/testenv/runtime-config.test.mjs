import assert from 'node:assert/strict';
import test from 'node:test';
import { testEnvironmentRuntime } from './runtime-config.mjs';

test('default private origin remains loopback with unique historical ports', () => {
  const r = testEnvironmentRuntime({});
  assert.equal(r.origin, 'https://localhost:3443');
  assert.equal(r.issuer, 'https://localhost:3443/__test-idp');
  assert.equal(r.ports.web, 3100);
  assert(Object.isFrozen(r) && Object.isFrozen(r.ports));
});
test('a second private instance avoids the existing preview without public binding', () => {
  const r = testEnvironmentRuntime({ HON_TESTENV_GATEWAY_PORT: '3445', HON_TESTENV_WEB_PORT: '3200', HON_TESTENV_API_PORT: '3201', HON_TESTENV_POSTGRES_PORT: '55441' });
  assert.equal(r.origin, 'https://localhost:3445');
  assert.deepEqual(r.ports, { gateway: 3445, web: 3200, api: 3201, postgres: 55441 });
});
test('malformed, duplicate and out-of-range ports fail closed', () => {
  for (const value of ['0', '443', '65536', ' 3200', '3200x', '3e3', '03200', '-3200']) assert.throws(() => testEnvironmentRuntime({ HON_TESTENV_WEB_PORT: value }));
  assert.throws(() => testEnvironmentRuntime({ HON_TESTENV_WEB_PORT: '3001' }));
});

test('public browser origin requires approval and preserves a private TLS back-channel', () => {
  const origin = 'https://private-test.example';
  assert.throws(() => testEnvironmentRuntime({ HON_TESTENV_PUBLIC_ORIGIN: origin }));
  const r = testEnvironmentRuntime({ HON_TESTENV_PUBLIC_ORIGIN: origin, HON_TESTENV_PUBLIC_ACCESS_APPROVAL: 'temporary-passcode-site-v1' });
  assert.equal(r.origin, origin);
  assert.equal(r.privateOrigin, 'https://localhost:3443');
  assert.equal(r.issuer, origin + '/__test-idp');
  for (const bad of ['http://private-test.example', origin + '/', origin + '/path', origin + '?x=1', 'https://u:p@private-test.example']) {
    assert.throws(() => testEnvironmentRuntime({ HON_TESTENV_PUBLIC_ORIGIN: bad, HON_TESTENV_PUBLIC_ACCESS_APPROVAL: 'temporary-passcode-site-v1' }));
  }
});
