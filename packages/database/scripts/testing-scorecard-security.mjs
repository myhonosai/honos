export const testingScorecardTables = ['testing_scorecards', 'testing_scorecard_evaluations', 'testing_scorecard_requests', 'testing_scorecard_outbox'];
export const testingScorecardFunctions = [
  ['hon.testing_scorecard_safe_criterion(text)', false, false],
  ['hon.testing_scorecard_permission(uuid,uuid,uuid,text)', false, true],
  ['hon.resolve_testing_scorecard_scope(text,uuid)', true, true],
  ['hon.require_testing_scorecard_actor(text,text)', false, true],
  ['hon.lock_testing_scorecard_actor(text,text,boolean)', false, true],
  ['hon.testing_scorecard_projection(uuid,uuid,uuid)', false, true],
  ['hon.guard_testing_scorecard_root()', false, true],
  ['hon.guard_testing_scorecard_evaluation()', false, true],
  ['hon.guard_testing_scorecard_history()', false, false],
  ['hon.read_testing_scorecard(text,uuid,uuid)', true, true],
  ['hon.record_testing_scorecard_evaluation(text,uuid,uuid,jsonb,text,uuid,uuid)', true, true],
];

export async function verifyTestingScorecardSecurity(client, runtime) {
  for (const table of testingScorecardTables) {
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
    if (result?.safe !== true) throw new Error(`Unsafe testing scorecard table: ${table}`);
  }

  const inert = (await client.query(`SELECT count(*) = 1 AS safe FROM pg_constraint
    WHERE conrelid = 'hon.testing_scorecard_outbox'::regclass
      AND conname = 'testing_scorecard_outbox_execution_allowed_check'
      AND contype = 'c' AND convalidated
      AND pg_get_constraintdef(oid) = 'CHECK ((NOT execution_allowed))'`)).rows[0];
  if (inert?.safe !== true) throw new Error('Testing scorecard outbox must remain permanently inert.');

  for (const [signature, executable, definer] of testingScorecardFunctions) {
    const result = (await client.query(`
      SELECT p.prosecdef = $3
        AND p.provolatile = 'v'
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
    if (result?.safe !== true) throw new Error(`Unsafe testing scorecard function: ${signature}`);
    for (const { rolname } of (await client.query("SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role')")).rows) {
      const allowed = (await client.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [rolname, signature])).rows[0];
      if (allowed?.allowed) throw new Error(`Forbidden client testing scorecard function: ${rolname}.${signature}`);
    }
  }

  for (const [table, trigger, signature, type] of [
    ['testing_scorecards', 'testing_scorecard_root_guard', 'hon.guard_testing_scorecard_root()', 31],
    ['testing_scorecards', 'testing_scorecard_root_no_truncate', 'hon.guard_testing_scorecard_root()', 34],
    ['testing_scorecard_evaluations', 'testing_scorecard_evaluation_insert_guard', 'hon.guard_testing_scorecard_evaluation()', 7],
    ['testing_scorecard_evaluations', 'testing_scorecard_evaluation_immutable', 'hon.guard_testing_scorecard_history()', 27],
    ['testing_scorecard_evaluations', 'testing_scorecard_evaluation_no_truncate', 'hon.guard_testing_scorecard_history()', 34],
    ['testing_scorecard_requests', 'testing_scorecard_request_immutable', 'hon.guard_testing_scorecard_history()', 27],
    ['testing_scorecard_requests', 'testing_scorecard_request_no_truncate', 'hon.guard_testing_scorecard_history()', 34],
    ['testing_scorecard_outbox', 'testing_scorecard_outbox_immutable', 'hon.guard_testing_scorecard_history()', 27],
    ['testing_scorecard_outbox', 'testing_scorecard_outbox_no_truncate', 'hon.guard_testing_scorecard_history()', 34],
  ]) {
    const result = (await client.query(`SELECT count(*) = 1 AS safe FROM pg_trigger
      WHERE tgrelid = $1::regclass AND tgname = $2 AND tgfoid = $3::regprocedure AND tgtype = $4
        AND tgenabled = 'O' AND NOT tgisinternal AND NOT tgdeferrable AND NOT tginitdeferred`, [`hon.${table}`, trigger, signature, type])).rows[0];
    if (result?.safe !== true) throw new Error(`Unsafe testing scorecard trigger: ${table}.${trigger}`);
  }

  const identity = (await client.query(`SELECT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid='hon.testing_scorecards'::regclass AND contype='f'
        AND pg_get_constraintdef(oid) LIKE '%REFERENCES hon.testing_candidates(id, testing_event_id, organization_id, school_id)%'
    ) AND EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid='hon.testing_scorecard_evaluations'::regclass AND contype='f'
        AND pg_get_constraintdef(oid) LIKE '%REFERENCES hon.testing_scorecards(id, organization_id, school_id, testing_candidate_id, testing_event_id)%'
    ) AS safe`)).rows[0];
  if (identity?.safe !== true) throw new Error('Testing scorecard composite candidate/event ownership is unsafe.');
}
