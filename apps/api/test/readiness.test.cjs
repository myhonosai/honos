const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { ServiceUnavailableException } = require('@nestjs/common');
const { ReadinessController } = require('../dist/health/readiness.controller.js');

const controllerWith = (probe) => new ReadinessController({ probe });

test('readiness: 200 body when the runtime database probe succeeds', async () => {
  assert.deepEqual(await controllerWith(async () => {}).ready(), { status: 'ready', persistence: 'configured' });
});

test('readiness: a connection failure (e.g. untrusted TLS certificate) is 503 PERSISTENCE_UNAVAILABLE, not 500', async () => {
  for (const cause of [
    Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }),
    Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED' }),
    new Error('Connection terminated due to connection timeout'),
  ]) {
    await assert.rejects(controllerWith(async () => { throw cause; }).ready(), (error) => {
      assert.ok(error instanceof ServiceUnavailableException, cause.message);
      assert.equal(error.getStatus(), 503);
      const body = error.getResponse();
      assert.equal(body.code, 'PERSISTENCE_UNAVAILABLE');
      assert.ok(!JSON.stringify(body).includes(cause.message), 'the low-level cause is never echoed to the caller');
      return true;
    });
  }
});

test('readiness: existing 503 configuration / unsafe-role refusals pass through unchanged', async () => {
  const refusal = new ServiceUnavailableException({ status: 503, code: 'PERSISTENCE_NOT_CONFIGURED' });
  await assert.rejects(controllerWith(async () => { throw refusal; }).ready(), (error) => error === refusal);
});
