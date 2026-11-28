// HQ email and text blasts HB1 (0712), TEST MODE, disposable database only (the 0243 communication delivery fixture).
// It proves: only the current HQ owner lists, counts, saves, sends and cancels blasts; the audience is resolved in the
// database with every filter (status, plan, founder, interval, free, trial, sign-up date, location, features, can get
// texts, picked and left-out schools), never archived schools; only current non-HQ owners are reached, email without an
// HQ email opt-out and texts only with the owner's own HQ texting opt-in; sending writes one QUEUED HQ message per school
// with the school and HQ names filled and one delivery per reachable owner due at the send time; the claim fills the
// owner's first name and returns the subject and blast; BILLING/ACCOUNT are never blast purposes and blasts never pass an
// opt-out; RECENTLY_SENT, caps and daily limit; cancel before any delivery leaves PENDING; exact-request idempotency;
// ANNOUNCEMENT is the HQ owner's only (operators unchanged, one-off messages refuse it); append-only evidence; the runtime
// and the worker each run only their own functions and no table.
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const { Client } = pg;
for (const key of ['DATABASE_URL', 'HON_RUNTIME_DATABASE_URL', 'HON_COMMUNICATION_WORKER_DATABASE_URL']) {
  if (!process.env[key]) throw new Error(`${key} is required for HQ blast tests.`);
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
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); passed += 1; };
const ok = (condition, message) => { assert.ok(condition, message); passed += 1; };
async function refuse(code, work, message, text) {
  try { await work(); } catch (error) {
    assert.equal(error?.code, code, `${message}: ${error?.message}`);
    if (text) assert.equal(error?.message, text, message);
    passed += 1; return;
  }
  assert.fail(`${message}: expected ${code}`);
}
const K = () => randomUUID();
const orgs = { A: randomUUID(), B: randomUUID(), C: randomUUID(), D: randomUUID(), E: randomUUID() };
const sch = { A: randomUUID(), B: randomUUID(), C: randomUUID(), D: randomUUID(), E: randomUUID() };
const roles = Object.fromEntries(Object.keys(orgs).map((k) => [k, randomUUID()]));
const humans = Object.fromEntries(['hqOwner', 'supportOp', 'marketingOp', 'ownerA', 'ownerA2', 'ownerB', 'ownerC', 'ownerE']
  .map((k) => [k, { id: randomUUID(), user: randomUUID(), subject: `hqblast-${k}-${randomUUID()}`, email: `${k}-${randomUUID().slice(0, 8)}@example.test` }]));
const H = (k) => humans[k].subject, P = (k) => humans[k].id;
const SID = 'MG' + 'fedcba9876543210'.repeat(2);
const PHONE_B = '+15550120001';

const one = async (client, sql, params) => (await client.query(sql, params)).rows[0];
const call = async (fn, args, types) => (await one(runtime, `SELECT hon.${fn}(${args.map((_, i) => `$${i + 1}${types?.[i] ?? ''}`).join(',')}) AS d`, args)).d;
const CMD = ['', '::jsonb', '::uuid', '::uuid', '::uuid'];
const save = (who, input, key = K()) => call('save_hq_blast', [H(who), JSON.stringify(input), key, K(), K()], CMD);
const send = (who, input, key = K()) => call('send_hq_blast', [H(who), JSON.stringify(input), key, K(), K()], CMD);
const cancel = (who, input, key = K()) => call('cancel_hq_blast', [H(who), JSON.stringify(input), key, K(), K()], CMD);
const audience = (who, id) => call('read_hq_blast_audience', [H(who), id], ['', '::uuid']);
const draft = (over = {}) => ({ blastId: null, expectedVersion: 0, name: 'Spring news', channel: 'EMAIL', purpose: 'ANNOUNCEMENT',
  subject: 'News for {{school_name}}', body: 'Hi {{first_name}}, {{school_name}} gets new features. From {{hq_name}}.', audience: {}, ...over });
// Counts only for this proof's schools (other fixtures may hold schools too).
const mine = (view) => view.schools.filter((s) => Object.values(sch).includes(s.schoolId));
async function countFor(audienceJson, channel = 'EMAIL') {
  const saved = await save('hqOwner', draft({ audience: audienceJson, channel, subject: channel === 'EMAIL' ? 'Hello' : null }));
  const view = await audience('hqOwner', saved.blast.blastId);
  return Object.fromEntries(mine(view).map((s) => [Object.keys(sch).find((k) => sch[k] === s.schoolId), s.outcome]));
}

const tables = ['hq_blast_template_events', 'hq_blast_template_requests', 'hq_blast_templates', 'hq_blast_outbox', 'hq_blast_events', 'hq_blast_requests', 'hq_blast_schools', 'hq_inbound_replies', 'hq_inbound_texts',
  'hq_contact_requests', 'hq_contact_phones', 'hq_message_delivery_events', 'hq_message_deliveries', 'hq_messages', 'hq_blasts',
  'hq_communication_requests', 'hq_communication_senders', 'hq_contact_preferences'];
