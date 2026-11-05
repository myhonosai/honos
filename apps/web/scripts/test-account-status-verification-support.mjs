import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireAccountStatusRun } from './account-status-verification-support.mjs';
const sha = 'a'.repeat(40), repository = '/workspace/source';
const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', HON_ACCOUNT_STATUS_TEST: '1', HON_ACCOUNT_STATUS_SHA: sha,
  HON_ACCOUNT_STATUS_TOOLS: '/tmp/tools', HON_ACCOUNT_STATUS_CHROME: '/usr/bin/chromium', HON_ACCOUNT_STATUS_RESULTS: '/tmp/results' };
test('account evidence requires hosted exact-head opt-in and separate normalized artifacts', () => {
  assert.equal(requireAccountStatusRun(env, sha, repository).sourceSha, sha);
  for (const patch of [{ GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { HON_ACCOUNT_STATUS_TEST: '0' },
    { HON_ACCOUNT_STATUS_SHA: 'b'.repeat(40) }, { HON_ACCOUNT_STATUS_RESULTS: '../results' }, { HON_ACCOUNT_STATUS_CHROME: '/tmp/../chrome' },
    { HON_ACCOUNT_STATUS_RESULTS: '/workspace/source/results' }, { HON_ACCOUNT_STATUS_RESULTS: '/tmp/tools' }]) assert.throws(() => requireAccountStatusRun({ ...env, ...patch }, sha, repository));
});
test('account evidence refuses inherited live, auth, provider, execution and libpq authority without echoing values', () => {
  for (const key of ['NODE_ENV', 'HON_AUTH_MODE', 'HON_DEV_SUBJECT', 'HON_PUBLIC_ORIGIN', 'HON_SESSION_JWT_SECRET', 'PGHOST', 'PGOPTIONS',
    'STRIPE_API_KEY', 'OPENROUTER_TOKEN', 'SUPABASE_URL', 'HON_WORKER_ENABLED', 'HON_AI_ENABLED', 'SOMETHING_PRIVATE_KEY']) {
    const value = key === 'NODE_ENV' ? 'production' : 'SENSITIVE_CANARY';
    assert.throws(() => requireAccountStatusRun({ ...env, [key]: value }, sha, repository), error => !error.message.includes('SENSITIVE_CANARY'));
  }
});
