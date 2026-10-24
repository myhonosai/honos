import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import pg from 'pg';
import { verifyCurrentStaffReportingScopeSecurity } from './current-staff-reporting-scope-security.mjs';
import { verifyStaffReportingSchoolsSecurity } from './staff-reporting-schools-security.mjs';

// Required explicit scratch location; NEVER read DATABASE_URL or runtime URLs.
// A fresh cluster has no TCP listener, uses its own Unix socket, and is stopped
// after proof. No existing database is touched, deleted, dropped or truncated.
const scratch = process.argv[2];
if (!scratch || !isAbsolute(scratch) || !/^\/home\/ubuntu\/jobs\/job_[A-Za-z0-9]+$/.test(scratch)) {
  throw new Error('Pass an explicit /home/ubuntu/jobs/job_<id> scratch directory for this local-only proof.');
}
const root = await mkdtemp(join(scratch, 'staff-reporting-'));
const data = join(root, 'data');
const socket = join(root, 'socket');
const bin = '/usr/lib/postgresql/16/bin';
await mkdir(socket);
execFileSync(join(bin, 'initdb'), ['-D', data, '--auth=trust', '--no-locale', '--encoding=UTF8'], { stdio: 'pipe' });
let started = false;
let client;
let proofs = 0;
try {
  execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-l', join(root, 'postgres.log'), '-o', `-F -k ${socket} -p 6543 -c listen_addresses=''`, '-w', 'start'], { stdio: 'pipe' });
  started = true;
  client = new pg.Client({ host: socket, port: 6543, database: 'postgres', user: 'ubuntu' });
  await client.connect();
  await client.query('CREATE ROLE hon_runtime NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION');
  for (const role of ['anon', 'authenticated', 'service_role']) await client.query(`CREATE ROLE ${role} NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS`);
  await client.query('CREATE ROLE unexpected_client NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS');
  const directory = new URL('../migrations/', import.meta.url);
  const migrations = (await readdir(directory)).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
  for (const file of migrations) {
    if (file === '0142_staff_reporting_schools.sql') await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA hon GRANT EXECUTE ON FUNCTIONS TO unexpected_client');
    await client.query(await readFile(new URL(file, directory), 'utf8'));
  }
  console.log(`Applied ${migrations.length} actual migrations in fresh socket-only cluster: ${root}`);
  await client.query('GRANT USAGE ON SCHEMA hon TO hon_runtime');
  await verifyCurrentStaffReportingScopeSecurity(client);
  proofs++;
  await verifyStaffReportingSchoolsSecurity(client); proofs++;

  const organizationId = randomUUID();
  const schools = [randomUUID(), randomUUID()];
  await client.query('INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$2,$2)', [organizationId, 'Local proof']);
  // 0172: the default scope also requires the organization's entitlement to be ACTIVE and in effect.
  await client.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',statement_timestamp()-interval '1 day')", [organizationId]);
  for (let index = 0; index < schools.length; index++) await client.query('INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,$3,$3)', [schools[index], organizationId, `school-${index}`]);
  const roles = new Map();
  async function role(code, permissions = ['reporting.view'], managementSchool = null) {
    const key = `${code}:${permissions}:${managementSchool}`;
    if (roles.has(key)) return roles.get(key);
    const id = randomUUID();
    await client.query('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role,management_school_id) VALUES($1,$2,$3,$3,$4,$5)', [id, organizationId, code, code === 'OWNER', managementSchool]);
    for (const permission of permissions) await client.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [id, organizationId, permission]);
    roles.set(key, id); return id;
  }
  async function identity(subject, active = true) {
    const userId = randomUUID(); const principalId = randomUUID();
    await client.query('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$2)', [userId, subject, `${subject.replace(/[^a-z0-9]/gi, '-')}@example.invalid`]);
    await client.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER',$3,$4)", [principalId, userId, subject, active]);
    return { userId, principalId };
  }
  async function grant(principalId, roleId, schoolId = schools[0], timing = {}) {
    await client.query(`INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from,effective_until,revoked_at,revoked_by_principal_id)
      VALUES($1,$2,$3,$4,$3,statement_timestamp()+$5::interval,CASE WHEN $6::text IS NULL THEN NULL ELSE statement_timestamp()+$6::interval END,CASE WHEN $7 THEN statement_timestamp() ELSE NULL END,CASE WHEN $7 THEN $3::uuid ELSE NULL END)`, [organizationId, schoolId, principalId, roleId, timing.from ?? '-1 hour', timing.until ?? null, timing.revoked ?? false]);
  }
  async function expectScope(subject, expected = [], choices = []) {
    await client.query('SET ROLE hon_runtime');
    try {
      const result = await client.query('SELECT * FROM hon.resolve_current_staff_reporting_scope($1)', [subject]);
      assert.deepEqual(result.rows, expected, subject); proofs++;
      const selector = await client.query('SELECT * FROM hon.read_staff_reporting_schools($1)', [subject]);
      assert.deepEqual(selector.rows, choices, `${subject} selector`); proofs++;
    } finally { await client.query('RESET ROLE'); }
  }
  async function expectChoices(subject, expected = []) {
    await client.query('BEGIN READ ONLY');
    try {
      await client.query('SET LOCAL ROLE hon_runtime');
      const result = await client.query('SELECT * FROM hon.read_staff_reporting_schools($1)', [subject]);
      assert.deepEqual(result.rows, expected, `${subject} read-only selector`); proofs++;
    } finally { await client.query('ROLLBACK'); }
  }
  const scope = [{ organization_id: organizationId, school_id: schools[0] }];
  const twoChoices = schools.map((school, index) => ({ organization_id: organizationId, school_id: school, organization_name: 'Local proof', school_name: `school-${index}` }));
  const staffRole = await role('CUSTOM_REPORT_READER');
  const ownerRole = await role('OWNER');
  const noReportRole = await role('CUSTOM_NO_REPORT', ['school.view']);
  for (const [subject, roleId] of [['single-staff', staffRole], ['single-owner', ownerRole]]) {
    const person = await identity(subject); await grant(person.principalId, roleId); await expectScope(subject, scope);
    // Multiple compatible roles/grants at the same school are one candidate.
    await grant(person.principalId, noReportRole); await expectScope(subject, scope);
  }
  // A SUSPENDED entitlement resolves no default scope; restoring it resolves the same scope again.
  const setEntitlement = async (status) => {
    await client.query('ALTER TABLE hon.organization_entitlements DISABLE TRIGGER USER');
    try { await client.query('UPDATE hon.organization_entitlements SET status=$2 WHERE organization_id=$1', [organizationId, status]); }
    finally { await client.query('ALTER TABLE hon.organization_entitlements ENABLE TRIGGER USER'); }
  };
  await client.query('SET ROLE hon_runtime');
  try { assert.equal((await client.query('SELECT * FROM hon.resolve_current_staff_reporting_scope($1)', ['single-staff'])).rows.length, 1); } finally { await client.query('RESET ROLE'); }
  await setEntitlement('SUSPENDED');
  await client.query('SET ROLE hon_runtime');
  try { assert.deepEqual((await client.query('SELECT * FROM hon.resolve_current_staff_reporting_scope($1)', ['single-staff'])).rows, [], 'suspended entitlement'); proofs++; }
  finally { await client.query('RESET ROLE'); }
  await setEntitlement('ACTIVE');
  await expectScope('unknown-subject');
  await expectScope(null);
  for (const [subject, options] of [['zero', { none: true }], ['unauthorized', { noReport: true }], ['inactive-human', { active: false }], ['revoked', { revoked: true }], ['expired', { until: '-1 minute', from: '-2 hours' }], ['future', { from: '1 hour' }]]) {
    const person = await identity(subject, options.active ?? true);
    if (!options.none) await grant(person.principalId, options.noReport ? noReportRole : staffRole, schools[0], options);
    if (options.noReport || options.active === false) await grant(person.principalId, options.noReport ? noReportRole : staffRole, schools[1], options);
    await expectScope(subject);
  }
  // OWNER naming alone is never authority; give a distinct no-report owner role.
  const ownerWithoutReporting = await role('OWNER_WITHOUT_REPORTING', ['school.view']);
  const owner = await identity('owner-without-reporting'); await grant(owner.principalId, ownerWithoutReporting); await expectScope('owner-without-reporting');
  for (const secondRole of [staffRole, noReportRole]) {
    const subject = secondRole === staffRole ? 'multiple-reporting-schools' : 'second-nonreporting-school';
    const person = await identity(subject); await grant(person.principalId, staffRole); await grant(person.principalId, secondRole, schools[1]);
    await expectScope(subject, [], secondRole === staffRole ? twoChoices : []);
  }
  const multi = await identity('multiple-principals'); await grant(multi.principalId, staffRole);
  await grant(multi.principalId, staffRole, schools[1]);
  await client.query("INSERT INTO hon.principals(user_id,principal_type,display_name) VALUES($1,'HUMAN_USER','second')", [multi.userId]);
  await expectScope('multiple-principals');
  for (const code of ['PARENT', 'GUARDIAN', 'STUDENT', 'FAMILY', 'HQ', 'HON_HQ_OWNER', 'PLATFORM', 'SYSTEM']) {
    const mixedRole = await role(code);
    for (const mixed of [false, true]) {
      const subject = `${code}-${mixed ? 'mixed' : 'only'}`;
      const person = await identity(subject); await grant(person.principalId, mixedRole);
      if (mixed) { await grant(person.principalId, staffRole); await grant(person.principalId, staffRole, schools[1]); }
      await expectScope(subject);
    }
  }
  for (const expired of [false, true]) {
    const subject = expired ? 'staff-expired-hq' : 'staff-live-hq';
    const person = await identity(subject); await grant(person.principalId, staffRole);
    await grant(person.principalId, staffRole, schools[1]);
    await client.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,effective_from,effective_until) VALUES($1,'HON_HQ_OPERATOR',statement_timestamp()-interval '2 hours',CASE WHEN $2 THEN statement_timestamp()-interval '1 hour' ELSE NULL END)", [person.principalId, expired]);
    await expectScope(subject);
  }
  const familyPerson = await identity('staff-family'); await grant(familyPerson.principalId, staffRole);
  await grant(familyPerson.principalId, staffRole, schools[1]);
  const familyId = randomUUID();
  await client.query('INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,$4)', [familyId, organizationId, schools[0], 'Local family']);
  await client.query("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id) VALUES($1,$2,$3,$4,'PRIMARY_GUARDIAN',$4)", [organizationId, schools[0], familyId, familyPerson.principalId]);
  await expectScope('staff-family');
  const wrongRole = await role('CUSTOM_WRONG_MANAGEMENT_SCOPE', ['reporting.view'], schools[1]);
  const wrong = await identity('wrong-management-school'); await grant(wrong.principalId, wrongRole); await expectScope('wrong-management-school');
  for (const target of ['school', 'organization']) {
    const org = randomUUID(); const school = randomUUID();
    await client.query('INSERT INTO hon.organizations(id,legal_name,display_name,status) VALUES($1,$2,$2,$3)', [org, target, target === 'organization' ? 'SUSPENDED' : 'ACTIVE']);
    await client.query('INSERT INTO hon.schools(id,organization_id,name,slug,status) VALUES($1,$2,$3,$3,$4)', [school, org, target, target === 'school' ? 'SUSPENDED' : 'ACTIVE']);
    const roleId = randomUUID();
    await client.query('INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,$3,$3)', [roleId, org, 'CUSTOM_SUSPENDED']);
    await client.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'reporting.view')", [roleId, org]);
    const person = await identity(`inactive-${target}`);
    await client.query('INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$3)', [org, school, person.principalId, roleId]);
    await expectScope(`inactive-${target}`);
  }

  // List eligibility is all-or-nothing, including a live incompatible scope.
  const incompatible = await identity('second-incompatible-scope');
  await grant(incompatible.principalId, staffRole);
  const managedFirst = await role('CUSTOM_MANAGED_FIRST', ['reporting.view'], schools[0]);
  await grant(incompatible.principalId, managedFirst, schools[1]);
  await expectChoices('second-incompatible-scope');
  const duplicate = await identity('duplicate-grants');
  for (const school of schools) { await grant(duplicate.principalId, staffRole, school); await grant(duplicate.principalId, noReportRole, school); }
  await expectChoices('duplicate-grants', twoChoices);
  await client.query("INSERT INTO hon.principals(user_id,principal_type,display_name,is_active) VALUES($1,'HUMAN_USER','inactive second',false)", [duplicate.userId]);
  await expectChoices('duplicate-grants', twoChoices);
  const otherOrganization = randomUUID(); const otherSchool = randomUUID(); const otherRole = randomUUID();
  await client.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PRIVATE_LEGAL_NAME','Other organization')", [otherOrganization]);
  await client.query("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,'Other school','other-school')", [otherSchool, otherOrganization]);
  await client.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'CUSTOM_OTHER_REPORT','Private role metadata')", [otherRole, otherOrganization]);
  await client.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'reporting.view')", [otherRole, otherOrganization]);
  const crossOrganization = await identity('cross-organization'); await grant(crossOrganization.principalId, staffRole);
  await client.query('INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$3)', [otherOrganization, otherSchool, crossOrganization.principalId, otherRole]);
  await expectChoices('cross-organization', [twoChoices[0], { organization_id: otherOrganization, school_id: otherSchool, organization_name: 'Other organization', school_name: 'Other school' }]);
  await client.query('BEGIN READ ONLY');
  try {
    await client.query('SET LOCAL ROLE hon_runtime');
    await client.query("SELECT set_config('app.hon_principal_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_organization_id',$3,true),set_config('app.hon_external_subject','cross-organization',true)", [crossOrganization.principalId, otherSchool, otherOrganization]);
    assert.deepEqual((await client.query("SELECT * FROM hon.read_staff_reporting_schools('multiple-reporting-schools')")).rows, twoChoices); proofs++;
    assert.deepEqual((await client.query("SELECT * FROM hon.read_staff_reporting_schools('unknown-subject')")).rows, []); proofs++;
  } finally { await client.query('ROLLBACK'); }
  // Offering a choice is not persisted authority: the exact report resolver
  // denies that same school after revocation, without a selector preference.
  const revalidation = await identity('report-revalidation');
  for (const school of schools) await grant(revalidation.principalId, staffRole, school);
  await grant(revalidation.principalId, noReportRole, schools[1]);
  await expectChoices('report-revalidation', twoChoices);
  await client.query('UPDATE hon.principal_role_grants SET revoked_at=statement_timestamp(),revoked_by_principal_id=$1 WHERE principal_id=$1 AND school_id=$2 AND role_id=$3', [revalidation.principalId, schools[1], staffRole]);
  await expectChoices('report-revalidation');
  // Existing 010 runtime-bootstrap grant, not a new selector/table privilege.
  await client.query('GRANT EXECUTE ON FUNCTION hon.resolve_authorized_scope(text,uuid,text) TO hon_runtime');
  await client.query('SET ROLE hon_runtime');
  try { assert.deepEqual((await client.query("SELECT * FROM hon.resolve_authorized_scope('report-revalidation',$1,'reporting.view')", [schools[1]])).rows, []); proofs++; }
  finally { await client.query('RESET ROLE'); }
  const effects = () => client.query('SELECT (SELECT count(*)::int FROM hon.audit_events) audit, (SELECT count(*)::int FROM hon.outbox_events) outbox');
  const beforeEffects = (await effects()).rows;
  await expectChoices('multiple-reporting-schools', twoChoices);
  assert.deepEqual((await effects()).rows, beforeEffects); proofs++;
  // Expired/revoked/future roles are not a live mixed role or live third scope.
  for (const timing of [{ revoked: true }, { from: '-2 hours', until: '-1 minute' }, { from: '1 hour' }]) {
    const person = await identity(`inactive-mixed-${proofs}`);
    for (const school of schools) await grant(person.principalId, staffRole, school);
    await grant(person.principalId, await role('PARENT_INACTIVE', ['school.view']), schools[0], timing);
    await expectChoices(`inactive-mixed-${proofs}`, twoChoices);
  }
  await client.query("UPDATE hon.permissions SET is_staff_assignable=false WHERE code='reporting.view'");
  await expectChoices('multiple-reporting-schools');
  await client.query("UPDATE hon.permissions SET is_staff_assignable=true WHERE code='reporting.view'");
  await expectChoices('multiple-reporting-schools', twoChoices);
  // Unsafe labels must not expose a partial list or synthesize a display name.
  for (const name of ['', 'x'.repeat(121), 'Unsafe\nName', '\u202eSpoof']) {
    await client.query('UPDATE hon.schools SET name=$1 WHERE id=$2', [name, schools[1]]);
    await expectChoices('multiple-reporting-schools');
  }
  await client.query("UPDATE hon.schools SET name='school-1' WHERE id=$1", [schools[1]]);
  // Hard maximum: 20 returns exactly the authorized set; 21 returns no list.
  const bounded = await identity('bounded-schools');
  const boundedChoices = [];
  for (let index = 0; index < 21; index++) {
    const school = randomUUID(); const name = `bounded-${String(index).padStart(2, '0')}`;
    await client.query('INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,$3,$3)', [school, organizationId, name]);
    await grant(bounded.principalId, staffRole, school);
    boundedChoices.push({ organization_id: organizationId, school_id: school, organization_name: 'Local proof', school_name: name });
    if (index === 19) await expectChoices('bounded-schools', boundedChoices);
  }
  await expectChoices('bounded-schools');

  // No data-plane enumeration or public/client invocation was added.
  for (const clientRole of ['anon', 'authenticated', 'service_role']) {
    const access = await client.query("SELECT has_function_privilege($1,'hon.resolve_current_staff_reporting_scope(text)','EXECUTE') allowed", [clientRole]);
    assert.equal(access.rows[0].allowed, false); proofs++;
    const selector = await client.query("SELECT has_function_privilege($1,'hon.read_staff_reporting_schools(text)','EXECUTE') allowed", [clientRole]);
    assert.equal(selector.rows[0].allowed, false); proofs++;
  }
  assert.equal((await client.query("SELECT has_function_privilege('unexpected_client','hon.read_staff_reporting_schools(text)','EXECUTE') allowed")).rows[0].allowed, false); proofs++;
  await client.query('SET ROLE hon_runtime');
  try { await assert.rejects(() => client.query('SELECT * FROM hon.users'), (error) => error.code === '42501'); proofs++; }
  finally { await client.query('RESET ROLE'); }
  for (const drift of ['GRANT EXECUTE ON FUNCTION hon.resolve_current_staff_reporting_scope(text) TO PUBLIC', 'GRANT EXECUTE ON FUNCTION hon.resolve_current_staff_reporting_scope(text) TO hon_runtime WITH GRANT OPTION', 'ALTER FUNCTION hon.resolve_current_staff_reporting_scope(text) SECURITY INVOKER', 'ALTER FUNCTION hon.resolve_current_staff_reporting_scope(text) SET search_path=public,hon', 'ALTER TABLE hon.schools NO FORCE ROW LEVEL SECURITY']) {
    await client.query('BEGIN');
    try {
      await client.query(drift); await assert.rejects(() => verifyCurrentStaffReportingScopeSecurity(client)); proofs++;
    } finally { await client.query('ROLLBACK'); }
  }
  await verifyCurrentStaffReportingScopeSecurity(client); proofs++;
  for (const drift of ['GRANT EXECUTE ON FUNCTION hon.read_staff_reporting_schools(text) TO PUBLIC', 'GRANT EXECUTE ON FUNCTION hon.read_staff_reporting_schools(text) TO hon_runtime WITH GRANT OPTION', 'ALTER FUNCTION hon.read_staff_reporting_schools(text) SECURITY INVOKER', 'ALTER FUNCTION hon.read_staff_reporting_schools(text) SET search_path=public,hon', 'ALTER TABLE hon.schools NO FORCE ROW LEVEL SECURITY', 'ALTER ROLE hon_runtime INHERIT', 'GRANT SELECT ON hon.users TO hon_runtime', 'CREATE FUNCTION hon.read_staff_reporting_schools(text,integer) RETURNS text LANGUAGE sql AS $$ SELECT $1 $$']) {
    await client.query('BEGIN');
    try { await client.query(drift); await assert.rejects(() => verifyStaffReportingSchoolsSecurity(client)); proofs++; }
    finally { await client.query('ROLLBACK'); }
  }
  await verifyStaffReportingSchoolsSecurity(client); proofs++;
  console.log(`Passed ${proofs} local PostgreSQL reporting-scope/policy/ACL/RLS proofs. No remote DB or configured URLs used.`);
} finally {
  await client?.end();
  if (started) execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
}
