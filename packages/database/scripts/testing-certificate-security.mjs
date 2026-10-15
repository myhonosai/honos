export const testingCertificateTables = ['testing_certificates', 'testing_certificate_requests', 'testing_certificate_outbox'];
export const testingCertificateFunctions = [
  ['hon.testing_certificate_safe_text(text,integer)', false, false],
  ['hon.guard_testing_certificate_history()', false, false],
  ['hon.testing_certificate_permission(uuid,uuid,uuid,text)', false, true],
  ['hon.resolve_testing_certificate_scope(text,uuid)', true, true],
  ['hon.require_testing_certificate_actor(text,text)', false, true],
  ['hon.lock_testing_certificate_actor(text,text,boolean)', false, true],
  ['hon.testing_certificate_projection(uuid)', false, true],
  ['hon.guard_testing_certificate_insert()', false, true],
  ['hon.guard_testing_certificate_dependency()', false, true],
  ['hon.guard_testing_certificate_promotion_delete()', false, true],
  ['hon.read_testing_certificate(text,uuid)', true, true],
  ['hon.issue_testing_certificate(text,uuid,jsonb,text,uuid,uuid)', true, true],
];

export async function verifyTestingCertificateSecurity(client, runtime) {
  for (const table of testingCertificateTables) {
    const result = (await client.query(`
      SELECT c.relrowsecurity AND c.relforcerowsecurity
        AND (owner.rolsuper OR owner.rolbypassrls)
        AND owner.rolname <> $2
        AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = c.oid)
        AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) AS acl WHERE acl.grantee <> c.relowner)
        AND NOT EXISTS (SELECT 1 FROM pg_attribute AS a CROSS JOIN LATERAL aclexplode(a.attacl) AS acl
                        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND acl.grantee <> c.relowner)
        AS safe
      FROM pg_class AS c JOIN pg_roles AS owner ON owner.oid = c.relowner
      WHERE c.oid = $1::regclass`, [`hon.${table}`, runtime])).rows[0];
    if (result?.safe !== true) throw new Error(`Unsafe testing certificate table: ${table}`);
    for (const [name, type] of [['testing_certificate_immutable', 27], ['testing_certificate_no_truncate', 34]]) {
      const trigger = (await client.query(`SELECT count(*) = 1 AS safe FROM pg_trigger
        WHERE tgrelid = $1::regclass AND tgname = $2 AND tgtype = $3
          AND tgfoid = 'hon.guard_testing_certificate_history()'::regprocedure
          AND tgenabled = 'O' AND NOT tgisinternal AND NOT tgdeferrable AND NOT tginitdeferred`, [`hon.${table}`, name, type])).rows[0];
      if (trigger?.safe !== true) throw new Error(`Unsafe testing certificate immutable trigger: ${table}.${name}`);
    }
  }
  const inert = (await client.query(`SELECT count(*) = 1 AS safe FROM pg_constraint
    WHERE conrelid = 'hon.testing_certificate_outbox'::regclass
      AND conname = 'testing_certificate_outbox_execution_allowed_check'
      AND contype = 'c' AND convalidated
      AND pg_get_constraintdef(oid) = 'CHECK ((NOT execution_allowed))'`)).rows[0];
  if (inert?.safe !== true) throw new Error('Testing certificate outbox must remain permanently inert.');

  for (const [signature, executable, definer] of testingCertificateFunctions) {
    const result = (await client.query(`
      SELECT p.prosecdef = $3
        AND p.proconfig = ARRAY['search_path=pg_catalog, hon']::text[]
        AND (owner.rolsuper OR owner.rolbypassrls)
        AND owner.rolname <> $2
        AND has_function_privilege($2, p.oid, 'EXECUTE') = $4
        AND NOT EXISTS (
          SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
          WHERE acl.grantee <> p.proowner
            AND (acl.grantee <> (SELECT oid FROM pg_roles WHERE rolname = $2)
                 OR NOT $4::boolean OR acl.is_grantable OR acl.privilege_type <> 'EXECUTE')
        ) AS safe
      FROM pg_proc AS p JOIN pg_roles AS owner ON owner.oid = p.proowner
      WHERE p.oid = $1::regprocedure`, [signature, runtime, definer, executable])).rows[0];
    if (result?.safe !== true) throw new Error(`Unsafe testing certificate function: ${signature}`);
    for (const { rolname } of (await client.query("SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role')")).rows) {
      const allowed = (await client.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [rolname, signature])).rows[0];
      if (allowed?.allowed) throw new Error(`Forbidden client testing certificate function: ${rolname}.${signature}`);
    }
  }
  for (const [table, trigger, signature, type, deferred] of [
    ['testing_certificates', 'testing_certificate_insert_guard', 'hon.guard_testing_certificate_insert()', 7, false],
    ['testing_candidates', 'testing_certificate_candidate_dependency', 'hon.guard_testing_certificate_dependency()', 17, true],
    ['promotion_decisions', 'testing_certificate_promotion_dependency', 'hon.guard_testing_certificate_dependency()', 17, true],
    ['promotion_decisions', 'testing_certificate_promotion_delete_guard', 'hon.guard_testing_certificate_promotion_delete()', 11, false],
  ]) {
    const result = (await client.query(`SELECT count(*) = 1 AS safe FROM pg_trigger
      WHERE tgrelid = $1::regclass AND tgname = $2 AND tgfoid = $3::regprocedure AND tgtype = $4
        AND tgenabled = 'O' AND NOT tgisinternal AND tgdeferrable = $5 AND tginitdeferred = $5`, [`hon.${table}`, trigger, signature, type, deferred])).rows[0];
    if (result?.safe !== true) throw new Error(`Unsafe testing certificate prerequisite trigger: ${trigger}`);
  }
}
