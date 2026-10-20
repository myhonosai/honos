import { verifyCrmLeadCloseSecurity } from './crm-lead-close-security.mjs';
import { verifyParentPlannedAbsenceRequestSecurity } from './parent-planned-absence-request-security.mjs';
import { verifyPlannedAbsenceReviewSecurity } from './planned-absence-review-security.mjs';
import { curriculumLibraryTables,verifyCurriculumLibrarySecurity } from './curriculum-library-security.mjs';
import { requireCurriculumLibraryLocalUrls } from './curriculum-library-local-guard.mjs';
import { retentionAttentionTables, verifyRetentionAttentionSecurity } from './retention-attention-security.mjs';
import { requireClassPassLocalUrls } from './classpass-local-guard.mjs';
import { verifyCurrentStaffReportingScopeSecurity } from './current-staff-reporting-scope-security.mjs';
import { verifyStaffReportingSchoolsSecurity } from './staff-reporting-schools-security.mjs';
import { classpassTables, verifyClassPassSecurity } from './classpass-security.mjs';
import { requireKioskHandoffLocalUrls } from './kiosk-handoff-local-guard.mjs';
import { kioskTables, verifyKioskHandoffSecurity } from './kiosk-handoff-security.mjs';
import { requirePromotionReadinessLocalUrls } from './promotion-readiness-local-guard.mjs';
import { verifyPromotionReadinessSecurity } from './promotion-readiness-security.mjs';
import { marketingAssistantTables, verifyMarketingAssistantSecurity } from './marketing-assistant-security.mjs';
import { achievementTables, verifyAchievementSecurity } from './achievement-security.mjs';
import { testingCertificateTables, verifyTestingCertificateSecurity } from './testing-certificate-security.mjs';
import { testingScorecardTables, verifyTestingScorecardSecurity } from './testing-scorecard-security.mjs';
import { marketplaceTables, verifyMarketplaceSecurity } from './marketplace-security.mjs';
import { humanWorkTables, verifyHumanWorkSecurity } from './human-work-security.mjs';
import { voiceTables, verifyVoiceSecurity } from './voice-security.mjs';
import { retentionAcknowledgementTables, verifyRetentionAcknowledgementSecurity } from './retention-review-acknowledgement-security.mjs';
import { requireRetentionAcknowledgementLocalUrls } from './retention-review-acknowledgement-local-guard.mjs';
import { requireHqSchoolsLocalUrls } from './hq-schools-local-guard.mjs';
import { verifyRetentionReviewSecurity } from './retention-review-security.mjs';
import { ownerLaunchTables, verifyOwnerLaunchSecurity } from './owner-launch-security.mjs';
import { requireOwnerLaunchLocalUrls } from './owner-launch-local-guard.mjs';
import pg from 'pg';
import { verifyActionApprovalSecurity } from './action-approval-security.mjs';
import { communityTables, verifyCommunitySecurity } from './community-security.mjs';
import { championsClubTables, verifyChampionsClubSecurity } from './champions-club-security.mjs';
import { saasBillingTables, verifySaasBillingSecurity } from './saas-billing-security.mjs';
import { languagePreferenceTables, verifyLanguagePreferenceSecurity } from './language-preferences-security.mjs';
import { readFile } from 'node:fs/promises';

const { Client } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for RLS verification.');
// Supabase Session Pooler usernames are emitted as `role.project_ref`, while
// PostgreSQL role grants and SECURITY DEFINER ACLs remain attached to `role`.
// Local disposable validation aliases do not contain a dot and pass unchanged.
const runtimeRoleName = process.env.HON_RUNTIME_DATABASE_URL ? new URL(process.env.HON_RUNTIME_DATABASE_URL).username.split('.', 1)[0] : 'hon_runtime';
if (!['hon_owner_launch_runtime','hon_curriculum_library_runtime','hon_retention_acknowledgement_runtime','hon_classpass_runtime','hon_kiosk_handoff_runtime','hon_promotion_readiness_runtime','hon_marketing_ai_runtime','hon_teaching_ai_runtime','hon_achievement_runtime','hon_marketplace_runtime','hon_runtime','hon_crm_close_runtime','hon_attendance_runtime','hon_attendance_backfill_runtime','hon_work_runtime','hon_voice_runtime','hon_approval_runtime','hon_parent_billing_runtime','hon_revenue_runtime','hon_campaign_runtime','hon_staff_runtime','hon_automation_runtime','hon_followup_runtime','hon_renewal_runtime','hon_community_runtime','hon_hq_schools_runtime'].includes(runtimeRoleName)) throw new Error('Unknown verifier runtime role.');
if (runtimeRoleName === 'hon_owner_launch_runtime') requireOwnerLaunchLocalUrls();
if (runtimeRoleName === 'hon_curriculum_library_runtime') requireCurriculumLibraryLocalUrls();
if (runtimeRoleName === 'hon_classpass_runtime') requireClassPassLocalUrls();
if (runtimeRoleName === 'hon_retention_acknowledgement_runtime') requireRetentionAcknowledgementLocalUrls();
if (runtimeRoleName === 'hon_kiosk_handoff_runtime') requireKioskHandoffLocalUrls();
if (runtimeRoleName === 'hon_promotion_readiness_runtime') requirePromotionReadinessLocalUrls();
if (runtimeRoleName === 'hon_hq_schools_runtime') requireHqSchoolsLocalUrls();
if (runtimeRoleName === 'hon_crm_close_runtime') {
  for (const [key,role] of [['DATABASE_URL','hon_crm_close_owner'],['HON_RUNTIME_DATABASE_URL','hon_crm_close_runtime']]) {
    const url = new URL(process.env[key] ?? '');
    if (url.hostname !== 'localhost' || url.port !== '5432' || url.pathname !== '/hon_crm_close_validation' || url.username !== role) throw new Error('CRM close verifier requires exact disposable localhost aliases.');
  }
}
if (runtimeRoleName !== 'hon_runtime') {
  for (const key of ['DATABASE_URL','HON_RUNTIME_DATABASE_URL']) {
    const url = new URL(process.env[key]);
    const db = runtimeRoleName === 'hon_crm_close_runtime' ? '/hon_crm_close_validation' : runtimeRoleName === 'hon_owner_launch_runtime' ? '/hon_owner_launch_validation' : runtimeRoleName === 'hon_curriculum_library_runtime' ? '/hon_curriculum_library_validation' : runtimeRoleName === 'hon_retention_acknowledgement_runtime' ? '/hon_retention_acknowledgement_validation' : runtimeRoleName === 'hon_classpass_runtime' ? '/hon_classpass_validation' : runtimeRoleName === 'hon_kiosk_handoff_runtime' ? '/hon_kiosk_handoff_validation' : runtimeRoleName === 'hon_promotion_readiness_runtime' ? '/hon_promotion_readiness_validation' : runtimeRoleName === 'hon_attendance_runtime' ? '/hon_attendance_validation' : runtimeRoleName === 'hon_attendance_backfill_runtime' ? '/hon_attendance_backfill_validation' : runtimeRoleName === 'hon_marketing_ai_runtime' ? '/hon_marketing_ai_validation' : runtimeRoleName === 'hon_teaching_ai_runtime' ? '/hon_teaching_ai_validation' : runtimeRoleName === 'hon_achievement_runtime' ? '/hon_achievement_validation' : runtimeRoleName === 'hon_marketplace_runtime' ? '/hon_marketplace_validation' : runtimeRoleName === 'hon_work_runtime' ? '/hon_work_validation' : runtimeRoleName === 'hon_voice_runtime' ? '/hon_voice_validation' : runtimeRoleName === 'hon_approval_runtime' ? '/hon_approval_validation' : runtimeRoleName === 'hon_parent_billing_runtime' ? '/hon_parent_billing_validation' : runtimeRoleName === 'hon_community_runtime' ? '/hon_community_validation' : runtimeRoleName === 'hon_renewal_runtime' ? '/hon_renewal_validation' : runtimeRoleName === 'hon_followup_runtime' ? '/hon_followup_validation' : runtimeRoleName === 'hon_automation_runtime' ? '/hon_automation_validation' : runtimeRoleName === 'hon_staff_runtime' ? '/hon_staff_validation' : runtimeRoleName === 'hon_campaign_runtime' ? '/hon_campaign_validation' : runtimeRoleName === 'hon_hq_schools_runtime' ? '/hon_hq_schools_validation' : '/hon_revenue_validation';
    if (url.hostname !== 'localhost' || url.pathname !== db) throw new Error('Local verifier requires the guarded disposable localhost database.');
    if (runtimeRoleName === 'hon_attendance_runtime' && (url.port !== '5432' || url.username !== (key === 'DATABASE_URL' ? 'hon_attendance_owner' : runtimeRoleName))) throw new Error('Attendance verifier requires exact disposable-local aliases.');
    if (runtimeRoleName === 'hon_attendance_backfill_runtime' && (url.port !== '5432' || url.username !== (key === 'DATABASE_URL' ? 'hon_attendance_backfill_owner' : runtimeRoleName))) throw new Error('Attendance backfill verifier requires exact marked disposable-local aliases.');
    if (runtimeRoleName === 'hon_marketing_ai_runtime' && (url.port !== '5432' || url.username !== (key === 'DATABASE_URL' ? 'hon_marketing_ai_owner' : runtimeRoleName))) throw new Error('Marketing Assistant verifier requires exact disposable-local aliases.');
    if (runtimeRoleName === 'hon_parent_billing_runtime' && (url.port !== '5432' || url.username !== (key === 'DATABASE_URL' ? 'hon_parent_billing_owner' : runtimeRoleName))) throw new Error('Parent billing verifier requires exact disposable-local aliases.');
  }
}

