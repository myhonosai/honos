// HQ-COMM PR A (0281) HQ texting and email to school owners, TEST MODE, disposable database only (the 0243 communication
// delivery fixture). It proves: only the HQ owner sets or retires the HQ sender, and an SMS sender needs a Messaging Service
// SID with MMS Converter confirmed; drafting, queueing and cancelling need the HQ permission of the message purpose; texts
// over 1,600 characters are refused; recipients are the school's current non-HQ owners, resolved at queue time and again
// at claim time; HQ reads never contain an address; the worker claims HQ deliveries only through its own functions, holds
// them while no sender is active, suppresses opted-out, removed or address-less recipients and cancelled messages, records
// results with lease semantics (expired or late = UNKNOWN, never retried) and applies receipts idempotently and forward
// only, with unsubscribe recording an HQ opt-out; the runtime has no table access and the school and HQ paths never mix.
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { Client } = pg;
for (const key of ['DATABASE_URL', 'HON_RUNTIME_DATABASE_URL', 'HON_COMMUNICATION_WORKER_DATABASE_URL']) {
  if (!process.env[key]) throw new Error(`${key} is required for HQ communication tests.`);
}
if (Object.keys(process.env).some((key) => /^(?:OPENAI|ANTHROPIC|OPENROUTER|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS)(?:_|$)/i.test(key))) {
  throw new Error('Provider credentials are forbidden.');
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
const ok = (condition, message) => { assert.ok(condition, message); passed += 1; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); passed += 1; };
async function refuse(code, work, message, text) {
  try { await work(); } catch (error) {
    assert.equal(error?.code, code, `${message}: ${error?.message}`);
    if (text) assert.equal(error.message, text, message);
    passed += 1; return;
  }
  throw new Error(`FAIL: ${message} (no error)`);
}
const K = () => randomUUID();
const ORG = randomUUID(), ORG2 = randomUUID(), S = randomUUID(), S2 = randomUUID(), S3 = randomUUID(), ROLE = randomUUID(), ROLE2 = randomUUID();
const humans = Object.fromEntries(['hqOwner', 'exOwner', 'supportOp', 'billingOp', 'onboardOp', 'dashOnly', 'owner1', 'owner2', 'revokedOwner', 'hqSeat', 'staff', 'otherOwner']
  .map((k) => [k, { id: randomUUID(), user: randomUUID(), subject: `hqcomm-${k}-${randomUUID()}`, email: `${k}-${randomUUID().slice(0, 8)}@example.test` }]));
const H = (k) => humans[k].subject, P = (k) => humans[k].id;
const SUPPORT_CASE = randomUUID();

const one = async (client, sql, params) => (await client.query(sql, params)).rows[0];
const call = async (fn, args, types) => (await one(runtime, `SELECT hon.${fn}(${args.map((_, i) => `$${i + 1}${types?.[i] ?? ''}`).join(',')}) AS d`, args)).d;
const setSender = (who, input, key = K()) => call('set_hq_communication_sender', [H(who), JSON.stringify(input), key], ['', '::jsonb', '::uuid']);
const retireSender = (who, id, key = K()) => call('retire_hq_communication_sender', [H(who), id, key], ['', '::uuid', '::uuid']);
const create = (who, input, key = K()) => call('create_hq_message', [H(who), JSON.stringify(input), key], ['', '::jsonb', '::uuid']);
const queue = (who, id, version, key = K()) => call('queue_hq_message', [H(who), id, JSON.stringify({ expectedVersion: version }), key], ['', '::uuid', '::jsonb', '::uuid']);
const cancel = (who, id, version, key = K()) => call('cancel_hq_message', [H(who), id, JSON.stringify({ expectedVersion: version }), key], ['', '::uuid', '::jsonb', '::uuid']);
const list = (who, school = null, limit = 50) => call('read_hq_communications', [H(who), school, null, null, limit], ['', '::uuid', '::timestamptz', '::uuid', '::integer']);
const read = (who, id) => call('read_hq_message', [H(who), id], ['', '::uuid']);
const claim = async (channels = ['EMAIL', 'SMS'], limit = 100, lease = 60) =>
  (await worker.query('SELECT * FROM hon.claim_hq_message_deliveries($1::text[],$2,$3)', [channels, limit, lease])).rows.filter((r) => [ORG, ORG2].includes(r.organization_id));
