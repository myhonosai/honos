// 0352 school number orders (docs/architecture/SCHOOL_OWN_SENDERS.md §4.3, T2): owner with communication.sender.manage
// at an entitled school requests one number; HQ owner approves or rejects; the worker claims, leases and records;
// PURCHASED makes a DISABLED subaccount sender; UNKNOWN is reconciled, never re-bought blindly; the 0248 HQ setter can no
// longer move a HON-bought number; no runtime table access.
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const { Client } = pg;
for (const key of ['DATABASE_URL', 'HON_RUNTIME_DATABASE_URL', 'HON_COMMUNICATION_WORKER_DATABASE_URL']) {
  if (!process.env[key]) throw new Error(`${key} is required for the school number order proof.`);
}
const local = (url) => {
  const parsed = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || parsed.port !== '5432') throw new Error('Disposable localhost:5432 target required.');
  return { connectionString: url, ssl: false };
};
const admin = new Client(local(process.env.DATABASE_URL));
const runtime = new Client(local(process.env.HON_RUNTIME_DATABASE_URL));
const worker = new Client(local(process.env.HON_COMMUNICATION_WORKER_DATABASE_URL));

let passed = 0;
function check(condition, message) { if (!condition) throw new Error(`FAIL: ${message}`); passed += 1; }
async function expectError(code, work, message) {
  try { await work(); } catch (error) {
    if (error?.code === code) { passed += 1; return; }
    throw new Error(`FAIL: ${message} (got ${error?.code ?? error?.message})`);
  }
  throw new Error(`FAIL: ${message} (no error)`);
}

const ids = Object.fromEntries(['org', 'org2', 'schoolA', 'schoolB', 'ownerUser', 'ownerPrincipal', 'staffUser', 'staffPrincipal', 'hqUser', 'hqPrincipal',
  'ownerRole', 'staffRole', 'ownerRole2'].map((key) => [key, randomUUID()]));
const subject = { owner: `numbers-owner-${ids.ownerUser}`, staff: `numbers-staff-${ids.staffUser}`, hq: `numbers-hq-${ids.hqUser}` };
const acct = (c) => `AC${c.repeat(32)}`;
const pn = (c) => `PN${c.repeat(32)}`;
const mg = (c) => `MG${c.repeat(32)}`;

// A runtime call inside a HON staff session for one school (the RuntimeDatabaseService settings).
async function asStaff(who, principal, org, school, sql, args) {
  await runtime.query('BEGIN');
  try {
    for (const [k, v] of [['app.hon_external_subject', who], ['app.hon_principal_type', 'HUMAN_USER'], ['app.hon_source', 'HUMAN_UI'],
      ['app.hon_principal_id', principal], ['app.hon_organization_id', org], ['app.hon_school_id', school]]) {
      await runtime.query('SELECT set_config($1, $2, true)', [k, v]);
    }
    const rows = (await runtime.query(sql, args)).rows;
    await runtime.query('COMMIT');
    return rows[0]?.data;
  } catch (error) { await runtime.query('ROLLBACK'); throw error; }
}
const owner = (sql, args, school = ids.schoolA, org = ids.org) => asStaff(subject.owner, ids.ownerPrincipal, org, school, sql, args);
const request = (input, key = `key-${randomUUID()}`, school) => owner('SELECT hon.request_school_number($1,$2::jsonb,$3) AS data', [subject.owner, JSON.stringify(input), key], school);
const decide = async (order, decision, version, note = null) =>
  (await runtime.query('SELECT hon.decide_school_number_order_from_hq($1,$2,$3,$4,$5) AS data', [subject.hq, order, decision, note, version])).rows[0].data;
const claim = async (limit = 5, lease = 60) => (await worker.query('SELECT * FROM hon.claim_school_number_purchases($1,$2)', [limit, lease])).rows;
const record = async (row, outcome, extra = {}) => (await worker.query('SELECT hon.record_school_number_purchase($1,$2,$3,$4,$5,$6,$7) AS data',
  [row.order_id, row.lease_token, outcome, extra.number ?? null, extra.service ?? null, extra.account ?? null, extra.failure ?? null])).rows[0].data;
const order = async (id) => (await admin.query('SELECT * FROM hon.school_number_orders WHERE id = $1', [id])).rows[0];
const number = { phoneE164: '+15125550101', locality: 'Austin', region: 'TX', monthlyPriceMicrounits: 1150000 };

