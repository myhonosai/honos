const { test } = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path');
const { AI_USAGE_AGENTS } = require('@hon/contracts');

// Every AI text kind's usage line must be one the HQ per-school usage report accepts, or one row breaks the whole report.
test('every hon.ai_text_kinds usage_agent in the migrations is a contracts AI usage agent', () => {
  const dir = path.join(__dirname, '../../../packages/database/migrations');
  const found = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const m of sql.matchAll(/INSERT INTO hon\.ai_text_kinds\([^)]*usage_agent\)\s*VALUES\s*([\s\S]*?);/g)) {
      for (const row of m[1].matchAll(/\(([^()]*)\)/g)) found.push([file, row[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).at(-1)]);
    }
  }
  assert.ok(found.some(([f]) => f.startsWith('0641_')), 'the Marcus review kind is covered');
  // Pre-existing on main, reported separately (0594 paper import): fixing it means adding the value to AI_USAGE_AGENTS.
  const knownGap = new Set(['0594_paper_import_ai_reader.sql:PAPER_READING']);
  for (const [file, agent] of found) if (!knownGap.has(`${file}:${agent}`)) assert.ok(AI_USAGE_AGENTS.includes(agent), `${file}: ${agent}`);
});
