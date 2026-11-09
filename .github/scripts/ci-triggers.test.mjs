// Guards the CI trigger policy in .github/workflows/ci.yml (B-OPS-1): pull requests, pushes to main
// and manual dispatch; never a schedule, a deployment, secrets or write permissions. Plain Node only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8');
const onBlock = /^on:\n((?:[ #].*\n|\n)+?)^\S/m.exec(workflow)[1];

test('CI runs on pull requests, on pushes to main and on manual dispatch only', () => {
  assert.match(onBlock, /^ {2}pull_request:\n {4}branches: \[main\]/m);
  assert.match(onBlock, /^ {2}push:\n {4}branches: \[main\]\n/m);
  assert.match(onBlock, /^ {2}workflow_dispatch:/m);
  assert.deepEqual([...onBlock.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]), ['pull_request', 'push', 'workflow_dispatch']);
  assert.doesNotMatch(workflow, /^\s*schedule:/m);
  assert.doesNotMatch(workflow, /branches: \[[^\]]*['"]?\*/, 'no wildcard branch triggers');
});

test('docs-only changes are skipped for pushes as for pull requests', () => {
  const push = /^ {2}push:\n((?: {4,}.*\n)+)/m.exec(onBlock)[1];
  assert.match(push, /paths-ignore:\n {6}- 'docs\/\*\*'\n {6}- '\*\*\/\*\.md'/);
});

test('every job runs for push and dispatch, and still skips draft pull requests', () => {
  const conditions = [...workflow.matchAll(/^ {4}if: (.+)$/gm)].map((m) => m[1]);
  assert.equal(conditions.length, 2);
  for (const condition of conditions) {
    assert.equal(condition, "github.event_name != 'pull_request' || github.event.pull_request.draft == false");
  }
});

test('read-only token, no secrets, no deployment, superseded runs cancelled', () => {
  assert.match(workflow, /^permissions:\n {2}contents: read\n/m);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(workflow, /\b(deploy|render\.com|supabase\.co|db:migrate)\b/i);
  assert.match(workflow, /group: ci-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}\n {2}cancel-in-progress: true/);
});
