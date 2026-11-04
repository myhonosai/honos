import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCleanupStack, STATE_MARKER, validateStateDirectory } from './state-safety.mjs';

function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'hon-state-safety-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'checkout'); mkdirSync(root, { mode: 0o700 });
  const dir = join(parent, 'state');
  const create = () => {
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, 'MARKER'), `${STATE_MARKER}\n`, { mode: 0o600 });
  };
  return { parent, root, dir, create };
}

test('fresh QA requires an absolute external path and never reuses existing state', (t) => {
  const f = fixture(t);
  assert.equal(validateStateDirectory(f.dir, { root: f.root, requireFresh: true }), f.dir);
  assert.throws(() => validateStateDirectory('relative', { root: f.root }), /absolute/);
  assert.throws(() => validateStateDirectory(join(f.root, 'state'), { root: f.root }), /outside/);
  f.create();
  assert.throws(() => validateStateDirectory(f.dir, { root: f.root, requireFresh: true }), /existing/);
  assert.equal(validateStateDirectory(f.dir, { root: f.root }), f.dir);
});

test('existing marker must be exact, private and regular', (t) => {
  const f = fixture(t); f.create();
  writeFileSync(join(f.dir, 'MARKER'), 'unrelated state\n');
  assert.throws(() => validateStateDirectory(f.dir, { root: f.root }), /invalid/);
  writeFileSync(join(f.dir, 'MARKER'), `${STATE_MARKER}\n`);
  chmodSync(join(f.dir, 'MARKER'), 0o644);
  assert.throws(() => validateStateDirectory(f.dir, { root: f.root }), /another user/);
  chmodSync(join(f.dir, 'MARKER'), 0o600); chmodSync(f.dir, 0o755);
  assert.throws(() => validateStateDirectory(f.dir, { root: f.root }), /0700/);
});

test('symlinked home and ancestor aliases cannot select retained state or repository paths', (t) => {
  const f = fixture(t); f.create();
  const alias = join(f.parent, 'alias'); symlinkSync(f.dir, alias);
  assert.throws(() => validateStateDirectory(alias, { root: f.root }), /symlink/);
  assert.throws(() => validateStateDirectory(join(alias, 'new'), { root: f.root, requireFresh: true }), /symlink/);
  const checkoutAlias = join(f.parent, 'checkout-alias'); symlinkSync(f.root, checkoutAlias);
  assert.throws(() => validateStateDirectory(join(checkoutAlias, 'new'), { root: f.root }), /symlink/);
});

test('secret links, hardlinks, and aliased cluster directories fail closed', (t) => {
  const f = fixture(t); f.create();
  const outside = join(f.parent, 'private'); writeFileSync(outside, 'NOT A CREDENTIAL', { mode: 0o600 });
  symlinkSync(outside, join(f.dir, 'secrets.json'));
  assert.throws(() => validateStateDirectory(f.dir, { root: f.root }), /non-linked/);
  rmSync(join(f.dir, 'secrets.json')); linkSync(outside, join(f.dir, 'secrets.json'));
  assert.throws(() => validateStateDirectory(f.dir, { root: f.root }), /non-linked/);
  rmSync(join(f.dir, 'secrets.json')); symlinkSync(f.root, join(f.dir, 'pgdata'));
  assert.throws(() => validateStateDirectory(f.dir, { root: f.root }), /real private directory/);
});

for (const failure of ['migration', 'ACL', 'bootstrap', 'gateway listen', 'readiness']) {
  test(`injected ${failure} failure awaits LIFO cleanup exactly once`, async () => {
    const cleanup = createCleanupStack(); const calls = [];
    cleanup.add(async () => { await Promise.resolve(); calls.push('postgres'); });
    if (['gateway listen', 'readiness'].includes(failure)) {
      cleanup.add(async () => { await Promise.resolve(); calls.push('api'); });
      cleanup.add(async () => { await Promise.resolve(); calls.push('web'); });
    }
    await assert.rejects(async () => {
      try { throw new Error(failure); } catch (error) { await cleanup.close(); throw error; }
    }, new RegExp(failure));
    const expected = ['gateway listen', 'readiness'].includes(failure) ? ['web', 'api', 'postgres'] : ['postgres'];
    assert.deepEqual(calls, expected);
    assert.deepEqual(await cleanup.close(), []); assert.deepEqual(calls, expected);
    assert.throws(() => cleanup.add(() => {}), /after cleanup/);
  });
}

test('cleanup continues past stop errors, records them and shares one awaited completion', async () => {
  const cleanup = createCleanupStack(); const calls = [];
  cleanup.add(async () => { calls.push('postgres'); });
  cleanup.add(async () => { calls.push('web'); throw new Error('injected stop failure'); });
  const first = cleanup.close(); const second = cleanup.close(); assert.equal(first, second);
  const errors = await first; assert.deepEqual(calls, ['web', 'postgres']); assert.equal(errors.length, 1);
});

test('cleanup is already closed to registrations while its callbacks execute', async () => {
  const cleanup = createCleanupStack(); let completion;
  cleanup.add(() => {
    assert.throws(() => cleanup.add(() => {}), /after cleanup/);
    assert.equal(cleanup.close(), completion);
  });
  completion = cleanup.close(); assert.deepEqual(await completion, []);
});

test('real launcher registers database cleanup before launch/migration and awaits fatal cleanup', () => {
  const code = readFileSync(new URL('./testenv.mjs', import.meta.url), 'utf8');
  const start = code.indexOf("'-w', 'start'");
  const register = code.indexOf('cleanup.add(stopDatabase)');
  const migrate = code.indexOf('Applying repository migrations', start);
  assert(register > 0 && start > register && migrate > start);
  assert.match(code, /function fail\(message\) \{ throw new Error\(message\); \}/);
  assert.match(code, /await cleanup\.close\(\)/);
  assert.match(code, /await shutdown\(1\)/);
  assert.match(code, /ensureState\(dir, \{ requireFresh: args\.includes\('--fresh'\) \}\)/);
  assert.match(code, /mkdirSync\(dir, \{ mode: 0o700 \}\)/);
});
