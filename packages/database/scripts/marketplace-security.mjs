export const marketplaceTables = ['marketplace_assets','marketplace_versions','marketplace_curations','marketplace_selections','marketplace_requests','marketplace_events','marketplace_outbox'];
export const marketplaceFunctions = [
 ['hon.guard_marketplace_history()',false,false],
 ['hon.marketplace_permission(uuid,uuid,uuid,text)',false,true],
 ['hon.resolve_marketplace_scope(text,uuid)',true,true],
 ['hon.require_marketplace_actor(text,text)',false,true],
 ['hon.lock_marketplace_member(uuid)',false,true],
 ['hon.lock_marketplace_actor(text,text)',false,true],
 ['hon.marketplace_text(text,integer)',false,false],
 ['hon.validate_marketplace_input(text,jsonb)',false,false],
 ['hon.review_marketplace_asset(uuid,integer,text)',false,false],
 ['hon.marketplace_visible(uuid,integer)',false,true],
 ['hon.marketplace_projection(uuid,integer)',false,true],
 ['hon.marketplace_selection_projection(uuid)',false,true],
 ['hon.read_marketplace(text,text,uuid,uuid,integer)',true,true],
 ['hon.mutate_marketplace(text,text,uuid,jsonb,text,uuid)',true,true],
];
export async function verifyMarketplaceSecurity(client,runtime) {
 for(const[table,name,definition]of[
  ['marketplace_selections','marketplace_selections_enabled_check','CHECK ((NOT enabled))'],
  ['marketplace_selections','marketplace_selections_status_check',"CHECK ((status = 'REQUIRES_REVIEW'::text))"],
  ['marketplace_selections','marketplace_selections_version_check','CHECK ((version = 1))'],
  ['marketplace_outbox','marketplace_outbox_execution_allowed_check','CHECK ((NOT execution_allowed))'],
  ['marketplace_outbox','marketplace_outbox_status_check',"CHECK ((status = 'INERT'::text))"],
 ]) {
  const r=(await client.query('SELECT count(*)=1 safe FROM pg_constraint WHERE conrelid=$1::regclass AND conname=$2 AND contype=\'c\' AND convalidated AND pg_get_constraintdef(oid)=$3',[`hon.${table}`,name,definition])).rows[0];
  if(r?.safe!==true)throw new Error(`Unsafe permanent marketplace constraint ${table}.${name}`);
 }
 for(const table of marketplaceTables) {
  const r=(await client.query(`SELECT c.relrowsecurity AND c.relforcerowsecurity AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>$2
   AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   AND NOT EXISTS(SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE att.attrelid=c.oid AND a.grantee<>c.relowner) safe
   FROM pg_class c JOIN pg_roles o ON o.oid=c.relowner WHERE c.oid=$1::regclass`,[`hon.${table}`,runtime])).rows[0];
  if(r?.safe!==true)throw new Error(`Unsafe marketplace table ${table}`);
  for(const[name,type]of[['marketplace_immutable',27],['marketplace_no_truncate',34]]) {
   const r=(await client.query(`SELECT count(*)=1 safe FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname=$2 AND tgtype=$3
    AND tgfoid='hon.guard_marketplace_history()'::regprocedure AND tgenabled='O' AND NOT tgisinternal AND NOT tgdeferrable AND NOT tginitdeferred`,[`hon.${table}`,name,type])).rows[0];
   if(r.safe!==true)throw new Error(`Unsafe marketplace trigger ${table}.${name}`);
  }
 }
 for(const[signature,execute,definer]of marketplaceFunctions) {
  const r=(await client.query(`SELECT p.prosecdef=$3 AND p.proconfig=ARRAY['search_path=pg_catalog, hon']::text[] AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>$2
   AND has_function_privilege($2,p.oid,'EXECUTE')=$4
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$2) OR NOT $4 OR a.is_grantable OR a.privilege_type<>'EXECUTE')) safe
   FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=$1::regprocedure`,[signature,runtime,definer,execute])).rows[0];
  if(r?.safe!==true)throw new Error(`Unsafe marketplace function ${signature}`);
  for(const role of(await client.query("SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role')")).rows)if((await client.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed",[role.rolname,signature])).rows[0].allowed)throw new Error(`Forbidden marketplace client function ${role.rolname}`);
 }
}
