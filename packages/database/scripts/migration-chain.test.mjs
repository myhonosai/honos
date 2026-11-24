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
  for (const sql of ['CREATE TABLE t();', 'BEGIN;\nSELECT 1;', 'BEGIN;\nSELECT 1;\nCOMMIT;\nBEGIN;\nSELECT 2;\nCOMMIT;', 'BEGIN;\nROLLBACK;\nCOMMIT;',
    // Review P3 (#585): every other spelling of a top-level transaction boundary.
    'BEGIN;\nABORT;\nCOMMIT;', 'BEGIN;\nabort work;\nCOMMIT;', 'BEGIN;\nCOMMIT AND CHAIN;\nCOMMIT;', 'BEGIN;\nCOMMIT WORK;\nCOMMIT;',
    'BEGIN;\nCOMMIT TRANSACTION AND NO CHAIN;\nCOMMIT;', 'BEGIN;\nROLLBACK AND CHAIN;\nCOMMIT;', 'BEGIN;\nROLLBACK TRANSACTION;\nCOMMIT;',
    "BEGIN;\nPREPARE TRANSACTION 'x';\nCOMMIT;", "BEGIN;\nCOMMIT PREPARED 'x';\nCOMMIT;", "BEGIN;\nROLLBACK PREPARED 'x';\nCOMMIT;",
    'BEGIN;\nSTART TRANSACTION ISOLATION LEVEL SERIALIZABLE;\nCOMMIT;', 'BEGIN;\nBEGIN WORK;\nCOMMIT;', 'BEGIN;\nBEGIN TRANSACTION READ ONLY;\nCOMMIT;',
    'BEGIN;\nBEGIN ISOLATION LEVEL REPEATABLE READ;\nCOMMIT;', 'BEGIN;\n  commit;\nCOMMIT;']) {
    const client = fakeClient();
    await assert.rejects(() => applyMigrationAtomically(client, '0001_x.sql', sql));
    assert.equal(client.calls.length, 0);
  }
  await assert.rejects(() => applyMigrationAtomically(fakeClient(), "0001_x'.sql", 'BEGIN;\nCOMMIT;'));
});

test('savepoints and PL/pgSQL blocks are not transaction boundaries', () => {
  const sql = "BEGIN;\nSAVEPOINT a;\nROLLBACK TO SAVEPOINT a;\nROLLBACK TO a;\nRELEASE SAVEPOINT a;\nDO $$\nBEGIN\n  PERFORM 1;\nEND;\n$$;\nCREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN NULL; END $$;\nCOMMIT;\n";
  assert.ok(withoutFinalCommit('0001_x.sql', sql).includes('ROLLBACK TO a;'));
});

test('every accepted migration file has exactly one outer transaction the runner can extend', async () => {
  const files = (await readdir(migrationsDirectory)).filter((file) => /^\d{4}_.+\.sql$/.test(file));
  assert.ok(files.length > 300);
  for (const file of files) withoutFinalCommit(file, await readFile(new URL(file, migrationsDirectory), 'utf8'));
});
