import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
const read = async (path) => readFile(new URL(path, import.meta.url), 'utf8');
const sql = await read('../migrations/0142_staff_reporting_schools.sql');
const body = sql.split('AS $$')[1]?.split('$$;')[0];

test('additive bounded subject-only selector seals pure identity and all-live-scope eligibility', async () => {
  assert.equal((await readdir(new URL('../migrations/', import.meta.url))).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort().at(-1), '0142_staff_reporting_schools.sql');
  assert.match(sql, /CREATE FUNCTION hon\.read_staff_reporting_schools\(p_subject text\)/);
  assert.match(sql, /RETURNS TABLE \(organization_id uuid, school_id uuid, organization_name text, school_name text\)/);
  assert.match(sql, /STABLE\s+SECURITY DEFINER\s+SET search_path = pg_catalog, hon/);
  for (const required of ["principal.principal_type = 'HUMAN_USER' AND principal.is_active", 'app_user.external_subject = p_subject', 'WHERE other.user_id = app_user.id AND other.is_active) = 1', 'hon.hq_operator_grants', 'hon.family_access_grants', 'mixed.revoked_at IS NULL', "'^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'", 'hon.staff_member_eligible', "permission.code = 'reporting.view' AND permission.is_staff_assignable", "school.status = 'ACTIVE'", "organization.status = 'ACTIVE'", 'role.management_school_id = scope.school_id', 'role_grant.revoked_at IS NULL', 'role_grant.effective_from <= statement_timestamp()', 'role_grant.effective_until > statement_timestamp()', 'FROM current_scopes) BETWEEN 2 AND 20', 'FROM candidates) = (SELECT count(*) FROM current_scopes)', 'organization.display_name', 'school.name', 'LIMIT 20']) assert(body.includes(required), required);
  assert.doesNotMatch(body, /INSERT|UPDATE|DELETE|EXECUTE|current_setting|set_config|resolve_owner_launch|resolve_parent|resolve_hq/i);
  assert.doesNotMatch(sql, /CREATE TABLE|CREATE POLICY|GRANT .*ON TABLE|ALTER TABLE|CREATE OR REPLACE/);
  assert.match(sql, /REVOKE ALL ON FUNCTION hon\.read_staff_reporting_schools\(text\) FROM PUBLIC/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION hon\.read_staff_reporting_schools\(text\) TO hon_runtime/);
});

test('canonical/JS verification seals exact signature/body, ACL, role restrictions and forced RLS', async () => {
  const canonical = await read('../../../infra/postgres/011_verify_supabase_hon_runtime.sql');
  const block = canonical.split('-- Staff reporting schools exact verification:')[1]?.split('-- End staff reporting schools exact verification.')[0];
  assert(block);
  for (const required of ['hon.read_staff_reporting_schools(text)', 'p.prosecdef', 'p.proargmodes', 'p.proallargtypes', 'p.proretset', "language.lanname = 'sql'", 'acl.is_grantable', 'acl.grantor', 'other.proname = p.proname', 'relrowsecurity AND relforcerowsecurity', 'has_any_column_privilege', 'pg_auth_members', 'rolinherit']) assert(block.includes(required), required);
  assert(block.includes(createHash('md5').update(body).digest('hex')));
  assert.match(await read('./verify-rls.mjs'), /await verifyStaffReportingSchoolsSecurity\(client, runtimeRoleName\)/);
});

test('selector is dashboard-only and school choice has no browser/server persistence or authority', async () => {
  const dashboard = await read('../../../apps/web/src/components/staff-dashboard.tsx');
  const transport = await read('../../../apps/web/src/components/staff-reporting-schools-http.ts');
  assert.match(dashboard, /selectorRead\.current \?\?= loadStaffReportingSchools\(\)/);
  assert.match(dashboard, /schoolChoices\.find\(\(school\) => school\.schoolId === schoolChoiceId\)/);
  assert.match(dashboard, /readDashboard\(choice\.organizationId, choice\.schoolId, requestGeneration\)/);
  assert.match(dashboard, /readDashboard\(scope\.organizationId, scope\.schoolId, requestGeneration\)/);
  assert.match(dashboard, /setSchoolChoiceId\(''\)/);
  assert.match(dashboard, /value="">Choose a school/);
  assert.match(dashboard, /Use manual known-ID entry/);
  assert.doesNotMatch(dashboard + transport, /localStorage|sessionStorage|indexedDB|document\.cookie|saveSchoolPreference|selectedSchoolPreference/);
  assert.match(transport, /cache: 'no-store'/); assert.match(transport, /redirect: 'error'/);
  const components = await readdir(new URL('../../../apps/web/src/components/', import.meta.url));
  for (const file of components.filter((file) => /\.tsx?$/.test(file) && !['staff-dashboard.tsx', 'staff-reporting-schools-http.ts'].includes(file))) assert.doesNotMatch(await read(`../../../apps/web/src/components/${file}`), /loadStaffReportingSchools/, file);
});
