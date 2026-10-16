import { readFile } from 'node:fs/promises';
export const retentionAttentionTables=["retention_attention_alerts", "retention_attention_resolutions", "retention_attention_record_receipts", "retention_attention_resolution_receipts", "retention_attention_outbox"];
export const retentionAttentionFunctions=[["require_retention_attention_actor(text,text)", false], ["retention_attention_codes(jsonb)", false], ["retention_attention_projection(uuid,boolean)", false], ["read_retention_attention_alerts(text,uuid)", true], ["read_retention_attention_evidence(text,uuid)", true], ["record_retention_attention_alert(text,uuid,text,text,timestamptz,text,uuid,uuid,uuid)", true], ["resolve_retention_attention_alert(text,uuid,uuid,integer,text,uuid,uuid,uuid)", true]];
export async function verifyRetentionAttentionSecurity(client,runtime='hon_runtime') {
 if(!/^hon_[a-z_]+$/.test(runtime))throw new Error('Invalid retention attention runtime alias.');
 const canonical=await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
 const block=canonical.split('-- Retention factual attention exact verification:')[1]?.split('-- End retention factual attention exact verification.')[0];
 if(!block)throw new Error('Missing canonical retention factual attention verifier.');
 await client.query(block.replaceAll('hon_runtime',runtime));
}
