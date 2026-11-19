/** School calls (0556, CL1, docs/architecture/SCHOOL_CALLING.md §5) on the marked disposable communication delivery database.
 *  Staff entry points run as the restricted runtime login inside HON staff session settings; provider entry points run as the
 *  0243 communication worker login. Schools are SYNTHETIC sign-ups made through the 0241 runtime entry point. Nothing is called. */
import assert from 'node:assert/strict';
import { randomUUID as K, createHash } from 'node:crypto';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const C = createRequire(new URL('../../../apps/api/package.json', import.meta.url))('@hon/contracts');

const owner = new URL(process.env.DATABASE_URL ?? ''), runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? ''), workerUrl = new URL(process.env.HON_COMMUNICATION_WORKER_DATABASE_URL ?? '');
for (const u of [owner, runtime, workerUrl]) {
  assert.equal(u.hostname, 'localhost'); assert.equal(u.port, '5432'); assert.equal(u.pathname, '/hon_comm_delivery_validation');
}
const admin = new pg.Client({ connectionString: owner.toString(), ssl: false });
const restricted = new pg.Client({ connectionString: runtime.toString(), ssl: false });
const worker = new pg.Client({ connectionString: workerUrl.toString(), ssl: false });
let groups = 0;
const pass = (name) => console.log('PASS CALLS ' + (++groups) + ' ' + name);
const q = async (sql, args = []) => (await admin.query(sql, args)).rows;
const hex = () => createHash('md5').update(K()).digest('hex');
const callSid = () => 'CA' + hex(), recSid = () => 'RE' + hex(), msid = () => 'MG' + hex();
const ident = (principal) => 'u' + principal.replaceAll('-', '');
const human = (label) => ({ externalSubject: 'oidc:calls:' + label + ':' + K(), email: label + '-' + K() + '@example.invalid' });

async function as(x, sql, args = [], readOnly = false) {
  // Reads run READ ONLY, as the API runs them.
  await restricted.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
  try {
    for (const [k, v] of [['app.hon_external_subject', x.externalSubject], ['app.hon_principal_type', 'HUMAN_USER'], ['app.hon_source', 'HUMAN_UI'],
      ['app.hon_principal_id', x.principal], ['app.hon_organization_id', x.org], ['app.hon_school_id', x.school]]) {
      await restricted.query('SELECT set_config($1,$2,true)', [k, v]);
    }
    const rows = (await restricted.query(sql, args)).rows;
    await restricted.query('COMMIT');
    return rows[0]?.data;
  } catch (error) { await restricted.query('ROLLBACK'); throw error; }
}
async function rejects(code, work, label) {
  try { await work(); } catch (error) { assert.equal(error.code, code, label + ': ' + error.message); return error; }
  assert.fail(label + ': no error');
}
const calling = (x) => as(x, 'SELECT hon.read_school_calling($1) data', [x.externalSubject], true);
const settings = (x, p) => as(x, 'SELECT hon.set_school_calling_settings($1,$2::jsonb,$3,$4) data', [x.externalSubject, JSON.stringify(p), K(), K()]);
const ringMe = (x, on) => as(x, 'SELECT hon.set_my_school_call_ringing($1,$2::jsonb) data', [x.externalSubject, JSON.stringify({ ringMe: on })]);
const start = (x, p, key = 'key-' + K()) => as(x, 'SELECT hon.start_school_call($1,$2::jsonb,$3,$4,$5) data', [x.externalSubject, JSON.stringify(p), key, K(), K()]);
const log = (x, p = {}) => as(x, 'SELECT hon.read_school_calls($1,$2::jsonb) data', [x.externalSubject, JSON.stringify(p)], true);
const update = (x, p) => as(x, 'SELECT hon.update_school_call($1,$2::jsonb,$3,$4) data', [x.externalSubject, JSON.stringify(p), K(), K()]);
const dnc = (x, phone, on) => as(x, 'SELECT hon.set_school_do_not_call($1,$2::jsonb) data', [x.externalSubject, JSON.stringify({ phoneE164: phone, doNotCall: on })]);
const openRec = (x, id) => as(x, 'SELECT hon.open_school_call_recording($1,$2) data', [x.externalSubject, id]);
const connect = async (id, identity, account, sid) => (await worker.query('SELECT * FROM hon.connect_school_client_call($1,$2,$3,$4)', [id, identity, account, sid])).rows[0];
const route = async (to, from, sid) => (await worker.query('SELECT * FROM hon.route_school_incoming_call($1,$2,$3)', [to, from, sid])).rows[0];
const status = async (sid, s, identity = null, duration = null, at = new Date(), account = null) =>
  (await worker.query('SELECT * FROM hon.record_school_call_status($1,$2,$3,$4,$5,$6)', [account, sid, s, identity, duration, at])).rows[0];
