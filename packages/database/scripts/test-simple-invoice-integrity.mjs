/**
 * Simple invoices proof (SI1, 0558) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guards + global
 * ValidationPipe + HonExceptionFilter -> SimpleInvoiceController -> protected definer functions on the restricted runtime
 * role with forced RLS), on the guarded disposable CRM-close fixture only. Synthetic names and amounts only; HON moves no
 * money, sends nothing and no provider is reachable.
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
const { SimpleInvoiceController } = await load('billing/simple-invoice.controller.js');
const { SimpleInvoiceService } = await load('billing/simple-invoice.service.js');
const { TuitionPaymentController } = await load('billing/tuition-payment.controller.js');
const { TuitionPaymentService } = await load('billing/tuition-payment.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-simple-invoices', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'otherSchool'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
let app, origin;
const database = new RuntimeDatabaseService();
const service = new SimpleInvoiceService(database);

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [SimpleInvoiceController, TuitionPaymentController],
    providers: [HonIdentityGuard, HonIdentityService, SimpleInvoiceService, TuitionPaymentService, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}

const COMMAND = 'billing.invoice.simple.create';
function call(actor, method, path, { body, key = randomUUID(), command = COMMAND, headers = {}, school = actor.school, organization = actor.org } = {}) {
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
const create = (actor, body, options = {}) => call(actor, 'POST', 'invoices/simple', { body, ...options });
const detail = (actor, invoiceId, options = {}) => call(actor, 'GET', `invoices/${invoiceId}/detail`, options);
const list = (actor, query = '') => call(actor, 'GET', `invoices${query ? `?${query}` : ''}`);

async function expectStatus(read, expected, label) {
  const { status, body, headers } = await read();
  assert.equal(status, expected, `${label}: expected ${expected}, got ${status} ${JSON.stringify(body).slice(0, 500)}`);
  if (expected < 300) ok(headers['cache-control'] === 'private, no-store', `${label}: never cached`);
  else ok(!('data' in body), `${label}: a refusal returns no data`);
  return body;
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
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`sinv-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`sinv-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`sinv-${ids.organization}-%`]);
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
  const user = randomUUID(), principal = randomUUID(), subject = `sinv-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Invoice Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Invoice Staff')", [principal, user]);
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
let OWN, ISSUER, CREATOR, RECORDER, NONE, OTHER_SCHOOL, OTHER_ORG, today;
const acct = {};
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
async function payer(school, givenName, { org = ids.organization, email = null, phone = null } = {}) {
  const person = randomUUID(), id = randomUUID();
  await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email,phone_e164) VALUES($1,$2,$3,$4,'Rivera',$5,$6)", [person, org, school, givenName, email, phone]);
  await sql('INSERT INTO hon.billing_accounts(id,organization_id,school_id,responsible_person_id) VALUES($1,$2,$3,$4)', [id, org, school, person]);
  return { id, person };
}

async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Invoice Org','Invoice Org'),($2,'Invoice Other Org','Invoice Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug, name] of [[ids.schoolA, ids.organization, 'a', 'Tiger Valley Karate'], [ids.schoolB, ids.organization, 'b', 'Second Dojo'], [ids.otherSchool, ids.otherOrganization, 'o', 'Other Dojo']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, name, `sinv-${slug}-${school.slice(0, 8)}`, LA]);
  }
  today = (await sql('SELECT (clock_timestamp() AT TIME ZONE $1)::date::text d', [LA])).rows[0].d;
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  ISSUER = await staff('issuer', [await role(ids.organization, ['billing.invoice.issue'])]);
  CREATOR = await staff('creator', [await role(ids.organization, ['billing.invoice.create'])]);
  RECORDER = await staff('recorder', [await role(ids.organization, ['billing.invoice.payment.record'])]);
  NONE = await staff('none', [await role(ids.organization, ['people.read', 'crm.lead.read', 'reporting.view', 'billing.membership.read'])]);
  OTHER_SCHOOL = await staff('other-school', [await role(ids.organization, allPermissions)], { school: ids.schoolB });
  OTHER_ORG = await staff('other-org', [await role(ids.otherOrganization, allPermissions, 'OWNER')], { org: ids.otherOrganization, school: ids.otherSchool });
  // School A's address (0392), written by the migration owner as the location command would.
  await sql(`INSERT INTO hon.school_locations(school_id,organization_id,country_code,region_code,city,postal_code,address_line1,address_line2,created_by_principal_id,updated_by_principal_id)
    VALUES($1,$2,'US','CA','Fresno','93701','12 Main St',NULL,$3,$3)`, [ids.schoolA, ids.organization, OWN.principal]);
  acct.a = await payer(ids.schoolA, 'Jordan', { email: 'jordan@example.test', phone: '+15595550100' });
  acct.a2 = await payer(ids.schoolA, 'Sam');
  acct.b = await payer(ids.schoolB, 'Casey');
  acct.o = await payer(ids.otherSchool, 'Devon', { org: ids.otherOrganization });
}
const counts = async () => (await sql(`SELECT (SELECT count(*)::int FROM hon.invoices WHERE organization_id=$1) invoices,
  (SELECT count(*)::int FROM hon.invoice_line_items WHERE organization_id=$1) lines, (SELECT count(*)::int FROM hon.invoice_details WHERE organization_id=$1) details,
  (SELECT count(*)::int FROM hon.audit_events WHERE organization_id=$1 AND action_code LIKE 'billing.invoice.%') audits,
  (SELECT count(*)::int FROM hon.outbox_events WHERE organization_id=$1 AND event_type LIKE 'billing.invoice.%') events,
  (SELECT count(*)::int FROM hon.payment_attempts WHERE organization_id=$1) attempts,
  (SELECT count(*)::int FROM hon.communication_messages WHERE organization_id=$1) messages`, [ids.organization])).rows[0];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

try {
  await cleanup();
  await seed();
  await startApp();

  const due = addDays(today, 14);
  const body = (patch = {}) => ({ billingAccountId: acct.a.id, dueDate: due, issue: false,
    items: [{ description: 'Monthly tuition', quantity: 1, unitAmountMinor: 14900 }, { description: 'Belt test', quantity: 2, unitAmountMinor: 2550 }],
    payToPhone: '(559) 555-0199', payToEmail: 'front@tigervalley.example', otherWaysToPay: 'Cash or check at the front desk.', note: 'Thank you!\nSee you in class.', ...patch });

  // 1. A creator saves a DRAFT with two items: the total is their sum; the printable view has every part.
  const before = await counts();
  const draftKey = randomUUID();
  const created = (await expectStatus(() => create(CREATOR, body(), { key: draftKey }), 201, 'creator saves a draft')).data;
  ok(created.invoice.status === 'DRAFT' && created.invoice.version === 1 && created.invoice.totalMinor === 14900 + 5100 && created.invoice.paidMinor === 0
    && created.invoice.balanceMinor === 20000 && created.invoice.currency === 'USD' && created.invoice.membershipId === null, 'DRAFT with total = sum of items');
  ok(same(created.items, [{ position: 1, description: 'Monthly tuition', quantity: 1, unitAmountMinor: 14900, amountMinor: 14900 },
    { position: 2, description: 'Belt test', quantity: 2, unitAmountMinor: 2550, amountMinor: 5100 }]), 'items in order with line amounts');
  ok(same(created.billTo, { personId: acct.a.person, name: 'Jordan Rivera', email: 'jordan@example.test', phone: '+15595550100' }), 'bill to: the payer with email and phone');
  ok(same(created.from, { schoolName: 'Tiger Valley Karate', addressLines: ['12 Main St', 'Fresno, CA 93701', 'US'], phone: '(559) 555-0199', email: 'front@tigervalley.example' }), 'from: school name, address and pay-to contact');
  ok(same(created.howToPay, { inApp: false, otherWays: 'Cash or check at the front desk.' }) && created.note === 'Thank you!\nSee you in class.', 'how to pay and note');
  ok(created.number === created.invoice.invoiceId.slice(0, 8).toUpperCase() && created.timezone === LA && created.localToday === today && created.canIssue === false, 'number, school day, a creator cannot issue');
  const dueRow = (await sql("SELECT to_char(due_at AT TIME ZONE $2,'YYYY-MM-DD HH24:MI:SS') local, subtotal_minor, discount_minor, total_minor FROM hon.invoices WHERE id=$1", [created.invoice.invoiceId, LA])).rows[0];
  ok(dueRow.local === `${due} 23:59:59` && dueRow.subtotal_minor === 20000 && dueRow.discount_minor === 0 && dueRow.total_minor === 20000, 'due at the end of the school day; subtotal = total');
  const afterDraft = await counts();
  ok(afterDraft.invoices === before.invoices + 1 && afterDraft.lines === before.lines + 2 && afterDraft.details === before.details + 1
    && afterDraft.audits === before.audits + 1 && afterDraft.events === before.events + 1 && afterDraft.attempts === 0 && afterDraft.messages === 0, 'one invoice, two lines, one detail, one audit, one event; no payment or message');
  const evidence = (await sql("SELECT a.next_state, o.payload FROM hon.audit_events a JOIN hon.outbox_events o ON o.aggregate_id=a.entity_id WHERE a.entity_id=$1 AND a.action_code='billing.invoice.create' AND o.event_type='billing.invoice.created'", [created.invoice.invoiceId])).rows[0];
  ok(evidence && same(evidence.next_state, evidence.payload) && evidence.payload.lineCount === 2 && !JSON.stringify(evidence.payload).match(/Jordan|example|tuition|Cash/i), 'audit and event carry identifiers and amounts only');

  // 2. Exact replay returns the same invoice; the key with another body is refused; nothing more is written.
  const replay = await expectStatus(() => create(CREATOR, body(), { key: draftKey }), 200, 'exact replay');
  ok(replay.meta.replayed === true && replay.data.invoice.invoiceId === created.invoice.invoiceId, 'replay names the same invoice');
  await expectStatus(() => create(CREATOR, body({ note: 'Changed' }), { key: draftKey }), 409, 'key reused with another body');
  ok(same(await counts(), afterDraft), 'replay and key reuse wrote nothing');

  // 3. Create and issue in one step needs billing.invoice.issue too.
  const deniedKey = randomUUID();
  const denied = await expectStatus(() => create(CREATOR, body({ issue: true }), { key: deniedKey }), 403, 'a creator cannot issue');
  ok(!('data' in denied) && same(await counts(), afterDraft), 'refused issue wrote nothing');
  const issued = (await expectStatus(() => create(OWN, body({ issue: true, billingAccountId: acct.a2.id, payToPhone: undefined, payToEmail: undefined, otherWaysToPay: undefined, note: undefined }), {}), 201, 'owner creates and issues')).data;
  ok(issued.invoice.status === 'ISSUED' && issued.invoice.version === 2 && issued.canIssue === true && issued.billTo.name === 'Sam Rivera'
    && issued.billTo.email === null && issued.from.phone === null && issued.howToPay.otherWays === null && issued.note === null, 'issued at once, version 2, optional text absent');
  const issuedEvidence = (await sql("SELECT action_code FROM hon.audit_events WHERE entity_id=$1 ORDER BY occurred_at, action_code", [issued.invoice.invoiceId])).rows.map((r) => r.action_code);
  const issuedEvents = (await sql("SELECT event_type, aggregate_version FROM hon.outbox_events WHERE aggregate_id=$1 ORDER BY aggregate_version", [issued.invoice.invoiceId])).rows;
  ok(same(issuedEvidence.sort(), ['billing.invoice.create', 'billing.invoice.issue']) && same(issuedEvents, [{ event_type: 'billing.invoice.created', aggregate_version: 1 }, { event_type: 'billing.invoice.issued', aggregate_version: 2 }]), 'create and issue audit and events');
  const listed = (await expectStatus(() => list(OWN), 200, 'school list')).data.items;
  ok(listed.some((i) => i.invoiceId === issued.invoice.invoiceId && i.status === 'ISSUED' && i.balanceMinor === 20000) && listed.some((i) => i.invoiceId === created.invoice.invoiceId && i.status === 'DRAFT'), 'both appear in the school invoice list');

  // 4. Validation: each bad input is refused before anything is written.
  const snapshot = await counts();
  const many = Array.from({ length: 31 }, (_, n) => ({ description: `Item ${n + 1}`, quantity: 1, unitAmountMinor: 100 }));
  for (const [label, bad] of [
    ['no items', body({ items: [] })], ['31 items', body({ items: many })], ['quantity 0', body({ items: [{ description: 'X', quantity: 0, unitAmountMinor: 100 }] })],
    ['quantity 1001', body({ items: [{ description: 'X', quantity: 1001, unitAmountMinor: 100 }] })], ['fractional quantity', body({ items: [{ description: 'X', quantity: 1.5, unitAmountMinor: 100 }] })],
    ['negative price', body({ items: [{ description: 'X', quantity: 1, unitAmountMinor: -1 }] })], ['price too high', body({ items: [{ description: 'X', quantity: 1, unitAmountMinor: 100000001 }] })],
    ['zero total', body({ items: [{ description: 'Free', quantity: 1, unitAmountMinor: 0 }] })], ['total too high', body({ items: Array.from({ length: 22 }, () => ({ description: 'Big', quantity: 1000, unitAmountMinor: 100000 })) })],
    ['blank description', body({ items: [{ description: ' ', quantity: 1, unitAmountMinor: 100 }] })], ['description with a newline', body({ items: [{ description: 'A\nB', quantity: 1, unitAmountMinor: 100 }] })],
    ['extra item key', body({ items: [{ description: 'X', quantity: 1, unitAmountMinor: 100, tax: 1 }] })], ['extra key', { ...body(), discountMinor: 5 }],
    ['missing issue', (({ issue, ...rest }) => rest)(body())], ['bad email', body({ payToEmail: 'nope' })], ['bad phone', body({ payToPhone: 'call us' })],
    ['bad date', body({ dueDate: '2026-02-30' })], ['due too far ahead', body({ dueDate: addDays(today, 400) })], ['due too long ago', body({ dueDate: addDays(today, -400) })],
    ['bad account id', body({ billingAccountId: 'abc' })], ['note too long', body({ note: 'x'.repeat(1001) })],
  ]) {
    await expectStatus(() => create(OWN, bad), 400, `validation: ${label}`);
  }
  ok(same(await counts(), snapshot), 'no refused input wrote anything');

  // 5. Scope: another school's or organization's payer is not found; people without the permission are refused.
  await expectStatus(() => create(OWN, body({ billingAccountId: acct.b.id })), 404, 'school B payer through school A');
  await expectStatus(() => create(OWN, body({ billingAccountId: acct.o.id })), 404, 'other organization payer');
  await expectStatus(() => create(OWN, body({ billingAccountId: randomUUID() })), 404, 'unknown payer');
  for (const actor of [NONE, ISSUER, RECORDER]) await expectStatus(() => create(actor, body()), 403, `create refused for ${actor.subject.split('-').pop()}`);
  await expectStatus(() => create(OTHER_SCHOOL, body(), { school: ids.schoolA }), 403, 'school B staff at the school A route');
  await expectStatus(() => create(OTHER_ORG, body(), { school: ids.schoolA, organization: ids.organization }), 403, 'other organization owner at school A');
  await expectStatus(() => create(OWN, body(), { command: 'billing-invoice' }), 403, 'wrong browser command');
  await expectStatus(() => create(OWN, body(), { headers: { 'X-Hon-Source': 'AI_AGENT' } }), 403, 'source header');
  await expectStatus(() => create(OWN, body(), { key: null }), 409, 'no idempotency key');
  ok(same(await counts(), snapshot), 'no refused caller wrote anything');
  await assert.rejects(service.create(OWN.context({ principalType: 'SERVICE' }), body()), (error) => error?.response?.code === 'HUMAN_COMMAND_REQUIRED'); checks += 1;

  // 6. Detail: the 0280 readers; another school's invoice is not found; an older invoice has no items.
  for (const actor of [ISSUER, CREATOR, RECORDER, OWN]) {
    const read = (await expectStatus(() => detail(actor, created.invoice.invoiceId), 200, `detail by ${actor.subject.split('-').pop()}`)).data;
    ok(same(read.items, created.items) && read.canIssue === [ISSUER, OWN].includes(actor), `detail by ${actor.subject.split('-').pop()}: same items, canIssue by permission`);
  }
  await expectStatus(() => detail(NONE, created.invoice.invoiceId), 403, 'detail without permission');
  const legacy = randomUUID();
  await sql("INSERT INTO hon.invoices(id,organization_id,school_id,billing_account_id,status,currency,subtotal_minor,total_minor,due_at) VALUES($1,$2,$3,$4,'ISSUED','USD',4900,4900,clock_timestamp()+interval '3 days')", [legacy, ids.organization, ids.schoolA, acct.a.id]);
  const old = (await expectStatus(() => detail(OWN, legacy), 200, 'older invoice')).data;
  ok(old.items.length === 0 && old.note === null && old.howToPay.otherWays === null && old.from.phone === null && old.invoice.totalMinor === 4900 && old.billTo.name === 'Jordan Rivera', 'an older invoice shows its total with no items');
  const otherB = randomUUID();
  await sql("INSERT INTO hon.invoices(id,organization_id,school_id,billing_account_id,status,currency,subtotal_minor,total_minor) VALUES($1,$2,$3,$4,'ISSUED','USD',100,100)", [otherB, ids.organization, ids.schoolB, acct.b.id]);
  await expectStatus(() => detail(OWN, otherB), 404, 'school B invoice through school A');
  await expectStatus(() => detail(OWN, randomUUID()), 404, 'unknown invoice');
  await expectStatus(() => detail(OWN, created.invoice.invoiceId, { headers: { 'Idempotency-Key': 'x' } }), 409, 'a read takes no key');
  ok(((await expectStatus(() => detail(OTHER_SCHOOL, otherB), 200, 'school B reads its own')).data.from.addressLines.length === 0), 'a school without an address shows none');

  // 7. Items and details never change, and are added only to a DRAFT of the same school.
  await sql('BEGIN');
  await rejectsSql(() => sql("UPDATE hon.invoice_line_items SET quantity=9 WHERE invoice_id=$1", [created.invoice.invoiceId]), /INVOICE_SIMPLE_ROWS_APPEND_ONLY/, 'items cannot be changed');
  await rejectsSql(() => sql('DELETE FROM hon.invoice_line_items WHERE invoice_id=$1', [created.invoice.invoiceId]), /INVOICE_SIMPLE_ROWS_APPEND_ONLY/, 'items cannot be deleted');
  await rejectsSql(() => sql("UPDATE hon.invoice_details SET note='x' WHERE invoice_id=$1", [created.invoice.invoiceId]), /INVOICE_SIMPLE_ROWS_APPEND_ONLY/, 'details cannot be changed');
  await rejectsSql(() => sql('TRUNCATE hon.invoice_details'), /INVOICE_SIMPLE_ROWS_APPEND_ONLY/, 'details cannot be truncated');
  await rejectsSql(() => sql("INSERT INTO hon.invoice_line_items(organization_id,school_id,invoice_id,position,description,quantity,unit_amount_minor,amount_minor) VALUES($1,$2,$3,3,'Extra',1,100,100)",
    [ids.organization, ids.schoolA, issued.invoice.invoiceId]), /INVOICE_SIMPLE_ROWS_APPEND_ONLY/, 'no item is added to an issued invoice');
  await rejectsSql(() => sql("INSERT INTO hon.invoice_line_items(organization_id,school_id,invoice_id,position,description,quantity,unit_amount_minor,amount_minor) VALUES($1,$2,$3,3,'Extra',1,100,100)",
    [ids.organization, ids.schoolB, created.invoice.invoiceId]), /INVOICE_SIMPLE_ROWS_APPEND_ONLY/, 'no item for another school');
  await rejectsSql(() => sql("INSERT INTO hon.invoice_line_items(organization_id,school_id,invoice_id,position,description,quantity,unit_amount_minor,amount_minor) VALUES($1,$2,$3,3,'Extra',2,100,100)",
    [ids.organization, ids.schoolA, created.invoice.invoiceId]), /amount_minor|check/i, 'a line amount must be quantity x price');
  await sql('ROLLBACK');

  // 8. Runtime access: entry points only; private helpers and tables; the 011 section passes.
  for (const fn of ['create_simple_invoice(text,jsonb,text,uuid,uuid)', 'read_school_invoice_detail(text,uuid)']) {
    const row = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, p.prosecdef, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(row.runtime && row.prosecdef && !row.public, `runtime may execute definer ${fn}; PUBLIC may not`);
  }
  for (const fn of ['simple_invoice_detail_json(hon.invoices,boolean)', 'simple_invoice_can_issue(text)', 'simple_invoice_text_ok(jsonb,integer,boolean)', 'guard_invoice_simple_rows()']) {
    const row = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(!row.runtime && !row.public, `helper ${fn} is private`);
  }
  for (const t of ['invoice_line_items', 'invoice_details']) {
    const row = (await sql(`SELECT c.relrowsecurity AND c.relforcerowsecurity forced, has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT')
      OR has_table_privilege($1,c.oid,'UPDATE') OR has_table_privilege($1,c.oid,'DELETE') OR has_any_column_privilege($1,c.oid,'SELECT') runtime FROM pg_class c WHERE c.oid=$2::regclass`,
      [CRM_CLOSE_RUNTIME_ROLE, `hon.${t}`])).rows[0];
    ok(row.forced && !row.runtime, `${t}: forced RLS, no runtime privilege`);
    await assert.rejects(runtime.query(`SELECT * FROM hon.${t} LIMIT 1`), /permission denied/); checks += 1;
  }
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const start = '-- Simple invoices exact verification (SI1 0558)', end = '-- End simple invoices exact verification.';
    const section = verify.split(start)[1]?.split(end)[0];
    ok(section, start);
    await sql(section.replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: simple invoices (0558): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
