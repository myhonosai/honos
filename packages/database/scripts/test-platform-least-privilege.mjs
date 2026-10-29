// Negative proof for platform-least-privilege-security.mjs on a disposable localhost fixture:
// each injected regression must make the verifier fail, and every injection is rolled back.
import pg from 'pg';
import { verifiedDatabaseConnection } from '../dist/index.js';
import { verifyPlatformLeastPrivilege } from './platform-least-privilege-security.mjs';

const url = process.env.DATABASE_URL;
if (!url || new URL(url).hostname !== 'localhost') throw new Error('Disposable localhost DATABASE_URL required.');
const marker = 'HON disposable';
const client = new pg.Client(verifiedDatabaseConnection(url));
await client.connect();
try {
  const database = (await client.query("SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = current_database()")).rows[0];
  if (!database?.marker?.startsWith(marker)) throw new Error('Refusing an unmarked database.');
  await verifyPlatformLeastPrivilege(client);
  const table = (await client.query("SELECT c.oid::regclass::text AS name FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'id' WHERE c.relnamespace = 'hon'::regnamespace AND c.relkind = 'r' ORDER BY c.relname LIMIT 1")).rows[0].name;
  const regressions = [
    ['a new definer function without REVOKE FROM PUBLIC', 'CREATE FUNCTION hon.p03_unrevoked_probe() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$ SELECT 1 $$', /PUBLIC-executable/],
    ['a PUBLIC table grant', `GRANT SELECT ON ${table} TO PUBLIC`, /PUBLIC holds privileges/],
    ['a PUBLIC column grant', `GRANT SELECT (id) ON ${table} TO PUBLIC`, /PUBLIC holds privileges/],
    ['PUBLIC schema usage', 'GRANT USAGE ON SCHEMA hon TO PUBLIC', /PUBLIC must have no USAGE/],
  ];
  for (const [name, statement, expected] of regressions) {
    await client.query('BEGIN');
    try {
      await client.query(statement);
      let failure;
      try { await verifyPlatformLeastPrivilege(client); } catch (error) { failure = error; }
      if (!failure || !expected.test(failure.message)) throw new Error(`Verifier did not reject ${name}.`);
      console.log(`PASS: verifier rejects ${name}.`);
    } finally {
      await client.query('ROLLBACK');
    }
  }
  await verifyPlatformLeastPrivilege(client);
  console.log('PASS: platform least-privilege verifier holds on the fixture and rejects every injected regression; all injections rolled back.');
} finally {
  await client.end();
}
