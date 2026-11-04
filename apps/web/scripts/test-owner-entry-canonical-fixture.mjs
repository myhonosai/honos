import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { requireCanonicalEntryFixture, canonicalEntrySetup } from './owner-entry-canonical-fixture.mjs';
const environment = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', HON_OWNER_ENTRY_API_TEST: '1' };
const urls = { DATABASE_URL: 'postgresql://hon_flexible_billing_accounts_owner:synthetic@localhost:5432/hon_flexible_billing_accounts_validation', HON_RUNTIME_DATABASE_URL: 'postgresql://hon_flexible_billing_accounts_runtime:synthetic@localhost:5432/hon_flexible_billing_accounts_validation' };
const observed = { owner: 'hon_flexible_billing_accounts_owner', marker: 'HON disposable flexible billing accounts validation', canonicalRoleExists: false };
test('canonical runtime preparation requires the existing exact marked disposable target', () => { requireCanonicalEntryFixture(environment, urls, observed); });
test('local/shared/unmarked/existing-role environments fail before any role operation', () => {
  for (const patch of [{ GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { HON_OWNER_ENTRY_API_TEST: '0' }]) assert.throws(() => requireCanonicalEntryFixture({ ...environment, ...patch }, urls, observed));
  for (const patch of [{ owner: 'postgres' }, { marker: null }, { canonicalRoleExists: true }, { canonicalRoleExists: undefined }]) assert.throws(() => requireCanonicalEntryFixture(environment, urls, { ...observed, ...patch }));
});
test('remote/override/role/database targets are rejected without including credentials in errors', () => {
  for (const from of ['remote.invalid', 'localhost']) for (const suffix of ['?host=remote.invalid', '#fragment', '']) {
    if (from === 'localhost' && suffix === '') continue;
    const values = { ...urls, HON_RUNTIME_DATABASE_URL: `postgresql://hon_flexible_billing_accounts_runtime:SENSITIVE_CANARY@${from}:5432/hon_flexible_billing_accounts_validation${suffix}` };
    assert.throws(() => requireCanonicalEntryFixture(environment, values, observed), e => !e.message.includes('SENSITIVE_CANARY'));
  }
  for (const value of [urls.HON_RUNTIME_DATABASE_URL.replace('5432', '5433'), urls.HON_RUNTIME_DATABASE_URL.replace('hon_flexible_billing_accounts_runtime', 'hon_runtime'), urls.HON_RUNTIME_DATABASE_URL.replace('_validation', '_other')]) assert.throws(() => requireCanonicalEntryFixture(environment, { ...urls, HON_RUNTIME_DATABASE_URL: value }, observed));
});
test('full canonical setup retains the real role and every function/ACL byte outside documented configuration placeholders', async () => {
  const source = await readFile(new URL('../../../infra/postgres/010_supabase_hon_runtime.sql', import.meta.url), 'utf8'), password = 'X'.repeat(48);
  const prepared = canonicalEntrySetup(source, password);
  assert.equal(prepared.replace(password, '<PASTE_FRESH_BASE64URL_PASSWORD_HERE>').replaceAll('DATABASE hon_flexible_billing_accounts_validation', 'DATABASE postgres').replaceAll('FOR ROLE hon_flexible_billing_accounts_owner', 'FOR ROLE postgres'), source);
  assert(prepared.includes('GRANT EXECUTE ON FUNCTION hon.read_current_school_class_sessions(text) TO hon_runtime;'));
  for (const invalid of ['short', "X'.repeat(48)", 'X'.repeat(49)]) assert.throws(() => canonicalEntrySetup(source, invalid));
  assert.throws(() => canonicalEntrySetup(source.replace('<PASTE_FRESH_BASE64URL_PASSWORD_HERE>', 'already-configured'), password));
});
