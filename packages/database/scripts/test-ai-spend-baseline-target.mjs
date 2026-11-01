/** Socket-free checks of the AI-0 disposable-target guard. No client is constructed and nothing connects. */
import assert from 'node:assert/strict';
import { AI0_DATABASE as db, AI0_OWNER_ROLE as owner, AI0_RUNTIME_ROLE as runtime, assertDisposableTarget, assertNoLibpqOverrides } from './ai-spend-baseline-target.mjs';

const good = (role = owner, scheme = 'postgresql') => `${scheme}://${role}:pw-1@localhost:5432/${db}`;
assert.equal(assertDisposableTarget(good(), owner), good());
assert.equal(assertDisposableTarget(good(runtime), runtime), good(runtime));
assert.equal(assertDisposableTarget(good(owner, 'postgres'), owner), good(owner, 'postgres'));

const refused = {
  'host override query': `${good()}?host=remote.example.invalid`,
  'hostaddr override query': `${good()}?hostaddr=192.0.2.1`,
  'user and port override query': `${good(runtime)}?user=other_user&port=6543`,
  'ssl override query': `${good()}?sslmode=disable`,
  'options override query': `${good()}?options=-c%20search_path%3Dpublic`,
  'empty query': `${good()}?`,
  fragment: `${good()}#host=remote.example.invalid`,
  'empty fragment': `${good()}#`,
  'http scheme': good(owner, 'http'),
  'socket scheme': `socket://${owner}:pw-1@localhost:5432/${db}`,
  'missing password': `postgresql://${owner}@localhost:5432/${db}`,
  'empty password': `postgresql://${owner}:@localhost:5432/${db}`,
  'missing credentials': `postgresql://localhost:5432/${db}`,
  'remote host': `postgresql://${owner}:pw-1@db.example.invalid:5432/${db}`,
  'loopback IP instead of the alias': `postgresql://${owner}:pw-1@127.0.0.1:5432/${db}`,
  'other port': `postgresql://${owner}:pw-1@localhost:6543/${db}`,
  'default port': `postgresql://${owner}:pw-1@localhost/${db}`,
  'other database': `postgresql://${owner}:pw-1@localhost:5432/postgres`,
  'trailing path': `postgresql://${owner}:pw-1@localhost:5432/${db}/x`,
  'other role': `postgresql://postgres:pw-1@localhost:5432/${db}`,
  'runtime role as owner': good(runtime),
  'encoded role spoof': `postgresql://${owner}%00:pw-1@localhost:5432/${db}`,
  'whitespace': ` ${good()}`,
  'not a URL': 'localhost:5432',
  empty: '',
};
for (const [label, url] of Object.entries(refused)) assert.throws(() => assertDisposableTarget(url, owner), /exact disposable localhost/, label);
assert.throws(() => assertDisposableTarget(undefined, owner), /exact disposable localhost/, 'unset');
assert.throws(() => assertDisposableTarget(good(owner), runtime), /exact disposable localhost/, 'owner URL as runtime');

assertNoLibpqOverrides({ PATH: '/usr/bin', DATABASE_URL: good() });
for (const k of ['PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGSSLMODE', 'PGSERVICE', 'PGOPTIONS'])
  assert.throws(() => assertNoLibpqOverrides({ [k]: 'x' }), /libpq/, k);

console.log(`PASS AI-0 target guard: 3 canonical URLs accepted; ${Object.keys(refused).length + 2} overrides, schemes, credentials and targets refused before any client exists; libpq PG* overrides refused.`);
