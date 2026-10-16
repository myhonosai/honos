import { readFile } from 'node:fs/promises';
export const retentionAcknowledgementTables=["retention_review_acknowledgements", "retention_review_acknowledgement_receipts", "retention_review_acknowledgement_outbox", "retention_review_acknowledgement_evidence_keys"];
export const retentionAcknowledgementFunctions=[["require_retention_acknowledgement_actor(text)", false], ["retention_review_evidence_fingerprint(jsonb,timestamptz)", false], ["read_retention_review_acknowledgement_evidence(text,uuid)", true], ["acknowledge_retention_review_evidence(text,uuid,text,text,timestamptz,uuid,uuid,uuid)", true]];
export async function verifyRetentionAcknowledgementSecurity(client,runtime='hon_runtime') {
 if(!/^hon_[a-z_]+$/.test(runtime))throw new Error('Invalid retention acknowledgement runtime alias.');
 const canonical=await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
 const block=canonical.split('-- Retention acknowledgement exact verification:')[1]?.split('-- End retention acknowledgement exact verification.')[0];
 if(!block)throw new Error('Missing canonical retention acknowledgement verifier.');
 await client.query(block.replaceAll('hon_runtime',runtime));
}
