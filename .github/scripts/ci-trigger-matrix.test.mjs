// Trigger-matrix regression for duplicate suite gating (docs/CI.md). Dependency-free: reads the workflow files as text.
// A feature job gated with "base.ref != 'main' || draft" relies on ci.yml for ready PRs to main; one gated with
// "base.ref != 'main'" alone relies on owner-experience-integration.yml. For every path that triggers a gated workflow,
// the covering workflow must trigger too, including markdown-only and workflow-file-only changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = new URL('../workflows/', import.meta.url).pathname;
const CI_GATE = "(github.event.pull_request.base.ref != 'main' || github.event.pull_request.draft)";
const MAIN_GATE = "github.event.pull_request.base.ref != 'main'";

function list(text, key) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `    ${key}:`);
  if (start < 0) return null;
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\s*#/.test(l)) continue;
    const m = /^      - '([^']+)'$/.exec(l);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}
function workflow(file) {
  const text = readFileSync(join(dir, file), 'utf8');
  const pr = text.split('\n  pull_request:\n')[1]?.split(/\n  [a-z_]+:\n|\n[a-z]/)[0] ?? '';
  const branches = /branches: \[([^\]]*)\]/.exec(pr)?.[1].split(',').map((b) => b.trim()) ?? [];
  return { file, text, branches, paths: list(text, 'paths'), ignore: list(text, 'paths-ignore') };
}
// `**/` also matches zero directories (so `**/*.md` matches a root README.md), as in GitHub's filter patterns.
const rx = (p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0001/g, '(?:.*/)?').replace(/\u0000/g, '.*')}$`);
// GitHub semantics: with `paths`, the last matching pattern decides (a leading ! excludes); with `paths-ignore`, any match excludes.
function triggers(w, file) {
  if (w.paths) {
    let hit = false;
    for (const p of w.paths) { const neg = p.startsWith('!'); if (rx(neg ? p.slice(1) : p).test(file)) hit = !neg; }
    return hit;
  }
  if (w.ignore) return !w.ignore.some((p) => rx(p).test(file));
  return true;
}
// Concrete files a pattern selects, including markdown and nested files.
const samples = (p) => p.startsWith('!') ? [] : [...new Set(['README.md', 'x/y.ts', 'notes.md'].map((s) => p.replace(/\*\*.*$/, s).replace(/\*/g, 'sample').replace(/\?/g, 'x')).concat(p.includes('*') ? [] : [p]))];

const all = readdirSync(dir).filter((f) => f.endsWith('.yml')).map(workflow);
const ci = all.find((w) => w.file === 'ci.yml');
const owner = all.find((w) => w.file === 'owner-experience-integration.yml');
const gated = (gate) => all.filter((w) => w.file !== 'ci.yml' && w.text.split('\n').some((l) => /^    if: /.test(l) && l.endsWith(` && ${gate}`)));

test('the gating is present where docs/CI.md says', () => {
  assert.deepEqual(gated(CI_GATE).map((w) => w.file).sort(), ['commercial-staging-validation.yml', 'connected-student-operations-validation.yml', 'crm-membership-recovery-integration.yml',
    'hq-school-create-validation.yml', 'membership-dates-validation.yml', 'owner-experience-integration.yml']);
  assert.deepEqual(gated(MAIN_GATE).map((w) => w.file).sort(), ['connected-student-operations-validation.yml', 'crm-membership-recovery-integration.yml', 'membership-dates-validation.yml']);
});

test('every file that triggers a CI-gated workflow on main also triggers ci.yml', () => {
  for (const w of gated(CI_GATE)) {
    assert.ok(w.branches.includes('main') && w.paths, w.file);
    for (const file of [...w.paths.flatMap(samples), `.github/workflows/${w.file}`]) {
      if (triggers(w, file)) assert.ok(triggers(ci, file), `${w.file}: ${file} would skip its full suites without regular CI`);
    }
  }
  // Review regressions (P2-159-1): markdown-only changes the feature workflows select.
  for (const file of ['docs/architecture/CRM_LEAD_MEMBERSHIP_RECOVERY_FRONTEND.md', 'apps/web/README.md']) assert.ok(triggers(ci, file), file);
  // Plain docs still skip regular CI.
  for (const file of ['docs/hon/README.md', 'README.md', 'packages/api/NOTES.md']) assert.equal(triggers(ci, file), false, file);
  assert.ok(triggers(ci, 'packages/contracts/src/x.ts') && triggers(ci, '.github/workflows/ci.yml'));
});

test('every file that triggers a rehearsal-gated workflow also triggers owner-experience-integration.yml', () => {
  for (const w of gated(MAIN_GATE)) {
    for (const file of [...w.paths.flatMap(samples), `.github/workflows/${w.file}`]) {
      if (triggers(w, file)) assert.ok(triggers(owner, file), `${w.file}: ${file} would skip the commercial rehearsal`);
    }
  }
  // Review regressions (P2-159-2): workflow-file-only changes.
  for (const f of ['connected-student-operations-validation.yml', 'crm-membership-recovery-integration.yml', 'membership-dates-validation.yml']) assert.ok(triggers(owner, `.github/workflows/${f}`), f);
});
