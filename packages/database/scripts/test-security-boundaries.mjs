import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Client } = pg;
if (!process.env.HON_RUNTIME_DATABASE_URL) throw new Error('HON_RUNTIME_DATABASE_URL is required for RLS boundary tests.');

const client = new Client({
  connectionString: process.env.HON_RUNTIME_DATABASE_URL,
  ssl: process.env.HON_RUNTIME_DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
});

const bindScope = async (organizationId, schoolId) => {
  await client.query(
    `SELECT set_config('app.hon_organization_id', $1, true), set_config('app.hon_school_id', $2, true)`,
    [organizationId, schoolId],
  );
};

await client.connect();
try {
  const role = (await client.query(`
    SELECT r.rolsuper, r.rolbypassrls
    FROM pg_roles r
    WHERE r.rolname = current_user
  `)).rows[0];
  if (role?.rolsuper || role?.rolbypassrls) {
    throw new Error('HON_RUNTIME_DATABASE_URL must use a non-superuser, non-BYPASSRLS runtime role.');
  }

  const organizationA = randomUUID();
  const schoolA = randomUUID();
  const personA = randomUUID();
  const organizationB = randomUUID();
  const schoolB = randomUUID();
  const personB = randomUUID();

  await client.query('BEGIN');
  try {
    await bindScope(organizationA, schoolA);
    await client.query('SELECT hon.require_tenant_context()');
    await client.query('INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, $2, $2)', [organizationA, 'RLS Test A']);
    await client.query('INSERT INTO hon.schools (id, organization_id, name, slug) VALUES ($1, $2, $3, $4)', [schoolA, organizationA, 'School A', `rls-a-${schoolA.slice(0, 8)}`]);
    await client.query('INSERT INTO hon.people (id, organization_id, school_id, given_name, family_name) VALUES ($1, $2, $3, $4, $5)', [personA, organizationA, schoolA, 'Scope', 'A']);

    await bindScope(organizationB, schoolB);
    await client.query('INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, $2, $2)', [organizationB, 'RLS Test B']);
    await client.query('INSERT INTO hon.schools (id, organization_id, name, slug) VALUES ($1, $2, $3, $4)', [schoolB, organizationB, 'School B', `rls-b-${schoolB.slice(0, 8)}`]);
    await client.query('INSERT INTO hon.people (id, organization_id, school_id, given_name, family_name) VALUES ($1, $2, $3, $4, $5)', [personB, organizationB, schoolB, 'Scope', 'B']);

    await bindScope(organizationA, schoolA);
    const visibleToA = await client.query('SELECT id FROM hon.people WHERE id = $1', [personB]);
    if (visibleToA.rowCount !== 0) throw new Error('RLS leaked a person from another tenant.');

    await client.query('SAVEPOINT cross_scope_reference');
    try {
      await client.query(
        'INSERT INTO hon.billing_accounts (organization_id, school_id, responsible_person_id) VALUES ($1, $2, $3)',
        [organizationA, schoolA, personB],
      );
      throw new Error('Composite tenant FK allowed a cross-scope relationship.');
    } catch (error) {
      if (error instanceof Error && error.message.includes('Composite tenant FK')) throw error;
      if (error?.code !== '23503') throw error;
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT cross_scope_reference');
    }

    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }

  const cleared = (await client.query(`
    SELECT hon.current_organization_id() AS organization_id, hon.current_school_id() AS school_id
  `)).rows[0];
  if (cleared.organization_id !== null || cleared.school_id !== null) {
    throw new Error('Tenant context leaked after transaction completion.');
  }
  console.log('Verified transaction-bound tenant context, RLS isolation, and composite tenant references.');
} finally {
  await client.end();
}
