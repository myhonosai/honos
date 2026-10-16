import { readFile } from 'node:fs/promises';
import { verifyClassBookingLockSecurity } from './class-booking-lock-security.mjs';
export const classpassTables=['classpass_products','classpass_passes','classpass_ledger'];
export const classpassFunctions = [
 ['read_classpass(text,text,uuid)',true], ['command_classpass(text,text,uuid,jsonb,text,uuid,uuid)',true],
 ['read_parent_classpass_view(text)',true], ['lock_class_booking_session(text,uuid)',true],
 ['lock_classpass_actor(text,text)',false], ['require_classpass_read_actor(text)',false],
 ['guard_classpass_snapshot()',false], ['guard_classpass_booking()',false],
];
export async function verifyClassPassFunctionAcls(client,runtime='hon_runtime') {
 if (!/^hon_[a-z_]+$/.test(runtime)) throw new Error('Invalid ClassPass verifier runtime alias.');
 for (const [signature,executable] of classpassFunctions) {
  const {rows}=await client.query(`SELECT p.proowner,a.grantee,a.grantor,a.privilege_type,a.is_grantable,
   (SELECT oid FROM pg_roles WHERE rolname=$2) runtime_oid,
   has_function_privilege($2,p.oid,'EXECUTE') executable,
   has_function_privilege($2,p.oid,'EXECUTE WITH GRANT OPTION') grantable
   FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   WHERE p.oid=$1::regprocedure`,['hon.'+signature,runtime]);
  if (rows.length!==(executable?2:1) || rows.some(a=>!a.runtime_oid || a.proowner===a.runtime_oid
   || a.grantor!==a.proowner || a.privilege_type!=='EXECUTE' || a.is_grantable || a.grantable || a.executable!==executable
   || (a.grantee!==a.proowner && (!executable || a.grantee!==a.runtime_oid)))
   || rows.filter(a=>a.grantee===a.proowner).length!==1
   || rows.filter(a=>a.grantee===a.runtime_oid).length!==(executable?1:0)) throw new Error('ClassPass exact function ACL surplus/missing/grant option: '+signature);
 }
}
export async function verifyClassPassSecurity(client,runtime='hon_runtime') {
 if (!/^hon_[a-z_]+$/.test(runtime)) throw new Error('Invalid ClassPass verifier runtime alias.');
 const canonical=await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
 const block=canonical.split('-- ClassPass exact verification:')[1]?.split('-- End ClassPass exact verification.')[0];
 if (!block) throw new Error('Missing canonical ClassPass verification.');
 await client.query(block.replaceAll('hon_runtime',runtime));
 await verifyClassPassFunctionAcls(client,runtime);
 const parent=(await client.query("SELECT prosrc FROM pg_proc WHERE oid='hon.read_parent_classpass_view(text)'::regprocedure")).rows[0].prosrc.replace(/--[^\n]*/g,'');
 if (/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|EXECUTE)\b|FOR SHARE|FOR KEY SHARE/i.test(parent)) throw new Error('Parent ClassPass read must not mutate or lock.');
 for (const relation of parent.matchAll(/hon\.([a-z_]+)/g)) if (!['resolve_parent_journey_scopes','family_access_level','family_members','student_profiles','people','classpass_passes','class_bookings','class_sessions','classpass_ledger','attendance_records'].includes(relation[1])) throw new Error('Unexpected parent ClassPass dependency: '+relation[1]);
 const parentShape=(await client.query("SELECT pronargs,prorettype='jsonb'::regtype returns_json,prosecdef,provolatile FROM pg_proc WHERE oid='hon.read_parent_classpass_view(text)'::regprocedure")).rows[0];
 if (parentShape.pronargs!==1 || !parentShape.returns_json || !parentShape.prosecdef || parentShape.provolatile!=='v') throw new Error('Parent ClassPass must be exact subject-only JSON projection.');
 const read=(await client.query("SELECT prosrc FROM pg_proc WHERE oid='hon.read_classpass(text,text,uuid)'::regprocedure")).rows[0].prosrc;
 if (/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|EXECUTE)\b/i.test(read.replace(/--[^\n]*/g,''))) throw new Error('ClassPass read must not mutate.');
 const command=(await client.query("SELECT prosrc FROM pg_proc WHERE oid='hon.command_classpass(text,text,uuid,jsonb,text,uuid,uuid)'::regprocedure")).rows[0].prosrc;
 if (/\bEXECUTE\b/i.test(command.replace(/--[^\n]*/g,''))) throw new Error('ClassPass forbids dynamic SQL.');
 for (const forbidden of ['memberships','billing_accounts','invoices','payment_attempts','communication_messages','action_requests','ai_usage_ledger']) if (command.includes('hon.'+forbidden)) throw new Error('ClassPass may not consume or mutate financial/provider/execution state.');
 for (const table of classpassTables) {
  const columns=(await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema=\'hon\' AND table_name=$1',[table])).rows.map(r=>r.column_name);
  if (columns.some(c=>/(amount|currency|billing|payer|membership|invoice|payment|card|provider|purchase)/.test(c))) throw new Error('ClassPass has forbidden financial columns.');
 }
 await verifyClassBookingLockSecurity(client,runtime);
}
