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
    await administrator.query('DELETE FROM hon.roles WHERE id = $1', [roleA]);
    await administrator.query('DELETE FROM hon.principals WHERE id = $1', [principalA]);
    await administrator.query('DELETE FROM hon.families WHERE id = $1', [familyA]);
    await administrator.query('DELETE FROM hon.people WHERE id IN ($1, $2)', [personA, personB]);
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
  console.log('Verified restricted runtime privileges, live permission revocation, transaction-bound RLS isolation, and composite tenant references.');
} finally {
  try { await cleanupFixtures(); } finally {
    await Promise.all([administrator.end(), runtime.end()]);
  }
}
