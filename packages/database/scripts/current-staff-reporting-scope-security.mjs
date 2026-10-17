import { readFile } from 'node:fs/promises';

export async function verifyCurrentStaffReportingScopeSecurity(client, runtime = 'hon_runtime') {
  if (!/^hon_[a-z_]+$/.test(runtime)) throw new Error('Unsafe staff reporting runtime alias.');
  const canonical = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
  const block = canonical.split('-- Current staff reporting scope exact verification:')[1]?.split('-- End current staff reporting scope exact verification.')[0];
  if (!block) throw new Error('Missing current staff reporting scope verifier.');
  await client.query(block.replaceAll('hon_runtime', runtime));
}
