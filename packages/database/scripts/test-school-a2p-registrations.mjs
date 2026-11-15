// 0379 school A2P registrations (docs/architecture/SCHOOL_OWN_SENDERS.md §4.3 step 6-7, T3a): only a live OWNER with
// communication.sender.manage at an entitled school submits the confirmed draft and business facts; a human HQ owner
// approves; the worker claims, leases and records each step; an APPROVED campaign on the school's own service switches
// its sender ACTIVE, and the HQ setter can no longer switch a HON-bought sender on without it; no runtime table access.
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const { Client } = pg;
for (const key of ['DATABASE_URL', 'HON_RUNTIME_DATABASE_URL', 'HON_COMMUNICATION_WORKER_DATABASE_URL']) {
  if (!process.env[key]) throw new Error(`${key} is required for the school A2P registration proof.`);
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

const ids = Object.fromEntries(['org', 'org2', 'schoolA', 'schoolB', 'ownerUser', 'ownerPrincipal', 'managerUser', 'managerPrincipal', 'hqUser', 'hqPrincipal',
  'ownerRole', 'managerRole', 'ownerRole2'].map((key) => [key, randomUUID()]));
const subject = { owner: `a2p-owner-${ids.ownerUser}`, manager: `a2p-manager-${ids.managerUser}`, hq: `a2p-hq-${ids.hqUser}` };
const sid = (prefix, c) => `${prefix}${c.repeat(32)}`;

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
const draft = {
  engineVersion: 'A2P_PREPARATION_V1', copyPreparationAvailable: true, warnings: [],
  answers: { campaignUseCase: 'Requested trial, enrollment and school service notifications', campaignDescription: 'Class reminders', messageFlow: 'Signup form',
    websiteUrl: 'https://dojo.example', privacyPolicyUrl: 'https://dojo.example/privacy', termsAndConditionsUrl: 'https://dojo.example/terms', optInUrl: 'https://dojo.example/join' },
  sampleMessages: [{ template: 'CLASS_REMINDER', content: 'Austin Dojo: class at 5pm. Reply STOP to opt out.' }, { template: 'TRIAL_CONFIRMATION', content: 'Austin Dojo: trial booked. Reply HELP for help.' }],
  helpResponseSample: 'Austin Dojo: help at 512-555-0100. Reply STOP to opt out.', stopResponseSample: 'Austin Dojo: you are unsubscribed.',
};
const business = { legalName: 'Austin Dojo LLC', ein: '12-3456789', businessType: 'LLC', street: '100 Main St', city: 'Austin', region: 'TX', postalCode: '78701',
  contactFirstName: 'Pat', contactLastName: 'Lee', contactEmail: 'owner@dojo.example', contactPhone: '+15125550100', contactTitle: 'Owner' };
const input = (over = {}) => ({ brandType: 'LOW_VOLUME_STANDARD', draftDigest: 'a'.repeat(64), business,
  draftInput: { purpose: 'SERVICE_NOTIFICATIONS', ownerConfirmation: 'OWNER_CONFIRMED_FACTS_FOR_DRAFT_ONLY', facts: { businessName: 'Austin Dojo' } }, draft, ...over });
const request = (value, key = `key-${randomUUID()}`, school, org) => owner('SELECT hon.request_school_a2p_registration($1,$2::jsonb,$3) AS data',
  [subject.owner, JSON.stringify(value), key], school, org);
const decide = async (id, decision, version, note = null) =>
  (await runtime.query('SELECT hon.decide_school_a2p_registration_from_hq($1,$2,$3,$4,$5) AS data', [subject.hq, id, decision, note, version])).rows[0].data;
const claim = async (limit = 5, lease = 60) => (await worker.query('SELECT * FROM hon.claim_school_a2p_registrations($1,$2)', [limit, lease])).rows;
const record = async (row, outcome, sids = {}, failure = null, wait = 600) => (await worker.query('SELECT hon.record_school_a2p_progress($1,$2,$3,$4::jsonb,$5,$6) AS data',
  [row.registration_id, row.lease_token, outcome, JSON.stringify(sids), failure, wait])).rows[0].data;
const reg = async (id) => (await admin.query('SELECT * FROM hon.school_a2p_registrations WHERE id = $1', [id])).rows[0];
const due = (id) => admin.query("UPDATE hon.school_a2p_registrations SET next_check_at = now() - interval '1 second', version = version + 1 WHERE id = $1", [id]);
const sender = async (school = ids.schoolA) => (await admin.query('SELECT * FROM hon.school_text_senders WHERE school_id = $1', [school])).rows[0];

async function cleanup() {
  await admin.query('BEGIN');
  for (const t of ['school_a2p_registrations', 'school_twilio_accounts']) await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER guarded`); // the guards forbid deletes; the disposable fixture's owner lifts them for cleanup only
  try {
    for (const org of [ids.org, ids.org2]) {
      await admin.query('DELETE FROM hon.audit_events WHERE organization_id = $1', [org]);
      await admin.query('DELETE FROM hon.school_a2p_registrations WHERE organization_id = $1', [org]);
      await admin.query('DELETE FROM hon.school_text_senders WHERE organization_id = $1', [org]);
      await admin.query('DELETE FROM hon.school_twilio_accounts WHERE organization_id = $1', [org]);
      await admin.query('DELETE FROM hon.organization_entitlements WHERE organization_id = $1', [org]);
      await admin.query('DELETE FROM hon.principal_role_grants WHERE organization_id = $1', [org]);
      await admin.query('DELETE FROM hon.role_permissions WHERE organization_id = $1', [org]);
      await admin.query('DELETE FROM hon.roles WHERE organization_id = $1', [org]);
    }
    await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id = $1', [ids.hqPrincipal]);
    await admin.query('DELETE FROM hon.principals WHERE id = ANY($1::uuid[])', [[ids.ownerPrincipal, ids.managerPrincipal, ids.hqPrincipal]]);
    await admin.query('DELETE FROM hon.users WHERE id = ANY($1::uuid[])', [[ids.ownerUser, ids.managerUser, ids.hqUser]]);
    await admin.query('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [[ids.org, ids.org2]]);
    await admin.query('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [[ids.org, ids.org2]]);
    for (const t of ['school_a2p_registrations', 'school_twilio_accounts']) await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER guarded`);
    await admin.query('COMMIT');
  } catch (error) { await admin.query('ROLLBACK'); throw error; }
}

