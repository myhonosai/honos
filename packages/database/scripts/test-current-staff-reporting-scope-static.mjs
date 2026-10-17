import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';

const read = async (path) => readFile(new URL(path, import.meta.url), 'utf8');
const sql = await read('../migrations/0141_current_staff_reporting_scope.sql');
const body = sql.split('AS $$')[1]?.split('$$;')[0];

test('latest additive migration seals a fixed subject-only exact-one staff reporting resolver', async () => {
  const migrations = (await readdir(new URL('../migrations/', import.meta.url))).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
  assert(migrations.includes('0141_current_staff_reporting_scope.sql'));
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.match(sql, /CREATE FUNCTION hon\.resolve_current_staff_reporting_scope\(p_subject text\)/);
  assert.match(sql, /RETURNS TABLE \(organization_id uuid, school_id uuid\)/);
  assert.match(sql, /STABLE\s+SECURITY DEFINER\s+SET search_path = pg_catalog, hon/);
  assert.match(body, /app_user\.external_subject = p_subject/);
  assert.match(body, /principal\.principal_type = 'HUMAN_USER' AND principal\.is_active/);
  assert.match(body, /WHERE other\.user_id = app_user\.id AND other\.is_active\) = 1/);
  assert.match(body, /FROM current_scopes\) = 1/);
  assert.match(body, /FROM candidates\) = 1/);
  assert.match(body, /hon\.staff_member_eligible/);
  assert.match(body, /permission\.code = 'reporting\.view' AND permission\.is_staff_assignable/);
  for (const required of ['role_grant.revoked_at IS NULL', 'role_grant.effective_from <= statement_timestamp()', 'role_grant.effective_until > statement_timestamp()', "school.status = 'ACTIVE'", "organization.status = 'ACTIVE'", 'role.management_school_id = school.id', 'hon.hq_operator_grants', 'hon.family_access_grants', "'^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'"]) assert(body.includes(required), required);
  assert.doesNotMatch(body, /LIMIT\s+1|ORDER BY|resolve_owner_launch|resolve_hq|resolve_parent|INSERT|UPDATE|DELETE|EXECUTE|current_setting/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION hon\.resolve_current_staff_reporting_scope\(text\) FROM PUBLIC/);
  assert.match(sql, /'hon_runtime', 'anon', 'authenticated', 'service_role'/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION hon\.resolve_current_staff_reporting_scope\(text\) TO hon_runtime/);
  assert.doesNotMatch(sql, /GRANT .*ON TABLE|DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY|ALTER ROLE|CREATE POLICY|CREATE TABLE/);
});

test('canonical and JS verifiers track exact signature, trusted ownership, ACL and forced RLS', async () => {
  const canonical = await read('../../../infra/postgres/011_verify_supabase_hon_runtime.sql');
  const block = canonical.split('-- Current staff reporting scope exact verification:')[1]?.split('-- End current staff reporting scope exact verification.')[0];
  assert(block);
  for (const fragment of ['hon.resolve_current_staff_reporting_scope(text)', 'p.prosecdef', "p.provolatile = 's'", 'p.proconfig', 'owner_role.rolsuper OR owner_role.rolbypassrls', 'acl.is_grantable', 'other.proname = p.proname', 'relrowsecurity AND relforcerowsecurity']) assert(block.includes(fragment), fragment);
  assert.match(await read('./verify-rls.mjs'), /await verifyCurrentStaffReportingScopeSecurity\(client, runtimeRoleName\)/);
});

test('only dashboard uses current-scope transport and does not persist a selected-school preference', async () => {
  const dashboard = await read('../../../apps/web/src/components/staff-dashboard.tsx');
  const transport = await read('../../../apps/web/src/components/current-staff-reporting-school-http.ts');
  assert.match(dashboard, /resolverRead\.current \?\?= loadCurrentStaffReportingSchool\(\)/);
  assert.match(dashboard, /scope\.state === 'MANUAL_ENTRY_REQUIRED'/);
  assert.match(dashboard, /readDashboard\(scope\.organizationId, scope\.schoolId, requestGeneration\)/);
  assert.match(dashboard, /next\.organizationId !== requestedOrganizationId/);
  assert.match(dashboard, /next\.schoolId !== requestedSchoolId/);
  assert.doesNotMatch(dashboard + transport, /localStorage|sessionStorage|indexedDB|document\.cookie|selectedSchoolPreference|saveSchoolPreference/);
  assert.match(transport, /redirect: 'error'/);
  assert.match(transport, /cache: 'no-store'/);
  assert.match(transport, /record\(value, \['data'\]\)/);
  assert.match(transport, /record\(data, \['state'\]\)/);
  const components = await readdir(new URL('../../../apps/web/src/components/', import.meta.url));
  for (const file of components.filter((file) => /\.tsx?$/.test(file) && !['staff-dashboard.tsx', 'current-staff-reporting-school-http.ts'].includes(file))) {
    assert.doesNotMatch(await read(`../../../apps/web/src/components/${file}`), /loadCurrentStaffReportingSchool/, file);
  }
});
