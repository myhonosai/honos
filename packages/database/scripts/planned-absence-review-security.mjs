import { readFile } from 'node:fs/promises';
export async function verifyPlannedAbsenceReviewSecurity(client, runtime = 'hon_runtime') {
  if (!/^hon_[a-z_]+$/.test(runtime)) throw new Error('Unsafe review runtime role.');
  const canonical = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
  const block = canonical.split('-- Planned absence review exact verification:')[1]?.split('-- End planned absence review exact verification.')[0];
  if (!block) throw new Error('Missing planned absence review security verifier.');
  await client.query(block.replaceAll('hon_runtime', runtime));
}
