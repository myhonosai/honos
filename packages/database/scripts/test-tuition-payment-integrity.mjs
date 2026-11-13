/**
 * Tuition payment records proof (B-TUI-1, 0240) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI
 * guards + global ValidationPipe + HonExceptionFilter -> TuitionPaymentController -> protected definer functions on the
 * restricted runtime role with forced RLS), on the guarded disposable CRM-close fixture only. Synthetic names and
 * amounts only; HON moves no money and no provider is reachable.
 */
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CRM_CLOSE_OWNER_ROLE, CRM_CLOSE_RUNTIME_ROLE, crmCloseProofTargets, verifyCrmCloseProofConnection } from './crm-close-proof-target.mjs';

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
const { TuitionPaymentController } = await load('billing/tuition-payment.controller.js');
const { TuitionPaymentService } = await load('billing/tuition-payment.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-tuition-payments', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'otherSchool'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
let app, origin;
const database = new RuntimeDatabaseService();
const service = new TuitionPaymentService(database);

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [TuitionPaymentController],
    providers: [HonIdentityGuard, HonIdentityService, TuitionPaymentService, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}

const COMMAND = { record: 'billing.invoice.payment.record', void: 'billing.invoice.payment.void' };
function call(actor, method, path, { body, key = randomUUID(), command, headers = {}, school = actor.school, organization = actor.org } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/billing/${path}`);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const sent = {
    Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session)}`,
    Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Accept: 'application/json',
    ...(method === 'POST' ? { 'Content-Type': 'application/json', ...(command ? { 'X-Hon-Human-Command': command } : {}), ...(key ? { 'Idempotency-Key': key } : {}) } : {}),
    ...headers,
  };
  for (const [name, value] of Object.entries(sent)) if (value === undefined) delete sent[name];
  return new Promise((resolvePromise, reject) => {
    const request = http.request(target, { method, headers: sent }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => { try { resolvePromise({ status: response.statusCode, headers: response.headers, body: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}
const receivables = (actor, query = 'filter=OPEN', options = {}) => call(actor, 'GET', `receivables${query ? `?${query}` : ''}`, options);
const payments = (actor, invoiceId, options = {}) => call(actor, 'GET', `invoices/${invoiceId}/payments`, options);
const record = (actor, invoiceId, body, options = {}) => call(actor, 'POST', `invoices/${invoiceId}/payments`, { body, command: COMMAND.record, ...options });
const voidPayment = (actor, paymentId, body, options = {}) => call(actor, 'POST', `invoice-payments/${paymentId}/void`, { body, command: COMMAND.void, ...options });

async function success(read, label) {
  const { status, body, headers } = await read();
  assert.equal(status, 200, `${label}: expected 200, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  ok(headers['cache-control'] === 'private, no-store', `${label}: never cached`);
  return body;
}
async function refused(read, expectedStatus, expectedCode, label) {
  const { status, body } = await read();
  assert.equal(status, expectedStatus, `${label}: expected ${expectedStatus}, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  if (expectedCode) assert.equal(body.code, expectedCode, `${label}: expected ${expectedCode}, got ${JSON.stringify(body).slice(0, 400)}`);
  ok(!('data' in body), `${label}: a refusal returns no data`);
}
async function rejectsSql(run, pattern, label) {
  await sql('SAVEPOINT expected_failure');
  try { await run(); } catch (error) { await sql('ROLLBACK TO SAVEPOINT expected_failure'); ok(pattern.test(error.message), `${label}: ${error.message}`); return; }
  await sql('ROLLBACK TO SAVEPOINT expected_failure');
  assert.fail(`${label}: expected a refusal`);
}

// Disposable-fixture cleanup only (as in the 0224 proof).
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
    const left = (await sql('SELECT count(*)::int n FROM hon.invoices WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]])).rows[0].n;
    if (left) throw new Error('fixture cleanup left invoices behind');
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`tuition-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`tuition-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`tuition-${ids.organization}-%`]);
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
  const user = randomUUID(), principal = randomUUID(), subject = `tuition-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Tuition Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Tuition Staff')", [principal, user]);
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
async function account(school, givenName, org = ids.organization) {
  const person = randomUUID(), id = randomUUID();
  await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4,'Tuition')", [person, org, school, givenName]);
  await sql('INSERT INTO hon.billing_accounts(id,organization_id,school_id,responsible_person_id) VALUES($1,$2,$3,$4)', [id, org, school, person]);
  return id;
}
async function invoice(school, accountId, { status = 'ISSUED', currency = 'USD', total, due = null, org = ids.organization }) {
  const id = randomUUID();
  await sql(`INSERT INTO hon.invoices(id,organization_id,school_id,billing_account_id,status,currency,subtotal_minor,total_minor,due_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$7,CASE WHEN $8::text IS NULL THEN NULL ELSE clock_timestamp()+$8::interval END)`, [id, org, school, accountId, status, currency, total, due]);
  return id;
}

let OWN, RECORDER, ISSUER, CREATOR, NONE, MIXED, OTHER_SCHOOL, OTHER_ORG, today;
const inv = {};
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Tuition Org','Tuition Org'),($2,'Tuition Other Org','Tuition Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Tuition ${slug}`, `tuition-${slug}-${school.slice(0, 8)}`, LA]);
  }
  today = (await sql('SELECT (clock_timestamp() AT TIME ZONE $1)::date::text d', [LA])).rows[0].d;
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  RECORDER = await staff('recorder', [await role(ids.organization, ['billing.invoice.payment.record'])]);
  ISSUER = await staff('issuer', [await role(ids.organization, ['billing.invoice.issue'])]);
  CREATOR = await staff('creator', [await role(ids.organization, ['billing.invoice.create'])]);
  NONE = await staff('none', [await role(ids.organization, ['people.read', 'crm.lead.read', 'reporting.view', 'billing.membership.read', 'billing.membership.refund.record'])]);
  MIXED = await staff('mixed', [await role(ids.organization, ['billing.invoice.payment.record']), await role(ids.organization, ['people.read'], 'PARENT_PORTAL')]);
  OTHER_SCHOOL = await staff('other-school', [await role(ids.organization, allPermissions)], { school: ids.schoolB });
  OTHER_ORG = await staff('other-org', [await role(ids.otherOrganization, allPermissions, 'OWNER')], { org: ids.otherOrganization, school: ids.otherSchool });
  const a1 = await account(ids.schoolA, 'Avery'), a2 = await account(ids.schoolA, 'Blake'), b1 = await account(ids.schoolB, 'Casey');
  const o1 = await account(ids.otherSchool, 'Devon', ids.otherOrganization);
  inv.A = await invoice(ids.schoolA, a1, { total: 1000, due: '-2 days' }); // overdue
  inv.B = await invoice(ids.schoolA, a2, { total: 500, due: '10 days' }); // open, not yet due
  inv.C = await invoice(ids.schoolA, a1, { currency: 'EUR', total: 700 }); // open, no due time
  inv.draft = await invoice(ids.schoolA, a1, { status: 'DRAFT', total: 900, due: '-2 days' });
  inv.voided = await invoice(ids.schoolA, a1, { status: 'VOID', total: 900, due: '-2 days' });
  inv.legacyPaid = await invoice(ids.schoolA, a2, { status: 'PAID', total: 300, due: '-30 days' }); // marked paid before 0240: no records
  inv.schoolB = await invoice(ids.schoolB, b1, { total: 400, due: '-2 days' });
  inv.otherOrg = await invoice(ids.otherSchool, o1, { total: 400, due: '-2 days', org: ids.otherOrganization });
}

const invoiceRow = async (id) => (await sql('SELECT status::text, version, total_minor FROM hon.invoices WHERE id=$1', [id])).rows[0];
const recordsOf = async (id) => (await sql('SELECT * FROM hon.invoice_payment_records WHERE invoice_id=$1 ORDER BY recorded_at, id', [id])).rows;
const untouched = async () => (await sql(`SELECT (SELECT md5(string_agg(i::text,'|' ORDER BY i.id)) FROM hon.invoices i WHERE i.id <> ALL($1::uuid[])) invoices,
  (SELECT count(*)::int FROM hon.payment_attempts) attempts, (SELECT count(*)::int FROM hon.membership_refund_records) refunds`,
  [[inv.A, inv.B, inv.C]])).rows[0];

try {
  await cleanup();
  await seed();
  await startApp();
  const before = await untouched();

  // 0. The permission exists, is sensitive and staff-assignable, and every system OWNER role holds it.
  const permission = (await sql("SELECT is_sensitive, is_staff_assignable FROM hon.permissions WHERE code='billing.invoice.payment.record'")).rows[0];
  ok(permission?.is_sensitive === true && permission?.is_staff_assignable === true, 'billing.invoice.payment.record is sensitive and staff-assignable');
  ok((await sql(`SELECT count(*)::int n FROM hon.roles r WHERE r.is_system_role AND r.code='OWNER' AND NOT EXISTS(SELECT 1 FROM hon.role_permissions rp
    WHERE rp.role_id=r.id AND rp.organization_id=r.organization_id AND rp.permission_code='billing.invoice.payment.record')`)).rows[0].n === 0, 'every system OWNER role holds the record permission');

  // 1. Unpaid balances: issued invoices with a balance only, current school only, per-currency totals.
  const open = await success(() => receivables(RECORDER), 'receivables OPEN by the recorder');
  const openIds = open.data.items.map((item) => item.invoiceId);
  ok(open.data.filter === 'OPEN' && open.data.canRecord === true && open.data.localToday === today && open.data.nextAfter === null, 'OPEN page header');
  ok(openIds.length === 3 && [inv.A, inv.B, inv.C].every((id) => openIds.includes(id)) && JSON.stringify(openIds) === JSON.stringify([...openIds].sort()), 'OPEN lists A, B and C in id order');
  ok(![inv.draft, inv.voided, inv.legacyPaid, inv.schoolB, inv.otherOrg].some((id) => openIds.includes(id)), 'drafts, voids, paid and other-school invoices are not receivables');
  ok(JSON.stringify(open.data.totals) === JSON.stringify([{ currency: 'EUR', count: 1, balanceMinor: 700 }, { currency: 'USD', count: 2, balanceMinor: 1500 }]), 'per-currency totals');
  const a = open.data.items.find((item) => item.invoiceId === inv.A);
  ok(a.overdue === true && a.paidMinor === 0 && a.balanceMinor === 1000 && a.payerName === 'Avery Tuition' && a.status === 'ISSUED' && a.version === 1, 'A is overdue with its payer');
  ok(open.data.items.find((item) => item.invoiceId === inv.B).overdue === false && open.data.items.find((item) => item.invoiceId === inv.C).dueAt === null, 'B not yet due, C has no due time');
  const overdue = await success(() => receivables(ISSUER, 'filter=OVERDUE'), 'receivables OVERDUE by an issuer');
  ok(overdue.data.items.length === 1 && overdue.data.items[0].invoiceId === inv.A && overdue.data.canRecord === false
    && JSON.stringify(overdue.data.totals) === JSON.stringify([{ currency: 'USD', count: 1, balanceMinor: 1000 }]), 'OVERDUE lists A only; an issuer cannot record');
  ok((await success(() => receivables(CREATOR, ''), 'receivables default filter by a creator')).data.filter === 'OPEN', 'the default filter is OPEN');
  const sortedIds = [...openIds].sort();
  const paged = await success(() => receivables(RECORDER, `filter=OPEN&after=${sortedIds[0]}`), 'receivables after a cursor');
  ok(JSON.stringify(paged.data.items.map((item) => item.invoiceId)) === JSON.stringify(sortedIds.slice(1)) && paged.data.totals.length === 2, 'the cursor pages by id; totals cover every match');
  ok((await success(() => receivables(OTHER_SCHOOL, 'filter=OPEN'), 'school B receivables')).data.items.map((item) => item.invoiceId).join() === inv.schoolB, 'school B sees only its own invoice');
  for (const actor of [NONE, MIXED]) await refused(() => receivables(actor), 403, undefined, `receivables refused for ${actor.subject.split('-').pop()}`);
  await refused(() => receivables(OTHER_SCHOOL, 'filter=OPEN', { school: ids.schoolA }), 403, undefined, 'school-B staff at the school-A route');
  await refused(() => receivables(OTHER_ORG, 'filter=OPEN', { school: ids.schoolA, organization: ids.organization }), 403, undefined, 'other-organization owner at the school-A route');
  for (const [label, query] of [['unknown filter', 'filter=PAID'], ['extra key', 'filter=OPEN&x=1'], ['bad cursor', 'filter=OPEN&after=nope'], ['repeated filter', 'filter=OPEN&filter=OVERDUE']]) {
    await refused(() => receivables(RECORDER, query), 400, 'VALIDATION_FAILED', `receivables validation: ${label}`);
  }
  await refused(() => receivables(RECORDER, 'filter=OPEN', { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'read with an idempotency key');
  await refused(() => receivables(RECORDER, 'filter=OPEN', { headers: { 'X-Hon-Source': 'AI_AGENT' } }), 403, 'HUMAN_UI_REQUIRED', 'read with a source header');

  // 2. Record a partial payment on A: refusals first, then the receipt, audit, inert outbox, exact replay.
  const goodA = { expectedInvoiceVersion: 1, amountMinor: 400, currency: 'USD', receivedOn: today, method: 'CASH', reference: 'Receipt 1041' };
  for (const actor of [ISSUER, CREATOR, NONE, MIXED]) await refused(() => record(actor, inv.A, goodA), 403, undefined, `record refused for ${actor.subject.split('-').pop()}`);
  await refused(() => record(OTHER_SCHOOL, inv.A, goodA, { school: ids.schoolA }), 403, undefined, 'school-B staff recording at the school-A route');
  await refused(() => record(RECORDER, inv.schoolB, goodA), 404, 'INVOICE_NOT_FOUND', 'school-B invoice through school A');
  await refused(() => record(RECORDER, inv.otherOrg, goodA), 404, 'INVOICE_NOT_FOUND', 'other-organization invoice');
  await refused(() => record(RECORDER, randomUUID(), goodA), 404, 'INVOICE_NOT_FOUND', 'unknown invoice');
  for (const [label, patch] of [['zero amount', { amountMinor: 0 }], ['string amount', { amountMinor: '400' }], ['fractional amount', { amountMinor: 1.5 }],
    ['amount above the cap', { amountMinor: 100000001 }], ['lowercase currency', { currency: 'usd' }], ['impossible date', { receivedOn: '2026-02-30' }],
    ['unknown method', { method: 'CRYPTO' }], ['long reference', { reference: 'x'.repeat(121) }], ['padded note', { note: ' late' }],
    ['control character', { note: 'pa\u0007id' }], ['extra key', { refund: true }], ['missing method', { method: undefined }]]) {
    await refused(() => record(RECORDER, inv.A, { ...goodA, ...patch }), 400, undefined, `record validation: ${label}`);
  }
  await refused(() => record(RECORDER, inv.A, { ...goodA, receivedOn: addDays(today, 1) }), 400, 'VALIDATION_FAILED', 'received in the school future');
  await refused(() => record(RECORDER, inv.A, { ...goodA, expectedInvoiceVersion: 2 }), 409, 'VERSION_CONFLICT', 'stale invoice version');
  await refused(() => record(RECORDER, inv.A, { ...goodA, currency: 'EUR' }), 422, 'INVOICE_CURRENCY_MISMATCH', 'currency mismatch');
  await refused(() => record(RECORDER, inv.A, { ...goodA, amountMinor: 1001 }), 422, 'INVOICE_PAYMENT_EXCEEDS_BALANCE', 'more than the total');
  await refused(() => record(RECORDER, inv.draft, { ...goodA }), 409, 'INVOICE_NOT_PAYABLE', 'a draft invoice');
  await refused(() => record(RECORDER, inv.voided, { ...goodA }), 409, 'INVOICE_NOT_PAYABLE', 'a void invoice');
  await refused(() => record(RECORDER, inv.legacyPaid, { ...goodA }), 409, 'INVOICE_NOT_PAYABLE', 'an invoice already paid');
  ok((await recordsOf(inv.A)).length === 0 && (await invoiceRow(inv.A)).version === 1, 'refusals wrote nothing');
  const keyA = randomUUID();
  const first = await success(() => record(RECORDER, inv.A, goodA, { key: keyA }), 'record 400 on A');
  ok(first.meta.replayed === false && first.data.payment.amountMinor === 400 && first.data.payment.method === 'CASH' && first.data.payment.reference === 'Receipt 1041'
    && first.data.payment.note === null && first.data.payment.void === null && first.data.payment.receivedOn === today, 'payment receipt');
  ok(first.data.invoice.status === 'ISSUED' && first.data.invoice.version === 2 && first.data.invoice.paidMinor === 400 && first.data.invoice.balanceMinor === 600
    && first.data.invoice.overdue === true, 'A stays ISSUED at version 2 with 600 left');
  const rowsA = await recordsOf(inv.A);
  ok(rowsA.length === 1 && rowsA[0].actor_principal_id === RECORDER.principal && rowsA[0].id === first.data.payment.paymentId, 'one record by the recorder');
  const audit = (await sql("SELECT prior_state, next_state, source FROM hon.audit_events WHERE entity_id=$1 AND action_code='billing.invoice.payment.record'", [rowsA[0].id])).rows;
  const outbox = (await sql("SELECT payload, aggregate_version FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='billing.invoice.payment_recorded'", [inv.A])).rows;
  ok(audit.length === 1 && audit[0].source === 'HUMAN_UI' && audit[0].prior_state.balanceMinor === 1000 && outbox.length === 1 && outbox[0].aggregate_version === 2, 'one audit event and one inert outbox event');
  const replay = await success(() => record(RECORDER, inv.A, goodA, { key: keyA }), 'record replay');
  ok(replay.meta.replayed === true && JSON.stringify(replay.data) === JSON.stringify(first.data) && (await recordsOf(inv.A)).length === 1, 'exact replay, no second record');
  await refused(() => record(RECORDER, inv.A, { ...goodA, amountMinor: 401 }, { key: keyA }), 409, 'IDEMPOTENCY_KEY_REUSED', 'key reused for another body');
  await refused(() => record(RECORDER, inv.A, { ...goodA, expectedInvoiceVersion: 2, amountMinor: 601 }), 422, 'INVOICE_PAYMENT_EXCEEDS_BALANCE', 'more than the remaining balance');

  // 3. The rest pays A in full: PAID, balance 0, gone from receivables, no further record.
  const second = await success(() => record(OWN, inv.A, { expectedInvoiceVersion: 2, amountMinor: 600, currency: 'USD', receivedOn: addDays(today, -1), method: 'CHECK', note: 'Check 552' }), 'record 600 on A');
  ok(second.data.invoice.status === 'PAID' && second.data.invoice.version === 3 && second.data.invoice.paidMinor === 1000 && second.data.invoice.balanceMinor === 0
    && second.data.invoice.overdue === false, 'A is PAID at version 3');
  ok(!(await success(() => receivables(RECORDER), 'receivables after A is paid')).data.items.some((item) => item.invoiceId === inv.A), 'a paid invoice is not a receivable');
  await refused(() => record(RECORDER, inv.A, { ...goodA, expectedInvoiceVersion: 3, amountMinor: 1 }), 409, 'INVOICE_NOT_PAYABLE', 'recording on a paid invoice');
  const listed = await success(() => payments(ISSUER, inv.A), 'payments of A by an issuer');
  ok(listed.data.canRecord === false && listed.data.invoice.status === 'PAID' && listed.data.payments.length === 2 && listed.data.payments[0].paymentId === second.data.payment.paymentId
    && listed.data.payments[1].paymentId === first.data.payment.paymentId, 'payments newest first');
  ok((await success(() => payments(RECORDER, inv.legacyPaid), 'payments of a legacy paid invoice')).data.invoice.balanceMinor === 0, 'a legacy PAID invoice owes nothing');
  await refused(() => payments(RECORDER, inv.draft), 404, 'INVOICE_NOT_FOUND', 'payments of a draft');
  await refused(() => payments(RECORDER, inv.schoolB), 404, 'INVOICE_NOT_FOUND', 'payments of a school-B invoice through school A');
  await refused(() => payments(NONE, inv.A), 403, undefined, 'payments refused without an admitting permission');
  await refused(() => call(RECORDER, 'GET', `invoices/${inv.A}/payments?x=1`), 400, 'VALIDATION_FAILED', 'payments read with a query string');

  // 4. Void the 600 with a reason: A returns to ISSUED with 600 open again; never deleted; not a refund.
  const goodVoid = { expectedInvoiceVersion: 3, reason: 'Check returned by the bank' };
  for (const actor of [ISSUER, CREATOR, NONE, MIXED]) await refused(() => voidPayment(actor, second.data.payment.paymentId, goodVoid), 403, undefined, `void refused for ${actor.subject.split('-').pop()}`);
  for (const [label, body] of [['missing reason', { expectedInvoiceVersion: 3 }], ['blank reason', { ...goodVoid, reason: ' ' }], ['extra key', { ...goodVoid, refund: 600 }],
    ['string version', { ...goodVoid, expectedInvoiceVersion: '3' }]]) {
    await refused(() => voidPayment(RECORDER, second.data.payment.paymentId, body), 400, undefined, `void validation: ${label}`);
  }
  await refused(() => voidPayment(RECORDER, randomUUID(), goodVoid), 404, 'INVOICE_PAYMENT_NOT_FOUND', 'void of an unknown payment');
  await refused(() => voidPayment(RECORDER, second.data.payment.paymentId, { ...goodVoid, expectedInvoiceVersion: 2 }), 409, 'VERSION_CONFLICT', 'void at a stale version');
  await refused(() => voidPayment(OTHER_SCHOOL, second.data.payment.paymentId, goodVoid), 404, 'INVOICE_PAYMENT_NOT_FOUND', 'void of a school-A payment from school B');
  const voidKey = randomUUID();
  const voided = await success(() => voidPayment(RECORDER, second.data.payment.paymentId, goodVoid, { key: voidKey }), 'void 600');
  ok(voided.data.payment.void?.reason === 'Check returned by the bank' && voided.data.invoice.status === 'ISSUED' && voided.data.invoice.version === 4
    && voided.data.invoice.paidMinor === 400 && voided.data.invoice.balanceMinor === 600, 'A is ISSUED again at version 4 with 600 left');
  const replayVoid = await success(() => voidPayment(RECORDER, second.data.payment.paymentId, goodVoid, { key: voidKey }), 'void replay');
  ok(replayVoid.meta.replayed === true && JSON.stringify(replayVoid.data) === JSON.stringify(voided.data), 'void exact replay');
  await refused(() => voidPayment(RECORDER, second.data.payment.paymentId, { ...goodVoid, expectedInvoiceVersion: 4 }), 409, 'INVOICE_PAYMENT_ALREADY_VOIDED', 'voiding twice');
  const rowsAfterVoid = await recordsOf(inv.A);
  ok(rowsAfterVoid.length === 2 && rowsAfterVoid[1].voided_by_principal_id === RECORDER.principal && rowsAfterVoid[0].voided_at === null, 'the voided record is kept');
  ok((await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='billing.invoice.payment_voided'", [inv.A])).rows[0].n === 1, 'one void outbox event');
  ok((await success(() => receivables(RECORDER), 'receivables after the void')).data.items.find((item) => item.invoiceId === inv.A)?.balanceMinor === 600, 'A is a receivable again');
  // A void that keeps the invoice covered leaves it PAID is impossible here (no overpayment), so voiding a partial payment keeps ISSUED.
  const voidFirst = await success(() => voidPayment(OWN, first.data.payment.paymentId, { expectedInvoiceVersion: 4, reason: 'Entered on the wrong invoice' }), 'void the 400');
  ok(voidFirst.data.invoice.status === 'ISSUED' && voidFirst.data.invoice.paidMinor === 0 && voidFirst.data.invoice.balanceMinor === 1000, 'A is fully open again');

  // 5. Two concurrent records against one invoice version: exactly one wins.
  const raced = await Promise.all([300, 300].map((amountMinor) => record(RECORDER, inv.B, { expectedInvoiceVersion: 1, amountMinor, currency: 'USD', receivedOn: today, method: 'BANK_TRANSFER' })));
  ok(raced.filter((r) => r.status === 200).length === 1 && raced.filter((r) => r.status === 409 && r.body.code === 'VERSION_CONFLICT').length === 1, 'one concurrent record wins, the other conflicts');
  ok((await recordsOf(inv.B)).length === 1 && (await invoiceRow(inv.B)).version === 2, 'B has one record at version 2');

  // 6. Strict browser transport.
  const goodC = { expectedInvoiceVersion: 1, amountMinor: 100, currency: 'EUR', receivedOn: today, method: 'CARD_TERMINAL' };
  await refused(() => record(RECORDER, inv.C, goodC, { command: null }), 403, 'HUMAN_UI_REQUIRED', 'missing command header');
  await refused(() => record(RECORDER, inv.C, goodC, { command: COMMAND.void }), 403, 'HUMAN_UI_REQUIRED', 'void command header on a record');
  await refused(() => record(RECORDER, inv.C, goodC, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'cross-site');
  await refused(() => record(RECORDER, inv.C, goodC, { headers: { 'X-Hon-Source': 'AI_AGENT' } }), 403, 'HUMAN_UI_REQUIRED', 'source header');
  await refused(() => record(RECORDER, inv.C, goodC, { headers: { 'X-Hon-Action-Request-Id': randomUUID() } }), 403, 'HUMAN_UI_REQUIRED', 'action request header');
  await refused(() => record(RECORDER, inv.C, goodC, { headers: { 'X-Hon-Delegated-By-Principal-Id': OWN.principal } }), 403, 'HUMAN_UI_REQUIRED', 'delegation header');
  await refused(() => record(RECORDER, inv.C, goodC, { headers: { Origin: 'https://evil.example' } }), 403, 'HUMAN_UI_REQUIRED', 'foreign origin');
  await refused(() => record(RECORDER, inv.C, goodC, { key: null }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'missing idempotency key');
  await refused(() => call(RECORDER, 'POST', `invoices/${inv.C}/payments?x=1`, { body: goodC, command: COMMAND.record }), 400, 'VALIDATION_FAILED', 'query string');
  ok((await recordsOf(inv.C)).length === 0, 'C unchanged by refused transports');

  // 7. The database decides independently of the controller: non-human context, wrong school, live access loss.
  await assert.rejects(service.record(RECORDER.context({ principalType: 'SERVICE' }), inv.C, goodC), (error) => error?.response?.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(service.record(RECORDER.context({ delegatedByPrincipalId: OWN.principal }), inv.C, goodC), (error) => error?.response?.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(service.record(ISSUER.context(), inv.C, goodC), (error) => error?.status === 403);
  await assert.rejects(service.record(RECORDER.context({ schoolId: ids.schoolB }), inv.C, goodC), (error) => error?.status === 403 || error?.status === 404);
  await assert.rejects(service.receivables(NONE.read(), { filter: 'OPEN' }), (error) => error?.status === 403);
  checks += 5;
  await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(), revoked_by_principal_id=$2 WHERE id=$1', [RECORDER.grants[0], OWN.principal]);
  await refused(() => record(RECORDER, inv.C, goodC), 403, undefined, 'record after the grant is revoked');
  await refused(() => receivables(RECORDER), 403, undefined, 'receivables after the grant is revoked');
  await sql('UPDATE hon.principal_role_grants SET revoked_at=NULL, revoked_by_principal_id=NULL WHERE id=$1', [RECORDER.grants[0]]);
  for (const [label, suspend, restore] of [
    ['grant expired', "UPDATE hon.principal_role_grants SET effective_until=clock_timestamp()-interval '1 minute' WHERE principal_id=(SELECT principal_id FROM hon.principal_role_grants WHERE id=$1)",
      'UPDATE hon.principal_role_grants SET effective_until=NULL WHERE principal_id=(SELECT principal_id FROM hon.principal_role_grants WHERE id=$1)'],
    ['school suspended', "UPDATE hon.schools SET status='SUSPENDED' WHERE id=(SELECT school_id FROM hon.principal_role_grants WHERE id=$1)",
      "UPDATE hon.schools SET status='ACTIVE' WHERE id=(SELECT school_id FROM hon.principal_role_grants WHERE id=$1)"],
    ['entitlement suspended', "UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=(SELECT organization_id FROM hon.principal_role_grants WHERE id=$1)",
      "UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=(SELECT organization_id FROM hon.principal_role_grants WHERE id=$1)"]]) {
    await sql(suspend, [RECORDER.grants[0]]);
    await refused(() => record(RECORDER, inv.C, goodC), 403, undefined, `record refused: ${label}`);
    await sql(restore, [RECORDER.grants[0]]);
  }
  const paidC = await success(() => record(RECORDER, inv.C, goodC), 'record on C after access is restored');
  ok(paidC.data.invoice.balanceMinor === 600 && paidC.data.payment.currency === 'EUR', 'C partially paid in EUR');

  // 8. Settings-free triggers: no owner write can mark paid, reopen, rewrite or delete outside the commands.
  await sql('BEGIN');
  await rejectsSql(() => sql("UPDATE hon.invoices SET status='PAID' WHERE id=$1", [inv.C]), /INVOICE_PAYMENT_STATUS_GUARD/, 'PAID without covering records');
  await rejectsSql(() => sql("UPDATE hon.invoices SET status='PAID' WHERE id=$1", [inv.draft]), /INVOICE_PAYMENT_STATUS_GUARD/, 'DRAFT -> PAID');
  await rejectsSql(() => sql("UPDATE hon.invoices SET status='VOID' WHERE id=$1", [inv.C]), /INVOICE_PAYMENT_STATUS_GUARD/, 'voiding an invoice with recorded payments');
  await rejectsSql(() => sql("UPDATE hon.invoices SET status='UNCOLLECTIBLE' WHERE id=$1", [inv.C]), /INVOICE_PAYMENT_STATUS_GUARD/, 'writing off an invoice with recorded payments');
  await rejectsSql(() => sql('UPDATE hon.invoices SET total_minor=50, subtotal_minor=50 WHERE id=$1', [inv.C]), /INVOICE_PAYMENT_STATUS_GUARD/, 'total change with recorded payments');
  await rejectsSql(() => sql("UPDATE hon.invoices SET currency='USD' WHERE id=$1", [inv.C]), /INVOICE_PAYMENT_STATUS_GUARD/, 'currency change with recorded payments');
  await rejectsSql(() => sql("UPDATE hon.invoices SET status='VOID' WHERE id=$1", [inv.legacyPaid]), /INVOICE_PAYMENT_STATUS_GUARD/, 'PAID -> VOID');
  await rejectsSql(() => sql('UPDATE hon.invoice_payment_records SET amount_minor=1 WHERE invoice_id=$1', [inv.C]), /INVOICE_PAYMENT_RECORD_IMMUTABLE/, 'record amount rewritten');
  await rejectsSql(() => sql("UPDATE hon.invoice_payment_records SET void_reason='again', voided_at=clock_timestamp() WHERE id=$1", [second.data.payment.paymentId]), /INVOICE_PAYMENT_RECORD_IMMUTABLE/, 'second void');
  await rejectsSql(() => sql('DELETE FROM hon.invoice_payment_records WHERE invoice_id=$1', [inv.A]), /INVOICE_PAYMENT_RECORD_IMMUTABLE/, 'record deleted');
  await rejectsSql(() => sql('TRUNCATE hon.invoice_payment_records'), /./, 'record table truncated');
  await rejectsSql(() => sql(`INSERT INTO hon.invoice_payment_records(organization_id,school_id,invoice_id,amount_minor,currency,received_on,method,actor_principal_id,voided_at,voided_by_principal_id,void_reason)
    VALUES($1,$2,$3,1,'USD',current_date,'CASH',$4,clock_timestamp(),$4,'x')`, [ids.organization, ids.schoolA, inv.B, OWN.principal]), /INVOICE_PAYMENT_RECORD_IMMUTABLE/, 'record inserted already voided');
  await rejectsSql(() => sql(`INSERT INTO hon.invoice_payment_records(organization_id,school_id,invoice_id,amount_minor,currency,received_on,method,actor_principal_id)
    VALUES($1,$2,$3,1,'USD',current_date,'CASH',$4)`, [ids.organization, ids.schoolB, inv.B, OWN.principal]), /foreign key/, 'record bound to another school');
  ok((await sql("UPDATE hon.invoices SET status='ISSUED' WHERE id=$1 RETURNING id", [inv.legacyPaid])).rowCount === 1, 'a legacy PAID invoice with no records may still reopen');
  await sql('ROLLBACK');

  // 9. Nothing else changed: other invoices, payment attempts, refund records.
  ok(JSON.stringify(await untouched()) === JSON.stringify(before), 'no other invoice, payment attempt or refund record changed');

  // 10. Runtime ACL: EXECUTE on the four entry points only; no table privilege, no helper, nothing for PUBLIC.
  const entry = ['record_invoice_payment(text,uuid,jsonb,text,uuid,uuid)', 'void_invoice_payment(text,uuid,jsonb,text,uuid,uuid)', 'read_invoice_payments(text,uuid)', 'read_school_receivables(text,jsonb)'];
  const helpers = ['guard_invoice_payment_record()', 'guard_invoice_payment_status()', 'require_tuition_actor(text,text)', 'require_tuition_reader(text)',
    'invoice_payment_json(hon.invoice_payment_records)', 'invoice_balance_json(hon.invoices)', 'tuition_command_begin(text,text,text)',
    'tuition_command_finish(text,text,uuid,jsonb,text,uuid,jsonb,jsonb,text,uuid,integer,uuid,uuid)'];
  for (const fn of entry) {
    const row = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, p.prosecdef, EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(row.runtime && row.prosecdef && !row.public, `runtime may execute definer ${fn}; PUBLIC may not`);
  }
  for (const fn of helpers) {
    const row = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(!row.runtime && !row.public, `helper ${fn} is private`);
  }
  const table = (await sql(`SELECT c.relrowsecurity AND c.relforcerowsecurity forced, has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT')
    OR has_table_privilege($1,c.oid,'UPDATE') OR has_table_privilege($1,c.oid,'DELETE') OR has_any_column_privilege($1,c.oid,'SELECT') runtime FROM pg_class c WHERE c.oid='hon.invoice_payment_records'::regclass`,
    [CRM_CLOSE_RUNTIME_ROLE])).rows[0];
  ok(table.forced && !table.runtime, 'invoice_payment_records: forced RLS, no runtime privilege');
  await assert.rejects(runtime.query('SELECT * FROM hon.invoice_payment_records LIMIT 1'), /permission denied/); checks += 1;
  await assert.rejects(runtime.query("SELECT hon.require_tuition_actor('x','billing.invoice.payment.record')"), /permission denied/); checks += 1;
  // The deployment verifier's 0240 section (infra/postgres/011) passes against this database with its runtime role.
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const start = '-- Tuition payment records exact verification (B-TUI-1 0240)', end = '-- End tuition payment records exact verification.';
    const section = verify.split(start)[1]?.split(end)[0];
    ok(section, start);
    await sql(section.replace(/^[^\n]*\n[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  // 11. 0280 invoice list: every status of the current school only, newest first, 50 per page; same readers; no DML.
  {
    const invoices = (actor, query = '', options = {}) => call(actor, 'GET', `invoices${query ? `?${query}` : ''}`, options);
    const beforeList = await untouched();
    const all = (await success(() => invoices(OWN), 'owner lists every invoice')).data;
    const listed = all.items.map((i) => i.invoiceId);
    for (const id of [inv.A, inv.B, inv.C, inv.draft, inv.voided, inv.legacyPaid]) ok(listed.includes(id), `school A invoice ${id.slice(0, 8)} is listed`);
    ok(!listed.includes(inv.schoolB) && !listed.includes(inv.otherOrg), 'no other school or organization invoice is listed');
    ok(all.status === 'ALL' && all.timezone === LA && all.canIssue && all.canRecord && all.nextAfter === null, 'owner may issue and record; one page');
    const draftRow = all.items.find((i) => i.invoiceId === inv.draft);
    ok(draftRow.status === 'DRAFT' && draftRow.paidMinor === 0 && draftRow.overdue === false && draftRow.payerName === 'Avery Tuition', 'a DRAFT is never overdue and names its payer');
    const created = (await sql('SELECT id, created_at FROM hon.invoices WHERE school_id=$1 ORDER BY created_at DESC, id DESC', [ids.schoolA])).rows.map((r) => r.id);
    ok(JSON.stringify(created) === JSON.stringify(listed), 'newest first, then by id');
    const drafts = (await success(() => invoices(OWN, 'status=DRAFT'), 'DRAFT only')).data;
    ok(drafts.items.length >= 1 && drafts.items.every((i) => i.status === 'DRAFT'), 'status filter returns only that status');
    ok((await success(() => invoices(CREATOR), 'creator lists')).data.canIssue === false, 'a creator may list but not issue');
    const issuer = (await success(() => invoices(ISSUER), 'issuer lists')).data;
    ok(issuer.canIssue === true && issuer.canRecord === false, 'an issuer may issue but not record');
    await refused(() => invoices(NONE), 403, undefined, 'no invoice permission');
    await refused(() => invoices(OTHER_ORG, '', { organization: ids.organization, school: ids.schoolA }), 403, undefined, 'another organization at school A');
    await refused(() => invoices(OWN, 'status=OPEN'), 400, 'VALIDATION_FAILED', 'unknown status');
    await refused(() => invoices(OWN, 'limit=5'), 400, 'VALIDATION_FAILED', 'unknown query key');
    await refused(() => invoices(OWN, `after=${inv.schoolB}`), 400, 'VALIDATION_FAILED', 'a cursor from another school is refused, not disclosed');
    await refused(() => invoices(OWN, `after=${randomUUID()}`), 400, 'VALIDATION_FAILED', 'an unknown cursor');
    await refused(() => invoices(OWN, '', { headers: { 'Idempotency-Key': randomUUID() } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'a read takes no key');
    const schoolB = (await success(() => invoices(OTHER_SCHOOL), 'school B staff')).data.items.map((i) => i.invoiceId);
    ok(schoolB.length === 1 && schoolB[0] === inv.schoolB, 'school B staff see only school B');
    // Paging: 52 more drafts give a full first page and a cursor that continues exactly where it stopped.
    const extra = await account(ids.schoolA, 'Pager');
    for (let n = 0; n < 52; n += 1) await invoice(ids.schoolA, extra, { status: 'DRAFT', total: 100 + n });
    const first = (await success(() => invoices(OWN), 'page 1')).data;
    ok(first.items.length === 50 && first.nextAfter === first.items[49].invoiceId, 'page 1 holds 50 and a cursor');
    const second = (await success(() => invoices(OWN, `after=${first.nextAfter}`), 'page 2')).data;
    const everyId = [...first.items, ...second.items].map((i) => i.invoiceId);
    const expected = (await sql('SELECT id FROM hon.invoices WHERE school_id=$1 ORDER BY created_at DESC, id DESC', [ids.schoolA])).rows.map((r) => r.id);
    ok(JSON.stringify(everyId) === JSON.stringify(expected) && second.nextAfter === null, 'two pages cover every invoice once, in order');
    await assert.rejects(service.invoices(OWN.read({ principalType: 'SERVICE' }), { status: 'ALL' }), (error) => error?.status === 403 || error?.response?.code === 'HUMAN_COMMAND_REQUIRED'); checks += 1;
    const afterList = await untouched();
    ok(afterList.attempts === beforeList.attempts && afterList.refunds === beforeList.refunds, 'the list writes nothing');
    const fn = (await sql(`SELECT has_function_privilege($1,'hon.read_school_invoices(text,jsonb)','EXECUTE') runtime, p.prosecdef,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public FROM pg_proc p WHERE p.oid='hon.read_school_invoices(text,jsonb)'::regprocedure`,
      [CRM_CLOSE_RUNTIME_ROLE])).rows[0];
    ok(fn.runtime && fn.prosecdef && !fn.public, 'runtime may execute the definer invoice list; PUBLIC may not');
    { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
      const start = '-- School invoice list exact verification (B-TUI-1b 0280)', end = '-- End school invoice list exact verification.';
      const section = verify.split(start)[1]?.split(end)[0];
      ok(section, start);
      await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }
  }

  console.log(`PASS: tuition payment records (0240, 0280 invoice list): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
