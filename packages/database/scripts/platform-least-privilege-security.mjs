// Schema-wide least-privilege guardrails (Supabase audit findings C-3/C-4). HON never uses the
// Supabase Data API roles, and after the canonical 010 grants nothing in schema hon is reachable
// through PUBLIC. These checks make any regression (a migration that forgets REVOKE ... FROM PUBLIC,
// or a manual dashboard grant to a client role) fail the verifier instead of relying on review.
const CLIENT_ROLES = ['anon', 'authenticated', 'service_role', 'authenticator'];

function sample(rows, key) {
  return rows.slice(0, 10).map((row) => row[key]).join(', ') + (rows.length > 10 ? `, … (${rows.length} total)` : '');
}

export async function verifyPlatformLeastPrivilege(client) {
  const schema = (await client.query(`SELECT
    EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
      WHERE n.nspname = 'hon' AND a.grantee = 0) AS public_schema_access`)).rows[0];
  if (schema.public_schema_access) throw new Error('PUBLIC must have no USAGE or CREATE on schema hon.');

  const publicRelations = (await client.query(`SELECT DISTINCT c.oid::regclass::text AS name
    FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault((CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END)::"char", c.relowner))) a
    WHERE c.relnamespace = 'hon'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') AND a.grantee = 0
    UNION
    SELECT DISTINCT c.oid::regclass::text FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid CROSS JOIN LATERAL aclexplode(att.attacl) a
    WHERE c.relnamespace = 'hon'::regnamespace AND att.attnum > 0 AND NOT att.attisdropped AND a.grantee = 0
    ORDER BY 1`)).rows;
  if (publicRelations.length) throw new Error(`PUBLIC holds privileges on hon relations: ${sample(publicRelations, 'name')}.`);

  const publicFunctions = (await client.query(`SELECT p.oid::regprocedure::text AS name FROM pg_proc p
    WHERE p.pronamespace = 'hon'::regnamespace
      AND EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
    ORDER BY 1`)).rows;
  if (publicFunctions.length) throw new Error(`Unreviewed PUBLIC-executable hon functions (add REVOKE ... FROM PUBLIC): ${sample(publicFunctions, 'name')}.`);

  for (const { rolname } of (await client.query('SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY 1', [CLIENT_ROLES])).rows) {
    const access = (await client.query(`SELECT
      has_schema_privilege($1, 'hon', 'USAGE') OR has_schema_privilege($1, 'hon', 'CREATE') AS schema_access,
      (SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'hon'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND (has_table_privilege($1, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR has_any_column_privilege($1, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')))::int AS relations,
      (SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'hon'::regnamespace AND c.relkind = 'S'
        AND has_sequence_privilege($1, c.oid, 'USAGE,SELECT,UPDATE'))::int AS sequences,
      (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'hon'::regnamespace AND has_function_privilege($1, p.oid, 'EXECUTE'))::int AS functions`, [rolname])).rows[0];
    if (access.schema_access || access.relations || access.sequences || access.functions) {
      throw new Error(`Client role ${rolname} must not reach schema hon (schema ${access.schema_access}, relations ${access.relations}, sequences ${access.sequences}, functions ${access.functions}).`);
    }
  }
}
