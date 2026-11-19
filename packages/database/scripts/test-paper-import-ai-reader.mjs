/**
 * Paper import AI reader (0594): HON reads paper import photos on the AI team's text route, through the real API services,
 * the restricted runtime role and the S4 spend controls on a fresh disposable AI-0 fixture. The provider is a counted
 * in-process fake: nothing leaves the machine, and fetch is refused. Synthetic names and pages only.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID as K } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { AI0_DATABASE as database, AI0_OWNER_ROLE as ownerRole, AI0_RUNTIME_ROLE as runtimeRole, assertDisposableTarget, assertNoLibpqOverrides } from './ai-spend-baseline-target.mjs';

assertNoLibpqOverrides(process.env);
const ownerUrl = assertDisposableTarget(process.env.DATABASE_URL, ownerRole);
process.env.HON_RUNTIME_DATABASE_URL = assertDisposableTarget(process.env.HON_RUNTIME_DATABASE_URL, runtimeRole);
const forbidden = Object.keys(process.env).filter((k) => /^(?:OPENAI|ANTHROPIC|OPENROUTER|STRIPE|TWILIO|SUPABASE|AWS|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(k));
if (forbidden.length) throw new Error(`Refusing provider or execution variables (${forbidden.join(', ')}).`);
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls += 1; throw new Error('EXTERNAL_NETWORK_FORBIDDEN'); };

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { AiInvocationPlanService } = await import('../../../apps/api/dist/ai/ai-invocation-plan.service.js');
const { PaperImportService } = await import('../../../apps/api/dist/paper-import/paper-import.service.js');
const { SyntheticPaperReader } = await import('../../../apps/api/dist/paper-import/paper-reader.js');
const { PaperVisionRuntimeError } = await import('../../../apps/api/dist/ai/paper-vision-runtime.js');

const admin = new pg.Client({ connectionString: ownerUrl, ssl: false });
const row = async (sql, args = []) => (await admin.query(sql, args)).rows[0];
const rows = async (sql, args = []) => (await admin.query(sql, args)).rows;
const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));
const code = (r) => r.error?.getResponse?.().code ?? r.error?.message;
let groups = 0; const pass = (name) => console.log(`PASS PR-AI ${++groups} ${name}`);

const COLUMNS = ['studentGivenName', 'studentFamilyName', 'birthDate', 'studentEmail', 'studentMobile', 'guardianGivenName', 'guardianFamilyName', 'guardianEmail', 'guardianMobile', 'familyKey'];
const cardRow = (given, family, birth) => [given, family, birth, '', '', '', '', '', '', ''];
const goodAnswer = { rows: [cardRow('Aria', 'Synthetic', '2016-04-02'), cardRow('Ben', 'Synthetic', '')], unsure: [COLUMNS.map(() => false), COLUMNS.map((c) => c === 'birthDate')] };

// The fake provider: counts calls, records what it was given, and can answer, refuse, lose the outcome or wait.
const fake = { calls: 0, inputs: [], mode: 'OK', answer: goodAnswer, usage: { inputTokens: 9000, outputTokens: 600, providerCostMicrounits: 21000 }, ready: 'READY', gate: null };
const vision = {
  readiness: () => fake.ready,
  read: async (input) => {
    fake.calls += 1; fake.inputs.push(input);
    if (fake.gate) await fake.gate.promise;
    if (fake.mode === 'UNKNOWN') throw new PaperVisionRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
    if (fake.mode === 'FAILED') throw new PaperVisionRuntimeError('FAILED', 'PROVIDER_REJECTED');
    return { answer: fake.answer, ...fake.usage };
  },
};
const hold = () => { let release; const promise = new Promise((r) => { release = r; }); fake.gate = { promise, release: () => { fake.gate = null; release(); } }; return fake.gate; };
const db = new RuntimeDatabaseService(), plans = new AiInvocationPlanService(db);
const imports = new PaperImportService(db, new SyntheticPaperReader(), plans, vision);
const textModel = K(), visionModel = K(), hq = { id: K(), user: K(), subject: `pr-ai-hq-owner-${K()}` };
const ctx = (o, patch = {}) => ({ organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: K(), correlationId: K(), idempotencyKey: K(), ...patch });
const readCtx = (o) => ctx(o, { idempotencyKey: '' });

const samples = resolve(repo, 'apps/web/public/paper-import-samples');
const CARD = await readFile(resolve(samples, 'student-card.png'));
const PHOTO = await readFile(resolve(repo, 'apps/api/test/fixtures/paper-page.jpg'));
const PHOTO_PNG = await readFile(resolve(samples, 'contract.png'));

async function makeOrg(label, { profile = 'VISION', tier = 'COMPLETE' } = {}) {
  const o = { label, id: K(), school: K(), user: K(), principal: K(), role: K(), subject: `pr-ai-${label}-${K()}`, policy: K(), profile: K() };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Paper AI synthetic organization','Paper AI synthetic organization')", [o.id]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'Paper AI Secret Dojo Name',$1::uuid::text,'UTC')", [o.school, o.id]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,$2,'ACTIVE',clock_timestamp()-interval '1 day')", [o.id, tier]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','Paper AI synthetic owner')", [o.user, o.subject]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Paper AI synthetic owner')", [o.principal, o.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','Paper AI synthetic owner',true)", [o.role, o.id]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions', [o.role, o.id]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')", [o.id, o.school, o.principal, o.role]);
  // The text-only model comes first in the policy order, so only a DOCUMENT_READING profile can reach the image model.
  await admin.query("INSERT INTO hon.hq_ai_routing_policies(policy_id,organization_id,school_id,capability,active,minimum_tier,max_cost_micros,effective_from) VALUES($1,$2,$3,'TEXT',true,'COMPLETE',250000,'2020-01-01')", [o.policy, o.id, o.school]);
  await admin.query('INSERT INTO hon.hq_ai_routing_candidates(policy_id,ordinal,catalog_id) VALUES($1,0,$2),($1,1,$3)', [o.policy, textModel, visionModel]);
  await admin.query('COMMIT');
  if (profile) await addProfile(o, profile);
  return o;
}
async function addProfile(o, profile) {
  await admin.query('BEGIN');
  await admin.query(`INSERT INTO hon.hq_ai_task_profiles(profile_id,routing_policy_id,agent_key,task_category,cost_unit,active,max_cost_micros,required_capabilities,required_modalities,allowed_provider_ids,privacy_controls,timeout_category,retry_category,effective_from)
    VALUES($1,$2,'hon','DOCUMENT_READING','TOKEN',true,250000,ARRAY['TEXT'],$3::text[],ARRAY['OPENROUTER'],$4::text[],'EXTENDED','NONE','2020-01-01')`,
    [o.profile, o.policy, profile === 'TEXT_ONLY' ? ['TEXT'] : ['TEXT', 'IMAGE'], profile === 'VISION' ? ['NO_TRAINING', 'ZERO_RETENTION'] : []]);
  await admin.query("INSERT INTO hon.hq_ai_task_profile_candidates(profile_id,routing_policy_id,selection,ordinal,catalog_id) VALUES($1,$2,'DEFAULT',0,$3)", [o.profile, o.policy, profile === 'TEXT_ONLY' ? textModel : visionModel]);
  await admin.query('COMMIT');
}
/** A second person at the same school with the listed permissions only. */
async function addStaff(o, label, permissions) {
  const s = { ...o, user: K(), principal: K(), role: K(), subject: `pr-ai-${label}-${K()}` };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','Paper AI synthetic staff')", [s.user, s.subject]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Paper AI synthetic staff')", [s.principal, s.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,'Paper AI synthetic staff',false)", [s.role, o.id, 'PRAI_' + label.toUpperCase()]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,unnest($3::text[])', [s.role, o.id, permissions]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 day')", [o.id, o.school, s.principal, s.role, o.principal]);
  await admin.query('COMMIT');
  return s;
}
async function newSet(o, kind, pages) {
  let set = (await imports.create(ctx(o), { kind })).set;
  for (const [bytes, type] of pages) set = (await imports.addPage(ctx(o), set.id, { expectedVersion: set.version, mediaType: type, data: bytes.toString('base64') })).set;
  return set;
}
/** Read at the set's current version (each start of a reading moves the version). */
const readIt = async (o, set) => imports.readPages(readCtx(o), set.id, { expectedVersion: (await imports.detail(readCtx(o), set.id)).set.version });
const proposalOf = (set) => row("SELECT * FROM hon.ai_text_proposals WHERE kind='PAPER_READING' AND origin_key=$1", [set.id]);
const ledger = (id) => rows('SELECT customer_credits::int c, provider_cost_microunits::bigint cost, spend_class, school_id, model_code FROM hon.ai_usage_ledger WHERE source_invocation_id=$1', [id]);
const setRow = (set) => row('SELECT status,reader,read_outcome,table_rows,table_unsure FROM hon.paper_import_sets WHERE id=$1', [set.id]);

