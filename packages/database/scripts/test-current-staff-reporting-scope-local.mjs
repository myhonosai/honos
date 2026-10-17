import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import pg from 'pg';
import { verifyCurrentStaffReportingScopeSecurity } from './current-staff-reporting-scope-security.mjs';

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
  const directory = new URL('../migrations/', import.meta.url);
  const migrations = (await readdir(directory)).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
  for (const file of migrations) await client.query(await readFile(new URL(file, directory), 'utf8'));
  console.log(`Applied ${migrations.length} actual migrations in fresh socket-only cluster: ${root}`);
  await client.query('GRANT USAGE ON SCHEMA hon TO hon_runtime');
  await verifyCurrentStaffReportingScopeSecurity(client);
  proofs++;

  const organizationId = randomUUID();
  const schools = [randomUUID(), randomUUID()];
  await client.query('INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$2,$2)', [organizationId, 'Local proof']);
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
  async function expectScope(subject, expected = []) {
    await client.query('SET ROLE hon_runtime');
    try {
      const result = await client.query('SELECT * FROM hon.resolve_current_staff_reporting_scope($1)', [subject]);
      assert.deepEqual(result.rows, expected, subject); proofs++;
    } finally { await client.query('RESET ROLE'); }
  }
  const scope = [{ organization_id: organizationId, school_id: schools[0] }];
  const staffRole = await role('CUSTOM_REPORT_READER');
  const ownerRole = await role('OWNER');
  const noReportRole = await role('CUSTOM_NO_REPORT', ['school.view']);
  for (const [subject, roleId] of [['single-staff', staffRole], ['single-owner', ownerRole]]) {
    const person = await identity(subject); await grant(person.principalId, roleId); await expectScope(subject, scope);
    // Multiple compatible roles/grants at the same school are one candidate.
    await grant(person.principalId, noReportRole); await expectScope(subject, scope);
  }
  await expectScope('unknown-subject');
  await expectScope(null);
  for (const [subject, options] of [['zero', { none: true }], ['unauthorized', { noReport: true }], ['inactive-human', { active: false }], ['revoked', { revoked: true }], ['expired', { until: '-1 minute', from: '-2 hours' }], ['future', { from: '1 hour' }]]) {
    const person = await identity(subject, options.active ?? true);
    if (!options.none) await grant(person.principalId, options.noReport ? noReportRole : staffRole, schools[0], options);
    await expectScope(subject);
  }
  // OWNER naming alone is never authority; give a distinct no-report owner role.
  const ownerWithoutReporting = await role('OWNER_WITHOUT_REPORTING', ['school.view']);
  const owner = await identity('owner-without-reporting'); await grant(owner.principalId, ownerWithoutReporting); await expectScope('owner-without-reporting');
  for (const secondRole of [staffRole, noReportRole]) {
    const subject = secondRole === staffRole ? 'multiple-reporting-schools' : 'second-nonreporting-school';
    const person = await identity(subject); await grant(person.principalId, staffRole); await grant(person.principalId, secondRole, schools[1]); await expectScope(subject);
  }
  const multi = await identity('multiple-principals'); await grant(multi.principalId, staffRole);
  await client.query("INSERT INTO hon.principals(user_id,principal_type,display_name) VALUES($1,'HUMAN_USER','second')", [multi.userId]);
  await expectScope('multiple-principals');
  for (const code of ['PARENT', 'GUARDIAN', 'STUDENT', 'FAMILY', 'HQ', 'HON_HQ_OWNER', 'PLATFORM', 'SYSTEM']) {
    const mixedRole = await role(code);
    for (const mixed of [false, true]) {
      const subject = `${code}-${mixed ? 'mixed' : 'only'}`;
      const person = await identity(subject); await grant(person.principalId, mixedRole);
      if (mixed) await grant(person.principalId, staffRole);
      await expectScope(subject);
    }
  }
  for (const expired of [false, true]) {
    const subject = expired ? 'staff-expired-hq' : 'staff-live-hq';
    const person = await identity(subject); await grant(person.principalId, staffRole);
    await client.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,effective_from,effective_until) VALUES($1,'HON_HQ_OPERATOR',statement_timestamp()-interval '2 hours',CASE WHEN $2 THEN statement_timestamp()-interval '1 hour' ELSE NULL END)", [person.principalId, expired]);
    await expectScope(subject);
  }
  const familyPerson = await identity('staff-family'); await grant(familyPerson.principalId, staffRole);
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

  // No data-plane enumeration or public/client invocation was added.
  for (const clientRole of ['anon', 'authenticated', 'service_role']) {
    const access = await client.query("SELECT has_function_privilege($1,'hon.resolve_current_staff_reporting_scope(text)','EXECUTE') allowed", [clientRole]);
    assert.equal(access.rows[0].allowed, false); proofs++;
  }
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
  console.log(`Passed ${proofs} local PostgreSQL reporting-scope/policy/ACL/RLS proofs. No remote DB or configured URLs used.`);
} finally {
  await client?.end();
  if (started) execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
}