const expectedRlsTables = [
  'hq_entitlement_requests', 'hq_entitlement_audit', 'hq_entitlement_outbox',
  ...ownerLaunchTables,
  ...curriculumLibraryTables,
  ...retentionAcknowledgementTables,
  ...retentionAttentionTables,
  ...marketingAssistantTables,
  ...achievementTables,
  ...testingCertificateTables,
  ...testingScorecardTables,
  ...marketplaceTables,
  ...humanWorkTables,
  ...voiceTables,
  ...communityTables,
  ...championsClubTables,
  ...saasBillingTables,
  ...languagePreferenceTables,
  'membership_renewal_reviews', 'membership_renewal_versions', 'membership_renewal_requests',
  'crm_follow_ups', 'crm_follow_up_versions', 'crm_follow_up_requests',
  'crm_lead_close_requests',
  'automation_rules', 'automation_rule_versions', 'automation_rule_requests',
  'staff_profiles', 'staff_planning_revisions', 'staff_planning_requests',
  'instructor_qualifications', 'instructor_qualification_revisions', 'instructor_qualification_evidence',
  'instructor_qualification_evidence_reviews', 'instructor_qualification_requests', 'instructor_qualification_outbox',
  'action_approvals',
  'action_policies',
  'action_requests',
  'ai_team_presentation_preferences',
  'ai_usage_ledger',
  'ai_invocation_plans',
  'chad_follow_up_invocations',
  'chad_follow_up_drafts',
  'audit_events',
  'attendance_records',
  'attendance_progression_policies',
  'attendance_policy_requests',
  'billing_accounts',
	...classpassTables,
	...kioskTables,
	'class_bookings',
  'class_session_instructors',
  'class_sessions',
  'class_templates',
  'communication_consents',
  'communication_messages',
  'crm_activities',
  'crm_appointments',
  'crm_lead_registration_conversions',
  'crm_adult_membership_draft_sources',
  'crm_leads',
  'crm_lead_attributions',
  'crm_pipeline_stages',
  'crm_pipelines',
  'curricula',
  'curriculum_ranks',
  'curriculum_requirements',
  'curriculum_requirement_versions',
  'curriculum_enrollment_history',
  'curriculum_progress_observations',
  'curriculum_command_requests',
  'document_templates',
  'document_versions',
  'document_publications',
  'document_acknowledgements',
  'document_command_requests',
  'families',
  'family_access_grants',
  'family_members',
  'hq_ai_provider_connections',
  'hq_ai_model_catalog',
  'hq_ai_routing_policies',
  'hq_ai_routing_candidates',
  'hq_ai_task_profiles',
  'hq_ai_task_profile_candidates',
  'hq_ai_control_requests',
  'hq_ai_control_audit',
  'hq_ai_control_outbox',
  'hq_onboarding_requests',
  'hq_operator_grants',
  'idempotency_records',
  'invoices',
  'knowledge_articles',
  'lead_import_batches',
  'lead_import_rows',
  'lead_import_evidence',
  'lead_import_requests',
  'public_lead_forms',
  'public_lead_form_versions',
  'public_lead_form_requests',
  'public_lead_form_receipts',
  'public_lead_form_rates',
  'marketing_campaigns',
  'marketing_campaign_versions',
  'marketing_campaign_requests',
  'membership_payment_schedules',
  'memberships',
  'organization_entitlements',
  'organizations',
  'outbox_delivery_attempts',
  'outbox_events',
  'payment_attempts',
  'people',
  'planned_absence_requests',
  'principal_interface_preferences',
  'principal_role_grants',
  'programs',
  'revenue_plans',
  'revenue_plan_versions',
  'revenue_plan_requests',
  'roles',
  'role_permissions',
  'schools',
  'student_curriculum_enrollments',
  'student_profiles',
  'teaching_lesson_plans',
  'teaching_lesson_plan_revisions',
  'teaching_ai_invocations',
  'teaching_ai_drafts',
  'teaching_studio_ai_drafts',
  'teaching_resources',
  'teaching_resource_revisions',
  'instructor_assessments',
  'instructor_assessment_revisions',
  'teaching_studio_requests',
  'testing_candidates',
  'testing_events',
  'testing_registration_command_receipts',
  'testing_registration_interests',
  'promotion_decisions',
  'work_items',
].sort();