try {
  await admin.connect();
  assert.equal((await row("SELECT current_database() d FROM pg_database WHERE datname=current_database()")).d, database);

  // 1. Custody: six new runtime entry points, helpers owner-only, the PAPER_READING kind fixed, the plan guard attached.
  const entry = ['begin_paper_ai_reading', 'paper_ai_reading_planning_reference', 'prepare_paper_ai_reading', 'fail_paper_ai_reading', 'record_paper_ai_reading', 'type_paper_import_rows'];
  const helpers = ['ai_plan_document_reading_guard', 'paper_reading_proposal_id', 'paper_import_note', 'paper_reading_ai_actor', 'paper_import_detail'];
  for (const name of [...entry, ...helpers]) {
    const f = await row("SELECT p.oid, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname=$1", [name]);
    assert(f, name);
    assert.equal((await row("SELECT has_function_privilege($1,$2::oid,'EXECUTE') ok", [runtimeRole, f.oid])).ok, entry.includes(name), name);
    assert.equal((await row("SELECT coalesce(bool_or(a.grantee=0),false) pub FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1", [f.oid])).pub, false, name);
  }
  const kind = await row("SELECT * FROM hon.ai_text_kinds WHERE kind='PAPER_READING'");
  assert.deepEqual([kind.agent_key, kind.task_class, kind.input_budget, kind.output_budget, Number(kind.max_cost_microunits), kind.max_result_bytes, kind.caller, kind.subject_type, kind.usage_agent],
    ['hon', 'READ_DOCUMENT', 40000, 16000, 250000, 256, 'HUMAN_UI', 'PAPER_IMPORT_SET', 'PAPER_READING']);
  await assert.rejects(admin.query("UPDATE hon.ai_text_kinds SET max_cost_microunits=900000 WHERE kind='PAPER_READING'"));
  assert.equal((await row("SELECT hon.ai_route_task_category('hon','READ_DOCUMENT') c")).c, 'DOCUMENT_READING');
  assert.equal((await row("SELECT hon.ai_route_task_category('marcus','READ_DOCUMENT') c")).c, null);
  assert.equal((await row("SELECT count(*)::int n FROM pg_trigger WHERE tgrelid='hon.ai_invocation_plans'::regclass AND tgname='ai_plan_document_reading_guard'")).n, 1);
  pass('custody: runtime executes exactly the six new entry points, helpers are owner-only, the PAPER_READING kind (hon, READ_DOCUMENT, 40,000/16,000, $0.25) is fixed, hon/READ_DOCUMENT routes to DOCUMENT_READING, the plan guard is attached');

  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state,credential_secret_ref) VALUES('OPENROUTER','Paper AI synthetic route','HEALTHY',$1)", [`hon-secret:${K()}`]);
  await admin.query("INSERT INTO hon.hq_ai_model_catalog(catalog_id,provider_id,model_id,display_name,capabilities,modalities,active,minimum_tier,unit_cost_micros,cost_unit,effective_from) VALUES($1,'OPENROUTER','approved/pr-ai-text','Paper AI text model',ARRAY['TEXT'],ARRAY['TEXT'],true,'COMPLETE',2,'TOKEN','2020-01-01')", [textModel]);
  await admin.query("INSERT INTO hon.hq_ai_model_catalog(catalog_id,provider_id,model_id,display_name,capabilities,modalities,privacy_controls,active,minimum_tier,unit_cost_micros,cost_unit,effective_from) VALUES($1,'OPENROUTER','approved/pr-ai-vision','Paper AI vision model',ARRAY['TEXT','IMAGE'],ARRAY['TEXT','IMAGE'],ARRAY['NO_TRAINING','ZERO_RETENTION'],true,'COMPLETE',2,'TOKEN','2020-01-01')", [visionModel]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','Paper AI synthetic HQ owner')", [hq.user, hq.subject]);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','Paper AI synthetic HQ owner',true)", [hq.id, hq.user]);
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER','{}',clock_timestamp()-interval '2 days')", [hq.id]);
  await admin.query('COMMIT');

  // 2. No DOCUMENT_READING profile, then a profile that does not require IMAGE: nothing is planned or sent; the set stays open.
  const a = await makeOrg('a', { profile: null });
  const s1 = await newSet(a, 'STUDENT_CARDS', [[PHOTO, 'image/jpeg'], [PHOTO_PNG, 'image/png']]);
  const blocked = await readIt(a, s1);
  assert.deepEqual([blocked.set.status, blocked.aiReading?.status, blocked.aiReading?.reason, fake.calls], ['OPEN', 'BLOCKED', 'NO_ELIGIBLE_ROUTE', 0], JSON.stringify(blocked));
  const p0 = await proposalOf(s1);
  assert.deepEqual([p0.plan_id, p0.reserved_credits], [null, 0]);
  assert.equal((await row("SELECT count(*)::int n FROM hon.ai_invocation_plans WHERE organization_id=$1 AND task_class='READ_DOCUMENT'", [a.id])).n, 0, 'the policy-order text model was never planned');
  const c = await makeOrg('c', { profile: 'TEXT_ONLY' });
  const sc = await newSet(c, 'STUDENT_CARDS', [[PHOTO, 'image/jpeg']]);
  const blockedC = await readIt(c, sc);
  assert.deepEqual([blockedC.aiReading?.status, blockedC.aiReading?.reason, fake.calls], ['BLOCKED', 'NO_ELIGIBLE_ROUTE', 0]);
  assert.equal((await row("SELECT count(*)::int n FROM hon.ai_invocation_plans WHERE organization_id=$1", [c.id])).n, 0);
  // An image profile without the no-training and zero-retention controls: the planner would pick the image model, but
  // the plan guard refuses it (the pages can show minors' details), so nothing is planned or sent.
  const v = await makeOrg('v', { profile: 'VISION_NO_PRIVACY' });
  const sv = await newSet(v, 'STUDENT_CARDS', [[PHOTO, 'image/jpeg']]);
  const blockedV = await readIt(v, sv);
  assert.deepEqual([blockedV.aiReading?.status, blockedV.aiReading?.reason, fake.calls], ['BLOCKED', 'NO_ELIGIBLE_ROUTE', 0], JSON.stringify(blockedV));
  assert.equal((await row("SELECT count(*)::int n FROM hon.ai_invocation_plans WHERE organization_id=$1", [v.id])).n, 0);
  await assert.rejects(admin.query("INSERT INTO hon.ai_invocation_plans(organization_id,school_id,work_item_id,work_item_version,work_item_state,agent_key,modality,task_class,risk_class,input_budget,output_budget,max_provider_cost_microunits,estimated_provider_cost_microunits,customer_credit_estimate,provider_id,model_id,catalog_id,catalog_version,routing_policy_id,routing_policy_version,provider_version,request_hash) SELECT organization_id,school_id,work_item_id,1,'READY','hon','TEXT','READ_DOCUMENT','MODERATE',40000,16000,250000,1,56,'OPENROUTER','approved/pr-ai-text',$2,1,$3,1,1,repeat('a',64) FROM hon.ai_text_proposals WHERE id=$1", [p0.id, textModel, a.policy]), /AI_DOCUMENT_ROUTE_REQUIRED/);
  pass('route: with no DOCUMENT_READING profile, one that does not require IMAGE, or one without NO_TRAINING and ZERO_RETENTION, the planner never stores a plan (the text-only model is refused even first in the policy order); the reading is BLOCKED NO_ELIGIBLE_ROUTE with nothing held and the set open');

  // 3. HQ adds the image profile: the same set is read once, on the image model, with only the pages and columns sent.
  await addProfile(a, 'VISION');
  const read1 = await readIt(a, s1);
  assert.deepEqual([read1.set.status, read1.set.reader, read1.set.readOutcome, read1.aiReading?.status], ['READ', 'AI_ROUTE', 'AI_READ', 'APPLIED'], JSON.stringify(read1));
  assert.deepEqual(read1.rows, goodAnswer.rows); assert.deepEqual(read1.unsure, goodAnswer.unsure);
  assert.equal(fake.calls, 1);
  const sent = fake.inputs[0];
  assert.deepEqual([sent.modelId, sent.inputBudget, sent.outputBudget, sent.maxCostMicrounits, sent.kind, sent.columns.join(), sent.pages.length], ['approved/pr-ai-vision', 40000, 16000, 250000, 'STUDENT_CARDS', COLUMNS.join(), 2]);
  assert.deepEqual(sent.pages.map((p) => p.mediaType), ['image/jpeg', 'image/png']);
  const stored = await rows('SELECT checksum FROM hon.paper_import_pages WHERE set_id=$1 ORDER BY page_no', [s1.id]);
  assert.deepEqual(sent.pages.map((p) => createHash('sha256').update(Buffer.from(p.data, 'base64')).digest('hex')), stored.map((r) => r.checksum), 'exactly the stored (metadata-free) pages');
  const wire = JSON.stringify(sent);
  for (const secret of ['Secret Dojo', a.subject, a.id, a.school, a.principal, '@example.test']) assert(!wire.includes(secret), `no ${secret} in the call`);
  const p1 = await proposalOf(s1);
  assert.deepEqual([p1.status, p1.reserved_credits, p1.result], ['APPLIED', 0, { rowCount: 2, unsureCount: 1 }]);
  assert(!JSON.stringify(p1).includes('Aria'), 'the proposal keeps counts, never names');
  const plan = await row('SELECT agent_key, task_class, route_selection, catalog_id FROM hon.ai_invocation_plans WHERE id=$1', [p1.plan_id]);
  assert.deepEqual(plan, { agent_key: 'hon', task_class: 'READ_DOCUMENT', route_selection: 'PROFILE_DEFAULT', catalog_id: visionModel });
  assert.deepEqual(await ledger(p1.id), [{ c: 10, cost: '21000', spend_class: 'AGENT_INFERENCE', school_id: a.school, model_code: 'approved/pr-ai-vision' }]);
  assert(!JSON.stringify(await rows("SELECT next_state FROM hon.audit_events WHERE organization_id=$1 AND entity_type IN ('PAPER_IMPORT_SET','AI_TEXT_PROPOSAL')", [a.id])).includes('Aria'), 'audit is identifier-only');
  const again = await readIt(a, { ...s1, version: read1.set.version });
  assert.equal(again.set.version, read1.set.version); assert.equal(fake.calls, 1);
  pass('read: once HQ keeps a DOCUMENT_READING profile on an image model, the set is read once on that model with only the kind, the column names and the stored pages sent; the table lands as AI_READ, the proposal keeps counts only, one ledger row, a repeat never sends again');

  // 4. Answers: a cell that is not plain text is blanked and marked unsure; an answer that is not a table is paid, kept as nothing.
  fake.answer = { rows: [[' Cara  Synthetic ', 'Synthetic', 'x'.repeat(201), '', '', '', '', '', '', ''], COLUMNS.map(() => '')], unsure: [COLUMNS.map(() => false), COLUMNS.map(() => false)] };
  const s2 = await newSet(a, 'STUDENT_CARDS', [[PHOTO, 'image/jpeg']]);
  const read2 = await readIt(a, s2);
  assert.deepEqual(read2.rows, [['Cara Synthetic', 'Synthetic', '', '', '', '', '', '', '', '']]); assert.equal(read2.unsure[0][2], true);
  fake.answer = { rows: [['only', 'three', 'cells']], unsure: [[false, false, false]] };
  const s3 = await newSet(a, 'STUDENT_CARDS', [[PHOTO, 'image/jpeg']]);
  const read3 = await readIt(a, s3);
  assert.deepEqual([read3.set.status, read3.set.reader, read3.set.readOutcome, read3.rows.length, read3.aiReading?.status, read3.aiReading?.reason], ['READ', 'AI_ROUTE', 'NOT_READABLE', 0, 'DISMISSED', 'RESULT_INVALID']);
  const p3 = await proposalOf(s3);
  assert.deepEqual(p3.result_problems, ['The answer was not a table in the import columns.']); assert.equal((await ledger(p3.id)).length, 1);
  fake.answer = 'not json';
  const s3b = await newSet(a, 'ATTENDANCE_SHEETS', [[PHOTO, 'image/jpeg']]);
  assert.equal((await readIt(a, s3b)).set.readOutcome, 'NOT_READABLE');
  // Usage beyond the plan: recorded, the answer discarded.
  fake.answer = goodAnswer; fake.usage = { inputTokens: 52000, outputTokens: 600, providerCostMicrounits: 21000 };
  const s4 = await newSet(a, 'STUDENT_CARDS', [[PHOTO, 'image/jpeg']]);
  const read4 = await readIt(a, s4);
  assert.deepEqual([read4.set.readOutcome, read4.rows.length, read4.aiReading?.status, read4.aiReading?.reason], ['NOT_READABLE', 0, 'FAILED', 'RESULT_BUDGET_EXCEEDED']);
  assert.equal((await ledger((await proposalOf(s4)).id)).length, 1);
  fake.usage = { inputTokens: 9000, outputTokens: 600, providerCostMicrounits: 21000 };
  pass('answers: cells are trimmed, and one that is not plain text of up to 200 characters is blanked and marked unsure; an answer outside the columns, non-JSON or over the plan is recorded as paid, keeps no table and leaves an empty NOT_READABLE table for staff');

  // 5. Unknown outcome: the hold stays for the HQ owner, the set stays open, it is never sent again; staff can type the rows.
  fake.mode = 'UNKNOWN';
  const s5 = await newSet(a, 'STUDENT_CARDS', [[PHOTO, 'image/jpeg']]);
  const lost = await readIt(a, s5);
  assert.deepEqual([lost.set.status, lost.aiReading?.status], ['OPEN', 'UNKNOWN']);
  const p5 = await proposalOf(s5);
  assert.equal(p5.reserved_credits, 56); assert(p5.held_at); assert.equal((await ledger(p5.id)).length, 0);
  const queue = (await row('SELECT hon.read_ai_unknown_invocations_from_hq($1) r', [hq.subject])).r;
  const item = queue.open.find((q) => q.invocationId === p5.id);
  assert.deepEqual([item?.agent, item?.reservedCredits, item?.schoolId], ['TEXT_PROPOSAL', 56, a.school]);
  fake.mode = 'OK';
  const calls5 = fake.calls;
  assert.equal((await readIt(a, { ...s5, version: lost.set.version })).aiReading?.status, 'UNKNOWN'); assert.equal(fake.calls, calls5, 'never sent again');
  const typed5 = await imports.typeRows(readCtx(a), s5.id, { expectedVersion: (await imports.detail(readCtx(a), s5.id)).set.version });
  assert.deepEqual([typed5.set.status, typed5.set.reader, typed5.set.readOutcome, typed5.rows.length], ['READ', 'NONE', 'TYPED', 0]);
  assert.equal((await proposalOf(s5)).reserved_credits, 56, 'typing does not release the HQ hold');
  // A provider refusal releases the hold; the set stays open for typing.
  fake.mode = 'FAILED';
  const s6 = await newSet(a, 'STUDENT_CARDS', [[PHOTO, 'image/jpeg']]);
  const refusedRead = await readIt(a, s6);
  assert.deepEqual([refusedRead.set.status, refusedRead.aiReading?.status, refusedRead.aiReading?.reason, (await proposalOf(s6)).reserved_credits], ['OPEN', 'FAILED', 'PROVIDER_REJECTED', 0]);
  fake.mode = 'OK';
  pass('unknown: a lost outcome keeps its 56-credit hold in the HQ queue as TEXT_PROPOSAL, the set stays open and is never sent again, and staff can still type the rows; a provider refusal releases its hold');

  // 6. Not configured: nothing held; once the key and approval are present, the same reading proceeds.
  fake.ready = 'CONFIGURATION_REQUIRED';
  const s7 = await newSet(a, 'STUDENT_CARDS', [[PHOTO, 'image/jpeg']]);
  const notReady = await readIt(a, s7);
  assert.deepEqual([notReady.set.status, notReady.aiReading?.status, (await proposalOf(s7)).reserved_credits], ['OPEN', 'CONFIGURATION_REQUIRED', 0]);
  fake.ready = 'READY';
  const calls7 = fake.calls;
  assert.equal((await readIt(a, { ...s7, version: notReady.set.version })).set.readOutcome, 'AI_READ'); assert.equal(fake.calls, calls7 + 1);
  pass('not configured: without the provider key and approval nothing is held and the set stays open; the same reading proceeds later');

  // 7. In flight: typing is refused while the call is out; a set deleted mid-call records the cost and keeps no table.
  const gate = hold();
  const s8 = await newSet(a, 'STUDENT_CARDS', [[PHOTO, 'image/jpeg']]);
  const inFlight = readIt(a, s8);
  while (fake.inputs.length < calls7 + 2) await new Promise((r) => setTimeout(r, 20));
  const v8 = (await imports.detail(readCtx(a), s8.id)).set.version;
  assert.equal(code(await settle(imports.typeRows(readCtx(a), s8.id, { expectedVersion: v8 }))), 'PAPER_IMPORT_READING_BUSY');
  await imports.remove(ctx(a), s8.id, {});
  gate.release();
  const after8 = await inFlight;
  assert.deepEqual([after8.set.status, after8.rows.length], ['DELETED', 0]);
  const p8 = await proposalOf(s8);
  assert.deepEqual([p8.status, p8.reserved_credits, (await ledger(p8.id)).length], ['DISMISSED', 0, 1]);
  assert.equal((await setRow(s8)).table_rows, null);
  pass('in flight: typing is refused while HON is reading; a set deleted mid-call keeps no table, and the paid call is still recorded once');

  // 8. Gates: a Core plan, import staff without AI permission, someone else's reading, an HQ pause.
  const calls8 = fake.calls;
  const b = await makeOrg('b', { tier: 'CORE' });
  const sb = await newSet(b, 'STUDENT_CARDS', [[PHOTO, 'image/jpeg']]);
  assert.equal(code(await settle(readIt(b, sb))), 'PAPER_IMPORT_AI_FORBIDDEN');
  const typedB = await imports.typeRows(readCtx(b), sb.id, { expectedVersion: (await imports.detail(readCtx(b), sb.id)).set.version });
  assert.equal(typedB.set.readOutcome, 'TYPED', 'a Core school can always type the rows');
  const importer = await addStaff(a, 'importer', ['students.import']);
  const si = await newSet(importer, 'STUDENT_CARDS', [[PHOTO, 'image/jpeg']]);
  assert.equal(code(await settle(readIt(importer, si))), 'PAPER_IMPORT_AI_FORBIDDEN');
  assert.equal((await row('SELECT count(*)::int n FROM hon.ai_text_proposals WHERE organization_id=$1', [b.id])).n, 0);
  fake.ready = 'CONFIGURATION_REQUIRED';
  const s9 = await newSet(a, 'STUDENT_CARDS', [[PHOTO, 'image/jpeg']]);
  const mine = await readIt(a, s9);
  fake.ready = 'READY';
  const coOwner = await addStaff(a, 'coowner', (await rows('SELECT code FROM hon.permissions')).map((p) => p.code));
  assert.equal(code(await settle(imports.readPages(readCtx(coOwner), s9.id, { expectedVersion: mine.set.version }))), 'PAPER_IMPORT_READING_OWNED');
  const pause = await settle(admin.query('SELECT hon.command_ai_spend_pause($1,$2::jsonb,$3::uuid) r', [hq.subject, JSON.stringify({ action: 'PAUSE', organizationId: a.id, spendClass: 'AGENT_INFERENCE', reason: 'Paper AI synthetic pause for this proof' }), K()]));
  assert.equal(pause.value?.rows[0].r.status, 'ACTIVE', pause.error?.message);
  const paused = await settle(readIt(a, { ...s9, version: (await imports.detail(readCtx(a), s9.id)).set.version }));
  assert.deepEqual([code(paused), paused.error?.getResponse().reason], ['PAPER_IMPORT_AI_BLOCKED', 'AI_PAUSED_BY_HQ']);
  assert.equal(fake.calls, calls8);
  pass('gates: a Core plan or import staff without AI permission are refused before any proposal and can type the rows; another person cannot take over someone\'s reading; an HQ pause refuses before anything is sent');

  // 9. HQ usage: paper reading counts under its own agent, at the school that read.
  const usage = (await row('SELECT hon.read_ai_school_usage_from_hq($1,$2::timestamptz,$3::timestamptz) r', [hq.subject, new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString()])).r;
  const by = usage.schools.find((s) => s.schoolId === a.school).byClass.AGENT_INFERENCE.byAgent;
  assert(by.PAPER_READING?.credits >= 10, JSON.stringify(by));
  pass('usage: the HQ per-school read attributes paper reading to PAPER_READING');

  // 10. Guards: reader and outcome pairs are closed; the sample-only set still uses the stand-in with no provider call.
  await assert.rejects(admin.query("UPDATE hon.paper_import_sets SET version=version+1,status='READ',reader='NONE',read_outcome='AI_READ',read_at=now(),reading_id=gen_random_uuid(),reading_started_at=now(),table_rows='[]',table_unsure='[]' WHERE id=$1", [s9.id]));
  const calls10 = fake.calls;
  const sample = await newSet(a, 'STUDENT_CARDS', [[CARD, 'image/png']]);
  const resumed = await settle(admin.query('SELECT hon.command_ai_spend_pause($1,$2::jsonb,$3::uuid) r', [hq.subject, JSON.stringify({ action: 'RESUME', organizationId: a.id, spendClass: 'AGENT_INFERENCE', reason: 'Paper AI synthetic resume for this proof' }), K()]));
  assert(resumed.value, resumed.error?.message);
  const sampled = await readIt(a, sample);
  assert.deepEqual([sampled.set.reader, sampled.set.readOutcome, sampled.rows[0][0], sampled.aiReading], ['SYNTHETIC', 'SAMPLE_READ', 'Mina', null]);
  assert.equal(fake.calls, calls10);
  assert.equal(networkCalls, 0);
  pass('guards: reader and outcome pairs are closed in the database; a set of built-in sample pages never reaches the provider');
  console.log(`Paper import AI reader: ${groups} groups passed, ${fake.calls} fake provider calls, 0 network calls`);
} finally {
  await admin.end().catch(() => {});
  await db.onModuleDestroy?.().catch?.(() => {});
}
