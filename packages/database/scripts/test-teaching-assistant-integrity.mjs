import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const target = process.env.HON_TEACHING_AI_VALIDATION_TARGET;
if (!target) throw new Error('HON_TEACHING_AI_VALIDATION_TARGET must name the disposable localhost Claire fixture.');
const url = new URL(target);
if (url.hostname !== 'localhost' || url.port !== '5432' || url.pathname !== '/hon_teaching_ai_validation') {
  throw new Error('Claire validation refuses every non-local or non-disposable target.');
}
if (process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_PAID_CALL_APPROVED) {
  throw new Error('Claire validation refuses provider credentials or a paid-call gate.');
}
const migration = await readFile(resolve('migrations/0100_claire_teaching_assistant.sql'), 'utf8');
for (const required of ['DRAFT_TEACHING', 'teaching_ai_invocations', 'teaching_action_is_current', 'teaching.draft.save', 'FORCE ROW LEVEL SECURITY']) {
  if (!migration.includes(required)) throw new Error(`Claire migration is missing ${required}.`);
}

const client = new pg.Client({ connectionString: url.toString(), ssl: false });
await client.connect();
try {
  const tables = ['teaching_ai_invocations', 'teaching_ai_drafts', 'teaching_studio_ai_drafts'];
  const state = await client.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x WHERE x.grantee = 0) AS public_access,
    has_table_privilege('hon_runtime', format('hon.%I', c.relname), 'SELECT') AS runtime_select
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='hon' AND c.relname = ANY($1::text[])`, [tables]);
  if (state.rows.length !== tables.length || state.rows.some(row => !row.relrowsecurity || !row.relforcerowsecurity || row.public_access || row.runtime_select)) {
    throw new Error('Claire private tables require forced RLS and no PUBLIC/runtime direct SELECT.');
  }

  const functions = [
    'hon.resolve_teaching_assistant_scope(text)',
    'hon.read_teaching_invocation(text,uuid)',
    'hon.begin_teaching_request(text,jsonb,uuid)',
    'hon.teaching_planning_reference(text,uuid)',
    'hon.prepare_teaching_invocation(text,uuid,uuid,boolean)',
    'hon.fail_teaching_invocation(text,uuid,text,text)',
    'hon.record_teaching_result(text,uuid,jsonb)',
    'hon.bind_teaching_proposal(text,uuid,uuid)',
    'hon.save_approved_teaching_draft(text,uuid)',
  ];
  for (const signature of functions) {
    const acl = await client.query(`SELECT
      EXISTS(SELECT 1 FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE p.oid=$1::regprocedure AND x.grantee=0 AND x.privilege_type='EXECUTE') AS public_execute,
      has_function_privilege('hon_runtime',$1,'EXECUTE') AS runtime_execute`, [signature]);
    if (acl.rows[0]?.public_execute || !acl.rows[0]?.runtime_execute) throw new Error(`Claire runtime function ACL is unsafe: ${signature}`);
  }
  const runtime = await client.query("SELECT rolsuper, rolbypassrls, rolinherit, rolcreatedb, rolcreaterole, rolcanlogin FROM pg_roles WHERE rolname='hon_runtime'");
  if (!runtime.rows[0] || runtime.rows[0].rolsuper || runtime.rows[0].rolbypassrls || runtime.rows[0].rolinherit || runtime.rows[0].rolcreatedb || runtime.rows[0].rolcreaterole || !runtime.rows[0].rolcanlogin) {
    throw new Error('Claire runtime verification requires the restricted hon_runtime role posture.');
  }
  console.log('Claire isolated local verification passed: forced RLS/private tables, no public/direct runtime reads, exact function-only runtime ACLs, and restricted runtime role posture.');
} finally {
  await client.end();
}
