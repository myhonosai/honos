import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { applyMigrationAtomically, migrationsDirectory, withoutFinalCommit } from './migration-chain.mjs';

// Launch-readiness P2: a migration and its ledger row commit in one transaction.
const fakeClient = (failOn) => {
  const calls = [];
  return { calls, query: async (sql, values) => { calls.push(values ? [sql, values] : sql); if (failOn && String(sql).includes(failOn)) throw new Error('boom'); return { rows: [] }; } };
};

test('the migration body, ledger row and one COMMIT run in that order', async () => {
  const client = fakeClient();
  await applyMigrationAtomically(client, '0001_x.sql', 'BEGIN;\nCREATE TABLE t();\nCOMMIT;\n');
  assert.deepEqual(client.calls, ['BEGIN;\nCREATE TABLE t();\n',
    ['INSERT INTO hon.schema_migrations (filename) VALUES ($1)', ['0001_x.sql']], 'COMMIT']);
});

test('a failed ledger row rolls back and never commits', async () => {
  const client = fakeClient('schema_migrations');
  await assert.rejects(() => applyMigrationAtomically(client, '0001_x.sql', 'BEGIN;\nSELECT 1;\nCOMMIT;\n'), /boom/);
  assert.equal(client.calls.at(-1), 'ROLLBACK');
  assert.ok(!client.calls.includes('COMMIT'));
});

test('files without one outer transaction, or with an inner boundary, and odd names are refused before running', async () => {
  for (const sql of ['CREATE TABLE t();', 'BEGIN;\nSELECT 1;', 'BEGIN;\nSELECT 1;\nCOMMIT;\nBEGIN;\nSELECT 2;\nCOMMIT;', 'BEGIN;\nROLLBACK;\nCOMMIT;']) {
    const client = fakeClient();
    await assert.rejects(() => applyMigrationAtomically(client, '0001_x.sql', sql));
    assert.equal(client.calls.length, 0);
  }
  await assert.rejects(() => applyMigrationAtomically(fakeClient(), "0001_x'.sql", 'BEGIN;\nCOMMIT;'));
});

test('every accepted migration file has exactly one outer transaction the runner can extend', async () => {
  const files = (await readdir(migrationsDirectory)).filter((file) => /^\d{4}_.+\.sql$/.test(file));
  assert.ok(files.length > 300);
  for (const file of files) withoutFinalCommit(file, await readFile(new URL(file, migrationsDirectory), 'utf8'));
});
