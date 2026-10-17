import { readFile } from 'node:fs/promises';

export async function verifyStaffReportingSchoolsSecurity(client, runtime = 'hon_runtime') {
  if (!/^hon_[a-z_]+$/.test(runtime)) throw new Error('Unsafe staff reporting runtime alias.');
  const canonical = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
  const block = canonical.split('-- Staff reporting schools exact verification:')[1]?.split('-- End staff reporting schools exact verification.')[0];
  if (!block) throw new Error('Missing staff reporting schools verifier.');
  await client.query(block.replaceAll('hon_runtime', runtime));
}