const recording = async (sid, rec, seconds, voicemail, account = null) => (await worker.query('SELECT * FROM hon.record_school_call_recording($1,$2,$3,$4,$5)', [account, sid, rec, seconds, voicemail])).rows[0];
const row = async (id) => (await q('SELECT * FROM hon.school_calls WHERE id=$1', [id]))[0];

let terms;
async function register(label) {
  const p = human(label);
  const r = (await restricted.query('SELECT hon.register_hon_os_school($1,$2,$3::jsonb,$4) data', [p.externalSubject, p.email,
    { ownerName: 'Synthetic ' + label, schoolName: 'Synthetic ' + label + ' Dojo', legalName: 'Synthetic ' + label + ' LLC', timezone: 'America/Chicago',
      termsVersionId: terms, confirmation: C.SIGNUP_CONFIRMATION }, K()])).rows[0].data;
  const principal = (await q('SELECT p.id FROM hon.users u JOIN hon.principals p ON p.user_id=u.id WHERE u.external_subject=$1', [p.externalSubject]))[0].id;
  await q("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=NULL,updated_at=clock_timestamp() WHERE organization_id=$1", [r.organizationId]);
  return { ...p, org: r.organizationId, school: r.schoolId, principal };
}
async function staff(x, label, permissions) {
  const p = human(label), user = K(), principal = K(), role = K();
  await q('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)', [user, p.externalSubject, p.email, 'Coach ' + label]);
  await q("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,$3)", [principal, user, 'Coach ' + label]);
  await q('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,false)', [role, x.org, 'STAFF_' + role.slice(0, 8)]);
  for (const code of permissions) await q('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [role, x.org, code]);
  const grant = K();
  await q("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')",
    [grant, x.org, x.school, principal, role]);
  return { ...p, org: x.org, school: x.school, principal, grant };
}

try {
  await Promise.all([admin.connect(), restricted.connect(), worker.connect()]);
  assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m, 'HON disposable communication delivery validation');

  // 1. Custody.
  for (const t of ['school_calling_settings', 'school_call_staff', 'school_calls', 'school_do_not_call']) {
    const c = (await q('SELECT relrowsecurity rls,relforcerowsecurity forced FROM pg_class WHERE oid=$1::regclass', ['hon.' + t]))[0]; assert(c.rls && c.forced, t);
    for (const role of [runtime.username, workerUrl.username]) for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
      assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok', [role, 'hon.' + t, p]))[0].ok, false, role + ':' + t + ':' + p);
  }
  const staffEntry = ['read_school_calling', 'set_school_calling_settings', 'set_my_school_call_ringing', 'start_school_call', 'read_school_calls', 'update_school_call', 'set_school_do_not_call', 'open_school_call_recording'];
  const workerEntry = ['connect_school_client_call', 'route_school_incoming_call', 'record_school_call_status', 'record_school_call_recording', 'read_school_call_recordings_due', 'mark_school_call_recording_deleted'];
  const fns = await q("SELECT p.oid,p.proname,p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.oid>=(SELECT oid FROM pg_proc WHERE proname='school_call_rank')");
  const ours = fns.filter((f) => /call|calling/.test(f.proname) && !/(^|_)hq_/.test(f.proname));
  assert.equal(ours.length, 27, ours.map((f) => f.proname).join());
  for (const f of ours) {
    assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [runtime.username, f.oid]))[0].ok, staffEntry.includes(f.proname), 'runtime ' + f.proname);
    assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [workerUrl.username, f.oid]))[0].ok, workerEntry.includes(f.proname), 'worker ' + f.proname);
  }
  await assert.rejects(restricted.query('SELECT * FROM hon.route_school_incoming_call($1,$2,$3)', ['+15125550100', '+15125551001', callSid()]), /permission denied/);
  await assert.rejects(worker.query('SELECT hon.read_school_calls($1,$2::jsonb)', ['x', '{}']), /permission denied/);
  assert.equal((await q("SELECT count(*) n FROM hon.permissions WHERE code IN ('communication.call.use','communication.call.manage') AND is_sensitive AND is_staff_assignable"))[0].n, '2');
  pass('forced RLS on four tables with no table privilege; runtime runs exactly the eight staff entry points, the worker exactly the six provider ones');

  await q("UPDATE hon.hon_os_signup_program SET status='TEST_MODE',recorded_at=clock_timestamp() WHERE program_id=1");
  terms = (await q('SELECT id FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1'))[0].id;
  const a = await register('alpha'), b = await register('beta');
  const coach = await staff(a, 'coach', ['communication.call.use']), desk = await staff(a, 'desk', ['communication.message.read']);
  const coach2 = await staff(a, 'coach2', ['communication.call.use']);
  // Sender numbers are unique database-wide: fresh ones per run (737 area code, never dialed).
  const rnd = () => '+1737' + String(2000000 + Math.floor(Math.random() * 7999999));
  const numA = rnd(), numB = rnd(), fwdA = rnd();
  await q("INSERT INTO hon.school_text_senders(organization_id,school_id,phone_e164,messaging_service_sid,status,mms_converter_confirmed,set_by_principal_id) VALUES($1,$2,$3,$4,'ACTIVE',true,$5),($6,$7,$8,$9,'ACTIVE',true,$10)",
    [a.org, a.school, numA, msid(), a.principal, b.org, b.school, numB, msid(), b.principal]);
  const ada = K();
  await q("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,phone_e164) VALUES($1,$2,$3,'Ada','Parent','+15125551001')", [ada, a.org, a.school]);
  await q("INSERT INTO hon.people(organization_id,school_id,given_name,family_name,phone_e164) VALUES($1,$2,'Other','School','+15125551001')", [b.org, b.school]);

  // 2. Permissions.
  await rejects('42501', () => calling(desk), 'no communication.call.use');
  await rejects('42501', () => settings(coach, { callingOn: true, voicemailGreeting: null, recordingOn: false, recordingConsentAccepted: false, expectedVersion: 0 }), 'use is not manage');
  await rejects('42501', () => as({ ...coach, school: b.school, org: b.org }, 'SELECT hon.read_school_calling($1) data', [coach.externalSubject]), 'other school session');
  let view = await calling(a);
  assert.equal(view.callingOn, false); assert.equal(view.numberReady, true); assert.equal(view.schoolNumber, numA); assert.equal(view.canManage, true); assert.equal(view.version, 0);
  assert.equal((await calling(coach)).staff, null);
  pass('call.use reads, only call.manage (system OWNER) changes settings, other permissions and schools refused, staff list for managers only');

  // 3. Settings and recording consent.
  await rejects('55000', () => start(coach, { toE164: '+15125551001' }), 'calling off: no outgoing call');
  await rejects('22023', () => settings(a, { callingOn: true, voicemailGreeting: '<b>hi</b>', recordingOn: false, recordingConsentAccepted: false, expectedVersion: 0 }), 'greeting markup refused');
  await rejects('22023', () => settings(a, { callingOn: true, voicemailGreeting: null, recordingOn: true, recordingConsentAccepted: false, expectedVersion: 0 }), 'recording without consent');
  let s = await settings(a, { callingOn: true, voicemailGreeting: 'Thanks for calling Alpha Dojo, leave a message.', recordingOn: false, recordingConsentAccepted: false, expectedVersion: 0 });
  assert.equal(s.version, 1); assert.equal(s.recordingConsentAt, null);
  await rejects('40001', () => settings(a, { callingOn: true, voicemailGreeting: null, recordingOn: false, recordingConsentAccepted: false, expectedVersion: 0 }), 'stale version');
  s = await settings(a, { callingOn: true, voicemailGreeting: 'Thanks for calling Alpha Dojo, leave a message.', recordingOn: true, recordingConsentAccepted: true, expectedVersion: 1 });
  assert.equal(s.recordingOn, true); assert(s.recordingConsentAt);
  const consent = (await q('SELECT recording_consent_by FROM hon.school_calling_settings WHERE school_id=$1', [a.school]))[0].recording_consent_by;
  assert.equal(consent, a.principal);
  assert.equal((await q("SELECT count(*) n FROM hon.audit_events WHERE school_id=$1 AND action_code='communication.calling_settings.set'", [a.school]))[0].n, '2');
  pass('calling starts off; greeting is plain text; recording needs the consent statement, who and when are kept; versioned and audited');

  // 4. Outgoing start: number rules, do-not-call, idempotency, person matching.
  for (const bad of ['+442071234567', '+19005551234', '+15129765555', '+14115551234', '+15124111234', numA,
    '+18765551234', '+18095551234', '+18295551234', '+12685551234', '+14735551234', '+16495551234', '+17875551234', '+19395551234',
    '+15005551234', '+15215551234', '+12925551234', '+17105551234']) {
    await rejects('22023', () => start(coach, { toE164: bad }), 'refused number ' + bad);
  }
  await q('UPDATE hon.school_text_senders SET forward_phone_e164=$1 WHERE school_id=$2', [fwdA, a.school]);
  await rejects('22023', () => start(coach, { toE164: fwdA }), 'own forwarding phone refused');
  await dnc(coach, '+15125551009', true);
  await rejects('22023', () => start(coach, { toE164: '+15125551009' }), 'do-not-call refused');
  await rejects('42501', () => q("UPDATE hon.school_do_not_call SET phone_e164='+15125551008' WHERE phone_e164='+15125551009'"), 'do-not-call row immutable');
  await rejects('42501', () => q('TRUNCATE hon.school_do_not_call'), 'do-not-call never truncated');
  await dnc(coach, '+15125551009', false);
  assert.equal((await start(coach, { toE164: '+18005551234' })).status, 'INITIATED', 'US toll-free allowed');
  const key = 'key-' + K();
  const out = await start(coach, { toE164: '+15125551001' }, key);
  assert.equal(out.status, 'INITIATED'); assert.equal(out.personId, ada); assert.equal(out.contactName, 'Ada Parent'); assert.equal(out.replayed, false);
  const again = await start(coach, { toE164: '+15125551001' }, key);
  assert.equal(again.callId, out.callId); assert.equal(again.replayed, true);
  await rejects('23505', () => start(coach, { toE164: '+15125551002' }, key), 'key reused for another number');
  await rejects('P0002', () => start(coach, { toE164: '+15125551002', personId: K() }), 'unknown person');
  await rejects('22023', () => start(coach, { toE164: '+15125551002', personId: ada }), 'person whose phone is another number');
  const otherPerson = (await q('SELECT id FROM hon.people WHERE school_id=$1', [b.school]))[0].id;
  await rejects('P0002', () => start(coach, { toE164: '+15125551002', personId: otherPerson }), 'other school person');
  pass('+1 US/Canada only: no Caribbean or territory codes, no 900/976/N11/personal/reserved codes, not the school number or its forwarding phone, do-not-call honoured; exact replay by key, reuse refused; person matched in this school only');

  // 5. Connecting the browser call.
  const sidOut = callSid();
  let c = await connect(out.callId, ident(coach2.principal), null, sidOut);
  assert.equal(c.outcome, 'REFUSED', 'another staff identity');
  c = await connect(out.callId, ident(coach.principal), 'AC' + hex(), sidOut);
  assert.equal(c.outcome, 'REFUSED', 'other account');
  c = await connect(out.callId, ident(coach.principal), null, sidOut);
  assert.equal(c.outcome, 'CONNECT'); assert.equal(c.to_e164, '+15125551001'); assert.equal(c.caller_id_e164, numA); assert.equal(c.recorded, true);
  assert.equal((await connect(out.callId, ident(coach.principal), null, sidOut)).outcome, 'REPLAYED');
  assert.equal((await connect(out.callId, ident(coach2.principal), null, sidOut)).outcome, 'REFUSED', 'replay by another identity');
  assert.equal((await connect(out.callId, ident(coach.principal), 'AC' + hex(), sidOut)).outcome, 'REFUSED', 'replay on another account');
  assert.equal((await connect(out.callId, ident(coach.principal), null, callSid())).outcome, 'REFUSED', 'used once');
  const stale = await start(coach, { toE164: '+15125551003' });
  await q("ALTER TABLE hon.school_calls DISABLE TRIGGER guarded");
  await q("UPDATE hon.school_calls SET connect_by=clock_timestamp()-interval '1 second' WHERE id=$1", [stale.callId]);
  await q("ALTER TABLE hon.school_calls ENABLE TRIGGER guarded");
  assert.equal((await connect(stale.callId, ident(coach.principal), null, callSid())).outcome, 'REFUSED', 'expired');
  assert.equal((await log(coach)).calls.find((x) => x.callId === stale.callId).status, 'EXPIRED', 'shown EXPIRED at once');
  await start(coach, { toE164: '+15125551005' });
  assert.equal((await row(stale.callId)).status, 'EXPIRED', 'stored EXPIRED on the next start');
  const lost = await start(coach, { toE164: '+15125551004' });
  await q("DELETE FROM hon.role_permissions WHERE permission_code='communication.call.use' AND role_id=(SELECT role_id FROM hon.principal_role_grants WHERE id=$1)", [coach.grant]);
  assert.equal((await connect(lost.callId, ident(coach.principal), null, callSid())).outcome, 'REFUSED', 'starter lost permission');
  await q("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT role_id,organization_id,'communication.call.use' FROM hon.principal_role_grants WHERE id=$1", [coach.grant]);
  pass('only the starter, on the school\'s own account, within two minutes, once; expired calls show EXPIRED; a starter who lost permission is refused');

  // 6. Status ordering.
  assert.equal((await status(sidOut, 'IN_PROGRESS')).status, 'IN_PROGRESS');
  assert.equal((await status(sidOut, 'RINGING')).outcome, 'IGNORED');
  assert.equal((await status(sidOut, 'COMPLETED', null, 95)).status, 'COMPLETED');
  assert.equal((await status(sidOut, 'FAILED')).outcome, 'IGNORED');
  let r = await row(out.callId); assert.equal(r.duration_seconds, 95); assert(r.answered_at && r.ended_at);
  assert.equal((await status(callSid(), 'COMPLETED')).outcome, 'UNKNOWN_CALL');
  assert.equal((await status(sidOut, 'COMPLETED', null, 95, new Date(), 'AC' + hex())).outcome, 'UNKNOWN_CALL', 'another account cannot touch this call');
  assert.equal((await recording(sidOut, recSid(), 5, false, 'AC' + hex())).outcome, 'UNKNOWN_CALL', 'nor record on it');
  assert.equal((await q("SELECT count(*) n FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='communication.call.completed'", [out.callId]))[0].n, '1');
  await rejects('42501', () => q('UPDATE hon.school_calls SET remote_e164=$1, version=version+1 WHERE id=$2', ['+15125550000', out.callId]), 'numbers immutable');
  await rejects('42501', () => q("UPDATE hon.school_calls SET status='RINGING', version=version+1 WHERE id=$1", [out.callId]), 'status never moves back');
  await rejects('42501', () => q('DELETE FROM hon.school_calls WHERE id=$1', [out.callId]), 'never deleted');
  pass('status moves forward only, older callbacks ignored, completion event once, numbers immutable, no deletes');

  // 7. Incoming: routing to Ring me staff, answer, voicemail, other schools.
  assert.equal((await route('+15125559999', '+15125551001', callSid())).outcome, 'UNROUTED');
  await ringMe(coach, true); await ringMe(coach2, true);
  const sidIn = callSid();
  let rt = await route(numA, '+15125551001', sidIn);
  assert.equal(rt.outcome, 'RING'); assert.deepEqual(rt.identities.sort(), [ident(coach.principal), ident(coach2.principal)].sort());
  assert.equal(rt.forward_phone_e164, fwdA); assert.equal(rt.recorded, true); assert.equal(rt.voicemail_greeting, 'Thanks for calling Alpha Dojo, leave a message.');
  assert.equal((await route(numA, '+15125551001', sidIn)).outcome, 'REPLAYED');
  await settings(b, { callingOn: true, voicemailGreeting: null, recordingOn: false, recordingConsentAccepted: false, expectedVersion: 0 });
  assert.equal((await route(numB, '+15125551001', sidIn)).outcome, 'UNROUTED', 'same sid at another school');
  await status(sidIn, 'IN_PROGRESS', ident(coach2.principal));
  r = (await q('SELECT * FROM hon.school_calls WHERE provider_call_sid=$1', [sidIn]))[0];
  assert.equal(r.staff_principal_id, coach2.principal); assert.equal(r.person_id, ada);
  await status(sidIn, 'IN_PROGRESS', ident(coach.principal));
  assert.equal((await q('SELECT staff_principal_id FROM hon.school_calls WHERE provider_call_sid=$1', [sidIn]))[0].staff_principal_id, coach2.principal, 'first answer wins');
  await status(sidIn, 'COMPLETED', null, 40);
  assert.equal((await recording(sidIn, recSid(), 40, false)).outcome, 'RECORDED');
  // Recording off: no recording kept; a withheld caller still rings; voicemail turns a missed call into VOICEMAIL.
  const v = (await q('SELECT version FROM hon.school_calling_settings WHERE school_id=$1', [a.school]))[0].version;
  await settings(a, { callingOn: true, voicemailGreeting: null, recordingOn: false, recordingConsentAccepted: false, expectedVersion: v });
  await ringMe(coach2, false);
  const sidVm = callSid();
  rt = await route(numA, null, sidVm);
  assert.equal(rt.outcome, 'RING'); assert.deepEqual(rt.identities, [ident(coach.principal)]); assert.equal(rt.recorded, false);
  const vmRec = recSid();
  assert.equal((await recording(sidVm, recSid(), 10, false)).outcome, 'REFUSED', 'not recorded call');
  assert.equal((await status(sidVm, 'MISSED')).status, 'MISSED');
  assert.equal((await recording(sidIn, recSid(), 5, true)).outcome, 'REFUSED', 'an answered call takes no voicemail');
  assert.equal((await recording(sidVm, vmRec, 12, true)).outcome, 'RECORDED');
  assert.equal((await recording(sidVm, vmRec, 12, true)).outcome, 'REPLAYED');
  r = (await q('SELECT * FROM hon.school_calls WHERE provider_call_sid=$1', [sidVm]))[0];
  assert.equal(r.status, 'VOICEMAIL'); assert.equal(r.voicemail, true); assert.equal(r.remote_e164, null);
  assert.equal((await q("SELECT count(*) n FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type IN ('communication.call.missed','communication.voicemail.received')", [r.id]))[0].n, '2');
  // Calling off: the 0249 path applies.
  const v2 = (await q('SELECT version FROM hon.school_calling_settings WHERE school_id=$1', [a.school]))[0].version;
  await settings(a, { callingOn: false, voicemailGreeting: null, recordingOn: false, recordingConsentAccepted: false, expectedVersion: v2 });
  assert.equal((await route(numA, '+15125551001', callSid())).outcome, 'OFF');
  await settings(a, { callingOn: true, voicemailGreeting: null, recordingOn: false, recordingConsentAccepted: false, expectedVersion: v2 + 1 });
  await q("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [a.org]);
  assert.equal((await route(numA, '+15125551001', callSid())).outcome, 'OFF', 'lapsed school');
  await q("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1", [a.org]);
  pass('incoming rings Ring me staff (max 10) plus the forwarding phone, first answer wins, voicemail and recordings recorded once, calling off or lapsed = 0249 path');

  // 8. Call log, after-call card, voicemail heard, recording open.
  let page = await log(coach);
  assert(page.calls.length >= 4); assert.equal(page.nextCursor, null);
  assert.equal((await log(coach, { filter: 'VOICEMAIL' })).calls.length, 1);
  assert.equal((await log(coach, { filter: 'OUTGOING' })).calls.every((x) => x.direction === 'OUT'), true);
  assert.equal((await log(coach, { personId: ada })).calls.every((x) => x.personId === ada), true);
  assert.equal((await log(b)).calls.length, 0, 'school B sees nothing of A');
  view = await calling(coach); assert.equal(view.unheardVoicemails, 1); assert.equal(view.ringMe, true);
  const vm = (await log(coach, { filter: 'VOICEMAIL' })).calls[0];
  assert.equal(vm.recordingAvailable, true);
  const opened = await openRec(coach, vm.callId); assert.equal(opened.recordingSid, vmRec); assert.equal(opened.accountSid, null);
  await rejects('P0002', () => openRec(b, vm.callId), 'other school cannot open');
  await rejects('42501', () => openRec(desk, vm.callId), 'no permission cannot open');
  assert.equal((await q("SELECT count(*) n FROM hon.audit_events WHERE entity_id=$1 AND action_code='communication.call_recording.open'", [vm.callId]))[0].n, '1');
  const done = await update(coach, { callId: vm.callId, expectedVersion: vm.version, outcome: 'CALL_BACK', note: 'Asked about kids class', heard: true });
  assert.equal(done.outcome, 'CALL_BACK'); assert.equal(done.heard, true);
  await rejects('40001', () => update(coach, { callId: vm.callId, expectedVersion: vm.version, outcome: 'OTHER' }), 'stale');
  const outVersion = (await row(out.callId)).version;
  await rejects('22023', () => update(coach, { callId: out.callId, expectedVersion: outVersion, heard: true }), 'heard only for voicemail');
  await rejects('P0002', () => update(b, { callId: vm.callId, expectedVersion: done.version, outcome: 'OTHER' }), 'other school');
  assert.equal((await calling(coach)).unheardVoicemails, 0);
  pass('call log filters and person view stay inside the school; recordings open only for call.use at that school, audited; outcome, note, heard versioned');

  // 9. Retention.
  await q('ALTER TABLE hon.school_calls DISABLE TRIGGER guarded');
  await q("UPDATE hon.school_calls SET created_at=created_at-interval '91 days' WHERE id=$1", [vm.callId]);
  await q('ALTER TABLE hon.school_calls ENABLE TRIGGER guarded');
  const due = (await worker.query('SELECT * FROM hon.read_school_call_recordings_due(10)')).rows;
  assert(due.some((d) => d.call_id === vm.callId && d.recording_sid === vmRec));
  assert.equal((await worker.query('SELECT hon.mark_school_call_recording_deleted($1,$2) ok', [vm.callId, recSid()])).rows[0].ok, false, 'wrong sid');
  assert.equal((await worker.query('SELECT hon.mark_school_call_recording_deleted($1,$2) ok', [vm.callId, vmRec])).rows[0].ok, true);
  await rejects('P0002', () => openRec(coach, vm.callId), 'deleted recording cannot open');
  pass('recordings older than 90 days are listed for deletion and marked DELETED only with the exact SID');

  // 10. Rate limit.
  for (let i = 0; i < 60; i += 1) {
    const n = await q('SELECT count(*) n FROM hon.school_calls WHERE staff_principal_id=$1 AND direction=$2 AND created_at>now()-interval \'1 hour\'', [coach2.principal, 'OUT']);
    if (Number(n[0].n) >= 60) break;
    await start(coach2, { toE164: '+1512555' + String(2000 + i) });
  }
  await rejects('54000', () => start(coach2, { toE164: '+15125553999' }), '61st call in an hour');
  pass('at most 60 outgoing calls per staff member per hour');
  // 11. The canonical 011 section passes with the fixture's roles and catches an extra runtime or worker grant.
  {
    const verify = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
    const section = verify.split('-- School calls exact verification (0556)')[1]?.split('-- End school calls exact verification.')[0];
    assert(section, '011 section');
    const body = section.replace(/^[^\n]*\n[^\n]*\n/, '').replaceAll('hon_communication_worker', workerUrl.username).replaceAll('hon_runtime', runtime.username);
    await q(body);
    await q(`GRANT EXECUTE ON FUNCTION hon.expire_school_calls(uuid) TO ${runtime.username}`);
    await assert.rejects(q(body), /Unsafe school calls function: hon.expire_school_calls/);
    await q(`REVOKE EXECUTE ON FUNCTION hon.expire_school_calls(uuid) FROM ${runtime.username}`);
    await q(`GRANT EXECUTE ON FUNCTION hon.start_school_call(text,jsonb,text,uuid,uuid) TO ${workerUrl.username}`);
    await assert.rejects(q(body), /Unsafe school calls function: hon.start_school_call/);
    await q(`REVOKE EXECUTE ON FUNCTION hon.start_school_call(text,jsonb,text,uuid,uuid) FROM ${workerUrl.username}`);
    await q(body);
  }
  pass('the canonical 011 verification of the 0556 tables and functions passes and refuses an extra runtime or worker grant');
  console.log('PASS school calls proof: ' + groups + ' groups');
} finally {
  await Promise.allSettled([admin.end(), restricted.end(), worker.end()]);
}