const record = async (row, outcome, extra = {}) => one(worker, 'SELECT * FROM hon.record_hq_message_send_result($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
  [row.delivery_id, row.lease_token, outcome, extra.provider ?? 'FAKE', extra.providerMessageId ?? null, extra.sentAs ?? null,
    extra.segments ?? null, extra.encoding ?? null, extra.failureCode ?? null, extra.retryAfter ?? null]);
const receipt = async (eventId, providerMessageId, type, extra = {}) => one(worker, 'SELECT * FROM hon.record_hq_message_provider_event($1,$2,$3,$4,$5,$6,$7)',
  [extra.provider ?? 'FAKE', eventId, providerMessageId, extra.honDeliveryId ?? null, type, extra.occurredAt ?? new Date().toISOString(), extra.cost ?? null]);
const deliveries = async (messageId) => (await admin.query('SELECT * FROM hon.hq_message_deliveries WHERE message_id=$1 ORDER BY recipient_principal_id', [messageId])).rows;
const msgInput = (patch = {}) => ({ organizationId: ORG, schoolId: S, purpose: 'SUPPORT', channel: 'EMAIL', content: 'Your sign-in link was reset.', supportCaseId: null, ...patch });

const tables = ['hq_message_delivery_events', 'hq_message_deliveries', 'hq_messages', 'hq_communication_requests', 'hq_communication_senders', 'hq_contact_preferences'];
async function cleanup() {
  await admin.query('ROLLBACK').catch(() => {});
  await admin.query('BEGIN');
  try {
    for (const t of tables) await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
    for (const t of tables) await admin.query(`DELETE FROM hon.${t}`);
    for (const t of tables) await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
    await admin.query('ALTER TABLE hon.hq_support_case_events DISABLE TRIGGER USER; ALTER TABLE hon.hq_support_cases DISABLE TRIGGER USER');
    await admin.query('DELETE FROM hon.hq_support_case_events WHERE case_id=$1', [SUPPORT_CASE]);
    await admin.query('DELETE FROM hon.hq_support_cases WHERE id=$1', [SUPPORT_CASE]);
    await admin.query('ALTER TABLE hon.hq_support_case_events ENABLE TRIGGER USER; ALTER TABLE hon.hq_support_cases ENABLE TRIGGER USER');
    await admin.query('DELETE FROM hon.audit_events WHERE organization_id=ANY($1::uuid[])', [[ORG, ORG2]]);
    for (const t of ['principal_role_grants', 'role_permissions', 'roles', 'schools']) await admin.query(`DELETE FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`, [[ORG, ORG2]]);
    await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])', [[ORG, ORG2]]);
    const ps = Object.values(humans).map((h) => h.id), us = Object.values(humans).map((h) => h.user);
    await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=ANY($1::uuid[])', [ps]);
    await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])', [ps]);
    await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])', [us]);
    await admin.query('COMMIT');
  } catch (error) { await admin.query('ROLLBACK'); throw error; }
}

