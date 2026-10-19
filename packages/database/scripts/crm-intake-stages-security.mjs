import { createHash } from 'node:crypto';

const expectedFingerprints = Object.freeze({
  'hon.require_current_school_crm_intake_stages_actor(text)': '4f9568f14aad5e2728640fecc8ab399cf7d3b55add6b229e5dc6e24df31bf486',
  'hon.read_current_school_crm_intake_stages(text)': '960c330a664a714ac7b33d3e9f5af7d0a8dfefe7a6cb47cb6e0651fd784e2832',
});

function fingerprint(source) { return createHash('sha256').update(source).digest('hex'); }

export async function verifyCrmIntakeStagesSecurity(client, runtime = 'hon_runtime') {
  if (!/^hon_[a-z_]+$/.test(runtime)) throw new Error('Unsafe CRM intake-stage runtime alias.');
  const required = Object.keys(expectedFingerprints);
  const functions = await client.query(`SELECT p.oid::regprocedure::text signature, p.prosecdef, p.provolatile, p.proconfig, p.prosrc
    FROM pg_proc p WHERE p.oid = ANY($1::regprocedure[])`, [required]);
  if (functions.rows.length !== required.length) throw new Error('Missing CRM intake-stage functions.');
  for (const row of functions.rows) {
    if (!row.prosecdef || row.provolatile !== 'v' || !Array.isArray(row.proconfig) || !row.proconfig.includes('search_path=pg_catalog, hon')) throw new Error(`CRM intake-stage function posture weakened: ${row.signature}`);
    if (fingerprint(row.prosrc) !== expectedFingerprints[row.signature]) throw new Error(`CRM intake-stage function fingerprint drift: ${row.signature}`);
  }
  const helper = functions.rows.find((row) => row.signature.startsWith('hon.require_current_school_crm_intake_stages_actor'))?.prosrc ?? '';
  const read = functions.rows.find((row) => row.signature.startsWith('hon.read_current_school_crm_intake_stages'))?.prosrc ?? '';
  for (const text of ["'crm.lead.create'", "'HUMAN_USER'", "'HUMAN_UI'", 'app.hon_external_subject', 'app.hon_principal_id', 'app.hon_action_request_id', 'app.hon_delegated_by_principal_id', 'hq_operator_grants', 'family_access_grants', 'organization_entitlements', 'staff_member_eligible', 'is_staff_assignable']) if (!helper.includes(text)) throw new Error(`CRM intake-stage helper lacks ${text}.`);
  if (!helper.includes('count(*) FROM hon.principals') || !helper.includes("p.id = principal")) throw new Error('CRM intake-stage helper lacks exact one-human principal binding.');
  const body = read.replace(/--[^\n]*/g, '');
  if ((body.match(/require_current_school_crm_intake_stages_actor/g) ?? []).length !== 2 || !body.includes('LIMIT 25') || !body.includes('stage.terminal_status IS NULL')) throw new Error('CRM intake-stage fixed read/reauthorization weakened.');
  if (/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|EXECUTE)\b/i.test(body) || /\bFOR\s+(?:UPDATE|SHARE|KEY\s+SHARE)\b/i.test(body)) throw new Error('CRM intake-stage read must not mutate or lock.');
  for (const table of ['crm_leads', 'people', 'crm_activities', 'crm_lead_attributions', 'families', 'student_profiles', 'memberships', 'invoices', 'payment_attempts', 'action_requests', 'ai_usage_ledger', 'outbox_events', 'audit_events']) if (body.includes(`hon.${table}`)) throw new Error(`CRM intake-stage projection depends on forbidden table: ${table}`);
  for (const field of ['pipelineId', 'pipelineName', 'stageId', 'stageName']) if (!body.includes(`'${field}'`)) throw new Error(`CRM intake-stage projection lacks ${field}.`);
  const closedKeyCount = (body.match(/'(?:pipelineId|pipelineName|stageId|stageName)'/g) ?? []).length;
  if (closedKeyCount !== 4) throw new Error('CRM intake-stage projection exposes keys beyond its closed four-field contract.');
  const rls = await client.query("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = ANY(ARRAY['hon.crm_pipelines'::regclass, 'hon.crm_pipeline_stages'::regclass])");
  if (rls.rows.length !== 2 || rls.rows.some((row) => !row.relrowsecurity || !row.relforcerowsecurity)) throw new Error('CRM intake-stage tables must retain forced RLS.');
  const acl = await client.query(`SELECT
      has_table_privilege($1, 'hon.crm_pipelines', 'SELECT') AS pipelines_select,
      has_table_privilege($1, 'hon.crm_pipeline_stages', 'SELECT') AS stages_select,
      has_function_privilege($1, 'hon.read_current_school_crm_intake_stages(text)', 'EXECUTE') AS read_execute,
      has_function_privilege($1, 'hon.require_current_school_crm_intake_stages_actor(text)', 'EXECUTE') AS helper_execute,
      EXISTS (SELECT 1 FROM pg_proc AS proc CROSS JOIN LATERAL aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) AS privilege
        WHERE proc.oid = 'hon.read_current_school_crm_intake_stages(text)'::regprocedure AND privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE') AS public_read_execute,
      EXISTS (SELECT 1 FROM pg_proc AS proc CROSS JOIN LATERAL aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) AS privilege
        WHERE proc.oid = 'hon.require_current_school_crm_intake_stages_actor(text)'::regprocedure AND privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE') AS public_helper_execute`, [runtime]);
  const privileges = acl.rows[0];
  if (privileges?.pipelines_select || privileges?.stages_select || !privileges?.read_execute || privileges?.helper_execute || privileges?.public_read_execute || privileges?.public_helper_execute) throw new Error('CRM intake-stage function-only ACL weakened.');
  const permission = (await client.query("SELECT is_sensitive, is_staff_assignable FROM hon.permissions WHERE code='crm.lead.create'")).rows[0];
  if (!permission || permission.is_sensitive || !permission.is_staff_assignable) throw new Error('CRM intake-stage exact permission is invalid.');
}
