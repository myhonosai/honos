import assert from 'node:assert/strict';
import pg from 'pg';
import { verifyMarketingAssistantSecurity } from './marketing-assistant-security.mjs';

const owner = new URL(process.env.DATABASE_URL ?? ''), runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
if (owner.hostname !== 'localhost' || owner.port !== '5432' || owner.pathname !== '/hon_marketing_ai_validation' || owner.username !== 'hon_marketing_ai_owner' || runtime.hostname !== owner.hostname || runtime.port !== owner.port || runtime.pathname !== owner.pathname || runtime.username !== 'hon_marketing_ai_runtime') throw new Error('Only the guarded disposable localhost Marketing Assistant database is permitted.');
const client = new pg.Client({ connectionString:owner.toString(), ssl:false });
await client.connect();
try {
  await verifyMarketingAssistantSecurity(client, runtime.username);
  const drifts = [
    'GRANT SELECT ON hon.marketing_ai_invocations TO hon_marketing_ai_runtime',
    'GRANT SELECT (request_text) ON hon.marketing_ai_invocations TO PUBLIC',
    'GRANT EXECUTE ON FUNCTION hon.marketing_owner(text) TO hon_marketing_ai_runtime',
    'REVOKE EXECUTE ON FUNCTION hon.read_marketing_invocation(text,uuid) FROM hon_marketing_ai_runtime',
    'GRANT EXECUTE ON FUNCTION hon.begin_marketing_request(text,jsonb,uuid) TO PUBLIC',
    'GRANT EXECUTE ON FUNCTION hon.begin_marketing_request(text,jsonb,uuid) TO hon_marketing_ai_runtime WITH GRANT OPTION',
    'ALTER FUNCTION hon.read_marketing_invocation(text,uuid) SET search_path=public',
    'ALTER TABLE hon.marketing_ai_drafts NO FORCE ROW LEVEL SECURITY',
    'CREATE POLICY synthetic_drift ON hon.marketing_campaign_content USING (true)',
    'ALTER TABLE hon.marketing_ai_drafts DISABLE TRIGGER marketing_draft_immutable',
  ];
  for (const sql of drifts) {
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await assert.rejects(verifyMarketingAssistantSecurity(client, runtime.username), /Unsafe Marketing Assistant/, `Canonical verifier must reject: ${sql}`);
    } finally { await client.query('ROLLBACK'); }
    await verifyMarketingAssistantSecurity(client, runtime.username);
  }
  console.log(`Marketing Assistant canonical verifier: ${drifts.length} deliberate table/column/function/grant-option/path/RLS/policy/trigger drifts rejected and rolled back; final posture passed.`);
} finally { await client.end(); }
