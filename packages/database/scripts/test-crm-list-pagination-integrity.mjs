import pg from 'pg';
import { randomUUID } from 'node:crypto';

// B-CRM-4 list pagination proof: the CRM lead list and the school people directory page through every row of the
// exact school with an opaque keyset cursor. Disposable local database fixtures only; synthetic names.
const { Client } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for CRM list pagination tests.');
if (!process.env.HON_RUNTIME_DATABASE_URL) throw new Error('HON_RUNTIME_DATABASE_URL is required for CRM list pagination tests.');
const connectionOptions = (connectionString) => ({ connectionString, ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false } });

const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { LeadService } = await import('../../../apps/api/dist/crm/lead.service.js');
const { LeadController } = await import('../../../apps/api/dist/crm/lead.controller.js');
const { PersonService } = await import('../../../apps/api/dist/people/person.service.js');
const { PersonController } = await import('../../../apps/api/dist/people/person.controller.js');

const ids = Object.fromEntries(['organization', 'schoolA', 'schoolB', 'user', 'principal', 'role', 'pipelineA', 'pipelineB', 'stageA', 'stageB']
  .map((key) => [key, randomUUID()]));
const externalSubject = `crm-list-pagination-${randomUUID()}`;
const administrator = new Client(connectionOptions(process.env.DATABASE_URL));
await administrator.connect();
const database = new RuntimeDatabaseService();
const leadController = new LeadController(database, new LeadService(database));
const personController = new PersonController(database, new PersonService(database));
const request = { honIdentity: { externalSubject } };
let assertions = 0;

function assert(condition, message) { assertions += 1; if (!condition) throw new Error(message); }
async function expectCursorRefused(operation, message) {
  try { await operation(); } catch (error) {
    if (typeof error?.getStatus === 'function' && error.getStatus() === 400 && error.getResponse()?.code === 'INVALID_CURSOR') { assertions += 1; return; }
    throw error;
  }
  throw new Error(message);
}

async function cleanup() {
  await administrator.query('BEGIN');
  try {
    for (const table of ['outbox_events', 'audit_events', 'idempotency_records']) await administrator.query(`DELETE FROM hon.${table} WHERE organization_id = $1`, [ids.organization]);
    await administrator.query('ALTER TABLE hon.saas_access_transitions DISABLE TRIGGER USER');
    await administrator.query('DELETE FROM hon.saas_access_transitions WHERE organization_id = $1', [ids.organization]);
    await administrator.query('ALTER TABLE hon.saas_access_transitions ENABLE TRIGGER USER');
    await administrator.query('DELETE FROM hon.principal_role_grants WHERE principal_id = $1', [ids.principal]);
    await administrator.query('DELETE FROM hon.roles WHERE id = $1', [ids.role]);
    await administrator.query('ALTER TABLE hon.crm_lead_attributions DISABLE TRIGGER USER');
    await administrator.query('DELETE FROM hon.crm_lead_attributions WHERE organization_id = $1', [ids.organization]);
    await administrator.query('ALTER TABLE hon.crm_lead_attributions ENABLE TRIGGER USER');
    await administrator.query('DELETE FROM hon.crm_leads WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.crm_pipeline_stages WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.crm_pipelines WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.principals WHERE id = $1', [ids.principal]);
    await administrator.query('DELETE FROM hon.users WHERE id = $1', [ids.user]);
    await administrator.query('DELETE FROM hon.people WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.schools WHERE id IN ($1, $2)', [ids.schoolA, ids.schoolB]);
    await administrator.query('DELETE FROM hon.organization_entitlements WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.organizations WHERE id = $1', [ids.organization]);
    await administrator.query('COMMIT');
  } catch (error) { await administrator.query('ROLLBACK'); throw error; }
}

