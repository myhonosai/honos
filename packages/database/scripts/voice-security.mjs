export const voiceTables = ['voice_sessions','voice_session_requests'];
export const voiceFunctions = [
 ['hon.guard_voice_history()',false,false],
 ['hon.require_voice_actor(text)',false,true],
 ['hon.require_voice_references(uuid,uuid,uuid)',false,true],
 ['hon.voice_session_snapshot(uuid)',false,true],
 ['hon.read_voice_session(text,uuid)',true,true],
 ['hon.mutate_voice_session(text,text,uuid,jsonb,uuid,uuid,uuid)',true,true],
];
export async function verifyVoiceSecurity(client,runtime) {
 for (const [signature,execute,definer] of voiceFunctions) {
  const value=(await client.query(`SELECT p.prosecdef=$3 AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, hon']::text[]
   AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>$2 AND has_function_privilege($2,p.oid,'EXECUTE')=$4
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$2) OR NOT $4 OR a.is_grantable OR a.privilege_type<>'EXECUTE')) safe
   FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=$1::regprocedure`,[signature,runtime,definer,execute])).rows[0];
  if(value?.safe!==true) throw new Error(`Unsafe voice function ${signature}`);
  for(const r of (await client.query("SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role')")).rows)
   if((await client.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed",[r.rolname,signature])).rows[0].allowed) throw new Error(`Forbidden client voice execution ${r.rolname}`);
 }
 const columns={voice_sessions:['id','organization_id','school_id','actor_principal_id','agent_catalog_id','work_item_id','action_request_id','approval_id','resume_session_id','state','reason_code','version','draft_text','created_at','updated_at','expires_at'],voice_session_requests:['organization_id','school_id','actor_principal_id','idempotency_key','request_fingerprint','session_id','receipt_version','created_at']};
 for(const table of voiceTables) {
  const value=(await client.query(`SELECT c.relrowsecurity AND c.relforcerowsecurity
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   AND NOT EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a WHERE x.attrelid=c.oid AND a.grantee<>c.relowner) safe FROM pg_class c WHERE c.oid=$1::regclass`,[`hon.${table}`])).rows[0];
  if(value?.safe!==true) throw new Error(`Unsafe private voice table ${table}`);
  if((await client.query("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') allowed",[runtime,`hon.${table}`])).rows[0].allowed) throw new Error(`Forbidden runtime voice table ${table}`);
  const policies=(await client.query('SELECT polname,polcmd,polpermissive,pg_get_expr(polqual,polrelid) qual,pg_get_expr(polwithcheck,polrelid) check FROM pg_policy WHERE polrelid=$1::regclass',[`hon.${table}`])).rows;
  if(policies.length!==1 || policies[0].polname!==`${table}_deny_all` || policies[0].polcmd!=='*' || !policies[0].polpermissive || policies[0].qual!=='false' || policies[0].check!=='false') throw new Error(`Unsafe deny-all voice policy ${table}`);
  const names=(await client.query('SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum',[`hon.${table}`])).rows.map(r=>r.attname);
  if(JSON.stringify(names)!==JSON.stringify(columns[table])) throw new Error(`Expanded voice data surface ${table}`);
 }
 for(const [table,name,type] of [['voice_sessions','voice_session_guard',27],['voice_sessions','voice_session_no_truncate',34],['voice_session_requests','voice_request_guard',27],['voice_session_requests','voice_request_no_truncate',34]]) {
  if(!(await client.query(`SELECT count(*)=1 safe FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname=$2 AND tgtype=$3 AND tgfoid='hon.guard_voice_history()'::regprocedure AND tgenabled='O' AND NOT tgisinternal AND NOT tgdeferrable AND NOT tginitdeferred`,[`hon.${table}`,name,type])).rows[0].safe) throw new Error(`Unsafe voice trigger ${name}`);
 }
 for(const [table,ref,count] of [['voice_sessions','schools',1],['voice_sessions','work_items',1],['voice_sessions','action_requests',1],['voice_sessions','action_approvals',1],['voice_sessions','voice_sessions',1],['voice_session_requests','voice_sessions',1]]) {
  const row=(await client.query(`SELECT count(*)=$3 safe FROM pg_constraint WHERE conrelid=$1::regclass AND confrelid=$2::regclass AND contype='f' AND convalidated AND NOT condeferrable AND array_length(conkey,1)>=2`,[`hon.${table}`,`hon.${ref}`,count])).rows[0];
  if(!row.safe) throw new Error(`Missing scoped voice FK ${table}.${ref}`);
 }
}
