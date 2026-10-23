import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MINIMUM_PATCHED, nodeRuntimeRefusal } from './verify-node-runtime.mjs';

const script = fileURLToPath(new URL('./verify-node-runtime.mjs', import.meta.url));

test('accepts each patched release line and later releases', () => {
  for (const version of ['22.23.4', 'v22.23.4', '22.23.5', '22.24.0', '24.22.1', '24.23.0', '26.12.1', '26.13.0']) {
    assert.equal(nodeRuntimeRefusal(version), null, version);
  }
});

test('refuses every release before the October 2026 security releases', () => {
  // 22.23.3 is the version PR #53 CI actually executed after the advisory.
  for (const version of ['22.23.3', '22.22.0', '22.0.0', '24.22.0', '24.21.9', '26.12.0', '26.11.1']) {
    assert.match(nodeRuntimeRefusal(version), /predates the \d+\.x security release/, version);
  }
});

test('refuses unsupported, odd and end-of-life release lines', () => {
  for (const version of ['18.20.8', '20.19.9', '21.7.3', '23.11.1', '25.9.0', '27.0.0']) {
    assert.match(nodeRuntimeRefusal(version), /not a supported release line/, version);
  }
});

test('refuses malformed versions', () => {
  for (const version of ['', '22', '22.23', '22.23.4-rc.1', 'latest', 'lts/*']) {
    assert.match(nodeRuntimeRefusal(version), /unrecognized Node\.js version/, JSON.stringify(version));
  }
});

test('an exact pin must match the running version and must itself be patched', () => {
  assert.equal(nodeRuntimeRefusal('22.23.4', '22.23.4'), null);
  assert.match(nodeRuntimeRefusal('22.23.5', '22.23.4'), /workflow pinned 22\.23\.4/);
  assert.match(nodeRuntimeRefusal('22.23.3', '22.23.3'), /predates/);
  assert.match(nodeRuntimeRefusal('22.23.4', '22'), /unrecognized expected/);
});

test('floors match the published advisory', () => {
  assert.deepEqual({ ...MINIMUM_PATCHED }, { 22: '22.23.4', 24: '24.22.1', 26: '26.12.1' });
  assert.ok(Object.isFrozen(MINIMUM_PATCHED));
});

test('command line exits non-zero on refusal and on bad arguments', () => {
  const current = process.versions.node;
  const pinned = spawnSync(process.execPath, [script, '--expect', '0.0.1'], { encoding: 'utf8' });
  assert.equal(pinned.status, 1);
  assert.match(pinned.stderr, new RegExp(`Node\\.js ${current.replaceAll('.', '\\.')} is running but the workflow pinned 0\\.0\\.1`));
  const usage = spawnSync(process.execPath, [script, '--bogus'], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  const plain = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(plain.status, nodeRuntimeRefusal(current) === null ? 0 : 1);
});
