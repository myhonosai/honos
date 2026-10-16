import { readFile } from 'node:fs/promises';
export async function verifyPromotionReadinessSecurity(client, runtime = 'hon_runtime') {
 if (!/^hon_[a-z_]+$/.test(runtime)) throw new Error('Invalid verifier runtime alias.');
 const canonical = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
 const block = canonical.split('-- Promotion readiness exact verification:')[1]?.split('-- End promotion readiness exact verification.')[0];
 if (!block) throw new Error('Missing canonical readiness verification.');
 await client.query(block.replaceAll('hon_runtime', runtime));
 const sql = (await client.query("SELECT prosrc FROM pg_proc WHERE oid='hon.read_promotion_readiness(text,uuid,uuid)'::regprocedure")).rows[0]?.prosrc;
 if (!sql || /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|EXECUTE|pg_advisory|FOR\s+SHARE|FOR\s+UPDATE)\b/i.test(sql.replace(/--[^\n]*/g, ''))) throw new Error('Readiness projection must be fixed and read-only.');
 for (const forbidden of ['instructor_notes', 'instructor_note', 'testing_registration_interests', 'testing_scorecards', 'document_versions', 'family_access_grants', 'payment_attempts', 'communication_messages', 'action_requests', 'ai_invocation_plans']) if (sql.includes(forbidden)) throw new Error('Readiness must not consume excluded evidence.');
}
