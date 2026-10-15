import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Client } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for knowledge integrity tests.');
if (!process.env.HON_RUNTIME_DATABASE_URL) throw new Error('HON_RUNTIME_DATABASE_URL is required for knowledge integrity tests.');

const connectionOptions = (connectionString) => ({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});
const administrator = new Client(connectionOptions(process.env.DATABASE_URL));
const runtime = new Client(connectionOptions(process.env.HON_RUNTIME_DATABASE_URL));
const ids = Object.fromEntries(
  ['organization', 'schoolA', 'schoolB', 'creator', 'approver', 'articleA', 'articleB']
    .map((key) => [key, randomUUID()]),
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function cleanupFixtures() {
  await administrator.query('BEGIN');
  try {
    await administrator.query('DELETE FROM hon.knowledge_articles WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.principals WHERE id IN ($1, $2)', [ids.creator, ids.approver]);
    await administrator.query('DELETE FROM hon.schools WHERE id IN ($1, $2)', [ids.schoolA, ids.schoolB]);
    await administrator.query('DELETE FROM hon.organizations WHERE id = $1', [ids.organization]);
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }
}

await administrator.connect();
await runtime.connect();
try {
  const posture = await administrator.query(`
    SELECT relrowsecurity, relforcerowsecurity
    FROM pg_class
    WHERE oid = 'hon.knowledge_articles'::regclass
  `);
  assert(posture.rows[0]?.relrowsecurity && posture.rows[0]?.relforcerowsecurity,
    'knowledge_articles must enable and force row-level security.');

  const obsoleteParentPermission = await administrator.query(
    "SELECT 1 FROM hon.permissions WHERE code = 'knowledge.parent.read'",
  );
  assert(obsoleteParentPermission.rowCount === 0,
    'Parent-safe knowledge must be authorized by family scope, not a dead staff-only permission.');

  const privileges = await runtime.query(`
    SELECT
      has_table_privilege(current_user, 'hon.knowledge_articles', 'SELECT') AS can_select,
      has_table_privilege(current_user, 'hon.knowledge_articles', 'INSERT') AS can_insert,
      has_table_privilege(current_user, 'hon.knowledge_articles', 'UPDATE') AS can_update,
      has_table_privilege(current_user, 'hon.knowledge_articles', 'DELETE') AS can_delete,
      has_type_privilege(current_user, 'hon.knowledge_article_audience', 'USAGE') AS audience_type_usage,
      has_type_privilege(current_user, 'hon.knowledge_article_lifecycle', 'USAGE') AS lifecycle_type_usage
  `);
  const grants = privileges.rows[0];
  assert(grants?.can_select && grants?.can_insert && grants?.can_update && !grants?.can_delete,
    'hon_runtime knowledge article table privileges are not the reviewed minimum.');
  assert(grants?.audience_type_usage && grants?.lifecycle_type_usage,
    'hon_runtime lacks an explicitly reviewed knowledge enum cast grant.');

  await administrator.query('BEGIN');
  try {
    await administrator.query(
      'INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, $2, $2)',
      [ids.organization, 'Knowledge Integrity Test'],
    );
    await administrator.query(
      `INSERT INTO hon.schools (id, organization_id, name, slug) VALUES
       ($1, $2, 'Knowledge School A', $3),
       ($4, $2, 'Knowledge School B', $5)`,
      [
        ids.schoolA,
        ids.organization,
        `knowledge-a-${ids.schoolA.slice(0, 8)}`,
        ids.schoolB,
        `knowledge-b-${ids.schoolB.slice(0, 8)}`,
      ],
    );
    await administrator.query(
      `INSERT INTO hon.principals (id, principal_type, display_name) VALUES
       ($1, 'AI_EMPLOYEE', 'Knowledge Draft Author'),
       ($2, 'AI_EMPLOYEE', 'Knowledge Approver')`,
      [ids.creator, ids.approver],
    );
    await administrator.query(
      `INSERT INTO hon.knowledge_articles (
         id, organization_id, school_id, title, body, audience, created_by_principal_id
       ) VALUES
       ($1, $2, $3, 'School A guidance', 'School A governed guidance', 'STAFF', $4),
       ($5, $2, $6, 'School B guidance', 'School B governed guidance', 'PARENT_SAFE', $4)`,
      [ids.articleA, ids.organization, ids.schoolA, ids.creator, ids.articleB, ids.schoolB],
    );
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }

  await runtime.query('BEGIN');
  try {
    await runtime.query(
      `SELECT set_config('app.hon_organization_id', $1, true),
              set_config('app.hon_school_id', $2, true)`,
      [ids.organization, ids.schoolA],
    );
    await runtime.query('SELECT hon.require_tenant_context()');
    const visible = await runtime.query('SELECT id FROM hon.knowledge_articles WHERE id = $1::uuid', [ids.articleA]);
    const hidden = await runtime.query('SELECT id FROM hon.knowledge_articles WHERE id = $1::uuid', [ids.articleB]);
    assert(visible.rowCount === 1, 'RLS hid the scoped school knowledge article.');
    assert(hidden.rowCount === 0, 'RLS exposed a different school’s knowledge article.');
    await runtime.query('ROLLBACK');
  } catch (error) {
    await runtime.query('ROLLBACK');
    throw error;
  }

  await administrator.query('BEGIN');
  try {
    await administrator.query('SAVEPOINT no_self_approval');
    try {
      await administrator.query(
        `UPDATE hon.knowledge_articles
         SET lifecycle = 'APPROVED'::hon.knowledge_article_lifecycle,
             effective_from = now(),
             approved_by_principal_id = $2::uuid,
             approved_at = now(),
             version = version + 1
         WHERE id = $1::uuid`,
        [ids.articleA, ids.creator],
      );
      throw new Error('Knowledge article self-approval was accepted.');
    } catch (error) {
      if (error instanceof Error && error.message.includes('self-approval was accepted')) throw error;
      if (error?.code !== '23514') throw error;
    } finally {
      await administrator.query('ROLLBACK TO SAVEPOINT no_self_approval');
    }
    await administrator.query('ROLLBACK');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }

  console.log('Verified forced RLS, cross-school knowledge invisibility, reviewed runtime privileges/type usage, and database-enforced no-self approval.');
} finally {
  try {
    await cleanupFixtures();
  } finally {
    await Promise.all([administrator.end(), runtime.end()]);
  }
}
