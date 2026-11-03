/**
 * AI-0 spend-authority baseline. A REGRESSION BASELINE, NOT THE SECURITY FIX.
 *
 * - Invariants (INV-*) pin today's AI spend surface: entry points, grants, closed programs, nothing seeded,
 *   gates that refuse. Any silent change fails.
 * - Known failures (KNOWN_FAILURE_*) intentionally reproduce open vulnerabilities and pass only while they
 *   reproduce exactly as recorded in ai-spend-entrypoints.json. A fix must flip the entry to FIXED_BY_<slice>
 *   and add the matching invariant in the same reviewed PR (S4 for KF-AI2/AI3/AI9/AI14; the AI-D3 slice for KF-AI8).
 *   Fixed so far: KF-AI14 by S4-a (INV-13); KF-AI2 and KF-AI3 by S4-b (INV-14, INV-15).
 *
 * Disposable single-use fixture only (setup-ai-spend-baseline-validation.mjs recreates it every run).
 * Fake providers only; every network call is counted and refused. Synthetic approvals live only here.
 * `--print-inventory` prints the collected inventory for review and runs nothing else.
 */
import assert from 'node:assert/strict';
import { randomUUID as K } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { AI0_DATABASE as database, AI0_OWNER_ROLE as ownerRole, AI0_RUNTIME_ROLE as runtimeRole, assertDisposableTarget, assertNoLibpqOverrides } from './ai-spend-baseline-target.mjs';

const marker = 'HON disposable AI spend baseline validation';
// Both URLs are checked before any client exists. The socket-free negative cases run first, in every CI run.
await import('./test-ai-spend-baseline-target.mjs');
assertNoLibpqOverrides(process.env);
const ownerUrl = assertDisposableTarget(process.env.DATABASE_URL, ownerRole);
const runtimeUrl = assertDisposableTarget(process.env.HON_RUNTIME_DATABASE_URL, runtimeRole);
process.env.HON_RUNTIME_DATABASE_URL = runtimeUrl;
const forbidden = Object.keys(process.env).filter((k) => /^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|HEYGEN|HIGGSFIELD|GOOGLE_AI|GOOGLE_GENERATIVE|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(k));
if (forbidden.length) throw new Error(`AI-0 refuses provider, payment or execution variables (${forbidden.join(', ')}).`);
let networkCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { networkCalls += 1; throw new Error('EXTERNAL_NETWORK_FORBIDDEN'); };

const admin = new pg.Client({ connectionString: ownerUrl, ssl: false });
const row = async (sql, args = []) => (await admin.query(sql, args)).rows[0];
const rows = async (sql, args = []) => (await admin.query(sql, args)).rows;

// The explicit agent, planning and B3 spend surface (signatures are pinned in the inventory).
const SPEND_FUNCTION_NAMES = [
  'begin_marketing_request', 'prepare_marketing_invocation', 'record_marketing_result', 'fail_marketing_invocation',
  'begin_teaching_request', 'prepare_teaching_invocation', 'record_teaching_result', 'fail_teaching_invocation',
  'begin_chad_follow_up_request', 'prepare_chad_follow_up_invocation', 'record_chad_follow_up_result', 'fail_chad_follow_up_invocation',
  'plan_ai_invocation', 'require_ai_invocation_plan_access',
  'reserve_saas_premium_credits', 'settle_saas_premium_credits', 'saas_record_provider_usage', 'saas_current_allowance',
];
const AGENT_TABLES = ['marketing_ai_invocations', 'teaching_ai_invocations', 'chad_follow_up_invocations'];
const PROGRAMS = {
  credit: 'SELECT status,top_ups_enabled,overage_enabled FROM hon.saas_credit_program',
  trial: 'SELECT status,signup_enabled,enrollment_enabled,promotional_issuance_enabled FROM hon.saas_trial_program',
  access: 'SELECT status,mutations_enabled FROM hon.saas_access_program',
  payment: 'SELECT status,live_mode FROM hon.saas_payment_program',
};
const EMPTY_AT_START = ['saas_credit_allowances', 'saas_credit_reservations', 'saas_credit_ledger', 'ai_usage_ledger', 'saas_trial_policy_versions',
  'saas_trial_policy_decisions', 'saas_trial_campaign_versions', 'saas_trial_publications', 'saas_exception_policy_decisions', 'saas_access_exceptions',
  'saas_access_states', 'organizations', ...AGENT_TABLES];
const AI_POLICY_CODES = ['PLAN_ALLOWANCES', 'CREDIT_ROLLOVER', 'TOP_UP_PRICING', 'SUSPENDED_ALLOWANCE', 'FOUNDER_ALLOWANCE', 'PREMIUM_OPERATIONS'];

const functions = async (condition) => (await rows(`SELECT p.oid::regprocedure::text s FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace AND (${condition}) ORDER BY 1`)).map((r) => r.s);
const within = (list, regex) => `p.oid::regprocedure::text = ANY(ARRAY[${list.map((s) => `'${s}'`).join(',') || "''"}]) AND p.prosrc ~* '${regex}'`;

async function collectInventory() {
  const spendFunctions = await functions(`p.proname = ANY(ARRAY[${SPEND_FUNCTION_NAMES.map((n) => `'${n}'`).join(',')}])`);
  const agentFunctions = spendFunctions.filter((s) => /_(marketing|teaching|chad_follow_up)_/.test(s));
  const b3Functions = spendFunctions.filter((s) => /saas_/.test(s));
  const inventory = {
    spendTables: (await rows("SELECT DISTINCT c.relname n FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.relnamespace='hon'::regnamespace AND c.relkind IN ('r','p') AND a.attname IN ('reserved_credits','customer_credits') AND NOT a.attisdropped ORDER BY 1")).map((r) => r.n),
    spendFunctions,
    ledgerWriters: await functions("p.prosrc ~* 'insert\\s+into\\s+(hon\\.)?ai_usage_ledger'"),
    reservationWriters: await functions("p.prosrc ~* '\\mreserved_credits\\s*=' OR p.prosrc ~* 'insert\\s+into\\s+(hon\\.)?saas_credit_reservations'"),
    allowanceWriters: await functions("p.prosrc ~* '(insert\\s+into|update)\\s+(hon\\.)?saas_credit_allowances'"),
    creditLedgerWriters: await functions("p.prosrc ~* 'insert\\s+into\\s+(hon\\.)?saas_credit_ledger'"),
    budgetCeilingLiteral12000: await functions("p.prosrc ~ '\\m12000\\M'"),
    spendReferences: await functions("p.prosrc ~* '\\m(reserved_credits|customer_credits|ai_usage_ledger|saas_credit_(allowances|reservations|ledger|program))\\M'"),
    trialTableReaders: await functions("p.prosrc ~* '\\msaas_trial_(campaign_versions|policy_decisions|policy_versions|program|publications)\\M'"),
    accessStateReadersInSpendFunctions: await functions(within(spendFunctions, '\\msaas_access_(states|exceptions)\\M')),
    b3ReservationsInAgentFunctions: await functions(within(agentFunctions, 'saas_credit_reservations')),
    agentTablesInB3Functions: await functions(within(b3Functions, '(marketing_ai_invocations|teaching_ai_invocations|chad_follow_up_invocations)')),
  };
  const granted = [...new Set([...spendFunctions, ...inventory.ledgerWriters, ...inventory.reservationWriters, ...inventory.allowanceWriters, ...inventory.creditLedgerWriters, ...inventory.budgetCeilingLiteral12000])].sort();
  inventory.grants = {};
  for (const signature of granted) {
    const g = await row("SELECT has_function_privilege($2,p.oid,'EXECUTE') runtime,coalesce((SELECT bool_or(a.grantee=0 AND a.privilege_type='EXECUTE') FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a),false) public,p.prosecdef security_definer FROM pg_proc p WHERE p.oid=$1::regprocedure", [signature, runtimeRole]);
    inventory.grants[signature] = g;
  }
  inventory.runtimeSpendTablePrivileges = {};
  for (const table of inventory.spendTables) {
    inventory.runtimeSpendTablePrivileges[table] = await row(`SELECT ${['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].map((p) => `has_table_privilege($1,'hon.${table}','${p}') "${p.toLowerCase()}"`).join(',')}`, [runtimeRole]);
  }
  inventory.spendTableTriggers = {};
  for (const table of inventory.spendTables) inventory.spendTableTriggers[table] = (await rows(`SELECT tgname FROM pg_trigger WHERE tgrelid='hon.${table}'::regclass AND NOT tgisinternal ORDER BY 1`)).map((r) => r.tgname);
  inventory.programs = {};
  for (const [name, sql] of Object.entries(PROGRAMS)) inventory.programs[name] = await row(sql);
  inventory.aiPolicyRecords = await rows('SELECT policy_code,version,status,decision_code,actions_enabled FROM hon.saas_policy_records WHERE policy_code=ANY($1) ORDER BY policy_code,version', [AI_POLICY_CODES]);
  return inventory;
}

