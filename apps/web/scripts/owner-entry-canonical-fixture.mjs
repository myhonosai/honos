import { flexibleBillingAccountsFixture as fixture } from '../../../packages/database/scripts/flexible-billing-accounts-local-guard.mjs';

/** Socket-free preconditions. Only a fresh ephemeral hosted fixture may create
 * the production-named role required by readStaffReportingSchools's real guard. */
export function requireCanonicalEntryFixture(environment, urls, observed) {
  if (environment.GITHUB_ACTIONS !== 'true' || environment.RUNNER_ENVIRONMENT !== 'github-hosted'
    || environment.HON_OWNER_ENTRY_API_TEST !== '1') throw new Error('Canonical entry fixture requires an ephemeral hosted test runner.');
  if (observed.owner !== fixture.owner || observed.marker !== 'HON disposable flexible billing accounts validation'
    || observed.canonicalRoleExists !== false) throw new Error('Canonical entry fixture requires a marked database and a fresh role; existing roles are never changed.');
  for (const [key, user] of [['DATABASE_URL', fixture.owner], ['HON_RUNTIME_DATABASE_URL', fixture.runtime]]) {
    let u; try { u = new URL(urls[key]); } catch { throw new Error('Canonical entry fixture target refused.'); }
    if (u.protocol !== 'postgresql:' || u.hostname !== 'localhost' || u.port !== '5432' || u.pathname !== `/${fixture.database}`
      || u.username !== user || !u.password || u.search || u.hash) throw new Error('Canonical entry fixture target refused.');
  }
}

/** Only the documented password/database/default-owner deployment placeholders
 * change. No function, grant, verifier, role-name alias or authority check changes. */
export function canonicalEntrySetup(canonicalSql, password) {
  if (!/^[A-Za-z0-9_-]{48}$/.test(password) || canonicalSql.split('<PASTE_FRESH_BASE64URL_PASSWORD_HERE>').length !== 2) throw new Error('Canonical entry fixture configuration refused.');
  return canonicalSql.replace('<PASTE_FRESH_BASE64URL_PASSWORD_HERE>', password)
    .replaceAll('DATABASE postgres', `DATABASE ${fixture.database}`)
    .replaceAll('FOR ROLE postgres', `FOR ROLE ${fixture.owner}`);
}
