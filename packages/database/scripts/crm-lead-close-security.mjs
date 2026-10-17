import { readFile } from 'node:fs/promises';
export async function verifyCrmLeadCloseSecurity(client, runtime = 'hon_runtime') {
  if (!/^hon_[a-z_]+$/.test(runtime)) throw new Error('Unsafe CRM close runtime role.');
  const canonical = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
  const block = canonical.split('-- CRM-only lead close exact verification:')[1]?.split('-- End CRM-only lead close exact verification.')[0];
  if (!block) throw new Error('Missing canonical CRM close verifier.');
  await client.query(block.replaceAll('hon_runtime', runtime));
}
