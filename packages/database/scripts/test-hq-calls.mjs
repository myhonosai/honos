// HQ calling (CL5, 0591, docs/architecture/SCHOOL_CALLING.md §10) on the marked disposable communication delivery database
// (the 0243 fixture). It proves: forced RLS and no table privilege on the six HQ calling tables; the runtime runs only the
// HQ entry points and the worker only the provider entry points; HQ people with an HQ messaging purpose use calling, only
// the HQ owner switches it on; outgoing calls follow the school toll-fraud rules, the HQ number, the HQ do-not-call list,
// 60 an hour and exact key replay; the worker connects a browser call only for its starter, within two minutes, once;
// incoming calls ring Ring me HQ people, the first answer wins, voicemail is kept and opened as evidence and deleted after
// 90 days; status never moves back; calls are never changed outside the entry points. Nothing reaches Twilio.
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const { Client } = pg;
for (const key of ['DATABASE_URL', 'HON_RUNTIME_DATABASE_URL', 'HON_COMMUNICATION_WORKER_DATABASE_URL']) {
  if (!process.env[key]) throw new Error(`${key} is required for HQ calling tests.`);
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

let groups = 0;
const pass = (name) => console.log('PASS HQ CALLS ' + (++groups) + ' ' + name);
async function refuse(code, work, message, text) {
  try { await work(); } catch (error) {
    assert.equal(error?.code, code, `${message}: ${error?.message}`);
    if (text) assert.equal(error.message, text, message);
    return;
  }
  assert.fail(`${message}: expected ${code}`);
}
const K = () => randomUUID();
const hex = () => createHash('md5').update(K()).digest('hex');
const CA = () => 'CA' + hex(), RE = () => 'RE' + hex();
const sealed = () => 'v1.' + 'A'.repeat(16) + '.' + 'B'.repeat(40) + '.' + 'C'.repeat(22);
const ORG = randomUUID(), S = randomUUID(), ROLE = randomUUID();
const humans = Object.fromEntries(['hqOwner', 'supportOp', 'billingOp', 'noPurpose', 'owner1', 'other']
  .map((k) => [k, { id: randomUUID(), user: randomUUID(), subject: `hqcall-${k}-${randomUUID()}`, email: `${k}-${randomUUID().slice(0, 8)}@example.test` }]));
const H = (k) => humans[k].subject, P = (k) => humans[k].id, Uu = (k) => humans[k].user;
const ident = (k) => 'h' + P(k).replaceAll('-', '');
const HQ_NUMBER = '+15125550199', OWNER_PHONE = '+15125550101', STRANGER = '+15125550123';

const one = async (client, sql, params) => (await client.query(sql, params)).rows[0];
const call = async (fn, args, types) => (await one(runtime, `SELECT hon.${fn}(${args.map((_, i) => `$${i + 1}${types?.[i] ?? ''}`).join(',')}) AS d`, args)).d;
const j = (who, fn, p) => call(fn, [H(who), JSON.stringify(p)], ['', '::jsonb']);
const overview = (who) => call('read_hq_calling', [H(who)]);
const settings = (who, callingOn, expectedVersion, voicemailGreeting = null) => j(who, 'set_hq_calling_settings', { callingOn, voicemailGreeting, expectedVersion });
const start = (who, p, key = 'key-' + K()) => call('start_hq_call', [H(who), JSON.stringify(p), key], ['', '::jsonb', '']);
const w = async (sql, args = []) => (await worker.query(sql, args)).rows;
const connect = async (callId, identity, sid) => (await w('SELECT * FROM hon.connect_hq_client_call($1,$2,$3)', [callId, identity, sid]))[0];
const route = async (to, from, sid) => (await w('SELECT * FROM hon.route_hq_incoming_call($1,$2,$3)', [to, from, sid]))[0];
const status = async (sid, s, identity = null, seconds = null) => (await w('SELECT * FROM hon.record_hq_call_status($1,$2,$3,$4,$5)', [sid, s, identity, seconds, new Date().toISOString()]))[0];
const voicemail = async (sid, rec, seconds = 12) => (await w('SELECT * FROM hon.record_hq_call_voicemail($1,$2,$3)', [sid, rec, seconds]))[0];
const row = (id) => one(admin, 'SELECT * FROM hon.hq_calls WHERE id=$1', [id]);

const tables = ['hq_call_events', 'hq_calls', 'hq_do_not_call', 'hq_call_staff', 'hq_calling_settings', 'hq_voice_app',
  'hq_contact_phones', 'hq_communication_requests', 'hq_communication_senders'];
async function cleanup() {
  await admin.query('ROLLBACK').catch(() => {});
  await admin.query('BEGIN');
  try {
    for (const t of tables) await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
    for (const t of tables) await admin.query(`DELETE FROM hon.${t}`);
    for (const t of tables) await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
    for (const t of ['principal_role_grants', 'roles', 'schools']) await admin.query(`DELETE FROM hon.${t} WHERE organization_id=$1`, [ORG]);
    await admin.query('DELETE FROM hon.organizations WHERE id=$1', [ORG]);
    const ps = Object.values(humans).map((h) => h.id), us = Object.values(humans).map((h) => h.user);
    await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=ANY($1::uuid[])', [ps]);
    await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])', [ps]);
    await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])', [us]);
    await admin.query('COMMIT');
  } catch (error) { await admin.query('ROLLBACK'); throw error; }
}

