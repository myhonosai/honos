/** School voice apps (0561, CL2, docs/architecture/SCHOOL_CALLING.md §4) on the marked disposable communication delivery
 *  database: the worker claims and records each school's TwiML App and sealed API key on its own subaccount; staff get a
 *  phone-token decision from the runtime; the key is readable only by the worker. Nothing is created at Twilio. */
import assert from 'node:assert/strict';
import { randomUUID as K, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const C = createRequire(new URL('../../../apps/api/package.json', import.meta.url))('@hon/contracts');
const owner = new URL(process.env.DATABASE_URL ?? ''), runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? ''), workerUrl = new URL(process.env.HON_COMMUNICATION_WORKER_DATABASE_URL ?? '');
for (const u of [owner, runtime, workerUrl]) { assert.equal(u.hostname, 'localhost'); assert.equal(u.port, '5432'); assert.equal(u.pathname, '/hon_comm_delivery_validation'); }
const admin = new pg.Client({ connectionString: owner.toString(), ssl: false });
const restricted = new pg.Client({ connectionString: runtime.toString(), ssl: false });
const worker = new pg.Client({ connectionString: workerUrl.toString(), ssl: false });
let groups = 0;
const pass = (name) => console.log('PASS VOICE APPS ' + (++groups) + ' ' + name);
const q = async (sql, args = []) => (await admin.query(sql, args)).rows;
const hex = () => createHash('md5').update(K()).digest('hex');
const sealed = () => 'v1.' + 'A'.repeat(16) + '.' + 'B'.repeat(40) + '.' + 'C'.repeat(22);
const human = (label) => ({ externalSubject: 'oidc:voice:' + label + ':' + K(), email: label + '-' + K() + '@example.invalid' });
const rnd = () => '+1737' + String(2000000 + Math.floor(Math.random() * 7999999));
async function as(x, sql, args = []) {
  await restricted.query('BEGIN');
  try {
    for (const [k, v] of [['app.hon_external_subject', x.externalSubject], ['app.hon_principal_type', 'HUMAN_USER'], ['app.hon_source', 'HUMAN_UI'],
      ['app.hon_principal_id', x.principal], ['app.hon_organization_id', x.org], ['app.hon_school_id', x.school]]) await restricted.query('SELECT set_config($1,$2,true)', [k, v]);
    const rows = (await restricted.query(sql, args)).rows; await restricted.query('COMMIT'); return rows[0]?.data;
  } catch (error) { await restricted.query('ROLLBACK'); throw error; }
}
const w = async (sql, args = []) => (await worker.query(sql, args)).rows;
const begin = async (school, lease = 60) => (await w('SELECT * FROM hon.begin_school_voice_app($1,$2)', [school, lease]))[0];
const token = (x) => as(x, 'SELECT hon.authorize_school_phone_token($1) data', [x.externalSubject]);
let terms;
async function register(label) {
  const p = human(label);
  const r = (await restricted.query('SELECT hon.register_hon_os_school($1,$2,$3::jsonb,$4) data', [p.externalSubject, p.email,
    { ownerName: 'Synthetic ' + label, schoolName: 'Synthetic ' + label + ' Dojo', legalName: 'Synthetic ' + label + ' LLC', timezone: 'America/Chicago',
      termsVersionId: terms, confirmation: C.SIGNUP_CONFIRMATION }, K()])).rows[0].data;
  const principal = (await q('SELECT p.id FROM hon.users u JOIN hon.principals p ON p.user_id=u.id WHERE u.external_subject=$1', [p.externalSubject]))[0].id;
  await q("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=NULL WHERE organization_id=$1", [r.organizationId]);
  return { ...p, org: r.organizationId, school: r.schoolId, principal };
}
async function subaccount(x, number) {
  const account = 'AC' + hex();
  await q("INSERT INTO hon.school_twilio_accounts(organization_id,school_id,account_sid,status,sealed_auth_token,vault_key_id) VALUES($1,$2,$3,'ACTIVE',$4,'k1')", [x.org, x.school, account, sealed()]);
  await q("INSERT INTO hon.school_text_senders(organization_id,school_id,phone_e164,messaging_service_sid,status,mms_converter_confirmed,set_by_principal_id,twilio_account_sid) VALUES($1,$2,$3,$4,'ACTIVE',true,$5,$6)",
    [x.org, x.school, number, 'MG' + hex(), x.principal, account]);
  return account;
}
const callingOn = (x, on, version) => as(x, 'SELECT hon.set_school_calling_settings($1,$2::jsonb,$3,$4) data',
  [x.externalSubject, JSON.stringify({ callingOn: on, voicemailGreeting: null, recordingOn: false, recordingConsentAccepted: false, expectedVersion: version }), K(), K()]);

