/**
 * Socket-free regression test for crm-close-proof-target.mjs (Manus P1-166-1, CRM list pagination proof in #166).
 * No client is constructed and nothing connects. For every reported bypass it shows that (a) the previous inline
 * guard accepted the URL, (b) node-postgres's own parser would really have connected somewhere else or with other
 * options, and (c) the new guard refuses it.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CRM_CLOSE_DATABASE as db, CRM_CLOSE_OWNER_ROLE as owner, CRM_CLOSE_RUNTIME_ROLE as runtime, crmCloseTargetConfig as championsTargetConfig, crmCloseProofTargets as championsProofTargets, assertNoLibpqOverrides } from './crm-close-proof-target.mjs';

const { parse } = createRequire(createRequire(import.meta.url).resolve('pg'))('pg-connection-string');
const good = (role = owner, scheme = 'postgresql') => `${scheme}://${role}:pw-1_x@localhost:5432/${db}`;

// The pagination proof at a4479cf had no guard at all; this is the stronger inline guard other CRM-close proofs use
// (hostname/port/path/user on WHATWG URL only), shown to accept every bypass below.
function legacyGuard(ownerRaw, runtimeRaw) {
  const o = new URL(ownerRaw ?? ''), r = new URL(runtimeRaw ?? '');
  if (o.hostname !== 'localhost' || o.port !== '5432' || o.pathname !== `/${db}` || o.username !== owner || r.hostname !== o.hostname
    || r.port !== o.port || r.pathname !== o.pathname || r.username !== runtime) throw new Error('refused');
}

// Accepted: exactly the URLs setup-crm-lead-close-validation.mjs writes.
assert.deepEqual(championsTargetConfig(good(), owner), { host: 'localhost', port: 5432, database: db, user: owner, password: 'pw-1_x', ssl: false });
assert.equal(championsTargetConfig(good(runtime), runtime).user, runtime);
assert.equal(championsTargetConfig(good(owner, 'postgres'), owner).database, db);
assert.equal(championsProofTargets({ DATABASE_URL: good(), HON_RUNTIME_DATABASE_URL: good(runtime), PATH: '/usr/bin' }).runtime.user, runtime);

// Bypasses the previous guard accepted, and where node-postgres would really have gone.
const bypasses = {
  'host override (reported)': [`${good()}?host=example.invalid`, p => p.host === 'example.invalid'],
  'hostaddr override': [`${good()}?hostaddr=192.0.2.1`, p => p.hostaddr === '192.0.2.1'],
  'port override': [`${good()}?port=6543`, p => p.port === '6543'],
  'user override': [`${good()}?user=postgres`, p => p.user === 'postgres'],
  'dbname option': [`${good()}?dbname=postgres`, p => p.dbname === 'postgres'],
  'unix socket via host query': [`${good()}?host=/var/run/other`, p => p.host === '/var/run/other'],
  'sslmode option': [`${good()}?sslmode=disable`, p => p.sslmode === 'disable'],
  'options injection': [`${good()}?options=-c%20search_path%3Dpublic`, p => p.options === '-c search_path=public'],
  'application_name option': [`${good()}?application_name=x`, p => p.application_name === 'x'],
  'empty query': [`${good()}?`, () => true],
  fragment: [`${good()}#host=example.invalid`, () => true],
  'http scheme': [good(owner, 'http'), () => true],
  'socket scheme': [`socket://${owner}:pw-1_x@localhost:5432/${db}`, () => true],
};
for (const [label, [url, redirects]] of Object.entries(bypasses)) {
  assert.doesNotThrow(() => legacyGuard(url, good(runtime)), `legacy guard accepted: ${label}`);
  assert.ok(redirects(parse(url)), `pg interprets it differently: ${label}`);
  assert.throws(() => championsTargetConfig(url, owner), /exact disposable localhost/, label);
  assert.throws(() => championsProofTargets({ DATABASE_URL: good(), HON_RUNTIME_DATABASE_URL: url.replace(owner, runtime) }), /exact disposable localhost/, `runtime ${label}`);
}

// Other refusals: non-loopback, encoded sockets, wrong target, credentials, malformed input.
const refused = {
  'remote host': `postgresql://${owner}:pw-1_x@db.example.invalid:5432/${db}`,
  'other loopback address': `postgresql://${owner}:pw-1_x@127.0.0.2:5432/${db}`,
  'loopback IP instead of the alias': `postgresql://${owner}:pw-1_x@127.0.0.1:5432/${db}`,
  'IPv6 loopback instead of the alias': `postgresql://${owner}:pw-1_x@[::1]:5432/${db}`,
  'percent-encoded socket host': `postgresql://${owner}:pw-1_x@%2Fvar%2Frun%2Fpostgresql:5432/${db}`,
  'percent-encoded password': `postgresql://${owner}:pw%40x@localhost:5432/${db}`,
  'other port': `postgresql://${owner}:pw-1_x@localhost:6543/${db}`,
  'default port': `postgresql://${owner}:pw-1_x@localhost/${db}`,
  'other database': `postgresql://${owner}:pw-1_x@localhost:5432/postgres`,
  'trailing path': `postgresql://${owner}:pw-1_x@localhost:5432/${db}/x`,
  'other role': `postgresql://postgres:pw-1_x@localhost:5432/${db}`,
  'runtime role as owner': good(runtime),
  'missing password': `postgresql://${owner}@localhost:5432/${db}`,
  'empty password': `postgresql://${owner}:@localhost:5432/${db}`,
  'backslash': `postgresql://${owner}:pw-1_x@localhost:5432\\${db}`,
  whitespace: ` ${good()}`,
  'not a URL': 'localhost:5432',
  empty: '',
};
for (const [label, url] of Object.entries(refused)) assert.throws(() => championsTargetConfig(url, owner), /exact disposable localhost/, label);
assert.throws(() => championsTargetConfig(undefined, owner), /exact disposable localhost/, 'unset');
assert.throws(() => championsProofTargets({ DATABASE_URL: good() }), /exact disposable localhost/, 'runtime unset');
assert.throws(() => championsProofTargets({ DATABASE_URL: good(runtime), HON_RUNTIME_DATABASE_URL: good(owner) }), /exact disposable localhost/, 'roles swapped');

assertNoLibpqOverrides({ PATH: '/usr/bin', DATABASE_URL: good() });
for (const k of ['PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGSSLMODE', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS', 'PGPASSFILE'])
  assert.throws(() => championsProofTargets({ [k]: 'x', DATABASE_URL: good(), HON_RUNTIME_DATABASE_URL: good(runtime) }), /libpq/, k);

for (const k of ['OPENAI_API_KEY', 'STRIPE_SECRET_KEY', 'HON_PROVIDER_EXECUTION', 'HON_AI_ENABLED', 'SUPABASE_URL', 'TWILIO_AUTH_TOKEN'])
  assert.throws(() => championsProofTargets({ [k]: 'x', DATABASE_URL: good(), HON_RUNTIME_DATABASE_URL: good(runtime) }), /provider credentials/, k);

console.log(`PASS CRM-close proof target guard: ${Object.keys(bypasses).length} bypasses the previous guard accepted (pg would have redirected) now refused; ${Object.keys(refused).length + 3} other targets refused; 10 libpq PG* overrides and 6 provider/execution variables refused; nothing connected.`);
