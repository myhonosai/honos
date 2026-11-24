// HQ-COMM PR E1 (0283) HON prospects and their consent, TEST MODE, disposable database only (the 0243 communication
// delivery fixture). It proves: only an HQ owner or an HQ operator holding hq.marketing.manage reads or changes prospects
// (support, read-only marketing, school owners and unknown people are refused); one prospect per email and per phone;
// edits are version-checked and closed; archive and restore; consent is append-only per channel and purpose and tied to
// the exact address, so a changed address starts with none; HQ records only opt-outs and email service opt-ins, always
// with a note; replays return the saved answer; the runtime has no table access and runs only the five entry points.
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { Client } = pg;
for (const key of ['DATABASE_URL', 'HON_RUNTIME_DATABASE_URL', 'HON_COMMUNICATION_WORKER_DATABASE_URL']) {
  if (!process.env[key]) throw new Error(`${key} is required for HQ prospect tests.`);
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
    if (text) assert.equal(error.message, text, message);
    passed += 1; return;
  }
  assert.fail(`${message}: expected ${code}`);
}
const K = () => randomUUID();

const humans = Object.fromEntries(['hqOwner', 'marketer', 'reader', 'supportOp', 'schoolOwner']
  .map((k) => [k, { id: randomUUID(), user: randomUUID(), subject: `hqprospect-${k}-${randomUUID()}`, email: `${k}-${randomUUID().slice(0, 8)}@example.test` }]));
const H = (k) => humans[k].subject, P = (k) => humans[k].id;
const ORG = randomUUID(), S = randomUUID(), ROLE = randomUUID(), CAMPAIGN = randomUUID();
const one = async (client, sql, params) => (await client.query(sql, params)).rows[0];
const call = async (fn, args, types) => (await one(runtime, `SELECT hon.${fn}(${args.map((_, i) => `$${i + 1}${types?.[i] ?? ''}`).join(',')}) AS d`, args)).d;
const base = { fullName: 'Synthetic Prospect', schoolName: 'Synthetic Karate', email: 'prospect@example.test', phone: '+15550100101', campaignId: null };
const create = (who, input, key = K()) => call('create_hq_prospect', [H(who), JSON.stringify(input), key], ['', '::jsonb', '::uuid']);
const update = (who, id, input, key = K()) => call('update_hq_prospect', [H(who), id, JSON.stringify(input), key], ['', '::uuid', '::jsonb', '::uuid']);
const consent = (who, id, input, key = K()) => call('record_hq_prospect_consent', [H(who), id, JSON.stringify(input), key], ['', '::uuid', '::jsonb', '::uuid']);
const list = (who, status = null, campaign = null, at = null, cid = null, limit = 50) =>
  call('read_hq_prospects', [H(who), status, campaign, at, cid, limit], ['', '::text', '::uuid', '::timestamptz', '::uuid', '::integer']);
const detail = (who, id) => call('read_hq_prospect', [H(who), id], ['', '::uuid']);

