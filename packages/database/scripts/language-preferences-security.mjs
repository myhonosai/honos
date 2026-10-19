// Interface language persistence (0171): private deny-all tables reachable only through four fixed functions.
export const languagePreferenceTables = ['user_language_preferences','school_language_defaults','language_requests','language_audit'];
// [signature, runtime may execute, security definer]
const languageFunctions = [
 ['hon.guard_language_records()',false,false],
 ['hon.language_actor(text)',false,true],
 ['hon.language_school_member(uuid,uuid)',false,true],
 ['hon.language_school_manager(uuid,uuid)',false,true],
 ['hon.language_ts(timestamp with time zone)',false,false],
 ['hon.language_preference_json(uuid)',false,false],
 ['hon.language_school_json(uuid)',false,false],
 ['hon.language_input(jsonb)',false,false],
 ['hon.language_replay(uuid,uuid,text,text)',false,false],
 ['hon.read_my_language_preference(text,uuid)',true,true],
 ['hon.set_my_language_preference(text,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.read_school_language_default(text,uuid)',true,true],
 ['hon.set_school_language_default(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
];
export async function verifyLanguagePreferenceSecurity(client, runtime) {
 if (!/^hon_[a-z_]+$/.test(runtime)) throw new Error('Unsafe language preference runtime role.');
 for (const table of languagePreferenceTables) {
  const r=(await client.query(`SELECT c.relrowsecurity AND c.relforcerowsecurity AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>$2
   AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   AND NOT EXISTS(SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE att.attrelid=c.oid AND a.grantee<>c.relowner) safe
   FROM pg_class c JOIN pg_roles o ON o.oid=c.relowner WHERE c.oid=$1::regclass`,[`hon.${table}`,runtime])).rows[0];
  if (r?.safe!==true) throw new Error(`Unsafe language preference table ${table}`);
  for (const [name,type] of [['language_guarded',27],['language_no_truncate',34]]) {
   const t=(await client.query(`SELECT count(*)=1 safe FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname=$2 AND tgtype=$3
    AND tgfoid='hon.guard_language_records()'::regprocedure AND tgenabled='O' AND NOT tgisinternal`,[`hon.${table}`,name,type])).rows[0];
   if (t.safe!==true) throw new Error(`Unsafe language preference trigger ${table}.${name}`);
  }
 }
 const total=(await client.query("SELECT count(*)::int n FROM pg_proc WHERE pronamespace='hon'::regnamespace AND proname ~ 'language'")).rows[0].n;
 if (total!==languageFunctions.length) throw new Error(`Untracked language preference functions: ${total}`);
 for (const [signature,execute,definer] of languageFunctions) {
  const r=(await client.query(`SELECT p.prosecdef=$3 AND p.proconfig=ARRAY['search_path=pg_catalog, hon']::text[] AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>$2
   AND has_function_privilege($2,p.oid,'EXECUTE')=$4
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$2) OR NOT $4 OR a.is_grantable OR a.privilege_type<>'EXECUTE')) safe
   FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=$1::regprocedure`,[signature,runtime,definer,execute])).rows[0];
  if (r?.safe!==true) throw new Error(`Unsafe language preference function ${signature}`);
  for (const role of (await client.query("SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role')")).rows) {
   if ((await client.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed",[role.rolname,signature])).rows[0].allowed) throw new Error(`Forbidden client language function ${role.rolname}`);
  }
 }
}