try {
  await Promise.all([admin.connect(), restricted.connect(), worker.connect()]);
  assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m, 'HON disposable communication delivery validation');
  // 1. Custody.
  const t = (await q("SELECT relrowsecurity rls,relforcerowsecurity forced FROM pg_class WHERE oid='hon.school_voice_apps'::regclass"))[0]; assert(t.rls && t.forced);
  for (const role of [runtime.username, workerUrl.username]) for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
    assert.equal((await q("SELECT has_table_privilege($1,'hon.school_voice_apps',$2) ok", [role, p]))[0].ok, false, role + p);
  const fns = { 'authorize_school_phone_token': 'runtime', 'read_schools_needing_voice_app': 'worker', 'begin_school_voice_app': 'worker',
    'record_school_voice_app_twiml': 'worker', 'complete_school_voice_app': 'worker', 'read_school_voice_app': 'worker', 'guard_school_voice_app': 'none' };
  for (const [name, who] of Object.entries(fns)) {
    const oid = (await q("SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname=$1", [name]))[0].oid;
    assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [runtime.username, oid]))[0].ok, who === 'runtime', 'runtime ' + name);
    assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [workerUrl.username, oid]))[0].ok, who === 'worker', 'worker ' + name);
  }
  pass('forced RLS, no table privilege; runtime runs only the phone-token decision, the worker only the claim, record and key reads');

  await q("UPDATE hon.hon_os_signup_program SET status='TEST_MODE',recorded_at=clock_timestamp() WHERE program_id=1");
  terms = (await q('SELECT id FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1'))[0].id;
  const a = await register('alpha'), b = await register('beta'), parentSchool = await register('parent');
  const accountA = await subaccount(a, rnd()); await subaccount(b, rnd());
  await q("INSERT INTO hon.school_text_senders(organization_id,school_id,phone_e164,messaging_service_sid,status,mms_converter_confirmed,set_by_principal_id) VALUES($1,$2,$3,$4,'ACTIVE',true,$5)",
    [parentSchool.org, parentSchool.school, rnd(), 'MG' + hex(), parentSchool.principal]);

  // 2. Eligibility: calling off, parent account, lapsed school.
  assert.equal((await begin(a.school)).state, 'INELIGIBLE', 'calling off');
  await callingOn(a, true, 0); await callingOn(parentSchool, true, 0);
  assert.equal((await begin(parentSchool.school)).state, 'INELIGIBLE', 'parent account school');
  await q("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [a.org]);
  assert.equal((await begin(a.school)).state, 'INELIGIBLE', 'lapsed');
  await q("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1", [a.org]);
  const due = (await w('SELECT * FROM hon.read_schools_needing_voice_app(50)')).map((r) => r.school_id);
  assert(due.includes(a.school)); assert(!due.includes(b.school)); assert(!due.includes(parentSchool.school));
  pass('only schools with calling on, an ACTIVE sender on an ACTIVE subaccount and live access need or get a voice app');

  // 3. Claim, record, complete.
  let tk = await token(a); assert.equal(tk.ready, false); assert.equal(tk.identity, 'u' + a.principal.replaceAll('-', ''));
  const c1 = await begin(a.school, 30);
  assert.equal(c1.state, 'CLAIMED'); assert.equal(c1.account_sid, accountA); assert.equal(c1.twiml_app_sid, null);
  assert.equal((await begin(a.school)).state, 'BUSY');
  const app = 'AP' + hex(), key = 'SK' + hex();
  assert.equal((await w('SELECT hon.record_school_voice_app_twiml($1,$2,$3) ok', [a.school, c1.claim_token, app]))[0].ok, true);
  await assert.rejects(w('SELECT hon.record_school_voice_app_twiml($1,$2,$3)', [a.school, K(), app]), /VOICE_APP_CLAIM_LOST/);
  // A claim that expired is taken over and keeps the TwiML App already made.
  await q('ALTER TABLE hon.school_voice_apps DISABLE TRIGGER guarded');
  await q("UPDATE hon.school_voice_apps SET claim_expires_at=clock_timestamp()-interval '1 second' WHERE school_id=$1", [a.school]);
  await q('ALTER TABLE hon.school_voice_apps ENABLE TRIGGER guarded');
  await assert.rejects(w('SELECT hon.complete_school_voice_app($1,$2,$3,$4,$5)', [a.school, c1.claim_token, key, sealed(), 'k1']), /VOICE_APP_CLAIM_LOST/);
  const c2 = await begin(a.school);
  assert.equal(c2.state, 'CLAIMED'); assert.equal(c2.twiml_app_sid, app, 'found, never made twice');
  assert.equal((await w('SELECT hon.record_school_voice_app_twiml($1,$2,$3) ok', [a.school, c2.claim_token, 'AP' + hex()]))[0].ok, false, 'a second app is not recorded');
  assert.equal((await w('SELECT hon.complete_school_voice_app($1,$2,$3,$4,$5) ok', [a.school, c2.claim_token, key, sealed(), 'k1']))[0].ok, true);
  assert.equal((await begin(a.school)).state, 'ACTIVE');
  pass('one claim at a time, an expired claim is taken over keeping the TwiML App found earlier, a lost claim cannot record');

  // 4. Phone token decision and key read.
  tk = await token(a); assert.equal(tk.ready, true); assert.equal(tk.incoming, false); assert.equal(tk.schoolId, a.school);
  assert.equal(JSON.stringify(tk).includes(key), false); assert.equal(JSON.stringify(tk).includes(accountA), false);
  await as(a, 'SELECT hon.set_my_school_call_ringing($1,$2::jsonb) data', [a.externalSubject, JSON.stringify({ ringMe: true })]);
  assert.equal((await token(a)).incoming, true);
  const keyRow = (await w('SELECT * FROM hon.read_school_voice_app($1)', [a.school]))[0];
  assert.equal(keyRow.api_key_sid, key); assert.equal(keyRow.twiml_app_sid, app); assert.equal(keyRow.account_sid, accountA);
  assert.equal((await w('SELECT * FROM hon.read_school_voice_app($1)', [b.school])).length, 0);
  await assert.rejects(as({ ...b, principal: a.principal, externalSubject: a.externalSubject }, 'SELECT hon.authorize_school_phone_token($1) data', [a.externalSubject]), /CALLING_FORBIDDEN/);
  const v = (await q('SELECT version FROM hon.school_calling_settings WHERE school_id=$1', [a.school]))[0].version;
  await callingOn(a, false, v);
  tk = await token(a); assert.equal(tk.ready, false); assert.equal(tk.incoming, false);
  await q("UPDATE hon.school_twilio_accounts SET status='SUSPENDED',version=version+1 WHERE school_id=$1", [a.school]);
  assert.equal((await w('SELECT * FROM hon.read_school_voice_app($1)', [a.school])).length, 0, 'suspended subaccount: no key');
  assert.equal((await q("SELECT count(*) n FROM hon.audit_events WHERE school_id=$1 AND action_code='communication.phone_token.issue'", [a.school]))[0].n, '4');
  pass('a token decision names the identity and never a key; ring only with Ring me; another school\'s session is refused; calling off or a suspended subaccount stops it; every decision audited');

  // 5. Immutability.
  await assert.rejects(q("UPDATE hon.school_voice_apps SET api_key_sid=$1,version=version+1 WHERE school_id=$2", ['SK' + hex(), a.school]), /SCHOOL_VOICE_APP_IMMUTABLE/);
  await assert.rejects(q('DELETE FROM hon.school_voice_apps WHERE school_id=$1', [a.school]), /SCHOOL_VOICE_APP_IMMUTABLE/);
  await q("UPDATE hon.school_voice_apps SET status='CLOSED',api_key_sid=NULL,sealed_api_secret=NULL,vault_key_id=NULL,version=version+1 WHERE school_id=$1", [a.school]);
  pass('an ACTIVE key never changes in place and no row is deleted; only CLOSED ends it');

  // 6. 011.
  const verify = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
  const section = verify.split('-- School voice apps exact verification (0561)')[1]?.split('-- End school voice apps exact verification.')[0];
  assert(section);
  const body = section.replace(/^[^\n]*\n[^\n]*\n/, '').replaceAll('hon_communication_worker', workerUrl.username).replaceAll('hon_runtime', runtime.username);
  await q(body);
  await q(`GRANT EXECUTE ON FUNCTION hon.read_school_voice_app(uuid) TO ${runtime.username}`);
  await assert.rejects(q(body), /Unsafe school voice apps function: hon.read_school_voice_app/);
  await q(`REVOKE EXECUTE ON FUNCTION hon.read_school_voice_app(uuid) FROM ${runtime.username}`);
  await q(body);
  pass('the canonical 011 section passes and refuses a runtime grant on the key read');
  console.log('PASS school voice apps proof: ' + groups + ' groups');
} finally { await Promise.allSettled([admin.end(), restricted.end(), worker.end()]); }