const tables = ['hq_prospect_requests', 'hq_prospect_consents', 'hq_prospects'];
async function cleanup() {
  await admin.query('BEGIN');
  try {
    for (const t of tables) await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
    for (const t of tables) await admin.query(`DELETE FROM hon.${t}`);
    for (const t of tables) await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
    await admin.query('ALTER TABLE hon.hq_marketing_campaigns DISABLE TRIGGER USER');
    await admin.query('DELETE FROM hon.hq_marketing_campaigns WHERE id=$1', [CAMPAIGN]);
    await admin.query('ALTER TABLE hon.hq_marketing_campaigns ENABLE TRIGGER USER');
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
  // ---------- 0. posture ----------
  const has = async (client, sig) => (await one(client, "SELECT has_function_privilege(current_user,$1,'EXECUTE') a", ['hon.' + sig])).a;
  for (const sig of ['create_hq_prospect(text,jsonb,uuid)', 'update_hq_prospect(text,uuid,jsonb,uuid)', 'record_hq_prospect_consent(text,uuid,jsonb,uuid)',
    'read_hq_prospects(text,text,uuid,timestamptz,uuid,integer)', 'read_hq_prospect(text,uuid)']) {
    eq(await has(runtime, sig), true, `runtime runs ${sig}`); eq(await has(worker, sig), false, `worker cannot run ${sig}`);
  }
  for (const sig of ['hq_prospect_json(hon.hq_prospects)', 'hq_prospect_fields(jsonb)', 'hq_prospect_claim(uuid,uuid,text,text)'])
    eq(await has(runtime, sig), false, `runtime cannot run helper ${sig}`);
  for (const t of tables) {
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
      eq((await one(runtime, 'SELECT has_table_privilege(current_user,$1,$2) a', ['hon.' + t, priv])).a, false, `runtime ${t} ${priv}`);
    eq(await one(admin, 'SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE oid=$1::regclass', ['hon.' + t]), { r: true, f: true }, `${t} forced RLS`);
  }
  await cleanup();

  // ---------- fixture ----------
  await admin.query('BEGIN');
  for (const h of Object.values(humans)) {
    await admin.query('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)', [h.user, h.subject, h.email, 'Fixture person']);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','Fixture person',true)", [h.id, h.user]);
  }
  const grant = (who, role, perms) => admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",
    [P(who), role, perms]);
  await grant('hqOwner', 'HON_HQ_OWNER', '{}');
  await grant('marketer', 'HON_HQ_OPERATOR', '{hq.marketing.manage}');
  await grant('reader', 'HON_HQ_OPERATOR', '{hq.marketing.read}');
  await grant('supportOp', 'HON_HQ_SUPPORT', '{hq.support.manage}');
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name,status,created_at) VALUES($1,'HQPR Fixture Dojo','HQPR Fixture Dojo','ACTIVE',clock_timestamp())", [ORG]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'HQPR Main',$1::text,'UTC')", [S, ORG]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','School Owner',true)", [ROLE, ORG]);
  await admin.query(`INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from)
    VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')`, [ORG, S, P('schoolOwner'), ROLE]);
  await admin.query(`INSERT INTO hon.hq_marketing_campaigns(id,code,name,goal,audience,offer_label,channel,status,starts_on,ends_on,planned_budget_minor,created_by,created_at,updated_at)
    VALUES($1,'HQPR-SPRING','Spring schools','Fixture goal','NEW_SCHOOLS','Founder offer','EMAIL','ACTIVE',current_date,current_date+30,0,$2,clock_timestamp(),clock_timestamp())`, [CAMPAIGN, P('hqOwner')]);
  await admin.query('COMMIT');

  // ---------- 1. authority ----------
  for (const who of ['reader', 'supportOp', 'schoolOwner']) {
    await refuse('42501', () => create(who, { ...base, source: 'HQ_ENTERED' }), `${who} cannot add a prospect`);
    await refuse('42501', () => list(who), `${who} cannot read prospects (contact details)`);
  }
  await refuse('42501', () => call('read_hq_prospects', ['nobody-' + randomUUID(), null, null, null, null, 10], ['', '::text', '::uuid', '::timestamptz', '::uuid', '::integer']), 'unknown subject');

  // ---------- 2. create ----------
  await refuse('22023', () => create('marketer', { ...base, source: 'PUBLIC_SIGN_UP' }), 'HQ cannot claim a sign-up source');
  await refuse('22023', () => create('marketer', { ...base, email: null, phone: null, source: 'HQ_ENTERED' }), 'needs an email or phone');
  await refuse('22023', () => create('marketer', { ...base, email: 'Prospect@Example.test', source: 'HQ_ENTERED' }), 'email must be lower case');
  await refuse('22023', () => create('marketer', { ...base, phone: '5550100101', source: 'HQ_ENTERED' }), 'phone must be E.164');
  await refuse('22023', () => create('marketer', { ...base, fullName: ' Padded', source: 'HQ_ENTERED' }), 'name trimmed');
  await refuse('22023', () => create('marketer', { ...base, source: 'HQ_ENTERED', extra: 1 }), 'closed keys');
  await refuse('P0002', () => create('marketer', { ...base, campaignId: randomUUID(), source: 'HQ_ENTERED' }), 'unknown campaign');
  const key = K();
  const c1 = await create('marketer', { ...base, campaignId: CAMPAIGN, source: 'HQ_ENTERED' }, key);
  const p1 = c1.prospect;
  eq([c1.operation, c1.replayed, p1.status, p1.version, p1.email, p1.phone, p1.campaign.code, p1.createdBy.principalId], ['CREATE', false, 'ACTIVE', 1,
    base.email, base.phone, 'HQPR-SPRING', P('marketer')], 'prospect added with contact details for HQ marketing');
  eq(p1.consent, { EMAIL: { SERVICE: null, MARKETING: null }, SMS: { SERVICE: null, MARKETING: null } }, 'no consent yet');
  eq((await create('marketer', { ...base, campaignId: CAMPAIGN, source: 'HQ_ENTERED' }, key)).replayed, true, 'replay returns the saved answer');
  await refuse('23505', () => create('marketer', { ...base, fullName: 'Other', source: 'HQ_ENTERED' }, key), 'same key, different request', 'SAAS_KEY_REUSED');
  await refuse('23514', () => create('hqOwner', { ...base, phone: null, source: 'IMPORT' }), 'same email twice', 'HQ_PROSPECT_EXISTS');
  await refuse('23514', () => create('hqOwner', { ...base, email: null, source: 'IMPORT' }), 'same phone twice', 'HQ_PROSPECT_EXISTS');
  const p2 = (await create('hqOwner', { fullName: 'Second Prospect', schoolName: null, email: null, phone: '+15550100102', campaignId: null, source: 'IMPORT' })).prospect;
  eq([p2.source, p2.email, p2.schoolName], ['IMPORT', null, null], 'phone-only import');

  // ---------- 3. consent ----------
  const ask = (input) => ({ expectedVersion: 1, note: 'Asked by email about pricing.', ...input });
  for (const [channel, purpose] of [['EMAIL', 'MARKETING'], ['SMS', 'SERVICE'], ['SMS', 'MARKETING']])
    await refuse('23514', () => consent('marketer', p1.prospectId, ask({ channel, purpose, status: 'OPTED_IN' })), `HQ cannot opt someone in to ${channel} ${purpose}`, 'HQ_CONSENT_NOT_ALLOWED');
  await refuse('22023', () => consent('marketer', p1.prospectId, ask({ channel: 'EMAIL', purpose: 'SERVICE', status: 'OPTED_IN', note: 'x' })), 'a note is required');
  await refuse('40001', () => consent('marketer', p1.prospectId, ask({ channel: 'EMAIL', purpose: 'SERVICE', status: 'OPTED_IN', expectedVersion: 9 })), 'stale version');
  const in1 = await consent('marketer', p1.prospectId, ask({ channel: 'EMAIL', purpose: 'SERVICE', status: 'OPTED_IN' }));
  eq([in1.prospect.version, in1.prospect.consent.EMAIL.SERVICE.status, in1.prospect.consent.EMAIL.SERVICE.source], [2, 'OPTED_IN', 'HQ_RECORDED'], 'email service opt-in recorded');
  await refuse('23514', () => consent('marketer', p1.prospectId, ask({ channel: 'EMAIL', purpose: 'SERVICE', status: 'OPTED_IN', expectedVersion: 2 })), 'no change', 'HQ_CONSENT_NO_CHANGE');
  const out1 = await consent('hqOwner', p1.prospectId, ask({ channel: 'SMS', purpose: 'MARKETING', status: 'OPTED_OUT', expectedVersion: 2, note: 'Said on the phone: no texts.' }));
  eq(out1.prospect.consent.SMS.MARKETING.status, 'OPTED_OUT', 'any opt-out can be recorded');
  await refuse('23514', () => consent('hqOwner', p2.prospectId, ask({ channel: 'EMAIL', purpose: 'SERVICE', status: 'OPTED_IN' })), 'no email address', 'HQ_PROSPECT_NO_ADDRESS');
  await admin.query(`INSERT INTO hon.hq_prospect_consents(prospect_id,channel,purpose,status,source,address,disclosure_version,captured_at,recorded_at)
    VALUES($1,'SMS','MARKETING','OPTED_IN','SIGN_UP_FORM',$2,'signup-2026-11',clock_timestamp(),clock_timestamp())`, [p2.prospectId, '+15550100102']);
  eq((await detail('marketer', p2.prospectId)).prospect.consent.SMS.MARKETING, { status: 'OPTED_IN', source: 'SIGN_UP_FORM',
    capturedAt: (await detail('marketer', p2.prospectId)).prospect.consent.SMS.MARKETING.capturedAt }, 'a sign-up opt-in (with its disclosure) counts');
  await refuse('23514', () => admin.query(`INSERT INTO hon.hq_prospect_consents(prospect_id,channel,purpose,status,source,address,captured_at,recorded_at)
    VALUES($1,'SMS','MARKETING','OPTED_IN','SIGN_UP_FORM','+15550100102',clock_timestamp(),clock_timestamp())`, [p2.prospectId]), 'a sign-up opt-in needs its disclosure version');
  await refuse('23514', () => admin.query(`INSERT INTO hon.hq_prospect_consents(prospect_id,channel,purpose,status,source,address,note,recorded_by,captured_at,recorded_at)
    VALUES($1,'SMS','MARKETING','OPTED_IN','HQ_RECORDED','+15550100102','fixture note',$2,clock_timestamp(),clock_timestamp())`, [p2.prospectId, P('hqOwner')]),
    'even the table refuses an HQ-recorded texting opt-in');
  await refuse('23514', () => admin.query(`INSERT INTO hon.hq_prospect_consents(prospect_id,channel,purpose,status,source,address,recorded_by,captured_at,recorded_at)
    VALUES($1,'SMS','MARKETING','OPTED_OUT','RECIPIENT','+15550100102',$2,clock_timestamp(),clock_timestamp())`, [p2.prospectId, P('hqOwner')]),
    'only an HQ-recorded answer names who recorded it');
  await admin.query(`INSERT INTO hon.hq_prospect_consents(prospect_id,channel,purpose,status,source,address,captured_at,recorded_at)
    VALUES($1,'EMAIL','MARKETING','OPTED_OUT','RECIPIENT','gone@example.test',clock_timestamp(),clock_timestamp())`, [p2.prospectId]);
  eq((await detail('marketer', p2.prospectId)).consentHistory.find((h) => h.channel === 'EMAIL').current, false,
    'an answer for an address the prospect no longer has reads as not current (never null)');
  eq((await one(admin, "SELECT created_at = date_trunc('milliseconds', created_at) ok FROM hon.hq_prospects WHERE id=$1", [p2.prospectId])).ok, true,
    'created_at is stored at millisecond precision');
  await refuse('23514', () => admin.query(`INSERT INTO hon.hq_prospects(full_name,email,source,status,created_at,updated_at)
    VALUES('Fixture Signup','micro@example.test','PUBLIC_SIGN_UP','ACTIVE','2026-11-12T10:00:00.000001Z','2026-11-12T10:00:00.000001Z')`),
    'a sub-millisecond created_at is refused');

  // ---------- 4. update, address change, archive ----------
  const u = { fullName: 'Synthetic Prospect', schoolName: 'Synthetic Karate', email: 'prospect@example.test', phone: '+15550100101', campaignId: CAMPAIGN, status: 'ACTIVE' };
  await refuse('23514', () => update('marketer', p1.prospectId, { ...u, expectedVersion: 3 }), 'no change', 'HQ_PROSPECT_NO_CHANGE');
  await refuse('23514', () => update('marketer', p1.prospectId, { ...u, phone: '+15550100102', expectedVersion: 3 }), 'phone belongs to another prospect', 'HQ_PROSPECT_EXISTS');
  const moved = await update('marketer', p1.prospectId, { ...u, email: 'new-address@example.test', expectedVersion: 3 });
  eq([moved.prospect.version, moved.prospect.email, moved.prospect.consent.EMAIL.SERVICE, moved.prospect.consent.SMS.MARKETING.status], [4, 'new-address@example.test', null, 'OPTED_OUT'],
    'a changed email starts with no email consent; the unchanged phone keeps its answer');
  const hist = await detail('marketer', p1.prospectId);
  eq(hist.consentHistory.map((h) => [h.channel, h.status, h.current]), [['SMS', 'OPTED_OUT', true], ['EMAIL', 'OPTED_IN', false]], 'history keeps the old address answer, marked not current');
  const archived = await update('marketer', p1.prospectId, { ...u, email: 'new-address@example.test', status: 'ARCHIVED', expectedVersion: 4 });
  eq(archived.prospect.status, 'ARCHIVED', 'archived');
  await refuse('23514', () => update('marketer', p1.prospectId, { ...u, email: 'new-address@example.test', fullName: 'Renamed', status: 'ARCHIVED', expectedVersion: 5 }),
    'an archived prospect can only be restored', 'HQ_PROSPECT_ARCHIVED');
  await refuse('23514', () => consent('marketer', p1.prospectId, ask({ channel: 'EMAIL', purpose: 'SERVICE', status: 'OPTED_IN', expectedVersion: 5 })), 'no opt-in while archived', 'HQ_PROSPECT_ARCHIVED');
  eq((await consent('marketer', p1.prospectId, ask({ channel: 'EMAIL', purpose: 'MARKETING', status: 'OPTED_OUT', expectedVersion: 5 }))).prospect.version, 6, 'opt-out still recorded while archived');
  await refuse('23514', () => create('marketer', { ...base, email: 'new-address@example.test', phone: null, source: 'HQ_ENTERED' }), 'an archived prospect still holds its address', 'HQ_PROSPECT_EXISTS');
  eq((await update('marketer', p1.prospectId, { ...u, email: 'new-address@example.test', expectedVersion: 6 })).prospect.status, 'ACTIVE', 'restored');

  // ---------- 5. list and paging ----------
  for (let i = 3; i <= 7; i++) await create('marketer', { fullName: `Prospect ${i}`, schoolName: null, email: `p${i}@example.test`, phone: null, campaignId: null, source: 'IMPORT' });
  const page1 = await list('marketer', 'ACTIVE', null, null, null, 4);
  eq(page1.prospects.length, 4, 'first page');
  ok(page1.nextCursor !== null, 'more to read');
  const page2 = await list('marketer', 'ACTIVE', null, page1.nextCursor.createdAt, page1.nextCursor.prospectId, 4);
  const ids = [...page1.prospects, ...page2.prospects].map((p) => p.prospectId);
  eq(new Set(ids).size, 7, 'two pages hold all seven prospects once each');
  eq((await list('marketer', null, CAMPAIGN)).prospects.map((p) => p.prospectId), [p1.prospectId], 'filtered by campaign');
  await refuse('22023', () => list('marketer', 'GONE'), 'bad status filter');
  await refuse('22023', () => list('marketer', null, null, null, null, 101), 'page size capped');

  // ---------- 6. history is append-only ----------
  await refuse('42501', () => admin.query('DELETE FROM hon.hq_prospects WHERE id=$1', [p1.prospectId]), 'prospects are never deleted');
  await refuse('42501', () => admin.query("UPDATE hon.hq_prospects SET full_name='x' WHERE id=$1", [p1.prospectId]), 'changes need a version bump');
  await refuse('42501', () => admin.query("UPDATE hon.hq_prospect_consents SET status='OPTED_IN'"), 'consent immutable');
  await refuse('42501', () => admin.query('TRUNCATE hon.hq_prospect_requests'), 'no truncate');

  await cleanup();
  console.log(`PASS: HQ prospects (0283) integrity (${passed} checks).`);
} finally {
  await Promise.allSettled([admin.end(), runtime.end(), worker.end()]);
}
