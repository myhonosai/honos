import { readFile } from 'node:fs/promises';

export const marketingAssistantTables = ['marketing_ai_invocations', 'marketing_ai_drafts', 'marketing_campaign_content'];

/** Keep SQL and JavaScript verification identical, including drift denials. */
export async function verifyMarketingAssistantSecurity(client, runtimeRole) {
  if (typeof runtimeRole !== 'string' || !/^hon(?:_[a-z]+)*_runtime$/.test(runtimeRole)) throw new Error('Invalid Marketing Assistant verification runtime role identifier.');
  const canonical = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
  const block = canonical.split('-- Marketing Assistant exact verification:')[1]?.split('-- End Marketing Assistant verification.')[0];
  if (!block) throw new Error('Missing canonical Marketing Assistant verification block.');
  await client.query(block.replaceAll('hon_runtime', runtimeRole));
}