await admin.connect();
const identity = await row("SELECT current_database() db,current_user usr,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()");
assert.deepEqual(identity, { db: database, usr: ownerRole, marker });
{
  // The runtime alias must reach the same disposable database as the runtime role, before any service uses it.
  const probe = new pg.Client({ connectionString: runtimeUrl, ssl: false });
  await probe.connect();
  try {
    const actual = (await probe.query("SELECT current_database() db,current_user usr,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
    assert.deepEqual(actual, { db: database, usr: runtimeRole, marker });
  } finally { await probe.end(); }
}
if (process.argv.includes('--print-inventory')) {
  console.log(JSON.stringify(await collectInventory(), null, 2));
  await admin.end();
  process.exit(0);
}
const expected = JSON.parse(await readFile(new URL('./ai-spend-entrypoints.json', import.meta.url), 'utf8'));
const knownFailure = (id) => { const k = expected.knownFailures.find((f) => f.id === id); assert(k, `Missing known failure ${id}`); return k; };

const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { AiInvocationPlanService } = await import('../../../apps/api/dist/ai/ai-invocation-plan.service.js');
const { ActionEngineService } = await import('../../../apps/api/dist/action/action-engine.service.js');
const { MarketingAssistantService } = await import('../../../apps/api/dist/marketing/marketing-assistant.service.js');
const { TeachingAssistantService } = await import('../../../apps/api/dist/teaching-assistant/teaching-assistant.service.js');
const { ChadFollowUpAssistantService } = await import('../../../apps/api/dist/chad-follow-up-assistant/chad-follow-up-assistant.service.js');
const { ProviderRuntimeError } = await import('../../../apps/api/dist/ai/provider-runtime.js');
const { ClaireProviderRuntimeError } = await import('../../../apps/api/dist/ai/claire-provider-runtime.js');
const { ChadProviderRuntimeError } = await import('../../../apps/api/dist/ai/chad-provider-runtime.js');
const { CampaignService } = await import('../../../apps/api/dist/marketing/campaign.service.js');
const { SaasBillingService } = await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const { SaasSchoolBillingService } = await import('../../../apps/api/dist/school-billing/saas-school-billing.service.js');
const db = new RuntimeDatabaseService(), plans = new AiInvocationPlanService(db), actions = new ActionEngineService(db);
const campaigns = new CampaignService(db), billing = new SaasBillingService(db), schoolBilling = new SaasSchoolBillingService(billing);

let providerCalls = 0;
function fakeProvider(ErrorType, draft) {
  const provider = { calls: 0, mode: 'RESULT', held: [] };
  provider.readiness = () => 'READY';
  provider.generate = async () => {
    provider.calls += 1; providerCalls += 1;
    if (provider.mode === 'HOLD') return new Promise((resolve, reject) => provider.held.push({ resolve, reject }));
    if (provider.mode === 'UNKNOWN') throw new ErrorType('UNKNOWN', 'PROVIDER_UNKNOWN');
    if (provider.mode === 'FAILED') throw new ErrorType('FAILED', 'PROVIDER_REJECTED');
    return { draft, inputTokens: 200, outputTokens: 100, providerCostMicrounits: 600 };
  };
  // Held calls end as an ordinary provider rejection, which releases their reservations.
  provider.release = () => { for (const h of provider.held.splice(0)) h.reject(new ErrorType('FAILED', 'PROVIDER_REJECTED')); };
  // Held calls end with an ordinary result (used to prove evidence still records after a mid-flight lapse).
  provider.complete = () => { for (const h of provider.held.splice(0)) h.resolve({ draft, inputTokens: 200, outputTokens: 100, providerCostMicrounits: 600 }); };
  return provider;
}
const fakes = {
  marcus: fakeProvider(ProviderRuntimeError, { title: 'Welcome to beginner classes', content: 'Discover martial arts in a friendly setting. Ask [school name] about [class times].' }),
  claire: fakeProvider(ClaireProviderRuntimeError, { title: 'Practice outline', content: 'Warm up, demonstrate the sequence, then guide controlled practice.' }),
  chad: fakeProvider(ChadProviderRuntimeError, { subject: 'A friendly check-in', content: 'Please reply when a human team member can help with a trial class.' }),
};
const agents = {
  marcus: { table: 'marketing_ai_invocations', estimate: 6, hold: 'hold_marketing_result', record: 'record_marketing_result', draft: { title: 'Replay', content: 'Replay' }, service: new MarketingAssistantService(db, plans, actions, fakes.marcus), input: (o) => ({ campaignId: o.campaign, request: 'Write a friendly beginner classes introduction. Use placeholders for unprovided facts.' }) },
  claire: { table: 'teaching_ai_invocations', estimate: 6, hold: 'hold_teaching_result', record: 'record_teaching_result', draft: { title: 'Replay', content: 'Replay' }, service: new TeachingAssistantService(db, plans, actions, fakes.claire), input: (o) => ({ curriculumId: o.curriculum, brief: 'Synthetic AI-0 practice outline' }) },
  chad: { table: 'chad_follow_up_invocations', estimate: 3, hold: 'hold_chad_follow_up_result', record: 'record_chad_follow_up_result', draft: { subject: 'Replay', content: 'Replay' }, service: new ChadFollowUpAssistantService(db, plans, actions, fakes.chad), input: (o) => ({ leadId: o.lead, expectedLeadVersion: 1, purpose: 'CHECK_IN' }) },
};

const results = { invariants: [], knownFailures: [] };
const pass = (id, name) => { results.invariants.push(id); console.log(`PASS AI-0 ${id}: ${name}`); };
const catalog = K(), hq = { id: K(), user: K(), subject: `ai0-hq-owner-${K()}` };
const orgs = [];
const context = (o, patch = {}) => ({ organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: K(), correlationId: K(), idempotencyKey: K(), ...patch });

async function makeOrg(label) {
  const o = { label, id: K(), school: K(), user: K(), principal: K(), role: K(), subject: `ai0-${label}-${K()}`, campaign: null, curriculum: K(), person: K(), pipeline: K(), stage: K(), lead: K(), policy: K() };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'AI-0 synthetic organization','AI-0 synthetic organization')", [o.id]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'AI-0 synthetic school',$1::uuid::text,'UTC')", [o.school, o.id]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day')", [o.id]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','AI-0 synthetic owner')", [o.user, o.subject]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'AI-0 synthetic owner')", [o.principal, o.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','AI-0 synthetic owner',true)", [o.role, o.id]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions', [o.role, o.id]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')", [o.id, o.school, o.principal, o.role]);
  await admin.query("INSERT INTO hon.curricula(id,organization_id,school_id,name,description,lifecycle,model_code) VALUES($1,$2,$3,'AI-0 synthetic curriculum','Synthetic bounded curriculum facts only','PUBLISHED','LINEAR')", [o.curriculum, o.id, o.school]);
  await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email) VALUES($1,$2,$3,'Synthetic','Lead','synthetic-lead@example.test')", [o.person, o.id, o.school]);
  await admin.query("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'AI-0 pipeline')", [o.pipeline, o.id, o.school]);
  await admin.query("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,$4,'New',1)", [o.stage, o.id, o.school, o.pipeline]);
  await admin.query("INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status,source_code) VALUES($1,$2,$3,$4,$5,$6,'OPEN','AI0')", [o.lead, o.id, o.school, o.person, o.pipeline, o.stage]);
  await admin.query("INSERT INTO hon.hq_ai_routing_policies(policy_id,organization_id,school_id,capability,active,minimum_tier,max_cost_micros,effective_from) VALUES($1,$2,$3,'TEXT',true,'COMPLETE',100000,'2020-01-01')", [o.policy, o.id, o.school]);
  await admin.query('INSERT INTO hon.hq_ai_routing_candidates(policy_id,ordinal,catalog_id) VALUES($1,0,$2)', [o.policy, catalog]);
  for (const code of ['marketing.draft.save', 'teaching.draft.save', 'crm.follow_up_draft.propose']) {
    await admin.query("INSERT INTO hon.action_policies(organization_id,school_id,action_code,authority_mode,policy_version,effective_from) VALUES($1,$2,$3,'CONFIRM',1,clock_timestamp()-interval '1 day')", [o.id, o.school, code]);
  }
  await admin.query('COMMIT');
  const start = new Date(Date.now() + 3_600_000).toISOString(), end = new Date(Date.now() + 30 * 86_400_000).toISOString();
  o.campaign = (await campaigns.save(context(o), null, { expectedVersion: 0, code: 'AI0', name: 'AI-0 synthetic campaign', goal: 'Introduce beginner classes', offerLabel: '', channel: 'REFERRAL', startsAt: start, endsAt: end, plannedBudgetMinor: 0, currency: 'USD' })).campaign.id;
  orgs.push(o);
  return o;
}
const restoreEntitlement = (o) => admin.query("UPDATE hon.organization_entitlements SET tier='COMPLETE',status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=NULL WHERE organization_id=$1", [o.id]);
const setUsed = (o, credits) => admin.query("INSERT INTO hon.ai_usage_ledger(organization_id,school_id,provider_code,model_code,modality,customer_credits,correlation_id) VALUES($1,$2,'OPENROUTER','ai0-used-fixture','TEXT',$3,$4)", [o.id, o.school, credits, K()]);
const ledgerRows = async (o) => (await row('SELECT count(*)::int n FROM hon.ai_usage_ledger WHERE organization_id=$1', [o.id])).n;
const reservedByAgent = async (o) => {
  const out = {};
  for (const [name, a] of Object.entries(agents)) out[name] = Number((await row(`SELECT coalesce(sum(reserved_credits),0) n FROM hon.${a.table} WHERE organization_id=$1`, [o.id])).n);
  return out;
};
const committed = async (o) => {
  const used = Number((await row("SELECT coalesce(sum(customer_credits),0) n FROM hon.ai_usage_ledger WHERE organization_id=$1 AND occurred_at>=date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'", [o.id])).n);
  const reserved = Object.values(await reservedByAgent(o)).reduce((a, b) => a + b, 0);
  return { used, reserved, total: used + reserved };
};
const sendingCount = async (o) => { let n = 0; for (const a of Object.values(agents)) n += (await row(`SELECT count(*)::int n FROM hon.${a.table} WHERE organization_id=$1 AND status='SENDING'`, [o.id])).n; return n; };
const humanSource = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
/** The same tenant transaction the agent services use, for direct calls to their fixed functions. */
const tenant = (c, work) => db.withTenantTransaction(c, async (client) => { await client.query(humanSource); return work(client); });
const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

/** Starts a submit and resolves when its invocation is SENDING (held) or when the submit settles without sending. */
async function startHeld(name, o, patch = {}) {
  const a = agents[name], before = (await row(`SELECT count(*)::int n FROM hon.${a.table} WHERE organization_id=$1 AND status='SENDING'`, [o.id])).n;
  fakes[name].mode = 'HOLD';
  const submitted = settle(a.service.submit(context(o, patch), a.input(o)));
  let done = null; submitted.then((r) => { done = r; });
  for (const end = Date.now() + 15000; Date.now() < end; await sleep(20)) {
    if ((await row(`SELECT count(*)::int n FROM hon.${a.table} WHERE organization_id=$1 AND status='SENDING'`, [o.id])).n > before) return { sending: true, submitted };
    if (done) return { sending: false, submitted, settled: done };
  }
  throw new Error(`${name} neither reached SENDING nor settled`);
}

/** A refusal adds no SENDING row, reservation, ledger row or provider call. */
async function expectRefused(name, o, patch = {}, label = '') {
  const a = agents[name], calls = fakes[name].calls, ledger = await ledgerRows(o), reserved = (await reservedByAgent(o))[name], sending = await sendingCount(o);
  fakes[name].mode = 'RESULT';
  const r = await settle(a.service.submit(context(o, patch), a.input(o)));
  if (r.error) assert.equal(r.error?.getStatus?.(), 403, `${name} ${label}: ${r.error?.stack ?? r.error}`);
  else assert.equal(r.value.status, 'BLOCKED', `${name} ${label}: expected refusal, got ${JSON.stringify(r.value)}`);
  assert.equal(fakes[name].calls, calls, `${name} ${label}: provider must not be called`);
  assert.equal(await ledgerRows(o), ledger);
  assert.equal(await sendingCount(o), sending);
  assert.equal((await reservedByAgent(o))[name], reserved, `${name} ${label}: a refusal must not reserve`);
  return r.error ? 'HTTP_403' : `BLOCKED_${r.value.reason}`;
}

/** Known failure: passes only while the recorded vulnerable behavior reproduces. */
function reportKnownFailure(id, reproduced, detail, { mayNotReproduce = false } = {}) {
  const k = knownFailure(id);
  if (k.status !== 'OPEN') throw new Error(`${id} is ${k.status}; replace this probe with its invariant in the fixing PR.`);
  if (!reproduced && !mayNotReproduce) throw new Error(`${id} no longer reproduces while the inventory still says OPEN. Behavior changed silently: update ai-spend-entrypoints.json (FIXED_BY_<slice>) and add the replacing invariant in the reviewed fixing PR. Detail: ${detail}`);
  results.knownFailures.push({ id, finding: k.finding, replacedBy: k.replacedBy, reproduced, detail });
  console.log(`KNOWN-FAILURE (open, replaced by ${k.replacedBy}) ${id}: ${reproduced ? 'reproduced' : 'not reproduced'}: ${detail}`);
}

