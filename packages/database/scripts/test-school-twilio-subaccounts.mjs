// 0351 per-school Twilio subaccounts (docs/architecture/SCHOOL_OWN_SENDERS.md §4, T1): worker-only claim/complete,
// one subaccount per school, claim lease and take-over, lost claims refused, SID unique across schools, a sender can
// point only at its own school's subaccount, reads return ACTIVE accounts only, and the runtime has no access.
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const { Client } = pg;
for (const key of ['DATABASE_URL', 'HON_RUNTIME_DATABASE_URL', 'HON_COMMUNICATION_WORKER_DATABASE_URL']) {
  if (!process.env[key]) throw new Error(`${key} is required for the school Twilio subaccount proof.`);
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
function check(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  passed += 1;
}
async function expectError(code, work, message) {
  try { await work(); } catch (error) {
    if (error?.code === code) { passed += 1; return; }
    throw new Error(`FAIL: ${message} (got ${error?.code ?? error?.message})`);
  }
  throw new Error(`FAIL: ${message} (no error)`);
}

const ids = Object.fromEntries(['org', 'schoolA', 'schoolB', 'schoolC', 'user', 'principal'].map((key) => [key, randomUUID()]));
const sealed = (n) => `v1.${'A'.repeat(16)}.${'B'.repeat(10 + n)}.${'C'.repeat(22)}`;
const acct = (c) => `AC${c.repeat(32)}`;
const service = (c) => `MG${c.repeat(32)}`;
const begin = async (school, lease = 60) => (await worker.query('SELECT * FROM hon.begin_school_twilio_account($1, $2)', [school, lease])).rows[0];
const complete = async (school, claim, sid, n = 1) =>
  (await worker.query('SELECT * FROM hon.complete_school_twilio_account($1, $2, $3, $4, $5)', [school, claim, sid, sealed(n), 'staging-1'])).rows[0];

async function cleanup() {
  await admin.query('BEGIN');
  try {
    await admin.query('DELETE FROM hon.audit_events WHERE organization_id = $1', [ids.org]);
    await admin.query('DELETE FROM hon.school_text_senders WHERE organization_id = $1', [ids.org]);
    await admin.query('DELETE FROM hon.school_twilio_accounts WHERE organization_id = $1', [ids.org]);
    await admin.query('DELETE FROM hon.principals WHERE id = $1', [ids.principal]);
    await admin.query('DELETE FROM hon.users WHERE id = $1', [ids.user]);
    await admin.query('DELETE FROM hon.schools WHERE organization_id = $1', [ids.org]);
    await admin.query('DELETE FROM hon.organizations WHERE id = $1', [ids.org]);
    await admin.query('COMMIT');
  } catch (error) { await admin.query('ROLLBACK'); throw error; }
}

await Promise.all([admin.connect(), runtime.connect(), worker.connect()]);
try {
  await admin.query("INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, 'Twilio Org', 'Twilio Org')", [ids.org]);
  await admin.query("INSERT INTO hon.schools (id, organization_id, name, slug, timezone) VALUES ($1,$2,'A',$3,'UTC'), ($4,$2,'B',$5,'UTC'), ($6,$2,'C',$7,'UTC')",
    [ids.schoolA, ids.org, `a-${ids.schoolA.slice(0, 8)}`, ids.schoolB, `b-${ids.schoolB.slice(0, 8)}`, ids.schoolC, `c-${ids.schoolC.slice(0, 8)}`]);
  await admin.query("INSERT INTO hon.users (id, external_subject, email, display_name) VALUES ($1, $2, 'hq@example.test', 'HQ')", [ids.user, `twilio-${ids.user}`]);
  await admin.query("INSERT INTO hon.principals (id, principal_type, user_id, display_name) VALUES ($1, 'HUMAN_USER', $2, 'HQ')", [ids.principal, ids.user]);

  // 1. Role boundaries: the runtime has no table or function access; the worker has functions only.
  await expectError('42501', () => runtime.query('SELECT count(*) FROM hon.school_twilio_accounts'), 'runtime cannot read subaccounts');
  await expectError('42501', () => runtime.query('SELECT * FROM hon.begin_school_twilio_account($1, 60)', [ids.schoolA]), 'runtime cannot claim a subaccount');
  await expectError('42501', () => runtime.query('SELECT * FROM hon.read_twilio_webhook_account($1)', [acct('a')]), 'runtime cannot read a sealed token');
  await expectError('42501', () => runtime.query('SELECT * FROM hon.read_twilio_send_account($1)', [service('a')]), 'runtime cannot read send accounts');
  await expectError('42501', () => runtime.query('SELECT hon.twilio_number_in_account($1, $2)', [acct('a'), '+15555559001']), 'runtime cannot check numbers');
  await expectError('42501', () => worker.query('SELECT count(*) FROM hon.school_twilio_accounts'), 'worker cannot read the table directly');
  await expectError('42501', () => worker.query('INSERT INTO hon.school_twilio_accounts (organization_id, school_id, status, claim_token, claim_expires_at) VALUES ($1,$2,$3,$4, now())',
    [ids.org, ids.schoolA, 'PENDING', randomUUID()]), 'worker cannot write the table directly');

  // 2. Claim, take-over and completion.
  await expectError('22023', () => begin(ids.schoolA, 5), 'a lease outside 30-900 seconds is refused');
  await expectError('P0002', () => begin(randomUUID()), 'an unknown school is refused');
  const first = await begin(ids.schoolA);
  check(first.state === 'CLAIMED' && first.claim_token && first.account_sid === null, 'the first claim is CLAIMED with a token');
  check((await begin(ids.schoolA)).state === 'BUSY', 'a second worker sees BUSY while the claim is live');
  await admin.query("UPDATE hon.school_twilio_accounts SET claim_expires_at = now() - interval '1 second' WHERE school_id = $1", [ids.schoolA]);
  const second = await begin(ids.schoolA);
  check(second.state === 'CLAIMED' && second.claim_token !== first.claim_token, 'an expired claim is taken over with a new token');
  await expectError('40001', () => complete(ids.schoolA, first.claim_token, acct('a')), 'the old worker cannot complete after a take-over');
  await expectError('40001', () => complete(ids.schoolA, randomUUID(), acct('a')), 'a made-up claim is refused');
  await expectError('22023', () => complete(ids.schoolA, second.claim_token, 'AC1'), 'a malformed SID is refused');
  check((await complete(ids.schoolA, second.claim_token, acct('a'))).account_sid === acct('a'), 'the live claim completes');
  const again = await begin(ids.schoolA);
  check(again.state === 'ACTIVE' && again.account_sid === acct('a'), 'an ACTIVE subaccount is returned, never a new claim');
  await expectError('40001', () => complete(ids.schoolA, second.claim_token, acct('d')), 'an ACTIVE subaccount cannot be replaced');
  check((await admin.query("SELECT count(*)::int AS n FROM hon.audit_events WHERE organization_id = $1 AND action_code = 'communication.twilio_account.created'", [ids.org])).rows[0].n === 1,
    'creation is audited once');
  check((await admin.query('SELECT next_state FROM hon.audit_events WHERE organization_id = $1 AND action_code = $2', [ids.org, 'communication.twilio_account.created'])).rows[0].next_state.sealedAuthToken === undefined,
    'the audit record holds no token');

  // 3. One SID per school; a SID cannot be recorded for two schools.
  const b = await begin(ids.schoolB);
  await expectError('23505', () => complete(ids.schoolB, b.claim_token, acct('a')), "school B cannot record school A's subaccount");
  await complete(ids.schoolB, b.claim_token, acct('b'), 2);

  // 4. Inactive schools get no subaccount.
  await admin.query("UPDATE hon.schools SET status = 'SUSPENDED' WHERE id = $1", [ids.schoolC]).catch(async () => {
    await admin.query("UPDATE hon.schools SET status = 'INACTIVE' WHERE id = $1", [ids.schoolC]);
  });
  await expectError('55000', () => begin(ids.schoolC), 'a school that is not ACTIVE cannot start a subaccount');

  // 5. Senders point only at their own school's subaccount.
  await admin.query(`INSERT INTO hon.school_text_senders (organization_id, school_id, phone_e164, messaging_service_sid, status, mms_converter_confirmed, set_by_principal_id, twilio_account_sid)
    VALUES ($1,$2,'+15555559001',$3,'ACTIVE',true,$4,$5)`, [ids.org, ids.schoolA, service('a'), ids.principal, acct('a')]);
  await expectError('23503', () => admin.query(`INSERT INTO hon.school_text_senders (organization_id, school_id, phone_e164, messaging_service_sid, status, mms_converter_confirmed, set_by_principal_id, twilio_account_sid)
    VALUES ($1,$2,'+15555559002',$3,'ACTIVE',true,$4,$5)`, [ids.org, ids.schoolB, service('b'), ids.principal, acct('a')]), "school B's sender cannot name school A's subaccount");
  await admin.query(`INSERT INTO hon.school_text_senders (organization_id, school_id, phone_e164, messaging_service_sid, status, mms_converter_confirmed, set_by_principal_id)
    VALUES ($1,$2,'+15555559002',$3,'ACTIVE',true,$4)`, [ids.org, ids.schoolB, service('b'), ids.principal]);

  // 6. Reads.
  const hook = (await worker.query('SELECT * FROM hon.read_twilio_webhook_account($1)', [acct('a')])).rows;
  check(hook.length === 1 && hook[0].school_id === ids.schoolA && hook[0].sealed_auth_token === sealed(1) && hook[0].vault_key_id === 'staging-1', 'webhook read returns the sealed token for the ACTIVE subaccount');
  check((await worker.query('SELECT * FROM hon.read_twilio_webhook_account($1)', [acct('e')])).rows.length === 0, 'an unknown SID returns nothing');
  const send = (await worker.query('SELECT * FROM hon.read_twilio_send_account($1)', [service('a')])).rows;
  check(send.length === 1 && send[0].account_sid === acct('a') && send[0].account_status === 'ACTIVE', 'a subaccount service sends on its subaccount');
  check((await worker.query('SELECT * FROM hon.read_twilio_send_account($1)', [service('b')])).rows.length === 0, 'a parent-account (0248 hand-entered) service has no subaccount');
  const owns = async (sid, phone) => (await worker.query('SELECT hon.twilio_number_in_account($1, $2) AS owned', [sid, phone])).rows[0].owned;
  check(await owns(acct('a'), '+15555559001') === true, "school A's number is in school A's subaccount");
  check(await owns(acct('a'), '+15555559002') === false, "school B's number is not in school A's subaccount");
  check(await owns(acct('b'), '+15555559002') === false, 'a parent-account number is not in any subaccount');
  await admin.query("UPDATE hon.school_text_senders SET status = 'DISABLED' WHERE school_id = $1", [ids.schoolA]);
  check(await owns(acct('a'), '+15555559001') === true, 'a disabled number still belongs to its subaccount (a STOP to it verifies)');

  // 7. A suspended subaccount: no webhook token, sends report SUSPENDED (the adapter refuses), numbers no longer verify.
  await admin.query("UPDATE hon.school_twilio_accounts SET status = 'SUSPENDED' WHERE school_id = $1", [ids.schoolA]);
  check((await worker.query('SELECT * FROM hon.read_twilio_webhook_account($1)', [acct('a')])).rows.length === 0, 'a suspended subaccount has no webhook token');
  check((await worker.query('SELECT * FROM hon.read_twilio_send_account($1)', [service('a')])).rows[0].account_status === 'SUSPENDED', 'send read reports SUSPENDED');
  check(await owns(acct('a'), '+15555559001') === false, 'numbers of a suspended subaccount do not verify');
  await expectError('55000', () => begin(ids.schoolA), 'a suspended subaccount is not re-created');

  // 8. Table shape: PENDING rows hold no SID or token; ACTIVE rows need both.
  await expectError('23514', () => admin.query("UPDATE hon.school_twilio_accounts SET sealed_auth_token = NULL WHERE school_id = $1", [ids.schoolB]), 'an ACTIVE subaccount must keep its sealed token');

  // 9. The deployment verifier's 0351 section (infra/postgres/011) passes here with this database's runtime role.
  {
    const verify = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
    const start = verify.indexOf('-- School Twilio subaccounts exact verification');
    const section = verify.slice(start, verify.indexOf('-- End school Twilio subaccounts exact verification', start));
    const role = (await runtime.query('SELECT current_user AS r')).rows[0].r;
    check(start >= 0 && section.includes('DO $$'), 'the 011 section exists');
    await admin.query(section.replaceAll('hon_runtime', role));
    passed += 1;
  }

  console.log(`PASS: school Twilio subaccounts (${passed} checks).`);
} finally {
  await cleanup();
  await Promise.all([admin.end(), runtime.end(), worker.end()]);
}