const curriculumPrivateTables = ['curriculum_requirement_versions', 'curriculum_enrollment_history', 'curriculum_progress_observations', 'curriculum_command_requests'];
const curriculumRestrictedTables = ['curriculum_requirements', ...curriculumPrivateTables];
// [signature, runtime EXECUTE, SECURITY DEFINER]; trigger-only guards are invoker
// functions, not callable authorization boundaries.
const curriculumFunctions = [
  ['hon.mutate_curriculum_progress(text,text,uuid,uuid,jsonb,text,uuid,uuid)', true, true],
  ['hon.read_staff_curriculum_progress(text,text,uuid,uuid)', true, true],
  ['hon.read_parent_curriculum_progress(text,uuid)', true, true],
  ['hon.lock_human_testing_authority(text)', true, true],
  ['hon.lock_human_testing_record(text,text,uuid)', true, true],
  ['hon.resolve_authorized_scope(text,uuid,text)', true, true],
  ['hon.resolve_parent_family_scope(text,uuid)', true, true],
  ['hon.resolve_parent_journey_scopes(text)', true, true],
  ['hon.read_parent_planned_absence_history(text)', true, true],
  ['hon.principal_has_school_permission(uuid,uuid,uuid,text)', true, true],
  ['hon.require_curriculum_actor(text,text)', false, true],
  ['hon.snapshot_curriculum_requirement()', false, true],
  ['hon.validate_curriculum_observation()', false, true],
  ['hon.verify_curriculum_enrollment_evidence()', false, true],
  ['hon.guard_curriculum_history()', false, false],
  ['hon.guard_curriculum_requirement()', false, false],
  ['hon.guard_curriculum_enrollment_identity()', false, false],
  ['hon.guard_curriculum_structure_identity()', false, false],
];

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
});
await client.connect();
try {
  await verifyOwnerLaunchSecurity(client,runtimeRoleName);
  await verifyCurrentStaffReportingScopeSecurity(client, runtimeRoleName);
  await verifyParentPlannedAbsenceRequestSecurity(client, runtimeRoleName);
  await verifyPlannedAbsenceReviewSecurity(client, runtimeRoleName);
  await verifyStaffReportingSchoolsSecurity(client, runtimeRoleName);
  const attendanceCanonical = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
  const attendanceVerification = attendanceCanonical.split('-- Advanced attendance exact verification:')[1]?.split('-- End advanced attendance exact verification.')[0];
  if (!attendanceVerification) throw new Error('Missing canonical attendance verification.');
  await client.query(attendanceVerification.replaceAll('hon_runtime', runtimeRoleName));
  // Explicitly guard the application command boundary in the JS verifier too.
  const attendanceBoundary = (await client.query(`SELECT
    has_table_privilege($1,'hon.attendance_records','SELECT') readable,
    has_table_privilege($1,'hon.attendance_records','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') writable,
    has_any_column_privilege($1,'hon.attendance_records','INSERT,UPDATE,REFERENCES') column_writable,
    has_function_privilege($1,'hon.record_attendance(text,uuid,jsonb,text,uuid,uuid)','EXECUTE') command`, [runtimeRoleName])).rows[0];
  if (!attendanceBoundary?.readable || attendanceBoundary.writable || attendanceBoundary.column_writable || !attendanceBoundary.command) {
    throw new Error('Attendance requires SELECT-only records and the fixed atomic command.');
  }
  await verifyMarketingAssistantSecurity(client, runtimeRoleName);
  // One fixed requester-only work pointer per implemented drafting slice. These
  // projections expose no prompt/draft/provider/usage table and must remain
  // sealed SECURITY DEFINER read boundaries for the restricted runtime only.
  const inboxFunctions = runtimeRoleName === 'hon_marketing_ai_runtime'
    ? ['hon.list_my_marketing_invocations(text)']
    : runtimeRoleName === 'hon_teaching_ai_runtime'
      ? ['hon.list_my_teaching_invocations(text)']
      : ['hon.list_my_marketing_invocations(text)', 'hon.list_my_teaching_invocations(text)', 'hon.list_my_chad_follow_up_invocations(text)'];
  for (const signature of inboxFunctions) {
    const inbox = (await client.query(`SELECT
      p.prosecdef AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, hon']::text[] AS definition_safe,
      (owner_role.rolsuper OR owner_role.rolbypassrls) AND owner_role.rolname<>$2 AS owner_safe,
      has_function_privilege($2,p.oid,'EXECUTE') AS runtime_execute,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee=(SELECT oid FROM pg_roles WHERE rolname=$2) AND acl.privilege_type='EXECUTE' AND acl.is_grantable) AS runtime_grantable
      FROM pg_proc p JOIN pg_roles owner_role ON owner_role.oid=p.proowner WHERE p.oid=$1::regprocedure`, [signature, runtimeRoleName])).rows[0];
    if (!inbox?.definition_safe || !inbox.owner_safe || !inbox.runtime_execute || inbox.public_execute || inbox.runtime_grantable) throw new Error(`Unsafe AI Draft Work inbox function: ${signature}`);
    for (const { rolname } of (await client.query("SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role')")).rows) {
      if ((await client.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [rolname, signature])).rows[0].allowed) throw new Error(`Forbidden client AI Draft Work inbox execution: ${rolname}.${signature}`);
    }
  }
  await verifyAchievementSecurity(client,runtimeRoleName);
  await verifyTestingCertificateSecurity(client, runtimeRoleName);
  await verifyTestingScorecardSecurity(client, runtimeRoleName);
	await verifyPromotionReadinessSecurity(client, runtimeRoleName);
	await verifyClassPassSecurity(client, runtimeRoleName);
	await verifyKioskHandoffSecurity(client, runtimeRoleName);
	await verifyMarketplaceSecurity(client, runtimeRoleName);
  await verifyCommunitySecurity(client, runtimeRoleName);
  await verifyChampionsClubSecurity(client, runtimeRoleName);
  await verifySaasBillingSecurity(client, runtimeRoleName);
  await verifyLanguagePreferenceSecurity(client, runtimeRoleName);
  await verifyVoiceSecurity(client,runtimeRoleName);
  await verifyHumanWorkSecurity(client,runtimeRoleName);
  await verifyActionApprovalSecurity(client,runtimeRoleName);
  await verifyRetentionReviewSecurity(client,runtimeRoleName);
  await verifyRetentionAcknowledgementSecurity(client,runtimeRoleName);
  await verifyRetentionAttentionSecurity(client,runtimeRoleName);
  await verifyCurriculumLibrarySecurity(client,runtimeRoleName);
  const posture = (await client.query(`SELECT rolcanlogin,rolsuper,rolbypassrls,rolinherit,rolcreatedb,rolcreaterole,rolreplication,
    EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) memberships,
    has_schema_privilege(r.rolname,'hon','CREATE') schema_create,
    has_schema_privilege(r.rolname,'hon','USAGE') schema_usage
    FROM pg_roles r WHERE r.rolname=$1`, [runtimeRoleName])).rows[0];
  if (!posture?.rolcanlogin || !posture.schema_usage || Object.entries(posture).some(([k,v]) => !['rolcanlogin','schema_usage'].includes(k) && v)) throw new Error('Runtime verification requires a restricted login with no elevated posture, role memberships or schema CREATE.');
  const rows = (await client.query(`
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'hon'
      AND c.relkind = 'r'
      AND c.relname = ANY($1::text[])
    ORDER BY c.relname
  `, [expectedRlsTables])).rows;
  const present = new Set(rows.map((row) => row.relname));
  const missingTables = expectedRlsTables.filter((table) => !present.has(table));
  const unforced = rows.filter((row) => !row.relrowsecurity || !row.relforcerowsecurity).map((row) => row.relname);
  const unexpected = (await client.query(`
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'hon' AND c.relkind = 'r' AND c.relrowsecurity = true AND c.relname <> ALL($1::text[])
    ORDER BY c.relname
  `, [expectedRlsTables])).rows.map((row) => row.relname);
  if (missingTables.length || unforced.length || unexpected.length) {
    throw new Error(`RLS verification failed. Missing: ${missingTables.join(', ') || 'none'}; disabled/unforced: ${unforced.join(', ') || 'none'}; untracked RLS tables: ${unexpected.join(', ') || 'none'}.`);
  }

  const appendOnlyPolicies = (await client.query(`
    SELECT tablename, array_agg(cmd ORDER BY cmd) AS commands
    FROM pg_policies
    WHERE schemaname = 'hon' AND tablename IN ('audit_events', 'outbox_events')
    GROUP BY tablename
  `)).rows;
  for (const policy of appendOnlyPolicies) {
    const commands = policy.commands ?? [];
    if (!commands.includes('SELECT') || !commands.includes('INSERT') || commands.some((command) => ['ALL', 'UPDATE', 'DELETE'].includes(command))) {
      throw new Error(`Append-only policy verification failed for ${policy.tablename}.`);
    }
  }
  if (appendOnlyPolicies.length !== 2) throw new Error('Append-only policies are missing for HON audit/outbox tables.');

  const workItemPolicies = (await client.query(`
    SELECT cmd
    FROM pg_policies
    WHERE schemaname = 'hon' AND tablename = 'work_items'
  `)).rows.map((row) => row.cmd);
  if (workItemPolicies.length) throw new Error('Work items must have forced deny-all RLS; fixed human/reference boundaries only.');

  const aiUsagePolicies = (await client.query(`
    SELECT cmd
    FROM pg_policies
    WHERE schemaname = 'hon' AND tablename = 'ai_usage_ledger'
  `)).rows.map((row) => row.cmd);
  if (!aiUsagePolicies.includes('ALL')) {
    throw new Error('AI usage ledger tenant-isolation RLS policy is missing.');
  }

  const planPolicies = (await client.query("SELECT cmd FROM pg_policies WHERE schemaname='hon' AND tablename='ai_invocation_plans'")).rows;
  if (planPolicies.length !== 1 || planPolicies[0].cmd !== 'SELECT') throw new Error('Invocation plans must have only scoped SELECT policy; append is definer-only.');

  const documentTables = ['document_templates','document_versions','document_publications','document_acknowledgements','document_command_requests'];
  if ((await client.query("SELECT count(*) n FROM pg_policies WHERE schemaname='hon' AND tablename=ANY($1::text[])",[documentTables])).rows[0].n !== '0') throw new Error('Document tables must retain forced deny-all RLS.');
  const importTables = ['lead_import_batches','lead_import_rows','lead_import_evidence','lead_import_requests'];
  if ((await client.query("SELECT count(*) n FROM pg_policies WHERE schemaname='hon' AND tablename=ANY($1::text[])",[importTables])).rows[0].n !== '0') throw new Error('Import tables must retain forced deny-all RLS.');
  if ((await client.query("SELECT count(*) n FROM pg_policies WHERE schemaname='hon' AND tablename=ANY($1::text[])", [curriculumPrivateTables])).rows[0].n !== '0') throw new Error('Curriculum history/replay must retain forced deny-all RLS.');
  const broadCurriculumAcls = (await client.query(`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='hon' AND c.relname=ANY($1::text[]) AND (
      EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
        WHERE a.grantee NOT IN(c.relowner,coalesce((SELECT oid FROM pg_roles WHERE rolname='${runtimeRoleName}'),c.relowner)))
      OR EXISTS(SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a
        WHERE att.attrelid=c.oid AND att.attnum>0 AND NOT att.attisdropped
        AND a.grantee NOT IN(c.relowner,coalesce((SELECT oid FROM pg_roles WHERE rolname='${runtimeRoleName}'),c.relowner))))
  `, [[...curriculumRestrictedTables, 'student_curriculum_enrollments']])).rows;
  if (broadCurriculumAcls.length) throw new Error(`Forbidden PUBLIC/client curriculum table/column ACLs: ${broadCurriculumAcls.map(r => r.relname).join(', ')}`);
  for (const {rolname} of (await client.query("SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role')")).rows) {
    for (const table of importTables) if ((await client.query("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed",[rolname,`hon.${table}`])).rows[0].allowed) throw new Error(`Forbidden client import access: ${rolname}.${table}`);
    for (const signature of ['hon.resolve_lead_import_scope(text,text)','hon.mutate_lead_import(text,text,uuid,jsonb,text,uuid,uuid)','hon.read_lead_import(text,text,uuid,uuid)']) if ((await client.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed",[rolname,signature])).rows[0].allowed) throw new Error(`Forbidden client import function: ${rolname}.${signature}`);
    for (const table of curriculumRestrictedTables) {
      const access = (await client.query("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') allowed", [rolname, `hon.${table}`])).rows[0];
      if (access.allowed) throw new Error(`Forbidden client curriculum access: ${rolname}.${table}`);
    }
    if ((await client.query("SELECT has_table_privilege($1,'hon.student_curriculum_enrollments','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege($1,'hon.student_curriculum_enrollments','INSERT,UPDATE,REFERENCES') allowed", [rolname])).rows[0].allowed) throw new Error(`Forbidden client enrollment mutation: ${rolname}`);
    for (const [signature] of curriculumFunctions) if ((await client.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [rolname, signature])).rows[0].allowed) throw new Error(`Forbidden client curriculum/authorization function: ${rolname}.${signature}`);
  }
  const renewalCanonical = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
  const renewalVerification = renewalCanonical.split('-- Human renewal exact verification:')[1]?.split('-- End human renewal verification.')[0];
  if (!renewalVerification) throw new Error('Missing canonical renewal verification block.');
  await client.query(('DO $$' + renewalVerification.split('DO $$')[1]).replaceAll('hon_runtime', runtimeRoleName));
  const followUpCanonical = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
  const followUpVerification = followUpCanonical.split('-- Human follow-up exact verification:')[1]?.split('-- End human follow-up verification.')[0];
  if (!followUpVerification) throw new Error('Missing canonical follow-up verification block.');
  await client.query(('DO $$' + followUpVerification.split('DO $$')[1]).replaceAll('hon_runtime', runtimeRoleName));
  const automationCanonical = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
  const automationVerification = automationCanonical.split('-- Inert automation exact verification:')[1]?.split('-- End inert automation verification.')[0];
  if (!automationVerification) throw new Error('Missing canonical automation verification block.');
  await client.query(('DO $$' + automationVerification.split('DO $$')[1]).replaceAll('hon_runtime', runtimeRoleName));
  const staffCanonical = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
  const staffVerification = staffCanonical.split('-- Human staff planning exact verification:')[1]?.split('-- End human staff planning verification.')[0];
  if (!staffVerification) throw new Error('Missing canonical staff verification block.');
  await client.query(('DO $$' + staffVerification.split('DO $$')[1]).replaceAll('hon_runtime', runtimeRoleName));
  const qualificationCanonical = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
  const qualificationVerification = qualificationCanonical.split('-- Human instructor qualification evidence:')[1]?.split('-- End Human instructor qualification exact verification.')[0];
  if (!qualificationVerification) throw new Error('Missing canonical instructor qualification verification block.');
  await client.query(('DO $$' + qualificationVerification.split('DO $$')[1]).replaceAll('hon_runtime', runtimeRoleName));

  const hqAiCanonical = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
  const hqAiVerification = hqAiCanonical.split('-- HQ AI exact verification:')[1]?.split('-- End HQ AI exact verification.')[0];
  if (!hqAiVerification) throw new Error('Missing canonical HQ AI verification block.');
  await client.query(('DO $$' + hqAiVerification.split('DO $$')[1]).replaceAll('hon_runtime', runtimeRoleName));

  // HQ-1 platform overview exact verification: the only permitted runtime
  // capability is its selector-free fixed function. This assertion rejects
  // broad EXECUTE, direct HQ/directory source access, caller GUC authority,
  // and any non-read-only definition drift.
  const hqOverviewCanonical = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
  const hqOverviewVerification = hqOverviewCanonical.split('-- HQ-1 platform overview exact verification:')[1]?.split('-- End HQ-1 platform overview exact verification.')[0];
  if (!hqOverviewVerification) throw new Error('Missing canonical HQ-1 platform overview verification block.');
  await client.query(('DO $$' + hqOverviewVerification.split('DO $$')[1]).replaceAll('hon_runtime', runtimeRoleName));

  // HQ School Management must stay a separate selector-free function-only
  // boundary: no source-table grant, client execution, caller GUC authority,
  // grant option, or unreviewed response-shape drift is permitted.
  const hqSchoolsCanonical = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
  const hqSchoolsVerification = hqSchoolsCanonical.split('-- HQ School Management exact verification:')[1]?.split('-- End HQ school directory exact verification.')[0];
  if (!hqSchoolsVerification) throw new Error('Missing canonical HQ school-directory verification block.');
  await client.query(('DO $$' + hqSchoolsVerification.split('DO $$')[1]).replaceAll('hon_runtime', runtimeRoleName));

  // The conventional runtime tier read is function-only too. Reject raw table
  // and column SELECT (including PUBLIC), grantable/broad EXECUTE, selectors,
  // unsafe ownership/runtime bypass, and active-period/context definition drift.
  const entitlementVerification = hqSchoolsCanonical.split('-- Current organization entitlement exact verification:')[1]?.split('-- End current organization entitlement exact verification.')[0];
  if (!entitlementVerification) throw new Error('Missing canonical current organization entitlement verification block.');
  await client.query(('DO $$' + entitlementVerification.split('DO $$')[1]).replaceAll('hon_runtime', runtimeRoleName));

  const hqEntitlementVerification = hqSchoolsCanonical.split('-- HQ entitlement transition exact verification:')[1]?.split('-- End HQ entitlement transition exact verification.')[0];
  if (!hqEntitlementVerification) throw new Error('Missing canonical HQ entitlement transition verification.');
  await client.query(('DO $$' + hqEntitlementVerification.split('DO $$')[1]).replaceAll('hon_runtime', runtimeRoleName));
  const revenueTables = ['revenue_plans','revenue_plan_versions','revenue_plan_requests'];
  const campaignTables = ['marketing_campaigns','marketing_campaign_versions','marketing_campaign_requests','crm_lead_attributions'];
  const campaignFunctions = [
    ['hon.resolve_campaign_scope(text,text)',true,true],
    ['hon.mutate_campaign(text,text,uuid,jsonb,text,uuid,uuid)',true,true],
    ['hon.read_campaigns(text,text,uuid,text,text,integer)',true,true],
    ['hon.authorize_campaign_lead(text,boolean)',true,true],
    ['hon.guard_campaign_history()',false,false],
    ['hon.validate_campaign_window(text,text,boolean)',false,false],
    ['hon.validate_campaign_input(jsonb,boolean)',false,false],
    ['hon.campaign_summary(uuid)',false,true],
    ['hon.guard_campaign_record()',false,false],
    ['hon.require_campaign_actor(text,text)',false,true],
    ['hon.lock_campaign_actor(text,text)',false,true],
    ['hon.capture_lead_attribution()',false,true],
    ['hon.guard_campaign_evidence_insert()',false,true],
    ['hon.check_campaign_current_version()',false,true],
  ];
  if ((await client.query("SELECT count(*) n FROM pg_policies WHERE schemaname='hon' AND tablename=ANY($1::text[])", [campaignTables])).rows[0].n !== '0') throw new Error('Campaign/source tables require deny-all forced RLS.');
  const campaignAcls = (await client.query(`SELECT c.relname,r.rolsuper OR r.rolbypassrls trusted_owner,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
      OR EXISTS(SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE att.attrelid=c.oid AND att.attnum>0 AND NOT att.attisdropped AND a.grantee<>c.relowner) broad_acl
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='hon' AND c.relname=ANY($1::text[])`, [campaignTables])).rows;
  if (campaignAcls.length !== 4 || campaignAcls.some(r => !r.trusted_owner || r.broad_acl)) throw new Error('Campaign/source table and column ACLs must be trusted-owner-only.');
  for (const [signature,execute,definer] of campaignFunctions) {
    const b = (await client.query(`SELECT p.prosecdef,p.provolatile,p.proconfig,r.rolsuper OR r.rolbypassrls trusted_owner,
      has_function_privilege($2,p.oid,'EXECUTE') runtime_execute,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$2) OR NOT $3::boolean OR a.privilege_type<>'EXECUTE' OR a.is_grantable)) broad_acl
      FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=$1::regprocedure`, [signature,runtimeRoleName,execute])).rows[0];
    if (!b?.trusted_owner || b.runtime_execute !== execute || b.prosecdef !== definer || b.provolatile !== 'v' || b.broad_acl || b.proconfig?.length !== 1 || b.proconfig[0] !== 'search_path=pg_catalog, hon') throw new Error(`Unsafe campaign function ACL/owner/path: ${signature}`);
  }
  for (const {rolname} of (await client.query("SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role')")).rows) {
    for (const table of campaignTables) if ((await client.query("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') allowed", [rolname,`hon.${table}`])).rows[0].allowed) throw new Error(`Forbidden client campaign access: ${rolname}.${table}`);
    for (const [signature] of campaignFunctions) if ((await client.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [rolname,signature])).rows[0].allowed) throw new Error(`Forbidden client campaign function: ${rolname}.${signature}`);
  }
  const formTables = ['public_lead_forms','public_lead_form_versions','public_lead_form_requests','public_lead_form_receipts','public_lead_form_rates'];
  const formFunctions = [
    ['hon.resolve_public_form_scope(text,text)',true,true],
    ['hon.read_public_forms(text)',true,true],
    ['hon.mutate_public_form(text,text,uuid,jsonb,text,uuid,uuid)',true,true],
    ['hon.read_published_form(text)',true,true],
    ['hon.submit_public_form(text,jsonb,text)',true,true],
    ['hon.validate_public_form_config(jsonb)',false,false],
    ['hon.require_public_form_actor(text,text)',false,true],
    ['hon.lock_public_form_actor(text,text)',false,true],
    ['hon.public_form_staff_summary(uuid)',false,true],
    ['hon.validate_public_form_submission(jsonb,jsonb)',false,false],
    ['hon.take_public_form_rate(uuid,text,integer)',false,true],
    ['hon.create_public_form_lead(uuid,uuid,jsonb,uuid)',false,true],
    ['hon.guard_public_form_record()',false,true],
    ['hon.check_public_form_version()',false,true],
  ];
  if ((await client.query("SELECT count(*) n FROM pg_policies WHERE schemaname='hon' AND tablename=ANY($1::text[])", [formTables])).rows[0].n !== '0') throw new Error('Public form tables require deny-all forced RLS.');
  const formAcls = (await client.query(`SELECT c.relname,r.rolsuper OR r.rolbypassrls trusted_owner,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
      OR EXISTS(SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE att.attrelid=c.oid AND att.attnum>0 AND NOT att.attisdropped AND a.grantee<>c.relowner) broad_acl
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='hon' AND c.relname=ANY($1::text[])`, [formTables])).rows;
  if (formAcls.length !== 5 || formAcls.some(r => !r.trusted_owner || r.broad_acl)) throw new Error('Public form table and column ACLs must be trusted-owner-only.');
  for (const [signature,execute,definer] of formFunctions) {
    const b = (await client.query(`SELECT p.prosecdef,p.provolatile,p.proconfig,r.rolsuper OR r.rolbypassrls trusted_owner,
      has_function_privilege($2,p.oid,'EXECUTE') runtime_execute,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$2) OR NOT $3::boolean OR a.privilege_type<>'EXECUTE' OR a.is_grantable)) broad_acl
      FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=$1::regprocedure`, [signature,runtimeRoleName,execute])).rows[0];
    if (!b?.trusted_owner || b.runtime_execute !== execute || b.prosecdef !== definer || b.provolatile !== 'v' || b.broad_acl || b.proconfig?.length !== 1 || b.proconfig[0] !== 'search_path=pg_catalog, hon') throw new Error(`Unsafe public form function ACL/owner/path: ${signature}`);
  }
  for (const {rolname} of (await client.query("SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role')")).rows) {
    for (const table of formTables) if ((await client.query("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') allowed", [rolname,`hon.${table}`])).rows[0].allowed) throw new Error(`Forbidden client public form access: ${rolname}.${table}`);
    for (const [signature] of formFunctions) if ((await client.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [rolname,signature])).rows[0].allowed) throw new Error(`Forbidden client public form function: ${rolname}.${signature}`);
  }
  for (const [table,trigger,signature,deferred] of [
    ['public_lead_forms','public_form_identity_guard','hon.guard_public_form_record()',false],
    ['public_lead_forms','public_form_no_truncate','hon.guard_public_form_record()',false],
    ['public_lead_forms','public_form_current_version','hon.check_public_form_version()',true],
    ['public_lead_form_versions','public_form_version_coherent','hon.check_public_form_version()',false],
    ['public_lead_form_versions','public_form_versions_immutable','hon.guard_campaign_history()',false],
    ['public_lead_form_versions','public_form_versions_no_truncate','hon.guard_campaign_history()',false],
    ['public_lead_form_requests','public_form_requests_immutable','hon.guard_campaign_history()',false],
    ['public_lead_form_requests','public_form_requests_no_truncate','hon.guard_campaign_history()',false],
    ['public_lead_form_receipts','public_form_receipts_no_update','hon.guard_campaign_history()',false],
    ['crm_leads','lead_source_snapshot','hon.capture_lead_attribution()',false],
    ['crm_leads','lead_source_immutable','hon.capture_lead_attribution()',false],
    ['crm_lead_attributions','lead_attributions_immutable','hon.guard_campaign_history()',false],
    ['crm_lead_attributions','lead_attributions_no_truncate','hon.guard_campaign_history()',false],
    ['crm_lead_attributions','lead_attribution_coherent','hon.guard_campaign_evidence_insert()',false],
  ]) {
    if (!(await client.query("SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname=$2 AND tgfoid=$3::regprocedure AND tgenabled='O' AND NOT tgisinternal AND tgdeferrable=$4 AND tginitdeferred=$4) safe",[`hon.${table}`,trigger,signature,deferred])).rows[0].safe) throw new Error(`Unsafe public form provenance trigger: ${trigger}`);
  }
  if (!(await client.query(`SELECT EXISTS(SELECT 1 FROM hon.principals WHERE id='00000000-0000-4000-8000-000000000075' AND principal_type='SYSTEM_SERVICE' AND user_id IS NULL AND is_active)
    AND NOT EXISTS(SELECT 1 FROM hon.principal_role_grants WHERE principal_id='00000000-0000-4000-8000-000000000075')
    AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id='00000000-0000-4000-8000-000000000075')
    AND NOT EXISTS(SELECT 1 FROM hon.family_access_grants WHERE principal_id='00000000-0000-4000-8000-000000000075') safe`)).rows[0].safe) throw new Error('Unsafe public form intake principal');
  const revenueFunctions = [
    ['hon.save_revenue_plan(text,uuid,jsonb,text,uuid,uuid)',true,true],
    ['hon.read_revenue_plan(text,text,uuid,integer)',true,true],
    ['hon.validate_revenue_plan_input(jsonb)',false,false],
    ['hon.guard_revenue_plan()',false,false],
    ['hon.guard_revenue_plan_history()',false,false],
    ['hon.require_revenue_planning_actor(text)',false,true],
    ['hon.lock_revenue_planning_actor(text)',false,true],
    ['hon.revenue_plan_snapshot(uuid)',false,true],
  ];
  if ((await client.query("SELECT count(*) n FROM pg_policies WHERE schemaname='hon' AND tablename=ANY($1::text[])", [revenueTables])).rows[0].n !== '0') throw new Error('Revenue tables require deny-all forced RLS with no policies.');
  // Every table AND column ACL must be owner-only, not just denied to PUBLIC.
  const revenueAcls = (await client.query(`SELECT c.relname,r.rolsuper OR r.rolbypassrls trusted_owner,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
      OR EXISTS(SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a
        WHERE att.attrelid=c.oid AND att.attnum>0 AND NOT att.attisdropped AND a.grantee<>c.relowner) broad_acl
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
    WHERE n.nspname='hon' AND c.relname=ANY($1::text[])`, [revenueTables])).rows;
  if (revenueAcls.length !== 3 || revenueAcls.some(r => !r.trusted_owner || r.broad_acl)) throw new Error('Revenue table/column ACLs must be trusted-owner-only.');
  for (const [signature, execute, definer] of revenueFunctions) {
    const b = (await client.query(`SELECT p.prosecdef,p.provolatile,p.proconfig,r.rolsuper OR r.rolbypassrls trusted_owner,
      has_function_privilege($2,p.oid,'EXECUTE') runtime_execute,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$2) OR NOT $3::boolean OR a.privilege_type<>'EXECUTE' OR a.is_grantable)) broad_acl
      FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=$1::regprocedure`, [signature,runtimeRoleName,execute])).rows[0];
    if (!b?.trusted_owner || b.runtime_execute !== execute || b.prosecdef !== definer || b.provolatile !== 'v' || b.broad_acl || b.proconfig?.length !== 1 || b.proconfig[0] !== 'search_path=pg_catalog, hon') throw new Error(`Unsafe revenue function ACL/owner/path: ${signature}`);
  }
  for (const {rolname} of (await client.query("SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role')")).rows) {
    for (const table of revenueTables) if ((await client.query("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') allowed", [rolname,`hon.${table}`])).rows[0].allowed) throw new Error(`Forbidden client revenue access: ${rolname}.${table}`);
    for (const [signature] of revenueFunctions) if ((await client.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [rolname,signature])).rows[0].allowed) throw new Error(`Forbidden client revenue function: ${rolname}.${signature}`);
  }
  const runtimeRole = (await client.query(`SELECT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = '${runtimeRoleName}'
  ) AS exists`)).rows[0];
  const hqAiTables = expectedRlsTables.filter((table) => table.startsWith('hq_ai_'));
  const hqAiPolicies = (await client.query(`
    SELECT tablename FROM pg_policies
    WHERE schemaname = 'hon' AND tablename = ANY($1::text[])
  `, [hqAiTables])).rows;
  if (hqAiPolicies.length) throw new Error('HQ AI configuration must retain forced deny-all RLS without tenant/GUC policies.');
  if (runtimeRole?.exists) {
    for (const table of curriculumRestrictedTables) {
      const access = (await client.query(`SELECT has_table_privilege('${runtimeRoleName}',$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege('${runtimeRoleName}',$1,'SELECT,INSERT,UPDATE,REFERENCES') allowed`, [`hon.${table}`])).rows[0];
      if (access.allowed) throw new Error(`Forbidden direct runtime curriculum access: ${table}`);
    }
    for (const [table, allowedUpdates] of [
      ['student_curriculum_enrollments', ['current_rank_id', 'version', 'updated_at']],
      ['testing_candidates', ['result', 'instructor_notes', 'version', 'updated_at']],
    ]) {
      if ((await client.query(`SELECT has_table_privilege('${runtimeRoleName}',$1,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege('${runtimeRoleName}',$1,'REFERENCES') allowed`, [`hon.${table}`])).rows[0].allowed) throw new Error(`Forbidden broad testing/enrollment mutation: ${table}`);
      const columns = (await client.query(`SELECT attname,has_column_privilege('${runtimeRoleName}',attrelid,attnum,'UPDATE') allowed
        FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`, [`hon.${table}`])).rows;
      if (!columns.length || columns.some(c => c.allowed !== allowedUpdates.includes(c.attname)) || allowedUpdates.some(c => !columns.some(row => row.attname === c))) throw new Error(`Incorrect exact curriculum/testing UPDATE column grants: ${table}`);
    }
    const enrollmentAccess = (await client.query(`SELECT has_table_privilege('${runtimeRoleName}','hon.student_curriculum_enrollments','SELECT') read,has_table_privilege('${runtimeRoleName}','hon.student_curriculum_enrollments','INSERT') OR has_any_column_privilege('${runtimeRoleName}','hon.student_curriculum_enrollments','INSERT') insert_allowed`)).rows[0];
    if (!enrollmentAccess.read || enrollmentAccess.insert_allowed) throw new Error('Enrollment runtime requires SELECT, exact evidenced UPDATE columns, no INSERT.');
    for (const [signature, shouldExecute, shouldDefine] of curriculumFunctions) {
      const boundary = (await client.query(`SELECT p.prosecdef,p.proconfig,r.rolsuper OR r.rolbypassrls trusted_owner,
        has_function_privilege('${runtimeRoleName}',p.oid,'EXECUTE') execute,
        EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantee NOT IN(p.proowner,(SELECT oid FROM pg_roles WHERE rolname='${runtimeRoleName}'))) broad_acl
        FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=$1::regprocedure`, [signature])).rows[0];
      if (!boundary?.trusted_owner || boundary.prosecdef !== shouldDefine || boundary.execute !== shouldExecute || boundary.broad_acl
        || boundary.proconfig?.length !== 1 || boundary.proconfig[0] !== 'search_path=pg_catalog, hon') throw new Error(`Unsafe curriculum/testing authorization or private-helper boundary: ${signature}`);
    }
    const summaryBoundary = (await client.query(`
      SELECT p.prosecdef, p.provolatile, p.proconfig, r.rolsuper, r.rolbypassrls,
        has_function_privilege('${runtimeRoleName}', p.oid, 'EXECUTE') AS execute,
        EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
          WHERE acl.grantee NOT IN (p.proowner, (SELECT oid FROM pg_roles WHERE rolname = '${runtimeRoleName}'))) AS broad_acl
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = 'hon.read_organization_operations_summary(text,uuid,timestamptz,timestamptz)'::regprocedure
    `)).rows[0];
    if (!summaryBoundary?.execute || !summaryBoundary.prosecdef || summaryBoundary.provolatile !== 's'
      || summaryBoundary.broad_acl || summaryBoundary.proconfig?.length !== 1
      || !summaryBoundary.proconfig.includes('search_path=pg_catalog, hon')
      || !(summaryBoundary.rolsuper || summaryBoundary.rolbypassrls)) {
      throw new Error('Unsafe organization operations summary projection boundary.');
    }
    const healthScoreBoundary = (await client.query(`
      SELECT p.prosecdef, p.provolatile, p.proconfig, r.rolsuper, r.rolbypassrls,
        has_function_privilege('${runtimeRoleName}', p.oid, 'EXECUTE') AS execute,
        EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
          WHERE acl.grantee NOT IN (p.proowner, (SELECT oid FROM pg_roles WHERE rolname = '${runtimeRoleName}'))) AS broad_acl,
        position('current_setting' IN pg_get_functiondef(p.oid)) = 0 AS no_caller_guc_authority
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = 'hon.read_school_health_score(text,uuid,uuid)'::regprocedure
    `)).rows[0];
    if (!healthScoreBoundary?.execute || !healthScoreBoundary.prosecdef || healthScoreBoundary.provolatile !== 's'
      || healthScoreBoundary.broad_acl || !healthScoreBoundary.no_caller_guc_authority
      || healthScoreBoundary.proconfig?.length !== 1 || !healthScoreBoundary.proconfig.includes('search_path=pg_catalog, hon')
      || !(healthScoreBoundary.rolsuper || healthScoreBoundary.rolbypassrls)) {
      throw new Error('Unsafe School Health Score projection boundary.');
    }
    for (const [signature, shouldExecute] of [
      ['hon.search_school(text,uuid,uuid,text,text[],uuid)', true],
      ['hon.resolve_lead_import_scope(text,text)', true],
      ['hon.mutate_lead_import(text,text,uuid,jsonb,text,uuid,uuid)', true],
      ['hon.read_lead_import(text,text,uuid,uuid)', true],
      ['hon.require_lead_import_actor(text,text)', false],
      ['hon.lead_import_summary(uuid)', false],
      ['hon.validate_lead_import_row(jsonb,jsonb,jsonb)', false],
      ['hon.apply_imported_lead(uuid,integer,uuid,uuid,uuid)', false],
      ['hon.guard_lead_import_evidence()', false],
      ['hon.mutate_document(text,text,text,uuid,jsonb,text,uuid,uuid)', true],
      ['hon.read_documents(text,text,text,uuid,integer)', true],
      ['hon.guard_document_immutability()', false],
      ['hon.require_document_actor(text,text,text,uuid,boolean)', false],
      ['hon.document_family_authorized(text,uuid,boolean)', false],
      ['hon.mutate_staff_role(text,text,uuid,jsonb,text,uuid,uuid)', true],
      ['hon.read_staff_role(text,text,uuid)', true],
      ['hon.resolve_staff_role_target(uuid,text,uuid)', false],
      ['hon.guard_staff_custom_role_recipients()', false],
    ]) {
      const boundary = (await client.query(`SELECT p.prosecdef,p.proconfig,r.rolsuper,r.rolbypassrls,
        has_function_privilege('${runtimeRoleName}',p.oid,'EXECUTE') AS execute,
        EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
          WHERE acl.grantee NOT IN(p.proowner,(SELECT oid FROM pg_roles WHERE rolname='${runtimeRoleName}'))) AS broad_acl
        FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=$1::regprocedure`, [signature])).rows[0];
      if (!boundary?.prosecdef || !(boundary.rolsuper || boundary.rolbypassrls) || boundary.execute !== shouldExecute || boundary.broad_acl
        || boundary.proconfig?.length !== 1 || boundary.proconfig[0] !== 'search_path=pg_catalog, hon') {
        throw new Error(`Unsafe staff IAM boundary: ${signature}`);
      }
    }
    for (const table of ['users', 'principals', 'roles', 'permissions', 'role_permissions', 'principal_role_grants',
      ...documentTables, ...importTables, ...revenueTables, 'family_access_grants', 'organizations', 'schools', 'organization_entitlements', 'hq_operator_grants', 'hq_onboarding_requests', 'crm_activities']) {
      if ((await client.query(`SELECT has_table_privilege('${runtimeRoleName}',$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege('${runtimeRoleName}',$1,'SELECT,INSERT,UPDATE,REFERENCES') AS allowed`, [`hon.${table}`])).rows[0].allowed) {
        throw new Error(`Forbidden runtime directory/control-plane/activity privilege: hon.${table}`);
      }
    }
    for (const table of hqAiTables) {
      const access = (await client.query(`
        SELECT has_table_privilege('${runtimeRoleName}', $1, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed
      `, [`hon.${table}`])).rows[0];
      if (access?.allowed) throw new Error(`hon_runtime has forbidden direct HQ AI privileges on ${table}.`);
    }
    const planAccess = (await client.query(`SELECT has_table_privilege('${runtimeRoleName}','hon.ai_invocation_plans','SELECT') AS read,has_table_privilege('${runtimeRoleName}','hon.ai_invocation_plans','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS mutate`)).rows[0];
    if (!planAccess.read || planAccess.mutate) throw new Error('Invocation plans require exact SELECT-only runtime access.');
    for (const signature of ['hon.plan_ai_invocation(uuid,jsonb,uuid,uuid,uuid)', 'hon.require_ai_invocation_plan_access()']) {
      const f = (await client.query(`SELECT p.prosecdef,p.proconfig,r.rolsuper,r.rolbypassrls,has_function_privilege('${runtimeRoleName}',p.oid,'EXECUTE') AS execute FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=$1::regprocedure`, [signature])).rows[0];
      if (!f?.execute || !f.prosecdef || !f.proconfig?.includes('search_path=pg_catalog, hon') || !(f.rolsuper || f.rolbypassrls)) throw new Error(`Unsafe planning boundary: ${signature}`);
    }
    for (const signature of ['hon.validate_ai_invocation_plan_input(jsonb)','hon.ai_invocation_plan_summary(uuid)','hon.reject_ai_invocation_plan_mutation()']) {
      if ((await client.query(`SELECT has_function_privilege('${runtimeRoleName}',$1,'EXECUTE') AS allowed`, [signature])).rows[0].allowed) throw new Error(`Forbidden runtime planning helper: ${signature}`);
    }
    const runtimeLedgerPrivileges = (await client.query(`
      SELECT
        has_table_privilege('${runtimeRoleName}', 'hon.ai_usage_ledger', 'SELECT') AS can_select,
        has_table_privilege('${runtimeRoleName}', 'hon.ai_usage_ledger', 'INSERT') AS can_insert,
        has_table_privilege('${runtimeRoleName}', 'hon.ai_usage_ledger', 'UPDATE') AS can_update,
        has_table_privilege('${runtimeRoleName}', 'hon.ai_usage_ledger', 'DELETE') AS can_delete
    `)).rows[0];
    if (!runtimeLedgerPrivileges?.can_select
      || runtimeLedgerPrivileges.can_insert
      || runtimeLedgerPrivileges.can_update
      || runtimeLedgerPrivileges.can_delete) {
      throw new Error('hon_runtime AI usage ledger privileges are not the required SELECT-only minimum.');
    }

    const runtimeCrmAppointmentPrivileges = (await client.query(`
      SELECT
        has_table_privilege('${runtimeRoleName}', 'hon.crm_appointments', 'SELECT') AS can_select,
        has_table_privilege('${runtimeRoleName}', 'hon.crm_appointments', 'INSERT') AS can_insert,
        has_table_privilege('${runtimeRoleName}', 'hon.crm_appointments', 'UPDATE') AS can_update,
        has_table_privilege('${runtimeRoleName}', 'hon.crm_appointments', 'DELETE') AS can_delete,
        has_type_privilege('${runtimeRoleName}', 'hon.crm_appointment_type', 'USAGE') AS type_usage,
        has_type_privilege('${runtimeRoleName}', 'hon.crm_appointment_status', 'USAGE') AS status_usage
    `)).rows[0];
    if (!runtimeCrmAppointmentPrivileges?.can_select
      || !runtimeCrmAppointmentPrivileges.can_insert
      || !runtimeCrmAppointmentPrivileges.can_update
      || runtimeCrmAppointmentPrivileges.can_delete
      || !runtimeCrmAppointmentPrivileges.type_usage
      || !runtimeCrmAppointmentPrivileges.status_usage) {
      throw new Error('hon_runtime CRM appointment privileges are not the required SELECT/INSERT/UPDATE and no-DELETE minimum.');
    }

    const runtimeCommunicationConsentPrivileges = (await client.query(`
      SELECT
        has_table_privilege('${runtimeRoleName}', 'hon.communication_consents', 'SELECT') AS can_select,
        has_table_privilege('${runtimeRoleName}', 'hon.communication_consents', 'INSERT') AS can_insert,
        has_table_privilege('${runtimeRoleName}', 'hon.communication_consents', 'UPDATE') AS can_update,
        has_table_privilege('${runtimeRoleName}', 'hon.communication_consents', 'DELETE') AS can_delete,
        has_type_privilege('${runtimeRoleName}', 'hon.communication_consent_channel', 'USAGE') AS channel_usage,
        has_type_privilege('${runtimeRoleName}', 'hon.communication_consent_status', 'USAGE') AS status_usage,
        has_type_privilege('${runtimeRoleName}', 'hon.communication_consent_source', 'USAGE') AS source_usage
    `)).rows[0];
    if (!runtimeCommunicationConsentPrivileges?.can_select
      || !runtimeCommunicationConsentPrivileges.can_insert
      || !runtimeCommunicationConsentPrivileges.can_update
      || runtimeCommunicationConsentPrivileges.can_delete
      || !runtimeCommunicationConsentPrivileges.channel_usage
      || !runtimeCommunicationConsentPrivileges.status_usage
      || !runtimeCommunicationConsentPrivileges.source_usage) {
      throw new Error('hon_runtime communication consent privileges are not the required SELECT/INSERT/UPDATE, enum-usage, and no-DELETE minimum.');
    }

    const runtimeCommunicationMessagePrivileges = (await client.query(`
      SELECT
        has_table_privilege('${runtimeRoleName}', 'hon.communication_messages', 'SELECT') AS can_select,
        has_table_privilege('${runtimeRoleName}', 'hon.communication_messages', 'INSERT') AS can_insert,
        has_table_privilege('${runtimeRoleName}', 'hon.communication_messages', 'UPDATE') AS can_update,
        has_table_privilege('${runtimeRoleName}', 'hon.communication_messages', 'DELETE') AS can_delete,
        has_type_privilege('${runtimeRoleName}', 'hon.communication_message_channel', 'USAGE') AS channel_usage,
        has_type_privilege('${runtimeRoleName}', 'hon.communication_message_lifecycle', 'USAGE') AS lifecycle_usage
    `)).rows[0];
    if (!runtimeCommunicationMessagePrivileges?.can_select
      || !runtimeCommunicationMessagePrivileges.can_insert
      || !runtimeCommunicationMessagePrivileges.can_update
      || runtimeCommunicationMessagePrivileges.can_delete
      || !runtimeCommunicationMessagePrivileges.channel_usage
      || !runtimeCommunicationMessagePrivileges.lifecycle_usage) {
      throw new Error('hon_runtime communication message privileges are not the required SELECT/INSERT/UPDATE, enum-usage, and no-DELETE minimum.');
    }

    const parentBillingBoundary = (await client.query(`
      SELECT p.prosecdef, p.provolatile, p.proconfig, r.rolsuper OR r.rolbypassrls AS trusted_owner,
        has_function_privilege($1, p.oid, 'EXECUTE') AS execute,
        EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
          WHERE acl.grantee NOT IN(p.proowner, (SELECT oid FROM pg_roles WHERE rolname = $1)) OR acl.is_grantable) AS broad_acl
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = 'hon.read_parent_billing_view(text)'::regprocedure
    `, [runtimeRoleName])).rows[0];
    if (!parentBillingBoundary?.trusted_owner || !parentBillingBoundary.prosecdef || parentBillingBoundary.provolatile !== 'v'
      || !parentBillingBoundary.execute || parentBillingBoundary.broad_acl
      || parentBillingBoundary.proconfig?.length !== 1 || parentBillingBoundary.proconfig[0] !== 'search_path=pg_catalog, hon') {
      throw new Error('Unsafe parent billing fixed read projection boundary.');
    }
    const runtimeOperationsReportingPrivileges = (await client.query(`
      SELECT
        has_table_privilege('${runtimeRoleName}', 'hon.invoices', 'SELECT') AS invoices_can_select,
        has_table_privilege('${runtimeRoleName}', 'hon.invoices', 'INSERT') AS invoices_can_insert,
        has_table_privilege('${runtimeRoleName}', 'hon.invoices', 'UPDATE') AS invoices_can_update,
        has_table_privilege('${runtimeRoleName}', 'hon.invoices', 'DELETE') AS invoices_can_delete,
        has_table_privilege('${runtimeRoleName}', 'hon.payment_attempts', 'SELECT') AS payments_can_select,
        has_table_privilege('${runtimeRoleName}', 'hon.payment_attempts', 'INSERT') AS payments_can_insert,
        has_table_privilege('${runtimeRoleName}', 'hon.payment_attempts', 'UPDATE') AS payments_can_update,
        has_table_privilege('${runtimeRoleName}', 'hon.payment_attempts', 'DELETE') AS payments_can_delete
    `)).rows[0];
    if (!runtimeOperationsReportingPrivileges?.invoices_can_select
      || !runtimeOperationsReportingPrivileges.invoices_can_insert
      || !runtimeOperationsReportingPrivileges.invoices_can_update
      || runtimeOperationsReportingPrivileges.invoices_can_delete
      || !runtimeOperationsReportingPrivileges.payments_can_select
      || runtimeOperationsReportingPrivileges.payments_can_insert
      || runtimeOperationsReportingPrivileges.payments_can_update
      || runtimeOperationsReportingPrivileges.payments_can_delete) {
      throw new Error('hon_runtime billing privileges are not exact invoice SELECT/INSERT/UPDATE and payment SELECT-only minima.');
    }

    const runtimeMembershipPrivileges = (await client.query(`
      SELECT
        has_table_privilege('${runtimeRoleName}', 'hon.memberships', 'SELECT') AS can_select,
        has_table_privilege('${runtimeRoleName}', 'hon.memberships', 'INSERT') AS can_insert,
        has_table_privilege('${runtimeRoleName}', 'hon.memberships', 'UPDATE') AS can_update,
        has_table_privilege('${runtimeRoleName}', 'hon.memberships', 'DELETE') AS can_delete
    `)).rows[0];
    if (!runtimeMembershipPrivileges?.can_select
      || !runtimeMembershipPrivileges.can_insert
      || !runtimeMembershipPrivileges.can_update
      || runtimeMembershipPrivileges.can_delete) {
      throw new Error('hon_runtime membership privileges are not the required SELECT/INSERT/UPDATE and no-DELETE minimum.');
    }

    const runtimeAiTeamPreferencesPrivileges = (await client.query(`
      SELECT
        has_table_privilege('${runtimeRoleName}', 'hon.ai_team_presentation_preferences', 'SELECT') AS can_select,
        has_table_privilege('${runtimeRoleName}', 'hon.ai_team_presentation_preferences', 'INSERT') AS can_insert,
        has_table_privilege('${runtimeRoleName}', 'hon.ai_team_presentation_preferences', 'UPDATE') AS can_update,
        has_table_privilege('${runtimeRoleName}', 'hon.ai_team_presentation_preferences', 'DELETE') AS can_delete
    `)).rows[0];
    if (!runtimeAiTeamPreferencesPrivileges?.can_select
      || !runtimeAiTeamPreferencesPrivileges.can_insert
      || !runtimeAiTeamPreferencesPrivileges.can_update
      || runtimeAiTeamPreferencesPrivileges.can_delete) {
      throw new Error('hon_runtime AI Team presentation preferences privileges are not the required SELECT/INSERT/UPDATE and no-DELETE minimum.');
    }
  }

  await verifyCrmLeadCloseSecurity(client, runtimeRoleName);
  const context = await client.query("SELECT hon.current_organization_id() AS organization_id, hon.current_school_id() AS school_id");
  if (context.rows[0].organization_id !== null || context.rows[0].school_id !== null) {
    throw new Error('Connection began with unexpected residual tenant context.');
  }
  console.log(`Verified forced RLS on all ${expectedRlsTables.length} tracked HON operational tables, append-only audit/outbox policies, work-item, immutable decision-only AI plans and AI ledger tenant isolation, exact CRM appointment and communications consent/message command grants, invoice and membership SELECT/INSERT/UPDATE plus payment and AI-ledger SELECT-only reporting access, fixed read-only operations summary definer/ACL and forbidden runtime directory/HQ/activity grants, curriculum deny-all history/private access, exact enrollment/grading UPDATE columns and callable authorization/lock boundaries with denied PUBLIC/client/guard/evidence helpers, revenue owner-only tables and exact function-only runtime ACLs/private helpers, and cleared connection context.`);
} finally {
  await client.end();
}
