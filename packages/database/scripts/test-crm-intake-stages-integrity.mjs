import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { verifyCrmIntakeStagesSecurity } from './crm-intake-stages-security.mjs';
import { requireCrmIntakeStagesLocalUrls } from './crm-intake-stages-local-guard.mjs';

requireCrmIntakeStagesLocalUrls();
const owner = new URL(process.env.DATABASE_URL ?? ''), runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { CrmIntakeStagesService } = await import('../../../apps/api/dist/crm/crm-intake-stages.service.js');
const admin = new pg.Client({ connectionString: owner.toString(), ssl: false });
const restricted = new pg.Client({ connectionString: runtime.toString(), ssl: false });
const ids = Object.fromEntries(['org', 'school', 'otherSchool', 'user', 'staff', 'role', 'grant', 'family', 'mixedRole', 'mixedGrant', 'extraPrincipal', 'alphaPipeline', 'betaPipeline', 'zuluPipeline', 'otherPipeline'].map((key) => [key, randomUUID()]));
const subject = `crm-intake-${randomUUID()}`;
const context = (patch = {}) => ({ organizationId: ids.org, schoolId: ids.school, principalId: ids.staff, externalSubject: subject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: '', ...patch });
const denied = (status = 403) => (error) => error?.getStatus?.() === status || error?.code === '42501';
const sqlDenied = (work) => assert.rejects(work, (error) => error?.code === '42501');
const fields = (item) => Object.keys(item).sort();

async function snapshot() {
  return (await admin.query("SELECT coalesce(jsonb_object_agg(table_name,n),'{}') counts FROM (SELECT table_name,(xpath('/row/n/text()',query_to_xml(format('SELECT count(*) n FROM hon.%I',table_name),false,true,'')))[1]::text::bigint n FROM information_schema.tables WHERE table_schema='hon' AND table_type='BASE TABLE') rows")).rows[0].counts;
}

async function directRead(readContext, requestedSubject = readContext.externalSubject) {
  await restricted.query('BEGIN READ ONLY');
  try {
    for (const [key, value] of Object.entries({
      organization_id: readContext.organizationId,
      school_id: readContext.schoolId,
      principal_id: readContext.principalId,
      principal_type: readContext.principalType,
      source: readContext.source,
      external_subject: readContext.externalSubject,
      action_request_id: readContext.actionRequestId ?? '',
      delegated_by_principal_id: readContext.delegatedByPrincipalId ?? '',
    })) await restricted.query('SELECT set_config($1,$2,true)', [`app.hon_${key}`, value]);
    const result = await restricted.query('SELECT hon.read_current_school_crm_intake_stages($1) AS data', [requestedSubject]);
    await restricted.query('COMMIT');
    return result.rows[0]?.data;
  } catch (error) {
    await restricted.query('ROLLBACK');
    throw error;
  }
}

async function assertDeniedEverywhere(service, patch = {}, requestedSubject) {
  await assert.rejects(() => service.read(context(patch)), denied());
  await sqlDenied(() => directRead(context(patch), requestedSubject));
}

