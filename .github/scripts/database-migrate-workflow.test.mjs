// Guards .github/workflows/database-migrate.yml: the only workflow allowed to touch a live database.
// It must run only when a person presses "Run workflow" on main, use the chosen GitHub environment's
// secrets only in database steps, require a typed confirmation to migrate, and never be cancelled
// mid-run. Plain Node only; reads the file as text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../workflows/', import.meta.url);
const workflow = readFileSync(new URL('database-migrate.yml', dir), 'utf8');
const onBlock = /^on:\n((?:[ #].*\n|\n)+?)^\S/m.exec(workflow)[1];
const steps = workflow.split(/\n {6}- /).slice(1);

test('manual dispatch only, from main only', () => {
  assert.deepEqual([...onBlock.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]), ['workflow_dispatch']);
  assert.match(workflow, /^ {4}if: github\.ref == 'refs\/heads\/main'$/m);
  assert.match(onBlock, /options: \[staging, production\]/);
  assert.match(onBlock, /options: \[status, migrate, verify\]\n {8}default: status/);
});

test('secrets come from the chosen environment and only reach database steps', () => {
  assert.match(workflow, /^ {4}environment: \$\{\{ inputs\.target \}\}$/m);
  assert.match(workflow, /^permissions:\n {2}contents: read\n/m);
  assert.match(workflow, /persist-credentials: false/);
  const secretKeys = new Set([...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]));
  assert.deepEqual([...secretKeys].sort(), ['DATABASE_URL', 'HON_DATABASE_CA_CERT']);
  for (const step of steps) {
    if (!step.includes('secrets.')) continue;
    assert.match(step, /run: pnpm (db:migrate|db:verify-rls|--filter @hon\/database db:status( --require-current)?)\n?$/, step.split('\n')[0]);
  }
  assert.ok(!steps.some((step) => /install|checkout|setup|db:check/.test(step.split('\n')[0]) && step.includes('secrets.')));
});

test('migrate needs the target typed again, runs after a checksum check, and must end current', () => {
  const index = (needle) => steps.findIndex((step) => step.includes(needle));
  const refuse = steps[index('Refuse migrate')];
  assert.match(refuse, /if: inputs\.action == 'migrate' && inputs\.confirm != inputs\.target/);
  assert.match(refuse, /exit 1/);
  assert.ok(index('Refuse migrate') === 0, 'confirmation is checked before anything else');
  assert.ok(index('db:check') < index('run: pnpm db:migrate'));
  assert.match(steps[index('run: pnpm db:migrate')], /if: inputs\.action == 'migrate'/);
  assert.match(steps[index('--require-current')], /if: inputs\.action == 'migrate'/);
  assert.match(steps[index('db:verify-rls')], /if: inputs\.action == 'verify'/);
});

test('one run per database, never cancelled mid-migration, no deploy', () => {
  assert.match(workflow, /group: database-migrate-\$\{\{ inputs\.target \}\}\n {2}cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /\b(render\.com|deploy hook|vercel|flyctl)\b/i);
  assert.doesNotMatch(workflow, /secrets\.(OPENROUTER|STRIPE|ZERNIO|MANUS)/);
});

test('no other workflow reads a database secret', () => {
  for (const file of readdirSync(dir).filter((name) => /\.ya?ml$/.test(name) && name !== 'database-migrate.yml')) {
    assert.doesNotMatch(readFileSync(new URL(file, dir), 'utf8'), /secrets\.(DATABASE_URL|HON_DATABASE_CA_CERT|HON_RUNTIME_DATABASE_URL)/, file);
  }
});
