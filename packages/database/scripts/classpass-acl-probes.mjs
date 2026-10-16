import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classpassFunctions, verifyClassPassFunctionAcls, verifyClassPassSecurity } from './classpass-security.mjs';
export async function testClassPassAclDrift(client,runtime='hon_runtime') {
  const canonical=await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
  const block=canonical.split('-- ClassPass exact verification:')[1].split('-- End ClassPass exact verification.')[0].replaceAll('hon_runtime',runtime);
  const owner=(await client.query('SELECT current_user owner')).rows[0].owner;
  assert(/^hon_[a-z_]+$/.test(owner));let probes=0;
  for(const [signature,executable]of classpassFunctions) {
    const statements=[`GRANT EXECUTE ON FUNCTION hon.${signature} TO pg_database_owner`,
      `GRANT EXECUTE ON FUNCTION hon.${signature} TO PUBLIC`,
      `GRANT EXECUTE ON FUNCTION hon.${signature} TO ${owner} WITH GRANT OPTION`,
      executable?`GRANT EXECUTE ON FUNCTION hon.${signature} TO ${runtime} WITH GRANT OPTION`:`GRANT EXECUTE ON FUNCTION hon.${signature} TO ${runtime}`,
      ...(executable?[`REVOKE EXECUTE ON FUNCTION hon.${signature} FROM ${runtime}`]:[])];
    for(const sql of statements) {
      // A failed SQL DO block aborts the transaction. Repeat the isolated drift
      // for JS so its independent aclexplode check is actually exercised.
      for(const check of[c=>c.query(block),c=>verifyClassPassFunctionAcls(c,runtime)]) {
        await client.query('BEGIN');
        try { await client.query(sql);await assert.rejects(()=>check(client),/ClassPass exact function ACL/);probes++; }
        finally { await client.query('ROLLBACK'); }
      }
      await verifyClassPassSecurity(client,runtime);
    }
  }
  return probes;
}
