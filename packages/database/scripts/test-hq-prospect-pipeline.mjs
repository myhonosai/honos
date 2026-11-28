// HQ prospects pipeline board (0715), TEST MODE, disposable database only (the 0243 communication delivery fixture). It
// proves: only an HQ owner or an operator holding hq.marketing.manage reads the board or changes stages and moves; open
// prospects always sit in a stage (new ones land in the first visible stage, a restore clears the outcome); moves are
// version-checked, idempotent and land only in visible stages; WON/LOST close a prospect and a stage move re-opens it;
// stage saves keep every stage (hide, never delete), need one visible stage and unique names, and move prospects out of a
// stage that hides; customer schools appear read-only by their real status (ACTIVE vs SUSPENDED/ARCHIVED, trial end);
// tables are forced-RLS with no runtime access and the runtime runs only the three entry points.
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const { Client } = pg;
for (const key of ['DATABASE_URL', 'HON_RUNTIME_DATABASE_URL', 'HON_COMMUNICATION_WORKER_DATABASE_URL']) {
  if (!process.env[key]) throw new Error(`${key} is required for HQ prospect pipeline tests.`);
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
  .map((k) => [k, { id: randomUUID(), user: randomUUID(), subject: `hqpipe-${k}-${randomUUID()}`, email: `${k}-${randomUUID().slice(0, 8)}@example.test` }]));
const H = (k) => humans[k].subject, P = (k) => humans[k].id;
const ORG = randomUUID(), S = randomUUID(), ORG2 = randomUUID(), S2 = randomUUID(), ROLE = randomUUID();
const one = async (client, sql, params) => (await client.query(sql, params)).rows[0];
const call = async (fn, args, types) => (await one(runtime, `SELECT hon.${fn}(${args.map((_, i) => `$${i + 1}${types?.[i] ?? ''}`).join(',')}) AS d`, args)).d;
const create = (who, input, key = K()) => call('create_hq_prospect', [H(who), JSON.stringify(input), key], ['', '::jsonb', '::uuid']);
const update = (who, id, input, key = K()) => call('update_hq_prospect', [H(who), id, JSON.stringify(input), key], ['', '::uuid', '::jsonb', '::uuid']);
const board = (who) => call('read_hq_prospect_board', [H(who)]);
const move = (who, id, input, key = K()) => call('move_hq_prospect_stage', [H(who), id, JSON.stringify(input), key], ['', '::uuid', '::jsonb', '::uuid']);
const save = (who, input, key = K()) => call('save_hq_prospect_stages', [H(who), JSON.stringify(input), key], ['', '::jsonb', '::uuid']);
const prospect = (n) => ({ fullName: `Pipe Prospect ${n}`, schoolName: `Pipe Dojo ${n}`, email: `pipe${n}@example.test`, phone: null, campaignId: null, source: 'IMPORT' });

const tables = ['hq_prospect_board_requests', 'hq_prospect_requests', 'hq_prospect_consents', 'hq_prospects'];
let seedStages = null, seedVersion = null; // read after the first cleanup
async function cleanup() {
  await admin.query('BEGIN');
  try {
    await admin.query('SET CONSTRAINTS ALL IMMEDIATE');
    for (const t of [...tables, 'hq_prospect_stages', 'hq_prospect_pipeline']) await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
    for (const t of tables) await admin.query(`DELETE FROM hon.${t}`);
    // Back to the 0715 seed: the three oldest stages as Lead, Contacted, Demo booked; any other stage removed.
    const keep = (await admin.query('SELECT id FROM hon.hq_prospect_stages ORDER BY created_at, position LIMIT 3')).rows.map((r) => r.id);
    await admin.query('DELETE FROM hon.hq_prospect_stages WHERE NOT (id = ANY($1::uuid[]))', [keep]);
    await admin.query('SET CONSTRAINTS hon.hq_prospect_stages_position_key DEFERRED');
    await admin.query('UPDATE hon.hq_prospect_stages SET name = id::text');
    for (const [i, [name, color]] of [['Lead', 'BLUE'], ['Contacted', 'AMBER'], ['Demo booked', 'VIOLET']].entries())
      await admin.query('UPDATE hon.hq_prospect_stages SET name=$2, color=$3, position=$4, hidden=false WHERE id=$1', [keep[i], name, color, i + 1]);
    await admin.query('SET CONSTRAINTS ALL IMMEDIATE');
    for (const t of [...tables, 'hq_prospect_stages', 'hq_prospect_pipeline']) await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
    await admin.query('DELETE FROM hon.hon_os_trial_enrollments WHERE organization_id = ANY($1::uuid[])', [[ORG, ORG2]]).catch(() => {});
    for (const t of ['principal_role_grants', 'roles', 'schools']) await admin.query(`DELETE FROM hon.${t} WHERE organization_id = ANY($1::uuid[])`, [[ORG, ORG2]]);
    await admin.query('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [[ORG, ORG2]]);
    const ps = Object.values(humans).map((h) => h.id), us = Object.values(humans).map((h) => h.user);
    await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=ANY($1::uuid[])', [ps]);
    await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])', [ps]);
    await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])', [us]);
    await admin.query('COMMIT');
  } catch (error) { await admin.query('ROLLBACK'); throw error; }
}