await Promise.all([admin.connect(), restricted.connect()]);
const database = new RuntimeDatabaseService();
const service = new CrmIntakeStagesService(database);
try {
  const marker = (await admin.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
  assert.deepEqual(marker, { owner: 'hon_crm_intake_stages_owner', marker: 'HON disposable CRM intake-stage validation' });
  const runtimePosture = (await restricted.query("SELECT NOT(rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication) safe FROM pg_roles WHERE rolname=current_user")).rows[0];
  assert.equal(runtimePosture.safe, true);
  assert.equal((await restricted.query("SELECT count(*)::int n FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)")).rows[0].n, 0);
  await verifyCrmIntakeStagesSecurity(admin, runtime.username);

  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PRIVATE_CRM_INTAKE_ORG','PRIVATE_CRM_INTAKE_ORG')", [ids.org]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,'PRIVATE_CRM_INTAKE_SCHOOL',$3),($4,$2,'PRIVATE_CRM_INTAKE_OTHER_SCHOOL',$5)", [ids.school, ids.org, `crm-intake-${ids.school}`, ids.otherSchool, `crm-intake-other-${ids.otherSchool}`]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',now()-interval '1 day')", [ids.org]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_CRM_INTAKE_HUMAN')", [ids.user, subject, `${ids.user}@example.test`]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'PRIVATE_CRM_INTAKE_HUMAN')", [ids.staff, ids.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'CRM_INTAKE_CREATOR','PRIVATE_CRM_INTAKE_ROLE')", [ids.role, ids.org]);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'crm.lead.create')", [ids.role, ids.org]);
  await admin.query("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,now()-interval '1 day')", [ids.grant, ids.org, ids.school, ids.staff, ids.role]);

  const expected = [];
  async function addStage(pipelineId, pipelineName, position, stageName, terminalStatus = null, include = false) {
    const stageId = randomUUID();
    await admin.query('INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position,terminal_status) VALUES($1,$2,$3,$4,$5,$6,$7::hon.lead_status)', [stageId, ids.org, ids.school, pipelineId, stageName, position, terminalStatus]);
    if (include) expected.push({ pipelineId, pipelineName, stageId, stageName });
  }
  await admin.query("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'ALPHA INTAKE'),($4,$2,$3,'BETA INTAKE'),($5,$2,$3,'ZULU INTAKE')", [ids.alphaPipeline, ids.org, ids.school, ids.betaPipeline, ids.zuluPipeline]);
  for (let index = 0; index < 24; index += 1) await addStage(ids.alphaPipeline, 'ALPHA INTAKE', index, `ALPHA_STAGE_${String(index).padStart(2, '0')}`, null, true);
  await addStage(ids.alphaPipeline, 'ALPHA INTAKE', 24, 'TERMINAL_STAGE_SECRET', 'WON');
  for (let index = 0; index < 3; index += 1) await addStage(ids.betaPipeline, 'BETA INTAKE', index, `BETA_STAGE_${String(index).padStart(2, '0')}`, null, index === 0);
  await addStage(ids.zuluPipeline, 'ZULU INTAKE', 0, 'ZULU_STAGE_SECRET');
  await admin.query("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'CROSS_SCHOOL_SECRET')", [ids.otherPipeline, ids.org, ids.otherSchool]);
  await admin.query("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,$4,'CROSS_SCHOOL_STAGE_SECRET',0)", [randomUUID(), ids.org, ids.otherSchool, ids.otherPipeline]);

  const before = await snapshot();
  const returned = await service.read(context());
  assert.equal(returned.length, 25);
  assert.deepEqual(returned, expected);
  assert.deepEqual(returned.map((item) => item.pipelineName), [...Array(24).fill('ALPHA INTAKE'), 'BETA INTAKE']);
  assert(returned.every((item) => JSON.stringify(item).includes('SECRET') === false));
  assert(returned.every((item) => fields(item).join(',') === 'pipelineId,pipelineName,stageId,stageName'));
  assert.deepEqual(await directRead(context()), expected);
  assert.deepEqual(await snapshot(), before, 'Successful read must write no table.');

  for (const table of ['crm_pipelines', 'crm_pipeline_stages']) {
    assert.equal((await restricted.query("SELECT has_table_privilege(current_user,$1,'SELECT') OR has_any_column_privilege(current_user,$1,'SELECT') allowed", [`hon.${table}`])).rows[0].allowed, false, table);
    await sqlDenied(() => restricted.query(`SELECT * FROM hon.${table}`));
  }
  await sqlDenied(() => restricted.query('SELECT hon.require_current_school_crm_intake_stages_actor($1)', [subject]));
  await sqlDenied(() => restricted.query('SELECT hon.read_current_school_crm_intake_stages($1)', [subject]));

  for (const patch of [
    { principalType: 'AI_EMPLOYEE' }, { source: 'AUTOMATION' }, { source: 'INTEGRATION' },
    { actionRequestId: randomUUID() }, { delegatedByPrincipalId: randomUUID() },
    { schoolId: ids.otherSchool }, { principalId: randomUUID() },
  ]) await assertDeniedEverywhere(service, patch);
  const mismatchedSubject = `other-subject-${randomUUID()}`;
  await assert.rejects(() => service.read(context({ externalSubject: mismatchedSubject })), denied());
  await sqlDenied(() => directRead(context(), mismatchedSubject));

  await admin.query("UPDATE hon.principals SET is_active=false WHERE id=$1", [ids.staff]);
  await assertDeniedEverywhere(service);
  await admin.query("UPDATE hon.principals SET is_active=true WHERE id=$1", [ids.staff]);

  await admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='crm.lead.create'", [ids.role]);
  await assertDeniedEverywhere(service);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'crm.lead.create')", [ids.role, ids.org]);
  await admin.query("UPDATE hon.permissions SET is_staff_assignable=false WHERE code='crm.lead.create'");
  await assertDeniedEverywhere(service);
  await admin.query("UPDATE hon.permissions SET is_staff_assignable=true WHERE code='crm.lead.create'");

  await admin.query("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [ids.org]);
  await assertDeniedEverywhere(service);
  await admin.query("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1", [ids.org]);
  await admin.query("UPDATE hon.organization_entitlements SET effective_until=now()-interval '1 second' WHERE organization_id=$1", [ids.org]);
  await assertDeniedEverywhere(service);
  await admin.query("UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1", [ids.org]);

  await admin.query("INSERT INTO hon.hq_operator_grants(id,principal_id,hq_role) VALUES($1,$2,'HON_HQ_OWNER')", [randomUUID(), ids.staff]);
  await assertDeniedEverywhere(service);
  await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=$1', [ids.staff]);
  await admin.query("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'PRIVATE_CRM_INTAKE_FAMILY')", [ids.family, ids.org, ids.school]);
  await admin.query("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,'VIEWER',now()-interval '1 day',$4)", [ids.org, ids.school, ids.family, ids.staff]);
  await assertDeniedEverywhere(service);
  await admin.query('DELETE FROM hon.family_access_grants WHERE principal_id=$1', [ids.staff]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'PARENT_MIXED','PRIVATE_CRM_INTAKE_MIXED')", [ids.mixedRole, ids.org]);
  await admin.query("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,now()-interval '1 day')", [ids.mixedGrant, ids.org, ids.school, ids.staff, ids.mixedRole]);
  await assertDeniedEverywhere(service);
  await admin.query('DELETE FROM hon.principal_role_grants WHERE id=$1', [ids.mixedGrant]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'PRIVATE_CRM_INTAKE_DUPLICATE')", [ids.extraPrincipal, ids.user]);
  await assertDeniedEverywhere(service);
  await admin.query('DELETE FROM hon.principals WHERE id=$1', [ids.extraPrincipal]);

  const beforeFinalRead = await snapshot();
  assert.deepEqual(await service.read(context()), expected);
  assert.deepEqual(await snapshot(), beforeFinalRead, 'Permitted and denied reads must have no write effect.');

  for (const sql of [
    `GRANT SELECT ON hon.crm_pipelines TO ${runtime.username}`,
    `GRANT EXECUTE ON FUNCTION hon.require_current_school_crm_intake_stages_actor(text) TO ${runtime.username}`,
    'ALTER TABLE hon.crm_pipelines NO FORCE ROW LEVEL SECURITY',
    'ALTER TABLE hon.crm_pipeline_stages NO FORCE ROW LEVEL SECURITY',
  ]) {
    await admin.query('BEGIN');
    try { await admin.query(sql); await assert.rejects(() => verifyCrmIntakeStagesSecurity(admin, runtime.username)); } finally { await admin.query('ROLLBACK'); }
  }
  for (const sql of [
    "CREATE OR REPLACE FUNCTION hon.require_current_school_crm_intake_stages_actor(p_subject text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$ BEGIN RETURN NULL; END $$",
    "CREATE OR REPLACE FUNCTION hon.read_current_school_crm_intake_stages(p_subject text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$ BEGIN RETURN '[]'::jsonb; END $$",
  ]) {
    await admin.query('BEGIN');
    try { await admin.query(sql); await assert.rejects(() => verifyCrmIntakeStagesSecurity(admin, runtime.username), /fingerprint drift/); } finally { await admin.query('ROLLBACK'); }
  }
  await verifyCrmIntakeStagesSecurity(admin, runtime.username);
  console.log('PASS: disposable localhost CRM intake-stage projection returns only the first 25 lexicographic non-terminal current-school pipeline/stage choices with four closed keys; reads write no tables; direct table/helper access and unscoped fixed reads deny; current active direct human crm.lead.create and active entitlement are required; HQ/family/mixed/nonhuman/delegated/action/scope/principal/subject denials hold; forced-RLS, grants, and both function fingerprints reject drift.');
} finally {
  await database.onModuleDestroy();
  await restricted.end();
  await admin.end();
}