await Promise.all([admin.connect(), runtime.connect(), worker.connect()]);
try {
  // ---------- 0. posture ----------
  const entry = ['set_hq_communication_sender(text,jsonb,uuid)', 'retire_hq_communication_sender(text,uuid,uuid)', 'create_hq_message(text,jsonb,uuid)',
    'queue_hq_message(text,uuid,jsonb,uuid)', 'cancel_hq_message(text,uuid,jsonb,uuid)', 'read_hq_communications(text,uuid,timestamptz,uuid,integer)', 'read_hq_message(text,uuid)'];
  const workerFns = ['claim_hq_message_deliveries(text[],integer,integer)', 'reconcile_expired_hq_message_leases(integer)',
    'record_hq_message_send_result(uuid,uuid,text,text,text,text,integer,text,text,integer)', 'record_hq_message_provider_event(text,text,text,uuid,text,timestamptz,bigint)'];
  const has = async (client, sig) => (await one(client, "SELECT has_function_privilege(current_user,$1,'EXECUTE') a", ['hon.' + sig])).a;
  for (const sig of entry) { eq(await has(runtime, sig), true, `runtime runs ${sig}`); eq(await has(worker, sig), false, `worker cannot run ${sig}`); }
  for (const sig of workerFns) { eq(await has(worker, sig), true, `worker runs ${sig}`); eq(await has(runtime, sig), false, `runtime cannot run ${sig}`); }
  for (const sig of ['require_hq_communication_actor(text,text)', 'hq_communication_claim(uuid,uuid,text,text)', 'hq_message_owner_recipients(uuid)', 'hq_contact_sms_address(uuid)'])
    eq(await has(runtime, sig), false, `runtime cannot run helper ${sig}`);
  eq(await has(worker, 'claim_communication_deliveries(text[],integer,integer)'), true, 'worker keeps its school claim');
  for (const t of tables) {
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      eq((await one(runtime, 'SELECT has_table_privilege(current_user,$1,$2) a', ['hon.' + t, priv])).a, false, `runtime ${t} ${priv}`);
      eq((await one(worker, 'SELECT has_table_privilege(current_user,$1,$2) a', ['hon.' + t, priv])).a, false, `worker ${t} ${priv}`);
    }
    eq(await one(admin, 'SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE oid=$1::regclass', ['hon.' + t]), { r: true, f: true }, `${t} forced RLS`);
  }
  await cleanup();

  // ---------- fixture ----------
  await admin.query('BEGIN');
  for (const h of Object.values(humans)) {
    await admin.query('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)', [h.user, h.subject, h.email, 'Fixture person']);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','Fixture person',true)", [h.id, h.user]);
  }
  for (const [who, role, perms, until] of [['hqOwner', 'HON_HQ_OWNER', [], null], ['exOwner', 'HON_HQ_OWNER', [], '1 minute'],
    ['supportOp', 'HON_HQ_SUPPORT', ['hq.support.manage'], null], ['billingOp', 'HON_HQ_OPERATOR', ['hq.billing.manage'], null],
    ['onboardOp', 'HON_HQ_OPERATOR', ['hq.onboarding.manage'], null], ['dashOnly', 'HON_HQ_OPERATOR', ['hq.dashboard.view'], null],
    ['hqSeat', 'HON_HQ_OPERATOR', ['hq.dashboard.view'], null]]) {
    await admin.query(`INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from,effective_until)
      VALUES($1,$2,$3,clock_timestamp()-interval '1 hour',${until ? `clock_timestamp()-interval '${until}'` : 'NULL'})`, [P(who), role, perms]);
  }
  for (const [o, s, name, zone] of [[ORG, S, 'HQC Fixture Dojo', 'America/Los_Angeles'], [ORG2, S2, 'HQC Other Dojo', 'UTC']]) {
    await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name,status,created_at) VALUES($1,$2,$2,'ACTIVE',clock_timestamp())", [o, name]);
    await admin.query('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,$3,$1::text,$4)', [s, o, name + ' Main', zone]);
  }
  await admin.query('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,$3,$1::text,$4)', [S3, ORG, 'HQC Fixture Dojo Annex', 'UTC']);
  for (const [r, o] of [[ROLE, ORG], [ROLE2, ORG2]]) {
    await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','School Owner',true)", [r, o]);
  }
  const STAFF_ROLE = randomUUID();
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'STAFF_FIXTURE','Staff',false)", [STAFF_ROLE, ORG]);
  const grant = (o, s, who, role, extra = '') => admin.query(`INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from${extra ? ',revoked_at,revoked_by_principal_id' : ''})
    VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour'${extra ? ',clock_timestamp(),$3' : ''})`, [o, s, P(who), role]);
  await grant(ORG, S, 'owner1', ROLE); await grant(ORG, S, 'owner2', ROLE); await grant(ORG, S, 'revokedOwner', ROLE, 'revoked');
  await grant(ORG, S, 'hqSeat', ROLE); await grant(ORG, S, 'staff', STAFF_ROLE); await grant(ORG2, S2, 'otherOwner', ROLE2);
  await admin.query(`INSERT INTO hon.hq_support_cases(id,organization_id,school_id,subject,category,priority,status,opened_by,opened_at,updated_at)
    VALUES($1,$2,$3,'Owner cannot sign in','ACCOUNT_ACCESS','HIGH','OPEN',$4,clock_timestamp(),clock_timestamp())`, [SUPPORT_CASE, ORG, S, P('supportOp')]);
  await admin.query('COMMIT');

  // ---------- 1. sender ----------
  const emailSender = { channel: 'EMAIL', emailFrom: 'hello@hon.example', emailDisplayName: 'HON OS', smsServiceSid: null, a2pState: null, mmsConverterConfirmed: null };
  const smsSender = { channel: 'SMS', emailFrom: null, emailDisplayName: null, smsServiceSid: 'MG' + '0123456789abcdef'.repeat(2), a2pState: 'PENDING', mmsConverterConfirmed: true };
  for (const who of ['supportOp', 'billingOp', 'exOwner', 'owner1', 'dashOnly']) await refuse('42501', () => setSender(who, emailSender), `${who} cannot set the sender`);
  await refuse('22023', () => setSender('hqOwner', { ...smsSender, mmsConverterConfirmed: false }), 'SMS sender needs MMS Converter confirmed');
  await refuse('22023', () => setSender('hqOwner', { ...smsSender, smsServiceSid: '+15555550100' }), 'SMS sender needs a Messaging Service SID, not a phone number');
  await refuse('22023', () => setSender('hqOwner', { ...emailSender, emailFrom: 'not-an-email' }), 'email sender needs an address');
  await refuse('22023', () => setSender('hqOwner', { ...emailSender, smsServiceSid: smsSender.smsServiceSid }), 'email sender carries no SID');
  const senderKey = K();
  const setEmail = await setSender('hqOwner', emailSender, senderKey);
  eq(setEmail.sender.channel, 'EMAIL', 'HQ owner sets the email sender');
  eq((await setSender('hqOwner', emailSender, senderKey)).replayed, true, 'sender set replays by key');
  await refuse('23514', () => setSender('hqOwner', emailSender), 'one active sender per channel', 'HQ_SENDER_EXISTS');
  await refuse('23505', () => setSender('hqOwner', smsSender, senderKey), 'key reuse with other content refused');

  // ---------- 2. drafting and purpose authority ----------
  for (const who of ['owner1', 'dashOnly', 'exOwner', 'staff']) await refuse('42501', () => create(who, msgInput()), `${who} cannot draft`);
  await refuse('42501', () => create('billingOp', msgInput({ purpose: 'SUPPORT' })), 'billing operator cannot draft SUPPORT');
  await refuse('42501', () => create('supportOp', msgInput({ purpose: 'BILLING' })), 'support person cannot draft BILLING');
  await refuse('42501', () => create('onboardOp', msgInput({ purpose: 'ACCOUNT' })), 'onboarding operator cannot draft ACCOUNT');
  await refuse('22023', () => create('supportOp', msgInput({ channel: 'SMS', content: 'x'.repeat(1601) })), 'SMS over 1,600 characters refused');
  await refuse('22023', () => create('supportOp', msgInput({ content: 'x'.repeat(4001) })), 'email over 4,000 characters refused');
  await refuse('22023', () => create('supportOp', msgInput({ content: '  padded  ' })), 'content must be trimmed');
  await refuse('22023', () => create('supportOp', { ...msgInput(), extra: 1 }), 'unknown keys refused');
  await refuse('P0002', () => create('supportOp', msgInput({ schoolId: S2 })), 'school must belong to the organization');
  await refuse('P0002', () => create('supportOp', msgInput({ schoolId: S3, supportCaseId: SUPPORT_CASE })), 'support case must be about the same school');
  const longText = 'Hola, su cuenta está lista. '.repeat(57).trim();
  ok(longText.length > 1500 && longText.length <= 1600, 'long accented text fixture fits 1,600');
  const smsDraft = await create('supportOp', msgInput({ channel: 'SMS', content: longText, supportCaseId: SUPPORT_CASE }));
  eq([smsDraft.message.status, smsDraft.message.channel, smsDraft.message.supportCaseId], ['DRAFT', 'SMS', SUPPORT_CASE], 'long text accepted whole, linked to the case');
  eq((await one(admin, 'SELECT content FROM hon.hq_messages WHERE id=$1', [smsDraft.message.messageId])).content, longText, 'nothing is cut short');
  const billKey = K();
  const billing = await create('billingOp', msgInput({ purpose: 'BILLING', content: 'Your invoice is ready.' }), billKey);
  eq((await create('billingOp', msgInput({ purpose: 'BILLING', content: 'Your invoice is ready.' }), billKey)).replayed, true, 'create replays by key');
  const ownerMade = await create('hqOwner', msgInput({ purpose: 'ONBOARDING', content: 'Welcome to HON OS.' }));
  eq(ownerMade.message.purpose, 'ONBOARDING', 'HQ owner drafts any purpose');

  // ---------- 3. queueing ----------
  await refuse('42501', () => queue('supportOp', billing.message.messageId, 1), 'support person cannot queue a BILLING message');
  await refuse('40001', () => queue('billingOp', billing.message.messageId, 2), 'stale version refused');
  const queued = await queue('billingOp', billing.message.messageId, 1);
  eq([queued.message.status, queued.message.recipientCount], ['QUEUED', 2], 'queue creates one delivery per current non-HQ owner');
  const rows = await deliveries(billing.message.messageId);
  eq(rows.map((r) => r.recipient_principal_id).sort(), [P('owner1'), P('owner2')].sort(), 'revoked owner, HQ seat and staff are not recipients');
  eq(rows.every((r) => r.status === 'PENDING'), true, 'deliveries start PENDING');
  await refuse('23514', () => queue('billingOp', billing.message.messageId, 2), 'already queued', 'HQ_MESSAGE_NOT_DRAFT');
  const noOwners = await create('hqOwner', msgInput({ schoolId: S3, purpose: 'ACCOUNT', content: 'Annex note.' }));
  await refuse('23514', () => queue('hqOwner', noOwners.message.messageId, 1), 'a school without owners is refused', 'HQ_MESSAGE_NO_RECIPIENTS');

  // ---------- 4. reads never show addresses ----------
  const listing = await list('supportOp');
  eq(listing.messages.every((m) => m.purpose === 'SUPPORT' || m.purpose === 'ACCOUNT'), true, 'support sees only SUPPORT and ACCOUNT messages');
  const ownerListing = await list('hqOwner');
  eq(ownerListing.messages.length, 4, 'HQ owner sees every message');
  eq(ownerListing.senders.EMAIL?.ready === undefined, true, 'sender readiness is not claimed by the database');
  const detail = await read('billingOp', billing.message.messageId);
  eq(detail.deliveries.length, 2, 'detail lists each recipient delivery');
  const wire = JSON.stringify([listing, ownerListing, detail]);
  for (const h of Object.values(humans)) ok(!wire.includes(h.email), 'no address in any HQ read');
  await refuse('42501', () => read('supportOp', billing.message.messageId), 'support cannot read a BILLING message');
  await refuse('42501', () => list('owner1'), 'school owner cannot read HQ messages');

  // ---------- 5. claim ----------
  await admin.query("UPDATE hon.hq_communication_senders SET status='RETIRED', retired_by=$1, retired_at=clock_timestamp(), version=version+1 WHERE channel='EMAIL'", [P('hqOwner')]);
  let claimed = await claim(['EMAIL']);
  eq(claimed.length, 0, 'nothing is leased while no email sender is active');
  eq((await deliveries(billing.message.messageId)).map((r) => r.hold_reason), ['NO_SENDER', 'NO_SENDER'], 'held with NO_SENDER');
  const reset = await setSender('hqOwner', emailSender);
  ok(reset.sender.senderId !== setEmail.sender.senderId, 'a new sender row after retirement');
  await admin.query("UPDATE hon.hq_message_deliveries SET next_attempt_at=now() WHERE message_id=$1", [billing.message.messageId]);
  // owner2 opts out of HQ email; owner1 receives.
  await admin.query("INSERT INTO hon.hq_contact_preferences(user_id,channel,status,source,captured_at) VALUES($1,'EMAIL','OPTED_OUT','RECIPIENT',clock_timestamp())", [humans.owner2.user]);
  claimed = await claim(['EMAIL']);
  eq(claimed.length, 1, 'one delivery leased');
  eq([claimed[0].recipient_address, claimed[0].sender_ref, claimed[0].sender_name, claimed[0].content],
    [humans.owner1.email, 'hello@hon.example', 'HON OS', 'Your invoice is ready.'], 'claim returns the owner address and the HQ sender, in memory only');
  const after = await deliveries(billing.message.messageId);
  eq(after.find((r) => r.recipient_principal_id === P('owner2')).status, 'SUPPRESSED', 'opted-out owner is suppressed');
  eq(after.find((r) => r.recipient_principal_id === P('owner2')).failure_code, 'CONSENT_MISSING', 'with CONSENT_MISSING');
  eq((await claim(['EMAIL'])).length, 0, 'a leased delivery is not leased twice');

  // ---------- 6. results and receipts ----------
  const lease = claimed[0];
  await refuse('22023', () => record(lease, 'ACCEPTED'), 'accepted needs provider id and sent-as');
  eq(await record({ ...lease, lease_token: randomUUID() }, 'ACCEPTED', { providerMessageId: 'fake-x', sentAs: 'EMAIL' }), { status: 'SENDING', accepted: false }, 'wrong lease refused');
  eq(await record(lease, 'ACCEPTED', { providerMessageId: 'fake-hq-1', sentAs: 'EMAIL' }), { status: 'ACCEPTED', accepted: true }, 'accepted recorded');
  eq(await record(lease, 'FAILED', { failureCode: 'PROVIDER_FAILED' }), { status: 'ACCEPTED', accepted: false }, 'late second result refused');
  eq(await receipt('ev-1', 'fake-hq-1', 'DELIVERED'), { outcome: 'RECORDED', delivery_status: 'DELIVERED' }, 'delivered receipt');
  eq(await receipt('ev-1', 'fake-hq-1', 'DELIVERED'), { outcome: 'REPLAYED', delivery_status: 'DELIVERED' }, 'receipt replay');
  eq(await receipt('ev-2', 'fake-hq-1', 'SENT'), { outcome: 'RECORDED', delivery_status: 'DELIVERED' }, 'status never moves backward');
  eq(await receipt('ev-3', 'unknown-id', 'DELIVERED'), { outcome: 'UNMATCHED', delivery_status: null }, 'unknown provider message unmatched');
  eq(await receipt('ev-4', 'fake-hq-1', 'UNSUBSCRIBED'), { outcome: 'RECORDED', delivery_status: 'DELIVERED' }, 'unsubscribe recorded');
  eq((await one(admin, "SELECT status, source FROM hon.hq_contact_preferences WHERE user_id=$1 AND channel='EMAIL'", [humans.owner1.user])),
    { status: 'OPTED_OUT', source: 'RECIPIENT' }, 'unsubscribe records an HQ email opt-out');
  // HQ receipts never touch school deliveries and the school receipt function never matches HQ provider ids.
  eq((await one(worker, 'SELECT * FROM hon.record_communication_provider_event($1,$2,$3,$4,$5,$6,$7)',
    ['FAKE', 'ev-school-1', 'fake-hq-1', null, 'DELIVERED', new Date().toISOString(), null])).outcome, 'UNMATCHED', 'school receipt path never matches HQ sends');

  // ---------- 7. SMS without a confirmed phone, removal, cancel ----------
  await setSender('hqOwner', smsSender);
  const smsQueued = await queue('supportOp', smsDraft.message.messageId, 1);
  eq(smsQueued.message.recipientCount, 2, 'SMS queued to both owners');
  claimed = await claim(['SMS']);
  eq(claimed.length, 0, 'no SMS leased without the owner\'s own HQ texting opt-in');
  eq((await deliveries(smsDraft.message.messageId)).map((r) => r.failure_code), ['CONSENT_MISSING', 'CONSENT_MISSING'], 'SUPPRESSED with CONSENT_MISSING');
  // Opted in to texts but no confirmed phone yet (0282 supplies it): still never sent.
  await admin.query("INSERT INTO hon.hq_contact_preferences (user_id, channel, status, source, captured_at) VALUES ($1,'SMS','OPTED_IN','USER',clock_timestamp())", [humans.owner1.user]);
  const smsTwo = await create('supportOp', msgInput({ channel: 'SMS', content: 'Short HQ text.' }));
  await queue('supportOp', smsTwo.message.messageId, 1);
  claimed = await claim(['SMS']);
  eq(claimed.length, 0, 'no SMS leased without a confirmed phone (0282)');
  const smsTwoRows = await deliveries(smsTwo.message.messageId);
  eq(smsTwoRows.find((r) => r.recipient_principal_id === P('owner1')).failure_code, 'ADDRESS_MISSING', 'opted-in owner without a phone: ADDRESS_MISSING');
  eq(smsTwoRows.find((r) => r.recipient_principal_id === P('owner2')).failure_code, 'CONSENT_MISSING', 'owner who never opted in: CONSENT_MISSING');

  const onboarding = await queue('hqOwner', ownerMade.message.messageId, 1);
  eq(onboarding.message.recipientCount, 2, 'onboarding message queued');
  await admin.query('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(), revoked_by_principal_id=$1 WHERE principal_id=$1 AND school_id=$2', [P('owner2'), S]);
  await admin.query("UPDATE hon.hq_contact_preferences SET status='OPTED_IN', source='USER', version=version+1 WHERE user_id=ANY($1::uuid[])", [[humans.owner1.user, humans.owner2.user]]);
  claimed = await claim(['EMAIL']);
  eq(claimed.map((r) => r.recipient_address), [humans.owner1.email], 'only the still-current owner is leased');
  eq((await deliveries(ownerMade.message.messageId)).find((r) => r.recipient_principal_id === P('owner2')).failure_code, 'RECIPIENT_REMOVED', 'removed owner suppressed');
  await refuse('23514', () => cancel('hqOwner', ownerMade.message.messageId, 2), 'cannot cancel once a delivery left PENDING', 'HQ_MESSAGE_NOT_CANCELLABLE');

  await admin.query('UPDATE hon.principal_role_grants SET revoked_at=NULL, revoked_by_principal_id=NULL WHERE principal_id=$1 AND school_id=$2', [P('owner2'), S]);
  const toCancel = await create('supportOp', msgInput({ content: 'Never mind.' }));
  await queue('supportOp', toCancel.message.messageId, 1);
  await refuse('42501', () => cancel('billingOp', toCancel.message.messageId, 2), 'billing cannot cancel a SUPPORT message');
  const cancelled = await cancel('supportOp', toCancel.message.messageId, 2);
  eq(cancelled.message.status, 'CANCELLED', 'queued message cancelled');
  eq((await deliveries(toCancel.message.messageId)).map((r) => [r.status, r.failure_code]), [['SUPPRESSED', 'CANCELLED'], ['SUPPRESSED', 'CANCELLED']], 'its deliveries are suppressed');
  eq((await claim(['EMAIL'])).length, 0, 'cancelled deliveries are never leased');

  // A cancel racing a claim in flight waits for it and then refuses; it never reports CANCELLED over a send.
  const race = await create('supportOp', msgInput({ content: 'Race me.' }));
  await queue('supportOp', race.message.messageId, 1);
  await worker.query('BEGIN');
  const raced = await claim(['EMAIL']);
  eq(raced.length, 2, 'claim in flight holds both deliveries');
  let raceSettled = false;
  const raceCancel = cancel('supportOp', race.message.messageId, 2).then((v) => ({ ok: v }), (e) => ({ err: e })).finally(() => { raceSettled = true; });
  await new Promise((r) => setTimeout(r, 300));
  eq(raceSettled, false, 'cancel waits for the claim in flight');
  await worker.query('COMMIT');
  const raceOutcome = await raceCancel;
  eq([raceOutcome.err?.code, raceOutcome.err?.message], ['23514', 'HQ_MESSAGE_NOT_CANCELLABLE'], 'cancel refuses once the claim committed SENDING');
  eq((await one(admin, 'SELECT status FROM hon.hq_messages WHERE id=$1', [race.message.messageId])).status, 'QUEUED', 'message stays QUEUED');
  for (const row of raced) await record(row, 'ACCEPTED', { providerMessageId: `fake-race-${row.delivery_id}`, sentAs: 'EMAIL' });

  // ---------- 8. lease expiry and retries ----------
  const lease2 = claimed[0];
  await admin.query("UPDATE hon.hq_message_deliveries SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [lease2.delivery_id]);
  eq(await record(lease2, 'ACCEPTED', { providerMessageId: 'fake-late', sentAs: 'EMAIL' }), { status: 'UNKNOWN', accepted: false }, 'expired lease becomes UNKNOWN');
  eq((await claim(['EMAIL'])).length, 0, 'UNKNOWN is never retried');
  const retry = await create('supportOp', msgInput({ content: 'Retry me.' }));
  await queue('supportOp', retry.message.messageId, 1);
  let r1 = await claim(['EMAIL']);
  eq(r1.length, 2, 'both owners leased');
  eq(await record(r1[0], 'RETRYABLE', { retryAfter: 30 }), { status: 'PENDING', accepted: true }, 'retryable waits');
  eq(await record(r1[1], 'FAILED', { failureCode: 'INVALID_ADDRESS' }), { status: 'FAILED', accepted: true }, 'permanent failure');
  await admin.query("UPDATE hon.hq_message_deliveries SET attempt_count=5, next_attempt_at=now() WHERE id=$1", [r1[0].delivery_id]);
  // attempt 5 is the last; one more claim leases attempt 6? No: claim refuses past 5 attempts.
  eq((await claim(['EMAIL'])).length, 0, 'no lease after 5 attempts');
  eq((await one(admin, 'SELECT status, failure_code FROM hon.hq_message_deliveries WHERE id=$1', [r1[0].delivery_id])), { status: 'FAILED', failure_code: 'RETRIES_EXHAUSTED' }, 'exhausted');

  // ---------- 9. evidence and immutability ----------
  ok(Number((await one(admin, "SELECT count(*) n FROM hon.audit_events WHERE organization_id=$1 AND entity_type='HQ_MESSAGE_DELIVERY'", [ORG])).n) >= 8, 'delivery transitions audited');
  await refuse('42501', () => admin.query('DELETE FROM hon.hq_message_delivery_events'), 'receipts are append-only');
  await refuse('42501', () => admin.query("UPDATE hon.hq_messages SET content='changed' WHERE id=$1", [billing.message.messageId]), 'message content immutable');
  await refuse('42501', () => admin.query('DELETE FROM hon.hq_communication_senders'), 'sender history kept');
  await refuse('42501', () => admin.query('DELETE FROM hon.hq_contact_preferences'), 'preferences are never deleted');

  // ---------- 10. a revoked reader gets nothing ----------
  await admin.query("UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp() WHERE principal_id=$1", [P('supportOp')]);
  await refuse('42501', () => list('supportOp'), 'support person whose grant ended is refused');

  console.log(`PASS: HQ communications (0281) integrity (${passed} checks).`);
} finally {
  await cleanup().catch((error) => console.error('cleanup failed', error.message));
  await Promise.all([admin.end(), runtime.end(), worker.end()]);
}
