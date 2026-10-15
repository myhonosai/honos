export const actionApprovalFunctions=[['hon.require_human_action_review(text,uuid)',true,true,false],['hon.human_action_reviewer()',true,true,false],['hon.crm_lead_target_is_current(uuid,uuid)',true,true,true],['hon.guard_action_review_immutability()',false,false,false]];
export async function verifyActionApprovalSecurity(client,runtime) {
 for(const [signature,execute,definer,booleanResult] of actionApprovalFunctions) {
  const r=(await client.query(`SELECT p.prosecdef=$3 AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, hon']::text[] AND (NOT $5 OR p.prorettype='bool'::regtype) AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>$2
   AND has_function_privilege($2,p.oid,'EXECUTE')=$4
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$2) OR NOT $4 OR a.is_grantable OR a.privilege_type<>'EXECUTE')) safe
   FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=$1::regprocedure`,[signature,runtime,definer,execute,booleanResult])).rows[0];
  if(r?.safe!==true) throw new Error(`Unsafe action approval function ${signature}`);
  for(const role of (await client.query("SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role')")).rows) if((await client.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed",[role.rolname,signature])).rows[0].allowed) throw new Error(`Forbidden client approval function ${role.rolname}`);
 }
 const minima={action_requests:['SELECT','INSERT','UPDATE'],action_approvals:['SELECT','INSERT'],action_policies:['SELECT']};
 for(const [table,allowed] of Object.entries(minima)) {
  const row=(await client.query(`SELECT c.relrowsecurity AND c.relforcerowsecurity AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$2) OR a.privilege_type<>ALL($3::text[]) OR a.is_grantable))
   AND NOT EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a WHERE x.attrelid=c.oid AND a.grantee<>c.relowner) safe FROM pg_class c WHERE c.oid=$1::regclass`,[`hon.${table}`,runtime,allowed])).rows[0];
  if(row?.safe!==true) throw new Error(`Unsafe action approval table ${table}`);
  for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) if((await client.query('SELECT has_table_privilege($1,$2,$3) allowed',[runtime,`hon.${table}`,privilege])).rows[0].allowed!==allowed.includes(privilege)) throw new Error(`Wrong approval minimum ${table}.${privilege}`);
  const policies=(await client.query('SELECT polname,polpermissive,polcmd,pg_get_expr(polqual,polrelid) qual,pg_get_expr(polwithcheck,polrelid) check FROM pg_policy WHERE polrelid=$1::regclass',[`hon.${table}`])).rows;
  const tenant=policies.find(p=>p.polname===`${table}_tenant_isolation`);
  const normal=v=>(v??'').replace(/[\s()]/g,'');
  const exact='organization_id=hon.current_organization_idANDschool_id=hon.current_school_id';
  if(!tenant || !tenant.polpermissive || tenant.polcmd!=='*' || normal(tenant.qual)!==exact || normal(tenant.check)!==exact || policies.length!==(table==='action_approvals'?2:1)) throw new Error(`Unsafe action approval tenant policy ${table}`);
  if(table==='action_approvals') {const p=policies.find(p=>p.polname==='action_approvals_qualified_read');if(!p || p.polpermissive || p.polcmd!=='r' || normal(p.qual)!=='hon.human_action_reviewer') throw new Error('Unsafe qualified approval evidence policy');}
 }
 for(const [table,name,type] of [['action_requests','action_request_immutable',27],['action_requests','action_request_no_truncate',34],['action_approvals','action_approval_immutable',27],['action_approvals','action_approval_no_truncate',34]]) {
  if(!(await client.query(`SELECT count(*)=1 safe FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname=$2 AND tgtype=$3 AND tgfoid='hon.guard_action_review_immutability()'::regprocedure AND tgenabled='O' AND NOT tgisinternal AND NOT tgdeferrable AND NOT tginitdeferred`,[`hon.${table}`,name,type])).rows[0].safe) throw new Error(`Unsafe action approval trigger ${table}.${name}`);
 }
 if(!(await client.query("SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.action_approvals'::regclass AND conname='action_approvals_request_tenant_fk' AND contype='f' AND convalidated) safe")).rows[0].safe) throw new Error('Missing scoped approval proposal FK');
}
