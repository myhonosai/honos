export const communityTables = ['community_verifications','community_organizations','community_members','community_profiles','community_content','community_versions','community_requests','community_events'];
export const communityFunctions = [
 ['hon.guard_community_history()',false,false],
 ['hon.community_permission(uuid,uuid,uuid,text)',false,true],
 ['hon.resolve_community_scope(text,uuid)',true,true],
 ['hon.community_member_active(uuid)',false,true],
 ['hon.require_community_actor(text,boolean)',false,true],
 ['hon.lock_community_actor(text,boolean)',false,true],
 ['hon.community_text(text,integer,boolean,boolean)',false,false],
 ['hon.validate_community_input(text,jsonb)',false,false],
 ['hon.community_visible(uuid,uuid,integer)',false,true],
 ['hon.community_projection(uuid,uuid,integer)',false,true],
 ['hon.read_community_profile(text)',true,true],
 ['hon.mutate_community(text,text,uuid,jsonb,text,uuid)',true,true],
 ['hon.read_community(text,text,uuid,uuid,uuid)',true,true],
 ['hon.read_community_history(text,uuid,integer)',true,true],
];
export async function verifyCommunitySecurity(client, runtime) {
 for(const table of communityTables) {
  const r=(await client.query(`SELECT c.relrowsecurity AND c.relforcerowsecurity AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>$2
   AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   AND NOT EXISTS(SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE att.attrelid=c.oid AND a.grantee<>c.relowner) safe
   FROM pg_class c JOIN pg_roles o ON o.oid=c.relowner WHERE c.oid=$1::regclass`,[`hon.${table}`,runtime])).rows[0];
  if(r?.safe!==true) throw new Error(`Unsafe community table ${table}`);
  if(table!=='community_verifications') for(const [name,type] of [['community_immutable',27],['community_no_truncate',34]]) {
   const r=(await client.query(`SELECT count(*)=1 safe FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname=$2 AND tgtype=$3
    AND tgfoid='hon.guard_community_history()'::regprocedure AND tgenabled='O' AND NOT tgisinternal AND NOT tgdeferrable AND NOT tginitdeferred`,[`hon.${table}`,name,type])).rows[0];
   if(r.safe!==true) throw new Error(`Unsafe community trigger ${table}.${name}`);
  }
 }
 for(const [signature,execute,definer] of communityFunctions) {
  const r=(await client.query(`SELECT p.prosecdef=$3 AND p.proconfig=ARRAY['search_path=pg_catalog, hon']::text[] AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>$2
   AND has_function_privilege($2,p.oid,'EXECUTE')=$4
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$2) OR NOT $4 OR a.is_grantable OR a.privilege_type<>'EXECUTE')) safe
   FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=$1::regprocedure`,[signature,runtime,definer,execute])).rows[0];
  if(r?.safe!==true) throw new Error(`Unsafe community function ${signature}`);
  for(const role of (await client.query("SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role')")).rows) {
   if((await client.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') allowed',[role.rolname,signature])).rows[0].allowed) throw new Error(`Forbidden client community function ${role.rolname}`);
  }
 }
}
