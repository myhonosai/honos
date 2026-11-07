import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

export const fixture = Object.freeze({ database: 'hon_champions_validation', owner: 'hon_champions_owner', runtime: 'hon_champions_runtime', marker: 'HON disposable Champions Club validation' });
export const proofs = Object.freeze([
  ['test-saas-subscription-generation-integrity.mjs','0189 Commercial B1 immutable generation lineage and fail-closed provider boundary','synthetic generation intent only; no provider evidence/billing/activation'],
  ['test-saas-price-acceptance-integrity.mjs','0188 Commercial A2 immutable pricing and customer acceptance','synthetic offer publication/acceptance only; no checkout, grants or provider traffic'],
  ['test-saas-trial-governance-integrity.mjs','0187 D11-A trial policy/campaign governance and separation','synthetic approvals/publications only; trial activation INACTIVE; zero access/credits'],
  ['test-saas-hon-os-offers-integrity.mjs', '0181 whole-set offers', 'temporary legacy fixture'],
  ['test-saas-hon-os-purchase-integrity.mjs', '0182 accepted-price binding and D6 stop', 'temporary legacy fixture; simulated provider'],
  ['test-saas-hon-os-new-school-onboarding.mjs', '0183 D7 onboarding', 'temporary paid-access and credit-program ACTIVE; zero AI grants; simulated provider', true],
  ['test-saas-hon-os-only-new-sales.mjs', '0184 D8 legacy continuity/closure', 'temporary legacy fixture and paid-access ACTIVE; simulated provider'],
  ['test-saas-secure-hq-provisioning.mjs', '0185 suspended provisioning and revoke-first conversion', 'synthetic exception-only approval; temporary paid-access ACTIVE; simulated provider'],
  ['test-saas-exception-policy-integrity.mjs', '0186 D10 policy authority, validity, binding and concurrency', 'synthetic exception-only decisions; full paid access INACTIVE'],
  ['test-saas-access-exception-hardening.mjs', '0185 authority/concurrency, cleanup and contest windows', 'synthetic exception-only approval; full paid access INACTIVE'],
  ['test-entitlement-enforcement-coverage.mjs', 'runtime entitlement windows and tenant isolation', 'shipped INACTIVE'],
  ['test-champions-club-contests-integrity.mjs', 'contest lifecycle and frozen evidence regression', 'shipped INACTIVE'],
  ['test-champions-club-journey-integrity.mjs', 'referral/contest journey regression', 'shipped INACTIVE'],
]);
export function validateEnvironment(env) {
  const forbidden = /^(?:DATABASE_URL|HON_RUNTIME_DATABASE_URL|PG[A-Z_]*|NODE_OPTIONS|OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|AZURE|GOOGLE_APPLICATION_CREDENTIALS|HEYGEN|HIGGSFIELD|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i;
  const refused = Object.keys(env).filter(k => forbidden.test(k));
  assert(refused.length === 0, 'Refusing inherited database/provider credentials or execution/preload switches (names only): ' + refused.join(', '));
  if (env.GITHUB_ACTIONS === 'true') assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted', 'Only ephemeral GitHub-hosted runners supported in CI.');
}
export function parseArguments(args) {
  assert(args.length === 3 && args[0] === '--confirm-disposable-local' && args[1] === '--report' && args[2]?.startsWith('/'),
    'Usage: node scripts/run-commercial-staging-validation.mjs --confirm-disposable-local --report /absolute/private/report.json');
  return args[2];
}
export function assertEmptyInstance({ databases, roles, honSchema, applicationObjects, listen }) {
  assert(Array.isArray(databases) && databases.length === 0, 'Refusing an existing application/validation database; use a fresh dedicated local PostgreSQL instance.');
  assert(Array.isArray(roles) && roles.length === 0, 'Refusing existing custom roles, including stale fixtures.');
  assert.equal(honSchema, false, 'Refusing HON objects in the maintenance database.');
  assert.equal(applicationObjects, false, 'Refusing application objects in the maintenance database.');
  assert(['localhost', '127.0.0.1', '::1'].includes(listen), 'PostgreSQL must listen only on loopback.');
}
export function parseFixtureCredentials(text) {
  const rows = text.trim().split('\n');
  assert.equal(rows.length, 2, 'Unexpected fixture descriptor.');
  const result = {};
  for (const line of rows) {
    const m = /^export (DATABASE_URL|HON_RUNTIME_DATABASE_URL)='([^'\n]+)'$/.exec(line);
    assert(m && !Object.hasOwn(result, m[1]), 'Unexpected fixture descriptor.');
    const url = new URL(m[2]);
    assert.equal(url.protocol, 'postgresql:'); assert.equal(url.hostname, 'localhost'); assert.equal(url.port, '5432');
    assert.equal(url.pathname, '/' + fixture.database); assert.equal(url.search, ''); assert.equal(url.hash, '');
    assert.equal(url.username, m[1] === 'DATABASE_URL' ? fixture.owner : fixture.runtime); assert(url.password);
    result[m[1]] = url.toString();
  }
  assert(result.DATABASE_URL && result.HON_RUNTIME_DATABASE_URL); return result;
}
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function validateMigrationEvidence(entries, expected) {
  assert(entries.length && new Set(entries.map(x => x.file.slice(0, 4))).size === entries.length, 'Duplicate migration number.');
  assert(!entries.some(x => /^(0179|0180)_/.test(x.file)), 'Reserved migrations must remain absent.');
  assert(entries.at(-1).file.startsWith('0213_'), 'Unreviewed migration ceiling.');
  assert.equal(sha256(JSON.stringify(entries)), expected.chainSha256, 'Migration chain differs from the reviewed baseline.');
  for (const target of expected.targets) assert.deepEqual(entries.find(x => x.file === target.file), target, '0181–0213 checksum mismatch.');
  return { count: entries.length, chainSha256: expected.chainSha256, targets: expected.targets, entries };
}
export async function readMigrationEvidence() {
  const dir = new URL('../migrations/', import.meta.url);
  const entries = [];
  for (const file of (await readdir(dir)).filter(f => /^\d{4}_.+\.sql$/.test(f)).sort()) entries.push({ file, sha256: sha256(await readFile(new URL(file, dir))) });
  const expected = JSON.parse(await readFile(new URL('./commercial-staging-manifest.json', import.meta.url), 'utf8'));
  return validateMigrationEvidence(entries, expected);
}
export function postgresTarget(args) {
  let options = args[0];
  if (Array.isArray(options)) return postgresTarget(options);
  if (typeof options === 'object' && options) {
    if (options.path) return options.path === '/var/run/postgresql/.s.PGSQL.5432';
    return Number(options.port) === 5432 && ['localhost', '127.0.0.1', '::1'].includes(options.host ?? 'localhost');
  }
  if (typeof options === 'string' && options.startsWith('/')) return options === '/var/run/postgresql/.s.PGSQL.5432';
  return Number(options) === 5432 && ['localhost', '127.0.0.1', '::1'].includes(typeof args[1] === 'string' ? args[1] : 'localhost');
}
