export const retentionReviewFunctions = [
  ['hon.retention_review_has_permission(uuid,uuid,uuid)', false],
  ['hon.resolve_retention_review_scope(text,uuid)', true],
  ['hon.require_retention_review_actor(text)', false],
  ['hon.lock_retention_review_actor(text)', false],
  ['hon.read_retention_review_signals(text,uuid)', true],
];

/** Verifies ACL and definer posture for the evidence-only Retention Review Signals projection. */
export async function verifyRetentionReviewSecurity(client, runtimeRoleName) {
  for (const [signature, expectedExecute] of retentionReviewFunctions) {
    const boundary = (await client.query(`
      SELECT p.prosecdef, p.provolatile, p.proconfig,
        owner_role.rolsuper OR owner_role.rolbypassrls AS trusted_owner,
        has_function_privilege($2, p.oid, 'EXECUTE') AS runtime_execute,
        EXISTS (
          SELECT 1
          FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
          WHERE acl.grantee <> p.proowner
            AND (
              acl.grantee <> (SELECT oid FROM pg_roles WHERE rolname = $2)
              OR NOT $3::boolean
              OR acl.is_grantable
              OR acl.privilege_type <> 'EXECUTE'
            )
        ) AS broad_execute
      FROM pg_proc p
      JOIN pg_roles owner_role ON owner_role.oid = p.proowner
      WHERE p.oid = $1::regprocedure
    `, [signature, runtimeRoleName, expectedExecute])).rows[0];
    if (!boundary?.prosecdef || boundary.provolatile !== 'v' || !boundary.trusted_owner
      || boundary.runtime_execute !== expectedExecute || boundary.broad_execute
      || boundary.proconfig?.length !== 1 || boundary.proconfig[0] !== 'search_path=pg_catalog, hon') {
      throw new Error(`Unsafe Retention Review Signals boundary: ${signature}`);
    }
  }

  const permission = (await client.query(`
    SELECT is_sensitive, is_staff_assignable
    FROM hon.permissions
    WHERE code = 'retention.review.read'
  `)).rows[0];
  if (!permission?.is_sensitive || !permission.is_staff_assignable) {
    throw new Error('Retention Review Signals permission metadata is unsafe.');
  }

  for (const { rolname } of (await client.query(`
    SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')
  `)).rows) {
    for (const [signature] of retentionReviewFunctions) {
      const allowed = (await client.query(
        "SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS allowed",
        [rolname, signature],
      )).rows[0].allowed;
      if (allowed) throw new Error(`Client role may execute Retention Review Signals boundary: ${rolname}.${signature}`);
    }
  }
}
