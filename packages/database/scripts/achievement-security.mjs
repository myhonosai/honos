export const achievementTables = ["achievement_definitions", "achievement_definition_versions", "achievement_awards", "achievement_award_versions", "achievement_requests", "achievement_events", "achievement_outbox"];
export const achievementFunctions = [
 ['hon.guard_achievement_history()',false,false],
 ['hon.achievement_text(text,integer,boolean)',false,false],
 ['hon.achievement_permission(uuid,uuid,uuid,text)',false,true],
 ['hon.resolve_achievement_scope(text,uuid)',true,true],
 ['hon.require_achievement_actor(text,text)',false,true],
 ['hon.lock_achievement_actor(text,text,boolean)',false,true],
 ['hon.lock_achievement_student(uuid)',false,true],
 ['hon.validate_achievement_input(text,jsonb)',false,false],
 ['hon.achievement_definition_projection(uuid,integer)',false,true],
 ['hon.achievement_award_projection(uuid,integer,boolean)',false,true],
 ['hon.read_achievements(text,text,uuid,uuid,uuid,integer)',true,true],
 ['hon.mutate_achievements(text,text,uuid,uuid,jsonb,text,uuid,uuid)',true,true],
 ['hon.require_parent_achievement_actor(text,uuid,uuid)',false,true],
 ['hon.read_parent_achievements(text,uuid,uuid,uuid)',true,true],
];
export async function verifyAchievementSecurity(client,runtime) {
 for(const[table,name,definition]of[
  ['achievement_outbox','achievement_outbox_execution_allowed_check','CHECK ((NOT execution_allowed))'],
  ['achievement_outbox','achievement_outbox_status_check',"CHECK ((status = 'INERT'::text))"],
 ]) {
  const r=(await client.query('SELECT count(*)=1 safe FROM pg_constraint WHERE conrelid=$1::regclass AND conname=$2 AND contype=\'c\' AND convalidated AND pg_get_constraintdef(oid)=$3',[`hon.${table}`,name,definition])).rows[0];
  if(r?.safe!==true)throw new Error(`Unsafe permanent achievement constraint ${table}.${name}`);
 }
 for(const table of achievementTables) {
  const r=(await client.query(`SELECT c.relrowsecurity AND c.relforcerowsecurity AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>$2
   AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   AND NOT EXISTS(SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE att.attrelid=c.oid AND a.grantee<>c.relowner) safe
   FROM pg_class c JOIN pg_roles o ON o.oid=c.relowner WHERE c.oid=$1::regclass`,[`hon.${table}`,runtime])).rows[0];
  if(r?.safe!==true)throw new Error(`Unsafe achievement table ${table}`);
  for(const[name,type]of[['achievement_immutable',27],['achievement_no_truncate',34]]) {
   const r=(await client.query(`SELECT count(*)=1 safe FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname=$2 AND tgtype=$3
    AND tgfoid='hon.guard_achievement_history()'::regprocedure AND tgenabled='O' AND NOT tgisinternal AND NOT tgdeferrable AND NOT tginitdeferred`,[`hon.${table}`,name,type])).rows[0];
   if(r.safe!==true)throw new Error(`Unsafe achievement trigger ${table}.${name}`);
  }
 }
 for(const[signature,execute,definer]of achievementFunctions) {
  const r=(await client.query(`SELECT p.prosecdef=$3 AND p.proconfig=ARRAY['search_path=pg_catalog, hon']::text[] AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>$2
   AND has_function_privilege($2,p.oid,'EXECUTE')=$4
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$2) OR NOT $4 OR a.is_grantable OR a.privilege_type<>'EXECUTE')) safe
   FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=$1::regprocedure`,[signature,runtime,definer,execute])).rows[0];
  if(r?.safe!==true)throw new Error(`Unsafe achievement function ${signature}`);
  for(const role of(await client.query("SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role')")).rows)if((await client.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed",[role.rolname,signature])).rows[0].allowed)throw new Error(`Forbidden achievement client function ${role.rolname}`);
 }
}