await Promise.all([admin.connect(), runtime.connect(), worker.connect()]);
try {
  assert.equal((await one(admin, "SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).m,
    'HON disposable communication delivery validation');
  // ---------- 1. custody ----------
  for (const t of ['hq_calling_settings', 'hq_call_staff', 'hq_calls', 'hq_do_not_call', 'hq_voice_app', 'hq_call_events']) {
    assert.deepEqual(await one(admin, 'SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE oid=$1::regclass', ['hon.' + t]), { r: true, f: true }, t);
    for (const client of [runtime, worker]) for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
      assert.equal((await one(client, 'SELECT has_table_privilege(current_user,$1,$2) a', ['hon.' + t, priv])).a, false, `${t} ${priv}`);
  }
  const staffFns = ['read_hq_calling(text)', 'set_hq_calling_settings(text,jsonb)', 'set_my_hq_call_ringing(text,jsonb)', 'start_hq_call(text,jsonb,text)',
    'read_hq_calls(text,jsonb)', 'update_hq_call(text,jsonb)', 'set_hq_do_not_call(text,jsonb)', 'open_hq_call_recording(text,uuid)', 'authorize_hq_phone_token(text)'];
  const workerFns = ['hq_needs_voice_app()', 'begin_hq_voice_app(integer)', 'record_hq_voice_app_twiml(uuid,text)', 'complete_hq_voice_app(uuid,text,text,text)',
    'read_hq_voice_app()', 'connect_hq_client_call(uuid,text,text)', 'route_hq_incoming_call(text,text,text)',
    'record_hq_call_status(text,text,text,integer,timestamp with time zone)', 'record_hq_call_voicemail(text,text,integer)',
    'read_hq_call_recordings_due(integer)', 'mark_hq_call_recording_deleted(uuid,text)'];
  const privateFns = ['guard_hq_call()', 'guard_hq_calling_row()', 'guard_hq_voice_app()', 'guard_hq_call_evidence()', 'hq_call_identity(uuid)', 'hq_call_staff_ok(uuid)',
    'hq_call_number()', 'hq_call_contact(text)', 'expire_hq_calls()', 'hq_call_json(hon.hq_calls)', 'hq_call_evidence(uuid,uuid,text,text,jsonb)', 'hq_call_state(hon.hq_calls)'];
  const has = async (client, sig) => (await one(client, "SELECT has_function_privilege(current_user,$1,'EXECUTE') a", ['hon.' + sig])).a;
  for (const sig of [...staffFns, ...workerFns, ...privateFns]) {
    assert.equal(await has(runtime, sig), staffFns.includes(sig), 'runtime ' + sig);
    assert.equal(await has(worker, sig), workerFns.includes(sig), 'worker ' + sig);
    assert.equal((await one(admin, "SELECT has_function_privilege('public',$1,'EXECUTE') a", ['hon.' + sig])).a, false, 'PUBLIC ' + sig);
  }
  pass('forced RLS with no table privilege on six tables; runtime runs only the nine HQ entry points, the worker only the eleven provider entry points');

  await cleanup();
  await admin.query('BEGIN');
  for (const h of Object.values(humans)) {
    await admin.query('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)', [h.user, h.subject, h.email, 'Fixture person']);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','Fixture person',true)", [h.id, h.user]);
  }
  const grant = (who, role, perms) => admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')", [P(who), role, perms]);
  await grant('hqOwner', 'HON_HQ_OWNER', '{}'); await grant('supportOp', 'HON_HQ_SUPPORT', '{hq.support.manage}');
  await grant('billingOp', 'HON_HQ_OPERATOR', '{hq.billing.manage}'); await grant('noPurpose', 'HON_HQ_SUPPORT', '{}');
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name,status,created_at) VALUES($1,'HQC Fixture Dojo','HQC Fixture Dojo','ACTIVE',clock_timestamp())", [ORG]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'HQC Main',$1::text,'UTC')", [S, ORG]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','School Owner',true)", [ROLE, ORG]);
  await admin.query(`INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from)
    VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')`, [ORG, S, P('owner1'), ROLE]);
  await admin.query("INSERT INTO hon.hq_contact_phones(user_id,status,phone_e164,confirmed_at,created_at,updated_at) VALUES($1,'CONFIRMED',$2,clock_timestamp(),clock_timestamp(),clock_timestamp())", [Uu('owner1'), OWNER_PHONE]);
  await admin.query('COMMIT');

  // ---------- 2. who may use HQ calling ----------
  let o = await overview('supportOp');
  assert.deepEqual([o.callingOn, o.hqNumber, o.numberReady, o.ringMe, o.canManage, o.staff, o.version], [false, null, false, false, false, null, 0]);
  await overview('billingOp');
  for (const who of ['noPurpose', 'owner1', 'other']) await refuse('42501', () => overview(who), who + ' has no HQ calling');
  await refuse('42501', () => call('read_hq_calling', ['nobody-' + K()]), 'unknown subject');
  await refuse('42501', () => settings('supportOp', true, 0), 'support cannot switch calling on');
  await refuse('22023', () => j('hqOwner', 'set_hq_calling_settings', { callingOn: true, expectedVersion: 0 }), 'missing greeting key');
  await refuse('22023', () => settings('hqOwner', true, 0, '<b>hi</b>'), 'greeting markup refused');
  await refuse('42501', async () => {
    await runtime.query('BEGIN'); await runtime.query("SELECT set_config('app.hon_school_id',$1,true)", [S]);
    try { await overview('hqOwner'); } finally { await runtime.query('ROLLBACK'); }
  }, 'a school-scoped session never reaches HQ calling');
  o = await overview('hqOwner');
  assert.equal(o.canManage, true);
  // The shared fixture may hold HQ grants from earlier proofs; judge only this proof's people.
  const mine = new Set(Object.keys(humans).map(P));
  assert.deepEqual(o.staff.map((s) => s.principalId).filter((id) => mine.has(id)).sort(), [P('billingOp'), P('hqOwner'), P('supportOp')].sort(), 'staff list: HQ people with a purpose only');
  pass('HQ owner, support and billing operators use HQ calling; no-purpose HQ grants, school owners and school sessions are refused; only the HQ owner manages');

  // ---------- 3. starting calls ----------
  await refuse('55000', () => start('supportOp', { toE164: STRANGER }), 'calling off', 'CALLING_OFF');
  let s = await settings('hqOwner', true, 0, 'You reached HON HQ. Leave a message.');
  assert.deepEqual(s, { callingOn: true, voicemailGreeting: 'You reached HON HQ. Leave a message.', version: 1 });
  await refuse('40001', () => settings('hqOwner', true, 0), 'stale version', 'CALLING_VERSION_CONFLICT');
  await refuse('55000', () => start('supportOp', { toE164: STRANGER }), 'no HQ number', 'CALL_NUMBER_NOT_READY');
  await call('set_hq_communication_sender', [H('hqOwner'), JSON.stringify({ channel: 'SMS', emailFrom: null, emailDisplayName: null, smsServiceSid: 'MG' + hex(),
    smsReplyNumber: HQ_NUMBER, a2pState: 'REGISTERED_SERVICE', mmsConverterConfirmed: true }), K()], ['', '::jsonb', '::uuid']);
  for (const bad of ['+19005550100', '+15129765555', '+14415550100', '+442071234567', '+15125110100', '5125550100'])
    await refuse('22023', () => start('supportOp', { toE164: bad }), 'toll-fraud rule ' + bad, 'CALL_NUMBER_NOT_ALLOWED');
  await refuse('22023', () => start('supportOp', { toE164: HQ_NUMBER }), 'HQ number itself', 'CALL_NUMBER_NOT_ALLOWED');
  await refuse('22023', () => start('supportOp', { toE164: STRANGER, schoolId: S }), 'unknown key');
  await refuse('22023', () => start('supportOp', { toE164: STRANGER }, 'short'), 'bad idempotency key');
  const key = 'key-' + K();
  const first = await start('supportOp', { toE164: OWNER_PHONE }, key);
  assert.equal(first.status, 'INITIATED'); assert.equal(first.contactUserId, Uu('owner1')); assert.deepEqual(first.contactSchools, ['HQC Main']);
  assert.equal(first.replayed, false); assert.equal(first.direction, 'OUT');
  const replay = await start('supportOp', { toE164: OWNER_PHONE }, key);
  assert.equal(replay.callId, first.callId); assert.equal(replay.replayed, true);
  await refuse('23505', () => start('supportOp', { toE164: STRANGER }, key), 'key reused for another number', 'IDEMPOTENCY_KEY_REUSED');
  const other = await start('billingOp', { toE164: OWNER_PHONE }, key);
  assert.notEqual(other.callId, first.callId, 'keys are per HQ person');
  await refuse('22023', () => start('supportOp', { toE164: STRANGER, contactUserId: Uu('owner1') }), 'contact phone mismatch', 'CALL_PERSON_PHONE_MISMATCH');
  await refuse('P0002', () => start('supportOp', { toE164: STRANGER, contactUserId: K() }), 'unknown contact', 'CALL_PERSON_NOT_FOUND');
  assert.equal((await start('supportOp', { toE164: OWNER_PHONE, contactUserId: Uu('owner1') })).contactUserId, Uu('owner1'));
  assert.deepEqual(await j('supportOp', 'set_hq_do_not_call', { phoneE164: STRANGER, doNotCall: true }), { phoneE164: STRANGER, doNotCall: true });
  await refuse('22023', () => start('supportOp', { toE164: STRANGER }), 'do not call', 'CALL_DO_NOT_CALL');
  await j('supportOp', 'set_hq_do_not_call', { phoneE164: STRANGER, doNotCall: false });
  await start('supportOp', { toE164: STRANGER });
  await admin.query('ALTER TABLE hon.hq_calls DISABLE TRIGGER USER');
  await admin.query(`INSERT INTO hon.hq_calls(direction,status,hq_number_e164,remote_e164,staff_principal_id,idempotency_key,connect_by)
    SELECT 'OUT','EXPIRED',$1,$2,$3,'bulk-'||g||'-'||$4,clock_timestamp() FROM generate_series(1,57) g`, [HQ_NUMBER, STRANGER, P('supportOp'), K()]);
  await admin.query('ALTER TABLE hon.hq_calls ENABLE TRIGGER USER');
  await refuse('54000', () => start('supportOp', { toE164: STRANGER }), '60 an hour', 'CALL_RATE_LIMITED');
  pass('outgoing: calling on and an HQ number required; school toll-fraud rules, not the HQ number, HQ do-not-call, 60 an hour; exact replay by key per person; contact linked by confirmed HQ phone');

  // ---------- 4. voice app and phone token ----------
  let t = await call('authorize_hq_phone_token', [H('supportOp')]);
  assert.deepEqual(t, { identity: ident('supportOp'), ready: false, callingOn: true, incoming: false });
  assert.equal((await w('SELECT hon.hq_needs_voice_app() n'))[0].n, true);
  const claim = (await w('SELECT * FROM hon.begin_hq_voice_app(60)'))[0];
  assert.equal(claim.state, 'CLAIMED');
  assert.equal((await w('SELECT * FROM hon.begin_hq_voice_app(60)'))[0].state, 'BUSY');
  assert.equal((await w('SELECT hon.hq_needs_voice_app() n'))[0].n, false);
  const AP = 'AP' + hex(), SK = 'SK' + hex();
  await refuse('40001', () => w('SELECT hon.record_hq_voice_app_twiml($1,$2)', [K(), AP]), 'lost claim records nothing', 'VOICE_APP_CLAIM_LOST');
  assert.equal((await w('SELECT hon.record_hq_voice_app_twiml($1,$2) ok', [claim.claim_token, AP]))[0].ok, true);
  assert.equal((await w('SELECT * FROM hon.read_hq_voice_app()')).length, 0);
  assert.equal((await w('SELECT hon.complete_hq_voice_app($1,$2,$3,$4) ok', [claim.claim_token, SK, sealed(), 'k1']))[0].ok, true);
  assert.deepEqual((await w('SELECT * FROM hon.read_hq_voice_app()'))[0], { twiml_app_sid: AP, api_key_sid: SK, sealed_api_secret: sealed(), vault_key_id: 'k1' });
  assert.equal((await w('SELECT * FROM hon.begin_hq_voice_app(60)'))[0].state, 'ACTIVE');
  await refuse('42501', () => admin.query("UPDATE hon.hq_voice_app SET api_key_sid=$1, version=version+1", ['SK' + hex()]), 'ACTIVE key never changes in place');
  t = await call('authorize_hq_phone_token', [H('supportOp')]);
  assert.deepEqual(t, { identity: ident('supportOp'), ready: true, callingOn: true, incoming: false });
  assert.deepEqual(await j('supportOp', 'set_my_hq_call_ringing', { ringMe: true }), { ringMe: true, version: 1 });
  assert.equal((await call('authorize_hq_phone_token', [H('supportOp')])).incoming, true);
  await refuse('42501', () => call('authorize_hq_phone_token', [H('noPurpose')]), 'no-purpose HQ grant gets no phone');
  pass('voice app: one claim at a time, a lost claim records nothing, the key is read only by the worker and never changes in place; the phone token names the HQ identity, never a key, and rings only with Ring me');

  // ---------- 5. connecting an outgoing call ----------
  const fresh = await start('hqOwner', { toE164: OWNER_PHONE });
  const sid = CA();
  assert.equal((await connect(fresh.callId, ident('supportOp'), sid)).outcome, 'REFUSED', 'another HQ person cannot use the call');
  await refuse('22023', () => connect(fresh.callId, 'u' + P('hqOwner').replaceAll('-', ''), sid), 'a school phone identity is not an HQ identity');
  const c1 = await connect(fresh.callId, ident('hqOwner'), sid);
  assert.deepEqual([c1.outcome, c1.to_e164, c1.caller_id_e164], ['CONNECT', OWNER_PHONE, HQ_NUMBER], 'the number dialled comes from the stored call');
  assert.equal((await connect(fresh.callId, ident('hqOwner'), sid)).outcome, 'REPLAYED');
  assert.equal((await connect(fresh.callId, ident('hqOwner'), CA())).outcome, 'REFUSED', 'connects once');
  const late = await start('hqOwner', { toE164: OWNER_PHONE });
  await admin.query('ALTER TABLE hon.hq_calls DISABLE TRIGGER USER');
  await admin.query("UPDATE hon.hq_calls SET connect_by=clock_timestamp()-interval '1 second' WHERE id=$1", [late.callId]);
  await admin.query('ALTER TABLE hon.hq_calls ENABLE TRIGGER USER');
  assert.equal((await connect(late.callId, ident('hqOwner'), CA())).outcome, 'REFUSED', 'after two minutes');
  const dnc = await start('hqOwner', { toE164: OWNER_PHONE });
  await j('hqOwner', 'set_hq_do_not_call', { phoneE164: OWNER_PHONE, doNotCall: true });
  assert.equal((await connect(dnc.callId, ident('hqOwner'), CA())).outcome, 'REFUSED', 'do-not-call set after start');
  await j('hqOwner', 'set_hq_do_not_call', { phoneE164: OWNER_PHONE, doNotCall: false });
  const revoked = await start('billingOp', { toE164: OWNER_PHONE });
  await admin.query("UPDATE hon.hq_operator_grants SET permission_codes='{}' WHERE principal_id=$1", [P('billingOp')]);
  assert.equal((await connect(revoked.callId, ident('billingOp'), CA())).outcome, 'REFUSED', 'starter lost HQ purpose');
  await admin.query("UPDATE hon.hq_operator_grants SET permission_codes='{hq.billing.manage}' WHERE principal_id=$1", [P('billingOp')]);
  assert.equal((await status(sid, 'IN_PROGRESS')).outcome, 'RECORDED');
  assert.equal((await status(sid, 'RINGING')).outcome, 'IGNORED', 'status never moves back');
  assert.equal((await status(sid, 'MISSED')).outcome, 'IGNORED', 'an outgoing call is never MISSED');
  assert.deepEqual(await status(sid, 'COMPLETED', null, 95), { outcome: 'RECORDED', status: 'COMPLETED' });
  assert.equal((await status(CA(), 'COMPLETED')).outcome, 'UNKNOWN_CALL');
  pass('outgoing connect: only the starter, from the stored number, within two minutes, once; refused after do-not-call or lost HQ purpose; status forward only');

  // ---------- 6. incoming calls and voicemail ----------
  await j('hqOwner', 'set_my_hq_call_ringing', { ringMe: true });
  await j('noPurpose', 'set_my_hq_call_ringing', { ringMe: true }).catch(() => null);
  assert.equal((await route('+15125550100', OWNER_PHONE, CA())).outcome, 'UNROUTED', 'not the HQ number');
  const inSid = CA();
  const r1 = await route(HQ_NUMBER, OWNER_PHONE, inSid);
  assert.equal(r1.outcome, 'RING'); assert.deepEqual(r1.identities, [ident('supportOp'), ident('hqOwner')]);
  assert.equal(r1.voicemail_greeting, 'You reached HON HQ. Leave a message.');
  assert.equal((await route(HQ_NUMBER, OWNER_PHONE, inSid)).outcome, 'REPLAYED');
  assert.equal((await row(r1.call_id)).contact_user_id, Uu('owner1'), 'incoming linked to the confirmed contact');
  await refuse('22023', () => status(inSid, 'IN_PROGRESS', 'u' + P('supportOp').replaceAll('-', '')), 'school identity refused');
  assert.equal((await status(inSid, 'IN_PROGRESS', ident('supportOp'))).outcome, 'RECORDED');
  assert.equal((await status(inSid, 'IN_PROGRESS', ident('hqOwner'))).outcome, 'IGNORED', 'first answer wins');
  assert.equal((await row(r1.call_id)).staff_principal_id, P('supportOp'));
  assert.equal((await voicemail(inSid, RE())).outcome, 'REFUSED', 'an answered call gets no voicemail');
  const vmSid = CA();
  const r2 = await route(HQ_NUMBER, null, vmSid);
  assert.equal(r2.outcome, 'RING');
  await refuse('22023', () => voicemail(vmSid, 'nope'), 'bad recording SID');
  const rec = RE();
  assert.deepEqual(await voicemail(vmSid, rec, 21), { outcome: 'RECORDED', call_id: r2.call_id });
  assert.equal((await voicemail(vmSid, rec, 21)).outcome, 'REPLAYED');
  assert.equal((await voicemail(vmSid, RE(), 21)).outcome, 'REFUSED', 'one voicemail per call');
  let vm = await row(r2.call_id);
  assert.deepEqual([vm.status, vm.voicemail, vm.recording_status, vm.remote_e164], ['VOICEMAIL', true, 'AVAILABLE', null]);
  o = await overview('supportOp');
  assert.equal(o.unheardVoicemails, 1); assert.equal(o.missedToday >= 1, true);
  const list = await j('supportOp', 'read_hq_calls', { filter: 'VOICEMAIL' });
  assert.deepEqual(list.calls.map((c) => c.callId), [r2.call_id]);
  assert.equal(list.calls[0].recordingAvailable, true); assert.equal(list.calls[0].heard, false);
  assert.equal((await j('supportOp', 'read_hq_calls', { filter: 'OUTGOING' })).calls.every((c) => c.direction === 'OUT'), true);
  assert.equal((await j('supportOp', 'read_hq_calls', { contactUserId: Uu('owner1') })).calls.every((c) => c.contactUserId === Uu('owner1')), true);
  const page = await j('supportOp', 'read_hq_calls', {});
  assert.equal(page.calls.length, 50); assert.ok(page.nextCursor);
  const page2 = await j('supportOp', 'read_hq_calls', { before: page.nextCursor });
  assert.equal(new Set([...page.calls, ...page2.calls].map((c) => c.callId)).size, page.calls.length + page2.calls.length, 'pages never repeat');
  const opened = await call('open_hq_call_recording', [H('supportOp'), r2.call_id], ['', '::uuid']);
  assert.deepEqual(opened, { recordingSid: rec, accountSid: null, seconds: 21 });
  await refuse('P0002', () => call('open_hq_call_recording', [H('supportOp'), r1.call_id], ['', '::uuid']), 'no recording on an answered HQ call', 'CALL_RECORDING_NOT_FOUND');
  await refuse('42501', () => call('open_hq_call_recording', [H('noPurpose'), r2.call_id], ['', '::uuid']), 'no-purpose HQ grant cannot play');
  const heard = await j('supportOp', 'update_hq_call', { callId: r2.call_id, expectedVersion: list.calls[0].version, heard: true, outcome: 'CALL_BACK', note: 'Owner asked about billing.' });
  assert.deepEqual([heard.heard, heard.outcome, heard.note], [true, 'CALL_BACK', 'Owner asked about billing.']);
  await refuse('40001', () => j('supportOp', 'update_hq_call', { callId: r2.call_id, expectedVersion: list.calls[0].version, note: null }), 'stale version', 'CALL_VERSION_CONFLICT');
  await refuse('22023', async () => j('supportOp', 'update_hq_call', { callId: r1.call_id, expectedVersion: (await row(r1.call_id)).version, heard: true }), 'heard only for voicemail');
  await refuse('22023', () => j('supportOp', 'update_hq_call', { callId: r2.call_id, expectedVersion: heard.version, outcome: 'TRIAL_BOOKED' }), 'school outcomes are not HQ outcomes');
  await settings('hqOwner', false, 1, null);
  assert.equal((await route(HQ_NUMBER, OWNER_PHONE, CA())).outcome, 'OFF', 'calling off: nothing recorded');
  assert.equal((await call('authorize_hq_phone_token', [H('supportOp')])).ready, false);
  await settings('hqOwner', true, 2, null);
  pass('incoming: only the HQ number rings Ring me HQ people who may still take calls, first answer wins, one voicemail per missed call, list filters and keyset pages, every play kept as evidence; calling off stops routing and phones');

  // ---------- 7. retention, immutability and evidence ----------
  assert.equal((await w('SELECT * FROM hon.read_hq_call_recordings_due(10)')).length, 0);
  assert.equal((await w('SELECT hon.mark_hq_call_recording_deleted($1,$2) ok', [r2.call_id, rec]))[0].ok, false, 'not due yet');
  await admin.query('ALTER TABLE hon.hq_calls DISABLE TRIGGER USER');
  await admin.query("UPDATE hon.hq_calls SET created_at=clock_timestamp()-interval '91 days' WHERE id=$1", [r2.call_id]);
  await admin.query('ALTER TABLE hon.hq_calls ENABLE TRIGGER USER');
  assert.deepEqual(await w('SELECT * FROM hon.read_hq_call_recordings_due(10)'), [{ call_id: r2.call_id, recording_sid: rec }]);
  assert.equal((await w('SELECT hon.mark_hq_call_recording_deleted($1,$2) ok', [r2.call_id, RE()]))[0].ok, false, 'exact SID only');
  assert.equal((await w('SELECT hon.mark_hq_call_recording_deleted($1,$2) ok', [r2.call_id, rec]))[0].ok, true);
  assert.equal((await row(r2.call_id)).recording_status, 'DELETED');
  await refuse('P0002', () => call('open_hq_call_recording', [H('supportOp'), r2.call_id], ['', '::uuid']), 'deleted voicemail cannot be played');
  await refuse('42501', () => admin.query("UPDATE hon.hq_calls SET remote_e164='+15125550177', version=version+1 WHERE id=$1", [r1.call_id]), 'numbers never change');
  await refuse('42501', () => admin.query("UPDATE hon.hq_calls SET status='RINGING', version=version+1 WHERE id=$1", [r1.call_id]), 'status never moves back');
  await refuse('42501', () => admin.query("UPDATE hon.hq_calls SET recording_status='AVAILABLE', version=version+1 WHERE id=$1", [r2.call_id]), 'deleted stays deleted');
  await refuse('42501', () => admin.query('DELETE FROM hon.hq_calls WHERE id=$1', [r1.call_id]), 'calls are never deleted');
  await refuse('42501', () => admin.query('TRUNCATE hon.hq_calls CASCADE'), 'calls are never truncated');
  await refuse('42501', () => admin.query("UPDATE hon.hq_call_events SET action_code='hq.call.x'"), 'evidence is append-only');
  await refuse('42501', () => admin.query('DELETE FROM hon.hq_call_staff'), 'Ring me rows are never deleted');
  const events = (await admin.query('SELECT action_code, state::text s FROM hon.hq_call_events')).rows;
  for (const a of ['hq.call.settings.set', 'hq.call.start', 'hq.call.connect', 'hq.call.receive', 'hq.call.status', 'hq.call.voicemail.receive',
    'hq.call.recording.open', 'hq.call.update', 'hq.call.do_not_call.set', 'hq.call.phone_token.issue', 'hq.call.voice_app.created', 'hq.call.recording.delete', 'hq.call.ringing.set'])
    assert.ok(events.some((e) => e.action_code === a), 'evidence ' + a);
  assert.ok(events.every((e) => !e.s.includes('+1512') && !e.s.includes('billing')), 'evidence carries no numbers or notes');
  pass('voicemail deleted after 90 days by exact SID only; calls never change outside the entry points, never deleted or truncated; append-only evidence with ids and states only');
  // ---------- 8. canonical 011 section ----------
  {
    const verify = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
    const section = verify.split('-- HQ calls exact verification (0591)')[1]?.split('-- End HQ calls exact verification.')[0];
    assert(section, '011 section');
    const rt = new URL(process.env.HON_RUNTIME_DATABASE_URL).username, wk = new URL(process.env.HON_COMMUNICATION_WORKER_DATABASE_URL).username;
    const body = section.replace(/^[^\n]*\n[^\n]*\n/, '').replaceAll('hon_communication_worker', wk).replaceAll('hon_runtime', rt);
    await admin.query(body);
    await admin.query(`GRANT EXECUTE ON FUNCTION hon.hq_call_json(hon.hq_calls) TO ${rt}`);
    await assert.rejects(admin.query(body), /Unsafe HQ calls function: hon.hq_call_json/);
    await admin.query(`REVOKE EXECUTE ON FUNCTION hon.hq_call_json(hon.hq_calls) FROM ${rt}`);
    await admin.query(`GRANT EXECUTE ON FUNCTION hon.start_hq_call(text,jsonb,text) TO ${wk}`);
    await assert.rejects(admin.query(body), /Unsafe HQ calls function: hon.start_hq_call/);
    await admin.query(`REVOKE EXECUTE ON FUNCTION hon.start_hq_call(text,jsonb,text) FROM ${wk}`);
    await admin.query(`GRANT SELECT ON hon.hq_calls TO ${wk}`);
    await assert.rejects(admin.query(body), /Unsafe HQ calls table: hq_calls/);
    await admin.query(`REVOKE SELECT ON hon.hq_calls FROM ${wk}`);
    await admin.query(body);
  }
  pass('the canonical 011 verification of the 0591 tables and functions passes and refuses an extra runtime grant, worker grant or table privilege');
  console.log(`HQ calls: ${groups} groups passed`);
} finally {
  await cleanup().catch(() => {});
  await Promise.all([admin.end(), runtime.end(), worker.end()]);
}
