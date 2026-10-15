import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Client } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for privileged test-fixture setup.');
if (!process.env.HON_RUNTIME_DATABASE_URL) throw new Error('HON_RUNTIME_DATABASE_URL is required for RLS boundary tests.');

const connectionOptions = (connectionString) => ({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});
const administrator = new Client(connectionOptions(process.env.DATABASE_URL));
const runtime = new Client(connectionOptions(process.env.HON_RUNTIME_DATABASE_URL));

const organizationA = randomUUID();
const schoolA = randomUUID();
const personA = randomUUID();
const familyA = randomUUID();
const organizationB = randomUUID();
const schoolB = randomUUID();
const personB = randomUUID();
const principalA = randomUUID();
const roleA = randomUUID();
const familyB = randomUUID();
const parentStudentA = randomUUID();
const parentStudentB = randomUUID();
const parentProfileA = randomUUID();
const parentProfileB = randomUUID();
const parentAccessLevels = ['PRIMARY_GUARDIAN', 'SECONDARY_GUARDIAN', 'VIEWER'];
const parentUsers = parentAccessLevels.map(() => randomUUID());
const parentPrincipals = parentAccessLevels.map(() => randomUUID());
const parentSubjects = parentAccessLevels.map((level) => `parent-scope-${level.toLowerCase()}-${randomUUID()}`);

const bindScope = async (organizationId, schoolId) => {
  await runtime.query(
    `SELECT set_config('app.hon_organization_id', $1, true), set_config('app.hon_school_id', $2, true)`,
    [organizationId, schoolId],
  );
};

async function cleanupFixtures() {
  await administrator.query('BEGIN');
  try {
    await administrator.query('DELETE FROM hon.role_permissions WHERE role_id = $1', [roleA]);
    await administrator.query('DELETE FROM hon.principal_role_grants WHERE role_id = $1', [roleA]);
    await administrator.query('DELETE FROM hon.family_access_grants WHERE principal_id = ANY($1::uuid[])', [parentPrincipals]);
    await administrator.query('DELETE FROM hon.roles WHERE id = $1', [roleA]);
    await administrator.query('DELETE FROM hon.student_profiles WHERE id IN ($1, $2)', [parentProfileA, parentProfileB]);
    await administrator.query('DELETE FROM hon.family_members WHERE family_id IN ($1, $2)', [familyA, familyB]);
    await administrator.query('DELETE FROM hon.families WHERE id IN ($1, $2)', [familyA, familyB]);
    await administrator.query('DELETE FROM hon.principals WHERE id = $1 OR id = ANY($2::uuid[])', [principalA, parentPrincipals]);
    await administrator.query('DELETE FROM hon.users WHERE id = ANY($1::uuid[])', [parentUsers]);
    await administrator.query('DELETE FROM hon.people WHERE id IN ($1, $2, $3, $4)', [personA, personB, parentStudentA, parentStudentB]);
    await administrator.query('DELETE FROM hon.schools WHERE id IN ($1, $2)', [schoolA, schoolB]);
    await administrator.query('DELETE FROM hon.organizations WHERE id IN ($1, $2)', [organizationA, organizationB]);
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }
}