await Promise.all([admin.connect(), runtime.connect(), worker.connect()]);
try {
  await admin.query("INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, 'A2P Org', 'A2P Org'), ($2, 'Other Org', 'Other Org')", [ids.org, ids.org2]);
  await admin.query("INSERT INTO hon.schools (id, organization_id, name, slug, timezone) VALUES ($1,$2,'Austin Dojo',$3,'America/Chicago'), ($4,$5,'Other Dojo',$6,'UTC')",
    [ids.schoolA, ids.org, `austin-${ids.schoolA.slice(0, 8)}`, ids.schoolB, ids.org2, `other-${ids.schoolB.slice(0, 8)}`]);
  for (const [user, principal, who, name] of [[ids.ownerUser, ids.ownerPrincipal, subject.owner, 'Owner'], [ids.managerUser, ids.managerPrincipal, subject.manager, 'Manager'],
    [ids.hqUser, ids.hqPrincipal, subject.hq, 'HQ']]) {
    await admin.query('INSERT INTO hon.users (id, external_subject, email, display_name) VALUES ($1, $2, $3, $4)', [user, who, `${who}@example.test`, name]);
    await admin.query("INSERT INTO hon.principals (id, principal_type, user_id, display_name) VALUES ($1, 'HUMAN_USER', $2, $3)", [principal, user, name]);
  }
  await admin.query("INSERT INTO hon.hq_operator_grants (principal_id, hq_role) VALUES ($1, 'HON_HQ_OWNER')", [ids.hqPrincipal]);
  // The manager holds communication.sender.manage through a non-OWNER role: enough to order a number, not to confirm facts.
  await admin.query("INSERT INTO hon.roles (id, organization_id, code, name, is_system_role) VALUES ($1,$2,'OWNER','Owner',true), ($3,$2,'MANAGER','Manager',false), ($4,$5,'OWNER','Owner',true)",
    [ids.ownerRole, ids.org, ids.managerRole, ids.ownerRole2, ids.org2]);
  await admin.query("INSERT INTO hon.role_permissions (role_id, organization_id, permission_code) VALUES ($1,$2,'communication.sender.manage'), ($3,$2,'communication.sender.manage'), ($4,$5,'communication.sender.manage')",
    [ids.ownerRole, ids.org, ids.managerRole, ids.ownerRole2, ids.org2]);
  await admin.query(`INSERT INTO hon.principal_role_grants (organization_id, school_id, principal_id, role_id, granted_by_principal_id, effective_from)
    VALUES ($1,$2,$3,$4,$3, clock_timestamp() - interval '1 hour'), ($1,$2,$5,$6,$3, clock_timestamp() - interval '1 hour'), ($7,$8,$3,$9,$3, clock_timestamp() - interval '1 hour')`,
    [ids.org, ids.schoolA, ids.ownerPrincipal, ids.ownerRole, ids.managerPrincipal, ids.managerRole, ids.org2, ids.schoolB, ids.ownerRole2]);

  // 1. Role boundaries.
  await expectError('42501', () => runtime.query('SELECT count(*) FROM hon.school_a2p_registrations'), 'runtime cannot read registrations directly');
  await expectError('42501', () => runtime.query('SELECT * FROM hon.claim_school_a2p_registrations(1, 60)'), 'runtime cannot claim registrations');
  await expectError('42501', () => runtime.query('SELECT hon.require_school_a2p_owner($1)', [subject.owner]), 'the owner check is private');
  await expectError('42501', () => runtime.query("SELECT hon.school_a2p_business('{}'::jsonb)"), 'the business check is private');
  await expectError('42501', () => worker.query('SELECT count(*) FROM hon.school_a2p_registrations'), 'worker cannot read registrations directly');
  await expectError('42501', () => worker.query('SELECT hon.read_hq_school_a2p_registrations($1, NULL)', [subject.hq]), 'worker cannot run HQ reads');

  // 2. Entitlement, OWNER role and tenant boundary.
  await expectError('42501', () => request(input()), 'no entitlement in effect: no request');
  await admin.query("INSERT INTO hon.organization_entitlements (organization_id, tier, status, effective_from) VALUES ($1, 'CORE', 'ACTIVE', now() - interval '1 day'), ($2, 'CORE', 'ACTIVE', now() - interval '1 day')", [ids.org, ids.org2]);
  await expectError('42501', () => asStaff(subject.manager, ids.managerPrincipal, ids.org, ids.schoolA, 'SELECT hon.request_school_a2p_registration($1,$2::jsonb,$3) AS data',
    [subject.manager, JSON.stringify(input()), `key-${randomUUID()}`]), 'a manager with communication.sender.manage but no OWNER role cannot confirm facts');
  await expectError('42501', () => owner('SELECT hon.read_school_a2p_registrations($1) AS data', [subject.owner], ids.schoolB, ids.org), "the owner cannot read another organization's school from this one");
  await expectError('42501', () => runtime.query('SELECT hon.request_school_a2p_registration($1,$2::jsonb,$3) AS data', [subject.owner, JSON.stringify(input()), 'key-nosession']),
    'without a HON session nothing is requested');

  // 3. Validation: exact keys and shapes, owner confirmation, complete draft, business facts.
  const bads = [
    input({ extra: 1 }), input({ brandType: 'SOLE_PROPRIETOR' }), input({ draftDigest: 'nothex' }),
    input({ draftInput: { purpose: 'SERVICE_NOTIFICATIONS', facts: {} } }), input({ draftInput: { purpose: 'OTHER', ownerConfirmation: 'OWNER_CONFIRMED_FACTS_FOR_DRAFT_ONLY' } }),
    input({ draft: { ...draft, copyPreparationAvailable: false } }), input({ draft: { ...draft, answers: null } }), input({ draft: { ...draft, saved: false } }),
    input({ draft: { ...draft, engineVersion: 'OTHER' } }), input({ draft: { ...draft, sampleMessages: [] } }),
    input({ business: { ...business, ein: '123' } }), input({ business: { ...business, ein: '11-1111111' } }), input({ business: { ...business, businessType: 'SOLE_PROPRIETOR' } }),
    input({ business: { ...business, region: 'Texas' } }), input({ business: { ...business, postalCode: '7870' } }), input({ business: { ...business, contactPhone: '5125550100' } }),
    input({ business: { ...business, contactEmail: 'nope' } }), input({ business: { ...business, legalName: ' Padded' } }), input({ business: { ...business, extra: 'x' } }),
    input({ business: { ...business, city: 5 } }),
  ];
  for (const bad of bads) await expectError('22023', () => request(bad), `invalid registration refused: ${JSON.stringify(bad).slice(0, 120)}`);
  const key = `key-${randomUUID()}`;
  const first = await request(input(), key);
  check(first.status === 'REQUESTED' && first.useCase === 'ACCOUNT_NOTIFICATION' && first.brandType === 'LOW_VOLUME_STANDARD' && first.version === 1, 'the registration is REQUESTED with the use case from the confirmed purpose');
  check(first.business.einLast4 === '6789' && !('ein' in first.business) && !JSON.stringify(first).includes('3456789'), 'reads show only the last four EIN digits');
  check((await reg(first.registrationId)).business.ein === '123456789', 'the EIN is stored as nine digits');
  check(first.answers.campaignDescription === 'Class reminders' && first.sampleMessages.length === 2 && first.brandRegistered === false, 'the frozen draft is returned for review');
  check((await request(input(), key)).registrationId === first.registrationId, 'the same key replays the same registration');
  await expectError('22023', () => request(input({ draftDigest: 'b'.repeat(64) }), key), 'a reused key with another draft is refused');
  await expectError('55000', () => request(input()), 'a second open registration is refused');
  check((await owner('SELECT hon.read_school_a2p_registrations($1) AS data', [subject.owner])).registrations.length === 1, 'the owner reads the one registration');
  check((await admin.query("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id = $1 AND action_code = 'communication.a2p_registration.requested'", [first.registrationId])).rows[0].n === 1, 'the request is audited');

  // 4. HQ decides; only an HQ owner; versioned; a rejection says why.
  check((await claim()).length === 0, 'a REQUESTED registration is not claimable');
  await expectError('42501', () => runtime.query('SELECT hon.decide_school_a2p_registration_from_hq($1,$2,$3,NULL,1) AS data', [subject.owner, first.registrationId, 'APPROVE']), 'a school owner cannot approve');
  await expectError('40001', () => decide(first.registrationId, 'APPROVE', 9), 'a stale version is refused');
  await expectError('22023', () => decide(first.registrationId, 'REJECT', 1), 'a rejection needs a reason');
  await expectError('22023', () => decide(first.registrationId, 'APPROVE', 1, ' padded'), 'an untrimmed note is refused');
  const hqList = (await runtime.query("SELECT hon.read_hq_school_a2p_registrations($1, 'REQUESTED') AS data", [subject.hq])).rows[0].data;
  check(hqList.registrations.some((r) => r.registrationId === first.registrationId && r.schoolName === 'Austin Dojo' && r.business.einLast4 === '6789'), 'HQ sees it with the school name and masked EIN');
  const approved = await decide(first.registrationId, 'APPROVE', 1, 'Facts match the website');
  check(approved.status === 'SUBMIT_APPROVED' && approved.version === 2, 'HQ approves the submission');
  await expectError('55000', () => decide(first.registrationId, 'REJECT', 2, 'Too late'), 'a decided registration cannot be decided again');

  // 5. The worker waits for the school's own ACTIVE subaccount.
  check((await claim()).length === 0, 'no claim before the school has its own subaccount');
  await admin.query("INSERT INTO hon.school_twilio_accounts (organization_id, school_id, account_sid, status, sealed_auth_token, vault_key_id) VALUES ($1,$2,$3,'ACTIVE',$4,'staging-1'), ($5,$6,$7,'ACTIVE',$4,'staging-1')",
    [ids.org, ids.schoolA, sid('AC', 'a'), `v1.${'A'.repeat(16)}.${'B'.repeat(12)}.${'C'.repeat(22)}`, ids.org2, ids.schoolB, sid('AC', 'b')]);
  let [c1] = await claim();
  check(c1?.registration_id === first.registrationId && c1.stage === 'SUBMITTING' && c1.attempt === 1 && c1.account_sid === sid('AC', 'a') && c1.messaging_service_sid === null,
    'the approved registration is claimed with its subaccount, and no sender service yet');
  check(c1.business.ein === '123456789' && c1.draft.answers.campaignDescription === 'Class reminders' && c1.use_case === 'ACCOUNT_NOTIFICATION', 'the claim carries the frozen facts for Twilio');
  check((await claim()).length === 0, 'a leased registration is not claimed twice');
  await expectError('40001', () => record({ ...c1, lease_token: randomUUID() }, 'RETRY'), 'a wrong lease is refused');
  await expectError('22023', () => record(c1, 'FAILED'), 'a failure needs a code');
  await expectError('22023', () => record(c1, 'BRAND_PENDING', { brandSid: 'BN1' }), 'a malformed SID is refused');
  await expectError('22023', () => record(c1, 'BRAND_PENDING', { other: sid('BU', '1') }), 'an unknown SID key is refused');
  await expectError('22023', () => record(c1, 'BRAND_PENDING', {}, null, 10), 'a wait under a minute is refused');
  check((await record(c1, 'RETRY', {}, 'A2P_SUBMIT_OFF')).status === 'SUBMIT_APPROVED', 'RETRY (switch off) returns it to SUBMIT_APPROVED');
  check((await claim()).length === 0, 'RETRY waits before the next claim');
  await due(first.registrationId);
  [c1] = await claim();
  check((await record(c1, 'UNKNOWN', { customerProfileSid: sid('BU', '1') })).status === 'SUBMITTING', 'UNKNOWN keeps SUBMITTING');
  let [c2] = await claim();
  check(c2?.registration_id === first.registrationId && c2.outcome_unknown === true && c2.customer_profile_sid === sid('BU', '1'), 'the next claim is told to find what exists, with the SIDs seen so far');
  await expectError('22023', () => record(c2, 'BRAND_PENDING', { customerProfileSid: sid('BU', '2') }), 'a recorded SID never changes');
  await expectError('42501', () => record(c2, 'CAMPAIGN_PENDING', { a2pProfileSid: sid('BU', '3'), brandSid: sid('BN', '1'), campaignSid: sid('QE', '1'), messagingServiceSid: sid('MG', '1') }),
    'no campaign without the school\'s own sender on that service');
  check((await record(c2, 'BRAND_PENDING', { a2pProfileSid: sid('BU', '3'), brandSid: sid('BN', '1') }, null, 3600)).status === 'BRAND_PENDING', 'the brand is submitted and in review');
  const pending = await reg(first.registrationId);
  check(pending.attempts === 0 && pending.outcome_unknown === false && pending.brand_sid === sid('BN', '1') && pending.lease_token === null, 'progress restarts the attempts and clears the unknown flag');
  check((await claim()).length === 0, 'a pending registration waits for its next check');
  check((await admin.query("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id = $1 AND action_code = 'communication.a2p_registration.brand_pending'", [first.registrationId])).rows[0].n === 1, 'the brand step is audited');

  // 6. The campaign needs the school's HON-bought sender; APPROVED switches it ACTIVE.
  await admin.query("INSERT INTO hon.school_text_senders (organization_id, school_id, phone_e164, messaging_service_sid, status, mms_converter_confirmed, set_by_principal_id, twilio_account_sid) VALUES ($1,$2,'+15125550101',$3,'DISABLED',true,'00000000-0000-4000-8000-00000000c043',$4), ($5,$6,'+12065550101',$7,'DISABLED',true,'00000000-0000-4000-8000-00000000c043',$8)",
    [ids.org, ids.schoolA, sid('MG', 'a'), sid('AC', 'a'), ids.org2, ids.schoolB, sid('MG', 'b'), sid('AC', 'b')]);
  // 6a. The HQ setter can no longer switch a HON-bought sender on before its campaign is approved.
  const setSender = async (status, school = ids.schoolA) => {
    const s = await sender(school);
    return (await runtime.query('SELECT hon.set_school_text_sender_from_hq($1,$2,$3,$4,$5,true,$6) AS data', [subject.hq, school, s.phone_e164, s.messaging_service_sid, status, s.version])).rows[0].data;
  };
  await expectError('55000', () => setSender('ACTIVE'), 'HQ cannot switch a HON-bought sender ACTIVE without an approved campaign');
  check((await setSender('DISABLED')).status === 'DISABLED', 'HQ can still keep it off');
  await due(first.registrationId);
  [c2] = await claim();
  check(c2.stage === 'BRAND_PENDING' && c2.messaging_service_sid === sid('MG', 'a') && c2.brand_sid === sid('BN', '1'), 'the next check sees the sender service and the brand');
  await expectError('42501', () => record(c2, 'CAMPAIGN_PENDING', { campaignSid: sid('QE', '1'), messagingServiceSid: sid('MG', 'b') }), "another school's service is refused");
  check((await record(c2, 'CAMPAIGN_PENDING', { campaignSid: sid('QE', '1'), messagingServiceSid: sid('MG', 'a') })).status === 'CAMPAIGN_PENDING', 'the campaign is submitted on the school service');
  check((await sender()).status === 'DISABLED', 'the sender stays off while the campaign is in review');
  await due(first.registrationId);
  [c2] = await claim();
  check(c2.stage === 'CAMPAIGN_PENDING' && c2.campaign_sid === sid('QE', '1'), 'the campaign is checked again');
  check((await record(c2, 'APPROVED', {})).status === 'APPROVED', 'the approved campaign is recorded');
  const live = await sender();
  check(live.status === 'ACTIVE' && live.set_by_principal_id === '00000000-0000-4000-8000-00000000c043', 'the school sender is switched ACTIVE by the A2P worker');
  check((await admin.query("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id = $1 AND action_code = 'communication.a2p_registration.approved' AND next_state->>'senderActivated' = 'true'", [first.registrationId])).rows[0].n === 1, 'the approval and activation are audited');
  await expectError('40001', () => record(c2, 'FAILED', {}, 'X_FAILED'), 'an approved registration takes no more results');
  await expectError('55000', () => request(input()), 'an approved school cannot submit another');
  check((await setSender('DISABLED')).status === 'DISABLED', 'HQ can switch an approved sender off');
  check((await setSender('ACTIVE')).status === 'ACTIVE', 'and back on once its campaign is approved');

  // 7. School B: reject, cancel, Twilio refusal, attempts and a moved subaccount.
  const b1 = await request(input(), `key-${randomUUID()}`, ids.schoolB, ids.org2);
  check((await decide(b1.registrationId, 'REJECT', 1, 'The website has no privacy policy')).status === 'REJECTED', 'HQ rejects with a reason');
  check((await claim()).length === 0, 'a rejected registration is never claimed');
  const b2 = await request(input(), `key-${randomUUID()}`, ids.schoolB, ids.org2);
  await expectError('P0002', () => owner('SELECT hon.cancel_school_a2p_registration($1,$2,$3) AS data', [subject.owner, b2.registrationId, 1]), "school A's session cannot cancel school B's registration");
  await expectError('40001', () => owner('SELECT hon.cancel_school_a2p_registration($1,$2,$3) AS data', [subject.owner, b2.registrationId, 9], ids.schoolB, ids.org2), 'cancel checks the version');
  await decide(b2.registrationId, 'APPROVE', 1);
  check((await owner('SELECT hon.cancel_school_a2p_registration($1,$2,$3) AS data', [subject.owner, b2.registrationId, 2], ids.schoolB, ids.org2)).status === 'CANCELLED', 'the owner withdraws before anything is submitted');
  const b3 = await request(input(), `key-${randomUUID()}`, ids.schoolB, ids.org2);
  await decide(b3.registrationId, 'APPROVE', 1);
  await admin.query("UPDATE hon.organization_entitlements SET effective_until = now() - interval '1 minute' WHERE organization_id = $1", [ids.org2]);
  check((await claim()).length === 0, 'a school whose entitlement lapsed is not claimed');
  await admin.query('UPDATE hon.organization_entitlements SET effective_until = NULL WHERE organization_id = $1', [ids.org2]);
  let [cb] = await claim();
  await expectError('55000', async () => owner('SELECT hon.cancel_school_a2p_registration($1,$2,$3) AS data', [subject.owner, b3.registrationId, (await reg(b3.registrationId)).version], ids.schoolB, ids.org2),
    'a submission in progress cannot be withdrawn');
  check((await record(cb, 'FAILED', { customerProfileSid: sid('BU', 'b') }, 'BRAND_REJECTED')).status === 'FAILED', 'a Twilio refusal ends FAILED');
  const fb = await reg(b3.registrationId);
  check(fb.failure_code === 'BRAND_REJECTED' && fb.customer_profile_sid === sid('BU', 'b'), 'with the code and the objects it made');
  check((await admin.query("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id = $1 AND action_code = 'communication.a2p_registration.failed'", [b3.registrationId])).rows[0].n === 1, 'the failure is audited');
  const b4 = await request(input(), `key-${randomUUID()}`, ids.schoolB, ids.org2);
  check(b4.status === 'REQUESTED', 'after a failure the owner can submit again');
  await decide(b4.registrationId, 'APPROVE', 1);
  for (let i = 0; i < 6; i += 1) { await due(b4.registrationId); const [c] = await claim(); await record(c, i === 0 ? 'UNKNOWN' : 'RETRY', {}, 'PROVIDER_UNREACHABLE', 60); }
  await due(b4.registrationId);
  check((await claim()).length === 0, 'the seventh claim does not submit');
  const xb = await reg(b4.registrationId);
  check(xb.status === 'FAILED' && xb.failure_code === 'ATTEMPTS_EXHAUSTED' && xb.outcome_unknown === true, 'six tries without progress end ATTEMPTS_EXHAUSTED, still marked unknown');
  const b5 = await request(input(), `key-${randomUUID()}`, ids.schoolB, ids.org2);
  await decide(b5.registrationId, 'APPROVE', 1);
  [cb] = await claim();
  await record(cb, 'BRAND_PENDING', { customerProfileSid: sid('BU', 'c') }, null, 60);
  await admin.query("UPDATE hon.school_twilio_accounts SET status = 'CLOSED', version = version + 1 WHERE school_id = $1", [ids.schoolB]);
  await due(b5.registrationId);
  check((await claim()).length === 0, 'a school whose subaccount is not ACTIVE is not claimed');

  // 8. Guard: even the table owner cannot rewrite facts, SIDs or a finished registration.
  await expectError('42501', () => admin.query("UPDATE hon.school_a2p_registrations SET business = business || '{\"legalName\":\"X\"}', version = version + 1 WHERE id = $1", [b5.registrationId]), 'the business facts never change');
  await expectError('42501', () => admin.query("UPDATE hon.school_a2p_registrations SET draft_digest = repeat('c',64), version = version + 1 WHERE id = $1", [b5.registrationId]), 'the draft digest never changes');
  await expectError('42501', () => admin.query('UPDATE hon.school_a2p_registrations SET customer_profile_sid = $2, version = version + 1 WHERE id = $1', [b5.registrationId, sid('BU', 'd')]), 'a recorded SID never changes');
  await expectError('42501', () => admin.query("UPDATE hon.school_a2p_registrations SET status = 'APPROVED', version = version + 1 WHERE id = $1", [b3.registrationId]), 'a failed registration never reopens');
  await expectError('42501', () => admin.query("UPDATE hon.school_a2p_registrations SET status = 'SUBMIT_APPROVED', version = version + 1 WHERE id = $1", [first.registrationId]), 'an approved registration never changes');
  await expectError('23514', () => admin.query("UPDATE hon.school_a2p_registrations SET status = 'APPROVED', version = version + 1 WHERE id = $1", [b5.registrationId]), 'an APPROVED status needs every SID (CHECK)');
  await expectError('42501', () => admin.query('UPDATE hon.school_a2p_registrations SET decision_note = $2, version = version + 1 WHERE id = $1', [b5.registrationId, 'rewritten']), 'an HQ decision is never rewritten');
  await expectError('42501', () => admin.query('DELETE FROM hon.school_a2p_registrations WHERE id = $1', [b1.registrationId]), 'a registration is never deleted');
  await expectError('42501', () => admin.query('TRUNCATE hon.school_a2p_registrations'), 'registrations are never truncated');

  // 9. The deployment verifier's 0379 section (infra/postgres/011) passes here with this database's roles.
  {
    const verify = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
    const start = verify.indexOf('-- School A2P registrations exact verification');
    const section = verify.slice(start, verify.indexOf('-- End school A2P registrations exact verification', start));
    const role = (await runtime.query('SELECT current_user AS r')).rows[0].r;
    check(start >= 0 && section.includes('DO $$'), 'the 011 section exists');
    await admin.query(section.replaceAll('hon_runtime', role));
    passed += 1;
  }

  console.log(`PASS: school A2P registrations (${passed} checks).`);
} finally {
  await cleanup();
  await Promise.all([admin.end(), runtime.end(), worker.end()]);
}
