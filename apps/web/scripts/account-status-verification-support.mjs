import assert from 'node:assert/strict';
import { isAbsolute, normalize } from 'node:path';

/** Before clients, session signing or listeners: hosted, exact-head, clean test configuration only. */
export function requireAccountStatusRun(env, sourceSha, repository) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Disposable hosted runner required.');
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted', 'Disposable hosted runner required.');
  assert.equal(env.HON_ACCOUNT_STATUS_TEST, '1', 'Explicit account-status proof opt-in required.');
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  assert.equal(env.HON_ACCOUNT_STATUS_SHA, sourceSha, 'Evidence checkout must equal the requested head.');
  for (const key of Object.keys(env)) {
    assert(!/^(?:PG[A-Z_]*|(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|HEYGEN|HIGGSFIELD|GOOGLE|STRIPE|SQUARE|TWILIO|ZERNIO|SENDGRID|MAILGUN|POSTMARK|SUPABASE|AWS|AZURE|GCP)(?:_|$)|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER)(?:_|$))/i.test(key), 'Inherited provider, execution or PostgreSQL override refused.');
    if (!['DATABASE_URL', 'HON_RUNTIME_DATABASE_URL'].includes(key)) assert(!/(?:^|_)(?:SECRET|PASSWORD|TOKEN|API_KEY|PRIVATE_KEY|CREDENTIALS?)(?:_|$)/i.test(key), 'Inherited credentials refused.');
  }
  for (const key of ['NODE_ENV', 'HON_ENV', 'HON_ENVIRONMENT', 'APP_ENV', 'ENVIRONMENT']) assert(!/^(?:production|prod|live)$/i.test(env[key] ?? ''), 'Live environment refused.');
  for (const key of ['HON_AUTH_MODE', 'HON_DEV_SUBJECT', 'HON_SESSION_AUDIENCE', 'HON_SESSION_JWT_SECRET', 'HON_PUBLIC_ORIGIN', 'HON_API_BASE_URL']) assert(env[key] === undefined, 'Inherited auth/origin authority refused.');
  const paths = {};
  for (const key of ['TOOLS', 'CHROME', 'RESULTS']) {
    const value = env[`HON_ACCOUNT_STATUS_${key}`];
    assert(typeof value === 'string' && isAbsolute(value) && normalize(value) === value && value !== '/', 'Absolute normalized tool/artifact paths required.');
    paths[key.toLowerCase()] = value;
  }
  assert.notEqual(paths.results, paths.tools);
  assert(!paths.results.startsWith(repository + '/') && paths.results !== repository, 'Artifacts must be outside source.');
  return Object.freeze({ ...paths, sourceSha });
}

/** Fixture diagnostics retain known symbolic codes and canonical locations only.
 * Never include arbitrary exception messages, SQL, parameters, bodies or stacks. */
export function accountFailureDiagnostic(body, error) {
  const apiCodes = new Set(['SAAS_UNAVAILABLE', 'SAAS_FORBIDDEN', 'INVALID_SAAS_INPUT', 'PERSISTENCE_NOT_CONFIGURED', 'HUMAN_UI_REQUIRED', 'UNAUTHENTICATED']);
  const pgCodes = new Set(['42501', '55000', '42703', '42883', '42P01', '42804', 'XX000', '0A000', '25006', '57014', '55P03', '22P02', '23514']);
  const functions = new Set(['read_saas_creative_wallet', 'saas_creative_wallet_json', 'saas_creative_eligibility', 'saas_organization_access',
    'saas_creative_balance_json', 'saas_creative_rates_json', 'saas_creative_packages_json', 'require_saas_school_actor']);
  const locations = [];
  if (typeof error?.where === 'string') for (const match of error.where.slice(0, 8192).matchAll(/(?:PL\/pgSQL|SQL) function (?:hon\.)?([a-z_]+)\([^\n]*?\) line (\d+)/g)) {
    const line = Number(match[2]); if (functions.has(match[1]) && line > 0 && line <= 10000) locations.push({ function: match[1], line });
  }
  return { apiCode: apiCodes.has(body?.code) ? body.code : 'UNRECOGNIZED',
    pgCode: pgCodes.has(error?.code) ? error.code : error === undefined ? null : 'UNRECOGNIZED',
    databaseErrorClass: error === undefined ? null : error?.message === 'record "per" is not assigned yet' ? 'UNASSIGNED_PERIOD_RECORD' : 'UNCLASSIFIED', locations };
}
