/**
 * AI-0 spend-authority baseline. A REGRESSION BASELINE, NOT THE SECURITY FIX.
 *
 * - Invariants (INV-*) pin today's AI spend surface: entry points, grants, closed programs, nothing seeded,
 *   gates that refuse. Any silent change fails.
 * - Known failures (KNOWN_FAILURE_*) intentionally reproduce open vulnerabilities and pass only while they
 *   reproduce exactly as recorded in ai-spend-entrypoints.json. A fix must flip the entry to FIXED_BY_<slice>
 *   and add the matching invariant in the same reviewed PR (S4 for KF-AI2/AI3/AI9/AI14; the AI-D3 slice for KF-AI8).
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

  // ---- KNOWN FAILURE KF-AI2: cross-agent over-commit ----
  const k1 = await makeOrg('kf-ai2');
  await setUsed(k1, 11990);
  const held = [];
  for (const name of ['marcus', 'claire', 'chad']) held.push([name, await startHeld(name, k1)]);
  const k1Committed = await committed(k1), k1Reserved = await reservedByAgent(k1);
  const allSending = held.every(([, h]) => h.sending);
  for (const name of Object.keys(fakes)) fakes[name].release();
  await Promise.all(held.map(([, h]) => h.submitted));
  assert.deepEqual(await reservedByAgent(k1), { marcus: 0, claire: 0, chad: 0 });
  // Causal split: each agent reserved exactly its own estimate against its own table, so no single agent saw the others.
  const k1Split = k1Reserved.marcus === 6 && k1Reserved.claire === 6 && k1Reserved.chad === 3 && k1Committed.used === 11990;
  reportKnownFailure('KF-AI2-CROSS-AGENT-OVERCOMMIT', allSending && k1Split && k1Committed.total === 12005,
    `used ${k1Committed.used} + reserved ${JSON.stringify(k1Reserved)} = ${k1Committed.total} committed against a 12000 ceiling`);

  // ---- KNOWN FAILURE KF-AI9: unpaid HQ COMPLETE exception reaches the provider ----
  const x = await makeOrg('kf-ai9');
  await admin.query("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [x.id]);
  assert.equal(await expectRefused('marcus', x, {}, 'suspended before exception'), 'HTTP_403');
  const view = await schoolBilling.readExceptionPolicy(hq.subject);
  // Synthetic approval ONLY in this disposable database; never a seed or operational approval. Decisions bind to the
  // latest proposed paid-access terms version (2 since 0192), so a v1 approval cannot authorize a grant.
  const termsVersion = Number((await row('SELECT max(policy_version) v FROM hon.saas_access_policy_terms')).v);
  await schoolBilling.decideExceptionPolicy(hq.subject, { expectedRevision: view.current?.revision ?? 0, decision: 'APPROVED', termsVersion, maxDays: 90,
    validFrom: new Date(Date.now() - 60_000).toISOString(), validUntil: new Date(Date.now() + 86_400_000).toISOString(),
    reason: 'DISPOSABLE SYNTHETIC AI-0 TEST ONLY; no operational policy approval', confirmation: 'APPROVE_ACCESS_EXCEPTION_POLICY_ONLY' }, K());
  const version = async () => (await row('SELECT version FROM hon.organization_entitlements WHERE organization_id=$1', [x.id])).version;
  const grant = async (scopeTier, ms) => schoolBilling.grantAccessException(hq.subject, x.id, { schoolId: x.school, purpose: 'INTERNAL_TESTING', reason: 'Disposable synthetic AI-0 exception only', scopeTier,
    startsAt: new Date().toISOString(), expiresAt: new Date(Date.now() + ms).toISOString(), expectedEntitlementVersion: await version() }, K());
  const granted = await grant('COMPLETE', 86_400_000);
  const aiCredits = JSON.stringify(granted).match(/"aiCredits":"([A-Z_]+)"/)?.[1];
  assert.equal(aiCredits, 'NONE', `exception receipt must state aiCredits NONE: ${JSON.stringify(granted)}`);
  const callsBefore = fakes.marcus.calls, ledgerBefore = await ledgerRows(x);
  fakes.marcus.mode = 'RESULT';
  const exceptionSpend = await settle(agents.marcus.service.submit(context(x), agents.marcus.input(x)));
  const reachedProvider = !exceptionSpend.error && exceptionSpend.value.status === 'AWAITING_APPROVAL' && fakes.marcus.calls === callsBefore + 1 && await ledgerRows(x) === ledgerBefore + 1;
  reportKnownFailure('KF-AI9-EXCEPTION-SPEND', reachedProvider,
    `COMPLETE HQ exception (receipt aiCredits ${aiCredits}) on an unpaid school: provider calls ${fakes.marcus.calls - callsBefore}, ledger rows +${await ledgerRows(x) - ledgerBefore}`);

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

  // ---- KNOWN FAILURE KF-AI8: UNKNOWN holds never release and are not month-scoped ----
  const k3 = await makeOrg('kf-ai8');
  fakes.marcus.mode = 'UNKNOWN';
  const unknown = await agents.marcus.service.submit(context(k3), agents.marcus.input(k3));
  assert.equal(unknown.status, 'UNKNOWN', JSON.stringify(unknown));
  assert.equal((await reservedByAgent(k3)).marcus, 6);
  await admin.query('BEGIN');
  await admin.query('ALTER TABLE hon.marketing_ai_invocations DISABLE TRIGGER USER');
  await admin.query("UPDATE hon.marketing_ai_invocations SET created_at=created_at-interval '40 days',updated_at=updated_at-interval '40 days' WHERE organization_id=$1", [k3.id]);
  await admin.query('ALTER TABLE hon.marketing_ai_invocations ENABLE TRIGGER USER');
  await admin.query('COMMIT');
  await setUsed(k3, 11990);
  const staleBlocked = await expectRefused('marcus', k3, {}, 'stale UNKNOWN hold');
  fakes.claire.mode = 'FAILED';
  const control = await agents.claire.service.submit(context(k3), agents.claire.input(k3));
  // The only reservation writers are pinned by INV-1; none of them can settle an UNKNOWN call later.
  const lateFail = await settle(tenant(context(k3), (client) => client.query("SELECT hon.fail_marketing_invocation($1,$2::uuid,'FAILED','PROVIDER_REJECTED')", [k3.subject, unknown.id])));
  const lateRecord = await settle(tenant(context(k3), (client) => client.query('SELECT hon.record_marketing_result($1,$2::uuid,$3::jsonb)', [k3.subject, unknown.id,
    JSON.stringify({ draft: { title: 'Late result', content: 'A late provider result for an UNKNOWN call.' }, inputTokens: 200, outputTokens: 100, providerCostMicrounits: 600 })])));
  const stillHeld = (await reservedByAgent(k3)).marcus;
  const unknownLedger = (await row("SELECT count(*)::int n FROM hon.marketing_ai_invocations WHERE organization_id=$1 AND usage_id IS NOT NULL AND status='UNKNOWN'", [k3.id])).n;
  const lateOutcome = (r) => r.error ? `refused ${r.error.message}` : `returned ${JSON.stringify(r.value.rows[0])}`;
  reportKnownFailure('KF-AI8-UNKNOWN-HOLD', staleBlocked === 'BLOCKED_CUSTOMER_BUDGET_EXCEEDED' && control.status === 'FAILED' && stillHeld === 6 && unknownLedger === 0,
    `last-month UNKNOWN hold still counted: Marcus ${staleBlocked} at used 11990 while Claire (own table) reached the provider; late fail ${lateOutcome(lateFail)}; late record ${lateOutcome(lateRecord)}; hold still ${stillHeld}; UNKNOWN ledger rows ${unknownLedger}`);

  // ---- KNOWN FAILURE KF-AI3: same-agent race (two open transactions) ----
  const k4 = await makeOrg('kf-ai3');
  await setUsed(k4, 11994);
  const beginAndPlan = async () => {
    const c = context(k4);
    const begun = await tenant(c, async (client) => (await client.query('SELECT hon.begin_marketing_request($1,$2::jsonb,$3::uuid) data', [k4.subject, JSON.stringify(agents.marcus.input(k4)), c.idempotencyKey])).rows[0].data);
    const ref = await tenant(c, async (client) => (await client.query('SELECT hon.marketing_planning_reference($1,$2::uuid) data', [k4.subject, begun.id])).rows[0].data);
    const planned = await plans.plan({ ...c, idempotencyKey: begun.id }, ref.workItemId, { expectedVersion: ref.workVersion, expectedState: 'READY', agentKey: 'marcus', modality: 'TEXT', taskClass: 'DRAFT_MARKETING', inputBudget: 4096, outputBudget: 1024, maxProviderCostMicrounits: 100000 });
    assert.equal(planned.status, 'PLANNED', JSON.stringify(planned));
    return { c, id: begun.id, planId: planned.plan.id };
  };
  const [first, second] = [await beginAndPlan(), await beginAndPlan()];
  let releaseFirst; const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let firstPrepared; const firstReady = new Promise((resolve) => { firstPrepared = resolve; });
  const firstTx = settle(tenant(first.c, async (client) => {
    const payload = (await client.query('SELECT hon.prepare_marketing_invocation($1,$2::uuid,$3::uuid,true) data', [k4.subject, first.id, first.planId])).rows[0].data;
    firstPrepared(); await firstGate; return payload;
  }));
  await firstReady;
  const secondRun = settle(tenant(second.c, async (client) => (await client.query('SELECT hon.prepare_marketing_invocation($1,$2::uuid,$3::uuid,true) data', [k4.subject, second.id, second.planId])).rows[0].data));
  const secondTx = await settle(Promise.race([secondRun.then((r) => { if (r.error) throw r.error; return r.value; }), sleep(3000).then(() => { throw new Error('SECOND_PREPARE_WAITED'); })]));
  // Record what the second prepare waits on, so the evidence names the serializing lock.
  const waits = secondTx.error?.message === 'SECOND_PREPARE_WAITED'
    ? (await rows("SELECT DISTINCT l.locktype,coalesce(l.relation::regclass::text,'') relation,l.mode FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE NOT l.granted AND a.datname=current_database()")).map((w) => `${w.locktype}:${w.relation}:${w.mode}`)
    : [];
  releaseFirst();
  const firstResult = await firstTx;
  const secondAfterWait = await secondRun;
  const bothPassed = !!firstResult.value && !!secondTx.value;
  const k4Committed = await committed(k4);
  // Release the synthetic holds the ordinary way (provider rejection); a refused prepare has nothing to release.
  for (const [id, prepared] of [[first.id, firstResult.value], [second.id, secondAfterWait.value]]) if (prepared) await tenant(context(k4), (client) => client.query("SELECT hon.fail_marketing_invocation($1,$2::uuid,'FAILED','PROVIDER_REJECTED')", [k4.subject, id]));
  assert.equal((await reservedByAgent(k4)).marcus, 0);
  reportKnownFailure('KF-AI3-SAME-AGENT-RACE', bothPassed,
    bothPassed ? `two concurrent Marcus prepares at used 11994 both reserved 6 (${k4Committed.total} committed)` : `second prepare waited on [${waits.join(', ')}] until the first committed, then returned ${secondAfterWait.value ? 'a payload' : 'no payload (refused by the per-agent ceiling)'}; ${k4Committed.total} committed`, { mayNotReproduce: true });
  if (secondAfterWait.error) throw secondAfterWait.error;

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