// Seeds 135 people in school A (130 with leads) and 12 in school B. Timestamps deliberately collide: 60 leads share
// one exact microsecond instant, others sit one microsecond apart inside the same millisecond, and 40 people share the
// same family name, given name and created_at so only the id orders them.
async function seed() {
  await administrator.query('BEGIN');
  try {
    await administrator.query('INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, $2, $2)', [ids.organization, 'CRM List Pagination Test']);
    await administrator.query("INSERT INTO hon.organization_entitlements (organization_id, tier, effective_from) VALUES ($1, 'CORE', clock_timestamp() - interval '1 day')", [ids.organization]);
    await administrator.query(`INSERT INTO hon.schools (id, organization_id, name, slug) VALUES ($1, $2, 'Pagination School A', $3), ($4, $2, 'Pagination School B', $5)`,
      [ids.schoolA, ids.organization, `pagination-a-${ids.schoolA.slice(0, 8)}`, ids.schoolB, `pagination-b-${ids.schoolB.slice(0, 8)}`]);
    await administrator.query('INSERT INTO hon.users (id, external_subject, email, display_name) VALUES ($1, $2, $3, $4)', [ids.user, externalSubject, `pagination-${ids.user}@example.test`, 'Pagination Reader']);
    await administrator.query(`INSERT INTO hon.principals (id, principal_type, user_id, display_name) VALUES ($1, 'HUMAN_USER', $2, 'Pagination Reader')`, [ids.principal, ids.user]);
    await administrator.query(`INSERT INTO hon.roles (id, organization_id, code, name, is_system_role) VALUES ($1, $2, 'FRONT_DESK', 'Front Desk', false)`, [ids.role, ids.organization]);
    await administrator.query(`INSERT INTO hon.role_permissions (role_id, organization_id, permission_code) VALUES ($1, $2, 'crm.lead.read'), ($1, $2, 'people.read')`, [ids.role, ids.organization]);
    await administrator.query(`INSERT INTO hon.principal_role_grants (organization_id, school_id, principal_id, role_id, granted_by_principal_id)
      VALUES ($1, $2, $4, $5, $4), ($1, $3, $4, $5, $4)`, [ids.organization, ids.schoolA, ids.schoolB, ids.principal, ids.role]);
    await administrator.query(`INSERT INTO hon.crm_pipelines (id, organization_id, school_id, name) VALUES ($1, $2, $3, 'A'), ($4, $2, $5, 'B')`,
      [ids.pipelineA, ids.organization, ids.schoolA, ids.pipelineB, ids.schoolB]);
    await administrator.query(`INSERT INTO hon.crm_pipeline_stages (id, organization_id, school_id, pipeline_id, name, position) VALUES ($1, $2, $3, $4, 'New', 1), ($5, $2, $6, $7, 'New', 1)`,
      [ids.stageA, ids.organization, ids.schoolA, ids.pipelineA, ids.stageB, ids.schoolB, ids.pipelineB]);
    for (let index = 0; index < 135; index += 1) {
      const person = randomUUID();
      const tied = index < 40;
      const createdAt = tied ? '2026-01-05 10:00:00.123456+00' : `2026-01-05 10:00:00.${String(123000 + index).padStart(6, '0')}+00`;
      await administrator.query('INSERT INTO hon.people (id, organization_id, school_id, given_name, family_name, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [person, ids.organization, ids.schoolA, tied ? 'Pat' : `Given${String(index % 17).padStart(2, '0')}`, tied ? 'Same' : `Family${String(index % 9)}`, createdAt]);
      if (index < 130) {
        const leadAt = index < 60 ? '2026-02-01 08:30:00.654321+00' : `2026-02-01 08:30:00.${String(654000 + index).padStart(6, '0')}+00`;
        await administrator.query(`INSERT INTO hon.crm_leads (id, organization_id, school_id, primary_person_id, pipeline_id, pipeline_stage_id, status, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [randomUUID(), ids.organization, ids.schoolA, person, ids.pipelineA, ids.stageA, index % 3 === 0 ? 'WON' : 'OPEN', leadAt]);
      }
    }
    for (let index = 0; index < 12; index += 1) {
      const person = randomUUID();
      await administrator.query("INSERT INTO hon.people (id, organization_id, school_id, given_name, family_name) VALUES ($1, $2, $3, 'Other', 'School')", [person, ids.organization, ids.schoolB]);
      await administrator.query(`INSERT INTO hon.crm_leads (id, organization_id, school_id, primary_person_id, pipeline_id, pipeline_stage_id, status) VALUES ($1, $2, $3, $4, $5, $6, 'OPEN')`,
        [randomUUID(), ids.organization, ids.schoolB, person, ids.pipelineB, ids.stageB]);
    }
    await administrator.query('COMMIT');
  } catch (error) { await administrator.query('ROLLBACK'); throw error; }
}

async function pageAll(read, label) {
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const envelope = await read(cursor);
    assert(Array.isArray(envelope.data), `${label}: page data must stay an array`);
    assert(envelope.meta.nextCursor === null || typeof envelope.meta.nextCursor === 'string', `${label}: nextCursor must be a string or null`);
    assert(envelope.data.length <= envelope.meta.limit, `${label}: page exceeds its limit`);
    if (envelope.meta.nextCursor) assert(envelope.data.length === envelope.meta.limit, `${label}: only a full page may offer another page`);
    for (const row of envelope.data) assert(!('cursorAt' in row) && !('sortFamily' in row) && !('sortGiven' in row), `${label}: internal sort keys must not leak`);
    seen.push(...envelope.data.map((row) => row.id));
    cursor = envelope.meta.nextCursor ?? undefined;
    pages += 1;
    assert(pages < 200, `${label}: pagination did not terminate`);
  } while (cursor);
  return { seen, pages };
}

try {
  await cleanup();
  await seed();

  // 1. Leads: every school-A lead exactly once, in (created_at DESC, id DESC) order, for several page sizes.
  const expectedLeads = (await administrator.query('SELECT id FROM hon.crm_leads WHERE school_id = $1 ORDER BY created_at DESC, id DESC', [ids.schoolA])).rows.map((row) => row.id);
  assert(expectedLeads.length === 130, 'fixture must hold 130 school-A leads');
  for (const limit of [100, 50, 7, 1]) {
    const { seen, pages } = await pageAll((cursor) => leadController.list(ids.organization, ids.schoolA, { limit, ...(cursor ? { cursor } : {}) }, request), `leads limit ${limit}`);
    assert(new Set(seen).size === seen.length, `leads limit ${limit}: a lead repeated across pages`);
    assert(JSON.stringify(seen) === JSON.stringify(expectedLeads), `leads limit ${limit}: pages must cover every lead once in order`);
    assert(pages === Math.ceil(130 / limit), `leads limit ${limit}: unexpected page count ${pages}`);
  }
  const defaultFirst = await leadController.list(ids.organization, ids.schoolA, {}, request);
  assert(defaultFirst.data.length === 50 && defaultFirst.meta.limit === 50 && typeof defaultFirst.meta.nextCursor === 'string', 'default lead page stays 50 rows and now offers a next page');

  // 2. Status filter pages only its own rows; a cursor from another filter is refused.
  const expectedWon = (await administrator.query("SELECT id FROM hon.crm_leads WHERE school_id = $1 AND status = 'WON' ORDER BY created_at DESC, id DESC", [ids.schoolA])).rows.map((row) => row.id);
  const won = await pageAll((cursor) => leadController.list(ids.organization, ids.schoolA, { status: 'WON', limit: 9, ...(cursor ? { cursor } : {}) }, request), 'WON leads');
  assert(JSON.stringify(won.seen) === JSON.stringify(expectedWon), 'WON pages must cover exactly the WON leads in order');
  await expectCursorRefused(() => leadController.list(ids.organization, ids.schoolA, { status: 'WON', cursor: defaultFirst.meta.nextCursor }, request), 'an unfiltered cursor must not continue a WON list');

  // 3. A cursor never crosses schools or lists, and tampering is refused before any read.
  const schoolBLeads = await leadController.list(ids.organization, ids.schoolB, {}, request);
  assert(schoolBLeads.data.length === 12 && schoolBLeads.meta.nextCursor === null, 'school B lists only its own 12 leads on one page');
  await expectCursorRefused(() => leadController.list(ids.organization, ids.schoolB, { cursor: defaultFirst.meta.nextCursor }, request), 'a school-A lead cursor must be refused at school B');
  const decoded = JSON.parse(Buffer.from(defaultFirst.meta.nextCursor, 'base64url').toString('utf8'));
  const forged = Buffer.from(JSON.stringify({ ...decoded, k: ['2026-02-01T08:30:00.654321Z', decoded.k[1].toUpperCase()] })).toString('base64url');
  await expectCursorRefused(() => leadController.list(ids.organization, ids.schoolA, { cursor: forged }, request), 'a cursor with a non-canonical id must be refused');
  const millisecond = Buffer.from(JSON.stringify({ ...decoded, k: ['2026-02-01T08:30:00.654Z', decoded.k[1]] })).toString('base64url');
  await expectCursorRefused(() => leadController.list(ids.organization, ids.schoolA, { cursor: millisecond }, request), 'a millisecond-precision cursor must be refused');
  for (const garbage of ['not-a-cursor', '!!!', Buffer.from('[]').toString('base64url'), 'a'.repeat(1025)]) {
    await expectCursorRefused(() => leadController.list(ids.organization, ids.schoolA, { cursor: garbage }, request), `garbage cursor ${garbage.slice(0, 12)} must be refused`);
  }

  // 4. People directory: every school-A person once in directory order (ties broken by id), several page sizes.
  const expectedPeople = (await administrator.query('SELECT id FROM hon.people WHERE school_id = $1 ORDER BY family_name ASC, given_name ASC, created_at ASC, id ASC', [ids.schoolA])).rows.map((row) => row.id);
  assert(expectedPeople.length === 135, 'fixture must hold 135 school-A people');
  for (const limit of [100, 50, 7]) {
    const { seen } = await pageAll((cursor) => personController.list(ids.organization, ids.schoolA, { limit, ...(cursor ? { cursor } : {}) }, request), `people limit ${limit}`);
    assert(new Set(seen).size === seen.length, `people limit ${limit}: a person repeated across pages`);
    assert(JSON.stringify(seen) === JSON.stringify(expectedPeople), `people limit ${limit}: pages must cover every person once in directory order`);
  }
  const peopleDefault = await personController.list(ids.organization, ids.schoolA, {}, request);
  assert(peopleDefault.data.length === 50 && typeof peopleDefault.meta.nextCursor === 'string', 'default people page stays 50 rows and offers a next page');

  // 5. Search pages stay inside the search and a cursor is bound to its search text.
  const expectedSame = (await administrator.query("SELECT id FROM hon.people WHERE school_id = $1 AND family_name = 'Same' ORDER BY family_name, given_name, created_at, id", [ids.schoolA])).rows.map((row) => row.id);
  const same = await pageAll((cursor) => personController.list(ids.organization, ids.schoolA, { query: 'Same', limit: 6, ...(cursor ? { cursor } : {}) }, request), 'people search');
  assert(expectedSame.length === 40 && JSON.stringify(same.seen) === JSON.stringify(expectedSame), 'searched pages cover exactly the 40 tied matches by id');
  const searchFirst = await personController.list(ids.organization, ids.schoolA, { query: 'Same', limit: 6 }, request);
  await expectCursorRefused(() => personController.list(ids.organization, ids.schoolA, { cursor: searchFirst.meta.nextCursor }, request), 'a search cursor must not continue the unfiltered directory');
  await expectCursorRefused(() => personController.list(ids.organization, ids.schoolB, { query: 'Same', cursor: searchFirst.meta.nextCursor }, request), 'a school-A people cursor must be refused at school B');
  await expectCursorRefused(() => personController.list(ids.organization, ids.schoolA, { cursor: defaultFirst.meta.nextCursor }, request), 'a lead cursor must not page the people directory');
  const schoolBPeople = await personController.list(ids.organization, ids.schoolB, {}, request);
  assert(schoolBPeople.data.length === 12 && schoolBPeople.meta.nextCursor === null, 'school B directory lists only its own 12 people');

  // 6. Reads stay read-only: no audit, outbox or idempotency rows were written by any page.
  const effects = (await administrator.query(`SELECT
      (SELECT count(*) FROM hon.audit_events WHERE organization_id = $1)::int AS audit,
      (SELECT count(*) FROM hon.outbox_events WHERE organization_id = $1)::int AS outbox,
      (SELECT count(*) FROM hon.idempotency_records WHERE organization_id = $1)::int AS idempotency`, [ids.organization])).rows[0];
  assert(effects.audit === 0 && effects.outbox === 0 && effects.idempotency === 0, `paged reads must have no effects (${JSON.stringify(effects)})`);

  console.log(`CRM list pagination integrity: ${assertions} assertions passed (leads 130 rows x 4 page sizes, WON filter, people 135 rows x 3 page sizes, tied search, cursor binding and forgery refusals, zero effects).`);
} finally {
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await administrator.end();
  await database.onModuleDestroy?.();
}
