export const humanWorkTables = ['human_work_history','human_work_requests'];
export const humanWorkFunctions = [
 ['hon.guard_human_work_history()',false,false,'v'],
 ['hon.validate_human_work(text,jsonb)',false,false,'v'],
 ['hon.human_work_permission(uuid,uuid,uuid,text)',false,true,'v'],
 ['hon.resolve_human_work_scope(text)',true,true,'v'],
 ['hon.require_human_work_actor(text)',false,true,'v'],
 ['hon.lock_human_work_actor(text,uuid[])',false,true,'v'],
 ['hon.human_work_visible(uuid,hon.work_items)',false,true,'v'],
 ['hon.human_work_transition_allowed(text,text)',false,false,'i'],
 ['hon.human_work_snapshot(uuid,integer,uuid,integer)',false,true,'v'],
 ['hon.guard_human_work_row()',false,false,'v'],
 ['hon.mutate_human_work(text,text,uuid,jsonb,text,uuid,uuid)',true,true,'v'],
 ['hon.read_human_work(text,uuid,text,text,uuid,integer)',true,true,'v'],
 ['hon.lock_ai_planning_work_reference(uuid)',true,true,'v'],
];
export async function verifyHumanWorkSecurity(client,runtime) {
 for (const [signature,execute,definer,volatility] of humanWorkFunctions) {
  const row=(await client.query(`SELECT p.prosecdef=$3 AND p.provolatile=$5 AND p.proconfig=ARRAY['search_path=pg_catalog, hon']::text[]
   AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>$2 AND has_function_privilege($2,p.oid,'EXECUTE')=$4
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$2) OR NOT $4 OR a.is_grantable OR a.privilege_type<>'EXECUTE')) safe
   FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=$1::regprocedure`,[signature,runtime,definer,execute,volatility])).rows[0];
  if(row?.safe!==true) throw new Error(`Unsafe human work function ${signature}`);
 }
 for(const table of ['work_items',...humanWorkTables]) {
  const row=(await client.query(`SELECT c.relrowsecurity AND c.relforcerowsecurity
   AND NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='hon' AND tablename=c.relname)
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   AND NOT EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a WHERE x.attrelid=c.oid AND a.grantee<>c.relowner) safe FROM pg_class c WHERE c.oid=$1::regclass`,[`hon.${table}`])).rows[0];
  if(row?.safe!==true) throw new Error(`Unsafe private human work table ${table}`);
  if((await client.query("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') allowed",[runtime,`hon.${table}`])).rows[0].allowed) throw new Error(`Forbidden inherited human work table access ${table}`);
 }
 for(const [table,trigger,fn] of [
  ['work_items','human_work_row_guard','hon.guard_human_work_row()'],['work_items','human_work_no_truncate','hon.guard_human_work_row()'],
  ['human_work_history','human_work_history_immutable','hon.guard_human_work_history()'],['human_work_history','human_work_history_no_truncate','hon.guard_human_work_history()'],
  ['human_work_requests','human_work_requests_immutable','hon.guard_human_work_history()'],['human_work_requests','human_work_requests_no_truncate','hon.guard_human_work_history()'],
 ]) if(!(await client.query("SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname=$2 AND tgenabled='O' AND tgfoid=$3::regprocedure) safe",[`hon.${table}`,trigger,fn])).rows[0].safe) throw new Error(`Missing human work trigger ${trigger}`);
 for(const constraint of ['human_work_shape','work_items_version_positive','work_items_id_tenant_unique']) if(!(await client.query("SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.work_items'::regclass AND conname=$1 AND convalidated) safe",[constraint])).rows[0].safe) throw new Error(`Missing work constraint ${constraint}`);
 for(const role of (await client.query("SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role')")).rows) {
  for(const [signature] of humanWorkFunctions) if((await client.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed",[role.rolname,signature])).rows[0].allowed) throw new Error(`Forbidden client work execution ${role.rolname}`);
  for(const table of ['work_items',...humanWorkTables]) if((await client.query("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') allowed",[role.rolname,`hon.${table}`])).rows[0].allowed) throw new Error(`Forbidden client work table ${role.rolname}`);
 }
}
