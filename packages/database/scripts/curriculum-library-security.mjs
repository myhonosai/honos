import {readFile} from 'node:fs/promises';
export const curriculumLibraryTables=['curriculum_resources','curriculum_resource_versions','curriculum_resource_requests','curriculum_resource_facts'];
export async function verifyCurriculumLibrarySecurity(client,runtime='hon_runtime') {
 if(!/^hon_[a-z_]+$/.test(runtime))throw new Error('Invalid library verifier runtime alias.');
 const canonical=await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
 const block=canonical.split('-- Curriculum library exact verification:')[1]?.split('-- End curriculum library exact verification.')[0];
 if(!block)throw new Error('Missing exact library verifier.');
 await client.query(block.replaceAll('hon_runtime',runtime));
}
