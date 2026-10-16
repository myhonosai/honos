import { readFile } from 'node:fs/promises';
export const ownerLaunchTables=['student_registration_receipts','student_registration_outbox'];
export const ownerLaunchFunctions=[['guard_enrollment_program_identity()',false],['resolve_owner_launch_scope(text)',true],['require_owner_launch_actor(text)',false],['lock_owner_launch_actor(text)',false],['register_owner_launch_student(text,jsonb,text,uuid,uuid)',true],['read_owner_launch(text)',true]];
export async function verifyOwnerLaunchSecurity(client,runtime='hon_runtime') {
 if(!/^hon_[a-z_]+$/.test(runtime))throw new Error('Unsafe owner launch runtime alias.');
 const sql=await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
 const block=sql.split('-- Owner launch exact verification:')[1]?.split('-- End owner launch exact verification.')[0];
 if(!block)throw new Error('Missing owner launch verifier.');
 await client.query(block.replaceAll('hon_runtime',runtime));
}