async function cleanup() {
  await admin.query('ROLLBACK').catch(() => {});
  await admin.query('BEGIN');
  try {
    for (const t of tables) await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
    for (const t of tables) await admin.query(`DELETE FROM hon.${t}`);
    for (const t of tables) await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
    const os = Object.values(orgs);
    await admin.query('DELETE FROM hon.audit_events WHERE organization_id=ANY($1::uuid[])', [os]);
    await admin.query('ALTER TABLE hon.school_locations DISABLE TRIGGER USER');
    await admin.query('DELETE FROM hon.school_locations WHERE organization_id=ANY($1::uuid[])', [os]);
    await admin.query('ALTER TABLE hon.school_locations ENABLE TRIGGER USER');
    await admin.query('ALTER TABLE hon.hq_school_plan_assignments DISABLE TRIGGER USER');
    await admin.query('DELETE FROM hon.hq_school_plan_assignments WHERE organization_id=ANY($1::uuid[])', [os]);
    await admin.query('ALTER TABLE hon.hq_school_plan_assignments ENABLE TRIGGER USER');
    for (const t of ['principal_role_grants', 'roles', 'schools']) await admin.query(`DELETE FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`, [os]);
    await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])', [os]);
    const ps = Object.values(humans).map((h) => h.id), us = Object.values(humans).map((h) => h.user);
    await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=ANY($1::uuid[])', [ps]);
    await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])', [ps]);
    await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])', [us]);
    await admin.query('COMMIT');
  } catch (error) { await admin.query('ROLLBACK'); throw error; }
}
async function daytimeZone() {
  for (const zone of ['UTC', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'Asia/Kolkata', 'Europe/Berlin', 'Pacific/Auckland', 'America/Sao_Paulo']) {
    const hour = Number((await one(admin, 'SELECT extract(hour FROM now() AT TIME ZONE $1) h', [zone])).h);
    if (hour >= 9 && hour < 20) return zone;
  }
  throw new Error('No daytime zone found.');
}