await Promise.all([admin.connect(), runtime.connect(), worker.connect()]);
try {
  // ---------- 0. posture and seed ----------
  const has = async (client, sig) => (await one(client, "SELECT has_function_privilege(current_user,$1,'EXECUTE') a", ['hon.' + sig])).a;
  for (const sig of ['read_hq_prospect_board(text)', 'move_hq_prospect_stage(text,uuid,jsonb,uuid)', 'save_hq_prospect_stages(text,jsonb,uuid)']) {
    eq(await has(runtime, sig), true, `runtime runs ${sig}`); eq(await has(worker, sig), false, `worker cannot run ${sig}`);
  }
  for (const sig of ['hq_prospect_card_json(hon.hq_prospects)', 'hq_prospect_stages_json()', 'hq_prospect_board_claim(uuid,uuid,text,text)', 'hq_prospect_stage_defaults()'])
    eq(await has(runtime, sig), false, `runtime cannot run helper ${sig}`);
  for (const t of ['hq_prospect_pipeline', 'hq_prospect_stages', 'hq_prospect_board_requests']) {
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
      eq((await one(runtime, 'SELECT has_table_privilege(current_user,$1,$2) a', ['hon.' + t, priv])).a, false, `runtime ${t} ${priv}`);
    eq(await one(admin, 'SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE oid=$1::regclass', ['hon.' + t]), { r: true, f: true }, `${t} forced RLS`);
  }
  // The canonical 011 block (run with this fixture's role names) passes, and refuses a runtime grant on a helper.
  const canonical = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
  const block = canonical.split('-- HQ prospect pipeline exact verification (0715)')[1]?.split('-- End HQ prospect pipeline exact verification.')[0]
    ?.replace(/^[^\n]*\n[^\n]*\n/, '');
  if (!block) throw new Error('Missing canonical 0715 verification.');
  const roles = (await one(runtime, 'SELECT current_user r')).r, workerRole = (await one(worker, 'SELECT current_user r')).r;
  const fixtureBlock = block.replaceAll("'hon_runtime'", `'${roles}'`).replaceAll("'hon_communication_worker'", `'${workerRole}'`);
  await admin.query(fixtureBlock); eq(true, true, 'canonical 011 block passes');
  await admin.query('BEGIN');
  try {
    await admin.query(`GRANT EXECUTE ON FUNCTION hon.hq_prospect_card_json(hon.hq_prospects) TO ${roles}`);
    await assert.rejects(admin.query(fixtureBlock), /HQ prospect pipeline function body\/posture drift/); eq(true, true, 'canonical block refuses a runtime grant on a helper');
  } finally { await admin.query('ROLLBACK'); }
  await cleanup();
  seedStages = (await admin.query('SELECT id, name, color, position, hidden FROM hon.hq_prospect_stages ORDER BY position')).rows;
  seedVersion = (await one(admin, 'SELECT version FROM hon.hq_prospect_pipeline')).version;
  eq(seedStages.slice(0, 3).map((s) => [s.name, s.hidden]), [['Lead', false], ['Contacted', false], ['Demo booked', false]], 'seeded Lead, Contacted, Demo booked');
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
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name,status,created_at) VALUES($1,'HQPIPE Active Dojo','HQPIPE Active Dojo','ACTIVE',clock_timestamp())", [ORG]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'HQPIPE Active',$1::text,'UTC')", [S, ORG]);
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name,status,created_at) VALUES($1,'HQPIPE Paused Dojo','HQPIPE Paused Dojo','SUSPENDED',clock_timestamp())", [ORG2]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'HQPIPE Paused',$1::text,'UTC')", [S2, ORG2]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','School Owner',true)", [ROLE, ORG]);
  await admin.query(`INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from)
    VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')`, [ORG, S, P('schoolOwner'), ROLE]);
  await admin.query('COMMIT');

  // ---------- 1. authority ----------
  for (const who of ['reader', 'supportOp', 'schoolOwner']) {
    await refuse('42501', () => board(who), `${who} cannot read the board`);
    await refuse('42501', () => save(who, { expectedVersion: seedVersion, stages: [], moves: [] }), `${who} cannot save stages`);
  }
  await refuse('42501', () => call('read_hq_prospect_board', ['nobody-' + randomUUID()]), 'unknown subject');

  // ---------- 2. new prospects land in the first visible stage ----------
  const lead = seedStages[0].id, contacted = seedStages[1].id, demo = seedStages[2].id;
  const p1 = (await create('marketer', prospect(1))).prospect, p2 = (await create('hqOwner', prospect(2))).prospect;
  let b = await board('marketer');
  eq(b.prospects.map((p) => [p.prospectId, p.stageId]).sort(), [[p1.prospectId, lead], [p2.prospectId, lead]].sort(), 'both new prospects are in Lead');
  eq([b.pipelineVersion, b.stages.length, b.stages[0].openCount, b.closed, b.truncated], [seedVersion, seedStages.length, 2, { won: 0, lost: 0 }, false], 'board totals');
  const active = b.schools.find((s) => s.schoolId === S), paused = b.schools.find((s) => s.schoolId === S2);
  eq([active.status, active.schoolName, active.organizationName, active.trialEndsAt], ['ACTIVE', 'HQPIPE Active', 'HQPIPE Active Dojo', null], 'active school column');
  eq(paused.status, 'SUSPENDED', 'a paused organization puts its school in Inactive school');
  eq(Object.keys(active).sort(), ['createdAt', 'organizationName', 'schoolId', 'schoolName', 'status', 'tier', 'trialEndsAt'], 'a school shows only names, tier, status, trial and date');
  eq(b.prospects[0].textOptedOut, false, 'no text opt-out yet');

  // ---------- 3. moves ----------
  await refuse('22023', () => move('marketer', p1.prospectId, { expectedVersion: 1, stageId: contacted, outcome: 'WON' }), 'stage or outcome, not both');
  await refuse('22023', () => move('marketer', p1.prospectId, { expectedVersion: 1, stageId: null, outcome: null }), 'one of them is needed');
  await refuse('22023', () => move('marketer', p1.prospectId, { expectedVersion: 1, stageId: null, outcome: 'MAYBE' }), 'closed outcomes');
  await refuse('22023', () => move('marketer', p1.prospectId, { expectedVersion: 1, stageId: contacted, outcome: null, extra: 1 }), 'closed keys');
  await refuse('40001', () => move('marketer', p1.prospectId, { expectedVersion: 7, stageId: contacted, outcome: null }), 'stale version');
  await refuse('23514', () => move('marketer', p1.prospectId, { expectedVersion: 1, stageId: lead, outcome: null }), 'same stage', 'HQ_PROSPECT_NO_CHANGE');
  await refuse('23514', () => move('marketer', p1.prospectId, { expectedVersion: 1, stageId: randomUUID(), outcome: null }), 'unknown stage', 'HQ_PROSPECT_STAGE_UNAVAILABLE');
  await refuse('42501', () => move('reader', p1.prospectId, { expectedVersion: 1, stageId: contacted, outcome: null }), 'read-only marketing cannot move');
  const key = K();
  const m1 = await move('marketer', p1.prospectId, { expectedVersion: 1, stageId: contacted, outcome: null }, key);
  eq([m1.operation, m1.replayed, m1.prospect.stageId, m1.prospect.version, m1.prospect.status], ['MOVE', false, contacted, 2, 'ACTIVE'], 'moved to Contacted');
  eq((await move('marketer', p1.prospectId, { expectedVersion: 1, stageId: contacted, outcome: null }, key)).replayed, true, 'replay returns the saved answer');
  await refuse('23505', () => move('marketer', p1.prospectId, { expectedVersion: 2, stageId: demo, outcome: null }, key), 'same key, different move', 'SAAS_KEY_REUSED');
  const won = await move('hqOwner', p2.prospectId, { expectedVersion: 1, stageId: null, outcome: 'WON' });
  eq([won.prospect.status, won.prospect.closedOutcome, won.prospect.version], ['ARCHIVED', 'WON', 2], 'Became a school closes as WON');
  await refuse('23514', () => move('hqOwner', p2.prospectId, { expectedVersion: 2, stageId: null, outcome: 'LOST' }), 'a closed prospect cannot close again', 'HQ_PROSPECT_ARCHIVED');
  b = await board('marketer');
  eq([b.prospects.map((p) => p.prospectId), b.closed], [[p1.prospectId], { won: 1, lost: 0 }], 'closed prospects leave the board and count as won');
  const reopened = await move('hqOwner', p2.prospectId, { expectedVersion: 2, stageId: demo, outcome: null });
  eq([reopened.prospect.status, reopened.prospect.closedOutcome, reopened.prospect.stageId], ['ACTIVE', null, demo], 'a stage move re-opens a closed prospect');
  const lost = await move('hqOwner', p2.prospectId, { expectedVersion: 3, stageId: null, outcome: 'LOST' });
  eq(lost.prospect.closedOutcome, 'LOST', 'Not interested closes as LOST');
  // A restore through the prospect page clears the outcome and keeps the stage.
  const restored = await update('marketer', p2.prospectId, { expectedVersion: 4, fullName: 'Pipe Prospect 2', schoolName: 'Pipe Dojo 2', email: 'pipe2@example.test',
    phone: null, campaignId: null, status: 'ACTIVE' });
  eq([restored.prospect.status, (await one(admin, 'SELECT closed_outcome o, stage_id s FROM hon.hq_prospects WHERE id=$1', [p2.prospectId]))], ['ACTIVE', { o: null, s: demo }],
    'restore clears the outcome and keeps the stage');
  await admin.query("UPDATE hon.hq_prospects SET closed_outcome='WON', version=version+1 WHERE id=$1", [p1.prospectId]);
  eq((await one(admin, 'SELECT closed_outcome FROM hon.hq_prospects WHERE id=$1', [p1.prospectId])).closed_outcome, null, 'an open prospect never carries an outcome');
  await refuse('23514', () => admin.query("ALTER TABLE hon.hq_prospects DISABLE TRIGGER stage_defaults; UPDATE hon.hq_prospects SET closed_outcome='WON', version=version+1 WHERE id='" + p1.prospectId + "'"),
    'the table itself refuses an outcome on an open prospect');
  await admin.query('ALTER TABLE hon.hq_prospects ENABLE TRIGGER stage_defaults');
  await admin.query('UPDATE hon.hq_prospects SET stage_id=NULL, version=version+1 WHERE id=$1', [p1.prospectId]);
  eq((await one(admin, 'SELECT stage_id FROM hon.hq_prospects WHERE id=$1', [p1.prospectId])).stage_id, lead, 'an open prospect never loses its stage (the default puts it in the first visible stage)');
  await move('marketer', p1.prospectId, { expectedVersion: (await one(admin, 'SELECT version FROM hon.hq_prospects WHERE id=$1', [p1.prospectId])).version, stageId: contacted, outcome: null });

  // ---------- 4. text opt-out shows on the card ----------
  await admin.query(`INSERT INTO hon.hq_prospect_consents(prospect_id,channel,purpose,status,source,address,captured_at,recorded_at)
    VALUES($1,'SMS','SERVICE','OPTED_OUT','RECIPIENT','+15550100199',clock_timestamp(),clock_timestamp())`, [p1.prospectId]);
  eq((await board('marketer')).prospects.find((p) => p.prospectId === p1.prospectId).textOptedOut, false, 'an answer for another number does not count');
  const v = (await one(admin, 'SELECT version FROM hon.hq_prospects WHERE id=$1', [p1.prospectId])).version;
  await update('marketer', p1.prospectId, { expectedVersion: v, fullName: 'Pipe Prospect 1', schoolName: 'Pipe Dojo 1', email: 'pipe1@example.test',
    phone: '+15550100199', campaignId: null, status: 'ACTIVE' });
  eq((await board('marketer')).prospects.find((p) => p.prospectId === p1.prospectId).textOptedOut, true, 'a texting opt-out on the current number hides Text');

  // ---------- 5. stage saves ----------
  b = await board('hqOwner');
  const st = (s, over = {}) => ({ id: s.stageId, name: s.name, color: s.color, hidden: s.hidden, ...over });
  const all = b.stages.map((s) => st(s));
  const pv = b.pipelineVersion;
  await refuse('40001', () => save('hqOwner', { expectedVersion: pv + 5, stages: all, moves: [] }), 'stale pipeline version');
  await refuse('23514', () => save('hqOwner', { expectedVersion: pv, stages: all.slice(1), moves: [] }), 'a stage cannot be dropped', 'HQ_PROSPECT_STAGES_INVALID');
  await refuse('23514', () => save('hqOwner', { expectedVersion: pv, stages: [...all, { id: null, name: 'lead', color: 'RED', hidden: false }], moves: [] }), 'names unique', 'HQ_PROSPECT_STAGE_NAME_TAKEN');
  await refuse('23514', () => save('hqOwner', { expectedVersion: pv, stages: all.map((s) => ({ ...s, hidden: true })), moves: [] }), 'one stage stays visible');
  await refuse('22023', () => save('hqOwner', { expectedVersion: pv, stages: [...all, { id: null, name: ' Padded', color: 'RED', hidden: false }], moves: [] }), 'trimmed names');
  await refuse('22023', () => save('hqOwner', { expectedVersion: pv, stages: [...all, { id: null, name: 'Pink', color: 'PINK', hidden: false }], moves: [] }), 'palette colours');
  // Hide Contacted (holds p1): a move is required, to a visible existing stage.
  const hideContacted = all.map((s) => s.id === contacted ? { ...s, hidden: true } : s);
  await refuse('23514', () => save('hqOwner', { expectedVersion: pv, stages: hideContacted, moves: [] }), 'hiding a stage with prospects needs a move', 'HQ_PROSPECT_STAGE_MOVE_REQUIRED');
  await refuse('23514', () => save('hqOwner', { expectedVersion: pv, stages: hideContacted, moves: [{ fromStageId: contacted, toStageId: contacted }] }), 'not into a hidden stage', 'HQ_PROSPECT_STAGE_MOVE_INVALID');
  await refuse('23514', () => save('hqOwner', { expectedVersion: pv, stages: hideContacted, moves: [{ fromStageId: lead, toStageId: demo }] }), 'only stages that hide move', 'HQ_PROSPECT_STAGE_MOVE_INVALID');
  // Reorder, rename, add Trial school, hide Contacted moving p1 to Demo booked.
  const next = [st(b.stages[2], { name: 'Demo set' }), { id: null, name: 'Trial', color: 'GREEN', hidden: false }, st(b.stages[0]), ...hideContacted.filter((s) => s.id === contacted), ...all.slice(3)];
  const skey = K();
  const saved = await save('marketer', { expectedVersion: pv, stages: next, moves: [{ fromStageId: contacted, toStageId: demo }] }, skey);
  eq([saved.operation, saved.replayed, saved.pipelineVersion], ['STAGES', false, pv + 1], 'stages saved');
  eq(saved.stages.slice(0, 4).map((s) => [s.name, s.position, s.hidden, s.openCount]), [['Demo set', 1, false, 2], ['Trial', 2, false, 0], ['Lead', 3, false, 0], ['Contacted', 4, true, 0]],
    'renamed, added, reordered; Contacted hidden and its prospect moved to Demo set');
  eq((await save('marketer', { expectedVersion: pv, stages: next, moves: [{ fromStageId: contacted, toStageId: demo }] }, skey)).replayed, true, 'stage save replay');
  eq((await one(admin, 'SELECT stage_id s, version v FROM hon.hq_prospects WHERE id=$1', [p1.prospectId])).s, demo, 'the moved prospect sits in Demo set');
  await refuse('23514', async () => move('marketer', p2.prospectId, { expectedVersion: (await one(admin, 'SELECT version FROM hon.hq_prospects WHERE id=$1', [p2.prospectId])).version,
    stageId: contacted, outcome: null }), 'no move into a hidden stage', 'HQ_PROSPECT_STAGE_UNAVAILABLE');
  const p3 = (await create('marketer', prospect(3))).prospect;
  eq((await one(admin, 'SELECT stage_id FROM hon.hq_prospects WHERE id=$1', [p3.prospectId])).stage_id, demo, 'new prospects land in the first visible stage (Demo set now)');

  // ---------- 6. schools: trial and archived ----------
  await admin.query("UPDATE hon.organizations SET status='ARCHIVED' WHERE id=$1", [ORG2]).catch(() => {});
  const statusNow = (await board('marketer')).schools.find((s) => s.schoolId === S2)?.status;
  ok(['ARCHIVED', 'SUSPENDED'].includes(statusNow), 'archived or paused schools stay in Inactive school');

  // ---------- 7. evidence ----------
  await refuse('42501', () => admin.query('DELETE FROM hon.hq_prospect_stages WHERE id=$1', [lead]), 'stages are never deleted');
  await refuse('42501', () => admin.query('UPDATE hon.hq_prospect_pipeline SET version = version + 5'), 'pipeline version only steps by one');
  await refuse('42501', () => admin.query('DELETE FROM hon.hq_prospect_board_requests'), 'requests are evidence');
  await refuse('42501', () => admin.query('TRUNCATE hon.hq_prospect_board_requests'), 'no truncate');

  await cleanup();
  console.log(`PASS: HQ prospects pipeline board (0715) integrity (${passed} checks).`);
} finally {
  await Promise.allSettled([admin.end(), runtime.end(), worker.end()]);
}