await administrator.connect();
await runtime.connect();
try {
  const role = (await runtime.query(`
    SELECT r.rolsuper, r.rolbypassrls, r.rolinherit,
           EXISTS (SELECT 1 FROM pg_auth_members membership WHERE membership.member = r.oid) AS has_membership,
           has_schema_privilege(current_user, 'hon', 'CREATE') AS may_create_in_hon
    FROM pg_roles r WHERE r.rolname = current_user
  `)).rows[0];
  if (!role || role.rolsuper || role.rolbypassrls || role.rolinherit || role.has_membership || role.may_create_in_hon) {
    throw new Error('HON runtime PostgreSQL role is not restricted to NOINHERIT, non-superuser, non-BYPASSRLS runtime access.');
  }

  const deniedTables = [
    'hon.users', 'hon.principals', 'hon.roles', 'hon.role_permissions',
    'hon.principal_role_grants', 'hon.permissions', 'hon.family_access_grants',
    'hon.organizations', 'hon.schools',
  ];
  for (const tableName of deniedTables) {
    const privilege = await runtime.query(`SELECT has_table_privilege(current_user, $1, 'SELECT,INSERT,UPDATE,DELETE') AS allowed`, [tableName]);
    if (privilege.rows[0]?.allowed) throw new Error(`hon_runtime has forbidden direct DML on ${tableName}.`);
  }
  const controlPlaneMutations = [
    'hon.organizations', 'hon.schools', 'hon.organization_entitlements', 'hon.action_policies',
  ];
  for (const tableName of controlPlaneMutations) {
    const privilege = await runtime.query(`SELECT has_table_privilege(current_user, $1, 'INSERT,UPDATE,DELETE') AS allowed`, [tableName]);
    if (privilege.rows[0]?.allowed) throw new Error(`hon_runtime has forbidden direct control-plane mutation privileges on ${tableName}.`);
  }
  const resolverPrivilege = await runtime.query(`SELECT has_function_privilege(current_user, 'hon.principal_has_school_permission(uuid,uuid,uuid,text)', 'EXECUTE') AS allowed`);
  if (!resolverPrivilege.rows[0]?.allowed) throw new Error('hon_runtime cannot execute the fixed live-permission resolver.');

  await administrator.query('BEGIN');
  try {
    await administrator.query('INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, $2, $2), ($3, $4, $4)', [organizationA, 'RLS Test A', organizationB, 'RLS Test B']);
    await administrator.query('INSERT INTO hon.schools (id, organization_id, name, slug) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)', [schoolA, organizationA, 'School A', `rls-a-${schoolA.slice(0, 8)}`, schoolB, organizationB, 'School B', `rls-b-${schoolB.slice(0, 8)}`]);
    await administrator.query('INSERT INTO hon.people (id, organization_id, school_id, given_name, family_name) VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)', [personA, organizationA, schoolA, 'Scope', 'A', personB, organizationB, schoolB, 'Scope', 'B']);
    await administrator.query('INSERT INTO hon.families (id, organization_id, school_id, display_name) VALUES ($1, $2, $3, $4)', [familyA, organizationA, schoolA, 'Family A']);
    await administrator.query(`INSERT INTO hon.principals (id, principal_type, display_name) VALUES ($1, 'AI_EMPLOYEE', 'RLS Test Agent')`, [principalA]);
    await administrator.query('INSERT INTO hon.roles (id, organization_id, code, name) VALUES ($1, $2, $3, $4)', [roleA, organizationA, `RLS_TEST_${roleA.slice(0, 8)}`, 'RLS Test Role']);
    await administrator.query(`INSERT INTO hon.role_permissions (role_id, organization_id, permission_code) VALUES ($1, $2, 'crm.lead.create')`, [roleA, organizationA]);
    await administrator.query('INSERT INTO hon.principal_role_grants (organization_id, school_id, principal_id, role_id, granted_by_principal_id) VALUES ($1, $2, $3, $4, $3)', [organizationA, schoolA, principalA, roleA]);
    await administrator.query('INSERT INTO hon.families (id, organization_id, school_id, display_name) VALUES ($1, $2, $3, $4)', [familyB, organizationA, schoolA, 'Family B']);
    await administrator.query('INSERT INTO hon.people (id, organization_id, school_id, given_name, family_name) VALUES ($1, $2, $3, $4, $5), ($6, $2, $3, $7, $8)', [parentStudentA, organizationA, schoolA, 'Parent', 'Student A', parentStudentB, 'Other', 'Student B']);
    await administrator.query(`INSERT INTO hon.family_members (organization_id, school_id, family_id, person_id, member_role)
      VALUES ($1, $2, $3, $4, 'STUDENT'), ($1, $2, $5, $6, 'STUDENT')`, [organizationA, schoolA, familyA, parentStudentA, familyB, parentStudentB]);
    await administrator.query('INSERT INTO hon.student_profiles (id, organization_id, school_id, person_id, primary_family_id) VALUES ($1, $2, $3, $4, $5), ($6, $2, $3, $7, $8)', [parentProfileA, organizationA, schoolA, parentStudentA, familyA, parentProfileB, parentStudentB, familyB]);
    for (let index = 0; index < parentAccessLevels.length; index += 1) {
      await administrator.query('INSERT INTO hon.users (id, external_subject, email, display_name) VALUES ($1, $2, $3, $4)', [parentUsers[index], parentSubjects[index], `parent-${index}-${parentUsers[index]}@example.test`, `Parent ${parentAccessLevels[index]}`]);
      await administrator.query(`INSERT INTO hon.principals (id, principal_type, user_id, display_name)
        VALUES ($1, 'HUMAN_USER', $2, $3)`, [parentPrincipals[index], parentUsers[index], `Parent ${parentAccessLevels[index]}`]);
      await administrator.query(`INSERT INTO hon.family_access_grants (
        organization_id, school_id, family_id, principal_id, access_level, granted_by_principal_id
      ) VALUES ($1, $2, $3, $4, $5::hon.family_access_level, $6)`, [organizationA, schoolA, familyA, parentPrincipals[index], parentAccessLevels[index], parentPrincipals[0]]);
    }
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }

  const livePermission = await runtime.query(`SELECT hon.principal_has_school_permission($1::uuid, $2::uuid, $3::uuid, 'crm.lead.create') AS allowed`, [principalA, organizationA, schoolA]);
  if (!livePermission.rows[0]?.allowed) throw new Error('Live permission resolver denied an active role grant.');
  await administrator.query('DELETE FROM hon.role_permissions WHERE role_id = $1 AND permission_code = $2', [roleA, 'crm.lead.create']);
  const revokedPermission = await runtime.query(`SELECT hon.principal_has_school_permission($1::uuid, $2::uuid, $3::uuid, 'crm.lead.create') AS allowed`, [principalA, organizationA, schoolA]);
  if (revokedPermission.rows[0]?.allowed) throw new Error('Live permission resolver allowed an action after the permission was revoked.');

  // Mirror the endpoint's exact resolver-match rule for every currently
  // supported parent family access level. RLS is tenant-wide by design, so this
  // explicit resolver match is the authority that rejects another family in the
  // same school before the family-anchored read transaction begins.
  for (let index = 0; index < parentAccessLevels.length; index += 1) {
    const resolved = await runtime.query(`SELECT
      principal_id AS "principalId",
      organization_id AS "organizationId",
      school_id AS "schoolId",
      family_id AS "familyId",
      access_level::text AS "accessLevel"
      FROM hon.resolve_parent_family_scope($1, $2::uuid)`, [parentSubjects[index], schoolA]);
    if (resolved.rowCount !== 1) throw new Error(`Parent resolver did not return exactly one family for ${parentAccessLevels[index]}.`);
    const allowed = resolved.rows.find((scope) => scope.schoolId === schoolA && scope.familyId === familyA);
    const denied = resolved.rows.find((scope) => scope.schoolId === schoolA && scope.familyId === familyB);
    if (!allowed || denied || allowed.organizationId !== organizationA || allowed.principalId !== parentPrincipals[index] || allowed.accessLevel !== parentAccessLevels[index]) {
      throw new Error(`Parent resolver widened or corrupted ${parentAccessLevels[index]} family access.`);
    }

    await runtime.query('BEGIN');
    try {
      await bindScope(allowed.organizationId, allowed.schoolId);
      await runtime.query('SELECT hon.require_tenant_context()');
      // This is the journey service's family predicate: only the resolved family
      // id can reach the read. The same-school Family B id was rejected above.
      const journeyStudent = await runtime.query(`SELECT person_id AS "personId"
        FROM hon.family_members
        WHERE family_id = $1::uuid
          AND member_role = 'STUDENT'::hon.family_member_role`, [allowed.familyId]);
      if (journeyStudent.rowCount !== 1 || journeyStudent.rows[0]?.personId !== parentStudentA) {
        throw new Error(`Parent journey fixture returned data outside ${parentAccessLevels[index]} resolved family.`);
      }
      await runtime.query('ROLLBACK');
    } catch (error) {
      await runtime.query('ROLLBACK');
      throw error;
    }
  }

  await runtime.query('BEGIN');
  try {
    await bindScope(organizationA, schoolA);
    await runtime.query('SELECT hon.require_tenant_context()');
    const visibleToA = await runtime.query('SELECT id FROM hon.people WHERE id = $1', [personB]);
    if (visibleToA.rowCount !== 0) throw new Error('RLS leaked a person from another tenant.');

    await runtime.query('SAVEPOINT cross_scope_reference');
    try {
      await runtime.query('INSERT INTO hon.billing_accounts (organization_id, school_id, responsible_person_id) VALUES ($1, $2, $3)', [organizationA, schoolA, personB]);
      throw new Error('Composite tenant FK allowed a cross-scope relationship.');
    } catch (error) {
      if (error instanceof Error && error.message.includes('Composite tenant FK')) throw error;
      if (error?.code !== '23503') throw error;
    } finally {
      await runtime.query('ROLLBACK TO SAVEPOINT cross_scope_reference');
    }

    await runtime.query('SAVEPOINT cross_scope_family_reference');
    try {
      await runtime.query(`INSERT INTO hon.family_members (organization_id, school_id, family_id, person_id, member_role) VALUES ($1, $2, $3, $4, 'STUDENT')`, [organizationA, schoolA, familyA, personB]);
      throw new Error('Composite family FK allowed a cross-scope person relationship.');
    } catch (error) {
      if (error instanceof Error && error.message.includes('Composite family FK')) throw error;
      if (error?.code !== '23503') throw error;
    } finally {
      await runtime.query('ROLLBACK TO SAVEPOINT cross_scope_family_reference');
    }
    await runtime.query('ROLLBACK');
  } catch (error) {
    await runtime.query('ROLLBACK');
    throw error;
  }

  const cleared = (await runtime.query(`SELECT hon.current_organization_id() AS organization_id, hon.current_school_id() AS school_id`)).rows[0];
  if (cleared.organization_id !== null || cleared.school_id !== null) throw new Error('Tenant context leaked after transaction completion.');
  console.log('Verified restricted runtime privileges, live permission revocation, parent-family resolution for all access levels, transaction-bound RLS isolation, and composite tenant references.');
} finally {
  try { await cleanupFixtures(); } finally {
    await Promise.all([administrator.end(), runtime.end()]);
  }
}
