import { readFile } from 'node:fs/promises';
export async function verifyParentPlannedAbsenceRequestSecurity(client, runtime = 'hon_runtime') {
  if (!/^hon_[a-z_]+$/.test(runtime)) throw new Error('Unsafe parent absence runtime alias.');
  const canonical = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
  const block = canonical.split('-- Parent planned absence request exact verification:')[1]?.split('-- End parent planned absence request exact verification.')[0];
  if (!block) throw new Error('Missing parent absence security verifier.');
  await client.query(block.replaceAll('hon_runtime', runtime));
}
