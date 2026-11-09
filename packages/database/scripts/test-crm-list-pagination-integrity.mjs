/**
 * B-CRM-4 list pagination proof: the CRM lead list and the school people directory page through every row of the
 * exact school with a signed opaque keyset cursor.
 *
 * Real path: signed HON session cookie -> Nest HonIdentityGuard + global ValidationPipe (as in main.ts) ->
 * LeadController / PersonController -> restricted runtime role with forced RLS, on the guarded disposable CRM-close
 * fixture only. Synthetic names; nothing leaves localhost.
 */
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CRM_CLOSE_OWNER_ROLE, CRM_CLOSE_RUNTIME_ROLE, crmCloseProofTargets, verifyCrmCloseProofConnection } from './crm-close-proof-target.mjs';

// 1. Socket-free guard negatives first, then the real targets, before any API module is loaded or any client exists.
await import('./test-crm-close-proof-target.mjs');
const targets = crmCloseProofTargets(process.env);

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const apiRequire = createRequire(resolve(repo, 'apps/api/package.json'));
apiRequire('reflect-metadata');
const { Test } = apiRequire('@nestjs/testing');
const { ValidationPipe } = apiRequire('@nestjs/common');
const { HttpAdapterHost } = apiRequire('@nestjs/core');
const { issueSession, HON_SESSION_COOKIE } = await import(pathToFileURL(apiRequire.resolve('@hon/auth')).href);
const load = (path) => import(pathToFileURL(resolve(repo, 'apps/api/dist', path)).href);
const { RuntimeDatabaseService } = await load('foundation/runtime-database.service.js');
const { HonIdentityGuard } = await load('foundation/hon-identity.guard.js');
const { HonIdentityService } = await load('foundation/hon-identity.service.js');
const { HonExceptionFilter } = await load('observability/http-telemetry.js');
const { LeadService } = await load('crm/lead.service.js');
const { LeadController } = await load('crm/lead.controller.js');
const { PersonService } = await load('people/person.service.js');
const { PersonController } = await load('people/person.controller.js');
const { MAX_LIST_CURSOR_LENGTH } = await load('foundation/list-cursor.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
{
  const probe = new pg.Client(targets.runtime);
  await probe.connect();
  try { await verifyCrmCloseProofConnection(probe, CRM_CLOSE_RUNTIME_ROLE); } finally { await probe.end(); }
}

// Disposable per-run signing material; never a real credential. It also keys the list cursors (HKDF, domain-separated).
const session = { mode: 'OIDC', audience: 'hon-crm-list-pagination', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const ids = Object.fromEntries(['organization', 'schoolA', 'schoolB', 'user', 'principal', 'role', 'pipelineA', 'pipelineB', 'stageA', 'stageB']
  .map((key) => [key, randomUUID()]));
const subject = `crm-list-pagination-${randomUUID()}`;
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
const HANGUL = (seed, length) => Array.from({ length }, (_, i) => String.fromCharCode(0xac00 + ((seed * 131 + i * 7) % 11172))).join('');

let app, origin;
async function startApp() {
  const database = new RuntimeDatabaseService();
  const module = await Test.createTestingModule({
    controllers: [LeadController, PersonController],
    providers: [HonIdentityGuard, HonIdentityService, LeadService, PersonService, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}

function get(path, query = {}) {
  const target = new URL(`${origin}/v1/organizations/${ids.organization}/${path}`);
  for (const [key, value] of Object.entries(query)) if (value !== undefined) target.searchParams.set(key, String(value));
  return new Promise((resolvePromise, reject) => {
    const request = http.request(target, { method: 'GET', headers: {
      Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: subject }, session)}`,
      Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Accept: 'application/json',
    } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => { try { resolvePromise({ status: response.statusCode, body: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    request.on('error', reject);
    request.end();
  });
}
const leads = (school, query) => get(`schools/${school}/crm/leads`, query);
const people = (school, query) => get(`schools/${school}/people`, query);
async function page(read, label) {
  const { status, body } = await read();
  assert.equal(status, 200, `${label}: expected HTTP 200, got ${status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}
async function refused(read, expectedStatus, expectedCode, label) {
  const { status, body } = await read();
  assert.equal(status, expectedStatus, `${label}: expected HTTP ${expectedStatus}, got ${status} ${JSON.stringify(body).slice(0, 300)}`);
  if (expectedCode) assert.equal(body.code, expectedCode, `${label}: expected ${expectedCode}, got ${JSON.stringify(body).slice(0, 300)}`);
  ok(!('data' in body), `${label}: a refusal returns no rows`);
}

async function pageAll(read, label) {
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const body = await page(() => read(cursor), `${label} page ${pages + 1}`);
    ok(Array.isArray(body.data), `${label}: data stays an array`);
    ok(body.meta.nextCursor === null || (typeof body.meta.nextCursor === 'string' && body.meta.nextCursor.length <= MAX_LIST_CURSOR_LENGTH), `${label}: nextCursor is null or a bounded string`);
    ok(body.data.length <= body.meta.limit, `${label}: page exceeds its limit`);
    if (body.meta.nextCursor) ok(body.data.length === body.meta.limit, `${label}: only a full page offers another page`);
    for (const row of body.data) ok(!('cursorAt' in row), `${label}: internal sort keys never leak`);
    seen.push(...body.data.map((row) => row.id));
    cursor = body.meta.nextCursor ?? undefined;
    pages += 1;
    assert.ok(pages < 400, `${label}: pagination did not terminate`);
  } while (cursor);
  return { seen, pages };
}

async function cleanup() {
  await sql('BEGIN');
  try {
    for (const table of ['outbox_events', 'audit_events', 'idempotency_records']) await sql(`DELETE FROM hon.${table} WHERE organization_id = $1`, [ids.organization]);
    // Immutable evidence tables: disposable-fixture cleanup only, inside this transaction, on the guarded fixture.
    await sql('ALTER TABLE hon.saas_access_transitions DISABLE TRIGGER USER');
    await sql('DELETE FROM hon.saas_access_transitions WHERE organization_id = $1', [ids.organization]);
    await sql('ALTER TABLE hon.saas_access_transitions ENABLE TRIGGER USER');
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id = $1', [ids.principal]);
    await sql('DELETE FROM hon.role_permissions WHERE role_id = $1', [ids.role]);
    await sql('DELETE FROM hon.roles WHERE id = $1', [ids.role]);
    await sql('ALTER TABLE hon.crm_lead_attributions DISABLE TRIGGER USER');
    await sql('DELETE FROM hon.crm_lead_attributions WHERE organization_id = $1', [ids.organization]);
    await sql('ALTER TABLE hon.crm_lead_attributions ENABLE TRIGGER USER');
    await sql('DELETE FROM hon.crm_leads WHERE organization_id = $1', [ids.organization]);
    await sql('DELETE FROM hon.crm_pipeline_stages WHERE organization_id = $1', [ids.organization]);
    await sql('DELETE FROM hon.crm_pipelines WHERE organization_id = $1', [ids.organization]);
    await sql('DELETE FROM hon.principals WHERE id = $1', [ids.principal]);
    await sql('DELETE FROM hon.users WHERE id = $1', [ids.user]);
    await sql('DELETE FROM hon.people WHERE organization_id = $1', [ids.organization]);
    await sql('DELETE FROM hon.schools WHERE id IN ($1, $2)', [ids.schoolA, ids.schoolB]);
    await sql('DELETE FROM hon.organization_entitlements WHERE organization_id = $1', [ids.organization]);
    await sql('DELETE FROM hon.organizations WHERE id = $1', [ids.organization]);
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}

// School A: 130 leads (60 sharing one microsecond instant, the rest one microsecond apart in one millisecond) over
// 135 people (40 sharing name and created_at, so only the id orders them), plus 9 people with 120-character Korean
// given and family names (the API input maximum) and 3 with 400-character Korean names (stored text has no bound).
// School B: 12 people and 12 leads.
async function seed() {
  await sql('BEGIN');
  try {
    await sql('INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, $2, $2)', [ids.organization, 'CRM List Pagination Test']);
    await sql("INSERT INTO hon.organization_entitlements (organization_id, tier, effective_from) VALUES ($1, 'CORE', clock_timestamp() - interval '1 day')", [ids.organization]);
    await sql(`INSERT INTO hon.schools (id, organization_id, name, slug) VALUES ($1, $2, 'Pagination School A', $3), ($4, $2, 'Pagination School B', $5)`,
      [ids.schoolA, ids.organization, `pagination-a-${ids.schoolA.slice(0, 8)}`, ids.schoolB, `pagination-b-${ids.schoolB.slice(0, 8)}`]);
    await sql('INSERT INTO hon.users (id, external_subject, email, display_name) VALUES ($1, $2, $3, $4)', [ids.user, subject, `pagination-${ids.user}@example.test`, 'Pagination Reader']);
    await sql(`INSERT INTO hon.principals (id, principal_type, user_id, display_name) VALUES ($1, 'HUMAN_USER', $2, 'Pagination Reader')`, [ids.principal, ids.user]);
    await sql(`INSERT INTO hon.roles (id, organization_id, code, name, is_system_role) VALUES ($1, $2, 'FRONT_DESK', 'Front Desk', false)`, [ids.role, ids.organization]);
    await sql(`INSERT INTO hon.role_permissions (role_id, organization_id, permission_code) VALUES ($1, $2, 'crm.lead.read'), ($1, $2, 'people.read')`, [ids.role, ids.organization]);
    await sql(`INSERT INTO hon.principal_role_grants (organization_id, school_id, principal_id, role_id, granted_by_principal_id)
      VALUES ($1, $2, $4, $5, $4), ($1, $3, $4, $5, $4)`, [ids.organization, ids.schoolA, ids.schoolB, ids.principal, ids.role]);
    await sql(`INSERT INTO hon.crm_pipelines (id, organization_id, school_id, name) VALUES ($1, $2, $3, 'A'), ($4, $2, $5, 'B')`,
      [ids.pipelineA, ids.organization, ids.schoolA, ids.pipelineB, ids.schoolB]);
    await sql(`INSERT INTO hon.crm_pipeline_stages (id, organization_id, school_id, pipeline_id, name, position) VALUES ($1, $2, $3, $4, 'New', 1), ($5, $2, $6, $7, 'New', 1)`,
      [ids.stageA, ids.organization, ids.schoolA, ids.pipelineA, ids.stageB, ids.schoolB, ids.pipelineB]);
    for (let index = 0; index < 135; index += 1) {
      const person = randomUUID();
      const tied = index < 40;
      const createdAt = tied ? '2026-01-05 10:00:00.123456+00' : `2026-01-05 10:00:00.${String(123000 + index).padStart(6, '0')}+00`;
      await sql('INSERT INTO hon.people (id, organization_id, school_id, given_name, family_name, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [person, ids.organization, ids.schoolA, tied ? 'Pat' : `Given${String(index % 17).padStart(2, '0')}`, tied ? 'Same' : `Family${String(index % 9)}`, createdAt]);
      if (index < 130) {
        const leadAt = index < 60 ? '2026-02-01 08:30:00.654321+00' : `2026-02-01 08:30:00.${String(654000 + index).padStart(6, '0')}+00`;
        await sql(`INSERT INTO hon.crm_leads (id, organization_id, school_id, primary_person_id, pipeline_id, pipeline_stage_id, status, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [randomUUID(), ids.organization, ids.schoolA, person, ids.pipelineA, ids.stageA, index % 3 === 0 ? 'WON' : 'OPEN', leadAt]);
      }
    }
    for (let index = 0; index < 12; index += 1) {
      const length = index < 9 ? 120 : 400;
      await sql('INSERT INTO hon.people (id, organization_id, school_id, given_name, family_name) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), ids.organization, ids.schoolA, HANGUL(index, length), `김${HANGUL(index + 50, length - 1)}`]);
    }
    for (let index = 0; index < 12; index += 1) {
      const person = randomUUID();
      await sql("INSERT INTO hon.people (id, organization_id, school_id, given_name, family_name) VALUES ($1, $2, $3, 'Other', 'School')", [person, ids.organization, ids.schoolB]);
      await sql(`INSERT INTO hon.crm_leads (id, organization_id, school_id, primary_person_id, pipeline_id, pipeline_stage_id, status) VALUES ($1, $2, $3, $4, $5, $6, 'OPEN')`,
        [randomUUID(), ids.organization, ids.schoolB, person, ids.pipelineB, ids.stageB]);
    }
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}

const tamper = (cursor, change) => {
  const [payload, signature] = cursor.split('.');
  const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  return `${Buffer.from(JSON.stringify(change(body)), 'utf8').toString('base64url')}.${signature}`;
};

try {
  await cleanup();
  await seed();
  await startApp();

  // 2. Leads: every school-A lead exactly once in (created_at DESC, id DESC) order, for several page sizes.
  const expectedLeads = (await sql('SELECT id FROM hon.crm_leads WHERE school_id = $1 ORDER BY created_at DESC, id DESC', [ids.schoolA])).rows.map((row) => row.id);
  ok(expectedLeads.length === 130, 'fixture holds 130 school-A leads');
  for (const limit of [100, 50, 7, 1]) {
    const { seen, pages } = await pageAll((cursor) => leads(ids.schoolA, { limit, cursor }), `leads limit ${limit}`);
    ok(new Set(seen).size === seen.length, `leads limit ${limit}: no lead repeated`);
    ok(JSON.stringify(seen) === JSON.stringify(expectedLeads), `leads limit ${limit}: every lead once, in order`);
    ok(pages === Math.ceil(130 / limit), `leads limit ${limit}: page count ${pages}`);
  }
  const firstLeads = await page(() => leads(ids.schoolA), 'default lead page');
  ok(firstLeads.data.length === 50 && firstLeads.meta.limit === 50 && typeof firstLeads.meta.nextCursor === 'string', 'default lead page stays 50 rows and offers a next page');
  const leadCursor = firstLeads.meta.nextCursor;

  // 3. Status filter pages inside its filter; a cursor from another filter, school or list is refused.
  const expectedWon = (await sql("SELECT id FROM hon.crm_leads WHERE school_id = $1 AND status = 'WON' ORDER BY created_at DESC, id DESC", [ids.schoolA])).rows.map((row) => row.id);
  const won = await pageAll((cursor) => leads(ids.schoolA, { status: 'WON', limit: 9, cursor }), 'WON leads');
  ok(JSON.stringify(won.seen) === JSON.stringify(expectedWon), 'WON pages cover exactly the WON leads in order');
  await refused(() => leads(ids.schoolA, { status: 'WON', cursor: leadCursor }), 400, 'INVALID_CURSOR', 'unfiltered cursor on WON list');
  await refused(() => leads(ids.schoolB, { cursor: leadCursor }), 400, 'INVALID_CURSOR', 'school-A lead cursor at school B');
  await refused(() => people(ids.schoolA, { cursor: leadCursor }), 400, 'INVALID_CURSOR', 'lead cursor on the people directory');
  const schoolB = await page(() => leads(ids.schoolB), 'school B leads');
  ok(schoolB.data.length === 12 && schoolB.meta.nextCursor === null, 'school B lists only its own 12 leads');

  // 4. Valid-shaped tampering of every position key, client-minted signatures and garbage are all refused (P2-166-2).
  const [leadAt, leadId] = JSON.parse(Buffer.from(leadCursor.split('.')[0], 'base64url').toString('utf8')).k;
  const tampered = {
    'timestamp +1 microsecond': tamper(leadCursor, (b) => ({ ...b, k: [leadAt.replace(/\d(?=Z$)/, (d) => String((Number(d) + 1) % 10)), leadId] })),
    'timestamp one year earlier': tamper(leadCursor, (b) => ({ ...b, k: [leadAt.replace(/^\d{4}/, (y) => String(Number(y) - 1)), leadId] })),
    'another real lead id': tamper(leadCursor, (b) => ({ ...b, k: [leadAt, expectedLeads[120]] })),
    'impossible calendar date': tamper(leadCursor, (b) => ({ ...b, k: ['2026-02-30T08:30:00.654321Z', leadId] })),
    'impossible clock time': tamper(leadCursor, (b) => ({ ...b, k: ['2026-02-01T99:99:99.654321Z', leadId] })),
    'extra payload field': tamper(leadCursor, (b) => ({ ...b, school: ids.schoolA })),
    'client-minted signature': `${leadCursor.split('.')[0]}.${randomBytes(32).toString('base64url')}`,
    'unsigned payload': leadCursor.split('.')[0],
    garbage: 'not-a-cursor',
  };
  for (const [label, cursor] of Object.entries(tampered)) await refused(() => leads(ids.schoolA, { cursor }), 400, 'INVALID_CURSOR', label);
  await refused(() => leads(ids.schoolA, { cursor: `${leadCursor}${'A'.repeat(MAX_LIST_CURSOR_LENGTH)}` }), 400, undefined, 'over-long cursor (ValidationPipe)');
  await refused(() => leads(ids.schoolA, { limit: 101 }), 400, undefined, 'limit above 100 (ValidationPipe)');

  // 5. People directory: every school-A person once in directory order (ties broken by id), several page sizes.
  const expectedPeople = (await sql('SELECT id FROM hon.people WHERE school_id = $1 ORDER BY family_name, given_name, created_at, id', [ids.schoolA])).rows.map((row) => row.id);
  ok(expectedPeople.length === 147, 'fixture holds 147 school-A people');
  for (const limit of [100, 50, 7]) {
    const { seen } = await pageAll((cursor) => people(ids.schoolA, { limit, cursor }), `people limit ${limit}`);
    ok(new Set(seen).size === seen.length, `people limit ${limit}: no person repeated`);
    ok(JSON.stringify(seen) === JSON.stringify(expectedPeople), `people limit ${limit}: every person once, in directory order`);
  }

  // 6. Korean boundary names (P2-166-3): every Korean row is a page boundary at limit 1, and every cursor still fits.
  const expectedKorean = (await sql("SELECT id FROM hon.people WHERE school_id = $1 AND family_name LIKE '김%' ORDER BY family_name, given_name, created_at, id", [ids.schoolA])).rows.map((row) => row.id);
  const korean = await pageAll((cursor) => people(ids.schoolA, { query: '김', limit: 1, cursor }), 'Korean search limit 1');
  ok(expectedKorean.length === 12 && JSON.stringify(korean.seen) === JSON.stringify(expectedKorean), 'all 12 Korean-named people page through one at a time, including 120- and 400-character names');
  const koreanFirst = await page(() => people(ids.schoolA, { query: '김', limit: 1 }), 'Korean first page');
  ok(!Buffer.from(koreanFirst.meta.nextCursor.split('.')[0], 'base64url').toString('utf8').includes('김'), 'no name or search text travels in a cursor');

  // 7. Search pages stay inside the search; cursors are bound to their search text and school.
  const expectedSame = (await sql("SELECT id FROM hon.people WHERE school_id = $1 AND family_name = 'Same' ORDER BY family_name, given_name, created_at, id", [ids.schoolA])).rows.map((row) => row.id);
  const same = await pageAll((cursor) => people(ids.schoolA, { query: 'Same', limit: 6, cursor }), 'people search');
  ok(expectedSame.length === 40 && JSON.stringify(same.seen) === JSON.stringify(expectedSame), 'searched pages cover exactly the 40 tied matches by id');
  const searchFirst = await page(() => people(ids.schoolA, { query: 'Same', limit: 6 }), 'search first page');
  await refused(() => people(ids.schoolA, { cursor: searchFirst.meta.nextCursor }), 400, 'INVALID_CURSOR', 'search cursor on unfiltered directory');
  await refused(() => people(ids.schoolB, { query: 'Same', cursor: searchFirst.meta.nextCursor }), 400, 'INVALID_CURSOR', 'school-A people cursor at school B');
  await refused(() => people(ids.schoolA, { query: 'Same', cursor: tamper(searchFirst.meta.nextCursor, (b) => ({ ...b, k: [expectedSame[30], b.k[1]] })) }), 400, 'INVALID_CURSOR', 'people cursor retargeted to another person');

  // 8. An anchor edited between pages refuses the stale position instead of skipping rows; the first page reloads.
  const anchorPage = await page(() => people(ids.schoolA, { limit: 5 }), 'anchor first page');
  const anchorId = anchorPage.data.at(-1).id;
  await sql("UPDATE hon.people SET family_name = family_name || ' (edited)', version = version + 1 WHERE id = $1", [anchorId]);
  await refused(() => people(ids.schoolA, { limit: 5, cursor: anchorPage.meta.nextCursor }), 400, 'INVALID_CURSOR', 'edited anchor');
  await sql("UPDATE hon.people SET family_name = replace(family_name, ' (edited)', ''), version = version + 1 WHERE id = $1", [anchorId]);
  ok((await page(() => people(ids.schoolA, { limit: 5 }), 'reloaded first page')).data.length === 5, 'reloading the first page recovers');

  // 9. Authority is re-decided on every page: permission loss or suspension between pages refuses page two.
  const peopleCursor = (await page(() => people(ids.schoolA, { limit: 10 }), 'people page one')).meta.nextCursor;
  await sql("DELETE FROM hon.role_permissions WHERE role_id = $1 AND permission_code = 'crm.lead.read'", [ids.role]);
  await refused(() => leads(ids.schoolA, { cursor: leadCursor }), 403, undefined, 'lead page two after crm.lead.read removed');
  await sql("INSERT INTO hon.role_permissions (role_id, organization_id, permission_code) VALUES ($1, $2, 'crm.lead.read')", [ids.role, ids.organization]);
  await sql("DELETE FROM hon.role_permissions WHERE role_id = $1 AND permission_code = 'people.read'", [ids.role]);
  await refused(() => people(ids.schoolA, { limit: 10, cursor: peopleCursor }), 403, undefined, 'people page two after people.read removed');
  await sql("INSERT INTO hon.role_permissions (role_id, organization_id, permission_code) VALUES ($1, $2, 'people.read')", [ids.role, ids.organization]);
  for (const [label, statement, id] of [['school', 'UPDATE hon.schools SET status = $2 WHERE id = $1', ids.schoolA], ['organization', 'UPDATE hon.organizations SET status = $2 WHERE id = $1', ids.organization]]) {
    await sql(statement, [id, 'SUSPENDED']);
    await refused(() => leads(ids.schoolA, { cursor: leadCursor }), 403, undefined, `lead page two after ${label} suspension`);
    await refused(() => people(ids.schoolA, { limit: 10, cursor: peopleCursor }), 403, undefined, `people page two after ${label} suspension`);
    await sql(statement, [id, 'ACTIVE']);
  }
  await sql("UPDATE hon.organization_entitlements SET status = 'SUSPENDED' WHERE organization_id = $1", [ids.organization]);
  await refused(() => leads(ids.schoolA, { cursor: leadCursor }), 403, 'TIER_ENTITLEMENT_REQUIRED', 'lead page two after entitlement suspension');
  await sql("UPDATE hon.organization_entitlements SET status = 'ACTIVE' WHERE organization_id = $1", [ids.organization]);
  ok((await page(() => leads(ids.schoolA, { cursor: leadCursor }), 'lead page two after restoration')).data.length === 50, 'restoration restores page two');

  // 10. Reads stay read-only.
  const effects = (await sql(`SELECT (SELECT count(*) FROM hon.audit_events WHERE organization_id = $1)::int AS audit,
      (SELECT count(*) FROM hon.outbox_events WHERE organization_id = $1)::int AS outbox,
      (SELECT count(*) FROM hon.idempotency_records WHERE organization_id = $1)::int AS idempotency`, [ids.organization])).rows[0];
  ok(effects.audit === 0 && effects.outbox === 0 && effects.idempotency === 0, `paged reads have no effects (${JSON.stringify(effects)})`);

  console.log(`CRM list pagination integrity (signed HTTP): ${checks} checks passed. Leads 130 rows at 4 page sizes, WON filter, people 147 rows at 3 page sizes, 12 Korean boundary names (120 and 400 characters) one per page, tied search, cross-school/list/filter, ${Object.keys(tampered).length} tampered and over-long cursors refused, edited anchor refused, page two refused after permission loss, school, organization and entitlement suspension, zero effects.`);
} finally {
  try { await app?.close(); } finally {
    try { await cleanup(); } finally { await admin.end(); }
  }
}
