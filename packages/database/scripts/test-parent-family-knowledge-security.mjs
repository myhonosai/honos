import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Client } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for parent knowledge security fixtures.');
if (!process.env.HON_RUNTIME_DATABASE_URL) throw new Error('HON_RUNTIME_DATABASE_URL is required for parent knowledge security tests.');

const connectionOptions = (connectionString) => ({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});

const { ParentFamilyKnowledgeController } = await import('../../../apps/api/dist/knowledge/parent-family-knowledge.controller.js');
const { ParentFamilyKnowledgeService } = await import('../../../apps/api/dist/knowledge/parent-family-knowledge.service.js');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');

const ids = Object.fromEntries(
  [
    'organization', 'school', 'parentUser', 'parentPrincipal', 'author', 'approver',
    'familyA', 'familyB', 'publishedParentSafe', 'staff', 'draft', 'future', 'archived',
  ].map((key) => [key, randomUUID()]),
);
const externalSubject = `parent-knowledge-${randomUUID()}`;
const administrator = new Client(connectionOptions(process.env.DATABASE_URL));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function cleanupFixtures() {
  await administrator.query('BEGIN');
  try {
    await administrator.query('DELETE FROM hon.knowledge_articles WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.family_access_grants WHERE principal_id = $1', [ids.parentPrincipal]);
    await administrator.query('DELETE FROM hon.families WHERE id IN ($1, $2)', [ids.familyA, ids.familyB]);
    await administrator.query('DELETE FROM hon.principals WHERE id IN ($1, $2, $3)', [ids.parentPrincipal, ids.author, ids.approver]);
    await administrator.query('DELETE FROM hon.users WHERE id = $1', [ids.parentUser]);
    await administrator.query('DELETE FROM hon.schools WHERE id = $1', [ids.school]);
    await administrator.query('DELETE FROM hon.organizations WHERE id = $1', [ids.organization]);
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }
}

await administrator.connect();
const database = new RuntimeDatabaseService();
const knowledge = new ParentFamilyKnowledgeService(database);
const controller = new ParentFamilyKnowledgeController(database, knowledge);

try {
  const effectiveNow = new Date(Date.now() - 60_000).toISOString();
  const futureEffectiveFrom = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  await administrator.query('BEGIN');
  try {
    await administrator.query(
      'INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, $2, $2)',
      [ids.organization, 'Parent Knowledge Security Test'],
    );
    await administrator.query(
      'INSERT INTO hon.schools (id, organization_id, name, slug) VALUES ($1, $2, $3, $4)',
      [ids.school, ids.organization, 'Parent Knowledge School', `parent-knowledge-${ids.school.slice(0, 8)}`],
    );
    await administrator.query(
      'INSERT INTO hon.users (id, external_subject, email, display_name) VALUES ($1, $2, $3, $4)',
      [ids.parentUser, externalSubject, `parent-knowledge-${ids.parentUser}@example.test`, 'Knowledge Parent'],
    );
    await administrator.query(
      `INSERT INTO hon.principals (id, principal_type, user_id, display_name) VALUES
       ($1, 'HUMAN_USER', $2, 'Knowledge Parent'),
       ($3, 'AI_EMPLOYEE', NULL, 'Knowledge Author'),
       ($4, 'AI_EMPLOYEE', NULL, 'Knowledge Approver')`,
      [ids.parentPrincipal, ids.parentUser, ids.author, ids.approver],
    );
    await administrator.query(
      `INSERT INTO hon.families (id, organization_id, school_id, display_name) VALUES
       ($1, $2, $3, 'Authorized Family'),
       ($4, $2, $3, 'Other Family')`,
      [ids.familyA, ids.organization, ids.school, ids.familyB],
    );
    await administrator.query(
      `INSERT INTO hon.family_access_grants (
         organization_id, school_id, family_id, principal_id, access_level, granted_by_principal_id
       ) VALUES ($1, $2, $3, $4, 'PRIMARY_GUARDIAN', $4)`,
      [ids.organization, ids.school, ids.familyA, ids.parentPrincipal],
    );
    await administrator.query(
      `INSERT INTO hon.knowledge_articles (
         id, organization_id, school_id, title, body, audience, lifecycle, effective_from,
         created_by_principal_id, approved_by_principal_id, approved_at, version
       ) VALUES
       ($1, $2, $3, 'Published parent guidance', 'Visible parent-safe guidance', 'PARENT_SAFE', 'APPROVED', $4, $5, $6, now(), 3),
       ($7, $2, $3, 'Staff guidance', 'Staff-only guidance', 'STAFF', 'APPROVED', $4, $5, $6, now(), 2),
       ($8, $2, $3, 'Future parent guidance', 'Future parent-safe guidance', 'PARENT_SAFE', 'APPROVED', $9, $5, $6, now(), 2),
       ($10, $2, $3, 'Archived parent guidance', 'Archived parent-safe guidance', 'PARENT_SAFE', 'ARCHIVED', $4, $5, $6, now(), 2)`,
      [
        ids.publishedParentSafe, ids.organization, ids.school, effectiveNow, ids.author, ids.approver,
        ids.staff, ids.future, futureEffectiveFrom, ids.archived,
      ],
    );
    await administrator.query(
      `INSERT INTO hon.knowledge_articles (
         id, organization_id, school_id, title, body, audience, lifecycle, created_by_principal_id
       ) VALUES ($1, $2, $3, 'Draft parent guidance', 'Draft parent-safe guidance', 'PARENT_SAFE', 'DRAFT', $4)`,
      [ids.draft, ids.organization, ids.school, ids.author],
    );
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }

  const request = { honIdentity: { externalSubject } };
  const allowed = await controller.getKnowledge(ids.school, ids.familyA, request);
  assert(Object.keys(allowed.data).length === 1 && Array.isArray(allowed.data.articles), 'Parent knowledge response exposed fields beyond articles.');
  assert(allowed.data.articles.length === 1, 'Parent knowledge returned non-published or non-parent-safe content.');
  const article = allowed.data.articles[0];
  assert(article?.id === ids.publishedParentSafe && article.title === 'Published parent guidance' && article.body === 'Visible parent-safe guidance', 'Parent knowledge did not return the eligible article.');
  assert(article.effectiveFrom === new Date(effectiveNow).toISOString() && article.version === 3, 'Parent knowledge did not return safe publication facts.');
  assert(JSON.stringify(Object.keys(article).sort()) === JSON.stringify(['body', 'effectiveFrom', 'id', 'title', 'version']), 'Parent knowledge exposed prohibited article fields.');
  const serialized = JSON.stringify(allowed.data);
  assert(!serialized.includes('Staff guidance') && !serialized.includes('Draft parent guidance') && !serialized.includes('Future parent guidance') && !serialized.includes('Archived parent guidance'), 'Parent knowledge exposed STAFF, DRAFT, future, or archived content.');

  let crossFamilyDenied = false;
  try {
    await controller.getKnowledge(ids.school, ids.familyB, request);
  } catch (error) {
    crossFamilyDenied = typeof error?.getStatus === 'function' && error.getStatus() === 403;
  }
  assert(crossFamilyDenied, 'A parent could invoke the knowledge read for another same-school family.');

  console.log('Verified resolver-only parent knowledge authorization, same-school cross-family denial, publication filtering, and safe-field redaction.');
} finally {
  try {
    await database.onModuleDestroy();
  } finally {
    try {
      await cleanupFixtures();
    } finally {
      await administrator.end();
    }
  }
}
