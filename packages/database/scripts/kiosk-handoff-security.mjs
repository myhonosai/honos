import { readFile } from 'node:fs/promises';
export const kioskTables=['kiosk_terminals','kiosk_terminal_sessions','kiosk_claims','kiosk_handoffs','kiosk_receipts'];
export const kioskFunctions=[['manage_kiosk_terminal(text,text,uuid,uuid,text)',true],['provision_kiosk_claim(text,uuid,uuid,uuid,text)',true],['submit_kiosk_handoff(text,text)',true],['read_kiosk_handoff(text,uuid)',true],['lock_kiosk_actor(text,text)',false],['kiosk_secret_valid(text)',false],['guard_kiosk_transition()',false]];
export async function verifyKioskHandoffSecurity(client,runtime='hon_runtime') {
 if(!/^hon_[a-z_]+$/.test(runtime))throw new Error('Invalid kiosk runtime alias.');
 const canonical=await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
 const block=canonical.split('-- Kiosk handoff exact verification:')[1]?.split('-- End kiosk handoff exact verification.')[0];
 if(!block)throw new Error('Missing canonical kiosk verifier.');
 await client.query(block.replaceAll('hon_runtime',runtime));
 for(const [signature]of kioskFunctions){
  const source=(await client.query('SELECT prosrc FROM pg_proc WHERE oid=$1::regprocedure',['hon.'+signature])).rows[0].prosrc.replace(/--[^\n]*/g,'');
  if(/\bEXECUTE\b/i.test(source))throw new Error('Kiosk functions forbid dynamic SQL.');
  for(const match of source.matchAll(/hon\.([a-z_]+)/g)){
   const allowed=signature.startsWith('lock_kiosk_actor')?['current_organization_id','current_school_id','organizations','schools','users','principals','principal_role_grants','roles','role_permissions','family_access_grants','hq_operator_grants','organization_entitlements']:['current_organization_id','current_school_id','lock_kiosk_actor','kiosk_secret_valid',...kioskTables,'organizations','schools','student_profiles','class_sessions','organization_entitlements'];
   if(!allowed.includes(match[1]))throw new Error('Unexpected kiosk dependency: '+match[1]);
  }
  if(signature.startsWith('read_kiosk')&&/\b(?:INSERT|DELETE|TRUNCATE)\b|\bUPDATE\s+hon\./i.test(source))throw new Error('Kiosk recovery must not write.');
 }
}