await Promise.all([admin.connect(), runtime.connect(), worker.connect()]);
try {
  // ---------- 0. posture ----------
  const has = async (client, sig) => (await one(client, "SELECT has_function_privilege(current_user,$1,'EXECUTE') a", ['hon.' + sig])).a;
  const entry = ['save_hq_blast(text,jsonb,uuid,uuid,uuid)', 'send_hq_blast(text,jsonb,uuid,uuid,uuid)', 'cancel_hq_blast(text,jsonb,uuid,uuid,uuid)',
    'read_hq_blasts(text)', 'read_hq_blast(text,uuid)', 'read_hq_blast_audience(text,uuid)', 'read_hq_blast_options(text,text)',
    'save_hq_blast_template(text,jsonb,uuid,uuid,uuid)', 'read_hq_blast_templates(text)'];
  for (const sig of entry) {
    eq(await has(runtime, sig), true, `runtime runs ${sig}`);
    eq(await has(worker, sig), false, `worker cannot run ${sig}`);
    eq((await one(admin, "SELECT has_function_privilege('public',$1,'EXECUTE') a", ['hon.' + sig])).a, false, `PUBLIC cannot run ${sig}`);
  }
  for (const sig of ['hq_blast_resolve(jsonb,text)', 'hq_blast_json(hon.hq_blasts)', 'hq_blast_results_json(uuid)', 'hq_communication_purposes(uuid)', 'hq_blast_template_json(hon.hq_blast_templates)',
    'hq_blast_record(uuid,uuid,uuid,uuid,text,text,text,hon.hq_blasts,jsonb,timestamptz)']) {
    eq(await has(runtime, sig), false, `runtime cannot run internal ${sig}`);
  }
  eq(await has(worker, 'claim_hq_message_deliveries(text[],integer,integer)'), true, 'worker still claims after the claim is replaced');
  eq(await has(runtime, 'claim_hq_message_deliveries(text[],integer,integer)'), false, 'runtime cannot claim');
  for (const t of ['hq_blasts', 'hq_blast_schools', 'hq_blast_requests', 'hq_blast_events', 'hq_blast_outbox', 'hq_blast_templates',
    'hq_blast_template_requests', 'hq_blast_template_events']) {
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      eq((await one(runtime, 'SELECT has_table_privilege(current_user,$1,$2) a', ['hon.' + t, priv])).a, false, `runtime ${t} ${priv}`);
    }
    eq(await one(admin, 'SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE oid=$1::regclass', ['hon.' + t]), { r: true, f: true }, `${t} forced RLS`);
  }
  // The canonical 011 block (run with this fixture's role names) passes, and refuses a runtime grant on the claim.
  const canonical = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
  const block = canonical.split('-- HQ blasts exact verification (0712)')[1]?.split('-- End HQ blasts exact verification.')[0]
    ?.replace(/^[^\n]*\n[^\n]*\n/, '');
  if (!block) throw new Error('Missing canonical 0712 verification.');
  const runtimeRole = (await one(runtime, 'SELECT current_user r')).r, workerRole = (await one(worker, 'SELECT current_user r')).r;
  const fixtureBlock = block.replaceAll("'hon_runtime'", `'${runtimeRole}'`).replaceAll("'hon_communication_worker'", `'${workerRole}'`);
  await admin.query(fixtureBlock); eq(true, true, 'canonical 011 block passes');
  for (const bad of [`GRANT EXECUTE ON FUNCTION hon.claim_hq_message_deliveries(text[],integer,integer) TO ${runtimeRole}`,
    `GRANT SELECT ON hon.hq_blasts TO ${runtimeRole}`, `GRANT EXECUTE ON FUNCTION hon.hq_blast_resolve(jsonb,text) TO ${runtimeRole}`]) {
    await admin.query('BEGIN');
    try { await admin.query(bad); await assert.rejects(admin.query(fixtureBlock), /HQ blast/); eq(true, true, `canonical block refuses: ${bad.split(' TO ')[0]}`); }
    finally { await admin.query('ROLLBACK'); }
  }
  await cleanup();

  // ---------- fixture ----------
  const zone = await daytimeZone();
  await admin.query('BEGIN');
  for (const [k, h] of Object.entries(humans)) {
    const name = { ownerA: 'Avery Stone', ownerA2: 'Ari', ownerB: 'Blake Park', ownerC: 'Casey', ownerE: '' }[k] ?? 'Fixture person';
    await admin.query('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)', [h.user, h.subject, h.email, name]);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','Fixture person',true)", [h.id, h.user]);
  }
  await admin.query("UPDATE hon.users SET display_name='Dana HQ' WHERE id=$1", [humans.hqOwner.user]);
  const grant = "INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')";
  await admin.query(grant, [P('hqOwner'), 'HON_HQ_OWNER', '{}']);
  await admin.query(grant, [P('supportOp'), 'HON_HQ_SUPPORT', '{hq.support.manage,hq.onboarding.manage}']);
  await admin.query(grant, [P('marketingOp'), 'HON_HQ_OPERATOR', '{hq.marketing.manage}']);
  const schoolRows = [
    ['A', 'Alpha Dojo', 'ACTIVE', '3 days'], ['B', 'Bravo Martial Arts', 'SUSPENDED', '100 days'], ['C', 'Charlie Karate', 'ACTIVE', '40 days'],
    ['D', 'Delta Taekwondo', 'ARCHIVED', '10 days'], ['E', 'Echo Jiu Jitsu', 'ACTIVE', '20 days']];
  for (const [k, name, status, age] of schoolRows) {
    await admin.query(`INSERT INTO hon.organizations(id,legal_name,display_name,status,created_at) VALUES($1,$2,$2,'ACTIVE',clock_timestamp())`, [orgs[k], `${name} LLC`]);
    await admin.query(`INSERT INTO hon.schools(id,organization_id,name,slug,timezone,status,created_at) VALUES($1::uuid,$2,$3,$1::text,$4,$5,clock_timestamp()-$6::interval)`,
      [sch[k], orgs[k], name, zone, status, age]);
    await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','School Owner',true)", [roles[k], orgs[k]]);
  }
  for (const [who, k] of [['ownerA', 'A'], ['ownerA2', 'A'], ['ownerB', 'B'], ['ownerC', 'C'], ['ownerE', 'D'], ['ownerE', 'E']]) {
    await admin.query(`INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from)
      VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')`, [orgs[k], sch[k], P(who), roles[k]]);
  }
  // E's owner grant ends: Echo has no current owner.
  await admin.query("UPDATE hon.principal_role_grants SET effective_until=clock_timestamp() WHERE school_id=$1", [sch.E]);
  // Locations: Alpha in San Diego CA, Bravo in Austin TX, Charlie in Toronto ON.
  for (const [k, c, r, city] of [['A', 'US', 'CA', 'San Diego'], ['B', 'US', 'TX', 'Austin'], ['C', 'CA', 'ON', 'Toronto']]) {
    await admin.query(`INSERT INTO hon.school_locations(school_id,organization_id,country_code,region_code,city,created_by_principal_id,updated_by_principal_id)
      VALUES($1,$2,$3,$4,$5,$6,$6)`, [sch[k], orgs[k], c, r, city, P('hqOwner')]);
  }
  // Plans: Alpha on a paid monthly custom plan, Charlie on a free annual custom plan; Bravo has none.
  for (const [k, name, interval, price] of [['A', 'Gold Custom', 'MONTHLY', 14900], ['C', 'Free Partner', 'ANNUAL', 0]]) {
    await admin.query(`INSERT INTO hon.hq_school_plan_assignments(organization_id,revision,school_id,action,source,plan_name,billing_interval,price_minor,
      currency,founder,actor_principal_id,recorded_at,start_date) VALUES($1,1,$2,'ASSIGN','CUSTOM',$3,$4,$5,'USD',false,$6,clock_timestamp(),current_date)`,
      [orgs[k], sch[k], name, interval, price, P('hqOwner')]);
  }
  // Charlie's owner opted out of HQ email.
  await admin.query("INSERT INTO hon.hq_contact_preferences(user_id,channel,status,source,captured_at) VALUES($1,'EMAIL','OPTED_OUT','RECIPIENT',clock_timestamp())", [humans.ownerC.user]);
  // Alpha's second owner too: Alpha still reaches one owner by email.
  await admin.query("INSERT INTO hon.hq_contact_preferences(user_id,channel,status,source,captured_at) VALUES($1,'EMAIL','OPTED_OUT','RECIPIENT',clock_timestamp())", [humans.ownerA2.user]);
  await admin.query('COMMIT');
  await call('set_hq_communication_sender', [H('hqOwner'), JSON.stringify({ channel: 'SMS', emailFrom: null, emailDisplayName: null, smsServiceSid: SID,
    smsReplyNumber: '+15555550197', a2pState: 'REGISTERED_SERVICE', mmsConverterConfirmed: true }), K()], ['', '::jsonb', '::uuid']);
  // Bravo's owner confirms their phone by texting the code: HQ texts on.
  const started = await call('start_my_hq_phone', [H('ownerB'), JSON.stringify({ phone: PHONE_B, expectedVersion: 0 }), K()], ['', '::jsonb', '::uuid']);
  eq((await one(worker, 'SELECT * FROM hon.record_hq_inbound_text($1,$2,$3,$4,$5,$6)', ['FAKE', 'blast-ev-1', PHONE_B, SID, started.code, new Date().toISOString()])).outcome,
    'CONFIRMED', 'Bravo owner turns HQ texts on');

  // ---------- 1. who ----------
  await refuse('42501', () => save('supportOp', draft({ purpose: 'SUPPORT' })), 'an HQ support operator cannot save a blast');
  await refuse('42501', () => save('marketingOp', draft()), 'an HQ marketing operator cannot save a blast');
  await refuse('42501', () => save('ownerA', draft()), 'a school owner is not HQ');
  await refuse('42501', () => call('read_hq_blasts', [H('supportOp')]), 'operators cannot list blasts');
  await refuse('42501', () => call('read_hq_blast_options', [H('marketingOp'), null], ['', '::text']), 'operators cannot read options');
  // ANNOUNCEMENT is the HQ owner's only; operators keep their 0281 purposes.
  eq((await one(admin, 'SELECT hon.hq_communication_purposes($1) p', [P('hqOwner')])).p, ['ACCOUNT', 'ANNOUNCEMENT', 'BILLING', 'ONBOARDING', 'SUPPORT'], 'owner purposes');
  eq((await one(admin, 'SELECT hon.hq_communication_purposes($1) p', [P('supportOp')])).p, ['ACCOUNT', 'ONBOARDING', 'SUPPORT'], 'support purposes unchanged');
  eq((await one(admin, 'SELECT hon.hq_communication_purposes($1) p', [P('marketingOp')])).p, [], 'marketing operator gains no HQ messaging purpose');
  eq((await one(admin, 'SELECT hon.hq_communication_is_owner($1) a, hon.hq_communication_is_owner($2) b', [P('hqOwner'), P('supportOp')])), { a: true, b: false }, 'is_owner');
  await refuse('22023', () => call('create_hq_message', [H('hqOwner'), JSON.stringify({ organizationId: orgs.A, schoolId: sch.A, purpose: 'ANNOUNCEMENT',
    channel: 'EMAIL', content: 'Hi', supportCaseId: null }), K()], ['', '::jsonb', '::uuid']), 'a one-off HQ message cannot be an announcement');

  // ---------- 2. shape ----------
  for (const [bad, why] of [
    [{ purpose: 'BILLING' }, 'BILLING is never a blast purpose'], [{ purpose: 'ACCOUNT' }, 'ACCOUNT is never a blast purpose'],
    [{ body: 'Hi {{last_name}}' }, 'unknown merge tag'], [{ body: ' padded' }, 'untrimmed body'], [{ subject: null }, 'email needs a subject'],
    [{ channel: 'SMS' }, 'a text has no subject'], [{ body: 'x'.repeat(3501) }, 'email body at most 3,500'],
    [{ channel: 'SMS', subject: null, body: 'x'.repeat(1401) }, 'text body at most 1,400'],
    [{ audience: { statuses: ['ARCHIVED'] } }, 'archived is not a status choice'], [{ audience: { nope: true } }, 'unknown audience key'],
    [{ audience: { joinedWithinDays: 30, joinedFrom: '2026-01-01' } }, 'window and range together'],
    [{ audience: { joinedFrom: '2026-02-30' } }, 'impossible date'], [{ audience: { joinedFrom: '2026-05-02', joinedTo: '2026-05-01' } }, 'reversed range'],
    [{ audience: { trial: 'NEVER', trialEndsWithinDays: 7 } }, 'trial ending needs on-trial'], [{ audience: { featuresIncluded: ['made.up'] } }, 'unknown feature'],
    [{ audience: { schools: [] } }, 'empty pick list'], [{ audience: { schools: [sch.A, sch.A] } }, 'duplicate picks'],
    [{ audience: { noPlan: false } }, 'noPlan is only true'], [{ audience: { countries: ['usa'] } }, 'country code shape'],
    [{ expectedVersion: 1 }, 'a new blast starts at version 0']]) {
    await refuse('22023', () => save('hqOwner', draft(bad)), why);
  }

  // ---------- 3. filters ----------
  eq(await countFor({}), { A: 'QUEUED', B: 'QUEUED', C: 'NOT_REACHABLE', E: 'NO_OWNERS' }, 'everyone: archived Delta never; Charlie opted out; Echo has no owner');
  eq(await countFor({ statuses: ['PAUSED'] }), { B: 'QUEUED' }, 'paused only');
  eq(await countFor({ statuses: ['ACTIVE'] }), { A: 'QUEUED', C: 'NOT_REACHABLE', E: 'NO_OWNERS' }, 'active only');
  eq(await countFor({ planNames: ['gold custom'] }), { A: 'QUEUED' }, 'plan name, any case');
  eq(await countFor({ noPlan: true }), { B: 'QUEUED', E: 'NO_OWNERS' }, 'no plan');
  eq(await countFor({ planNames: ['Free Partner'], noPlan: true }), { B: 'QUEUED', C: 'NOT_REACHABLE', E: 'NO_OWNERS' }, 'plan name or no plan');
  eq(await countFor({ founder: false }), { A: 'QUEUED', C: 'NOT_REACHABLE' }, 'not founder (needs a plan)');
  eq(await countFor({ founder: true }), {}, 'founder');
  eq(await countFor({ billingIntervals: ['ANNUAL'] }), { C: 'NOT_REACHABLE' }, 'billing interval');
  eq(await countFor({ freePlan: true }), { C: 'NOT_REACHABLE' }, 'free plan');
  eq(await countFor({ freePlan: false }), { A: 'QUEUED' }, 'paid plan');
  eq(await countFor({ trial: 'NEVER' }), { A: 'QUEUED', B: 'QUEUED', C: 'NOT_REACHABLE', E: 'NO_OWNERS' }, 'never trialed');
  eq(await countFor({ trial: 'ON_TRIAL' }), {}, 'on trial');
  eq(await countFor({ trialEndsWithinDays: 14 }), {}, 'trial ending soon');
  eq(await countFor({ joinedWithinDays: 7 }), { A: 'QUEUED' }, 'joined within 7 days');
  eq(await countFor({ joinedWithinDays: 30 }), { A: 'QUEUED', E: 'NO_OWNERS' }, 'joined within 30 days');
  const day = async (n) => (await one(admin, "SELECT to_char((now() AT TIME ZONE 'UTC')::date - $1::integer,'YYYY-MM-DD') d", [n])).d;
  eq(await countFor({ joinedFrom: await day(45), joinedTo: await day(15) }), { C: 'NOT_REACHABLE', E: 'NO_OWNERS' }, 'joined date range');
  eq(await countFor({ countries: ['US'] }), { A: 'QUEUED', B: 'QUEUED' }, 'country');
  eq(await countFor({ regions: ['TX', 'ON'] }), { B: 'QUEUED', C: 'NOT_REACHABLE' }, 'state or region');
  eq(await countFor({ cities: ['san diego'] }), { A: 'QUEUED' }, 'city, any case');
  eq(await countFor({ countries: ['US'], cities: ['Toronto'] }), {}, 'filters AND together');
  eq(await countFor({ featuresIncluded: ['marketing.connections_reporting'] }), { A: 'QUEUED', B: 'QUEUED', C: 'NOT_REACHABLE', E: 'NO_OWNERS' },
    'custom and no plan include every feature');
  eq(await countFor({ featuresMissing: ['marketing.connections_reporting'] }), {}, 'none miss it');
  eq(await countFor({ canGetTexts: true }, 'SMS'), { B: 'QUEUED' }, 'only schools whose owner turned texts on');
  eq(await countFor({}, 'SMS'), { A: 'NOT_REACHABLE', B: 'QUEUED', C: 'NOT_REACHABLE', E: 'NO_OWNERS' }, 'texts need the owner\'s own opt-in');
  eq(await countFor({ statuses: ['PAUSED'], schools: [sch.A, sch.D] }), { A: 'QUEUED', B: 'QUEUED' }, 'picked schools join the matches; archived pick dropped');
  eq(await countFor({ excludeSchools: [sch.A] }), { B: 'QUEUED', C: 'NOT_REACHABLE', E: 'NO_OWNERS' }, 'left-out schools removed');
  eq(await countFor({ schools: [sch.A], excludeSchools: [sch.A] }, 'EMAIL'), { B: 'QUEUED', C: 'NOT_REACHABLE', E: 'NO_OWNERS' }, 'leave-out wins over a pick');
  eq(await countFor({ picksOnly: true, schools: [sch.A, sch.C] }), { A: 'QUEUED', C: 'NOT_REACHABLE' }, 'only the picked schools');
  eq(await countFor({ picksOnly: true, schools: [sch.D] }), {}, 'an archived pick is still dropped');
  for (const bad of [{ picksOnly: true }, { picksOnly: true, schools: [sch.A], countries: ['US'] }, { picksOnly: true, schools: [sch.A], excludeSchools: [sch.B] },
    { picksOnly: false, schools: [sch.A] }])
    await refuse('22023', () => save('hqOwner', draft({ audience: bad })), `picksOnly shape refused: ${JSON.stringify(bad).slice(0, 60)}`);

  // ---------- 4. preview ----------
  const b1 = await save('hqOwner', draft({ audience: { countries: ['US'] } }));
  eq([b1.blast.status, b1.blast.version, b1.replayed], ['DRAFT', 1, false], 'draft saved');
  const pv = await audience('hqOwner', b1.blast.blastId);
  eq([pv.schoolsReached, pv.ownersTotal, pv.ownersReached, pv.skipped.ownersNotReachable], [2, 3, 2, 1], 'counts: Alpha 1 of 2 owners, Bravo 1 of 1');
  eq(pv.sample, { schoolDisplayName: 'Alpha Dojo', subject: 'News for Alpha Dojo', body: 'Hi Alex, Alpha Dojo gets new features. From Dana HQ.' }, 'sample');
  ok(!JSON.stringify(pv).includes('example.test') && !JSON.stringify(pv).includes(PHONE_B), 'no address in the preview');

  // ---------- 5. edit and idempotency ----------
  const key = K();
  const edit = { ...draft({ audience: { countries: ['US'] } }), blastId: b1.blast.blastId, expectedVersion: 1, name: 'Spring news v2' };
  const e1 = await save('hqOwner', edit, key);
  eq([e1.blast.version, e1.blast.name, e1.replayed], [2, 'Spring news v2', false], 'edited by version');
  eq((await save('hqOwner', edit, key)).replayed, true, 'same key, same edit replays');
  await refuse('23505', () => save('hqOwner', { ...edit, name: 'Other' }, key), 'same key, other edit refused');
  await refuse('40001', () => save('hqOwner', { ...edit, name: 'Stale' }), 'stale version refused');

  // ---------- 6b. room for the longest names and the STOP line ----------
  const longSms = await save('hqOwner', draft({ name: 'Long text', channel: 'SMS', subject: null, body: '{{first_name}}'.repeat(100), audience: { schools: [sch.B], picksOnly: true } }));
  await refuse('23514', () => send('hqOwner', { blastId: longSms.blast.blastId, expectedVersion: 1, sendAt: null }), 'a text that could pass 1,600 with names and STOP',
    'HQ_BLAST_TEXT_TOO_LONG');
  const longSubject = await save('hqOwner', draft({ name: 'Long subject', subject: '{{first_name}}'.repeat(10), audience: { schools: [sch.A], picksOnly: true } }));
  await refuse('23514', () => send('hqOwner', { blastId: longSubject.blast.blastId, expectedVersion: 1, sendAt: null }), 'a subject that could pass 300 with names',
    'HQ_BLAST_TEXT_TOO_LONG');

  // ---------- 6. send ----------
  const sendAt = new Date(Date.now() + 2 * 3_600_000); sendAt.setMilliseconds(0);
  await refuse('23514', () => send('hqOwner', { blastId: b1.blast.blastId, expectedVersion: 2, sendAt: new Date(Date.now() + 61 * 86_400_000).toISOString() }),
    'at most 60 days ahead', 'HQ_BLAST_SEND_TIME');
  await refuse('42501', () => send('supportOp', { blastId: b1.blast.blastId, expectedVersion: 2, sendAt: null }), 'only the HQ owner sends');
  const sKey = K();
  const sent = await send('hqOwner', { blastId: b1.blast.blastId, expectedVersion: 2, sendAt: sendAt.toISOString() }, sKey);
  eq([sent.blast.status, sent.blast.schoolCount, sent.blast.recipientCount, sent.blast.sendAt], ['QUEUED', 2, 2, sendAt.toISOString()], 'queued for 2 schools, 2 owners');
  eq(sent.results.schools, { queued: 2, noOwners: 0, notReachable: 0, recentlySent: 0 }, 'school outcomes');
  eq((await send('hqOwner', { blastId: b1.blast.blastId, expectedVersion: 2, sendAt: sendAt.toISOString() }, sKey)).replayed, true, 'send replays');
  const msgs = (await admin.query('SELECT * FROM hon.hq_messages WHERE blast_id=$1 ORDER BY school_id', [b1.blast.blastId])).rows;
  const alpha = msgs.find((m) => m.school_id === sch.A);
  eq([msgs.length, alpha.status, alpha.purpose, alpha.subject, alpha.content, alpha.recipient_count],
    [2, 'QUEUED', 'ANNOUNCEMENT', 'News for Alpha Dojo', 'Hi {{first_name}}, Alpha Dojo gets new features. From Dana HQ.', 1], 'one queued HQ message per school, names filled');
  const dels = (await admin.query('SELECT d.* FROM hon.hq_message_deliveries d JOIN hon.hq_messages m ON m.id=d.message_id WHERE m.blast_id=$1', [b1.blast.blastId])).rows;
  eq(dels.map((d) => d.recipient_principal_id).sort(), [P('ownerA'), P('ownerB')].sort(), 'deliveries only to reachable owners');
  ok(dels.every((d) => d.status === 'PENDING' && Math.abs(new Date(d.next_attempt_at) - sendAt) < 1000), 'due at the send time');
  await refuse('23514', () => save('hqOwner', { ...edit, expectedVersion: 3 }), 'a queued blast cannot be edited', 'HQ_BLAST_NOT_DRAFT');
  await refuse('42501', () => admin.query("UPDATE hon.hq_blasts SET body='changed', version=version+1 WHERE id=$1", [b1.blast.blastId]), 'queued content immutable');
  eq((await call('read_hq_communications', [H('hqOwner'), sch.A, null, null, 50], ['', '::uuid', '::timestamptz', '::uuid', '::integer']))
    .messages.map((m) => [m.blastId, m.subject, m.purpose]), [[b1.blast.blastId, 'News for Alpha Dojo', 'ANNOUNCEMENT']], 'the blast message is in the school inbox for the HQ owner');
  eq((await call('read_hq_communications', [H('supportOp'), sch.A, null, null, 50], ['', '::uuid', '::timestamptz', '::uuid', '::integer'])).messages.length, 0,
    'an operator does not see announcements');

  // ---------- 7. cancel a scheduled blast ----------
  const cKey = K();
  const cancelled = await cancel('hqOwner', { blastId: b1.blast.blastId, expectedVersion: 3 }, cKey);
  eq([cancelled.blast.status, cancelled.results.deliveries.suppressed], ['CANCELLED', 2], 'cancelled; deliveries suppressed');
  eq((await cancel('hqOwner', { blastId: b1.blast.blastId, expectedVersion: 3 }, cKey)).replayed, true, 'cancel replays');
  eq((await admin.query('SELECT status FROM hon.hq_messages WHERE blast_id=$1', [b1.blast.blastId])).rows.map((r) => r.status), ['CANCELLED', 'CANCELLED'], 'messages cancelled');
  await refuse('23514', () => cancel('hqOwner', { blastId: b1.blast.blastId, expectedVersion: 4 }), 'cannot cancel twice', 'HQ_BLAST_NOT_CANCELLABLE');

  // ---------- 8. send now, claim fills the first name; recently sent ----------
  const b2 = await save('hqOwner', draft({ name: 'Now', audience: { schools: [sch.A] , statuses: ['ACTIVE'], cities: ['San Diego'] } }));
  const s2 = await send('hqOwner', { blastId: b2.blast.blastId, expectedVersion: 1, sendAt: null });
  eq(s2.blast.schoolCount, 1, 'sent now to Alpha');
  await call('set_hq_communication_sender', [H('hqOwner'), JSON.stringify({ channel: 'EMAIL', emailFrom: 'hq@example.test', emailDisplayName: 'HON OS',
    smsServiceSid: null, smsReplyNumber: null, a2pState: null, mmsConverterConfirmed: null }), K()], ['', '::jsonb', '::uuid']);
  const claimed = (await worker.query("SELECT * FROM hon.claim_hq_message_deliveries('{EMAIL}',100,60)")).rows;
  const mineClaim = claimed.filter((r) => r.blast_id === b2.blast.blastId);
  eq(mineClaim.map((r) => [r.recipient_address, r.subject, r.content, r.purpose]),
    [[humans.ownerA.email, 'News for Alpha Dojo', 'Hi Avery, Alpha Dojo gets new features. From Dana HQ.', 'ANNOUNCEMENT']], 'claim fills the first name');
  eq((await admin.query('SELECT content FROM hon.hq_messages WHERE blast_id=$1', [b2.blast.blastId])).rows[0].content.includes('{{first_name}}'), true,
    'the stored message keeps the tag (no name copied)');
  await refuse('23514', () => cancel('hqOwner', { blastId: b2.blast.blastId, expectedVersion: 2 }), 'a blast already handed over cannot be cancelled', 'HQ_BLAST_NOT_CANCELLABLE');
  eq(await countFor({ countries: ['US'] }), { A: 'RECENTLY_SENT', B: 'QUEUED' }, 'Alpha just got an email blast');
  eq(await countFor({ countries: ['US'] }, 'SMS'), { A: 'NOT_REACHABLE', B: 'QUEUED' }, 'the 24-hour rule is per channel');
  // A one-off support email to an opted-out owner is still suppressed; BILLING keeps passing the opt-out only outside blasts.
  const supportMsg = await call('create_hq_message', [H('supportOp'), JSON.stringify({ organizationId: orgs.C, schoolId: sch.C, purpose: 'SUPPORT', channel: 'EMAIL',
    content: 'Ticket update', supportCaseId: null }), K()], ['', '::jsonb', '::uuid']);
  await call('queue_hq_message', [H('supportOp'), supportMsg.message.messageId, JSON.stringify({ expectedVersion: 1 }), K()], ['', '::uuid', '::jsonb', '::uuid']);
  const billMsg = await call('create_hq_message', [H('hqOwner'), JSON.stringify({ organizationId: orgs.C, schoolId: sch.C, purpose: 'BILLING', channel: 'EMAIL',
    content: 'Invoice ready', supportCaseId: null }), K()], ['', '::jsonb', '::uuid']);
  await call('queue_hq_message', [H('hqOwner'), billMsg.message.messageId, JSON.stringify({ expectedVersion: 1 }), K()], ['', '::uuid', '::jsonb', '::uuid']);
  const c2 = (await worker.query("SELECT * FROM hon.claim_hq_message_deliveries('{EMAIL}',100,60)")).rows;
  eq(c2.filter((r) => r.message_id === billMsg.message.messageId).map((r) => [r.subject, r.blast_id]), [[null, null]], 'BILLING notice still passes an opt-out, no subject');
  eq((await one(admin, 'SELECT status, failure_code FROM hon.hq_message_deliveries WHERE message_id=$1', [supportMsg.message.messageId])),
    { status: 'SUPPRESSED', failure_code: 'CONSENT_MISSING' }, 'support email honors the opt-out');

  // ---------- 9. no recipients, daily limit ----------
  const b3 = await save('hqOwner', draft({ name: 'Nobody', audience: { statuses: ['ACTIVE'], cities: ['Toronto'] } }));
  await refuse('23514', () => send('hqOwner', { blastId: b3.blast.blastId, expectedVersion: 1, sendAt: null }), 'nobody reachable', 'HQ_BLAST_NO_RECIPIENTS');
  // Three handed over so far (b1, b2, plus none for b3). Fill the window to 10 with admin-made queued rows.
  await admin.query('ALTER TABLE hon.hq_blasts DISABLE TRIGGER USER');
  for (let i = 0; i < 8; i += 1) {
    await admin.query(`INSERT INTO hon.hq_blasts(name,channel,purpose,subject,body,audience,status,send_at,queued_at,queued_by,school_count,recipient_count,created_by,updated_by)
      VALUES('Filler','EMAIL','ANNOUNCEMENT','S','B','{}','QUEUED',now(),now(),$1,1,1,$1,$1)`, [P('hqOwner')]);
  }
  await admin.query('ALTER TABLE hon.hq_blasts ENABLE TRIGGER USER');
  const b4 = await save('hqOwner', draft({ name: 'Eleventh', channel: 'SMS', subject: null, body: 'Hi {{first_name}}', audience: { statuses: ['PAUSED'] } }));
  await refuse('23514', () => send('hqOwner', { blastId: b4.blast.blastId, expectedVersion: 1, sendAt: null }), '10 blasts in 24 hours', 'HQ_BLAST_DAILY_LIMIT');
  const list = await call('read_hq_blasts', [H('hqOwner')]);
  eq([list.sentToday, list.dailyLimit], [10, 10], 'list shows the daily count');
  const detail = await call('read_hq_blast', [H('hqOwner'), b2.blast.blastId], ['', '::uuid']);
  eq(detail.schools.map((s) => [s.schoolDisplayName, s.outcome, s.reachableCount]), [['Alpha Dojo', 'QUEUED', 1]], 'blast detail per school');
  const opts = await call('read_hq_blast_options', [H('hqOwner'), 'bra'], ['', '::text']);
  eq(opts.schools.map((s) => [s.schoolDisplayName, s.status]), [['Bravo Martial Arts', 'PAUSED']], 'school search');
  ok(opts.planNames.includes('Gold Custom') && opts.planNames.includes('Free Partner') && opts.countries.includes('CA'), 'plan and country choices');
  ok(!JSON.stringify(opts).includes('example.test'), 'no address in options');
  ok(Number.isInteger(opts.schoolCounts.active) && opts.schoolCounts.active >= 3 && opts.schoolCounts.paused >= 1
    && Object.keys(opts.schoolCounts).sort().join() === 'active,paused', 'school counts for the audience buttons');
  await refuse('22023', () => call('read_hq_blast_options', [H('hqOwner'), 'b'], ['', '::text']), 'search needs 2+ characters');

  // ---------- 9b. templates ----------
  const tsave = (who, input, key = K()) => call('save_hq_blast_template', [H(who), JSON.stringify(input), key, K(), K()], CMD);
  const tin = (over = {}) => ({ templateId: null, expectedVersion: 0, name: 'Monthly news', channel: 'EMAIL', subject: 'News for {{school_name}}',
    body: 'Hi {{first_name}}, here is the news.', archived: false, ...over });
  await refuse('42501', () => tsave('supportOp', tin()), 'operators cannot save templates');
  await refuse('42501', () => call('read_hq_blast_templates', [H('marketingOp')]), 'operators cannot read templates');
  for (const bad of [tin({ archived: true }), tin({ channel: 'SMS' }), tin({ body: 'Hi {{last_name}}' }), tin({ expectedVersion: 1 }), { ...tin(), purpose: 'ANNOUNCEMENT' }])
    await refuse('22023', () => tsave('hqOwner', bad), `template refused: ${JSON.stringify(bad).slice(0, 60)}`);
  const tKey = K();
  const t1 = await tsave('hqOwner', tin(), tKey);
  eq([t1.operation, t1.template.status, t1.template.version, t1.replayed], ['TEMPLATE_SAVE', 'ACTIVE', 1, false], 'template saved');
  eq((await tsave('hqOwner', tin(), tKey)).replayed, true, 'same key replays');
  await refuse('23505', () => tsave('hqOwner', tin({ name: 'Other' }), tKey), 'same key, other template refused');
  const t2 = await tsave('hqOwner', tin({ templateId: t1.template.templateId, expectedVersion: 1, channel: 'SMS', subject: null, body: 'Hi {{first_name}}!' }));
  eq([t2.template.channel, t2.template.subject, t2.template.version], ['SMS', null, 2], 'template edited');
  await refuse('40001', () => tsave('hqOwner', tin({ templateId: t1.template.templateId, expectedVersion: 1 })), 'stale template version');
  const t3 = await tsave('hqOwner', tin({ name: 'Second', channel: 'SMS', subject: null, body: 'Text news' }));
  let tl = await call('read_hq_blast_templates', [H('hqOwner')]);
  eq(tl.templates.map((t) => t.name), ['Second', 'Monthly news'], 'templates newest first');
  await refuse('22023', () => tsave('hqOwner', { ...tin({ templateId: t3.template.templateId, expectedVersion: 1, channel: 'SMS', subject: null, body: 'Changed' }), archived: true }),
    'archiving cannot change the text');
  const ar = await tsave('hqOwner', { ...tin({ templateId: t3.template.templateId, expectedVersion: 1, name: 'Second', channel: 'SMS', subject: null, body: 'Text news' }), archived: true });
  eq(ar.template.status, 'ARCHIVED', 'template archived');
  tl = await call('read_hq_blast_templates', [H('hqOwner')]);
  eq(tl.templates.map((t) => t.name), ['Monthly news'], 'archived templates are not listed');
  await refuse('P0002', () => tsave('hqOwner', tin({ templateId: t3.template.templateId, expectedVersion: 2, name: 'Back' })), 'an archived template stays archived');
  await refuse('42501', () => admin.query('DELETE FROM hon.hq_blast_templates WHERE id=$1', [t1.template.templateId]), 'templates cannot be deleted');
  for (const t of ['hq_blast_template_requests', 'hq_blast_template_events'])
    await refuse('42501', () => admin.query(`DELETE FROM hon.${t}`), `${t} cannot be deleted`);
  eq(Number((await one(admin, 'SELECT count(*) n FROM hon.hq_blast_template_events')).n), 4, 'one event per template change');

  // ---------- 10. append-only ----------
  for (const t of ['hq_blast_schools', 'hq_blast_requests', 'hq_blast_events', 'hq_blast_outbox']) {
    await refuse('42501', () => admin.query(`DELETE FROM hon.${t}`), `${t} cannot be deleted`);
    await refuse('42501', () => admin.query(`TRUNCATE hon.${t} CASCADE`), `${t} cannot be truncated`);
  }
  await refuse('42501', () => admin.query('DELETE FROM hon.hq_blasts WHERE id=$1', [b1.blast.blastId]), 'blasts cannot be deleted');
  const outbox = (await admin.query('SELECT payload FROM hon.hq_blast_outbox')).rows.map((r) => JSON.stringify(r.payload)).join('');
  ok(!outbox.includes('example.test') && !outbox.includes('Alpha Dojo') && !outbox.includes('features'), 'outbox holds ids and counts only');

  await cleanup();
  console.log(`PASS: HQ blasts (0712) integrity (${passed} checks).`);
} finally {
  await Promise.allSettled([admin.end(), runtime.end(), worker.end()]);
}
