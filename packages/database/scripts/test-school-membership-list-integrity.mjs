/**
 * U6 school-wide membership list proof (0220): GET /v1/organizations/:org/schools/:school/billing/memberships over
 * signed HTTP (HON session cookie -> HonIdentityGuard + global ValidationPipe + HonExceptionFilter -> controller ->
 * hon.read_school_membership_list on the restricted runtime role with forced RLS), on the guarded disposable CRM-close
 * fixture only. Confirmed dates come from the real two-step activation service; bulk rows and microsecond ties are
 * written by the disposable owner through the shared membership fixture writer. Synthetic names only.
 */
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CRM_CLOSE_OWNER_ROLE, CRM_CLOSE_RUNTIME_ROLE, crmCloseProofTargets, verifyCrmCloseProofConnection } from './crm-close-proof-target.mjs';
import { confirmationFor, membershipFixtureStatement } from './membership-activation-test-support.mjs';

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
const { SchoolMembershipListController, SchoolMembershipListHumanUiGuard } = await load('billing/school-membership-list.controller.js');
const { SchoolMembershipListService } = await load('billing/school-membership-list.service.js');
const { BillingAccountService } = await load('billing/billing-account.service.js');
const { MembershipService } = await load('billing/membership.service.js');
const { MembershipDateRevisionService } = await load('billing/membership-date-revision.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
{ const probe = new pg.Client(targets.runtime); await probe.connect(); try { await verifyCrmCloseProofConnection(probe, CRM_CLOSE_RUNTIME_ROLE); } finally { await probe.end(); } }

const session = { mode: 'OIDC', audience: 'hon-school-membership-list', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'otherSchool'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
let app, origin;
const database = new RuntimeDatabaseService();
const services = { accounts: new BillingAccountService(database), memberships: new MembershipService(database), dates: new MembershipDateRevisionService(database) };

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [SchoolMembershipListController],
    providers: [HonIdentityGuard, HonIdentityService, SchoolMembershipListHumanUiGuard, SchoolMembershipListService, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}
function list(actor, query = {}, { school = actor.school, organization = actor.org, headers = {} } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/billing/memberships`);
  for (const [key, value] of Object.entries(query)) if (value !== undefined) target.searchParams.set(key, String(value));
  return new Promise((resolvePromise, reject) => {
    const request = http.request(target, { method: 'GET', headers: {
      Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session)}`,
      Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Accept: 'application/json', ...headers,
    } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => { try { resolvePromise({ status: response.statusCode, headers: response.headers, body: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    request.on('error', reject);
    request.end();
  });
}
async function page(read, label) {
  const { status, body, headers } = await read();
  assert.equal(status, 200, `${label}: expected 200, got ${status} ${JSON.stringify(body).slice(0, 300)}`);
  ok(headers['cache-control'] === 'private, no-store', `${label}: never cached`);
  ok(Object.keys(body.meta).sort().join(',') === 'correlationId,limit,localToday,nextCursor,requestId,schoolTimezone', `${label}: closed meta`);
  return body;
}
async function refused(read, expectedStatus, expectedCode, label) {
  const { status, body } = await read();
  assert.equal(status, expectedStatus, `${label}: expected ${expectedStatus}, got ${status} ${JSON.stringify(body).slice(0, 300)}`);
  if (expectedCode) assert.equal(body.code, expectedCode, `${label}: expected ${expectedCode}, got ${JSON.stringify(body).slice(0, 300)}`);
  ok(!('data' in body), `${label}: a refusal returns no rows`);
}
async function pageAll(read, label) {
  const seen = []; let cursor; let pages = 0;
  do {
    const body = await page(() => read(cursor), `${label} page ${pages + 1}`);
    ok(body.data.length <= body.meta.limit && (!body.meta.nextCursor || body.data.length === body.meta.limit), `${label}: page size`);
    ok(!body.meta.nextCursor || body.meta.nextCursor.length <= 512, `${label}: bounded cursor`);
    seen.push(...body.data);
    cursor = body.meta.nextCursor ?? undefined; pages += 1;
    assert.ok(pages < 300, `${label}: pagination did not terminate`);
  } while (cursor);
  return seen;
}

// Disposable-fixture cleanup only: every organization-scoped row of the two synthetic organizations, user triggers
// (immutable evidence guards) disabled per table inside one transaction, repeated until foreign keys settle.
async function cleanup() {
  const tables = (await sql(`SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped
    WHERE c.relnamespace='hon'::regnamespace AND c.relkind='r' ORDER BY 1`)).rows.map((row) => row.relname);
  await sql('BEGIN');
  try {
    for (let pass = 0; pass < 8; pass += 1) {
      let failed = 0;
      for (const table of tables) {
        await sql('SAVEPOINT cleanup_table');
        try {
          await sql(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);
          await sql(`DELETE FROM hon.${table} WHERE organization_id = ANY($1::uuid[])`, [[ids.organization, ids.otherOrganization]]);
          await sql(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`);
          await sql('RELEASE SAVEPOINT cleanup_table');
        } catch { failed += 1; await sql('ROLLBACK TO SAVEPOINT cleanup_table'); }
      }
      if (!failed) break;
    }
    const left = (await sql(`SELECT count(*)::int n FROM hon.memberships WHERE organization_id = ANY($1::uuid[])`, [[ids.organization, ids.otherOrganization]])).rows[0].n;
    if (left) throw new Error('fixture cleanup left memberships behind');
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`membership-list-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`membership-list-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`membership-list-${ids.organization}-%`]);
    await sql('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}

const allPermissions = (await sql('SELECT code FROM hon.permissions ORDER BY code')).rows.map((row) => row.code);
async function role(org, permissions, code) {
  const id = randomUUID();
  await sql('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,false)', [id, org, code ?? `STAFF_${id.slice(0, 8)}`]);
  for (const permission of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [id, org, permission]);
  return id;
}
async function staff(label, roles, { org = ids.organization, school = ids.schoolA } = {}) {
  const user = randomUUID(), principal = randomUUID(), subject = `membership-list-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Membership List Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Membership List Staff')", [principal, user]);
  const grants = [];
  for (const roleId of roles) {
    const grant = randomUUID();
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
    grants.push(grant);
  }
  const context = (patch = {}) => { const requestId = randomUUID(); return { organizationId: org, schoolId: school, principalId: principal, principalType: 'HUMAN_USER', source: 'HUMAN_UI',
    externalSubject: subject, requestId, correlationId: requestId, idempotencyKey: randomUUID(), ...patch }; };
  return { subject, principal, grants, org, school, context, read: (patch = {}) => context({ idempotencyKey: '', ...patch }) };
}

const expected = new Map(); // membershipId -> { state, planCode, billingAccountId, personId }
let OWN, READER, ACTIVATOR, REVISER, NONE, MIXED, OTHER_SCHOOL;
async function person(school, givenName, familyName, org = ids.organization) {
  const id = randomUUID();
  await sql('INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4,$5)', [id, org, school, givenName, familyName]);
  return id;
}
async function account(school, responsible, org = ids.organization) {
  const id = randomUUID();
  await sql('INSERT INTO hon.billing_accounts(id,organization_id,school_id,responsible_person_id) VALUES($1,$2,$3,$4)', [id, org, school, responsible]);
  return id;
}

async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Membership List Org','Membership List Org'),($2,'Membership List Other Org','Membership List Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Membership List ${slug}`, `membership-list-${slug}-${school.slice(0, 8)}`, LA]);
  }
  const ownerRole = await role(ids.organization, allPermissions, 'OWNER');
  OWN = await staff('owner', [ownerRole]);
  READER = await staff('reader', [await role(ids.organization, ['billing.membership.read'])]);
  ACTIVATOR = await staff('activator', [await role(ids.organization, ['billing.membership.activate'])]);
  REVISER = await staff('reviser', [await role(ids.organization, ['billing.membership.dates.revise'])]);
  NONE = await staff('none', [await role(ids.organization, ['people.read', 'crm.lead.read', 'reporting.view', 'billing.membership.create'])]);
  MIXED = await staff('mixed', [await role(ids.organization, ['billing.membership.read']), await role(ids.organization, ['billing.membership.read'], 'PARENT_PORTAL')]);
  OTHER_SCHOOL = await staff('other-school', [await role(ids.organization, allPermissions)], { school: ids.schoolB });

  // Confirmed dates through the real two-step activation: SCHEDULED (future start) and IN_EFFECT (start today).
  const today = (await sql('SELECT (clock_timestamp() AT TIME ZONE $1)::date::text d', [LA])).rows[0].d;
  const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  for (const [label, startDate, endDate] of [['Scheduled', addDays(today, 10), addDays(today, 40)], ['Current', today, addDays(today, 30)], ['Open', today, null]]) {
    const participant = await person(ids.schoolA, label, 'Confirmed');
    const billingAccountId = (await services.accounts.create(OWN.context(), { responsiblePersonId: participant, currency: 'USD' })).account.id;
    const planCode = `PLAN-${label.toUpperCase()}`;
    const { membership } = await services.memberships.createDraft(OWN.context(), { billingAccountId, participantPersonId: participant, planCode });
    const preview = await services.memberships.previewActivation(OWN.read(), membership.id, { startDate, endDate });
    await services.memberships.activate(OWN.context(), membership.id, confirmationFor(preview));
    expected.set(membership.id, { state: 'ACTIVE', planCode, billingAccountId, personId: participant });
  }

  // Bulk rows (fixture writer, one transaction): 30 DRAFT rows sharing one created_at microsecond (only the id orders
  // them), 10 rows one microsecond apart, legacy ACTIVE rows with and without stored instants (UNDATED), one row per
  // other lifecycle state, and rows of school B and another organization that must never appear.
  await sql('BEGIN');
  try {
    const insert = async (school, org, state, createdAt, termStart = null, termEnd = null) => {
      const participant = await person(school, `Member${expected.size}`, state === 'DRAFT' ? 'Same' : `Family${expected.size % 5}`, org);
      const billingAccountId = await account(school, participant, org);
      const id = randomUUID(), planCode = `BULK-${state}`;
      await membershipFixtureStatement(admin, `INSERT INTO hon.memberships(id,organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, org, school, billingAccountId, participant, planCode, state, termStart, termEnd, createdAt]);
      return { id, planCode, billingAccountId, personId: participant, state };
    };
    const tie = '2026-03-01T10:00:00.123456Z';
    for (let index = 0; index < 30; index += 1) { const row = await insert(ids.schoolA, ids.organization, 'DRAFT', tie); expected.set(row.id, row); }
    for (let index = 0; index < 10; index += 1) {
      const row = await insert(ids.schoolA, ids.organization, index % 2 ? 'DRAFT' : 'ACTIVE', `2026-02-01T08:00:00.${String(100000 + index).padStart(6, '0')}Z`,
        index % 2 ? null : '2026-01-01T08:00:00Z', index % 4 === 0 ? '2026-12-31T08:00:00Z' : null);
      expected.set(row.id, row);
    }
    for (const state of ['FROZEN', 'CANCELLATION_PENDING', 'CANCELLED', 'EXPIRED']) {
      const row = await insert(ids.schoolA, ids.organization, state, '2025-12-15T12:00:00.000001Z', '2025-01-01T08:00:00Z', '2025-12-31T08:00:00Z');
      expected.set(row.id, row);
    }
    { const row = await insert(ids.schoolA, ids.organization, 'ACTIVE', '2025-11-01T12:00:00.5Z'); expected.set(row.id, row); }
    for (let index = 0; index < 5; index += 1) await insert(ids.schoolB, ids.organization, 'ACTIVE', '2026-03-02T00:00:00Z', '2026-01-01T08:00:00Z');
    for (let index = 0; index < 5; index += 1) await insert(ids.otherSchool, ids.otherOrganization, 'DRAFT', '2026-03-02T00:00:00Z');
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}

const tamper = (cursor, change) => {
  const [payload, signature] = cursor.split('.');
  return `${Buffer.from(JSON.stringify(change(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))), 'utf8').toString('base64url')}.${signature}`;
};
const effects = async () => (await sql(`SELECT (SELECT count(*)::int FROM hon.audit_events WHERE organization_id=$1) audit,
  (SELECT count(*)::int FROM hon.outbox_events WHERE organization_id=$1) outbox, (SELECT count(*)::int FROM hon.idempotency_records WHERE organization_id=$1) idempotency,
  (SELECT md5(string_agg(m::text, '|' ORDER BY m.id)) FROM hon.memberships m WHERE organization_id=$1) memberships`, [ids.organization])).rows[0];

try {
  await cleanup();
  await seed();
  await startApp();
  const before = await effects();

  // 1. Every school-A membership exactly once, (created_at DESC, id DESC), at several page sizes, matching the rows.
  const order = (await sql(`SELECT id FROM hon.memberships WHERE organization_id=$1 AND school_id=$2 ORDER BY created_at DESC, id DESC`, [ids.organization, ids.schoolA])).rows.map((row) => row.id);
  ok(order.length === expected.size && order.length === 48, `fixture holds 48 school-A memberships (${order.length})`);
  let full;
  for (const limit of [100, 50, 7, 1]) {
    const rows = await pageAll((cursor) => list(READER, { limit, cursor }), `list limit ${limit}`);
    ok(JSON.stringify(rows.map((row) => row.membershipId)) === JSON.stringify(order), `limit ${limit}: every membership once, in (created_at, id) order`);
    for (const row of rows) {
      const want = expected.get(row.membershipId);
      ok(row.state === want.state && row.planCode === want.planCode && row.billingAccountId === want.billingAccountId && row.participant?.personId === want.personId, `row facts for ${row.membershipId}`);
      ok(!('cursorCreatedAt' in row) && !Object.keys(row).some((key) => /price|amount|money|minor|reason|payer|agreement|consent/i.test(key)), `no internal or money keys on ${row.membershipId}`);
    }
    full = rows;
  }
  const first = await page(() => list(READER), 'default page');
  ok(first.data.length === 48 && first.meta.limit === 50 && first.meta.nextCursor === null, 'default page is 50 rows: all 48, no cursor');
  ok(first.meta.schoolTimezone === LA && /^\d{4}-\d{2}-\d{2}$/.test(first.meta.localToday), 'meta carries the school timezone and local today');

  // 2. Reporting status equals the per-membership history read (0178) for every row; legacy hints only when undated.
  const statuses = new Map();
  for (const row of full) {
    const history = await services.dates.history(OWN.read(), row.membershipId, {});
    ok(row.effectiveStatus === history.effectiveStatus && row.datesConfirmed === history.datesConfirmed, `status of ${row.membershipId} equals history (${row.effectiveStatus} vs ${history.effectiveStatus})`);
    ok(row.datesConfirmed ? row.currentPeriod.startDate === history.currentPeriod.startDate && row.currentPeriod.endDate === history.currentPeriod.endDate
      && row.currentPeriod.periodVersion === history.currentPeriod.periodVersion && row.legacyStoredTerm === null
      : row.currentPeriod === null && row.legacyStoredTerm.termStartedAt === history.legacyStoredTerm.termStartedAt
        && row.legacyStoredTerm.termEndsAt === history.legacyStoredTerm.termEndsAt, `period facts of ${row.membershipId} equal history: ${JSON.stringify([row, history])}`);
    statuses.set(row.effectiveStatus, (statuses.get(row.effectiveStatus) ?? 0) + 1);
  }
  ok(statuses.get('SCHEDULED') === 1 && statuses.get('IN_EFFECT') === 2 && statuses.get('UNDATED') === 6 && statuses.get('DRAFT') === 35, `status spread ${JSON.stringify([...statuses])}`);
  for (const state of ['FROZEN', 'CANCELLATION_PENDING', 'CANCELLED', 'EXPIRED']) ok(statuses.get(state) === 1, `${state} returned as stored`);

  // 3. State filter: exactly the rows of that state, in order, at a small page size; the cursor is bound to the filter.
  for (const state of ['DRAFT', 'ACTIVE', 'CANCELLED', 'EXPIRED']) {
    const rows = await pageAll((cursor) => list(REVISER, { state, limit: 4, cursor }), `state ${state}`);
    ok(JSON.stringify(rows.map((row) => row.membershipId)) === JSON.stringify(order.filter((id) => expected.get(id).state === state)), `state ${state}: exactly its rows, in order`);
  }
  const draftPage = await page(() => list(READER, { state: 'DRAFT', limit: 5 }), 'draft page');
  const allPage = await page(() => list(READER, { limit: 5 }), 'unfiltered page');
  await refused(() => list(READER, { state: 'ACTIVE', limit: 5, cursor: draftPage.meta.nextCursor }), 400, 'INVALID_CURSOR', 'DRAFT cursor with ACTIVE filter');
  await refused(() => list(READER, { limit: 5, cursor: draftPage.meta.nextCursor }), 400, 'INVALID_CURSOR', 'DRAFT cursor without a filter');
  await refused(() => list(READER, { state: 'DRAFT', limit: 5, cursor: allPage.meta.nextCursor }), 400, 'INVALID_CURSOR', 'unfiltered cursor with a filter');
  await refused(() => list(OTHER_SCHOOL, { limit: 5, cursor: allPage.meta.nextCursor }), 400, 'INVALID_CURSOR', 'school-A cursor at school B');
  await refused(() => list(READER, { limit: 5, cursor: tamper(allPage.meta.nextCursor, (body) => ({ ...body, k: [body.k[0], order[0]] })) }), 400, 'INVALID_CURSOR', 'tampered cursor');
  await refused(() => list(READER, { limit: 5, cursor: allPage.meta.nextCursor.slice(0, -2) }), 400, 'INVALID_CURSOR', 'truncated signature');
  await refused(() => list(READER, { cursor: 'x'.repeat(513) }), 400, undefined, 'over-long cursor (ValidationPipe)');
  for (const query of [{ limit: 0 }, { limit: 101 }, { state: 'ARCHIVED' }, { other: 'x' }]) await refused(() => list(READER, query), 400, undefined, `bad query ${JSON.stringify(query)}`);

  // 4. Exact school and organization only; school B's own list holds only its rows.
  const schoolB = await page(() => list(OTHER_SCHOOL), 'school B list');
  ok(schoolB.data.length === 5 && schoolB.data.every((row) => !expected.has(row.membershipId)), 'school B lists only its five memberships');
  await refused(() => list(READER, {}, { school: ids.schoolB }), 403, undefined, 'school-A reader at school B');
  await refused(() => list(READER, {}, { organization: ids.otherOrganization }), 403, undefined, 'route organization mismatch');

  // 5. Authority: any of the three permissions; others, mixed family roles and unknown subjects refused.
  for (const actor of [OWN, READER, ACTIVATOR, REVISER]) ok((await page(() => list(actor, { limit: 2 }), `allowed ${actor.subject}`)).data.length === 2, `${actor.subject} may list`);
  await refused(() => list(NONE), 403, undefined, 'no membership permission');
  // The definer function decides independently of the controller's selector check.
  const direct = new SchoolMembershipListService(database);
  for (const actor of [NONE, MIXED]) {
    await assert.rejects(direct.list(actor.read(), {}), (error) => error?.getStatus?.() === 403 && error.getResponse().code === 'MEMBERSHIP_LIST_FORBIDDEN', `direct service call as ${actor.subject}`);
    checks += 1;
  }
  await assert.rejects(direct.list(READER.read({ organizationId: ids.organization, schoolId: ids.schoolB }), {}), (error) => error?.getStatus?.() === 403, 'direct call with a forged school scope');
  checks += 1;
  for (const patch of [{ principalType: 'AI_AGENT' }, { source: 'AUTOMATION' }, { actionRequestId: randomUUID() }, { delegatedByPrincipalId: OWN.principal }]) {
    await assert.rejects(direct.list(READER.read(patch), {}), (error) => error?.getStatus?.() === 403 && error.getResponse().code === 'HUMAN_COMMAND_REQUIRED', `non-human context ${JSON.stringify(patch)}`);
    checks += 1;
  }
  await refused(() => list(MIXED), 403, undefined, 'staff permission mixed with a family role');
  await refused(() => list({ ...READER, subject: `unknown-${randomUUID()}` }), 403, undefined, 'unknown subject');
  await refused(() => list(READER, {}, { headers: { 'X-Hon-Source': 'AI_AGENT' } }), 403, 'HUMAN_UI_REQUIRED', 'non-human source selector');
  await refused(() => list(READER, {}, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'cross-site request');

  // 6. Page two is refused after the permission, the school, the organization or the entitlement goes away.
  const pageTwo = async (label, change, undo) => {
    const one = await page(() => list(READER, { limit: 10 }), `${label} page one`);
    await sql(change[0], change[1]);
    try { await refused(() => list(READER, { limit: 10, cursor: one.meta.nextCursor }), 403, undefined, `page two after ${label}`); }
    finally { await sql(undo[0], undo[1]); }
    ok((await page(() => list(READER, { limit: 10, cursor: one.meta.nextCursor }), `${label} restored`)).data.length === 10, `${label} restored: page two works again`);
  };
  await pageTwo('permission revoked', ['UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(), revoked_by_principal_id=$2 WHERE id=$1', [READER.grants[0], OWN.principal]],
    ['UPDATE hon.principal_role_grants SET revoked_at=NULL, revoked_by_principal_id=NULL WHERE id=$1', [READER.grants[0]]]);
  await pageTwo('school suspended', ["UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1", [ids.schoolA]], ["UPDATE hon.schools SET status='ACTIVE' WHERE id=$1", [ids.schoolA]]);
  await pageTwo('organization suspended', ["UPDATE hon.organizations SET status='SUSPENDED' WHERE id=$1", [ids.organization]], ["UPDATE hon.organizations SET status='ACTIVE' WHERE id=$1", [ids.organization]]);
  await pageTwo('entitlement suspended', ["UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [ids.organization]],
    ["UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1", [ids.organization]]);

  // 7. Runtime can call only the list function; the private evidence stays private; reads have no effects.
  const runtime = new pg.Client(targets.runtime); await runtime.connect();
  try {
    const acl = (await runtime.query(`SELECT has_function_privilege('hon.read_school_membership_list(text,jsonb)','EXECUTE') list,
      has_table_privilege('hon.membership_effective_periods','SELECT') periods, has_table_privilege('hon.membership_date_revisions','SELECT') revisions`)).rows[0];
    ok(acl.list === true && acl.periods === false && acl.revisions === false, `runtime ACL ${JSON.stringify(acl)}`);
    await assert.rejects(runtime.query("SELECT hon.read_school_membership_list('x','{}'::jsonb)"), (error) => error.code === '42501');
    checks += 1;
  } finally { await runtime.end(); }
  const after = await effects();
  ok(JSON.stringify(after) === JSON.stringify(before), `list reads have no effects (${JSON.stringify(after)})`);

  console.log(`School membership list integrity (0220, signed HTTP): ${checks} checks passed. 48 memberships (30 sharing one microsecond, microsecond steps, real activations SCHEDULED/IN_EFFECT, legacy UNDATED, every lifecycle state) at 4 page sizes in (created_at, id) order; reporting status equal to the 0178 history read for every row; state filter; cursors bound to school and filter, tamper refused; three admitting permissions, others/mixed/unknown/non-human refused; page two refused after permission loss and school/organization/entitlement suspension; runtime ACL; zero effects.`);
} finally {
  try { await app?.close(); } finally { try { await database.close?.(); } finally { try { await cleanup(); } finally { await admin.end(); } } }
}
