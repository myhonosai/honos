import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireOwnerWorkflowRun, nativeTransportObservation } from './owner-workflow-support.mjs';
const sha = 'a'.repeat(40);
const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', HON_OWNER_WORKFLOW_TEST: '1', HON_OWNER_WORKFLOW_SHA: sha,
  HON_OWNER_WORKFLOW_TOOLS: '/tmp/tools', HON_OWNER_WORKFLOW_CHROME: '/usr/bin/chromium', HON_OWNER_WORKFLOW_RESULTS: '/tmp/results' };
test('native browser fixture refuses local/self-hosted/stale-head execution and inherited auth/origin authority', () => {
  assert.equal(requireOwnerWorkflowRun(env, sha).sourceSha, sha);
  for (const patch of [{ GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { HON_OWNER_WORKFLOW_TEST: '0' }, { HON_OWNER_WORKFLOW_SHA: 'b'.repeat(40) },
    { HON_AUTH_MODE: 'DEVELOPMENT' }, { HON_DEV_SUBJECT: 'forged' }, { HON_PUBLIC_ORIGIN: 'https://example.test' }, { HON_SESSION_JWT_SECRET: 'SENSITIVE_CANARY' },
    { HON_OWNER_WORKFLOW_RESULTS: '../outside' }, { HON_OWNER_WORKFLOW_TOOLS: '/tmp/../tools' }]) {
    assert.throws(() => requireOwnerWorkflowRun({ ...env, ...patch }, sha), error => !error.message.includes('CANARY'));
  }
});
test('native trace retains origin absence and proxy header names without cookie, credentials, query values or arbitrary headers', () => {
  const trace = nativeTransportObservation('GET', '/api/v1/example?studentProfileId=PRIVATE_CANARY', {
    Cookie: 'SENSITIVE_CANARY', Authorization: 'SENSITIVE_CANARY', 'x-forwarded-for': 'SENSITIVE_CANARY', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin',
  }, 'http://127.0.0.1:3000');
  assert.deepEqual(trace, { method: 'GET', path: '/api/v1/example', originPresent: false, originMatches: false, fetchSite: 'same-origin', fetchMode: 'same-origin', forwardedHeaderNames: ['x-forwarded-for'] });
  assert(!JSON.stringify(trace).includes('CANARY'));
  assert.equal(nativeTransportObservation('POST', '/api/v1/example', { Origin: 'http://127.0.0.1:3000' }, 'http://127.0.0.1:3000').originMatches, true);
});