try {
  // ---- Static invariants on the pristine fixture ----
  const actual = await collectInventory();
  for (const key of ['spendTables', 'spendFunctions', 'ledgerWriters', 'reservationWriters', 'allowanceWriters', 'creditLedgerWriters', 'budgetCeilingLiteral12000', 'spendReferences', 'spendTableTriggers']) {
    assert.deepEqual(actual[key], expected[key], `INV-1 inventory drift in ${key}: review the new or removed AI spend path and update ai-spend-entrypoints.json in an owner-approved PR.`);
  }
  pass('INV-1', 'strict inventory of spend tables, functions, ledger/reservation/allowance writers, 12000 ceilings and spend triggers');

  assert.deepEqual(actual.grants, expected.grants, 'INV-2 grant drift');
  assert.deepEqual(actual.runtimeSpendTablePrivileges, expected.runtimeSpendTablePrivileges, 'INV-2 table privilege drift');
  for (const [signature, g] of Object.entries(actual.grants)) assert.equal(g.public, false, `${signature} is executable by PUBLIC`);
  for (const [table, p] of Object.entries(actual.runtimeSpendTablePrivileges)) assert(!p.insert && !p.update && !p.delete && !p.truncate, `runtime can write hon.${table} directly`);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    if (!(await row('SELECT 1 x FROM pg_roles WHERE rolname=$1', [role]))) continue;
    for (const signature of Object.keys(actual.grants)) assert.equal((await row("SELECT has_function_privilege($1,$2::regprocedure,'EXECUTE') x", [role, signature])).x, false, `${role} can execute ${signature}`);
  }
  pass('INV-2', 'grant matrix: runtime grants exactly as pinned, nothing for PUBLIC/anon/authenticated/service_role, no direct spend-table writes');

  assert.deepEqual(actual.programs, expected.programs, 'INV-3 program drift');
  assert.deepEqual(actual.programs.credit, { status: 'INACTIVE', top_ups_enabled: false, overage_enabled: false });
  assert.deepEqual(actual.programs.trial, { status: 'INACTIVE', signup_enabled: false, enrollment_enabled: false, promotional_issuance_enabled: false });
  assert.deepEqual(actual.programs.access, { status: 'INACTIVE', mutations_enabled: false });
  assert.equal(actual.programs.payment.live_mode, false);
  pass('INV-3', 'credit, trial, paid-access and payment programs closed');

  for (const table of EMPTY_AT_START) assert.equal((await row(`SELECT count(*)::int n FROM hon.${table}`)).n, 0, `INV-4 hon.${table} is seeded or the fixture is not pristine`);
  assert.deepEqual(actual.aiPolicyRecords, expected.aiPolicyRecords, 'INV-4 AI policy record drift');
  assert(actual.aiPolicyRecords.every((r) => r.actions_enabled === false));
  pass('INV-4', 'no allowance, reservation, credit ledger, trial, exception, access state or AI usage seeded; AI policy records pinned and inert');

  assert.deepEqual(actual.trialTableReaders, expected.trialTableReaders, 'INV-5 a new function reads trial tables');
  // read_saas_trial_governance only reads the credit program status for display; no writer or spend function may read trial tables.
  const spendWriters = new Set([...actual.spendFunctions, ...actual.ledgerWriters, ...actual.reservationWriters, ...actual.allowanceWriters, ...actual.creditLedgerWriters]);
  assert.deepEqual(actual.trialTableReaders.filter((s) => spendWriters.has(s)), [], 'INV-5 a spend path or spend writer reads trial tables');
  pass('INV-5', 'trial metadata is read only by trial-governance functions, never by a spend path');

  assert.deepEqual(actual.accessStateReadersInSpendFunctions, expected.accessStateReadersInSpendFunctions, 'INV-6 access state wired into a spend function outside S4');
  pass('INV-6', 'no spend function reads paid-access state or access exceptions directly (S4 changes this deliberately)');

  assert.deepEqual(actual.b3ReservationsInAgentFunctions, []);
  assert.deepEqual(actual.agentTablesInB3Functions, []);
  pass('INV-7', 'agent and B3 spend paths stay separate (no double debit path)');

  // ---- Shared synthetic provider route (fake provider only) ----
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state,credential_secret_ref) VALUES('OPENROUTER','AI-0 synthetic route','HEALTHY',$1)", [`hon-secret:${K()}`]);
  await admin.query("INSERT INTO hon.hq_ai_model_catalog(catalog_id,provider_id,model_id,display_name,capabilities,modalities,active,minimum_tier,unit_cost_micros,cost_unit,effective_from) VALUES($1,'OPENROUTER','approved/ai0-baseline','AI-0 synthetic model',ARRAY['TEXT'],ARRAY['TEXT'],true,'COMPLETE',2,'TOKEN','2020-01-01')", [catalog]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','AI-0 synthetic HQ owner')", [hq.user, hq.subject]);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','AI-0 synthetic HQ owner',true)", [hq.id, hq.user]);
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER','{}',clock_timestamp()-interval '2 days')", [hq.id]);
  await admin.query('COMMIT');

  // ---- INV-8: entitlement gate refuses for every agent ----
  const gate = await makeOrg('gate');
  const gateScenarios = [
    ['no entitlement row', () => admin.query('DELETE FROM hon.organization_entitlements WHERE organization_id=$1', [gate.id]),
      () => admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day')", [gate.id])],
    ['CORE ACTIVE', () => admin.query("UPDATE hon.organization_entitlements SET tier='CORE' WHERE organization_id=$1", [gate.id])],
    ['ESSENTIAL ACTIVE', () => admin.query("UPDATE hon.organization_entitlements SET tier='ESSENTIAL' WHERE organization_id=$1", [gate.id])],
    ['COMPLETE SUSPENDED', () => admin.query("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [gate.id])],
    ['COMPLETE expired', () => admin.query("UPDATE hon.organization_entitlements SET effective_until=clock_timestamp()-interval '1 minute' WHERE organization_id=$1", [gate.id])],
    ['COMPLETE not yet effective', () => admin.query("UPDATE hon.organization_entitlements SET effective_from=clock_timestamp()+interval '1 day' WHERE organization_id=$1", [gate.id])],
    ['school suspended', () => admin.query("UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1", [gate.school]), () => admin.query("UPDATE hon.schools SET status='ACTIVE' WHERE id=$1", [gate.school])],
    ['organization suspended', () => admin.query("UPDATE hon.organizations SET status='SUSPENDED' WHERE id=$1", [gate.id]), () => admin.query("UPDATE hon.organizations SET status='ACTIVE' WHERE id=$1", [gate.id])],
    ['ai.invocation.plan permission removed', () => admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='ai.invocation.plan'", [gate.role]),
      () => admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'ai.invocation.plan')", [gate.role, gate.id])],
    ['AI source context', null, null, { source: 'AI' }],
    ['delegated context', null, null, { delegatedByPrincipalId: gate.principal }],
  ];
  const gateOutcomes = {};
  for (const [label, apply, restore = () => restoreEntitlement(gate), patch = {}] of gateScenarios) {
    if (apply) await apply();
    try { for (const name of Object.keys(agents)) gateOutcomes[`${name}: ${label}`] = await expectRefused(name, gate, patch, label); }
    finally { if (apply) await restore(); }
  }
  pass('INV-8', `entitlement and identity gates refuse all three agents in ${gateScenarios.length} scenarios with no provider call, reservation or ledger row`);

  // ---- INV-10: B3 premium credits stay closed ----
  const b3 = await settle(billing.reservePremiumCredits(gate.subject, gate.school, { operationCode: 'ai.draft.text', units: 1, employeeKey: 'marcus', actionRequestId: null, workItemId: null }, K()));
  assert(b3.error, 'B3 reservation must be refused while the credit program is INACTIVE');
  assert.match(JSON.stringify(b3.error.getResponse?.() ?? b3.error.message), /SAAS_CREDITS_NOT_ACTIVE/, b3.error.stack);
  assert.equal((await row('SELECT count(*)::int n FROM hon.saas_credit_reservations')).n, 0);
  pass('INV-10', 'B3 premium reservation refused SAAS_CREDITS_NOT_ACTIVE for an active COMPLETE school; no reservation');

  // ---- INV-11: evidence path ----
  const evidence = await makeOrg('evidence');
  fakes.marcus.mode = 'RESULT';
  const evidenceContext = context(evidence);
  const recorded = await agents.marcus.service.submit(evidenceContext, agents.marcus.input(evidence));
  assert.equal(recorded.status, 'AWAITING_APPROVAL', JSON.stringify(recorded));
  assert.deepEqual(await rows("SELECT customer_credits::int c,provider_cost_microunits::int m FROM hon.ai_usage_ledger WHERE organization_id=$1", [evidence.id]), [{ c: 1, m: 600 }]);
  assert.equal((await agents.marcus.service.submit(evidenceContext, agents.marcus.input(evidence))).id, recorded.id);
  assert.equal(await ledgerRows(evidence), 1, 'replay must not record usage twice');
  for (const name of ['claire', 'chad']) {
    fakes[name].mode = 'FAILED';
    const failed = await agents[name].service.submit(context(evidence), agents[name].input(evidence));
    assert.equal(failed.status, 'FAILED', JSON.stringify(failed));
  }
  assert.deepEqual(await reservedByAgent(evidence), { marcus: 0, claire: 0, chad: 0 });
  assert.equal(await ledgerRows(evidence), 1);
  pass('INV-11', 'allowed legacy call records exactly one ledger row; replay records none; provider rejection releases the hold');

  // ---- INV-13 (S4-a, replaces KF-AI14): a charged result is always recorded, even after a mid-flight lapse ----
  // record_* and fail_* now check only tenant, requester and SENDING state. The full access gate stays on the
  // proposal step: a lapsed result is held (RESULT_HELD / ACCESS_LAPSED) and becomes a proposal only after access returns.
  const lapse = await makeOrg('inv-13');
  const resetPermission = () => admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'ai.invocation.plan') ON CONFLICT DO NOTHING", [lapse.role, lapse.id]);
  const lapses = [
    ['entitlement suspended', () => admin.query("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [lapse.id])],
    ['entitlement expired', () => admin.query("UPDATE hon.organization_entitlements SET effective_until=clock_timestamp()-interval '1 second' WHERE organization_id=$1", [lapse.id])],
    ['ai.invocation.plan permission removed', () => admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='ai.invocation.plan'", [lapse.role])],
  ];
  const lapseOutcomes = {};
  for (const [label, cut] of lapses) for (const name of Object.keys(agents)) {
    const a = agents[name];
    await restoreEntitlement(lapse); await resetPermission();
    const ledgerBefore = await ledgerRows(lapse), callsBefore = fakes[name].calls;
    const inFlight = await startHeld(name, lapse);
    assert(inFlight.sending, `${name} mid-flight call must reach SENDING`);
    await cut();
    fakes[name].complete();
    const settled = await inFlight.submitted;
    assert.equal(settled.error?.getStatus?.(), 403, `${name} ${label}: a held result is reported as no longer accessible`);
    const inv = await row(`SELECT i.id,i.status,i.reason,i.reserved_credits,i.action_request_id,i.usage_id,u.provider_cost_microunits cost,u.source_invocation_id src FROM hon.${a.table} i LEFT JOIN hon.ai_usage_ledger u ON u.id=i.usage_id WHERE i.organization_id=$1 ORDER BY i.created_at DESC LIMIT 1`, [lapse.id]);
    assert.equal(fakes[name].calls - callsBefore, 1, `${name} ${label}: exactly one provider call`);
    assert.equal((await ledgerRows(lapse)) - ledgerBefore, 1, `${name} ${label}: exactly one ledger row with provider cost`);
    assert.deepEqual({ status: inv.status, reason: inv.reason, reserved: inv.reserved_credits, action: inv.action_request_id, cost: Number(inv.cost), src: inv.src },
      { status: 'RESULT_HELD', reason: 'ACCESS_LAPSED', reserved: 0, action: null, cost: 600, src: inv.id }, `${name} ${label}: held with evidence, hold released, no proposal`);
    assert.equal(await sendingCount(lapse), 0, `${name} ${label}: nothing stranded in SENDING`);
    // While access is still lapsed a retry is refused and creates nothing.
    const early = await settle(a.service.generate(context(lapse), inv.id));
    assert.equal(early.error?.getStatus?.(), 403, `${name} ${label}: retry refused while lapsed`);
    // After access returns, retry binds the held result exactly once and never calls the provider.
    await restoreEntitlement(lapse); await resetPermission();
    const resumed = await a.service.generate(context(lapse), inv.id);
    assert.equal(resumed.status, 'AWAITING_APPROVAL', `${name} ${label}: held result becomes a proposal after access returns`);
    const again = await a.service.generate(context(lapse), inv.id);
    assert.equal(again.status, 'AWAITING_APPROVAL');
    assert.equal(fakes[name].calls - callsBefore, 1, `${name} ${label}: recovery never calls the provider`);
    assert.equal((await ledgerRows(lapse)) - ledgerBefore, 1, `${name} ${label}: recovery adds no ledger row`);
    assert.equal((await row('SELECT count(*)::int n FROM hon.action_requests WHERE organization_id=$1 AND id=(SELECT action_request_id FROM hon.' + a.table + ' WHERE id=$2)', [lapse.id, inv.id])).n, 1);
    lapseOutcomes[`${name}: ${label}`] = 'RESULT_HELD -> AWAITING_APPROVAL';
  }
  await restoreEntitlement(lapse); await resetPermission();

  // A failed proposal (transaction 2) never rolls back recorded usage; hold is refused while access is current.
  const proposeInTransaction = actions.proposeInTransaction;
  for (const name of Object.keys(agents)) {
    const a = agents[name], ledgerBefore = await ledgerRows(lapse);
    actions.proposeInTransaction = async () => { throw new Error('synthetic proposal failure'); };
    fakes[name].mode = 'RESULT';
    const failed = await settle(a.service.submit(context(lapse), a.input(lapse)));
    actions.proposeInTransaction = proposeInTransaction;
    assert.equal(failed.error?.message, 'synthetic proposal failure', `${name}: the proposal failure surfaces unchanged`);
    const inv = await row(`SELECT id,status,reserved_credits,usage_id FROM hon.${a.table} WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 1`, [lapse.id]);
    assert.deepEqual({ status: inv.status, reserved: inv.reserved_credits, recorded: inv.usage_id !== null }, { status: 'RESULT_RECORDED', reserved: 0, recorded: true }, `${name}: usage survives a failed proposal`);
    assert.equal((await ledgerRows(lapse)) - ledgerBefore, 1);
    const hold = await settle(tenant(context(lapse), (c) => c.query(`SELECT hon.${a.hold}($1,$2::uuid)`, [lapse.subject, inv.id])));
    assert.equal(hold.error?.code, '55000', `${name}: hold refused while access is current`);
    const replay = await settle(tenant(context(lapse), (c) => c.query(`SELECT hon.${a.record}($1,$2::uuid,$3::jsonb)`, [lapse.subject, inv.id, JSON.stringify({ draft: a.draft, inputTokens: 200, outputTokens: 100, providerCostMicrounits: 600 })])));
    assert.equal(replay.error?.code, '40001', `${name}: a replayed record is refused`);
    const duplicate = await settle(admin.query("INSERT INTO hon.ai_usage_ledger(organization_id,school_id,provider_code,model_code,modality,customer_credits,correlation_id,source_invocation_id) VALUES($1,$2,'OPENROUTER','ai0-duplicate','TEXT',1,$3,$4)", [lapse.id, lapse.school, K(), inv.id]));
    assert.equal(duplicate.error?.code, '23505', `${name}: a second ledger row for one invocation is refused`);
    assert.equal((await a.service.generate(context(lapse), inv.id)).status, 'AWAITING_APPROVAL', `${name}: retry binds the recorded result`);
    assert.equal((await ledgerRows(lapse)) - ledgerBefore, 1);
  }
  pass('INV-13', `S4-a: a charged result records exactly one ledger row after a mid-flight lapse (${Object.keys(lapseOutcomes).length} agent/lapse cases), is held without a proposal, and binds once after access returns; usage survives a failed proposal; replay and duplicate ledger rows refused`);

  // ---- INV-14 (S4-b, replaces KF-AI2): one organization budget across all three agents ----
  // At used 11,990 the organization has room for 10 credits. In every arrival order the agents are admitted
  // greedily against ONE organization total (Marcus 6, Claire 6, Chad 3); a refused agent is BLOCKED with
  // CUSTOMER_BUDGET_EXCEEDED before any provider call, and committed never exceeds the 12,000 ceiling.
  const orders = [['marcus', 'claire', 'chad'], ['marcus', 'chad', 'claire'], ['claire', 'marcus', 'chad'], ['claire', 'chad', 'marcus'], ['chad', 'marcus', 'claire'], ['chad', 'claire', 'marcus']];
  const orderOutcomes = [];
  for (const order of orders) {
    const o = await makeOrg(`inv-14-${order.join('-')}`);
    await setUsed(o, 11990);
    const callsBefore = Object.fromEntries(Object.keys(fakes).map((n) => [n, fakes[n].calls]));
    const held = [], admitted = [], refused = [];
    let room = 10;
    for (const name of order) {
      const h = await startHeld(name, o);
      held.push(h);
      const expectAdmit = agents[name].estimate <= room;
      if (expectAdmit) room -= agents[name].estimate;
      if (h.sending) admitted.push(name);
      else {
        assert.equal(h.settled.value?.status, 'BLOCKED', `${order}: ${name} refusal must be durable BLOCKED: ${JSON.stringify(h.settled)}`);
        const reason = (await row(`SELECT reason FROM hon.${agents[name].table} WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 1`, [o.id])).reason;
        assert.equal(reason, 'CUSTOMER_BUDGET_EXCEEDED');
        refused.push(name);
      }
      assert.equal(h.sending, expectAdmit, `${order.join('>')}: ${name} expected ${expectAdmit ? 'admitted' : 'refused'} against the organization total`);
      const c = await committed(o);
      assert(c.total <= 12000, `${order.join('>')}: committed ${c.total} exceeds the 12,000 ceiling`);
    }
    for (const name of refused) assert.equal(fakes[name].calls, callsBefore[name], `${name} refused but reached the provider`);
    for (const name of Object.keys(fakes)) fakes[name].release();
    await Promise.all(held.map((h) => h.submitted));
    assert.deepEqual(await reservedByAgent(o), { marcus: 0, claire: 0, chad: 0 });
    orderOutcomes.push(`${order.join('>')}: admitted ${admitted.join('+')}, refused ${refused.join('+') || 'none'}`);
  }
  pass('INV-14', `S4-b: one organization agent budget at used 11990 in all 6 arrival orders, committed <= 12000, refusals BLOCKED before any provider call (${orderOutcomes.join('; ')})`);

  // ---- INV-16 (S4-c, replaces KF-AI9): an HQ access exception grants product access, never AI spend (AI-D1 = A) ----
  const x = await makeOrg('inv-16');
  await admin.query("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [x.id]);
  assert.equal(await expectRefused('marcus', x, {}, 'suspended before exception'), 'HTTP_403');
  const view = await schoolBilling.readExceptionPolicy(hq.subject);
  // Synthetic approval ONLY in this disposable database; never a seed or operational approval. Decisions bind to the
  // latest proposed paid-access terms version (2 since 0192), so a v1 approval cannot authorize a grant.
  const termsVersion = Number((await row('SELECT max(policy_version) v FROM hon.saas_access_policy_terms')).v);
  await schoolBilling.decideExceptionPolicy(hq.subject, { expectedRevision: view.current?.revision ?? 0, decision: 'APPROVED', termsVersion, maxDays: 90,
    validFrom: new Date(Date.now() - 60_000).toISOString(), validUntil: new Date(Date.now() + 86_400_000).toISOString(),
    reason: 'DISPOSABLE SYNTHETIC AI-0 TEST ONLY; no operational policy approval', confirmation: 'APPROVE_ACCESS_EXCEPTION_POLICY_ONLY' }, K());
  const versionOf = async (o) => (await row('SELECT version FROM hon.organization_entitlements WHERE organization_id=$1', [o.id])).version;
  const grantFor = async (o, scopeTier, ms) => schoolBilling.grantAccessException(hq.subject, o.id, { schoolId: o.school, purpose: 'INTERNAL_TESTING', reason: 'Disposable synthetic AI-0 exception only', scopeTier,
    startsAt: new Date().toISOString(), expiresAt: new Date(Date.now() + ms).toISOString(), expectedEntitlementVersion: await versionOf(o) }, K());
  const grant = (scopeTier, ms) => grantFor(x, scopeTier, ms);
  const decision = async (o, cls = 'AGENT_INFERENCE') => (await row("SELECT hon.ai_spend_allowed($1,clock_timestamp(),$2) d", [o.id, cls])).d;
  const granted = await grant('COMPLETE', 86_400_000);
  const aiCredits = JSON.stringify(granted).match(/"aiCredits":"([A-Z_]+)"/)?.[1];
  assert.equal(aiCredits, 'NONE', `exception receipt must state aiCredits NONE: ${JSON.stringify(granted)}`);
  assert.equal(await decision(x), 'AI_EXCEPTION_NO_AI');
  assert.equal(await decision(x, 'CREATIVE_MEDIA'), 'AI_EXCEPTION_NO_AI');
  const beginRefusals = {};
  for (const name of Object.keys(agents)) beginRefusals[name] = await expectRefused(name, x, {}, 'COMPLETE exception on an unpaid school');
  assert.deepEqual(Object.values(beginRefusals), ['HTTP_403', 'HTTP_403', 'HTTP_403']);
  // Prepare and in-flight edges on a legacy school that receives an exception: a request begun before the grant is
  // refused at prepare (reserve guard) with no provider call; a call already SENDING at grant time still records.
  const y = await makeOrg('inv-16-inflight');
  const begunBefore = {}, inflight = {};
  for (const name of Object.keys(agents)) {
    fakes[name].readiness = () => 'NOT_CONFIGURED';
    begunBefore[name] = (await agents[name].service.submit(context(y), agents[name].input(y))).id;
    fakes[name].readiness = () => 'READY';
    inflight[name] = await startHeld(name, y);
    assert(inflight[name].sending, `${name} must be SENDING before the grant`);
  }
  // Exceptions are granted only where no entitlement is in effect (D9): the school lapses, then HQ grants one.
  await admin.query("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [y.id]);
  await grantFor(y, 'COMPLETE', 86_400_000);
  assert.equal(await decision(y), 'AI_EXCEPTION_NO_AI');
  const yCalls = Object.fromEntries(Object.keys(fakes).map((n) => [n, fakes[n].calls])), yLedger = await ledgerRows(y);
  for (const name of Object.keys(agents)) {
    const refused = await settle(agents[name].service.generate(context(y), begunBefore[name]));
    assert.equal(refused.error?.getStatus?.(), 403, `${name}: prepare after the grant must be refused: ${JSON.stringify(refused.value ?? refused.error?.getResponse?.())}`);
    assert.equal(fakes[name].calls, yCalls[name], `${name}: refused prepare reached the provider`);
  }
  for (const name of Object.keys(fakes)) fakes[name].complete();
  await Promise.all(Object.values(inflight).map((h) => h.submitted));
  assert.equal(await ledgerRows(y) - yLedger, 3, 'calls in flight at grant time still record exactly one ledger row each');
  assert.equal(await sendingCount(y), 0);
  pass('INV-16', `S4-c: a live COMPLETE HQ exception (receipt aiCredits ${aiCredits}) refuses begin for all three agents and prepare for requests begun earlier (AI_EXCEPTION_NO_AI, no provider call); calls already in flight at grant time still record`);

  // ---- INV-9: exception lifecycle edges stop spend ----
  const exceptionId = JSON.stringify(granted).match(/"exceptionId":"([0-9a-f-]{36})"/)?.[1];
  assert(exceptionId, JSON.stringify(granted));
  await schoolBilling.revokeAccessException(hq.subject, exceptionId, { reason: 'Disposable synthetic AI-0 revocation' }, K());
  const afterRevoke = await expectRefused('marcus', x, {}, 'after exception revocation');
  const coreGrant = await grant('CORE', 86_400_000);
  const coreScope = await expectRefused('marcus', x, {}, 'CORE exception');
  await schoolBilling.revokeAccessException(hq.subject, JSON.stringify(coreGrant).match(/"exceptionId":"([0-9a-f-]{36})"/)[1], { reason: 'Disposable synthetic AI-0 revocation' }, K());
  await grant('COMPLETE', 3_000);
  await sleep(4_000);
  const afterExpiry = await expectRefused('marcus', x, {}, 'after exception expiry');
  pass('INV-9', `exception end stops spend without any job: revoked ${afterRevoke}, CORE scope ${coreScope}, expired ${afterExpiry}`);

  // ---- INV-17 (S4-c): every paid-access state maps to its documented decision; legacy is unchanged ----
  const mapping = { PAYMENT_ACTIVE: [null, 'AI_ACCESS_LAPSED'], CANCELLATION_SCHEDULED: [null, 'AI_ACCESS_LAPSED'], AWAITING_FIRST_PAYMENT: ['AI_ACCESS_NOT_PAID', 'AI_ACCESS_NOT_PAID'],
    REGISTERED: ['AI_ACCESS_NOT_PAID', 'AI_ACCESS_NOT_PAID'], TRIAL_ENDED: ['AI_ACCESS_NOT_PAID', 'AI_ACCESS_NOT_PAID'], TRIAL_ACTIVE: ['AI_TRIAL_FUNDING_NOT_APPROVED', 'AI_TRIAL_FUNDING_NOT_APPROVED'],
    PAST_DUE_GRACE: ['AI_ACCESS_PAST_DUE', 'AI_ACCESS_PAST_DUE'], SUSPENDED_NONPAYMENT: ['AI_ACCESS_SUSPENDED', 'AI_ACCESS_SUSPENDED'], REVIEW_HOLD: ['AI_ACCESS_REVIEW_HOLD', 'AI_ACCESS_REVIEW_HOLD'],
    ENDED: ['AI_ACCESS_ENDED', 'AI_ACCESS_ENDED'], SOMETHING_NEW: ['AI_ACCESS_UNKNOWN_STATE', 'AI_ACCESS_UNKNOWN_STATE'] };
  for (const [state, [inEffect, lapsed]] of Object.entries(mapping)) {
    assert.equal((await row('SELECT hon.ai_access_state_decision($1,true,false) d', [state])).d, inEffect, `${state} with entitlement in effect`);
    assert.equal((await row('SELECT hon.ai_access_state_decision($1,false,false) d', [state])).d, lapsed, `${state} with entitlement lapsed`);
  }
  assert.equal((await row("SELECT hon.ai_access_state_decision('TRIAL_ACTIVE',true,true) d")).d, null, 'trial funding hook, once approved, is the only trial path');
  const legacy = await makeOrg('inv-17-legacy');
  assert.equal(await decision(legacy), null, 'legacy organization (no access-state row, no exception) is unchanged');
  // Real rows inside a rolled-back transaction (the proof leaves no access-state rows behind, INV-12).
  await admin.query('BEGIN');
  try {
    await admin.query("INSERT INTO hon.saas_access_states(organization_id,state,reason,version,changed_by_principal_id,created_at,updated_at) VALUES($1,'AWAITING_FIRST_PAYMENT','AWAITING_INITIAL_PAYMENT',1,$2,clock_timestamp(),clock_timestamp())", [legacy.id, legacy.principal]);
    assert.equal(await decision(legacy), 'AI_ACCESS_NOT_PAID');
    await admin.query("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [legacy.id]);
    assert.equal(await decision(legacy), 'AI_ACCESS_NOT_PAID');
  } finally { await admin.query('ROLLBACK'); }
  assert.equal(await decision(legacy), null);
  pass('INV-17', `S4-c: ${Object.keys(mapping).length} access states map to documented decisions in both entitlement conditions (unknown -> AI_ACCESS_UNKNOWN_STATE, trial only via the unapproved funding hook); a real AWAITING_FIRST_PAYMENT row refuses; legacy unchanged`);

  // ---- INV-18 (S4-c): HQ emergency AI pause, human HQ owner only ----
  const paused = await makeOrg('inv-18');
  const pauseCmd = (subject, input, key) => settle(admin.query('SELECT hon.command_ai_spend_pause($1,$2::jsonb,$3::uuid) r', [subject, JSON.stringify(input), key]));
  const pIn = (action, organizationId, spendClass = 'AGENT_INFERENCE') => ({ action, organizationId, spendClass, reason: 'Disposable synthetic AI-0 pause test' });
  assert.equal((await pauseCmd(paused.subject, pIn('PAUSE', paused.id), K())).error?.code, '42501', 'a school owner cannot pause');
  for (const bad of [{}, { action: 'PAUSE' }, { ...pIn('PAUSE', paused.id), extra: 1 }, { ...pIn('PAUSE', paused.id), spendClass: 'HQ_INTERNAL' }, { ...pIn('PAUSE', paused.id), reason: 'short' }])
    assert.equal((await pauseCmd(hq.subject, bad, K())).error?.code, '22023', `invalid pause input ${JSON.stringify(bad)}`);
  const pk = K();
  const pauseA = await pauseCmd(hq.subject, pIn('PAUSE', paused.id), pk);
  assert.equal(pauseA.value?.rows[0].r.status, 'ACTIVE', JSON.stringify(pauseA.error?.message));
  assert.equal((await pauseCmd(hq.subject, pIn('PAUSE', paused.id), pk)).value?.rows[0].r.replayed, true, 'pause replay');
  assert.equal((await pauseCmd(hq.subject, { ...pIn('PAUSE', paused.id), reason: 'A different synthetic pause reason' }, pk)).error?.code, '23505', 'pause key reuse');
  assert.equal((await pauseCmd(hq.subject, pIn('PAUSE', paused.id), K())).error?.message, 'AI_SPEND_PAUSE_ALREADY_ACTIVE', 'second active pause for the same scope');
  assert.equal(await decision(paused), 'AI_PAUSED_BY_HQ');
  assert.equal(await decision(paused, 'CREATIVE_MEDIA'), null, 'an agent pause does not pause creative');
  assert.equal(await decision(legacy), null, 'an organization pause does not affect another organization');
  for (const name of Object.keys(agents)) assert.equal(await expectRefused(name, paused, {}, 'HQ pause'), 'HTTP_403');
  const rk = K();
  assert.equal((await pauseCmd(hq.subject, pIn('RESUME', paused.id), rk)).value?.rows[0].r.status, 'ENDED');
  assert.equal((await pauseCmd(hq.subject, pIn('RESUME', paused.id), rk)).value?.rows[0].r.replayed, true, 'resume replay');
  assert.equal((await pauseCmd(hq.subject, pIn('RESUME', paused.id), K())).error?.message, 'AI_SPEND_PAUSE_NOT_ACTIVE', 'nothing left to resume');
  assert.equal(await decision(paused), null);
  fakes.claire.mode = 'RESULT';
  assert.equal((await agents.claire.service.submit(context(paused), agents.claire.input(paused))).status, 'AWAITING_APPROVAL', 'spend resumes after the pause ends');
  // Platform-wide pause for all classes, then resume.
  const platformKey = K();
  assert.equal((await pauseCmd(hq.subject, pIn('PAUSE', null, 'ALL'), platformKey)).value?.rows[0].r.status, 'ACTIVE');
  assert.equal(await decision(legacy), 'AI_PAUSED_BY_HQ');
  assert.equal(await decision(legacy, 'CREATIVE_MEDIA'), 'AI_PAUSED_BY_HQ');
  assert.equal((await pauseCmd(hq.subject, pIn('RESUME', null, 'ALL'), K())).value?.rows[0].r.status, 'ENDED');
  assert.equal(await decision(legacy), null);
  assert.equal((await settle(admin.query('UPDATE hon.ai_spend_pauses SET reason=$1', ['Tampered synthetic pause reason']))).error?.code, '55000', 'pause records are append-only');
  assert.equal((await settle(admin.query('DELETE FROM hon.ai_spend_pauses'))).error?.code, '55000');
  const listed = (await row('SELECT hon.read_ai_spend_pauses_from_hq($1) r', [hq.subject])).r.pauses;
  assert.equal(listed.filter((p) => p.status === 'ENDED').length >= 2, true);
  assert.equal((await settle(admin.query('SELECT hon.read_ai_spend_pauses_from_hq($1)', [paused.subject]))).error?.code, '42501', 'a school owner cannot read HQ pauses');
  pass('INV-18', 'S4-c: HQ-owner-only organization and platform AI pause/resume, idempotent per key, one active pause per scope, class-scoped, append-only; agents refused while paused and resume afterwards');

  // ---- INV-19 (S4-d, replaces KF-AI8): lost outcomes count only in the window in which they were held ----
  {
  const backdate = async (table, id, interval, status = null) => {
    await admin.query('BEGIN');
    await admin.query(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);
    await admin.query(`UPDATE hon.${table} SET status=coalesce($3,status),created_at=created_at-$2::interval,updated_at=clock_timestamp()-$2::interval WHERE id=$1`, [id, interval, status]);
    await admin.query(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`);
    await admin.query('COMMIT');
  };
  const lostOutcome = async (label, name = 'marcus') => {
    const o = await makeOrg(label);
    fakes[name].mode = 'UNKNOWN';
    const view = await agents[name].service.submit(context(o), agents[name].input(o));
    fakes[name].mode = 'RESULT';
    assert.equal(view.status, 'UNKNOWN', JSON.stringify(view));
    assert.equal((await reservedByAgent(o))[name], agents[name].estimate);
    return { o, id: view.id };
  };
  const admitted = async (name, o, label) => {
    fakes[name].mode = 'RESULT';
    const view = await agents[name].service.submit(context(o), agents[name].input(o));
    assert.equal(view.status, 'AWAITING_APPROVAL', `${label}: ${JSON.stringify(view)}`);
  };
  // Pure rule: fresh SENDING always counts (even across a window boundary); lost outcomes only in their window.
  const holdCounts = async (status, ago, windowOffset) => (await row(`SELECT hon.ai_hold_counts($1, clock_timestamp()-$2::interval,
    hon.ai_spend_window(NULL, clock_timestamp()-$3::interval), clock_timestamp()) r`, [status, ago, windowOffset])).r;
  assert.equal(await holdCounts('SENDING', '5 minutes', '40 days'), true, 'an in-flight call always counts');
  assert.equal(await holdCounts('SENDING', '2 hours', '0 days'), true, 'a stale SENDING hold counts in its own window');
  assert.equal(await holdCounts('SENDING', '40 days', '0 days'), false, 'a stale SENDING hold from an earlier window does not');
  assert.equal(await holdCounts('UNKNOWN', '1 minute', '0 days'), true);
  assert.equal(await holdCounts('UNKNOWN', '40 days', '0 days'), false);
  // Last window's UNKNOWN Marcus hold no longer blocks Marcus or Claire this window.
  const old = await lostOutcome('inv-19-old');
  await backdate(agents.marcus.table, old.id, '40 days');
  await setUsed(old.o, 11990);
  await admitted('claire', old.o, 'a last-window UNKNOWN hold must not block another agent');
  await admitted('marcus', old.o, 'a last-window UNKNOWN hold must not block its own agent');
  // This window's UNKNOWN hold still counts.
  const cur = await lostOutcome('inv-19-current');
  await setUsed(cur.o, 11990);
  assert.equal(await expectRefused('claire', cur.o, {}, 'current-window UNKNOWN hold'), 'BLOCKED_CUSTOMER_BUDGET_EXCEEDED');
  // A stale SENDING hold (provider answered, nothing recorded) from last window: same rule; from this window: counts.
  const staleOld = await lostOutcome('inv-19-stale-old', 'claire');
  await backdate(agents.claire.table, staleOld.id, '40 days', 'SENDING');
  await setUsed(staleOld.o, 11990);
  await admitted('marcus', staleOld.o, 'a last-window stale SENDING hold must not block');
  const staleCur = await lostOutcome('inv-19-stale-current', 'chad');
  await backdate(agents.chad.table, staleCur.id, '2 hours', 'SENDING');
  await setUsed(staleCur.o, 11994);
  assert.equal(await expectRefused('claire', staleCur.o, {}, 'current-window stale SENDING hold'), 'BLOCKED_CUSTOMER_BUDGET_EXCEEDED');
  // Late provider evidence through the agent path stays refused; only the HQ resolution below can settle it.
  const lateFail = await settle(tenant(context(old.o), (client) => client.query("SELECT hon.fail_marketing_invocation($1,$2::uuid,'FAILED','PROVIDER_REJECTED')", [old.o.subject, old.id])));
  assert.equal(lateFail.error?.message, 'MARKETING_OUTCOME_REPLAY');
  // The HQ queue lists every open lost outcome, with whether it still limits its school.
  const queue = (await row('SELECT hon.read_ai_unknown_invocations_from_hq($1) r', [hq.subject])).r;
  const item = (id) => queue.open.find((q) => q.invocationId === id);
  assert.deepEqual([item(old.id)?.agent, item(old.id)?.countsAgainstCurrentWindow, item(old.id)?.reservedCredits], ['MARKETING', false, 6]);
  assert.deepEqual([item(cur.id)?.countsAgainstCurrentWindow, item(staleOld.id)?.status, item(staleOld.id)?.countsAgainstCurrentWindow, item(staleCur.id)?.agent],
    [true, 'SENDING', false, 'CHAD_FOLLOW_UP']);
  assert.equal(queue.staleAfterSeconds, 3600);
  assert.equal((await settle(admin.query('SELECT hon.read_ai_unknown_invocations_from_hq($1)', [old.o.subject]))).error?.code, '42501', 'a school owner cannot read the HQ queue');
  pass('INV-19', 'S4-d: UNKNOWN and stale SENDING holds count only in the window in which they were held (last-window holds no longer block any agent; current-window holds do; in-flight calls always count); late agent evidence stays refused; HQ queue lists all four with window status');

  // ---- INV-20 (S4-d): human HQ owner resolution with provider evidence (AI-D3) ----
  const resolve = (subject, agent, id, input, key = K()) => settle(admin.query('SELECT hon.resolve_ai_unknown_invocation($1,$2,$3::uuid,$4::jsonb,$5::uuid,$6::uuid,$7::uuid) r',
    [subject, agent, id, JSON.stringify(input), key, K(), K()]));
  const REASON = 'Synthetic AI-0 resolution from provider evidence';
  const recordInput = { decision: 'RECORD_PROVIDER_COST', reason: REASON, evidence: { providerGenerationId: 'gen-ai0-synthetic-1', inputTokens: 1200, outputTokens: 600, providerCostMicrounits: 2400 } };
  const ledgerFor = async (id) => rows('SELECT id,customer_credits::int c,provider_cost_microunits::bigint cost,input_units::int i,occurred_at FROM hon.ai_usage_ledger WHERE source_invocation_id=$1', [id]);
  assert.equal((await resolve(old.o.subject, 'MARKETING', old.id, recordInput)).error?.code, '42501', 'a school owner cannot resolve');
  for (const bad of [{ ...recordInput, extra: 1 }, { ...recordInput, decision: 'REFUND' }, { ...recordInput, reason: 'short' },
    { ...recordInput, evidence: { ...recordInput.evidence, inputTokens: -1 } }, { ...recordInput, evidence: { ...recordInput.evidence, inputTokens: '1200' } },
    { ...recordInput, evidence: { providerLookupReference: 'x' } }, { decision: 'WRITE_OFF', reason: REASON, evidence: {} }])
    assert.equal((await resolve(hq.subject, 'MARKETING', old.id, bad)).error?.code, '22023', JSON.stringify(bad));
  assert.equal((await resolve(hq.subject, 'IMAGES', old.id, recordInput)).error?.code, '22023', 'unknown agent');
  assert.equal((await resolve(hq.subject, 'MARKETING', K(), recordInput)).error?.code, 'P0002', 'unknown invocation');
  assert.equal((await resolve(hq.subject, 'TEACHING', old.id, recordInput)).error?.code, 'P0002', 'agent and invocation must match');
  // RECORD_PROVIDER_COST: one ledger row in the ORIGINAL window, hold released, replay-safe, then not resolvable again.
  const audits0 = (await row("SELECT count(*)::int n FROM hon.audit_events WHERE action_code='hq.ai.unknown_invocation.resolve'")).n;
  const key = K();
  const rec = await resolve(hq.subject, 'MARKETING', old.id, recordInput, key);
  const receipt = rec.value?.rows[0].r;
  assert.deepEqual([receipt?.decision, receipt?.releasedCredits, receipt?.customerCredits, receipt?.replayed], ['RECORD_PROVIDER_COST', 6, 2, false], JSON.stringify(rec.error?.message ?? receipt));
  const recLedger = await ledgerFor(old.id);
  assert.equal(recLedger.length, 1); assert.equal(recLedger[0].c, 2); assert.equal(Number(recLedger[0].cost), 2400);
  assert.equal((await row('SELECT $1::timestamptz <@ hon.ai_spend_window(NULL, clock_timestamp()) r', [recLedger[0].occurred_at])).r, false, 'recorded in the original window, not this one');
  assert.equal((await reservedByAgent(old.o)).marcus, 0);
  assert.equal((await resolve(hq.subject, 'MARKETING', old.id, recordInput, key)).value?.rows[0].r.replayed, true, 'replay');
  assert.equal((await ledgerFor(old.id)).length, 1, 'a replay writes nothing');
  assert.equal((await resolve(hq.subject, 'MARKETING', old.id, { ...recordInput, reason: 'A different synthetic resolution reason' }, key)).error?.code, '23505', 'key reuse');
  assert.equal((await resolve(hq.subject, 'MARKETING', old.id, recordInput)).error?.message, 'AI_UNKNOWN_NOT_RESOLVABLE', 'resolved once');
  const lateRecord = await settle(tenant(context(old.o), (client) => client.query('SELECT hon.record_marketing_result($1,$2::uuid,$3::jsonb)', [old.o.subject, old.id,
    JSON.stringify({ draft: { title: 'Late result', content: 'A late provider result.' }, inputTokens: 200, outputTokens: 100, providerCostMicrounits: 600 })])));
  assert.equal(lateRecord.error?.message, 'MARKETING_OUTCOME_REPLAY', 'the agent path cannot record a resolved call');
  // NO_PROVIDER_CHARGE: no ledger row; the current-window hold is released and the school can spend again.
  const none = await resolve(hq.subject, 'MARKETING', cur.id, { decision: 'NO_PROVIDER_CHARGE', reason: REASON, evidence: { providerLookupReference: 'lookup-ai0-none-1' } });
  assert.deepEqual([none.value?.rows[0].r.ledgerEntryId, none.value?.rows[0].r.customerCredits], [null, null], JSON.stringify(none.error?.message));
  assert.equal((await ledgerFor(cur.id)).length, 0);
  await admitted('claire', cur.o, 'released hold');
  // WRITE_OFF of a stale SENDING (TEACHING): zero-credit row with the best-known cost; ends UNKNOWN.
  const off = await resolve(hq.subject, 'TEACHING', staleOld.id, { decision: 'WRITE_OFF', reason: REASON, evidence: { estimatedProviderCostMicrounits: 900 } });
  assert.equal(off.value?.rows[0].r.customerCredits, 0, JSON.stringify(off.error?.message));
  const offLedger = await ledgerFor(staleOld.id);
  assert.deepEqual([offLedger.length, offLedger[0]?.c, Number(offLedger[0]?.cost)], [1, 0, 900]);
  assert.equal((await row(`SELECT status FROM hon.${agents.claire.table} WHERE id=$1`, [staleOld.id])).status, 'UNKNOWN');
  // A fresh SENDING call and a recorded call are not resolvable.
  const fresh = await lostOutcome('inv-20-fresh', 'chad');
  await backdate(agents.chad.table, fresh.id, '1 minute', 'SENDING');
  assert.equal((await resolve(hq.subject, 'CHAD_FOLLOW_UP', fresh.id, recordInput)).error?.message, 'AI_UNKNOWN_NOT_RESOLVABLE', 'an in-flight call is not resolvable');
  const recordedCall = (await row(`SELECT id FROM hon.${agents.claire.table} WHERE organization_id=$1 AND status='AWAITING_APPROVAL' LIMIT 1`, [cur.o.id])).id;
  assert.equal((await resolve(hq.subject, 'TEACHING', recordedCall, recordInput)).error?.message, 'AI_UNKNOWN_NOT_RESOLVABLE');
  // Evidence: immutable resolutions, audit rows and inert outbox events for the three resolutions.
  assert.equal((await row("SELECT count(*)::int n FROM hon.audit_events WHERE action_code='hq.ai.unknown_invocation.resolve'")).n - audits0, 3);
  assert.equal((await row("SELECT count(*)::int n FROM hon.outbox_events WHERE event_type='ai.unknown_invocation.resolved' AND aggregate_id = ANY($1::uuid[])", [[old.id, cur.id, staleOld.id]])).n, 3);
  assert.equal((await settle(admin.query('UPDATE hon.ai_unknown_resolutions SET reason=$1', ['Tampered synthetic resolution reason']))).error?.code, '55000');
  assert.equal((await settle(admin.query('DELETE FROM hon.ai_unknown_resolutions'))).error?.code, '55000');
  const after = (await row('SELECT hon.read_ai_unknown_invocations_from_hq($1) r', [hq.subject])).r;
  assert.equal(after.open.some((q) => [old.id, cur.id, staleOld.id].includes(q.invocationId)), false, 'resolved items leave the open queue');
  assert.equal(after.open.some((q) => q.invocationId === staleCur.id), true, 'unresolved items stay');
  assert.equal(after.resolved.filter((x) => [old.id, cur.id, staleOld.id].includes(x.invocationId)).length, 3);
  pass('INV-20', 'S4-d: HQ-owner-only resolution: RECORD_PROVIDER_COST writes one ledger row in the original window, NO_PROVIDER_CHARGE writes none and frees the school, WRITE_OFF writes a zero-credit row; closed evidence, idempotent per key, once per call, in-flight and recorded calls refused, agent path still refused; immutable record, audit and inert outbox');

  // ---- INV-21 (S4-e): HQ per-school AI usage and actual provider cost, read only ----
  {
  const usage = (subject, from, to) => settle(admin.query('SELECT hon.read_ai_school_usage_from_hq($1,$2::timestamptz,$3::timestamptz) r', [subject, from, to]));
  const from = new Date(Date.now() - 90 * 86_400_000).toISOString(), to = new Date(Date.now() + 3_600_000).toISOString();
  // A non-agent (CREATIVE_MEDIA) provider expense row, as the creative wallet (CW1) records them: it has no agent, so
  // the per-agent breakdown must skip it rather than fail the whole HQ read (CW1 review P2-A regression).
  await admin.query("INSERT INTO hon.ai_usage_ledger(organization_id,school_id,provider_code,model_code,modality,customer_credits,provider_cost_microunits,correlation_id,spend_class) VALUES($1,$2,'OPENROUTER','ai0-creative','IMAGE',0,5000,$3,'CREATIVE_MEDIA')", [old.o.id, old.o.school, K()]);
  const ledgerBefore = (await row('SELECT count(*)::int n FROM hon.ai_usage_ledger')).n;
  const read = await usage(hq.subject, from, to);
  const report = read.value?.rows[0].r;
  assert(report, JSON.stringify(read.error?.message));
  // Independent per-school totals straight from the ledger: each school is reported exactly once and only with its own rows.
  const expected = await rows(`SELECT organization_id o, school_id s, spend_class c, sum(customer_credits)::bigint credits, sum(provider_cost_microunits)::bigint cost, count(*)::int n
    FROM hon.ai_usage_ledger WHERE occurred_at >= $1 AND occurred_at < $2 GROUP BY 1,2,3`, [from, to]);
  const schoolsSeen = new Set(expected.map((e) => `${e.o}/${e.s}`));
  assert.equal(report.schools.length, schoolsSeen.size, 'one entry per school with usage');
  assert.equal(new Set(report.schools.map((x) => `${x.organizationId}/${x.schoolId}`)).size, report.schools.length, 'no school reported twice');
  for (const e of expected) {
    const sch = report.schools.find((x) => x.organizationId === e.o && x.schoolId === e.s);
    const cls = sch?.byClass?.[e.c];
    assert.deepEqual([cls?.credits, cls?.providerCostMicrounits, cls?.entries], [Number(e.credits), Number(e.cost), e.n], `school ${e.s} class ${e.c}`);
  }
  // Agent attribution comes from the S4-a source invocation; pre-S4-a style rows are UNATTRIBUTED, never guessed.
  const oldSchool = report.schools.find((x) => x.schoolId === old.o.school);
  assert.equal(oldSchool.byClass.AGENT_INFERENCE.byAgent.MARKETING?.providerCostMicrounits >= 2400, true, JSON.stringify(oldSchool));
  assert.equal(oldSchool.byClass.AGENT_INFERENCE.byAgent.UNATTRIBUTED?.credits, 11990, 'the synthetic used-credit fixture row has no source invocation');
  const offSchool = report.schools.find((x) => x.schoolId === staleOld.o.school);
  assert.equal(offSchool.byClass.AGENT_INFERENCE.byAgent.TEACHING?.providerCostMicrounits >= 900, true, 'a WRITE_OFF row keeps its best-known cost');
  for (const sch of report.schools) assert.equal(sch.byClass.CREATIVE_MEDIA?.byAgent ?? null, null, 'creative rows are never attributed to an agent budget');
  assert.deepEqual([oldSchool.byClass.CREATIVE_MEDIA?.credits, oldSchool.byClass.CREATIVE_MEDIA?.providerCostMicrounits >= 5000], [0, true], 'creative expense is reported in its own class');
  // Organization budget picture equals the S4-b/S4-d functions; open lost outcomes are counted.
  const orgOf = (o) => report.organizations.find((x) => x.organizationId === o.id);
  const committedNow = Number((await row('SELECT hon.ai_org_committed_credits($1, clock_timestamp()) n', [staleCur.o.id])).n);
  assert.deepEqual([orgOf(staleCur.o)?.agentCeilingCredits, orgOf(staleCur.o)?.agentCommittedCredits, orgOf(staleCur.o)?.openUnknownHolds, orgOf(staleCur.o)?.aiPaused],
    [12000, committedNow, 1, false], JSON.stringify(orgOf(staleCur.o)));
  assert.equal(orgOf(old.o)?.openUnknownHolds, 0, 'resolved outcomes are not open');
  assert.equal(report.providerCostUnit, 'MICROUNITS_USD');
  // Authority and range: HQ readers only; bad ranges refused; nothing written; a STABLE definer read with one runtime grant.
  assert.equal((await usage(old.o.subject, from, to)).error?.code, '42501', 'a school owner cannot read HQ school usage');
  assert.equal((await usage(`ai0-unknown-${K()}`, from, to)).error?.code, '42501', 'an unknown subject cannot read');
  for (const [a, b, label] of [[to, from, 'reversed'], [new Date(Date.now() - 100 * 86_400_000).toISOString(), to, 'over 92 days'], [null, to, 'no start'],
    [from, new Date(Date.now() + 3 * 86_400_000).toISOString(), 'future end']])
    assert.equal((await usage(hq.subject, a, b)).error?.code, '22023', label);
  assert.equal((await row('SELECT count(*)::int n FROM hon.ai_usage_ledger')).n, ledgerBefore, 'the read writes nothing');
  assert.equal((await row("SELECT provolatile v, prosecdef d FROM pg_proc WHERE oid='hon.read_ai_school_usage_from_hq(text,timestamptz,timestamptz)'::regprocedure")).v, 's');
  pass('INV-21', `S4-e: HQ per-school AI usage: ${report.schools.length} schools each reported once with only their own ledger rows, per class (credits never cross classes) and per agent (UNATTRIBUTED when no source), actual provider cost in micro-USD, org budget equal to the S4-b/S4-d functions, open lost outcomes counted; HQ readers only, bounded range, read only`);
  }

  }

  // ---- INV-22: a permission or role grant lost after a request begins stops it at prepare, before any provider call ----
  {
  const lose = {
    'ai.invocation.plan permission removed': [async (o) => admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='ai.invocation.plan'", [o.role]),
      async (o) => admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'ai.invocation.plan')", [o.role, o.id])],
    'owner role grant expired': [async (o) => admin.query('UPDATE hon.principal_role_grants SET effective_until=clock_timestamp()-interval \'1 minute\' WHERE principal_id=$1', [o.principal]),
      async (o) => admin.query('UPDATE hon.principal_role_grants SET effective_until=NULL WHERE principal_id=$1', [o.principal])],
    'owner role grant revoked': [async (o) => admin.query('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE principal_id=$1', [o.principal]), null],
  };
  const lostOutcomes = {};
  for (const [label, [apply, restore]] of Object.entries(lose)) {
    const o = await makeOrg(`inv-22-${Object.keys(lostOutcomes).length}`);
    const begun = {};
    for (const name of Object.keys(agents)) {
      fakes[name].readiness = () => 'NOT_CONFIGURED';
      begun[name] = (await agents[name].service.submit(context(o), agents[name].input(o))).id;
      fakes[name].readiness = () => 'READY';
    }
    await apply(o);
    for (const name of Object.keys(agents)) {
      const calls = fakes[name].calls, ledger = await ledgerRows(o);
      fakes[name].mode = 'RESULT';
      const refused = await settle(agents[name].service.generate(context(o), begun[name]));
      assert.equal(refused.error?.getStatus?.(), 403, `${name} ${label}: prepare must be refused: ${JSON.stringify(refused.value ?? refused.error?.getResponse?.())}`);
      assert.equal(fakes[name].calls, calls, `${name} ${label}: refused prepare reached the provider`);
      assert.equal(await ledgerRows(o), ledger);
      assert.equal((await reservedByAgent(o))[name], 0, `${name} ${label}: no hold`);
      lostOutcomes[`${name}: ${label}`] = 'HTTP_403';
    }
    if (restore) {
      await restore(o);
      const ok = await agents.marcus.service.generate(context(o), begun.marcus);
      assert.equal(ok.status, 'AWAITING_APPROVAL', `${label}: restoring the authority lets the same request proceed: ${JSON.stringify(ok)}`);
    }
  }
  pass('INV-22', `a request begun with valid authority is refused at prepare once the permission is removed, the role grant expires or is revoked (${Object.keys(lostOutcomes).length} agent/case refusals, no provider call, hold or ledger row); restored authority proceeds`);
  }

  // ---- INV-23 (AI-R1): team readiness agrees with what a real request would do, and writes nothing ----
  {
  const ready = async (o, patch = {}) => (await tenant(context(o, patch), (client) => client.query('SELECT hon.read_ai_team_readiness($1) r', [o.subject]))).rows[0].r;
  const byKey = (r) => Object.fromEntries(r.agents.map((a) => [a.agentKey, a]));
  const counts = async () => (await row(`SELECT (SELECT count(*) FROM hon.ai_invocation_plans)::int p, (SELECT count(*) FROM hon.ai_usage_ledger)::int l,
    (SELECT count(*) FROM hon.audit_events)::int a, (SELECT count(*) FROM hon.marketing_ai_invocations)+(SELECT count(*) FROM hon.teaching_ai_invocations)+(SELECT count(*) FROM hon.chad_follow_up_invocations) i`));
  const r0 = await makeOrg('inv-23');
  const before = await counts(), calls0 = Object.values(fakes).reduce((n, f) => n + f.calls, 0);
  const base = await ready(r0);
  assert.deepEqual(base.agents.map((a) => [a.agentKey, a.available, a.route, a.spendDecision]), [['marcus', true, 'CONFIGURED', 'ALLOWED'], ['claire', true, 'CONFIGURED', 'ALLOWED'], ['chad', true, 'CONFIGURED', 'ALLOWED']], JSON.stringify(base));
  assert.deepEqual([base.organizationId, base.schoolId, base.completeEntitlement, base.agentBudget.ceilingCredits], [r0.id, r0.school, true, 12000]);
  assert.deepEqual(await counts(), before, 'readiness writes nothing');
  assert.equal(Object.values(fakes).reduce((n, f) => n + f.calls, 0), calls0, 'readiness never reaches a provider');
  // Equivalence with real requests across the INV-8 gate changes: every refused request is reported unavailable.
  const ALL = Object.keys(agents);
  const cases = [
    ['COMPLETE SUSPENDED', ALL, () => admin.query("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [r0.id]), () => restoreEntitlement(r0)],
    ['CORE ACTIVE', ALL, () => admin.query("UPDATE hon.organization_entitlements SET tier='CORE' WHERE organization_id=$1", [r0.id]), () => restoreEntitlement(r0)],
    ['teaching.assistant.use removed', ['claire'], () => admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='teaching.assistant.use'", [r0.role]),
      () => admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'teaching.assistant.use')", [r0.role, r0.id])],
    ['owner grant expired', ALL, () => admin.query("UPDATE hon.principal_role_grants SET effective_until=clock_timestamp()-interval '1 minute' WHERE principal_id=$1", [r0.principal]),
      () => admin.query('UPDATE hon.principal_role_grants SET effective_until=NULL WHERE principal_id=$1', [r0.principal])],
    ['no route', ALL, () => admin.query('UPDATE hon.hq_ai_routing_policies SET active=false WHERE policy_id=$1', [r0.policy]), () => admin.query('UPDATE hon.hq_ai_routing_policies SET active=true WHERE policy_id=$1', [r0.policy])],
  ];
  const seen = {};
  for (const [label, affected, apply, restore] of cases) {
    await apply();
    try {
      let readiness = null;
      const refused = await settle(ready(r0));
      if (refused.value) readiness = byKey(refused.value);
      for (const name of Object.keys(agents)) {
        if (!affected.includes(name)) { assert.equal(readiness?.[name].available, true, `${name} ${label}: unaffected agent stays available`); continue; }
        const outcome = await expectRefused(name, r0, {}, `INV-23 ${label}`);
        // A whole-school refusal (no ai.invocation.plan scope) refuses the readiness read itself, which is also unavailable.
        assert(readiness === null || readiness[name].available === false, `${name} ${label}: readiness must report unavailable (${outcome}): ${JSON.stringify(readiness?.[name])}`);
        seen[`${name}: ${label}`] = readiness ? readiness[name].blockedBy : 'READ_REFUSED';
      }
    } finally { await restore(); }
  }
  assert.deepEqual(byKey(await ready(r0)).claire.available, true, 'restored');
  // Specific blockers: HQ pause (S4-c), organization budget (S4-b), and a request that still fits the smaller Chad estimate.
  await setUsed(r0, 11996);
  const near = byKey(await ready(r0));
  assert.deepEqual([near.marcus.blockedBy, near.claire.blockedBy, near.chad.available], ['ORGANIZATION_AI_BUDGET_REACHED', 'ORGANIZATION_AI_BUDGET_REACHED', true], JSON.stringify(near));
  // The real request is refused too (the planner's budget denial surfaces as a BLOCKED request with no provider call).
  assert.match(await expectRefused('marcus', r0, {}, 'INV-23 budget'), /^BLOCKED_/, 'the real request agrees');
  const pauseIn = { action: 'PAUSE', organizationId: r0.id, spendClass: 'AGENT_INFERENCE', reason: 'Disposable synthetic AI-0 readiness pause' };
  const pause = await settle(admin.query('SELECT hon.command_ai_spend_pause($1,$2::jsonb,$3::uuid) r', [hq.subject, JSON.stringify(pauseIn), K()]));
  assert.equal(pause.value?.rows[0].r.status, 'ACTIVE', JSON.stringify(pause.error?.message));
  assert.deepEqual(Object.values(byKey(await ready(r0))).map((a) => a.blockedBy), ['AI_PAUSED_BY_HQ', 'AI_PAUSED_BY_HQ', 'AI_PAUSED_BY_HQ']);
  seen.pause = 'AI_PAUSED_BY_HQ';
  // Only the direct human of this transaction, in the human UI, may read readiness.
  for (const [patch, label] of [[{ source: 'AI' }, 'AI source'], [{ delegatedByPrincipalId: r0.principal }, 'delegated']]) {
    const r = await settle(tenant(context(r0, patch), async (client) => {
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_delegated_by_principal_id',$2,true)", [patch.source ?? 'HUMAN_UI', patch.delegatedByPrincipalId ?? '']);
      return client.query('SELECT hon.read_ai_team_readiness($1) r', [r0.subject]);
    }));
    assert.equal(r.error?.code, '42501', label);
  }
  const other = await makeOrg('inv-23-other');
  assert.equal((await settle(tenant(context(r0), (client) => client.query('SELECT hon.read_ai_team_readiness($1) r', [other.subject])))).error?.code, '42501', 'another school’s owner');
  pass('INV-23', `AI-R1: team readiness reports all three agents available on a ready school, agrees with real requests across ${cases.length} gate changes (${Object.keys(seen).length} checks), names the budget and HQ pause blockers, refuses non-direct or foreign humans, and writes nothing or calls no provider`);
  }

  // ---- INV-15 (S4-b, replaces KF-AI3): deterministic serialization on the ai.budget advisory lock ----
  // A blocker transaction holds ai.budget:<org>. Two prepares (same agent, and every agent pair) must both be seen
  // WAITING on an advisory lock (pg_locks), not racing. Room fits exactly one of the pair. On release each waiter
  // recomputes the organization total after the lock, so exactly one reaches the provider and the other is
  // BLOCKED / CUSTOMER_BUDGET_EXCEEDED. No deadlock, no timing dependence.
  const pairs = [['marcus', 'marcus'], ['claire', 'claire'], ['chad', 'chad'], ['marcus', 'claire'], ['marcus', 'chad'], ['claire', 'chad']];
  const pairOutcomes = [], waitEvidence = [];
  for (const [x, y] of pairs) {
    const o = await makeOrg(`inv-15-${x}-${y}`);
    const room = Math.max(agents[x].estimate, agents[y].estimate);
    await setUsed(o, 12000 - room);
    const blocker = new pg.Client({ connectionString: ownerUrl, ssl: false });
    await blocker.connect();
    // Begin both requests first (provider not ready: durable CONFIGURATION_REQUIRED, nothing reserved), so the race
    // below is between two prepares only, exactly as two open tabs retrying would be.
    const pending = [];
    for (const name of [x, y]) {
      fakes[name].readiness = () => 'NOT_CONFIGURED';
      const view = await agents[name].service.submit(context(o), agents[name].input(o));
      fakes[name].readiness = () => 'READY';
      assert.equal(view.status, 'CONFIGURATION_REQUIRED', `${name}: setup request must wait for configuration: ${JSON.stringify(view)}`);
      pending.push([name, view.id]);
    }
    const callsBefore = fakes[x].calls + (x === y ? 0 : fakes[y].calls);
    let racing; const done = [];
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT hon.ai_budget_lock($1)', [o.id]);
      // HOLD: the admitted call keeps its hold until checked, so the loser's decision cannot depend on how fast the
      // winner's (smaller) actual usage is recorded.
      fakes[x].mode = 'HOLD'; fakes[y].mode = 'HOLD';
      racing = pending.map(([name, id], i) => settle(agents[name].service.generate(context(o), id)).then((r) => { done[i] = r; return r; }));
      // Both prepares must be blocked at the same time: at least one on the ai.budget advisory lock, and the other
      // either on that lock too or queued behind the first prepare's organization row lock (taken earlier by the
      // shared access gate). Either way neither can compute its total until the budget lock is free.
      let waits = [];
      for (const end = Date.now() + 4000; ; await sleep(20)) {
        waits = await rows("SELECT DISTINCT l.pid,l.locktype FROM pg_locks l WHERE NOT l.granted AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database()) UNION SELECT DISTINCT l.pid,l.locktype FROM pg_locks l WHERE NOT l.granted AND l.locktype='transactionid'");
        const pids = new Set(waits.map((w) => w.pid));
        if (pids.size >= 2 && waits.some((w) => w.locktype === 'advisory')) break;
        if (Date.now() > end || done.filter(Boolean).length) throw new Error(`${x}/${y}: prepares were not both blocked behind the ai.budget lock (waits ${JSON.stringify(waits)}; settled early: ${JSON.stringify(done.map((r) => r && (r.error ? (r.error.getResponse?.() ?? String(r.error)) : r.value?.status)))})`);
      }
      waitEvidence.push(`${x}/${y}: ${[...new Set(waits.map((w) => w.locktype))].sort().join('+')}`);
      await blocker.query('COMMIT');
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      await blocker.end();
    }
    for (const end = Date.now() + 15000; ; await sleep(20)) {
      if (done.filter(Boolean).length === 1 && (await sendingCount(o)) === 1) break;
      if (Date.now() > end || done.filter(Boolean).length === 2) throw new Error(`${x}/${y}: expected one SENDING and one settled refusal: ${JSON.stringify(done.map((r) => r && (r.error ? (r.error.getResponse?.() ?? String(r.error)) : r.value?.status)))}`);
    }
    const loserCommitted = await committed(o);
    assert(loserCommitted.total <= 12000, `${x}/${y}: committed ${loserCommitted.total} exceeds the ceiling while the winner is in flight`);
    for (const name of new Set([x, y])) fakes[name].complete();
    const settled = await Promise.all(racing);
    for (const r of settled) if (r.error) throw r.error;
    const statuses = settled.map((r) => r.value.status).sort();
    const callsAfter = fakes[x].calls + (x === y ? 0 : fakes[y].calls);
    assert.deepEqual(statuses, ['AWAITING_APPROVAL', 'BLOCKED'].sort(), `${x}/${y}: exactly one admitted: ${JSON.stringify(statuses)}`);
    assert.equal(callsAfter - callsBefore, 1, `${x}/${y}: exactly one provider call`);
    const c = await committed(o);
    assert(c.total <= 12000, `${x}/${y}: committed ${c.total} exceeds the ceiling`);
    pairOutcomes.push(`${x}/${y}`);
  }
  pass('INV-15', `S4-b: prepares serialize on ai.budget:<org> (both blocked, lock evidence ${waitEvidence.join('; ')}); exactly one admitted, the other BLOCKED, one provider call, committed <= 12000`);

  // ---- INV-12: zero external effects ----
  assert.equal(networkCalls, 0);
  const after = await collectInventory();
  assert.deepEqual(after.programs, expected.programs, 'programs changed during the proof');
  const stray = await rows(`SELECT 'ledger' t,organization_id FROM hon.ai_usage_ledger WHERE NOT (organization_id=ANY($1::uuid[])) UNION ALL ${AGENT_TABLES.map((t) => `SELECT '${t}',organization_id FROM hon.${t} WHERE NOT (organization_id=ANY($1::uuid[]))`).join(' UNION ALL ')}`, [orgs.map((o) => o.id)]);
  assert.deepEqual(stray, []);
  for (const table of ['saas_credit_allowances', 'saas_credit_reservations', 'saas_credit_ledger', 'saas_trial_policy_versions', 'saas_trial_campaign_versions', 'saas_trial_publications', 'saas_access_states']) assert.equal((await row(`SELECT count(*)::int n FROM hon.${table}`)).n, 0, `hon.${table} written during the proof`);
  pass('INV-12', `zero network calls (${providerCalls} fake provider calls only), programs unchanged, all AI rows confined to ${orgs.length} synthetic organizations, no allowance/trial/access-state writes`);

  console.log(JSON.stringify({ ai0: { invariants: results.invariants, knownFailures: results.knownFailures, gateOutcomes, networkCalls, fakeProviderCalls: providerCalls } }, null, 2));
  console.log(`PASS AI-0: ${results.invariants.length} invariants; ${results.knownFailures.filter((k) => k.reproduced).length}/${results.knownFailures.length} known failures reproduced (open; replaced by S4 or a later approved slice). AI-0 is a regression baseline, not a fix.`);
} finally {
  for (const f of Object.values(fakes)) f.release();
  globalThis.fetch = originalFetch;
  await db.onModuleDestroy?.();
  await admin.end();
}