async function cleanup() {
  await admin.query('BEGIN');
  await admin.query('ALTER TABLE hon.school_number_orders DISABLE TRIGGER guarded'); // the 0352 guard forbids deletes; the disposable fixture's owner lifts it for cleanup only
  await admin.query('ALTER TABLE hon.school_twilio_accounts DISABLE TRIGGER guarded'); // the 0352 guard forbids deletes; the disposable fixture's owner lifts it for cleanup only
  try {
    for (const org of [ids.org, ids.org2]) {
      await admin.query('DELETE FROM hon.audit_events WHERE organization_id = $1', [org]);
      await admin.query('DELETE FROM hon.school_text_senders WHERE organization_id = $1', [org]);
      await admin.query('DELETE FROM hon.school_number_orders WHERE organization_id = $1', [org]);
      await admin.query('DELETE FROM hon.school_twilio_accounts WHERE organization_id = $1', [org]);
      await admin.query('DELETE FROM hon.organization_entitlements WHERE organization_id = $1', [org]);
      await admin.query('DELETE FROM hon.principal_role_grants WHERE organization_id = $1', [org]);
      await admin.query('DELETE FROM hon.role_permissions WHERE organization_id = $1', [org]);
      await admin.query('DELETE FROM hon.roles WHERE organization_id = $1', [org]);
    }
    await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id = $1', [ids.hqPrincipal]);
    await admin.query('DELETE FROM hon.principals WHERE id = ANY($1::uuid[])', [[ids.ownerPrincipal, ids.staffPrincipal, ids.hqPrincipal]]);
    await admin.query('DELETE FROM hon.users WHERE id = ANY($1::uuid[])', [[ids.ownerUser, ids.staffUser, ids.hqUser]]);
    await admin.query('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [[ids.org, ids.org2]]);
    await admin.query('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [[ids.org, ids.org2]]);
    await admin.query('ALTER TABLE hon.school_number_orders ENABLE TRIGGER guarded');
    await admin.query('ALTER TABLE hon.school_twilio_accounts ENABLE TRIGGER guarded');
    await admin.query('COMMIT');
  } catch (error) { await admin.query('ROLLBACK'); throw error; }
}

await Promise.all([admin.connect(), runtime.connect(), worker.connect()]);
try {
  await admin.query("INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, 'Numbers Org', 'Numbers Org'), ($2, 'Other Org', 'Other Org')", [ids.org, ids.org2]);
  await admin.query("INSERT INTO hon.schools (id, organization_id, name, slug, timezone) VALUES ($1,$2,'Austin Dojo',$3,'America/Chicago'), ($4,$5,'Other Dojo',$6,'UTC')",
    [ids.schoolA, ids.org, `austin-${ids.schoolA.slice(0, 8)}`, ids.schoolB, ids.org2, `other-${ids.schoolB.slice(0, 8)}`]);
  for (const [user, principal, who, name] of [[ids.ownerUser, ids.ownerPrincipal, subject.owner, 'Owner'], [ids.staffUser, ids.staffPrincipal, subject.staff, 'Staff'],
    [ids.hqUser, ids.hqPrincipal, subject.hq, 'HQ']]) {
    await admin.query('INSERT INTO hon.users (id, external_subject, email, display_name) VALUES ($1, $2, $3, $4)', [user, who, `${who}@example.test`, name]);
    await admin.query("INSERT INTO hon.principals (id, principal_type, user_id, display_name) VALUES ($1, 'HUMAN_USER', $2, $3)", [principal, user, name]);
  }
  await admin.query("INSERT INTO hon.hq_operator_grants (principal_id, hq_role) VALUES ($1, 'HON_HQ_OWNER')", [ids.hqPrincipal]);
  // The migration grants the permission to system OWNER roles; this fixture's OWNER role is created afterwards like a new sign-up's.
  await admin.query("INSERT INTO hon.roles (id, organization_id, code, name, is_system_role) VALUES ($1,$2,'OWNER','Owner',true), ($3,$2,'FRONT_DESK','Front desk',false), ($4,$5,'OWNER','Owner',true)",
    [ids.ownerRole, ids.org, ids.staffRole, ids.ownerRole2, ids.org2]);
  await admin.query("INSERT INTO hon.role_permissions (role_id, organization_id, permission_code) VALUES ($1,$2,'communication.sender.manage'), ($3,$2,'communication.message.read'), ($4,$5,'communication.sender.manage')",
    [ids.ownerRole, ids.org, ids.staffRole, ids.ownerRole2, ids.org2]);
  await admin.query(`INSERT INTO hon.principal_role_grants (organization_id, school_id, principal_id, role_id, granted_by_principal_id, effective_from)
    VALUES ($1,$2,$3,$4,$3, clock_timestamp() - interval '1 hour'), ($1,$2,$5,$6,$3, clock_timestamp() - interval '1 hour')`,
    [ids.org, ids.schoolA, ids.ownerPrincipal, ids.ownerRole, ids.staffPrincipal, ids.staffRole]);
  check((await admin.query("SELECT is_sensitive AND is_staff_assignable AS ok FROM hon.permissions WHERE code = 'communication.sender.manage'")).rows[0].ok, 'the permission exists, sensitive and staff-assignable');

  // 1. Role boundaries.
  await expectError('42501', () => runtime.query('SELECT count(*) FROM hon.school_number_orders'), 'runtime cannot read orders directly');
  await expectError('42501', () => runtime.query('SELECT * FROM hon.claim_school_number_purchases(1, 60)'), 'runtime cannot claim purchases');
  await expectError('42501', () => runtime.query('SELECT hon.require_school_sender_manager($1)', [subject.owner]), 'the actor check is private');
  await expectError('42501', () => worker.query('SELECT count(*) FROM hon.school_number_orders'), 'worker cannot read orders directly');
  await expectError('42501', () => worker.query('SELECT hon.read_hq_school_number_orders($1, NULL)', [subject.hq]), 'worker cannot run HQ reads');

  // 2. Entitlement and permission.
  await expectError('42501', () => request(number), 'no entitlement in effect: no request');
  await admin.query("INSERT INTO hon.organization_entitlements (organization_id, tier, status, effective_from) VALUES ($1, 'CORE', 'ACTIVE', now() - interval '1 day'), ($2, 'CORE', 'ACTIVE', now() - interval '1 day')", [ids.org, ids.org2]);
  await expectError('42501', () => asStaff(subject.staff, ids.staffPrincipal, ids.org, ids.schoolA, 'SELECT hon.request_school_number($1,$2::jsonb,$3) AS data',
    [subject.staff, JSON.stringify(number), `key-${randomUUID()}`]), 'staff without communication.sender.manage cannot request');
  await expectError('42501', () => owner('SELECT hon.read_school_number_orders($1) AS data', [subject.owner], ids.schoolB, ids.org2), "the owner cannot act in another organization's school");
  await expectError('42501', () => runtime.query('SELECT hon.request_school_number($1,$2::jsonb,$3) AS data', [subject.owner, JSON.stringify(number), 'key-nosession']),
    'without a HON session nothing is requested');
  const scope = await owner('SELECT hon.authorize_school_number_search($1) AS data', [subject.owner]);
  check(scope.schoolId === ids.schoolA && scope.hasProvisionedSender === false && scope.openOrder === null, 'search scope: this school, no number, no open order');

  // 3. Request validation and one open order.
  for (const bad of [{ ...number, phoneE164: '5125550101' }, { ...number, phoneE164: '+445555550101' }, { ...number, monthlyPriceMicrounits: -1 },
    { ...number, extra: 1 }, { phoneE164: number.phoneE164 }, { ...number, region: 'Texas' }]) {
    await expectError('22023', () => request(bad), `invalid order refused: ${JSON.stringify(bad)}`);
  }
  const key = `key-${randomUUID()}`;
  const first = await request(number, key);
  check(first.status === 'REQUESTED' && first.monthlyPriceMicrounits === 1150000 && first.version === 1, 'the order is REQUESTED with the quoted price');
  check((await request(number, key)).orderId === first.orderId, 'the same key replays the same order');
  await expectError('22023', () => request({ ...number, phoneE164: '+15125550102' }, key), 'a reused key with another number is refused');
  await expectError('55000', () => request({ ...number, phoneE164: '+15125550102' }), 'a second open order is refused');
  await expectError('55000', () => owner('SELECT hon.request_school_number($1,$2::jsonb,$3) AS data', [subject.owner, JSON.stringify(number), `key-${randomUUID()}`]),
    'the same number twice is refused');
  check((await owner('SELECT hon.read_school_number_orders($1) AS data', [subject.owner])).orders.length === 1, 'the owner reads the one order');
  check((await admin.query("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id = $1 AND action_code = 'communication.number_order.requested'", [first.orderId])).rows[0].n === 1, 'the request is audited');

  // 4. HQ decides; only an HQ owner; versioned; nothing claimable before approval.
  check((await claim()).length === 0, 'a REQUESTED order is not claimable');
  await expectError('42501', () => runtime.query('SELECT hon.decide_school_number_order_from_hq($1,$2,$3,NULL,1) AS data', [subject.owner, first.orderId, 'APPROVE']), 'a school owner cannot approve');
  await expectError('40001', () => decide(first.orderId, 'APPROVE', 9), 'a stale version is refused');
  await expectError('22023', () => decide(first.orderId, 'MAYBE', 1), 'an unknown decision is refused');
  const hqList = (await runtime.query("SELECT hon.read_hq_school_number_orders($1, 'REQUESTED') AS data", [subject.hq])).rows[0].data;
  check(hqList.orders.some((o) => o.orderId === first.orderId && o.schoolName === 'Austin Dojo'), 'HQ sees the requested order with the school name');
  const approved = await decide(first.orderId, 'APPROVE', 1, 'OK');
  check(approved.status === 'APPROVED' && approved.version === 2, 'HQ approves');
  await expectError('55000', () => decide(first.orderId, 'REJECT', 2), 'a decided order cannot be decided again');

  // 5. Worker claim, lease, RETRY, UNKNOWN reconcile and PURCHASED.
  let [c1] = await claim();
  check(c1?.order_id === first.orderId && c1.attempt === 1 && c1.outcome_unknown === false, 'the approved order is claimed');
  check((await claim()).length === 0, 'a leased order is not claimed twice');
  await expectError('40001', () => record({ ...c1, lease_token: randomUUID() }, 'FAILED'), 'a wrong lease is refused');
  check((await record(c1, 'RETRY', { failure: 'PROVISIONING_OFF' })).status === 'APPROVED', 'RETRY (switch off) returns the order to APPROVED');
  [c1] = await claim();
  check((await record(c1, 'UNKNOWN')).status === 'PURCHASING', 'UNKNOWN keeps PURCHASING');
  const [c2] = await claim();
  check(c2?.order_id === first.orderId && c2.outcome_unknown === true && c2.attempt === 3, 'the next claim is flagged for reconciliation by reading the subaccount');
  await expectError('42501', () => record(c2, 'PURCHASED', { number: pn('1'), service: mg('1'), account: acct('a') }), 'PURCHASED needs the school\'s own ACTIVE subaccount');
  await admin.query("INSERT INTO hon.school_twilio_accounts (organization_id, school_id, account_sid, status, sealed_auth_token, vault_key_id) VALUES ($1,$2,$3,'ACTIVE',$4,'staging-1'), ($5,$6,$7,'ACTIVE',$4,'staging-1')",
    [ids.org, ids.schoolA, acct('a'), `v1.${'A'.repeat(16)}.${'B'.repeat(12)}.${'C'.repeat(22)}`, ids.org2, ids.schoolB, acct('b')]);
  await expectError('42501', () => record(c2, 'PURCHASED', { number: pn('1'), service: mg('1'), account: acct('b') }), "another school's subaccount is refused");
  await expectError('22023', () => record(c2, 'PURCHASED', { number: 'PN1', service: mg('1'), account: acct('a') }), 'a malformed number SID is refused');
  check((await record(c2, 'PURCHASED', { number: pn('1'), service: mg('1'), account: acct('a') })).status === 'PURCHASED', 'the purchase is recorded');
  const sender = (await admin.query('SELECT * FROM hon.school_text_senders WHERE school_id = $1', [ids.schoolA])).rows[0];
  check(sender.phone_e164 === number.phoneE164 && sender.messaging_service_sid === mg('1') && sender.twilio_account_sid === acct('a')
    && sender.status === 'DISABLED' && sender.mms_converter_confirmed === true, 'the bought number is the school\'s sender on its subaccount, switched off until A2P');
  await expectError('40001', () => record(c2, 'FAILED'), 'a finished order takes no more results');
  check((await admin.query("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id = $1 AND action_code = 'communication.number_order.purchased'", [first.orderId])).rows[0].n === 1, 'the purchase is audited');
  await expectError('55000', () => request({ ...number, phoneE164: '+15125550109' }), 'a school with a bought number cannot order another');

  // 6. The 0248 HQ setter cannot move a HON-bought number; it can still switch it on or off.
  const setSender = (phone, service, status, version) => runtime.query('SELECT hon.set_school_text_sender_from_hq($1,$2,$3,$4,$5,true,$6) AS data', [subject.hq, ids.schoolA, phone, service, status, version]);
  await expectError('55000', () => setSender('+15125550199', mg('1'), 'DISABLED', sender.version), 'HQ cannot change the phone of a HON-bought number');
  await expectError('55000', () => setSender(number.phoneE164, mg('9'), 'DISABLED', sender.version), 'HQ cannot change the service of a HON-bought number');
  check((await setSender(number.phoneE164, mg('1'), 'DISABLED', sender.version)).rows[0].data.status === 'DISABLED', 'HQ can still set the status of a HON-bought number');

  // 7. Reject, cancel and failure paths on school B (another organization).
  await admin.query('INSERT INTO hon.principal_role_grants (organization_id, school_id, principal_id, role_id, granted_by_principal_id, effective_from) VALUES ($1,$2,$3,$4,$3, clock_timestamp() - interval \'1 hour\')',
    [ids.org2, ids.schoolB, ids.ownerPrincipal, ids.ownerRole2]);
  const b1 = await owner('SELECT hon.request_school_number($1,$2::jsonb,$3) AS data', [subject.owner, JSON.stringify({ ...number, phoneE164: '+12065550101' }), `key-${randomUUID()}`], ids.schoolB, ids.org2);
  check((await decide(b1.orderId, 'REJECT', 1, 'Pick a local number')).status === 'REJECTED', 'HQ rejects');
  const b2 = await owner('SELECT hon.request_school_number($1,$2::jsonb,$3) AS data', [subject.owner, JSON.stringify({ ...number, phoneE164: '+12065550102' }), `key-${randomUUID()}`], ids.schoolB, ids.org2);
  await expectError('40001', () => owner('SELECT hon.cancel_school_number_order($1,$2,$3) AS data', [subject.owner, b2.orderId, 9], ids.schoolB, ids.org2), 'cancel checks the version');
  await expectError('P0002', () => owner('SELECT hon.cancel_school_number_order($1,$2,$3) AS data', [subject.owner, b2.orderId, 1]), "school A's session cannot cancel school B's order");
  check((await owner('SELECT hon.cancel_school_number_order($1,$2,$3) AS data', [subject.owner, b2.orderId, 1], ids.schoolB, ids.org2)).status === 'CANCELLED', 'the owner cancels');
  const b3 = await owner('SELECT hon.request_school_number($1,$2::jsonb,$3) AS data', [subject.owner, JSON.stringify({ ...number, phoneE164: '+12065550103' }), `key-${randomUUID()}`], ids.schoolB, ids.org2);
  await decide(b3.orderId, 'APPROVE', 1);
  // Inactive school: approved orders are not claimed.
  await admin.query("UPDATE hon.organization_entitlements SET effective_until = now() - interval '1 minute' WHERE organization_id = $1", [ids.org2]);
  check((await claim()).length === 0, 'an approved order of a school whose entitlement lapsed is not claimed');
  await admin.query('UPDATE hon.organization_entitlements SET effective_until = NULL WHERE organization_id = $1', [ids.org2]);
  const [cb] = await claim();
  check((await record(cb, 'FAILED', { failure: 'NUMBER_NO_LONGER_AVAILABLE' })).status === 'FAILED', 'a refused purchase is FAILED');
  check((await order(b3.orderId)).failure_code === 'NUMBER_NO_LONGER_AVAILABLE', 'with the failure code');
  // An unknown buy settled by Twilio refusing the number (after this attempt found it on no subaccount) frees the school.
  const b5 = await owner('SELECT hon.request_school_number($1,$2::jsonb,$3) AS data', [subject.owner, JSON.stringify({ ...number, phoneE164: '+12065550105' }), `key-${randomUUID()}`], ids.schoolB, ids.org2);
  await decide(b5.orderId, 'APPROVE', 1);
  { const [c] = await claim(); await record(c, 'UNKNOWN'); }
  { const [c] = await claim(); check(c.outcome_unknown === true, 'the next claim is told the last outcome is unknown'); await record(c, 'FAILED', { failure: 'NUMBER_UNAVAILABLE' }); }
  check((await order(b5.orderId)).outcome_unknown === false, 'Twilio refusing the buy settles an unknown order');
  // Reviewer P2: a lost buy followed by four RETRYs must not end as an ordinary failure that frees the school and number.
  const b4 = await owner('SELECT hon.request_school_number($1,$2::jsonb,$3) AS data', [subject.owner, JSON.stringify({ ...number, phoneE164: '+12065550104' }), `key-${randomUUID()}`], ids.schoolB, ids.org2);
  await decide(b4.orderId, 'APPROVE', 1);
  { const [c] = await claim(); await record(c, 'UNKNOWN'); }
  for (let i = 0; i < 4; i += 1) { const [c] = await claim(); await record(c, 'RETRY', { failure: 'PROVIDER_UNREACHABLE' }); }
  check((await order(b4.orderId)).outcome_unknown === true, 'RETRY never clears an earlier unknown buy');
  check((await claim()).length === 0, 'the sixth claim does not buy');
  const settled = await order(b4.orderId);
  check(settled.status === 'FAILED' && settled.failure_code === 'RECONCILE_REQUIRED' && settled.outcome_unknown === true, 'it ends FAILED RECONCILE_REQUIRED, still marked unknown');
  const listed = (await owner('SELECT hon.read_school_number_orders($1) AS data', [subject.owner], ids.schoolB, ids.org2)).orders.find((o) => o.orderId === b4.orderId);
  check(listed.outcomeUnknown === true, 'the order JSON shows outcomeUnknown');
  await expectError('55000', () => owner('SELECT hon.request_school_number($1,$2::jsonb,$3) AS data', [subject.owner, JSON.stringify({ ...number, phoneE164: '+12065550106' }), `key-${randomUUID()}`], ids.schoolB, ids.org2),
    'an unsettled order blocks a second number for that school');
  const scopeB = await owner('SELECT hon.authorize_school_number_search($1) AS data', [subject.owner], ids.schoolB, ids.org2);
  check(scopeB.openOrder?.orderId === b4.orderId, 'the search scope reports the unsettled order');
  const heldIndex = (await admin.query("SELECT count(*)::int n FROM pg_indexes WHERE indexname = 'school_number_orders_one_number' AND indexdef LIKE '%outcome_unknown%'")).rows[0].n;
  check(heldIndex === 1, 'an unsettled order keeps its number reserved');
  // Five attempts with nothing ever sent (no unknown, no number) end as an ordinary ATTEMPTS_EXHAUSTED failure.
  // 7a. T2c (0358): a human HQ owner settles the unsettled order after checking the school's Twilio subaccount.
  const settle = async (id, finding, version, note = 'Checked the subaccount in the Twilio console', who = subject.hq) =>
    (await runtime.query('SELECT hon.settle_school_number_order_from_hq($1,$2,$3,$4,$5) AS data', [who, id, finding, note, version])).rows[0].data;
  const v4 = (await order(b4.orderId)).version;
  await expectError('42501', () => settle(b4.orderId, 'NOT_BOUGHT', v4, undefined, subject.owner), 'a school owner cannot settle');
  await expectError('42501', () => settle(b4.orderId, 'NOT_BOUGHT', v4, undefined, subject.staff), 'staff cannot settle');
  await expectError('40001', () => settle(b4.orderId, 'NOT_BOUGHT', v4 - 1), 'a stale version is refused');
  await expectError('22023', () => settle(b4.orderId, 'MAYBE', v4), 'an unknown finding is refused');
  await expectError('22023', () => settle(b4.orderId, 'NOT_BOUGHT', v4, ' padded '), 'an untrimmed note is refused');
  await expectError('22023', () => settle(b4.orderId, 'NOT_BOUGHT', v4, ''), 'an empty note is refused');
  await expectError('P0002', () => settle(randomUUID(), 'NOT_BOUGHT', 1), 'a missing order is refused');
  await expectError('55000', async () => settle(b5.orderId, 'NOT_BOUGHT', (await order(b5.orderId)).version), 'a settled FAILED order is not unsettled');
  await expectError('55000', async () => settle(first.orderId, 'BOUGHT', (await order(first.orderId)).version), 'a PURCHASED order cannot be settled');
  // The guard: even the table owner cannot free an unsettled order without a full settle record, or forge one.
  await expectError('42501', () => admin.query('UPDATE hon.school_number_orders SET outcome_unknown = false, version = version + 1 WHERE id = $1', [b4.orderId]), 'clearing the unknown flag needs a settle record');
  await expectError('42501', () => admin.query("UPDATE hon.school_number_orders SET settled_by = $2, settled_at = now(), settle_finding = 'NOT_BOUGHT', settle_note = 'x', failure_code = 'SETTLED_NOT_BOUGHT', version = version + 1 WHERE id = $1", [b5.orderId, ids.hqPrincipal]), 'a settle record cannot be written on an order that is not unsettled');
  await expectError('42501', () => admin.query("UPDATE hon.school_number_orders SET settled_by = $2, settled_at = now(), settle_finding = 'NOT_BOUGHT', settle_note = 'x', failure_code = 'SETTLED_NOT_BOUGHT', status = 'CANCELLED', outcome_unknown = false, version = version + 1 WHERE id = $1", [b4.orderId, ids.hqPrincipal]), 'NOT_BOUGHT keeps the order FAILED');
  await expectError('42501', () => admin.query("UPDATE hon.school_number_orders SET settled_by = $2, settle_finding = 'NOT_BOUGHT', settle_note = 'x', failure_code = 'SETTLED_NOT_BOUGHT', outcome_unknown = false, version = version + 1 WHERE id = $1", [b4.orderId, ids.hqPrincipal]), 'a settle record without its time is refused (the guard first, then the all-or-none CHECK)');
  const notBought = await settle(b4.orderId, 'NOT_BOUGHT', v4);
  check(notBought.status === 'FAILED' && notBought.outcomeUnknown === false && notBought.version === v4 + 1 && notBought.schoolName, 'NOT_BOUGHT settles the order and returns it with the school name');
  const r4 = await order(b4.orderId);
  check(r4.failure_code === 'SETTLED_NOT_BOUGHT' && r4.settle_finding === 'NOT_BOUGHT' && r4.settled_by === ids.hqPrincipal && r4.settled_at, 'the settle record names the HQ owner and the finding');
  check((await admin.query("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id = $1 AND action_code = 'communication.number_order.settled' AND actor_principal_id = $2 AND next_state->>'finding' = 'NOT_BOUGHT'", [b4.orderId, ids.hqPrincipal])).rows[0].n === 1, 'the settle is audited');
  await expectError('55000', () => settle(b4.orderId, 'NOT_BOUGHT', v4 + 1), 'a settled order cannot be settled twice');
  await expectError('42501', () => admin.query("UPDATE hon.school_number_orders SET status = 'APPROVED', version = version + 1 WHERE id = $1", [b4.orderId]), 'a NOT_BOUGHT order never reopens');
  check((await owner('SELECT hon.authorize_school_number_search($1) AS data', [subject.owner], ids.schoolB, ids.org2)).openOrder === null, 'NOT_BOUGHT frees the school');
  const b7 = await owner('SELECT hon.request_school_number($1,$2::jsonb,$3) AS data', [subject.owner, JSON.stringify({ ...number, phoneE164: '+12065550107' }), `key-${randomUUID()}`], ids.schoolB, ids.org2);
  await decide(b7.orderId, 'APPROVE', 1);
  for (let i = 0; i < 5; i += 1) { const [c] = await claim(); await record(c, 'RETRY', { failure: 'SUBACCOUNT_BUSY' }); }
  check((await claim()).length === 0 && (await order(b7.orderId)).failure_code === 'ATTEMPTS_EXHAUSTED' && (await order(b7.orderId)).outcome_unknown === false, 'five plain retries end ATTEMPTS_EXHAUSTED');
  // BOUGHT: the number is on the subaccount. The order goes back to APPROVED, the worker finds it (never buys again) and finishes.
  const reuse = await owner('SELECT hon.request_school_number($1,$2::jsonb,$3) AS data', [subject.owner, JSON.stringify({ ...number, phoneE164: '+12065550104' }), `key-${randomUUID()}`], ids.schoolB, ids.org2);
  check(reuse.status === 'REQUESTED', 'NOT_BOUGHT frees the number for a new order');
  await owner('SELECT hon.cancel_school_number_order($1,$2,$3) AS data', [subject.owner, reuse.orderId, 1], ids.schoolB, ids.org2);
  const b8 = await owner('SELECT hon.request_school_number($1,$2::jsonb,$3) AS data', [subject.owner, JSON.stringify({ ...number, phoneE164: '+12065550108' }), `key-${randomUUID()}`], ids.schoolB, ids.org2);
  await decide(b8.orderId, 'APPROVE', 1);
  { const [c] = await claim(); await record(c, 'UNKNOWN'); }
  for (let i = 0; i < 4; i += 1) { const [c] = await claim(); await record(c, 'RETRY', { failure: 'PROVIDER_UNREACHABLE', number: pn('2') }); }
  check((await claim()).length === 0, 'the sixth claim ends it');
  const u8 = await order(b8.orderId);
  check(u8.status === 'FAILED' && u8.failure_code === 'RECONCILE_REQUIRED' && u8.outcome_unknown, 'a second order ends unsettled');
  await expectError('42501', () => admin.query("UPDATE hon.school_number_orders SET settled_by = $2, settled_at = now(), settle_finding = 'BOUGHT', settle_note = 'x', failure_code = 'SETTLED_BOUGHT', status = 'APPROVED', attempts = 3, version = version + 1 WHERE id = $1", [b8.orderId, ids.hqPrincipal]), 'BOUGHT always restarts the attempts');
  await expectError('42501', () => admin.query("UPDATE hon.school_number_orders SET settled_by = $2, settled_at = now(), settle_finding = 'BOUGHT', settle_note = 'x', failure_code = 'SETTLED_BOUGHT', status = 'APPROVED', attempts = 0, outcome_unknown = false, version = version + 1 WHERE id = $1", [b8.orderId, ids.hqPrincipal]), 'BOUGHT keeps the order marked unknown');
  const bought = await settle(b8.orderId, 'BOUGHT', u8.version, 'Number is on the subaccount');
  check(bought.status === 'APPROVED' && bought.outcomeUnknown === true, 'BOUGHT moves the order back to APPROVED, still marked unknown');
  const r8 = await order(b8.orderId);
  check(r8.attempts === 0 && r8.failure_code === 'SETTLED_BOUGHT' && r8.settle_finding === 'BOUGHT', 'with fresh attempts and the finding recorded');
  const [c8] = await claim();
  check(c8?.order_id === b8.orderId && c8.outcome_unknown === true && c8.attempt === 1, 'the worker claims it told to find the number on the subaccount');
  check((await record(c8, 'PURCHASED', { number: pn('2'), service: mg('2'), account: acct('b') })).status === 'PURCHASED', 'the worker finishes the order');
  check((await admin.query('SELECT count(*)::int n FROM hon.school_text_senders WHERE school_id = $1 AND phone_e164 = $2', [ids.schoolB, '+12065550108'])).rows[0].n === 1, 'the found number becomes the school sender');
  await expectError('42501', () => admin.query("UPDATE hon.school_number_orders SET settle_note = 'rewritten', version = version + 1 WHERE id = $1", [b8.orderId]), 'a settle record is never rewritten');

  // 7b. Guard triggers: even the table owner cannot rewrite an order, reopen a finished one, or move a subaccount.
  await expectError('42501', () => admin.query("UPDATE hon.school_number_orders SET phone_e164 = '+15125550177', version = version + 1 WHERE id = $1", [b2.orderId]), 'an order\'s number never changes');
  await expectError('42501', () => admin.query("UPDATE hon.school_number_orders SET monthly_price_microunits = 1, version = version + 1 WHERE id = $1", [first.orderId]), 'the quoted price never changes');
  await expectError('42501', () => admin.query("UPDATE hon.school_number_orders SET status = 'APPROVED', version = version + 1 WHERE id = $1", [b2.orderId]), 'a cancelled order never reopens');
  await expectError('42501', () => admin.query("UPDATE hon.school_number_orders SET status = 'REQUESTED', version = version + 1 WHERE id = $1", [first.orderId]), 'a purchased order never changes');
  await expectError('42501', () => admin.query('DELETE FROM hon.school_number_orders WHERE id = $1', [b1.orderId]), 'an order is never deleted');
  await expectError('42501', () => admin.query('TRUNCATE hon.school_number_orders'), 'orders are never truncated');
  await expectError('42501', () => admin.query('UPDATE hon.school_twilio_accounts SET account_sid = $2, version = version + 1 WHERE school_id = $1', [ids.schoolA, acct('9')]), 'a recorded subaccount SID never changes');
  await expectError('42501', () => admin.query('DELETE FROM hon.school_twilio_accounts WHERE school_id = $1', [ids.schoolA]), 'a subaccount row is never deleted');

  // 8. The deployment verifier's 0352 section (infra/postgres/011) passes here with this database's runtime role.
  {
    const verify = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
    const start = verify.indexOf('-- School number orders exact verification');
    const section = verify.slice(start, verify.indexOf('-- End school number orders exact verification', start));
    const role = (await runtime.query('SELECT current_user AS r')).rows[0].r;
    check(start >= 0 && section.includes('DO $$'), 'the 011 section exists');
    await admin.query(section.replaceAll('hon_runtime', role));
    passed += 1;
  }
  {
    const verify = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
    const start = verify.indexOf('-- School number order settle exact verification');
    const section = verify.slice(start, verify.indexOf('-- End school number order settle exact verification', start));
    const role = (await runtime.query('SELECT current_user AS r')).rows[0].r;
    check(start >= 0 && section.includes('DO $$'), 'the 011 settle section exists');
    await admin.query(section.replaceAll('hon_runtime', role));
    passed += 1;
  }

  console.log(`PASS: school number orders (${passed} checks).`);
} finally {
  await cleanup();
  await Promise.all([admin.end(), runtime.end(), worker.end()]);
}
