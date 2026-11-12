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
  'begin_hon_turn', 'prepare_hon_reply', 'record_hon_reply_result', 'fail_hon_reply',
  'plan_ai_invocation', 'require_ai_invocation_plan_access',
  'reserve_saas_premium_credits', 'settle_saas_premium_credits', 'saas_record_provider_usage', 'saas_current_allowance',
];
const AGENT_TABLES = ['marketing_ai_invocations', 'teaching_ai_invocations', 'chad_follow_up_invocations', 'hon_reply_invocations'];
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
  const agentFunctions = spendFunctions.filter((s) => /_(marketing|teaching|chad_follow_up)_|_hon_reply\(|begin_hon_turn/.test(s));
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
    agentTablesInB3Functions: await functions(within(b3Functions, '(marketing_ai_invocations|teaching_ai_invocations|chad_follow_up_invocations|hon_reply_invocations)')),
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
const { HonConversationService } = await import('../../../apps/api/dist/hon-conversation/hon-conversation.controller.js');
const { AiTeamReadinessService } = await import('../../../apps/api/dist/ai-team/ai-team-readiness.controller.js');
const { ProviderRuntimeError } = await import('../../../apps/api/dist/ai/provider-runtime.js');
const { ClaireProviderRuntimeError } = await import('../../../apps/api/dist/ai/claire-provider-runtime.js');
const { ChadProviderRuntimeError } = await import('../../../apps/api/dist/ai/chad-provider-runtime.js');
const { HonReplyProviderRuntimeError } = await import('../../../apps/api/dist/ai/hon-reply-provider-runtime.js');
const { HonReplyService } = await import('../../../apps/api/dist/hon-conversation/hon-reply.service.js');
const { StaffRoleService } = await import('../../../apps/api/dist/staff-roles/staff-role.service.js');
const { CampaignService } = await import('../../../apps/api/dist/marketing/campaign.service.js');
const { SaasBillingService } = await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const { SaasSchoolBillingService } = await import('../../../apps/api/dist/school-billing/saas-school-billing.service.js');
const db = new RuntimeDatabaseService(), plans = new AiInvocationPlanService(db), actions = new ActionEngineService(db);
const campaigns = new CampaignService(db), billing = new SaasBillingService(db), schoolBilling = new SaasSchoolBillingService(billing);

let providerCalls = 0;
function fakeProvider(ErrorType, draft) {
  const provider = { calls: 0, mode: 'RESULT', held: [] };
  provider.readiness = () => 'READY';
  // 0256: each input is kept so a proof can see what the server sent (for Kai: the school's tone).
  provider.inputs = [];
  provider.generate = async (input) => {
    provider.calls += 1; providerCalls += 1; provider.inputs.push(input);
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
/** C2 HON reply fake: plain-text reply; records each input so the proof can inspect the server-built context. */
function fakeHonProvider() {
  const provider = { calls: 0, mode: 'RESULT', held: [], inputs: [], ready: 'READY', reply: 'Focus on the two trials booked for tomorrow and review new leads.' };
  // suggestions (C3a): what the model's closing SUGGEST line named, already parsed to the closed delegate set.
  provider.suggestions = [];
  // followUps / sources (0254): the closing ASK and SOURCES lines, already parsed to their closed rules.
  provider.followUps = []; provider.sources = [];
  const result = () => ({ reply: provider.reply, inputTokens: 300, outputTokens: 120, providerCostMicrounits: 900, truncated: false, suggestions: [...provider.suggestions],
    followUps: [...provider.followUps], sources: [...provider.sources] });
  provider.readiness = () => provider.ready;
  provider.generate = async (input) => {
    provider.calls += 1; providerCalls += 1; provider.inputs.push(input);
    if (provider.mode === 'HOLD') return new Promise((resolve, reject) => provider.held.push({ resolve, reject }));
    if (provider.mode === 'UNKNOWN') throw new HonReplyProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
    if (provider.mode === 'FAILED') throw new HonReplyProviderRuntimeError('FAILED', 'PROVIDER_REJECTED');
    if (provider.mode === 'OVER') return { ...result(), outputTokens: 5000 };
    // Stopped at the plan's output limit with verified usage (finish_reason 'length').
    if (provider.mode === 'TRUNCATED') return { ...result(), reply: `${provider.reply} Part ${provider.calls} continues`, outputTokens: input.outputBudget, truncated: true, suggestions: [], followUps: [], sources: [] };
    return result();
  };
  provider.complete = () => { for (const h of provider.held.splice(0)) h.resolve(result()); };
  provider.release = () => { for (const h of provider.held.splice(0)) h.reject(new HonReplyProviderRuntimeError('FAILED', 'PROVIDER_REJECTED')); };
  return provider;
}
fakes.hon = fakeHonProvider();
const honReplies = new HonReplyService(db, plans, fakes.hon);
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

/** A further disposable human HQ owner whose authority the race proofs change (the shared `hq` is never touched). */
async function makeHqOwner(label, untilSql = 'NULL') {
  const h = { id: K(), user: K(), subject: `ai0-hq-${label}-${K()}` };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','AI-0 synthetic HQ owner')", [h.user, h.subject]);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','AI-0 synthetic HQ owner',true)", [h.id, h.user]);
  await admin.query(`INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from,effective_until) VALUES($1,'HON_HQ_OWNER','{}',clock_timestamp()-interval '2 days',${untilSql})`, [h.id]);
  await admin.query('COMMIT');
  h.until = (await row('SELECT effective_until FROM hon.hq_operator_grants WHERE principal_id=$1', [h.id])).effective_until;
  return h;
}
/** A second connection with an open transaction (the "other" transaction of a two-connection proof). */
async function openTx() {
  const c = new pg.Client({ connectionString: ownerUrl, ssl: false });
  await c.connect();
  await c.query('BEGIN');
  return c;
}
/**
 * Runs `sql` on its own connection and resolves once pg_locks shows that backend WAITING on a lock of `locktype`
 * (deterministic: the proof never relies on timing for the interleaving). Throws if it settles without waiting.
 */
async function startBlocked(sql, args, locktype, { tx = false } = {}) {
  const c = new pg.Client({ connectionString: ownerUrl, ssl: false });
  await c.connect();
  const pid = (await c.query('SELECT pg_backend_pid() p')).rows[0].p;
  if (tx) await c.query('BEGIN');
  let done = null;
  const result = settle(c.query(sql, args)).then((r) => { done = r; return r; });
  for (const end = Date.now() + 5000; ; await sleep(20)) {
    const waits = await rows('SELECT locktype FROM pg_locks WHERE pid=$1 AND NOT granted', [pid]);
    if (waits.some((w) => w.locktype === locktype)) break;
    if (done || Date.now() > end) {
      await c.end().catch(() => {});
      throw new Error(`expected the command to wait on a ${locktype} lock first; it ${done ? `settled (${done.error ? done.error.code + ' ' + done.error.message : 'succeeded'})` : 'never waited'}`);
    }
  }
  return { client: c, pid, result: tx ? result : result.finally(() => c.end()) };
}

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

  // ---- INV-18R (S4-c, Manus review P1): HQ authority holds through the pause command (two connections) ----
  // The command checks authority, then takes a shared lock on users/principals/HQ grants/family grants and checks
  // again, and checks once more after the per-scope advisory lock. Each case below makes the command WAIT (seen in
  // pg_locks) while authority changes, then shows the outcome. A refusal leaves no pause row.
  {
  const raceOrg = await makeOrg('inv-18r');
  const pauseSql = 'SELECT hon.command_ai_spend_pause($1,$2::jsonb,$3::uuid) r';
  const activePauses = async () => (await row('SELECT count(*)::int n FROM hon.ai_spend_pauses WHERE organization_id=$1 AND ended_at IS NULL', [raceOrg.id])).n;
  const allPauses = async () => (await row('SELECT count(*)::int n FROM hon.ai_spend_pauses WHERE organization_id=$1', [raceOrg.id])).n;
  const scopeLock = "SELECT pg_advisory_xact_lock(hashtextextended('ai.pause:' || $1::text || ':AGENT_INFERENCE', 0))";
  const outcomes = [];
  // (a) Revoked while waiting: the revocation is uncommitted when the command starts (its first check passes), the
  // command waits for the shared lock, the revocation commits, and the recheck refuses.
  // (b) Permission change while waiting: the grant becomes an operator grant (owner-only command): refused.
  for (const [label, change] of [['revoked', "effective_until=clock_timestamp()"], ['downgraded to operator', "hq_role='HON_HQ_OPERATOR',permission_codes='{hq.billing.manage}'"]]) {
    const h = await makeHqOwner(`inv-18r-${label.split(' ')[0]}`);
    const before = await allPauses();
    const revoker = await openTx();
    await revoker.query(`UPDATE hon.hq_operator_grants SET ${change} WHERE principal_id=$1`, [h.id]);
    const cmd = await startBlocked(pauseSql, [h.subject, JSON.stringify(pIn('PAUSE', raceOrg.id)), K()], 'relation');
    await revoker.query('COMMIT'); await revoker.end();
    const r = await cmd.result;
    assert.equal(r.error?.code, '42501', `${label} while waiting must refuse the pause: ${JSON.stringify(r.value?.rows[0] ?? r.error?.message)}`);
    assert.equal(await allPauses(), before, `${label}: no pause row`);
    outcomes.push(`${label}: refused`);
  }
  // (c) Expired by the clock while waiting on the per-scope lock held by another pause command.
  {
    const h = await makeHqOwner('inv-18r-expiry', "clock_timestamp()+interval '4 seconds'");
    const before = await allPauses();
    const other = await openTx();
    await other.query(scopeLock, [raceOrg.id]);
    const cmd = await startBlocked(pauseSql, [h.subject, JSON.stringify(pIn('PAUSE', raceOrg.id)), K()], 'advisory');
    for (const end = Date.now() + 10000; !(await row('SELECT clock_timestamp() > $1::timestamptz r', [h.until])).r; await sleep(50)) if (Date.now() > end) throw new Error('grant did not expire');
    await other.query('COMMIT'); await other.end();
    const r = await cmd.result;
    assert.equal(r.error?.code, '42501', `expired while waiting must refuse the pause: ${JSON.stringify(r.value?.rows[0] ?? r.error?.message)}`);
    assert.equal(await allPauses(), before, 'expired: no pause row');
    outcomes.push('expired while waiting: refused');
  }
  // (d) A revocation cannot race past the final decision: while the command waits, a revocation of that owner waits
  // behind the command's shared lock; the command completes with the authority it held, then the revocation applies
  // and the same owner is refused afterwards.
  {
    const h = await makeHqOwner('inv-18r-ordered');
    const other = await openTx();
    await other.query(scopeLock, [raceOrg.id]);
    const cmd = await startBlocked(pauseSql, [h.subject, JSON.stringify(pIn('PAUSE', raceOrg.id)), K()], 'advisory');
    const revoke = await startBlocked('UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp() WHERE principal_id=$1', [h.id], 'relation', { tx: true });
    await other.query('COMMIT'); await other.end();
    const r = await cmd.result;
    assert.equal(r.value?.rows[0].r.status, 'ACTIVE', `the command decided before the revocation: ${JSON.stringify(r.error?.message)}`);
    assert.equal((await revoke.result).error, undefined);
    await revoke.client.query('COMMIT'); await revoke.client.end();
    assert.equal((await pauseCmd(h.subject, pIn('RESUME', raceOrg.id), K())).error?.code, '42501', 'the revoked owner is refused afterwards');
    assert.equal(await activePauses(), 1);
    assert.equal((await pauseCmd(hq.subject, pIn('RESUME', raceOrg.id), K())).value?.rows[0].r.status, 'ENDED');
    outcomes.push('revocation during the command: waits, applies after');
  }
  assert.equal(await activePauses(), 0);
  pass('INV-18R', `S4-c: HQ pause authority holds through the mutation (two-connection, pg_locks-observed waits): ${outcomes.join('; ')}; no refused pause row`);
  }

  // ---- INV-18K (S4-c, Manus final review P2): one immutable identity per pause/resume command key ----
  // PAUSE and RESUME share one key space bound to action, scope, spend class, reason and actor. Any other command
  // presented with a claimed key is refused (sequentially and concurrently); an exact replay returns the receipt.
  {
  const pauseSql = 'SELECT hon.command_ai_spend_pause($1,$2::jsonb,$3::uuid) r';
  const [ka, kb, kc] = [await makeOrg('inv-18k-a'), await makeOrg('inv-18k-b'), await makeOrg('inv-18k-c')];
  const active = async (o) => (await row('SELECT count(*)::int n FROM hon.ai_spend_pauses WHERE organization_id=$1 AND ended_at IS NULL', [o.id])).n;
  const reused = (r, label) => assert.equal(r.error?.message, 'AI_SPEND_PAUSE_KEY_REUSED', `${label}: ${JSON.stringify(r.value?.rows[0]?.r ?? r.error?.message)}`);
  const checks = [];
  // Sequential: a PAUSE key presented as a RESUME (same scope) is refused and the pause stays active.
  const k1 = K();
  assert.equal((await pauseCmd(hq.subject, pIn('PAUSE', ka.id), k1)).value?.rows[0].r.status, 'ACTIVE');
  reused(await pauseCmd(hq.subject, pIn('RESUME', ka.id), k1), 'PAUSE key reused for RESUME');
  assert.equal(await active(ka), 1, 'the pause is still active');
  // Same key, other scope or other class: refused, nothing written.
  reused(await pauseCmd(hq.subject, pIn('PAUSE', kb.id), k1), 'PAUSE key reused for another organization');
  reused(await pauseCmd(hq.subject, pIn('PAUSE', ka.id, 'CREATIVE_MEDIA'), k1), 'PAUSE key reused for another class');
  assert.equal(await active(kb), 0);
  // A RESUME key presented as a PAUSE is refused (no new pause is created).
  const k2 = K();
  assert.equal((await pauseCmd(hq.subject, pIn('RESUME', ka.id), k2)).value?.rows[0].r.status, 'ENDED');
  reused(await pauseCmd(hq.subject, pIn('PAUSE', ka.id), k2), 'RESUME key reused for PAUSE');
  assert.equal(await active(ka), 0, 'no pause was created from a RESUME key');
  checks.push('PAUSE<->RESUME, other scope and other class reuse refused');
  // Exact replays return the original receipt, even after the state moved on.
  const r1 = (await pauseCmd(hq.subject, pIn('PAUSE', ka.id), k1)).value?.rows[0].r;
  assert.deepEqual([r1?.replayed, r1?.status], [true, 'ENDED'], 'PAUSE replay after the resume');
  const r2 = (await pauseCmd(hq.subject, pIn('RESUME', ka.id), k2)).value?.rows[0].r;
  assert.deepEqual([r2?.replayed, r2?.status], [true, 'ENDED'], 'RESUME replay');
  checks.push('exact replays return the original receipt');
  // Another HQ owner replaying the same input with the key is a different command; a revoked owner cannot replay.
  const h2 = await makeHqOwner('inv-18k-other');
  reused(await pauseCmd(h2.subject, pIn('PAUSE', ka.id), k1), 'another actor replaying the key');
  const h3 = await makeHqOwner('inv-18k-revoked');
  const k3 = K();
  assert.equal((await pauseCmd(h3.subject, pIn('PAUSE', kb.id), k3)).value?.rows[0].r.status, 'ACTIVE');
  await admin.query('UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp() WHERE principal_id=$1', [h3.id]);
  assert.equal((await pauseCmd(h3.subject, pIn('PAUSE', kb.id), k3)).error?.code, '42501', 'a revoked owner cannot replay');
  assert.equal((await pauseCmd(hq.subject, pIn('RESUME', kb.id), K())).value?.rows[0].r.status, 'ENDED');
  checks.push('other actor refused, revoked owner cannot replay');
  // Concurrent: two incompatible commands with one key (a PAUSE for one organization and a RESUME for another) both
  // wait on the key lock (pg_locks); on release exactly one is applied and the other is refused.
  assert.equal((await pauseCmd(hq.subject, pIn('PAUSE', kc.id), K())).value?.rows[0].r.status, 'ACTIVE');
  const k4 = K();
  const holder = await openTx();
  await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('ai.pause.key:' || $1::text, 0))", [k4]);
  const c1 = await startBlocked(pauseSql, [hq.subject, JSON.stringify(pIn('PAUSE', kb.id)), k4], 'advisory');
  const c2 = await startBlocked(pauseSql, [hq.subject, JSON.stringify(pIn('RESUME', kc.id)), k4], 'advisory');
  await holder.query('COMMIT'); await holder.end();
  const both = [await c1.result, await c2.result];
  assert.equal(both.filter((r) => r.value).length, 1, `exactly one applied: ${JSON.stringify(both.map((r) => r.value?.rows[0].r ?? r.error?.message))}`);
  reused(both.find((r) => r.error), 'the concurrent loser');
  assert.equal((await row('SELECT count(*)::int n FROM hon.ai_spend_pause_commands WHERE command_key=$1', [k4])).n, 1);
  // PAUSE won: kb paused, kc still paused. RESUME won: kb not paused, kc resumed.
  const pauseWon = both[0].value !== undefined;
  assert.deepEqual([await active(kb), await active(kc)], pauseWon ? [1, 1] : [0, 0], 'only the winning command changed state');
  for (const o of [kb, kc]) if (await active(o)) await pauseCmd(hq.subject, pIn('RESUME', o.id), K());
  checks.push('concurrent incompatible reuse: one applied, one refused');
  assert.equal((await settle(admin.query('UPDATE hon.ai_spend_pause_commands SET reason=$1', ['Tampered synthetic command reason']))).error?.code, '55000', 'command identities are immutable');
  pass('INV-18K', `S4-c: one immutable command-key identity for pause/resume (action, scope, class, reason, actor): ${checks.join('; ')}`);
  }

  // ---- INV-19 (S4-d, replaces KF-AI8): lost outcomes count only in the window in which they were held ----
  {
  const backdate = async (table, id, interval, status = null) => {
    await admin.query('BEGIN');
    await admin.query(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);
    await admin.query(`UPDATE hon.${table} SET status=coalesce($3,status),created_at=created_at-$2::interval,updated_at=clock_timestamp()-$2::interval,held_at=held_at-$2::interval WHERE id=$1`, [id, interval, status]);
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

  // ---- INV-20R (S4-d, Manus review P1): HQ authority holds through UNKNOWN resolution (two connections) ----
  // Same pattern as INV-18R: authority is checked, then held by the shared lock on users/principals/HQ grants/family
  // grants, and checked again after the key lock and after the invocation row lock. A refusal writes nothing: no
  // resolution, ledger, audit or outbox row, and the hold stays as it was. No provider is involved (none is called).
  {
  const resolveSql = 'SELECT hon.resolve_ai_unknown_invocation($1,$2,$3::uuid,$4::jsonb,$5::uuid,$6::uuid,$7::uuid) r';
  const noCharge = { decision: 'NO_PROVIDER_CHARGE', reason: REASON, evidence: { providerLookupReference: 'lookup-ai0-race-1' } };
  const args = (h, id) => [h.subject, 'MARKETING', id, JSON.stringify(noCharge), K(), K(), K()];
  const evidence = async (id) => row(`SELECT i.status, i.reserved_credits::int reserved, i.usage_id,
      (SELECT count(*)::int FROM hon.ai_unknown_resolutions r WHERE r.invocation_id=i.id) resolutions,
      (SELECT count(*)::int FROM hon.ai_usage_ledger l WHERE l.source_invocation_id=i.id) ledger,
      (SELECT count(*)::int FROM hon.audit_events a WHERE a.entity_id=i.id AND a.action_code='hq.ai.unknown_invocation.resolve') audits,
      (SELECT count(*)::int FROM hon.outbox_events o WHERE o.aggregate_id=i.id AND o.event_type='ai.unknown_invocation.resolved') outbox
    FROM hon.marketing_ai_invocations i WHERE i.id=$1`, [id]);
  const untouched = (e) => e.status === 'UNKNOWN' && e.reserved === agents.marcus.estimate && e.usage_id === null && e.resolutions + e.ledger + e.audits + e.outbox === 0;
  const outcomes = [];
  for (const [label, change] of [['revoked', "effective_until=clock_timestamp()"], ['downgraded to operator', "hq_role='HON_HQ_OPERATOR',permission_codes='{hq.billing.manage}'"]]) {
    const lost = await lostOutcome(`inv-20r-${label.split(' ')[0]}`);
    const h = await makeHqOwner(`inv-20r-${label.split(' ')[0]}`);
    const revoker = await openTx();
    await revoker.query(`UPDATE hon.hq_operator_grants SET ${change} WHERE principal_id=$1`, [h.id]);
    const c0 = providerCalls;
    const cmd = await startBlocked(resolveSql, args(h, lost.id), 'relation');
    await revoker.query('COMMIT'); await revoker.end();
    const r = await cmd.result;
    assert.equal(providerCalls, c0, 'a resolution never calls a provider');
    assert.equal(r.error?.code, '42501', `${label} while waiting must refuse the resolution: ${JSON.stringify(r.value?.rows[0] ?? r.error?.message)}`);
    const e = await evidence(lost.id);
    assert(untouched(e), `${label}: nothing written: ${JSON.stringify(e)}`);
    outcomes.push(`${label}: refused`);
  }
  // Expired by the clock while waiting on the invocation row lock (held by another transaction, e.g. a recording).
  {
    const lost = await lostOutcome('inv-20r-expiry');
    const h = await makeHqOwner('inv-20r-expiry', "clock_timestamp()+interval '4 seconds'");
    const other = await openTx();
    await other.query('SELECT 1 FROM hon.marketing_ai_invocations WHERE id=$1 FOR UPDATE', [lost.id]);
    const c0 = providerCalls;
    const cmd = await startBlocked(resolveSql, args(h, lost.id), 'transactionid');
    for (const end = Date.now() + 10000; !(await row('SELECT clock_timestamp() > $1::timestamptz r', [h.until])).r; await sleep(50)) if (Date.now() > end) throw new Error('grant did not expire');
    await other.query('COMMIT'); await other.end();
    const r = await cmd.result;
    assert.equal(providerCalls, c0, 'a resolution never calls a provider');
    assert.equal(r.error?.code, '42501', `expired while waiting must refuse the resolution: ${JSON.stringify(r.value?.rows[0] ?? r.error?.message)}`);
    const e = await evidence(lost.id);
    assert(untouched(e), `expired: nothing written: ${JSON.stringify(e)}`);
    outcomes.push('expired while waiting on the invocation row: refused');
  }
  // A revocation issued while the resolution waits queues behind it; the resolution completes, then the revocation applies.
  {
    const lost = await lostOutcome('inv-20r-ordered');
    const h = await makeHqOwner('inv-20r-ordered');
    const other = await openTx();
    await other.query('SELECT 1 FROM hon.marketing_ai_invocations WHERE id=$1 FOR UPDATE', [lost.id]);
    const c0 = providerCalls;
    const cmd = await startBlocked(resolveSql, args(h, lost.id), 'transactionid');
    const revoke = await startBlocked('UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp() WHERE principal_id=$1', [h.id], 'relation', { tx: true });
    await other.query('COMMIT'); await other.end();
    const r = await cmd.result;
    assert.equal(providerCalls, c0, 'a resolution never calls a provider');
    assert.equal(r.value?.rows[0].r.decision, 'NO_PROVIDER_CHARGE', `the resolution decided before the revocation: ${JSON.stringify(r.error?.message)}`);
    assert.equal((await revoke.result).error, undefined);
    await revoke.client.query('COMMIT'); await revoke.client.end();
    const again = await lostOutcome('inv-20r-after');
    assert.equal((await settle(admin.query(resolveSql, args(h, again.id)))).error?.code, '42501', 'the revoked owner is refused afterwards');
    assert(untouched(await evidence(again.id)));
    outcomes.push('revocation during the resolution: waits, applies after');
  }
  pass('INV-20R', `S4-d: HQ UNKNOWN-resolution authority holds through the mutation (two-connection, pg_locks-observed waits): ${outcomes.join('; ')}; refusals write no resolution, ledger, audit or outbox row and keep the hold`);
  }

  // ---- INV-19W (S4-d, Manus final review P2): a hold's window is its immutable held_at, never updated_at ----
  // Natural cross-window progression in real transactions, for each agent: the hold is taken (SENDING, provider call
  // pending), its origin is moved to the previous window (simulated clock), then the real service records the provider
  // outcome as UNKNOWN now, which rewrites updated_at in the current window. The hold must stay in its original window:
  // it no longer limits the school, the HQ queue shows the original time, and a late resolution books the cost there.
  {
  const errors = { marcus: ProviderRuntimeError, claire: ClaireProviderRuntimeError, chad: ChadProviderRuntimeError };
  const agentCode = { marcus: 'MARKETING', claire: 'TEACHING', chad: 'CHAD_FOLLOW_UP' };
  const inWindow = async (o, t) => (await row('SELECT $2::timestamptz <@ hon.ai_spend_window($1, clock_timestamp()) r', [o.id, t])).r;
  const seen = [];
  for (const name of ['marcus', 'claire', 'chad']) {
    const a = agents[name], o = await makeOrg(`inv-19w-${name}`);
    const held = await startHeld(name, o);
    assert.equal(held.sending, true, `${name}: the hold is taken`);
    const inv = await row(`SELECT id, held_at FROM hon.${a.table} WHERE organization_id=$1 AND status='SENDING'`, [o.id]);
    assert.ok(inv.held_at, `${name}: held_at is stamped when the hold is taken`);
    // Tampering with the origin is refused, even by the table owner.
    // The table's column guard refuses it first (42501); the stamping trigger would refuse it too (55000).
    assert.ok(['42501', '55000'].includes((await settle(admin.query(`UPDATE hon.${a.table} SET held_at=clock_timestamp() WHERE id=$1`, [inv.id]))).error?.code), `${name}: held_at is immutable`);
    await admin.query('BEGIN');
    await admin.query(`ALTER TABLE hon.${a.table} DISABLE TRIGGER USER`);
    await admin.query(`UPDATE hon.${a.table} SET held_at=held_at-interval '40 days', created_at=created_at-interval '40 days' WHERE id=$1`, [inv.id]);
    await admin.query(`ALTER TABLE hon.${a.table} ENABLE TRIGGER USER`);
    await admin.query('COMMIT');
    // The provider outcome arrives now, as UNKNOWN, through the real service and its own fail_* transaction.
    for (const h of fakes[name].held.splice(0)) h.reject(new errors[name]('UNKNOWN', 'PROVIDER_UNKNOWN'));
    const settled = await held.submitted;
    assert.equal(settled.value?.status ?? settled.error?.getResponse?.()?.code, 'UNKNOWN', `${name}: outcome recorded as UNKNOWN`);
    const after = await row(`SELECT status, held_at, updated_at, reserved_credits FROM hon.${a.table} WHERE id=$1`, [inv.id]);
    assert.deepEqual([after.status, after.reserved_credits > 0, await inWindow(o, after.updated_at), await inWindow(o, after.held_at)], ['UNKNOWN', true, true, false],
      `${name}: updated_at moved to the current window, held_at stayed in the original one`);
    assert.equal(Number((await row('SELECT hon.ai_org_committed_credits($1, clock_timestamp()) n', [o.id])).n), 0, `${name}: the old-window hold no longer limits the school`);
    const q = (await row('SELECT hon.read_ai_unknown_invocations_from_hq($1) r', [hq.subject])).r.open.find((x) => x.invocationId === inv.id);
    assert.deepEqual([q?.countsAgainstCurrentWindow, q?.heldAt === new Date(after.held_at).toISOString()], [false, true], `${name}: HQ queue shows the original time`);
    const rec = await resolve(hq.subject, agentCode[name], inv.id, { ...recordInput, evidence: { ...recordInput.evidence, providerGenerationId: `gen-ai0-19w-${name}` } });
    assert.ok(rec.value, `${name}: ${rec.error?.message}`);
    const led = await ledgerFor(inv.id);
    assert.deepEqual([led.length, new Date(led[0].occurred_at).toISOString()], [1, new Date(after.held_at).toISOString()], `${name}: the late cost is booked in the original window`);
    seen.push(name);
  }
  // No trustworthy origin (a hold from before held_at existed): fail closed. It always counts, shows no time, and is
  // never resolvable (Manus delta review P2): any decision would release capacity on an unproven origin.
  const legacy = await lostOutcome('inv-19w-legacy');
  await admin.query('BEGIN');
  await admin.query(`ALTER TABLE hon.${agents.marcus.table} DISABLE TRIGGER USER`);
  await admin.query(`UPDATE hon.${agents.marcus.table} SET held_at=NULL, updated_at=updated_at-interval '40 days' WHERE id=$1`, [legacy.id]);
  await admin.query(`ALTER TABLE hon.${agents.marcus.table} ENABLE TRIGGER USER`);
  await admin.query('COMMIT');
  assert.equal(Number((await row('SELECT hon.ai_org_committed_credits($1, clock_timestamp()) n', [legacy.o.id])).n), agents.marcus.estimate, 'a NULL-origin hold always counts');
  const lq = (await row('SELECT hon.read_ai_unknown_invocations_from_hq($1) r', [hq.subject])).r.open.find((x) => x.invocationId === legacy.id);
  assert.deepEqual([lq?.heldAt, lq?.countsAgainstCurrentWindow], [null, true]);
  assert.equal((await resolve(hq.subject, 'MARKETING', legacy.id, recordInput)).error?.message, 'AI_UNKNOWN_ORIGIN_UNAVAILABLE');
  assert.equal((await resolve(hq.subject, 'MARKETING', legacy.id, { decision: 'WRITE_OFF', reason: REASON, evidence: { estimatedProviderCostMicrounits: 1 } })).error?.message, 'AI_UNKNOWN_ORIGIN_UNAVAILABLE');
  assert.equal((await resolve(hq.subject, 'MARKETING', legacy.id, { decision: 'NO_PROVIDER_CHARGE', reason: REASON, evidence: { providerLookupReference: 'lookup-ai0-legacy' } })).error?.message, 'AI_UNKNOWN_ORIGIN_UNAVAILABLE');
  assert.equal(Number((await row('SELECT hon.ai_org_committed_credits($1, clock_timestamp()) n', [legacy.o.id])).n), agents.marcus.estimate, 'a refused NULL-origin hold keeps counting');
  pass('INV-19W', `S4-d: immutable hold origin: for ${seen.join(', ')} a hold taken last window and recorded UNKNOWN now (updated_at current) stays in its original window (not counted now, HQ shows the original time, late cost booked there); held_at cannot be set; a NULL-origin hold counts always and refuses every decision`);
  }

  // ---- INV-19N (S4-d, Manus delta review P2): a hold without a trustworthy origin is never released ----
  // For each agent, a real SENDING hold whose held_at is missing (as for a hold taken before held_at existed): before
  // and after the stale limit measured on the mutable updated_at/created_at, under concurrent resolution attempts, and
  // after the provider outcome turns it UNKNOWN, no decision releases it: it keeps counting, nothing is written. A hold
  // with a trustworthy origin is still resolved exactly once under concurrent attempts (one ledger row, one release).
  {
  const errors = { marcus: ProviderRuntimeError, claire: ClaireProviderRuntimeError, chad: ChadProviderRuntimeError };
  const agentCode = { marcus: 'MARKETING', claire: 'TEACHING', chad: 'CHAD_FOLLOW_UP' };
  const committed = async (o) => Number((await row('SELECT hon.ai_org_committed_credits($1, clock_timestamp()) n', [o.id])).n);
  const written = async (id) => row(`SELECT (SELECT count(*)::int FROM hon.ai_unknown_resolutions WHERE invocation_id=$1) res,
      (SELECT count(*)::int FROM hon.ai_usage_ledger WHERE source_invocation_id=$1) led,
      (SELECT count(*)::int FROM hon.audit_events WHERE entity_id=$1 AND action_code='hq.ai.unknown_invocation.resolve') aud,
      (SELECT count(*)::int FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='ai.unknown_invocation.resolved') obx`, [id]);
  const adminPatch = async (table, id, set) => {
    await admin.query('BEGIN');
    await admin.query(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);
    await admin.query(`UPDATE hon.${table} SET ${set} WHERE id=$1`, [id]);
    await admin.query(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`);
    await admin.query('COMMIT');
  };
  const decisions = (name, tag) => [
    { ...recordInput, evidence: { ...recordInput.evidence, providerGenerationId: `gen-ai0-19n-${name}-${tag}` } },
    { decision: 'WRITE_OFF', reason: REASON, evidence: { estimatedProviderCostMicrounits: 900 } },
    { decision: 'NO_PROVIDER_CHARGE', reason: REASON, evidence: { providerLookupReference: `lookup-ai0-19n-${name}-${tag}` } }];
  const allRefused = async (name, id, tag, label) => {
    const key = K();
    const attempts = await Promise.all([...decisions(name, tag), ...decisions(name, `${tag}-b`)].map((input, i) => resolve(hq.subject, agentCode[name], id, input, i === 5 ? key : K()))
      .concat([resolve(hq.subject, agentCode[name], id, decisions(name, tag)[2], key)]));
    for (const r of attempts) assert.equal(r.error?.message, 'AI_UNKNOWN_ORIGIN_UNAVAILABLE', `${name} ${label}: ${r.error?.message ?? 'released'}`);
  };
  const seen = [];
  for (const name of ['marcus', 'claire', 'chad']) {
    const a = agents[name], o = await makeOrg(`inv-19n-${name}`);
    const held = await startHeld(name, o);
    assert.equal(held.sending, true, `${name}: the hold is taken`);
    const inv = await row(`SELECT id FROM hon.${a.table} WHERE organization_id=$1 AND status='SENDING'`, [o.id]);
    await adminPatch(a.table, inv.id, 'held_at=NULL');
    // Before the stale limit (updated_at fresh): every decision is refused, concurrently, with no write.
    await allRefused(name, inv.id, 'fresh', 'NULL-origin SENDING before the stale limit');
    assert.equal(await committed(o), a.estimate, `${name}: still counts`);
    // After the stale limit measured only on the mutable timestamps: still refused; staleness is never inferred.
    await adminPatch(a.table, inv.id, "updated_at=clock_timestamp()-interval '2 hours', created_at=created_at-interval '2 hours'");
    await allRefused(name, inv.id, 'stale', 'NULL-origin SENDING past the stale limit by updated_at');
    assert.deepEqual([await committed(o), (await reservedByAgent(o))[name], await sendingCount(o)], [a.estimate, a.estimate, 1], `${name}: the hold is untouched`);
    // The provider outcome arrives as UNKNOWN: the NULL-origin UNKNOWN hold is refused too.
    for (const h of fakes[name].held.splice(0)) h.reject(new errors[name]('UNKNOWN', 'PROVIDER_UNKNOWN'));
    await held.submitted;
    assert.equal((await row(`SELECT status FROM hon.${a.table} WHERE id=$1`, [inv.id])).status, 'UNKNOWN');
    await allRefused(name, inv.id, 'unknown', 'NULL-origin UNKNOWN');
    assert.deepEqual([await committed(o), (await reservedByAgent(o))[name]], [a.estimate, a.estimate], `${name}: no release`);
    assert.deepEqual(await written(inv.id), { res: 0, led: 0, aud: 0, obx: 0 }, `${name}: nothing written`);
    const q = (await row('SELECT hon.read_ai_unknown_invocations_from_hq($1) r', [hq.subject])).r.open.find((x) => x.invocationId === inv.id);
    assert.deepEqual([q?.heldAt, q?.countsAgainstCurrentWindow], [null, true], `${name}: HQ sees an open hold with no time that still counts`);
    // With a trustworthy origin: a fresh SENDING hold is not resolvable; an UNKNOWN one resolves exactly once under
    // concurrent attempts (one ledger row and one provider cost, one release).
    const o2 = await makeOrg(`inv-19n-${name}-valid`);
    const held2 = await startHeld(name, o2);
    const inv2 = await row(`SELECT id, held_at FROM hon.${a.table} WHERE organization_id=$1 AND status='SENDING'`, [o2.id]);
    assert.ok(inv2.held_at);
    await adminPatch(a.table, inv2.id, "updated_at=clock_timestamp()-interval '2 hours', created_at=created_at-interval '2 hours'");
    assert.equal((await resolve(hq.subject, agentCode[name], inv2.id, decisions(name, 'v0')[2])).error?.message, 'AI_UNKNOWN_NOT_RESOLVABLE', `${name}: a SENDING hold with a fresh origin is in flight`);
    for (const h of fakes[name].held.splice(0)) h.reject(new errors[name]('UNKNOWN', 'PROVIDER_UNKNOWN'));
    await held2.submitted;
    const race = await Promise.all([decisions(name, 'v1')[0], decisions(name, 'v2')[0], decisions(name, 'v3')[2]].map((input) => resolve(hq.subject, agentCode[name], inv2.id, input)));
    assert.equal(race.filter((r) => r.value).length, 1, `${name}: exactly one concurrent resolution wins`);
    for (const r of race.filter((x) => x.error)) assert.equal(r.error.message, 'AI_UNKNOWN_NOT_RESOLVABLE');
    const w = await written(inv2.id);
    assert.deepEqual([w.res, w.aud, w.obx, w.led <= 1, (await reservedByAgent(o2))[name]], [1, 1, 1, true, 0], `${name}: one release, no duplicate cost`);
    seen.push(name);
  }
  pass('INV-19N', `S4-d: for ${seen.join(', ')} a SENDING hold without a trustworthy origin is never released (before and after the stale limit by updated_at, under 7 concurrent attempts incl. a key replay, and after it turns UNKNOWN): it keeps counting, the HQ queue shows it, no resolution/ledger/audit/outbox row; a hold with an origin: fresh SENDING refused, UNKNOWN resolved exactly once under 3 concurrent attempts (no duplicate provider cost)`);
  }

  // ---- INV-20L (S4-d, Manus final review P2): a verified provider charge after a WRITE_OFF is recorded once ----
  {
  const lateSql = 'SELECT hon.record_ai_late_provider_expense($1,$2,$3::uuid,$4::jsonb,$5::uuid,$6::uuid,$7::uuid) r';
  const late = (subject, agent, id, input, key = K()) => settle(admin.query(lateSql, [subject, agent, id, JSON.stringify(input), key, K(), K()]));
  const lateIn = (gen, cost) => ({ reason: 'Provider usage export showed the actual charge', evidence: { providerGenerationId: gen, inputTokens: 1000, outputTokens: 500, providerCostMicrounits: cost } });
  const res = await row("SELECT * FROM hon.ai_unknown_resolutions WHERE invocation_id=$1", [staleOld.id]);
  assert.equal(res.decision, 'WRITE_OFF');
  const committedBefore = Number((await row('SELECT hon.ai_org_committed_credits($1, clock_timestamp()) n', [staleOld.o.id])).n);
  const audits0 = (await row("SELECT count(*)::int n FROM hon.audit_events WHERE action_code='hq.ai.late_provider_expense.record'")).n;
  assert.equal((await late(staleOld.o.subject, 'TEACHING', staleOld.id, lateIn('gen-ai0-late-1', 1100))).error?.code, '42501', 'a school owner cannot record it');
  for (const bad of [{ ...lateIn('gen-ai0-late-1', 1100), extra: 1 }, { reason: 'short', evidence: lateIn('x', 1).evidence }, { ...lateIn('gen ai0', 1), evidence: { ...lateIn('g', 1).evidence, providerGenerationId: 'bad id' } }])
    assert.equal((await late(hq.subject, 'TEACHING', staleOld.id, bad)).error?.code, '22023', JSON.stringify(bad));
  const key = K();
  const first = await late(hq.subject, 'TEACHING', staleOld.id, lateIn('gen-ai0-late-1', 1100), key);
  const receipt = first.value?.rows[0].r;
  assert.deepEqual([receipt?.customerCredits, receipt?.providerCostMicrounits, receipt?.estimatedProviderCostMicrounits, receipt?.replayed], [0, 1100, 900, false], JSON.stringify(first.error?.message ?? receipt));
  const led = await rows('SELECT id, customer_credits::int c, provider_cost_microunits::bigint cost FROM hon.ai_usage_ledger WHERE source_invocation_id=$1', [staleOld.id]);
  assert.deepEqual(led.map((l) => [l.id, l.c, Number(l.cost)]), [[res.ledger_entry_id, 0, 900]], 'the WRITE_OFF ledger row is the only ledger row for the call, unchanged; the actual is separate evidence');
  const exp = await row('SELECT occurred_at, provider_cost_microunits::bigint cost, estimated_provider_cost_microunits::bigint est FROM hon.ai_late_provider_expenses WHERE invocation_id=$1', [staleOld.id]);
  assert.deepEqual([new Date(exp.occurred_at).toISOString(), Number(exp.cost), Number(exp.est)], [new Date(res.held_at).toISOString(), 1100, 900], 'attributed to the original hold window');
  const resAfter = await row("SELECT decision, evidence, ledger_entry_id FROM hon.ai_unknown_resolutions WHERE id=$1", [res.id]);
  assert.deepEqual([resAfter.decision, resAfter.evidence, resAfter.ledger_entry_id], [res.decision, res.evidence, res.ledger_entry_id], 'the WRITE_OFF decision and estimate are unchanged');
  assert.equal(Number((await row('SELECT hon.ai_org_committed_credits($1, clock_timestamp()) n', [staleOld.o.id])).n), committedBefore, 'no customer credit is deducted again');
  // Replay, key reuse, a second actual for the same call, and a duplicate provider generation are all refused.
  assert.equal((await late(hq.subject, 'TEACHING', staleOld.id, lateIn('gen-ai0-late-1', 1100), key)).value?.rows[0].r.replayed, true, 'exact replay');
  assert.equal((await late(hq.subject, 'TEACHING', staleOld.id, lateIn('gen-ai0-late-1', 1200), key)).error?.message, 'AI_LATE_EXPENSE_KEY_REUSED');
  assert.equal((await late(hq.subject, 'TEACHING', staleOld.id, lateIn('gen-ai0-late-2', 1200))).error?.message, 'AI_LATE_EXPENSE_ALREADY_RECORDED');
  // Zero estimate: a WRITE_OFF of 0, then the actual charge; a reused generation id on it is refused first.
  const zero = await lostOutcome('inv-20l-zero', 'chad');
  assert.ok((await resolve(hq.subject, 'CHAD_FOLLOW_UP', zero.id, { decision: 'WRITE_OFF', reason: REASON, evidence: { estimatedProviderCostMicrounits: 0 } })).value);
  assert.equal((await late(hq.subject, 'CHAD_FOLLOW_UP', zero.id, lateIn('gen-ai0-late-1', 700))).error?.message, 'AI_LATE_EXPENSE_DUPLICATE_GENERATION');
  assert.equal((await late(hq.subject, 'CHAD_FOLLOW_UP', zero.id, lateIn('gen-ai0-late-zero', 700))).value?.rows[0].r.providerCostMicrounits, 700);
  assert.deepEqual((await rows('SELECT customer_credits::int c, provider_cost_microunits::bigint cost FROM hon.ai_usage_ledger WHERE source_invocation_id=$1', [zero.id])).map((l) => [l.c, Number(l.cost)]), [[0, 0]], 'zero estimate: one zero-credit ledger row');
  assert.equal(Number((await row('SELECT count(*) n FROM hon.ai_late_provider_expenses WHERE invocation_id=$1', [zero.id])).n), 1);
  // Only after a WRITE_OFF: a recorded cost or a no-charge resolution cannot take a late actual.
  assert.equal((await late(hq.subject, 'MARKETING', old.id, lateIn('gen-ai0-late-3', 1))).error?.message, 'AI_LATE_EXPENSE_NOT_WRITTEN_OFF');
  assert.equal((await late(hq.subject, 'MARKETING', cur.id, lateIn('gen-ai0-late-4', 1))).error?.message, 'AI_LATE_EXPENSE_NOT_WRITTEN_OFF');
  assert.equal((await late(hq.subject, 'MARKETING', K(), lateIn('gen-ai0-late-5', 1))).error?.code, 'P0002');
  assert.equal((await row("SELECT count(*)::int n FROM hon.audit_events WHERE action_code='hq.ai.late_provider_expense.record'")).n - audits0, 2, 'one audit row per recorded expense');
  assert.equal((await settle(admin.query('UPDATE hon.ai_late_provider_expenses SET reason=$1', ['Tampered synthetic late expense']))).error?.code, '55000');
  const item = (await row('SELECT hon.read_ai_unknown_invocations_from_hq($1) r', [hq.subject])).r.resolved.find((x) => x.invocationId === staleOld.id);
  assert.equal(item?.lateProviderExpense?.providerCostMicrounits, 1100, 'the HQ queue shows the late actual next to the write-off');
  pass('INV-20L', 'S4-d: a verified provider charge after a WRITE_OFF is recorded once as separate immutable evidence (no second ledger row; original hold window), the WRITE_OFF decision, estimate and ledger row stay, no credit is deducted again; replay, key reuse, a second actual and a duplicate provider generation are refused (also for a zero estimate); HQ-owner only; audited');
  }

  // ---- INV-21 (S4-e): HQ per-school AI usage and actual provider cost, read only ----
  {
  const usage = (subject, from, to) => settle(admin.query('SELECT hon.read_ai_school_usage_from_hq($1,$2::timestamptz,$3::timestamptz) r', [subject, from, to]));
  const from = new Date(Date.now() - 90 * 86_400_000).toISOString(), to = new Date(Date.now() + 3_600_000).toISOString();
  // A non-agent (CREATIVE_MEDIA) provider expense row, as the creative wallet (CW1) records them: it has no agent, so
  // the per-agent breakdown must skip it rather than fail the whole HQ read (CW1 review P2-A regression).
  await admin.query("INSERT INTO hon.ai_usage_ledger(organization_id,school_id,provider_code,model_code,modality,customer_credits,provider_cost_microunits,correlation_id,spend_class) VALUES($1,$2,'OPENROUTER','ai0-creative','IMAGE',0,5000,$3,'CREATIVE_MEDIA')", [old.o.id, old.o.school, K()]);
  // Manus delta review P2: a school whose only activity is unresolved calls (no ledger row at all) must still be listed;
  // a school with no activity at all is not. One org with an UNKNOWN hold from each agent and nothing recorded, and one
  // org with nothing.
  const unresolvedOnly = await lostOutcome('inv-21-unresolved-only', 'marcus');
  for (const name of ['claire', 'chad']) {
    fakes[name].mode = 'UNKNOWN';
    assert.equal((await agents[name].service.submit(context(unresolvedOnly.o), agents[name].input(unresolvedOnly.o))).status, 'UNKNOWN');
    fakes[name].mode = 'RESULT';
  }
  const idle = await makeOrg('inv-21-zero-activity');
  const ledgerBefore = (await row('SELECT count(*)::int n FROM hon.ai_usage_ledger')).n;
  const read = await usage(hq.subject, from, to);
  const report = read.value?.rows[0].r;
  assert(report, JSON.stringify(read.error?.message));
  // Independent per-school totals straight from the ledger: each school is reported exactly once and only with its own rows.
  // Cost basis comes from the resolution records: a WRITE_OFF row's cost is an estimate, never a provider charge.
  const expected = await rows(`SELECT u.organization_id o, u.school_id s, u.spend_class c, sum(u.customer_credits)::bigint credits,
      coalesce(sum(u.provider_cost_microunits) FILTER (WHERE r.id IS NULL),0)::bigint cost, coalesce(sum(u.provider_cost_microunits) FILTER (WHERE r.id IS NOT NULL),0)::bigint estimate,
      count(*)::int n, count(r.id)::int w
    FROM hon.ai_usage_ledger u LEFT JOIN hon.ai_unknown_resolutions r ON r.ledger_entry_id=u.id AND r.decision='WRITE_OFF'
    WHERE u.occurred_at >= $1 AND u.occurred_at < $2 GROUP BY 1,2,3`, [from, to]);
  // Independent unresolved counts per school (the HQ queue predicate on the immutable origin).
  const unresolvedExpected = await rows(`SELECT organization_id o, school_id s, count(*)::int n FROM (
      SELECT organization_id, school_id, status, held_at, reserved_credits FROM hon.marketing_ai_invocations
      UNION ALL SELECT organization_id, school_id, status, held_at, reserved_credits FROM hon.teaching_ai_invocations
      UNION ALL SELECT organization_id, school_id, status, held_at, reserved_credits FROM hon.chad_follow_up_invocations) h
    WHERE reserved_credits > 0 AND (status = 'UNKNOWN' OR (status = 'SENDING' AND held_at <= clock_timestamp() - interval '1 hour')) GROUP BY 1,2`);
  const schoolsSeen = new Set([...expected, ...unresolvedExpected].map((e) => `${e.o}/${e.s}`));
  assert.equal(report.truncated, false);
  assert.equal(report.schools.length, schoolsSeen.size, 'one entry per school with usage in range or unresolved calls now');
  assert.equal(new Set(report.schools.map((x) => `${x.organizationId}/${x.schoolId}`)).size, report.schools.length, 'no school reported twice');
  for (const e of unresolvedExpected)
    assert.equal(report.schools.find((x) => x.organizationId === e.o && x.schoolId === e.s)?.unreconciledInvocations, e.n, `school ${e.s} unresolved count`);
  for (const x of report.schools)
    if (!unresolvedExpected.some((e) => e.o === x.organizationId && e.s === x.schoolId)) assert.equal(x.unreconciledInvocations, 0, `school ${x.schoolId} has no unresolved call`);
  // The unresolved-only school is listed once, with its three unresolved calls and no amount at all (no ledger class,
  // no invented cost); the zero-activity school is not listed; the totals reconcile with the ledger (no double count).
  const uo = report.schools.filter((x) => x.schoolId === unresolvedOnly.o.school);
  assert.equal(uo.length, 1, 'an unresolved-only school is listed exactly once');
  assert.deepEqual([uo[0].unreconciledInvocations, uo[0].entries, uo[0].providerReportedCostMicrounits, uo[0].estimatedWriteOffCostMicrounits,
    uo[0].lateProviderCostMicrounits, uo[0].writeOffEntries, uo[0].byClass], [3, 0, 0, 0, 0, 0, {}], JSON.stringify(uo[0]));
  assert.equal(report.schools.some((x) => x.schoolId === idle.school || x.organizationId === idle.id), false, 'a zero-activity school is not listed');
  assert.equal(report.organizations.find((x) => x.organizationId === unresolvedOnly.o.id)?.openUnknownHolds, 3, 'its organization is listed with its open holds');
  const ledgerTotals = await row(`SELECT count(*)::int n, coalesce(sum(u.provider_cost_microunits) FILTER (WHERE r.id IS NULL),0)::bigint cost,
      coalesce(sum(u.provider_cost_microunits) FILTER (WHERE r.id IS NOT NULL),0)::bigint estimate
    FROM hon.ai_usage_ledger u LEFT JOIN hon.ai_unknown_resolutions r ON r.ledger_entry_id=u.id AND r.decision='WRITE_OFF' WHERE u.occurred_at >= $1 AND u.occurred_at < $2`, [from, to]);
  assert.deepEqual([report.schools.reduce((t, x) => t + x.entries, 0), report.schools.reduce((t, x) => t + x.providerReportedCostMicrounits, 0), report.schools.reduce((t, x) => t + x.estimatedWriteOffCostMicrounits, 0)],
    [ledgerTotals.n, Number(ledgerTotals.cost), Number(ledgerTotals.estimate)], 'entries, provider cost and estimates reconcile with the ledger exactly once');
  for (const e of expected) {
    const sch = report.schools.find((x) => x.organizationId === e.o && x.schoolId === e.s);
    const cls = sch?.byClass?.[e.c];
    assert.deepEqual([cls?.credits, cls?.providerReportedCostMicrounits, cls?.estimatedWriteOffCostMicrounits, cls?.entries, cls?.writeOffEntries],
      [Number(e.credits), Number(e.cost), Number(e.estimate), e.n, e.w], `school ${e.s} class ${e.c}`);
  }
  // Agent attribution comes from the S4-a source invocation; pre-S4-a style rows are UNATTRIBUTED, never guessed.
  const oldSchool = report.schools.find((x) => x.schoolId === old.o.school);
  assert.equal(oldSchool.byClass.AGENT_INFERENCE.byAgent.MARKETING?.providerReportedCostMicrounits >= 2400, true, JSON.stringify(oldSchool));
  assert.equal(oldSchool.byClass.AGENT_INFERENCE.byAgent.MARKETING?.estimatedWriteOffCostMicrounits, 0, 'RECORD_PROVIDER_COST is provider evidence, not an estimate');
  assert.equal(oldSchool.byClass.AGENT_INFERENCE.byAgent.UNATTRIBUTED?.credits, 11990, 'the synthetic used-credit fixture row has no source invocation');
  const offSchool = report.schools.find((x) => x.schoolId === staleOld.o.school);
  // Manus review P2: the WRITE_OFF estimate (900) is reported as an estimate and is NOT in the provider-reported total.
  const offTeaching = offSchool.byClass.AGENT_INFERENCE.byAgent.TEACHING;
  assert.deepEqual([offTeaching?.providerReportedCostMicrounits, offTeaching?.estimatedWriteOffCostMicrounits, offTeaching?.writeOffEntries], [0, 900, 1], JSON.stringify(offSchool));
  assert.equal(offSchool.estimatedWriteOffCostMicrounits, 900);
  // Manus final review P2: the late verified actual (1100, INV-20L) is reported beside the estimate, never inside the
  // provider-reported total or the estimate; the estimate it supersedes is shown, and no credits or entries are added.
  assert.deepEqual([offTeaching?.lateProviderCostMicrounits, offTeaching?.lateProviderExpenseEntries, offTeaching?.supersededWriteOffEstimateMicrounits, offTeaching?.entries, offTeaching?.credits],
    [1100, 1, 900, 1, 0], JSON.stringify(offTeaching));
  assert.deepEqual([offSchool.lateProviderCostMicrounits, offSchool.supersededWriteOffEstimateMicrounits], [1100, 900]);
  const lateTotals = await row(`SELECT coalesce(sum(provider_cost_microunits),0)::bigint c, count(*)::int n FROM hon.ai_late_provider_expenses WHERE occurred_at >= $1 AND occurred_at < $2`, [from, to]);
  assert.deepEqual([report.schools.reduce((t, x) => t + x.lateProviderCostMicrounits, 0), report.schools.reduce((t, x) => t + x.lateProviderExpenseEntries, 0)],
    [Number(lateTotals.c), lateTotals.n], 'every late actual in range is reported once (incl. the zero-estimate Chad call)');
  assert.equal(offSchool.providerReportedCostMicrounits, Object.values(offSchool.byClass).reduce((a, c) => a + c.providerReportedCostMicrounits, 0));
  // Unknown outcomes carry no amount: they are counted per school, separately from both cost totals.
  const staleSchool = report.schools.find((x) => x.schoolId === staleCur.o.school);
  assert.equal(staleSchool?.unreconciledInvocations, 1, 'an open stale SENDING hold is reported as unreconciled');
  assert.equal(oldSchool.unreconciledInvocations, 0, 'a resolved outcome is not unreconciled');
  for (const sch of report.schools) assert.equal(sch.byClass.CREATIVE_MEDIA?.byAgent ?? null, null, 'creative rows are never attributed to an agent budget');
  assert.deepEqual([oldSchool.byClass.CREATIVE_MEDIA?.credits, oldSchool.byClass.CREATIVE_MEDIA?.providerReportedCostMicrounits >= 5000, oldSchool.byClass.CREATIVE_MEDIA?.estimatedWriteOffCostMicrounits], [0, true, 0], 'creative expense is reported in its own class');
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
  pass('INV-21', `S4-e: HQ per-school AI usage: ${report.schools.length} schools each reported once with only their own ledger rows, per class (credits never cross classes) and per agent (UNATTRIBUTED when no source), provider-reported cost, WRITE_OFF estimates, late actuals (with the estimate they supersede) and unreconciled calls kept separate (mixed agent + creative), an unresolved-only school listed once with no amount, a zero-activity school not listed, totals reconcile with the ledger, org budget equal to the S4-b/S4-d functions, open lost outcomes counted; HQ readers only, bounded range, read only`);
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
  // K1: the teaching fixture driver keeps its legacy name 'claire'; clients see that agent as Kai ('kai').
  // K2: the Business Performance 'claire' row is listed separately (as 'claire-bp' here) and never collides with Kai.
  const byKey = (r) => Object.fromEntries(r.agents.map((a) => [a.agentKey === 'kai' ? 'claire' : a.agentKey === 'claire' ? 'claire-bp' : a.agentKey, a]));
  const counts = async () => (await row(`SELECT (SELECT count(*) FROM hon.ai_invocation_plans)::int p, (SELECT count(*) FROM hon.ai_usage_ledger)::int l,
    (SELECT count(*) FROM hon.audit_events)::int a, (SELECT count(*) FROM hon.marketing_ai_invocations)+(SELECT count(*) FROM hon.teaching_ai_invocations)+(SELECT count(*) FROM hon.chad_follow_up_invocations)+(SELECT count(*) FROM hon.hon_reply_invocations) i`));
  const r0 = await makeOrg('inv-23');
  const before = await counts(), calls0 = Object.values(fakes).reduce((n, f) => n + f.calls, 0);
  const base = await ready(r0);
  assert.deepEqual(base.agents.map((a) => [a.agentKey, a.available, a.route, a.spendDecision]), [['marcus', true, 'CONFIGURED', 'ALLOWED'], ['kai', true, 'CONFIGURED', 'ALLOWED'], ['chad', true, 'CONFIGURED', 'ALLOWED'], ['hon', true, 'CONFIGURED', 'ALLOWED'], ['claire', true, 'CONFIGURED', 'ALLOWED'],
    ['alex', true, 'CONFIGURED', 'ALLOWED'], ['jordan', true, 'CONFIGURED', 'ALLOWED'], ['lena', true, 'CONFIGURED', 'ALLOWED']], JSON.stringify(base));
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
      // C2: the HON reply follows the whole-school gates only (it has no specialist permission of its own).
      assert(readiness === null || readiness.hon.available === (affected !== ALL), `hon ${label}: ${JSON.stringify(readiness?.hon)}`);
      // K2: Claire (Business Performance) follows the whole-school gates plus reporting.view, never the teaching permission.
      assert(readiness === null || readiness['claire-bp'].available === (affected !== ALL), `claire-bp ${label}: ${JSON.stringify(readiness?.['claire-bp'])}`);
      // 0260: Alex, Jordan and Lena follow the whole-school gates plus their own capability, never the teaching permission.
      for (const k of ['alex', 'jordan', 'lena']) assert(readiness === null || readiness[k].available === (affected !== ALL), `${k} ${label}: ${JSON.stringify(readiness?.[k])}`);
    } finally { await restore(); }
  }
  assert.deepEqual(byKey(await ready(r0)).claire.available, true, 'restored');
  // Specific blockers: HQ pause (S4-c), organization budget (S4-b), and a request that still fits the smaller Chad estimate.
  await setUsed(r0, 11996);
  const near = byKey(await ready(r0));
  assert.deepEqual([near.marcus.blockedBy, near.claire.blockedBy, near.chad.available, near.hon.blockedBy, near['claire-bp'].blockedBy], ['ORGANIZATION_AI_BUDGET_REACHED', 'ORGANIZATION_AI_BUDGET_REACHED', true, 'ORGANIZATION_AI_BUDGET_REACHED', 'ORGANIZATION_AI_BUDGET_REACHED'], JSON.stringify(near));
  assert.deepEqual([near.alex.blockedBy, near.jordan.blockedBy, near.lena.blockedBy], Array(3).fill('ORGANIZATION_AI_BUDGET_REACHED'), '0260: the same 15-credit estimate as Claire');
  // The real request is refused too (the planner's budget denial surfaces as a BLOCKED request with no provider call).
  assert.match(await expectRefused('marcus', r0, {}, 'INV-23 budget'), /^BLOCKED_/, 'the real request agrees');
  const pauseIn = { action: 'PAUSE', organizationId: r0.id, spendClass: 'AGENT_INFERENCE', reason: 'Disposable synthetic AI-0 readiness pause' };
  const pause = await settle(admin.query('SELECT hon.command_ai_spend_pause($1,$2::jsonb,$3::uuid) r', [hq.subject, JSON.stringify(pauseIn), K()]));
  assert.equal(pause.value?.rows[0].r.status, 'ACTIVE', JSON.stringify(pause.error?.message));
  assert.deepEqual(Object.values(byKey(await ready(r0))).map((a) => a.blockedBy), Array(8).fill('AI_PAUSED_BY_HQ'));
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
  pass('INV-23', `AI-R1: team readiness reports all three agents and the C2 HON reply available on a ready school, agrees with real requests across ${cases.length} gate changes (${Object.keys(seen).length} checks), names the budget and HQ pause blockers, refuses non-direct or foreign humans, and writes nothing or calls no provider`);
  }

  // ---- INV-23V (AI-R1, Manus final review P2): organization budget totals need independent organization-wide authority ----
  // Two schools in one organization; usage at school B. Readiness is read at school A. Only an HQ reader, or a human with
  // ai.usage.read at every school of the organization, sees committed/ceiling credits; everyone else gets null.
  {
  const v = await makeOrg('inv-23v'), schoolB = K(), staffRole = K();
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'AI-0 synthetic school B',$1::uuid::text,'UTC')", [schoolB, v.id]);
  await admin.query("INSERT INTO hon.ai_usage_ledger(organization_id,school_id,provider_code,model_code,modality,customer_credits,correlation_id) VALUES($1,$2,'OPENROUTER','ai0-used-fixture','TEXT',500,$3)", [v.id, schoolB, K()]);
  // School-only staff: every school permission except the AI usage economics permission, at school A only.
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'AI0_STAFF','AI-0 synthetic staff',false)", [staffRole, v.id]);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions WHERE code <> 'ai.usage.read'", [staffRole, v.id]);
  const human = async (label, hqGrant = null) => {
    const h = { user: K(), principal: K(), subject: `ai0-23v-${label}-${K()}` };
    await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','AI-0 synthetic staff')", [h.user, h.subject]);
    await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'AI-0 synthetic staff')", [h.principal, h.user]);
    await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 day')", [v.id, v.school, h.principal, staffRole, v.principal]);
    if (hqGrant) await admin.query(`INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from,effective_until) VALUES($1,$2,$3,clock_timestamp()-interval '2 days',${hqGrant.until ?? 'NULL'})`, [h.principal, hqGrant.role, hqGrant.perms ?? []]);
    return h;
  };
  const budgetOf = async (h) => (await tenant(context(v, { principalId: h.principal, externalSubject: h.subject }), (client) => client.query('SELECT hon.read_ai_team_readiness($1) r', [h.subject]))).rows[0].r.agentBudget;
  const committedNow = async () => Number((await row('SELECT hon.ai_org_committed_credits($1, clock_timestamp()) n', [v.id])).n);
  const owner = { principal: v.principal, subject: v.subject };
  const outcomes = [];
  const expectHidden = async (h, label) => { assert.equal(await budgetOf(h), null, `${label}: organization totals must be hidden`); outcomes.push(`${label}: hidden`); };
  const expectShown = async (h, label) => {
    assert.deepEqual(await budgetOf(h), { committedCredits: await committedNow(), ceilingCredits: 12000 }, `${label}: organization totals shown`);
    outcomes.push(`${label}: shown`);
  };
  await expectHidden(await human('staff'), 'school-only staff');
  await expectHidden(owner, 'owner of school A only');
  await expectHidden(await human('hq-operator-no-billing', { role: 'HON_HQ_OPERATOR', perms: ['hq.dashboard.view'] }), 'HQ operator without billing authority');
  await expectHidden(await human('hq-expired', { role: 'HON_HQ_OWNER', until: "clock_timestamp()-interval '1 minute'" }), 'expired HQ owner');
  await expectShown(await human('hq-owner', { role: 'HON_HQ_OWNER' }), 'HQ owner');
  await expectShown(await human('hq-billing', { role: 'HON_HQ_OPERATOR', perms: ['hq.billing.manage'] }), 'HQ billing operator');
  assert.ok((await committedNow()) >= 500, 'the totals include school B usage');
  // Owner at both schools: organization-wide authority from existing grants.
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')", [v.id, schoolB, v.principal, v.role]);
  await expectShown(owner, 'owner of both schools');
  // A school that is not ACTIVE fails closed for school-derived authority; HQ still sees the totals.
  await admin.query("UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1", [schoolB]);
  await expectHidden(owner, 'owner of both schools, school B suspended');
  await admin.query("UPDATE hon.schools SET status='ACTIVE' WHERE id=$1", [schoolB]);
  await expectShown(owner, 'owner of both schools, school B active again');
  // (Manus delta review P2) Live entitlement: suspended, expired or missing entitlement and an access state without
  // access hide the totals from school-derived authority (owner of both schools, and staff granted ai.usage.read at
  // both schools); HQ billing readers are unchanged; restoring the entitlement shows them again.
  const hqOwner = await human('hq-owner-ent', { role: 'HON_HQ_OWNER' }), hqBilling = await human('hq-billing-ent', { role: 'HON_HQ_OPERATOR', perms: ['hq.billing.manage'] });
  const usageStaff = await human('usage-staff');
  const usageRole = K();
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'AI0_USAGE','AI-0 synthetic usage reader',false)", [usageRole, v.id]);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'ai.usage.read')", [usageRole, v.id]);
  for (const sch of [v.school, schoolB])
    await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 day')", [v.id, sch, usageStaff.principal, usageRole, v.principal]);
  await expectShown(usageStaff, 'staff with ai.usage.read at every school');
  const schoolDerived = [[owner, 'owner of both schools'], [usageStaff, 'staff with ai.usage.read at every school']];
  const lapses = [
    ['entitlement SUSPENDED', "UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1"],
    ['entitlement expired', "UPDATE hon.organization_entitlements SET effective_until=clock_timestamp()-interval '1 minute' WHERE organization_id=$1"],
    ['entitlement not yet effective', "UPDATE hon.organization_entitlements SET effective_from=clock_timestamp()+interval '1 day' WHERE organization_id=$1"],
    ['access state awaiting first payment', "INSERT INTO hon.saas_access_states(organization_id,state,reason,version,changed_by_principal_id,created_at,updated_at) VALUES($1,'AWAITING_FIRST_PAYMENT','AWAITING_INITIAL_PAYMENT',1,$2,clock_timestamp(),clock_timestamp())"]];
  for (const [label, sql] of lapses) {
    await admin.query(sql, sql.includes('$2') ? [v.id, v.principal] : [v.id]);
    for (const [h, who] of schoolDerived) await expectHidden(h, `${who}, ${label}`);
    await expectShown(hqOwner, `HQ owner, ${label}`);
    await expectShown(hqBilling, `HQ billing operator, ${label}`);
    // Fixture cleanup only (the access-state table refuses deletes by design): the end-of-proof check expects it empty.
    if (sql.includes('saas_access_states')) {
      await admin.query('BEGIN'); await admin.query('ALTER TABLE hon.saas_access_states DISABLE TRIGGER USER');
      await admin.query('DELETE FROM hon.saas_access_states WHERE organization_id=$1', [v.id]);
      await admin.query('ALTER TABLE hon.saas_access_states ENABLE TRIGGER USER'); await admin.query('COMMIT');
    }
    await restoreEntitlement(v);
    for (const [h, who] of schoolDerived) await expectShown(h, `${who}, restored after ${label}`);
  }
  // Revalidation during authorization (two connections, pg_locks-observed): an uncommitted suspension, role-grant
  // revocation, permission removal or HQ grant expiry makes the read wait, and it then fails closed once committed.
  const waitsOn = async (blocker) => {
    const xid = (await blocker.query('SELECT txid_current()::text x')).rows[0].x;
    for (const end = Date.now() + 5000; Date.now() < end; await sleep(20))
      if ((await rows("SELECT 1 FROM pg_locks WHERE locktype='transactionid' AND NOT granted AND transactionid::text=$1", [xid])).length) return true;
    return false;
  };
  const races = [
    ['entitlement suspended', owner, "UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [v.id], () => restoreEntitlement(v)],
    ['school B role grant revoked', usageStaff, "UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE principal_id=$1 AND school_id=$3",
      [usageStaff.principal, v.principal, schoolB], () => admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 minute')", [v.id, schoolB, usageStaff.principal, usageRole, v.principal])],
    ['ai.usage.read removed from the role', usageStaff, "DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='ai.usage.read'", [usageRole],
      () => admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'ai.usage.read')", [usageRole, v.id])],
    ['HQ owner grant expired', hqOwner, "UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp() WHERE principal_id=$1", [hqOwner.principal],
      () => admin.query('UPDATE hon.hq_operator_grants SET effective_until=NULL WHERE principal_id=$1', [hqOwner.principal])]];
  for (const [label, h, sql, args, restore] of races) {
    await expectShown(h, `${label}: before`);
    const blocker = await openTx();
    try {
      await blocker.query(sql, args);
      const read = settle(budgetOf(h));
      assert.equal(await waitsOn(blocker), true, `${label}: the read must wait for the uncommitted change`);
      await blocker.query('COMMIT');
      const r = await read;
      assert.equal(r.value, null, `${label}: after the change commits the totals are hidden: ${JSON.stringify(r.value ?? r.error?.message)}`);
      outcomes.push(`${label} during the read: waits, then hidden`);
    } finally { await blocker.end().catch(() => {}); }
    await restore();
    await expectShown(h, `${label}: restored`);
  }
  // (Manus delta review P2, entitlement time) Activation is judged at transaction start, exactly as the central rule
  // (0130); expiry on the fresh clock. Deterministic: a blocker row-locks (FOR UPDATE) the entitlement row, the read
  // begins its transaction and is seen WAITING on it (pg_locks), the activation or expiry instant passes, then the lock
  // is released. Owner of both schools (school-derived authority) throughout.
  const timeRace = async (label, setSql, waitMs, expectBudget) => {
    await admin.query(setSql, [v.id]);
    const blocker = await openTx();
    try {
      await blocker.query('SELECT 1 FROM hon.organization_entitlements WHERE organization_id=$1 FOR UPDATE', [v.id]);
      const read = settle(budgetOf(owner));
      assert.equal(await waitsOn(blocker), true, `${label}: the read must wait on the entitlement row`);
      await sleep(waitMs);
      await blocker.query('COMMIT');
      const r = await read;
      if (expectBudget) assert.deepEqual(r.value, { committedCredits: await committedNow(), ceilingCredits: 12000 }, `${label}: ${JSON.stringify(r.value ?? r.error?.message)}`);
      else assert.equal(r.value, null, `${label}: ${JSON.stringify(r.value ?? r.error?.message)}`);
      outcomes.push(`${label}: ${expectBudget ? 'shown' : 'hidden'}`);
    } finally { await blocker.end().catch(() => {}); }
  };
  // Case A: the transaction began before activation; activation passes during the wait: still denied.
  await timeRace('activation during the wait (transaction began before effective_from)',
    "UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp()+interval '1500 milliseconds',effective_until=NULL WHERE organization_id=$1", 2500, false);
  // Case B: a read that starts after activation, with every other requirement met: shown.
  await expectShown(owner, 'read started after activation');
  // Case C: active at transaction start, expires during the wait: denied on the fresh clock.
  await timeRace('expiry during the wait (active when the transaction began)',
    "UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=clock_timestamp()+interval '1500 milliseconds' WHERE organization_id=$1", 2500, false);
  await restoreEntitlement(v);
  // Control: no time boundary crossed during the same wait: shown (the wait itself never hides valid access).
  await timeRace('no boundary crossed during the wait', "UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1", 300, true);
  // Case E reconfirmed after the time races: one-school owner and staff stay hidden, full authority still shown.
  await expectHidden(await human('staff-after-time'), 'school-only staff after the time races');
  await expectShown(usageStaff, 'staff with ai.usage.read at every school after the time races');
  // Cross-organization isolation: authority over another organization's schools gives nothing here.
  const foreign = await makeOrg('inv-23v-foreign');
  assert.equal((await settle(tenant(context(v, { principalId: foreign.principal, externalSubject: foreign.subject }), (client) => client.query('SELECT hon.read_ai_team_readiness($1) r', [foreign.subject])))).error?.code, '42501', 'another organization’s owner is refused');
  pass('INV-23V', `AI-R1: school-scoped readiness discloses organization budget totals only with independent organization-wide authority (${outcomes.join('; ')})`);
  }

  // ---- INV-24 (C1): HON conversation hands each turn to the named specialist once, approvals stay in Action Center ----
  {
  const c0 = await makeOrg('inv-24');
  const scope = { organizationId: c0.id, schoolId: c0.school, principalId: c0.principal, externalSubject: c0.subject };
  const hon = new HonConversationService(db, agents.marcus.service, agents.claire.service, agents.chad.service, new AiTeamReadinessService(db, fakes.marcus, fakes.claire, fakes.chad, fakes.hon), honReplies);
  const code = async (p) => { const r = await settle(p); return r.error?.getResponse?.().code ?? r.error?.code ?? 'OK'; };
  const calls = () => fakes.marcus.calls + fakes.claire.calls + fakes.chad.calls;
  const readiness = (await hon.readiness(scope)).data;
  assert.deepEqual([readiness.contract, readiness.authorization, readiness.entitlement, readiness.providerRoute, readiness.availableAgentKeys], [true, true, true, true, ['marcus', 'kai', 'chad']]);
  const k1 = K();
  const conv = await hon.create(scope, { title: 'Spring enrollment push' }, k1);
  assert.deepEqual([conv.status, conv.turnCount], ['READY', 0]);
  assert.equal((await hon.create(scope, { title: 'Spring enrollment push' }, k1)).id, conv.id, 'conversation create is idempotent');
  assert.equal(await code(hon.create(scope, { title: 'Other' }, k1)), 'HON_IDEMPOTENCY_CONFLICT');
  const before = { calls: calls(), ledger: await ledgerRows(c0) };
  const t1 = K();
  const marcusTurn = { text: 'Draft a friendly spring beginner class post. Use placeholders for unprovided facts.', delegation: { agentKey: 'marcus', campaignId: c0.campaign } };
  const r1 = await hon.sendTurn(scope, conv.id, marcusTurn, t1);
  assert.equal(r1.status, 'AWAITING_APPROVAL'); assert.equal(r1.actionRequestIds.length, 1); assert.deepEqual(r1.delegatedAgentKeys, ['marcus']);
  const inv = await row('SELECT * FROM hon.marketing_ai_invocations WHERE id=$1', [r1.invocationId]);
  assert.deepEqual([inv.idempotency_key, inv.requested_by, inv.action_request_id, inv.work_item_id], [r1.turnId, c0.principal, r1.actionRequestIds[0], r1.workItemIds[0]], 'specialist record is found by turn id and requester only');
  assert.equal((await row('SELECT status FROM hon.action_requests WHERE id=$1', [r1.actionRequestIds[0]])).status, 'AWAITING_APPROVAL', 'consequential step is an Action Center CONFIRM proposal');
  assert.equal((await row('SELECT count(*)::int n FROM hon.marketing_campaign_content WHERE organization_id=$1', [c0.id])).n, 0, 'nothing saved before human approval');
  assert.deepEqual(await hon.sendTurn(scope, conv.id, marcusTurn, t1), r1, 'resend returns the same receipt');
  assert.deepEqual([calls() - before.calls, (await ledgerRows(c0)) - before.ledger], [1, 1], 'one provider call and one ledger row despite the resend');
  assert.equal(await code(hon.sendTurn(scope, conv.id, { ...marcusTurn, text: 'Something else' }, t1)), 'HON_IDEMPOTENCY_CONFLICT');
  const r2 = await hon.sendTurn(scope, conv.id, { text: 'Outline a white belt practice.', delegation: { agentKey: 'kai', curriculumId: c0.curriculum } }, K());
  const r3 = await hon.sendTurn(scope, conv.id, { text: 'Check in kindly about a trial class.', delegation: { agentKey: 'chad', leadId: c0.lead, expectedLeadVersion: 1, purpose: 'CHECK_IN' } }, K());
  assert.deepEqual([r2.status, r3.status], ['AWAITING_APPROVAL', 'AWAITING_APPROVAL']);
  assert.equal(await code(hon.sendTurn(scope, conv.id, { text: 'Just chat with me' }, K())), 'INVALID_HON_TURN');
  assert.equal((await settle(tenant(context(c0), (client) => client.query('SELECT hon.begin_hon_turn($1,$2,$3::jsonb,$4)', [c0.subject, conv.id, JSON.stringify({ text: 'hi', delegation: { agentKey: 'hon' } }), K()])))).error?.message, 'HON_DELEGATION_REQUIRED', 'HON is never a delegate: a question uses delegation null (C2, INV-25)');
  // A specialist refusal (entitlement suspended) is recorded before any provider call; the conversation itself stays readable.
  await admin.query("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [c0.id]);
  const n = calls();
  const refused = await hon.sendTurn(scope, conv.id, marcusTurn, K());
  await restoreEntitlement(c0);
  assert.deepEqual([refused.status, refused.reason, refused.invocationId, calls() - n], ['FAILED', 'AGENT_NOT_AUTHORIZED', null, 0]);
  // An unknown provider outcome is reported as UNKNOWN, never success or failure.
  fakes.marcus.mode = 'UNKNOWN';
  const unknown = await hon.sendTurn(scope, conv.id, { ...marcusTurn, text: 'A second spring post.' }, K());
  fakes.marcus.mode = 'RESULT';
  assert.equal(unknown.status, 'UNKNOWN');
  const thread = await hon.read(scope, conv.id);
  assert.deepEqual(thread.turns.map((t) => t.role), ['HUMAN', 'marcus', 'HUMAN', 'kai', 'HUMAN', 'chad', 'HUMAN', 'marcus', 'HUMAN', 'marcus']);
  assert.deepEqual(thread.turns.filter((t) => t.role !== 'HUMAN').map((t) => t.status), ['AWAITING_APPROVAL', 'AWAITING_APPROVAL', 'AWAITING_APPROVAL', 'FAILED', 'UNKNOWN']);
  assert.ok(thread.turns.filter((t) => t.role !== 'HUMAN').every((t) => t.text === null), 'specialist drafts stay behind their own reads');
  assert.equal(thread.status, 'UNKNOWN');
  // Pagination: newest first, keyset cursor.
  const c2 = await hon.create(scope, { title: 'Second' }, K()), c3 = await hon.create(scope, { title: 'Third' }, K());
  const p1 = await hon.list(scope, { limit: '2' });
  assert.deepEqual(p1.items.map((x) => x.id), [c3.id, c2.id]); assert.ok(p1.nextCursor);
  const p2 = await hon.list(scope, { limit: '2', cursor: p1.nextCursor });
  assert.deepEqual([p2.items.map((x) => x.id), p2.nextCursor], [[conv.id], null]);
  // Isolation: another school's owner cannot see or extend it; a foreign subject in this tenant is refused.
  const other = await makeOrg('inv-24-other');
  const otherScope = { organizationId: other.id, schoolId: other.school, principalId: other.principal, externalSubject: other.subject };
  assert.equal(await code(hon.read(otherScope, conv.id)), 'HON_CONVERSATION_NOT_FOUND');
  assert.equal(await code(hon.sendTurn(otherScope, conv.id, marcusTurn, K())), 'HON_CONVERSATION_NOT_FOUND');
  assert.deepEqual((await hon.list(otherScope, {})).items, []);
  assert.equal(await code(hon.read({ ...scope, externalSubject: other.subject }, conv.id)), 'HON_CONVERSATION_FORBIDDEN');
  assert.equal((await settle(tenant(context(c0), async (client) => { await client.query("SELECT set_config('app.hon_source','AI_AGENT',true)"); return client.query('SELECT hon.read_hon_conversation($1,$2)', [c0.subject, conv.id]); }))).error?.code, '42501', 'not the direct human source');
  for (const t of ['hon_conversations', 'hon_conversation_turns']) {
    assert.equal((await row(`SELECT has_table_privilege($1,'hon.${t}','SELECT') s`, [runtimeRole])).s, false, `${t}: functions only`);
  }
  for (const f of ['hon_conversation_actor(text)', 'hon_conversation_hold_actor(text,uuid)', 'hon_turn_view(hon.hon_conversation_turns)', 'hon_conversation_summary(hon.hon_conversations)']) {
    assert.equal((await row(`SELECT has_function_privilege($1,'hon.${f}','EXECUTE') s`, [runtimeRole])).s, false, `${f}: internal helper`);
  }
  pass('INV-24', 'C1: HON conversation turns hand off once to the named specialist (turn id = specialist idempotency key, one provider call and one ledger row per turn despite resends), every draft lands as an Action Center CONFIRM proposal, refusals and unknown outcomes are reported honestly, no HON-authored answer path, requester- and school-scoped, functions-only tables');

  // ---- INV-24R (C1, Manus review P2): requester authority holds through turn creation (two connections) ----
  // Another transaction holds the conversation row (as a concurrent turn would). The turn command, started with valid
  // authority, is seen WAITING in pg_locks; authority changes and commits; on release the command must refuse with no
  // turn row, no specialist record and no provider call. A revocation issued after the command took its hold waits.
  {
  const others = new Set();
  const turnSql = 'SELECT hon.begin_hon_turn($1,$2,$3::jsonb,$4)';
  const turnInput = (o) => JSON.stringify({ text: 'Draft a friendly spring beginner class post.', delegation: { agentKey: 'marcus', campaignId: o.campaign } });
  const turnRows = async (conversationId) => (await row('SELECT count(*)::int n FROM hon.hon_conversation_turns WHERE conversation_id=$1', [conversationId])).n;
  /** Starts begin_hon_turn in the real tenant transaction and resolves once a non-excluded backend waits on `locktypes`. */
  const startTurn = async (o, conversationId) => {
    const exclude = [...others];
    let done = null;
    const result = settle(tenant(context(o), (client) => client.query(turnSql, [o.subject, conversationId, turnInput(o), K()]))).then((r) => { done = r; return r; });
    for (const end = Date.now() + 5000; ; await sleep(20)) {
      const waits = await rows("SELECT pid FROM pg_locks WHERE NOT granted AND locktype IN ('transactionid','tuple') AND NOT (pid = ANY($1::int[]))", [exclude]);
      if (waits.length) return { pid: waits[0].pid, result };
      if (done || Date.now() > end) throw new Error(`expected the turn to wait on the conversation row first; it ${done ? `settled (${done.error ? done.error.code + ' ' + done.error.message : 'succeeded'})` : 'never waited'}`);
    }
  };
  const holdConversation = async (conversationId) => {
    const c = await openTx();
    others.add((await c.query('SELECT pg_backend_pid() p')).rows[0].p);
    await c.query('SELECT 1 FROM hon.hon_conversations WHERE id=$1 FOR UPDATE', [conversationId]);
    return c;
  };
  others.add((await row('SELECT pg_backend_pid() p')).p);
  const outcomes = [];
  const cases = [
    ['role grant revoked', (o) => admin.query('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE principal_id=$1 AND school_id=$2', [o.principal, o.school])],
    ['ai.invocation.plan removed from the role', (o) => admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='ai.invocation.plan'", [o.role])],
    ['principal deactivated', (o) => admin.query('UPDATE hon.principals SET is_active=false WHERE id=$1', [o.principal])],
  ];
  for (const [label, change] of cases) {
    const o = await makeOrg(`inv-24r-${outcomes.length}`);
    const sc = { organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject };
    const conv = await hon.create(sc, { title: 'Race proof' }, K());
    const callsBefore = calls();
    const holder = await holdConversation(conv.id);
    const cmd = await startTurn(o, conv.id);
    await change(o);
    await holder.query('COMMIT'); await holder.end();
    const r = await cmd.result;
    assert.equal(r.error?.code, '42501', `${label} while waiting must refuse the turn: ${JSON.stringify(r.value?.rows[0] ?? r.error?.message)}`);
    assert.deepEqual([await turnRows(conv.id), calls() - callsBefore, (await row('SELECT count(*)::int n FROM hon.marketing_ai_invocations WHERE organization_id=$1', [o.id])).n], [0, 0, 0], `${label}: no turn, provider call or specialist record`);
    outcomes.push(`${label}: refused`);
  }
  // Role grant expired by the clock while waiting.
  {
    const o = await makeOrg('inv-24r-expiry');
    const sc = { organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject };
    const conv = await hon.create(sc, { title: 'Race proof' }, K());
    await admin.query("UPDATE hon.principal_role_grants SET effective_until=clock_timestamp()+interval '4 seconds' WHERE principal_id=$1 AND school_id=$2", [o.principal, o.school]);
    const until = (await row('SELECT max(effective_until) u FROM hon.principal_role_grants WHERE principal_id=$1', [o.principal])).u;
    const holder = await holdConversation(conv.id);
    const cmd = await startTurn(o, conv.id);
    for (const end = Date.now() + 10000; !(await row('SELECT clock_timestamp() > $1::timestamptz r', [until])).r; await sleep(50)) if (Date.now() > end) throw new Error('grant did not expire');
    await holder.query('COMMIT'); await holder.end();
    const r = await cmd.result;
    assert.equal(r.error?.code, '42501', `expired while waiting must refuse the turn: ${JSON.stringify(r.value?.rows[0] ?? r.error?.message)}`);
    assert.equal(await turnRows(conv.id), 0);
    outcomes.push('role grant expired while waiting: refused');
  }
  // After the hold: the turn's transaction is kept open once begin_hon_turn has returned. A revocation then waits for
  // that transaction (pg_locks), the turn commits once, and only then does the revocation apply.
  {
    const o = await makeOrg('inv-24r-ordered');
    const sc = { organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject };
    const conv = await hon.create(sc, { title: 'Race proof' }, K());
    let release, turned = null;
    const gate = new Promise((resolve) => { release = resolve; });
    const result = settle(tenant(context(o), async (client) => { const r = await client.query(turnSql, [o.subject, conv.id, turnInput(o), K()]); turned = r; await gate; return r; }));
    let revoke;
    try {
      for (const end = Date.now() + 5000; !turned; await sleep(20)) if (Date.now() > end) throw new Error('the turn did not complete inside its transaction');
      revoke = await startBlocked('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE principal_id=$1 AND school_id=$2', [o.principal, o.school], 'transactionid', { tx: true });
    } finally { release(); }
    const r = await result;
    assert.equal(r.value?.rows[0]?.begin_hon_turn?.handOff, true, `the turn decided before the revocation: ${JSON.stringify(r.error?.message ?? r.value?.rows[0])}`);
    assert.equal((await revoke.result).error, undefined);
    await revoke.client.query('COMMIT'); await revoke.client.end();
    assert.equal(await turnRows(conv.id), 1, 'recorded once');
    assert.equal((await settle(tenant(context(o), (client) => client.query(turnSql, [o.subject, conv.id, turnInput(o), K()])))).error?.code, '42501', 'refused after the revocation');
    outcomes.push('revocation after the hold: waits, applies after');
  }
  pass('INV-24R', `C1: requester authority holds through turn creation (two-connection, pg_locks-observed waits): ${outcomes.join('; ')}; refusals leave no turn, specialist record or provider call`);
  }

  // ---- INV-24S (C1, Manus final review P2): a turn's specialist record must be the target the turn asked for ----
  // For each specialist: a turn is recorded (not yet handed over); a request sent straight to that specialist with the
  // turn id as its Idempotency-Key and a different target is refused and never shows on the turn; the normal hand-over
  // then completes, a resend replays it, and a concurrent substitution racing two concurrent hand-overs leaves exactly
  // one specialist record (the turn's target), one provider call and one Action Center proposal: the turn's hand-over
  // claim lets only one of the concurrent resends hand over (the other reads the live state).
  {
  const turnSql = 'SELECT hon.begin_hon_turn($1,$2,$3::jsonb,$4) r';
  const receiptOf = async (o, turnId) => (await tenant(context(o), (client) => client.query('SELECT hon.read_hon_turn_receipt($1,$2) r', [o.subject, turnId]))).rows[0].r;
  const byKey = async (name, o, key) => rows(`SELECT id, request_hash, action_request_id FROM hon.${agents[name].table} WHERE organization_id=$1 AND requested_by=$2 AND idempotency_key=$3`, [o.id, o.principal, key]);
  const cases = {
    marcus: (o) => [{ text: 'Draft a friendly spring beginner class post.', delegation: { agentKey: 'marcus', campaignId: o.campaign } },
      { campaignId: o.campaign, request: 'Draft a friendly spring beginner class post.' },
      { campaignId: o.campaign, request: 'Write something completely different for another purpose.' }],
    claire: (o) => [{ text: 'Outline a white belt practice.', delegation: { agentKey: 'kai', curriculumId: o.curriculum } },
      { curriculumId: o.curriculum, brief: 'Outline a white belt practice.' },
      { curriculumId: o.curriculum, brief: 'A different brief that the turn never asked for' }],
    chad: (o) => [{ text: 'Check in kindly about a trial class.', delegation: { agentKey: 'chad', leadId: o.lead, expectedLeadVersion: 1, purpose: 'CHECK_IN' } },
      { leadId: o.lead, expectedLeadVersion: 1, purpose: 'CHECK_IN' },
      { leadId: o.lead, expectedLeadVersion: 1, purpose: 'REENGAGEMENT' }],
  };
  const outcomes = [];
  for (const name of ['marcus', 'claire', 'chad']) {
    const o = await makeOrg(`inv-24s-${name}`);
    const scope = { organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject };
    const hon = new HonConversationService(db, agents.marcus.service, agents.claire.service, agents.chad.service, new AiTeamReadinessService(db, fakes.marcus, fakes.claire, fakes.chad, fakes.hon), honReplies);
    const conv = await hon.create(scope, { title: `Binding ${name}` }, K());
    const [turnInput, exact, substitute] = cases[name](o);
    const calls0 = fakes[name].calls;
    // The turn exists (as after a hand-over that never started); its id is now a specialist idempotency key.
    const key = K();
    const begun = (await tenant(context(o), (client) => client.query(turnSql, [o.subject, conv.id, JSON.stringify(turnInput), key]))).rows[0].r;
    assert.equal(begun.handOff, true);
    const turnId = begun.turnId;
    // That caller holds the hand-over claim: a resend now does not start a second, competing hand-over.
    assert.equal((await tenant(context(o), (client) => client.query(turnSql, [o.subject, conv.id, JSON.stringify(turnInput), key]))).rows[0].r.handOff, false, `${name}: one hand-over at a time`);
    // The claimed hand-over never ran (simulated crash): after five minutes a resend may claim it again.
    const abandon = (id) => admin.query("UPDATE hon.hon_conversation_turns SET handoff_claimed_at=clock_timestamp()-interval '6 minutes' WHERE id=$1", [id]);
    await abandon(turnId);
    // Direct-key substitution: the specialist's own endpoint, the turn id as Idempotency-Key, another target.
    const direct = await settle(agents[name].service.submit(context(o, { idempotencyKey: turnId }), substitute));
    assert.ok(direct.error, `${name}: a substituted target under a turn id must be refused: ${JSON.stringify(direct.value)}`);
    assert.deepEqual([(await byKey(name, o, turnId)).length, fakes[name].calls - calls0], [0, 0], `${name}: no substituted record, no provider call`);
    assert.equal((await receiptOf(o, turnId)).invocationId, null, `${name}: the turn shows no substituted work`);
    // Normal hand-over completes and binds the turn's own target; a resend replays it.
    const r1 = await hon.sendTurn(scope, conv.id, turnInput, key);
    const linked = await byKey(name, o, turnId);
    assert.deepEqual([r1.turnId, r1.status, linked.length, linked[0]?.id, r1.invocationId], [turnId, 'AWAITING_APPROVAL', 1, r1.invocationId, linked[0]?.id], `${name}: ${JSON.stringify(r1)}`);
    assert.equal(linked[0].request_hash, (await row('SELECT delegation_fingerprint f FROM hon.hon_conversation_turns WHERE id=$1', [turnId])).f, `${name}: specialist fingerprint is the turn's`);
    assert.deepEqual(await hon.sendTurn(scope, conv.id, turnInput, key), r1, `${name}: resend replays`);
    // The same target straight to the specialist under the turn id is the same request: it replays, never a second record.
    assert.equal((await agents[name].service.submit(context(o, { idempotencyKey: turnId }), exact)).id, r1.invocationId, `${name}: exact target replays`);
    assert.equal((await settle(agents[name].service.submit(context(o, { idempotencyKey: turnId }), substitute))).error != null, true, `${name}: substitution after the hand-over is still refused`);
    assert.equal(fakes[name].calls - calls0, 1, `${name}: one provider call`);
    // Concurrent: two hand-overs of a new turn and a substitution under its id, all at once.
    const key2 = K();
    const begun2 = (await tenant(context(o), (client) => client.query(turnSql, [o.subject, conv.id, JSON.stringify(turnInput), key2]))).rows[0].r;
    await abandon(begun2.turnId);
    const calls1 = fakes[name].calls;
    const [a, b, sub] = await Promise.all([settle(hon.sendTurn(scope, conv.id, turnInput, key2)), settle(hon.sendTurn(scope, conv.id, turnInput, key2)),
      settle(agents[name].service.submit(context(o, { idempotencyKey: begun2.turnId }), substitute))]);
    const rec2 = await byKey(name, o, begun2.turnId);
    assert.ok(sub.error, `${name}: concurrent substitution refused`);
    assert.equal(rec2.length, 1, `${name}: exactly one specialist record for the turn`);
    assert.equal(fakes[name].calls - calls1, 1, `${name}: one provider call under concurrency`);
    const final = await receiptOf(o, begun2.turnId);
    assert.deepEqual([final.invocationId, final.status, final.actionRequestIds.length], [rec2[0].id, 'AWAITING_APPROVAL', 1], `${name}: ${JSON.stringify(final)}`);
    for (const r of [a, b]) if (r.value) assert.equal(r.value.turnId, begun2.turnId);
    outcomes.push(`${name}: substitution refused before and after the hand-over and under concurrency (${[a, b].filter((r) => r.value).length}/2 concurrent hand-overs returned the receipt)`);
  }
  pass('INV-24S', `C1: each turn is bound to its specialist target and fingerprint: ${outcomes.join('; ')}; normal hand-over, resend and exact-target replay keep one record, one provider call and one Action Center proposal`);
  }

  // ---- INV-24W (C1, Manus delta review P2): Marcus hand-overs use one canonical request text and fingerprint ----
  // Whitespace that Marcus's own request contract trims (JavaScript trim) must not refuse a valid hand-over: the turn's
  // target and fingerprint are computed from the same canonical text Marcus records. Equivalent texts share one
  // fingerprint, different texts stay distinct, direct-key substitution stays refused, concurrent resends make one call.
  {
  const turnSql = 'SELECT hon.begin_hon_turn($1,$2,$3::jsonb,$4) r';
  const o = await makeOrg('inv-24w');
  const scope = { organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject };
  const hon = new HonConversationService(db, agents.marcus.service, agents.claire.service, agents.chad.service, new AiTeamReadinessService(db, fakes.marcus, fakes.claire, fakes.chad, fakes.hon), honReplies);
  const conv = await hon.create(scope, { title: 'Whitespace' }, K());
  const plain = 'Draft a friendly spring beginner class post.';
  const turn = (text) => ({ text, delegation: { agentKey: 'marcus', campaignId: o.campaign } });
  const fingerprintOf = async (turnId) => (await row('SELECT delegation_fingerprint f, delegation d FROM hon.hon_conversation_turns WHERE id=$1', [turnId]));
  const recordOf = async (turnId) => rows('SELECT id, request_hash, request_text FROM hon.marketing_ai_invocations WHERE organization_id=$1 AND idempotency_key=$2', [o.id, turnId]);
  fakes.marcus.mode = 'RESULT';
  const variants = [plain, `  ${plain}  `, `\n\t${plain}\r\n`, `\u00a0\u3000${plain}\u2028`, `\ufeff\u2003${plain}\u205f\u202f`, `\u2029\u1680${plain}\u2009 `];
  const fps = new Set(), seenV = [];
  for (const text of variants) {
    assert.equal(text.trim(), plain, 'the variant is equivalent under Marcus\'s own trim');
    const calls = fakes.marcus.calls;
    const r = await settle(hon.sendTurn(scope, conv.id, turn(text), K()));
    assert.equal(r.value?.status, 'AWAITING_APPROVAL', `variant ${JSON.stringify(text)}: valid hand-over must complete: ${JSON.stringify(r.value ?? r.error?.message)}`);
    const t = await fingerprintOf(r.value.turnId), rec = await recordOf(r.value.turnId);
    assert.deepEqual([rec.length, rec[0]?.request_hash, rec[0]?.request_text, t.d.request], [1, t.f, plain, plain], `variant ${JSON.stringify(text)}: one Marcus record bound to the turn's canonical target`);
    assert.equal(fakes.marcus.calls - calls, 1);
    // Direct-key substitution under this turn id stays refused; the same canonical request replays.
    assert.ok((await settle(agents.marcus.service.submit(context(o, { idempotencyKey: r.value.turnId }), { campaignId: o.campaign, request: 'Write something completely different.' }))).error, 'substitution refused');
    assert.equal((await agents.marcus.service.submit(context(o, { idempotencyKey: r.value.turnId }), { campaignId: o.campaign, request: text })).id, rec[0].id, 'the equivalent request replays');
    assert.equal(fakes.marcus.calls - calls, 1, 'no second provider call');
    fps.add(t.f); seenV.push(JSON.stringify(text));
  }
  assert.equal(fps.size, 1, 'canonically equivalent requests produce one fingerprint');
  // Different semantic targets stay distinct (inner whitespace is content; another campaign is another target).
  const inner = await hon.sendTurn(scope, conv.id, turn(plain.replace('spring ', 'spring  ')), K());
  assert.notEqual((await fingerprintOf(inner.turnId)).f, [...fps][0], 'inner whitespace is not normalized away');
  const start = new Date(Date.now() + 3_600_000).toISOString(), end = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const c2 = (await campaigns.save(context(o), null, { expectedVersion: 0, code: 'AI0B', name: 'AI-0 synthetic campaign B', goal: 'Introduce beginner classes', offerLabel: '', channel: 'REFERRAL', startsAt: start, endsAt: end, plannedBudgetMinor: 0, currency: 'USD' })).campaign.id;
  const t2 = await hon.sendTurn(scope, conv.id, { text: plain, delegation: { agentKey: 'marcus', campaignId: c2 } }, K());
  assert.notEqual((await fingerprintOf(t2.turnId)).f, [...fps][0], 'another campaign is another fingerprint');
  // Concurrent resends of one whitespace-variant turn: one Marcus record, one provider call.
  const key = K(), calls = fakes.marcus.calls;
  const [a, b] = await Promise.all([settle(hon.sendTurn(scope, conv.id, turn(`  ${plain}\n`), key)), settle(hon.sendTurn(scope, conv.id, turn(`  ${plain}\n`), key))]);
  const turnId = (a.value ?? b.value).turnId;
  assert.deepEqual([(await recordOf(turnId)).length, fakes.marcus.calls - calls], [1, 1], `concurrent resends: ${JSON.stringify([a.value ?? a.error?.message, b.value ?? b.error?.message])}`);
  // The canonical function equals JavaScript trim for every whitespace-like code point, including ones trim keeps.
  const points = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x180e, ...Array.from({ length: 11 }, (_, k) => 0x2000 + k), 0x200b, 0x200c, 0x200d,
    0x2028, 0x2029, 0x202f, 0x205f, 0x2060, 0x3000, 0xfeff, 0x41];
  for (const cp of points) {
    const ch = String.fromCodePoint(cp), sample = `${ch}${ch}a${ch}b${ch}`;
    assert.equal((await row('SELECT hon.hon_canonical_request_text($1) t', [sample])).t, sample.trim(), `U+${cp.toString(16).padStart(4, '0')}: same as JavaScript trim`);
  }
  // A text that is only whitespace under trim is refused before any turn is recorded.
  assert.equal((await settle(tenant(context(o), (client) => client.query(turnSql, [o.subject, conv.id, JSON.stringify(turn('\u00a0\u3000\u2028')), K()])))).error?.code, '22023');
  pass('INV-24W', `C1: Marcus hand-overs use one canonical request (JavaScript trim, ${points.length} code points checked): ${variants.length} whitespace variants hand over to one Marcus record each with the turn's fingerprint (one fingerprint for all), substitution refused and the equivalent request replays, inner whitespace and another campaign stay distinct, concurrent resends make one call, whitespace-only text refused`);
  }
  }

  // ---- INV-25 (C2 "Ask HON"): a provider-backed reply through the secure runtime, with authorized school context ----
  {
  const o = await makeOrg('inv-25');
  const scope = { organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject };
  const hon = new HonConversationService(db, agents.marcus.service, agents.claire.service, agents.chad.service, new AiTeamReadinessService(db, fakes.marcus, fakes.claire, fakes.chad, fakes.hon), honReplies);
  const code = async (p) => { const r = await settle(p); return r.error?.getResponse?.().code ?? r.error?.code ?? 'OK'; };
  const reply = async (turnId) => row('SELECT i.*, p.agent_key, p.task_class, p.input_budget, p.output_budget, p.max_provider_cost_microunits, p.customer_credit_estimate, w.work_type FROM hon.hon_reply_invocations i LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id JOIN hon.work_items w ON w.id=i.work_item_id WHERE i.turn_id=$1', [turnId]);
  const turnsOf = async (conversationId) => (await row('SELECT count(*)::int n FROM hon.hon_conversation_turns WHERE conversation_id=$1', [conversationId])).n;
  const ask = (conv, text, key = K()) => hon.sendTurn(scope, conv.id, { text, delegation: null }, key);
  fakes.hon.mode = 'RESULT'; fakes.hon.ready = 'READY';
  const readiness = (await hon.readiness(scope)).data;
  assert.equal(readiness.honReply, true, JSON.stringify(readiness));
  assert.deepEqual(readiness.availableAgentKeys, ['marcus', 'kai', 'chad'], 'HON is not offered as a delegate');
  const conv = await hon.create(scope, { title: 'Ask HON' }, K());

  // 1. A genuine reply from the (injected) provider, recorded once, persisted and readable after reload.
  const before = { calls: fakes.hon.calls, ledger: await ledgerRows(o) };
  const k1 = K();
  const r1 = await ask(conv, 'What should I focus on this week?', k1);
  assert.deepEqual([r1.status, r1.reply, r1.delegatedAgentKeys, r1.actionRequestIds], ['COMPLETED', fakes.hon.reply, [], []], JSON.stringify(r1));
  const i1 = await reply(r1.turnId);
  // STANDARD (default): SUMMARIZE route, 8000/1500 tokens, the owner's $0.08 ceiling; 10 credits reserved, settled to 1.
  assert.deepEqual([i1.status, i1.reserved_credits, i1.agent_key, i1.task_class, i1.work_type, i1.input_budget, i1.output_budget, Number(i1.max_provider_cost_microunits), i1.customer_credit_estimate, i1.reply_mode, i1.step, i1.truncated],
    ['COMPLETED', 0, 'hon', 'SUMMARIZE', 'AI_SUMMARIZE', 8000, 1500, 80000, 10, 'STANDARD', 1, false]);
  assert.deepEqual(r1.replyDetail, { mode: 'STANDARD', step: 1, maxSteps: 3, truncated: false, canContinue: false, continuesTurnId: null, suggestions: [], followUps: [], sources: [] });
  assert.match(i1.context_digest, /^[a-f0-9]{64}$/);
  const l1 = await row('SELECT customer_credits::int c, provider_cost_microunits::int cost, spend_class, school_id FROM hon.ai_usage_ledger WHERE id=$1 AND source_invocation_id=$2', [i1.usage_id, i1.id]);
  assert.deepEqual([l1.c, l1.cost, l1.spend_class, l1.school_id], [1, 900, 'AGENT_INFERENCE', o.school], 'one AGENT_INFERENCE ledger row at the provider-reported cost; a short answer settles to 1 credit, not the 10 reserved');
  // The provider sees only the question and server-built facts: aggregate metrics and no identity of the requester.
  const sent = fakes.hon.inputs.at(-1);
  assert.equal(sent.question, 'What should I focus on this week?');
  const facts = JSON.parse(sent.facts);
  assert.deepEqual(Object.keys(facts).sort(), ['history', 'school']);
  assert.ok(facts.school.newLeads24h && facts.school.pendingActionApprovals && facts.school.revenue?.availability === 'UNAVAILABLE', JSON.stringify(facts.school));
  assert.deepEqual(facts.history, []);
  for (const secret of [o.subject, o.principal, o.user, 'synthetic-lead@example.test', o.lead]) assert.ok(!sent.facts.includes(secret), `context leaks ${secret}`);
  assert.deepEqual([sent.replyMode, sent.step, sent.inputBudget, sent.outputBudget, sent.maxCostMicrounits], ['STANDARD', 1, 8000, 1500, 80000]);
  // Resend: same receipt, no second plan, call or ledger row; different text with the same key is refused.
  assert.deepEqual(await ask(conv, 'What should I focus on this week?', k1), r1);
  assert.deepEqual([fakes.hon.calls - before.calls, (await ledgerRows(o)) - before.ledger], [1, 1]);
  assert.equal(await code(ask(conv, 'Something else', k1)), 'HON_IDEMPOTENCY_CONFLICT');
  // A second question carries this conversation's earlier turn (trimmed) as history; specialists are named, not quoted.
  await hon.sendTurn(scope, conv.id, { text: 'Check in kindly about a trial class.', delegation: { agentKey: 'chad', leadId: o.lead, expectedLeadVersion: 1, purpose: 'CHECK_IN' } }, K());
  const r2 = await ask(conv, 'And what about next week?');
  assert.equal(r2.status, 'COMPLETED');
  assert.deepEqual(JSON.parse(fakes.hon.inputs.at(-1).facts).history, [
    { question: 'What should I focus on this week?', answer: fakes.hon.reply },
    { question: 'Check in kindly about a trial class.', delegatedTo: 'chad' }]);
  const thread = await hon.read(scope, conv.id);
  assert.deepEqual(thread.turns.map((t) => [t.role, t.status]), [['HUMAN', 'COMPLETED'], ['hon', 'COMPLETED'], ['HUMAN', 'AWAITING_APPROVAL'], ['chad', 'AWAITING_APPROVAL'], ['HUMAN', 'COMPLETED'], ['hon', 'COMPLETED']]);
  assert.deepEqual(thread.turns.filter((t) => t.role !== 'HUMAN').map((t) => t.text), [fakes.hon.reply, null, fakes.hon.reply], 'HON text after reload; specialist drafts stay behind Action Center');

  // 2. Without reporting.view HON is told the facts are NOT_AUTHORIZED (never another source); restored afterwards.
  await admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='reporting.view'", [o.role]);
  const noReporting = await ask(conv, 'How many leads came in?');
  assert.deepEqual([noReporting.status, noReporting.reply, noReporting.reason], ['COMPLETED', fakes.hon.reply, null], 'an answer that used no reporting facts needs no reporting.view');
  const downgraded = JSON.parse(fakes.hon.inputs.at(-1).facts);
  assert.deepEqual(downgraded.school, { availability: 'NOT_AUTHORIZED' });
  // Reporting-derived earlier answers are not reused as history without reporting.view (the questions remain).
  assert.ok(downgraded.history.length > 0 && downgraded.history.every((h) => !('answer' in h)), JSON.stringify(downgraded.history));
  assert.deepEqual([(await reply(r1.turnId)).used_reporting, (await reply(noReporting.turnId)).used_reporting], [true, false]);
  // Completed reporting-derived answers are concealed (evidence kept) while reporting.view is missing.
  const hidden = await hon.receipt(scope, r1.turnId);
  assert.deepEqual([hidden.status, hidden.reason, hidden.reply], ['COMPLETED', 'RESULT_CONCEALED', null]);
  const hiddenThread = (await hon.read(scope, conv.id)).turns.filter((t) => t.role === 'hon');
  assert.deepEqual(hiddenThread.map((t) => [t.text === null, t.reason]), [[true, 'RESULT_CONCEALED'], [true, 'RESULT_CONCEALED'], [false, null]]);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'reporting.view')", [o.role, o.id]);
  assert.deepEqual([(await hon.receipt(scope, r1.turnId)).reply, (await hon.receipt(scope, r1.turnId)).reason], [fakes.hon.reply, null], 'shown again once reporting.view returns');

  // 3. Safe failures: runtime not configured, provider rejection, over-budget result, unknown outcome.
  const quiet = async (label, mode, ready, expect) => {
    fakes.hon.mode = mode; fakes.hon.ready = ready;
    const n = { calls: fakes.hon.calls, ledger: await ledgerRows(o) };
    const r = await ask(conv, `Safe failure probe ${label}`);
    fakes.hon.mode = 'RESULT'; fakes.hon.ready = 'READY';
    const i = await reply(r.turnId);
    assert.deepEqual([r.status, r.reason, r.reply, i.status, i.reserved_credits], expect.slice(0, 5), `${label}: ${JSON.stringify(r)}`);
    assert.deepEqual([fakes.hon.calls - n.calls, (await ledgerRows(o)) - n.ledger], expect.slice(5), `${label}: calls/ledger`);
    return i;
  };
  await quiet('config', 'RESULT', 'CONFIGURATION_REQUIRED', ['FAILED', 'CONFIGURATION_REQUIRED', null, 'CONFIGURATION_REQUIRED', 0, 0, 0]);
  await quiet('rejected', 'FAILED', 'READY', ['FAILED', 'PROVIDER_REJECTED', null, 'FAILED', 0, 1, 0]);
  await quiet('over', 'OVER', 'READY', ['FAILED', 'RESULT_BUDGET_EXCEEDED', null, 'FAILED', 0, 1, 1]);
  const lost = await quiet('unknown', 'UNKNOWN', 'READY', ['UNKNOWN', 'PROVIDER_UNKNOWN', null, 'UNKNOWN', 10, 1, 0]);
  // The UNKNOWN hold counts against the organization and is in the HQ queue as HON_REPLY; an HQ owner resolves it.
  const held = await row('SELECT hon.ai_org_committed_credits($1,clock_timestamp())::int n', [o.id]);
  assert.ok(held.n >= 10, 'the UNKNOWN hold counts');
  const open = (await row('SELECT hon.read_ai_unknown_invocations_from_hq($1) r', [hq.subject])).r.open.find((x) => x.invocationId === lost.id);
  assert.deepEqual([open?.agent, open?.reservedCredits, open?.schoolId], ['HON_REPLY', 10, o.school]);
  const resolved = await settle(admin.query('SELECT hon.resolve_ai_unknown_invocation($1,$2,$3::uuid,$4::jsonb,$5::uuid,$6::uuid,$7::uuid) r',
    [hq.subject, 'HON_REPLY', lost.id, JSON.stringify({ decision: 'NO_PROVIDER_CHARGE', reason: 'Synthetic AI-0 C2 provider lookup found no charge', evidence: { providerLookupReference: 'ai0-c2-lookup' } }), K(), K(), K()]));
  assert.equal(resolved.value?.rows[0].r.releasedCredits, 10, JSON.stringify(resolved.error?.message));
  assert.equal((await reply((await row('SELECT turn_id FROM hon.hon_reply_invocations WHERE id=$1', [lost.id])).turn_id)).reserved_credits, 0);
  assert.equal((await row('SELECT hon.ai_org_committed_credits($1,clock_timestamp())::int n', [o.id])).n, held.n - 10);

  // 4. A reply recorded after access lapsed mid-flight is held (usage kept), then shown on resend once access returns.
  fakes.hon.mode = 'HOLD';
  const k4 = K();
  const pending = settle(ask(conv, 'Summarize this week for me.', k4));
  for (const end = Date.now() + 15000; !(await row("SELECT count(*)::int n FROM hon.hon_reply_invocations WHERE organization_id=$1 AND status='SENDING'", [o.id])).n; await sleep(20)) assert.ok(Date.now() < end, 'reply never reached SENDING');
  await admin.query("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [o.id]);
  fakes.hon.complete(); fakes.hon.mode = 'RESULT';
  const heldReceipt = (await pending).value;
  assert.deepEqual([heldReceipt?.status, heldReceipt?.reason, heldReceipt?.reply], ['PROCESSING', 'RESULT_HELD', null], JSON.stringify(heldReceipt ?? (await pending).error));
  const heldRow = await reply(heldReceipt.turnId);
  assert.ok(heldRow.usage_id, 'usage evidence recorded despite the lapse');
  assert.equal((await hon.read(scope, conv.id)).turns.at(-1).text, null, 'a held reply is never shown');
  assert.equal(await code(ask(conv, 'A new question while suspended')), 'HON_CONVERSATION_FORBIDDEN', 'no new question without the AI planning gate');
  await restoreEntitlement(o);
  const n4 = fakes.hon.calls;
  const shown = await ask(conv, 'Summarize this week for me.', k4);
  assert.deepEqual([shown.status, shown.reply, fakes.hon.calls - n4], ['COMPLETED', fakes.hon.reply, 0], 'released on resend without another provider call');

  // 4b. DETAILED is the human's explicit choice: ANALYZE route, 11000/4000 tokens, the same $0.08 ceiling, 15 reserved.
  // An answer cut off at its limit is COMPLETED but marked truncated (never shown as complete) and may be continued by
  // the human, at most 3 steps in total; each step is its own plan, reservation, call and ledger row, settled to use.
  fakes.hon.mode = 'TRUNCATED';
  const n4b = { calls: fakes.hon.calls, ledger: await ledgerRows(o) };
  const d1 = await hon.sendTurn(scope, conv.id, { text: 'Give me a detailed enrollment growth analysis.', delegation: null, replyMode: 'DETAILED' }, K());
  const di1 = await reply(d1.turnId);
  assert.deepEqual([d1.status, di1.task_class, di1.work_type, di1.input_budget, di1.output_budget, Number(di1.max_provider_cost_microunits), di1.customer_credit_estimate, di1.reserved_credits],
    ['COMPLETED', 'ANALYZE', 'AI_ANALYZE', 11000, 4000, 80000, 15, 0], JSON.stringify(d1));
  assert.deepEqual(d1.replyDetail, { mode: 'DETAILED', step: 1, maxSteps: 3, truncated: true, canContinue: true, continuesTurnId: null, suggestions: [], followUps: [], sources: [] });
  assert.equal((await row('SELECT customer_credits::int c FROM hon.ai_usage_ledger WHERE id=$1', [di1.usage_id])).c, 5, 'settled to ceil((300+4000)/1000), not the 15 reserved');
  assert.deepEqual([fakes.hon.inputs.at(-1).replyMode, fakes.hon.inputs.at(-1).outputBudget], ['DETAILED', 4000]);
  // Mode and continuation belong to questions only; a continuation keeps its answer's mode; a full answer is not continued.
  assert.equal(await code(hon.sendTurn(scope, conv.id, { text: 'Continue', delegation: null, continueTurnId: d1.turnId, replyMode: 'STANDARD' }, K())), 'HON_REPLY_NOT_CONTINUABLE');
  assert.equal(await code(hon.sendTurn(scope, conv.id, { text: 'Continue', delegation: null, continueTurnId: r1.turnId }, K())), 'HON_REPLY_NOT_CONTINUABLE', 'a complete answer cannot be continued');
  assert.equal(await code(hon.sendTurn(scope, conv.id, { text: 'Draft it', delegation: { agentKey: 'chad', leadId: o.lead, expectedLeadVersion: 1, purpose: 'CHECK_IN' }, replyMode: 'DETAILED' }, K())), 'INVALID_HON_TURN');
  assert.equal((await settle(tenant(context(o), (c) => c.query('SELECT hon.begin_hon_turn($1,$2,$3::jsonb,$4)', [o.subject, conv.id, JSON.stringify({ text: 'x', delegation: { agentKey: 'chad', leadId: o.lead, expectedLeadVersion: 1, purpose: 'CHECK_IN' }, replyMode: 'DETAILED' }), K()])))).error?.code, '22023', 'the database refuses a reply mode on a delegation too');
  const d2 = await hon.sendTurn(scope, conv.id, { text: 'Continue', delegation: null, continueTurnId: d1.turnId }, K());
  assert.deepEqual(d2.replyDetail, { mode: 'DETAILED', step: 2, maxSteps: 3, truncated: true, canContinue: true, continuesTurnId: d1.turnId, suggestions: [], followUps: [], sources: [] });
  const cont = JSON.parse(fakes.hon.inputs.at(-1).facts).continuation;
  assert.deepEqual([cont.step, cont.maxSteps, cont.originalQuestion, cont.previousAnswerEnd, fakes.hon.inputs.at(-1).step], [2, 3, 'Give me a detailed enrollment growth analysis.', d1.reply.slice(-2500), 2]);
  assert.equal((await hon.receipt(scope, d1.turnId)).replyDetail.canContinue, false, 'an answer is continued once');
  assert.equal(await code(hon.sendTurn(scope, conv.id, { text: 'Continue again', delegation: null, continueTurnId: d1.turnId }, K())), 'HON_REPLY_NOT_CONTINUABLE');
  const d3 = await hon.sendTurn(scope, conv.id, { text: 'Continue', delegation: null, continueTurnId: d2.turnId }, K());
  assert.deepEqual(d3.replyDetail, { mode: 'DETAILED', step: 3, maxSteps: 3, truncated: true, canContinue: false, continuesTurnId: d2.turnId, suggestions: [], followUps: [], sources: [] }, 'still cut off at the last step: shown as incomplete, no further step');
  const n4c = fakes.hon.calls;
  assert.equal(await code(hon.sendTurn(scope, conv.id, { text: 'Continue', delegation: null, continueTurnId: d3.turnId }, K())), 'HON_REPLY_NOT_CONTINUABLE');
  assert.deepEqual([fakes.hon.calls - n4c, fakes.hon.calls - n4b.calls, (await ledgerRows(o)) - n4b.ledger], [0, 3, 3], 'three bounded steps, three calls, three ledger rows');
  const dThread = (await hon.read(scope, conv.id)).turns.filter((t) => t.role === 'hon').slice(-3);
  assert.deepEqual(dThread.map((t) => [t.replyDetail.step, t.replyDetail.truncated, t.replyDetail.canContinue]), [[1, true, false], [2, true, false], [3, true, false]]);
  fakes.hon.mode = 'RESULT';

  // 4c. Source authority is re-checked at release and for continuations (Manus P1-148-1).
  const dropReporting = () => admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='reporting.view'", [o.role]);
  const addReporting = () => admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'reporting.view')", [o.role, o.id]);
  // Mid-flight reporting revocation: the result is recorded (usage kept) and held, then shown once reporting.view returns.
  fakes.hon.mode = 'HOLD';
  const kSrc = K();
  const srcPending = settle(ask(conv, 'Mid-flight source probe', kSrc));
  for (const end = Date.now() + 15000; !(await row("SELECT count(*)::int n FROM hon.hon_reply_invocations WHERE organization_id=$1 AND status='SENDING'", [o.id])).n; await sleep(20)) assert.ok(Date.now() < end, 'reply never reached SENDING');
  await dropReporting();
  fakes.hon.complete(); fakes.hon.mode = 'RESULT';
  const srcHeld = (await srcPending).value;
  const srcRow = await reply(srcHeld.turnId);
  assert.deepEqual([srcHeld.status, srcHeld.reason, srcHeld.reply, srcRow.status, srcRow.reason, Boolean(srcRow.usage_id)], ['PROCESSING', 'RESULT_HELD', null, 'RESULT_HELD', 'SOURCE_ACCESS_LAPSED', true]);
  const nSrc = fakes.hon.calls;
  assert.equal((await ask(conv, 'Mid-flight source probe', kSrc)).reply, null, 'not released without reporting.view');
  await addReporting();
  const srcShown = await ask(conv, 'Mid-flight source probe', kSrc);
  assert.deepEqual([srcShown.status, srcShown.reply, fakes.hon.calls - nSrc], ['COMPLETED', fakes.hon.reply, 0]);
  // A concealed answer cannot be continued; a continuation admitted before revocation is refused at prepare.
  fakes.hon.mode = 'TRUNCATED';
  const e1 = await hon.sendTurn(scope, conv.id, { text: 'Detailed retention review please.', delegation: null, replyMode: 'DETAILED' }, K());
  assert.equal(e1.replyDetail.canContinue, true);
  await dropReporting();
  const nCont = { calls: fakes.hon.calls, ledger: await ledgerRows(o) };
  const e1Hidden = await hon.receipt(scope, e1.turnId);
  assert.deepEqual([e1Hidden.reason, e1Hidden.reply, e1Hidden.replyDetail.truncated, e1Hidden.replyDetail.canContinue], ['RESULT_CONCEALED', null, true, false]);
  assert.equal(await code(hon.sendTurn(scope, conv.id, { text: 'Continue', delegation: null, continueTurnId: e1.turnId }, K())), 'HON_REPLY_NOT_CONTINUABLE');
  await addReporting();
  const kCont = K(), contInput = { text: 'Continue', delegation: null, continueTurnId: e1.turnId };
  const begun = await tenant(context(o), (c) => c.query('SELECT hon.begin_hon_turn($1,$2,$3::jsonb,$4) d', [o.subject, conv.id, JSON.stringify(contInput), kCont]));
  assert.equal(begun.rows[0].d.handOff, true, 'the continuation turn is recorded and pending');
  await dropReporting();
  const refusedCont = await hon.sendTurn(scope, conv.id, contInput, kCont);
  const refusedRow = await reply(refusedCont.turnId);
  assert.deepEqual([refusedCont.status, refusedCont.reason, refusedRow.status, refusedRow.reserved_credits, fakes.hon.calls - nCont.calls, (await ledgerRows(o)) - nCont.ledger],
    ['FAILED', 'SOURCE_ACCESS_REFUSED', 'BLOCKED', 0, 0, 0], JSON.stringify(refusedCont));
  await addReporting();
  fakes.hon.mode = 'RESULT';

  // 4d. Complete ending while prepare waits on the organization budget lock refuses at the live clock (Manus P2-148-2):
  // the transaction began while Complete was active, so the inherited now()-based gate alone would still admit it.
  await admin.query('BEGIN');
  await admin.query('SELECT hon.ai_budget_lock($1)', [o.id]);
  const nExp = { calls: fakes.hon.calls, ledger: await ledgerRows(o) };
  const expPending = settle(ask(conv, 'Expiry during wait probe'));
  for (const end = Date.now() + 15000; !(await row("SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND NOT granted")).n; await sleep(20)) assert.ok(Date.now() < end, 'prepare never waited on the budget lock');
  await sleep(1200);
  await admin.query("UPDATE hon.organization_entitlements SET effective_until=clock_timestamp()-interval '300 milliseconds' WHERE organization_id=$1", [o.id]);
  await admin.query('COMMIT');
  const expired = (await expPending).value;
  const expRow = await reply(expired.turnId);
  assert.deepEqual([expired.status, expired.reason, expRow.status, expRow.reserved_credits, fakes.hon.calls - nExp.calls, (await ledgerRows(o)) - nExp.ledger],
    ['FAILED', 'AI_ACCESS_REFUSED', 'BLOCKED', 0, 0, 0], JSON.stringify(expired ?? (await expPending).error));
  await restoreEntitlement(o);

  // 4e. A later wait on the reply's own work item (Manus residual of P1-148-1 / P2-148-2): the turn is begun and planned,
  // then prepare is called while a blocker holds the work-item row. Prepare locks that row before any decision, so a
  // reporting removal or a Complete expiry during the wait is seen: no protected facts or history leave prepare, and an
  // expired school gets no provider input at all.
  const barrierPrepare = async (label, change) => {
    const kTurn = K();
    const begun = await tenant(context(o), (c) => c.query('SELECT hon.begin_hon_turn($1,$2,$3::jsonb,$4) d', [o.subject, conv.id, JSON.stringify({ text: `Work-item barrier ${label}`, delegation: null }), kTurn]));
    const turnId = begun.rows[0].d.turnId;
    const ref = (await tenant(context(o), (c) => c.query('SELECT hon.hon_reply_planning_reference($1,$2::uuid) d', [o.subject, turnId]))).rows[0].d;
    const lim = ref.limits;
    const planned = await plans.plan({ ...context(o), idempotencyKey: ref.invocationId }, ref.workItemId, { expectedVersion: ref.workVersion, expectedState: 'READY', agentKey: 'hon', modality: 'TEXT', taskClass: lim.taskClass, inputBudget: lim.inputBudget, outputBudget: lim.outputBudget, maxProviderCostMicrounits: lim.maxProviderCostMicrounits });
    assert.equal(planned.status, 'PLANNED', `${label}: planned`);
    const prior = (await rows("SELECT x.agent_key, r.status, r.used_reporting FROM hon.hon_conversation_turns x LEFT JOIN hon.hon_reply_invocations r ON r.turn_id=x.id AND r.status='COMPLETED' WHERE x.conversation_id=$1 AND x.seq<(SELECT seq FROM hon.hon_conversation_turns WHERE id=$2) ORDER BY x.seq DESC LIMIT 3", [conv.id, turnId])).filter((r) => r.agent_key === 'hon' && r.status === 'COMPLETED');
    const blocker = new pg.Client({ connectionString: ownerUrl, ssl: false });
    await blocker.connect();
    let out;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM hon.work_items WHERE id=$1 FOR UPDATE', [ref.workItemId]);
      const bpid = (await blocker.query('SELECT pg_backend_pid() p')).rows[0].p;
      let done = false;
      const pending = settle(tenant(context(o), async (c) => {
        await c.query("SELECT set_config('app.hon_external_subject',$1,true)", [o.subject]);
        return (await c.query('SELECT hon.prepare_hon_reply($1,$2::uuid,$3::uuid,true) d', [o.subject, turnId, planned.plan.id])).rows[0].d;
      })).then((r) => { done = true; return r; });
      for (const end = Date.now() + 5000; !(await row('SELECT count(*)::int n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [bpid])).n; await sleep(20)) {
        assert.ok(!done && Date.now() < end, `${label}: prepare never waited on the work-item row`);
      }
      await change();
      await blocker.query('COMMIT');
      out = await pending;
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      await blocker.end();
    }
    if (out.error) throw out.error;
    return { turnId, prior, input: out.value, row: await reply(turnId) };
  };
  // Reporting removed during the wait: provider input carries no school facts and no reporting-derived answer.
  const nBar = fakes.hon.calls;
  const lostSrc = await barrierPrepare('reporting', dropReporting);
  assert.ok(lostSrc.input, 'a non-reporting reply may still be prepared');
  assert(lostSrc.prior.some((r) => r.used_reporting), 'the recent history held a reporting-derived answer');
  const lostFacts = JSON.parse(lostSrc.input.facts);
  assert.deepEqual(lostFacts.school, { availability: 'NOT_AUTHORIZED' });
  assert.equal((lostFacts.history ?? []).filter((h) => h.answer).length, lostSrc.prior.filter((r) => !r.used_reporting).length, 'only non-reporting earlier answers leave prepare');
  assert.deepEqual([lostSrc.row.status, lostSrc.row.used_reporting], ['SENDING', false]);
  await tenant(context(o), (c) => c.query('SELECT hon.fail_hon_reply($1,$2::uuid,$3,$4)', [o.subject, lostSrc.turnId, 'PRE_SEND', 'CONFIGURATION_REQUIRED']));
  assert.equal((await reply(lostSrc.turnId)).reserved_credits, 0, 'released');
  await addReporting();
  // Complete expires during the wait: nothing is reserved and no provider input is returned.
  const goneEnt = await barrierPrepare('expiry', () => admin.query("UPDATE hon.organization_entitlements SET effective_until=clock_timestamp()-interval '50 milliseconds' WHERE organization_id=$1", [o.id]));
  assert.deepEqual([goneEnt.input, goneEnt.row.status, goneEnt.row.reason, goneEnt.row.reserved_credits, fakes.hon.calls - nBar], [null, 'BLOCKED', 'AI_ACCESS_REFUSED', 0, 0], JSON.stringify(goneEnt));
  await restoreEntitlement(o);

  // 5. Budget, HQ pause and lost permission refuse before any call; a refused question records no turn.
  const b = await makeOrg('inv-25-budget');
  const bScope = { organizationId: b.id, schoolId: b.school, principalId: b.principal, externalSubject: b.subject };
  const bConv = await hon.create(bScope, { title: 'Budget' }, K());
  await setUsed(b, 11995);
  let n = fakes.hon.calls;
  const nearCeiling = await hon.sendTurn(bScope, bConv.id, { text: 'Anything new?', delegation: null }, K());
  assert.deepEqual([nearCeiling.status, fakes.hon.calls - n], ['FAILED', 0], JSON.stringify(nearCeiling));
  assert.match(nearCeiling.reason, /BUDGET|NO_ELIGIBLE_ROUTE/, 'the planner or prepare refuses at the organization ceiling');
  assert.equal((await hon.readiness(bScope)).data.honReply, false);
  const p = await makeOrg('inv-25-pause');
  const pScope = { organizationId: p.id, schoolId: p.school, principalId: p.principal, externalSubject: p.subject };
  const pConv = await hon.create(pScope, { title: 'Pause' }, K());
  const pause = await settle(admin.query('SELECT hon.command_ai_spend_pause($1,$2::jsonb,$3::uuid) r', [hq.subject, JSON.stringify({ action: 'PAUSE', organizationId: p.id, spendClass: 'AGENT_INFERENCE', reason: 'Disposable synthetic AI-0 C2 pause' }), K()]));
  assert.equal(pause.value?.rows[0].r.status, 'ACTIVE', JSON.stringify(pause.error?.message));
  n = fakes.hon.calls;
  const pr = await settle(hon.sendTurn(pScope, pConv.id, { text: 'Anything new?', delegation: null }, K()));
  assert.deepEqual([pr.error?.getResponse?.().code, pr.error?.getResponse?.().reason, fakes.hon.calls - n, await turnsOf(pConv.id)], ['HON_AI_SPEND_REFUSED', 'AI_PAUSED_BY_HQ', 0, 0]);
  assert.equal((await hon.readiness(pScope)).data.honReply, false);
  await admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='ai.invocation.plan'", [o.role]);
  n = fakes.hon.calls;
  assert.equal(await code(hon.sendTurn(scope, conv.id, { text: 'Still there?', delegation: null }, K())), 'HON_CONVERSATION_FORBIDDEN');
  assert.equal(fakes.hon.calls - n, 0);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'ai.invocation.plan')", [o.role, o.id]);

  // 6. Isolation, HQ usage attribution and function-only access.
  const other = await makeOrg('inv-25-other');
  const otherScope = { organizationId: other.id, schoolId: other.school, principalId: other.principal, externalSubject: other.subject };
  assert.equal(await code(hon.read(otherScope, conv.id)), 'HON_CONVERSATION_NOT_FOUND');
  assert.equal(await code(hon.sendTurn(otherScope, conv.id, { text: 'Read theirs', delegation: null }, K())), 'HON_CONVERSATION_NOT_FOUND');
  assert.equal((await settle(tenant(context(other), (client) => client.query('SELECT hon.prepare_hon_reply($1,$2::uuid,NULL,true)', [other.subject, r1.turnId])))).error?.code, 'P0002', 'another school cannot prepare this reply');
  assert.equal((await settle(tenant(context(o), (client) => client.query('SELECT hon.record_hon_reply_result($1,$2::uuid,$3::jsonb)', [o.subject, r1.turnId, JSON.stringify({ reply: 'x', inputTokens: 1, outputTokens: 1, providerCostMicrounits: 0 })])))).error?.code, '40001', 'a recorded reply cannot be recorded again');
  const usage = (await row('SELECT hon.read_ai_school_usage_from_hq($1,$2::timestamptz,$3::timestamptz) r', [hq.subject, new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString()])).r;
  const mine = usage.schools.find((x) => x.schoolId === o.school);
  assert.ok(mine?.byClass.AGENT_INFERENCE.byAgent.HON_REPLY?.credits >= 4, JSON.stringify(mine));
  assert.equal((await row("SELECT has_table_privilege($1,'hon.hon_reply_invocations','SELECT') s", [runtimeRole])).s, false, 'functions only');
  for (const f of ['hon_reply_limits(text)', 'hon_reply_max_steps()', 'hon_reply_detail(uuid,boolean)', 'hon_reply_access(text)', 'hon_reply_complete_live(uuid)', 'hon_reply_source_allowed(hon.hon_reply_invocations)', 'hon_reply_visible(text,uuid)']) assert.equal((await row(`SELECT has_function_privilege($1,'hon.${f}','EXECUTE') s`, [runtimeRole])).s, false, `${f}: internal helper`);
  pass('INV-25', 'C2: Ask HON answers through the planning boundary, S4 budget lock and access decision with one provider call and one ledger row per question (resend replays), using only server-built aggregate school facts (NOT_AUTHORIZED without reporting.view) and trimmed history of the same conversation; persisted after reload; config/rejection/over-budget/unknown are reported honestly; UNKNOWN holds count and resolve in the HQ queue as HON_REPLY; a mid-flight lapse holds the reply until access returns; STANDARD (SUMMARIZE 8000/1500) and DETAILED (ANALYZE 11000/4000) both under the $0.08 ceiling, reserving 10/15 and settling to measured tokens; a cut-off answer is marked truncated and continues only on the human\'s request, at most 3 steps, each its own call and ledger row; budget, HQ pause and lost permission refuse before any call; school-isolated and attributed in HQ usage');
  }
  // ---- INV-26 (K1): Kai is the Teaching & Curriculum assistant; legacy 'claire' teaching records stay as recorded ----
  {
  const o = await makeOrg('inv-26');
  const scope = { organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject };
  const hon = new HonConversationService(db, agents.marcus.service, agents.claire.service, agents.chad.service, new AiTeamReadinessService(db, fakes.marcus, fakes.claire, fakes.chad, fakes.hon), honReplies);
  const conv = await hon.create(scope, { title: 'Kai' }, K());
  const turnRow = (id) => row('SELECT agent_key FROM hon.hon_conversation_turns WHERE id=$1', [id]);
  const planOf = (invocationId) => row('SELECT p.agent_key, p.task_class FROM hon.teaching_ai_invocations i JOIN hon.ai_invocation_plans p ON p.id=i.plan_id WHERE i.id=$1', [invocationId]);
  // 1. A teaching delegation to Kai is recorded and planned as 'kai'; clients see 'kai'.
  const k1 = K();
  const kaiTurn = { text: 'Outline a white belt practice.', delegation: { agentKey: 'kai', curriculumId: o.curriculum } };
  const r1 = await hon.sendTurn(scope, conv.id, kaiTurn, k1);
  assert.deepEqual([r1.status, r1.delegatedAgentKeys], ['AWAITING_APPROVAL', ['kai']], JSON.stringify(r1));
  assert.equal((await turnRow(r1.turnId)).agent_key, 'kai');
  assert.deepEqual(await planOf(r1.invocationId), { agent_key: 'kai', task_class: 'DRAFT_TEACHING' }, 'new teaching plans are Kai\'s');
  assert.deepEqual(await hon.sendTurn(scope, conv.id, kaiTurn, k1), r1, 'resend replays');
  // 2. K2 (0229) retired the K1 alias: a teaching delegation named 'claire' is refused; teaching is 'kai' only.
  assert.equal((await settle(hon.sendTurn(scope, conv.id, { text: 'Outline a yellow belt practice.', delegation: { agentKey: 'claire', curriculumId: o.curriculum } }, K()))).error?.getResponse?.().code, 'INVALID_HON_TURN');
  const k2 = K(), yellow = { text: 'Outline a yellow belt practice.', delegation: { agentKey: 'kai', curriculumId: o.curriculum } };
  const r2 = await hon.sendTurn(scope, conv.id, yellow, k2);
  assert.deepEqual([r2.status, r2.delegatedAgentKeys, (await turnRow(r2.turnId)).agent_key], ['AWAITING_APPROVAL', ['kai'], 'kai']);
  // 3. A turn recorded before K1 under 'claire' keeps its recorded key, still resolves its teaching record and is shown as Kai.
  await admin.query('ALTER TABLE hon.hon_conversation_turns DISABLE TRIGGER USER');
  try { await admin.query("UPDATE hon.hon_conversation_turns SET agent_key='claire' WHERE id=$1", [r2.turnId]); }
  finally { await admin.query('ALTER TABLE hon.hon_conversation_turns ENABLE TRIGGER USER'); }
  assert.equal((await turnRow(r2.turnId)).agent_key, 'claire', 'the recorded key is never rewritten');
  const shown = (await hon.read(scope, conv.id)).turns.filter((t) => t.role !== 'HUMAN');
  assert.deepEqual(shown.map((t) => [t.role, t.status]), [['kai', 'AWAITING_APPROVAL'], ['kai', 'AWAITING_APPROVAL']], JSON.stringify(shown));
  const resent = await hon.sendTurn(scope, conv.id, yellow, k2);
  assert.deepEqual([resent.turnId, resent.delegatedAgentKeys, resent.status], [r2.turnId, ['kai'], 'AWAITING_APPROVAL'], 'a resend of the legacy turn matches it and is shown as Kai');
  // 4. Kai can only be planned for teaching; readiness and the HON delegate list name Kai, never 'claire'.
  const kaiOnly = await row("SELECT convalidated, pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='ai_invocation_plans_kai_teaching_only' AND conrelid='hon.ai_invocation_plans'::regclass");
  assert.equal(kaiOnly?.convalidated, true); assert.match(kaiOnly.d, /agent_key <> 'kai'.*task_class = 'DRAFT_TEACHING'/, 'a Kai plan is teaching only');
  const readiness = (await hon.readiness(scope)).data;
  assert.deepEqual(readiness.availableAgentKeys, ['marcus', 'kai', 'chad']);
  const team = (await new AiTeamReadinessService(db, fakes.marcus, fakes.claire, fakes.chad, fakes.hon).read(scope)).data;
  // K2: 'claire' is now the Business Performance analyst, listed separately from Kai.
  assert.deepEqual(team.agents.map((a) => [a.agentKey, a.agent]), [['marcus', 'MARKETING'], ['kai', 'TEACHING'], ['chad', 'CHAD_FOLLOW_UP'], ['hon', 'HON_REPLY'], ['claire', 'BUSINESS_PERFORMANCE'], ['alex', 'GENERAL_MANAGEMENT'], ['jordan', 'OPERATIONS'], ['lena', 'CREATIVE_COMMERCE']]);
  // 5. Without teaching.assistant.use, Kai is refused before any provider call (teaching-only permission boundary unchanged).
  await admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='teaching.assistant.use'", [o.role]);
  const n = fakes.claire.calls;
  const refused = await hon.sendTurn(scope, conv.id, { text: 'Outline a green belt practice.', delegation: { agentKey: 'kai', curriculumId: o.curriculum } }, K());
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'teaching.assistant.use')", [o.role, o.id]);
  assert.deepEqual([refused.status, refused.reason, fakes.claire.calls - n], ['FAILED', 'AGENT_NOT_AUTHORIZED', 0], JSON.stringify(refused));
  assert.equal((await row("SELECT has_function_privilege($1,'hon.hon_presented_agent(text)','EXECUTE') s", [runtimeRole])).s, false, 'presentation helper is internal');
  // 6. A pre-K1 interruption (Manus P2-150-1): the old service committed a 'claire' plan under the invocation's own key,
  // then stopped before prepare linked it. The K1 retry resumes with that plan exactly once instead of conflicting.
  const legacyBegin = await tenant(context(o), (c) => c.query('SELECT hon.begin_teaching_request($1,$2::jsonb,$3::uuid) d', [o.subject, JSON.stringify({ curriculumId: o.curriculum, brief: 'Synthetic pre-K1 interruption' }), K()]));
  const legacyInv = legacyBegin.rows[0].d;
  assert.equal(legacyInv.status, 'PENDING');
  const legacyRef = (await tenant(context(o), (c) => c.query('SELECT hon.teaching_planning_reference($1,$2::uuid) d', [o.subject, legacyInv.id]))).rows[0].d;
  assert.equal(legacyRef.planId, null);
  // The pre-K1 planner accepted any agent key; 0212 (later) binds each agent to a capability and never plans 'claire'.
  // Simulate the old planner for this one call by temporarily mapping 'claire' to its old teaching permission, then
  // restore the exact 0212 definition (INV-12 checks programs are unchanged).
  const capabilityDef = (await row("SELECT pg_get_functiondef('hon.ai_agent_capability_permission(text)'::regprocedure) d")).d;
  let legacyPlan;
  // K2 also refuses new 'claire' teaching plans (ai_invocation_plans_claire_analysis_only, NOT VALID); lift it for this one
  // simulated pre-K1 plan and restore it exactly as 0229 defines it.
  try {
    await admin.query('ALTER TABLE hon.ai_invocation_plans DROP CONSTRAINT ai_invocation_plans_claire_analysis_only');
    await admin.query(capabilityDef.replace("WHEN 'kai' THEN", "WHEN 'claire' THEN 'teaching.assistant.use' WHEN 'kai' THEN"));
    legacyPlan = await plans.plan({ ...context(o), idempotencyKey: legacyInv.id }, legacyRef.workItemId, { expectedVersion: legacyRef.workVersion, expectedState: 'READY', agentKey: 'claire', modality: 'TEXT', taskClass: 'DRAFT_TEACHING', inputBudget: 4096, outputBudget: 1024, maxProviderCostMicrounits: 100000 });
  } finally {
    await admin.query(capabilityDef);
    await admin.query("ALTER TABLE hon.ai_invocation_plans ADD CONSTRAINT ai_invocation_plans_claire_analysis_only CHECK (agent_key <> 'claire' OR task_class = 'ANALYZE') NOT VALID");
  }
  assert.equal((await row("SELECT hon.ai_agent_capability_permission('claire') c")).c, 'reporting.view', '0229 binding restored');
  assert.equal(legacyPlan.status, 'PLANNED', JSON.stringify(legacyPlan));
  // Why recovery is needed: planning Kai under the same key conflicts with the recorded claire fingerprint.
  const kaiReplan = await settle(plans.plan({ ...context(o), idempotencyKey: legacyInv.id }, legacyRef.workItemId, { expectedVersion: legacyRef.workVersion, expectedState: 'READY', agentKey: 'kai', modality: 'TEXT', taskClass: 'DRAFT_TEACHING', inputBudget: 4096, outputBudget: 1024, maxProviderCostMicrounits: 100000 }));
  assert.ok(kaiReplan.error, 'a Kai plan under the legacy key is refused');
  const nLegacy = { calls: fakes.claire.calls, ledger: await ledgerRows(o) };
  const resumed = await agents.claire.service.generate(context(o), legacyInv.id);
  const linked = await row('SELECT i.plan_id, p.agent_key, (SELECT count(*)::int FROM hon.ai_invocation_plans x WHERE x.work_item_id=i.work_item_id) plans FROM hon.teaching_ai_invocations i JOIN hon.ai_invocation_plans p ON p.id=i.plan_id WHERE i.id=$1', [legacyInv.id]);
  assert.deepEqual([resumed.status, linked.plan_id, linked.agent_key, linked.plans, fakes.claire.calls - nLegacy.calls, (await ledgerRows(o)) - nLegacy.ledger],
    ['AWAITING_APPROVAL', legacyPlan.plan.id, 'claire', 1, 1, 1], JSON.stringify(resumed));
  await agents.claire.service.generate(context(o), legacyInv.id);
  assert.deepEqual([fakes.claire.calls - nLegacy.calls, (await ledgerRows(o)) - nLegacy.ledger], [1, 1], 'a second retry never calls again');
  // 6b. Recovery accepts only this invocation's own completed planning outcome (Manus P2-150-R1). Wrong key, wrong
  // requester, ambiguous and mismatched evidence all stop for reconciliation: no fresh plan, no provider call.
  const pendingRequest = async (brief) => {
    const inv = (await tenant(context(o), (c) => c.query('SELECT hon.begin_teaching_request($1,$2::jsonb,$3::uuid) d', [o.subject, JSON.stringify({ curriculumId: o.curriculum, brief }), K()]))).rows[0].d;
    const ref = (await tenant(context(o), (c) => c.query('SELECT hon.teaching_planning_reference($1,$2::uuid) d', [o.subject, inv.id]))).rows[0].d;
    return { inv, ref };
  };
  const teachingPlan = (ctx, ref, key) => plans.plan({ ...ctx, idempotencyKey: key }, ref.workItemId, { expectedVersion: ref.workVersion, expectedState: 'READY', agentKey: 'kai', modality: 'TEXT', taskClass: 'DRAFT_TEACHING', inputBudget: 4096, outputBudget: 1024, maxProviderCostMicrounits: 100000 });
  const plansFor = async (work) => (await row('SELECT count(*)::int n FROM hon.ai_invocation_plans WHERE work_item_id=$1', [work])).n;
  const refusedRecovery = async (label, inv, work) => {
    const before = { calls: fakes.claire.calls, plans: await plansFor(work), ledger: await ledgerRows(o) };
    const r = await settle(agents.claire.service.generate(context(o), inv.id));
    assert.equal(r.error?.getResponse?.().code, 'TEACHING_ASSISTANT_CONFLICT', `${label}: ${JSON.stringify(r.value ?? String(r.error))}`);
    const st = await row('SELECT status, plan_id, reserved_credits FROM hon.teaching_ai_invocations WHERE id=$1', [inv.id]);
    assert.deepEqual([st.status, st.plan_id, st.reserved_credits, fakes.claire.calls - before.calls, await plansFor(work), (await ledgerRows(o)) - before.ledger], ['PENDING', null, 0, 0, before.plans, 0], label);
  };
  // Wrong key: one matching plan for this work item, planned under another key.
  const wk = await pendingRequest('Synthetic wrong-key evidence');
  await teachingPlan(context(o), wk.ref, K());
  await refusedRecovery('wrong key', wk.inv, wk.ref.workItemId);
  // Ambiguous: two alternate-key plans for the same work item never lead to a third.
  const amb = await pendingRequest('Synthetic ambiguous evidence');
  await teachingPlan(context(o), amb.ref, K());
  await teachingPlan(context(o), amb.ref, K());
  await refusedRecovery('ambiguous', amb.inv, amb.ref.workItemId);
  // Wrong requester: the invocation's own key, but planned by another staff member.
  const other = { user: K(), principal: K(), subject: `ai0-inv-26-other-${K()}` };
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','AI-0 synthetic second staff')", [other.user, other.subject]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'AI-0 synthetic second staff')", [other.principal, other.user]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 day')", [o.id, o.school, other.principal, o.role, o.principal]);
  const wr = await pendingRequest('Synthetic wrong-requester evidence');
  await teachingPlan(context(o, { principalId: other.principal, externalSubject: other.subject }), wr.ref, wr.inv.id);
  await refusedRecovery('wrong requester', wr.inv, wr.ref.workItemId);
  // Mismatched: this invocation's own completed outcome exists, but another plan also exists for the work item.
  const mm = await pendingRequest('Synthetic mismatched evidence');
  await teachingPlan(context(o), mm.ref, mm.inv.id);
  await teachingPlan(context(o), mm.ref, K());
  await refusedRecovery('mismatched', mm.inv, mm.ref.workItemId);
  // Genuinely absent evidence (no record, no plan) still plans fresh as Kai, exactly once.
  const fresh = await pendingRequest('Synthetic absent evidence');
  const nFresh = fakes.claire.calls;
  const freshView = await agents.claire.service.generate(context(o), fresh.inv.id);
  assert.deepEqual([freshView.status, await plansFor(fresh.ref.workItemId), fakes.claire.calls - nFresh, (await row('SELECT p.agent_key FROM hon.teaching_ai_invocations i JOIN hon.ai_invocation_plans p ON p.id=i.plan_id WHERE i.id=$1', [fresh.inv.id])).agent_key], ['AWAITING_APPROVAL', 1, 1, 'kai'], JSON.stringify(freshView));
  pass('INV-26', 'K1: Kai is the Teaching & Curriculum assistant: teaching turns and plans are recorded as kai (resend replays), the K1 claire alias is refused since K2 (0229), legacy claire turns keep their recorded key and are shown as Kai, a pre-K1 committed but unlinked claire plan resumes exactly once with its recorded key, recovery adopts only the invocation own completed planning outcome (wrong key, wrong requester, ambiguous and mismatched evidence stop with no fresh plan or call; absent evidence plans fresh once), a kai plan is teaching only, readiness and the delegate list name Kai, and Kai without teaching.assistant.use is refused before any provider call');
  }
  // ---- INV-27 (0212): per-agent capability binding in the planner; teaching-only staff use Kai and nothing else ----
  {
  const { TEACHING_STAFF_ROLE_PRESET, TEACHING_STAFF_ROLE_EXCLUDED_PREFIXES } = await import('@hon/contracts');
  const o = await makeOrg('inv-27');
  const scope = { organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject };
  const hon = new HonConversationService(db, agents.marcus.service, agents.claire.service, agents.chad.service, new AiTeamReadinessService(db, fakes.marcus, fakes.claire, fakes.chad, fakes.hon), honReplies);
  const work = async (type) => (await row("INSERT INTO hon.work_items(organization_id,school_id,work_type,status,subject_type,subject_id,payload,correlation_id) VALUES($1,$2,$5,'READY','AI0_INV27',$3,'{}',$4) RETURNING id", [o.id, o.school, K(), K(), type])).id;
  const plan = async (agentKey, taskClass = 'ANALYZE', ctx = context(o)) => {
    const r = await settle(plans.plan(ctx, await work(taskClass === 'DRAFT_TEACHING' ? 'AI_DRAFT_TEACHING' : 'AI_ANALYZE'), { expectedVersion: 1, expectedState: 'READY', agentKey, modality: 'TEXT', taskClass, inputBudget: 1000, outputBudget: 200, maxProviderCostMicrounits: 10000 }));
    return r.error ? (r.error.getResponse?.().code ?? r.error.constructor?.name ?? r.error.message) : r.value.status;
  };
  // 1. The owner (every capability) may plan each working agent; profile-only agents are never plannable.
  for (const agentKey of ['hon', 'marcus', 'chad']) assert.equal(await plan(agentKey), 'PLANNED', `${agentKey} plannable by an owner`);
  assert.equal(await plan('kai', 'DRAFT_TEACHING'), 'PLANNED', 'kai plannable for teaching by an owner');
  for (const agentKey of ['maya', 'eian']) assert.equal(await plan(agentKey), 'PERMISSION_DENIED', `${agentKey} has no working backend and is never planned`);
  // 0260: Alex, Jordan and Lena are plannable for analysis only, each with its own capability; never for teaching.
  for (const agentKey of ['alex', 'jordan', 'lena']) {
    assert.equal(await plan(agentKey), 'PLANNED', `${agentKey} plannable for analysis by an owner`);
    assert.notEqual(await plan(agentKey, 'DRAFT_TEACHING'), 'PLANNED', `${agentKey} is never planned for teaching`);
  }
  // K2 (0229): Claire (Business Performance) is plannable for analysis only, with reporting.view; never for teaching.
  assert.equal(await plan('claire'), 'PLANNED', 'claire plannable for analysis by an owner');
  assert.notEqual(await plan('claire', 'DRAFT_TEACHING'), 'PLANNED', 'claire is never planned for teaching');
  // 2. The reviewed teaching-staff preset: every code exists and is staff-assignable, none is excluded.
  const codes = [...TEACHING_STAFF_ROLE_PRESET.permissionCodes];
  const known = await rows('SELECT code, is_staff_assignable FROM hon.permissions WHERE code = ANY($1::text[]) ORDER BY code', [codes]);
  assert.deepEqual(known.map((k) => [k.code, k.is_staff_assignable]), codes.sort().map((c) => [c, true]), JSON.stringify(known));
  assert(codes.every((c) => !TEACHING_STAFF_ROLE_EXCLUDED_PREFIXES.some((x) => c.startsWith(x))));
  // 3. The owner creates the exported preset through the canonical staff-role command and grants it to a separate,
  // registered staff member. The owner keeps every permission; the instructor holds exactly the preset.
  const t = { user: K(), principal: K(), subject: `ai0-inv-27-instructor-${K()}` };
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','AI-0 synthetic instructor')", [t.user, t.subject]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'AI-0 synthetic instructor')", [t.principal, t.user]);
  const staffRoles = new StaffRoleService(db);
  const created = (await staffRoles.create(context(o), { ...TEACHING_STAFF_ROLE_PRESET, permissionCodes: [...TEACHING_STAFF_ROLE_PRESET.permissionCodes] })).record;
  assert.deepEqual([created.code, created.name, [...created.permissionCodes].sort()], ['CUSTOM_TEACHING_STAFF', 'Teaching staff', [...codes].sort()], JSON.stringify(created));
  const grantInstructor = async () => (await staffRoles.grant(context(o), { roleId: created.id, targetPrincipalId: t.principal, targetExternalSubject: t.subject })).record;
  let grant = await grantInstructor();
  assert.deepEqual((await rows('SELECT role_id FROM hon.principal_role_grants WHERE principal_id=$1 AND revoked_at IS NULL', [t.principal])).map((r) => r.role_id), [created.id], 'the instructor holds only the preset role');
  const tctx = (patch = {}) => context(o, { principalId: t.principal, externalSubject: t.subject, ...patch });
  const tscope = { organizationId: o.id, schoolId: o.school, principalId: t.principal, externalSubject: t.subject };
  assert.equal(await plan('kai', 'DRAFT_TEACHING', tctx()), 'PLANNED', 'teaching staff plan Kai');
  assert.equal(await plan('hon', 'ANALYZE', tctx()), 'PLANNED', 'teaching staff may ask HON');
  for (const agentKey of ['marcus', 'chad', 'alex', 'claire']) assert.equal(await plan(agentKey, 'ANALYZE', tctx()), 'PERMISSION_DENIED', `teaching staff cannot plan ${agentKey}`);
  const conv = await hon.create(tscope, { title: 'Teaching staff' }, K());
  const before = { kai: fakes.claire.calls, marcus: fakes.marcus.calls, chad: fakes.chad.calls };
  const kai = await hon.sendTurn(tscope, conv.id, { text: 'Outline a white belt practice.', delegation: { agentKey: 'kai', curriculumId: o.curriculum } }, K());
  assert.deepEqual([kai.status, kai.delegatedAgentKeys], ['AWAITING_APPROVAL', ['kai']], JSON.stringify(kai));
  const marcus = await hon.sendTurn(tscope, conv.id, { text: 'Draft a spring post.', delegation: { agentKey: 'marcus', campaignId: o.campaign ?? K() } }, K());
  const chad = await hon.sendTurn(tscope, conv.id, { text: 'Check in kindly.', delegation: { agentKey: 'chad', leadId: o.lead, expectedLeadVersion: 1, purpose: 'CHECK_IN' } }, K());
  assert.deepEqual([marcus.status, chad.status], ['FAILED', 'FAILED'], JSON.stringify([marcus, chad]));
  assert.deepEqual([fakes.claire.calls - before.kai, fakes.marcus.calls - before.marcus, fakes.chad.calls - before.chad], [1, 0, 0], 'one Kai call; no marketing or CRM provider call');
  // HON answers teaching staff without school business facts (no reporting.view).
  fakes.hon.mode = 'RESULT'; fakes.hon.ready = 'READY';
  const asked = await hon.sendTurn(tscope, conv.id, { text: 'What should I teach today?', delegation: null }, K());
  assert.equal(asked.status, 'COMPLETED', JSON.stringify(asked));
  assert.match(fakes.hon.inputs.at(-1).facts, /NOT_AUTHORIZED/, 'teaching staff get no school business facts');
  // 4. Authority is checked again after the planner's last wait. A blocker holds the per-key advisory lock the planner
  // takes after its first checks; once pg_locks shows the planner waiting there, the instructor's grant is revoked (or
  // its effective_until passes), then the blocker commits. The fresh plan and the exact replay must both be refused with
  // no plan, audit, outbox or idempotency effect.
  const advisoryWaiting = async () => (await row("SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())")).n > 0;
  const effects = (workId) => row(`SELECT (SELECT count(*)::int FROM hon.ai_invocation_plans WHERE work_item_id=$1) plans,
    (SELECT count(*)::int FROM hon.audit_events WHERE organization_id=$2 AND actor_principal_id=$3 AND action_code='ai.invocation.plan') audits,
    (SELECT count(*)::int FROM hon.outbox_events WHERE organization_id=$2 AND event_type='ai.invocation.planned' AND payload->>'workItemId'=$1::text) outbox,
    (SELECT count(*)::int FROM hon.idempotency_records WHERE organization_id=$2 AND principal_id=$3) keys`, [workId, o.id, t.principal]);
  const raceEvidence = [];
  for (const [replay, change] of [[false, 'revoke'], [false, 'expire'], [true, 'revoke'], [true, 'expire']]) {
    const label = `${replay ? 'replay' : 'fresh'}/${change}`;
    if (!(await row('SELECT EXISTS(SELECT 1 FROM hon.principal_role_grants WHERE principal_id=$1 AND revoked_at IS NULL AND (effective_until IS NULL OR effective_until>clock_timestamp())) live', [t.principal])).live) grant = await grantInstructor();
    const workId = await work('AI_DRAFT_TEACHING');
    const input = { expectedVersion: 1, expectedState: 'READY', agentKey: 'kai', modality: 'TEXT', taskClass: 'DRAFT_TEACHING', inputBudget: 1000, outputBudget: 200, maxProviderCostMicrounits: 10000 };
    const key = K();
    if (replay) assert.equal((await plans.plan(tctx({ idempotencyKey: key }), workId, input)).status, 'PLANNED', `${label}: first plan`);
    if (change === 'expire') await admin.query("UPDATE hon.principal_role_grants SET effective_until=clock_timestamp()+interval '3 seconds' WHERE id=$1", [grant.id]);
    const prior = await effects(workId);
    const blocker = new pg.Client({ connectionString: ownerUrl, ssl: false });
    await blocker.connect();
    let outcome, settledEarly = false;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${o.id}:${o.school}:${t.principal}:${key}`]);
      const pending = settle(plans.plan(tctx({ idempotencyKey: key }), workId, input)).then((r) => { settledEarly = true; return r; });
      for (const end = Date.now() + 2500; !(await advisoryWaiting()); await sleep(20)) {
        if (settledEarly || Date.now() > end) throw new Error(`${label}: the planner did not pass its first checks and wait on the per-key lock`);
      }
      if (change === 'revoke') await admin.query('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE id=$1', [grant.id, o.principal]);
      else for (const end = Date.now() + 6000; !(await row('SELECT clock_timestamp()>=effective_until gone FROM hon.principal_role_grants WHERE id=$1', [grant.id])).gone; await sleep(50)) if (Date.now() > end) throw new Error(`${label}: grant did not expire`);
      assert.equal(settledEarly, false, `${label}: still waiting when authority ended`);
      await blocker.query('COMMIT');
      outcome = await pending;
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      await blocker.end();
    }
    const code = outcome.error ? (outcome.error.getResponse?.().code ?? String(outcome.error)) : outcome.value.status;
    assert.equal(code, 'PERMISSION_DENIED', `${label}: authority ended during the wait: ${JSON.stringify(outcome.value ?? String(outcome.error))}`);
    assert.deepEqual(await effects(workId), prior, `${label}: no plan, audit, outbox or idempotency effect`);
    raceEvidence.push(label);
  }
  for (const f of ['ai_agent_capability_permission(text)', 'require_ai_agent_capability(text)', 'hold_and_recheck_ai_planning_authority(text)']) assert.equal((await row(`SELECT has_function_privilege($1,'hon.${f}','EXECUTE') s`, [runtimeRole])).s, false, `${f}: internal helper`);
  pass('INV-27', `0212: the planner requires each agent's own capability (hon ai.invocation.plan, kai teaching.assistant.use, marcus marketing.assistant.use, chad crm.assistant.follow_up_draft); profile-only agents (maya, eian) are never planned (0260: alex, jordan and lena are planned for ANALYZE only); the reviewed teaching-staff preset (CUSTOM_TEACHING_STAFF) is staff-assignable, excludes CRM/people/billing/reporting/marketing/approval, and is created through StaffRoleService and granted to a separate instructor; the instructor plans and uses Kai, is refused for Marcus, Chad and profile-only agents before any provider call, and gets HON answers without school business facts; authority is re-held and re-checked after the planner waits (pg_locks-observed ${raceEvidence.join(', ')}: refused, no plan/audit/outbox/idempotency effect)`);
  }

  // ---- INV-28 (C3a, 0214): HON suggests specialists; suggestions are data, filtered by live capability, and run nothing ----
  {
  const o = await makeOrg('inv-28');
  const scope = { organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject };
  const hon = new HonConversationService(db, agents.marcus.service, agents.claire.service, agents.chad.service, new AiTeamReadinessService(db, fakes.marcus, fakes.claire, fakes.chad, fakes.hon), honReplies);
  const conv = await hon.create(scope, { title: 'Grow enrollment' }, K());
  const ask = (text, key = K()) => hon.sendTurn(scope, conv.id, { text, delegation: null }, key);
  const stored = async (turnId) => (await row('SELECT suggested_agents FROM hon.hon_reply_invocations WHERE turn_id=$1', [turnId])).suggested_agents;
  const drop = (code) => admin.query('DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code=$2', [o.role, code]);
  const add = (code) => admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [o.role, o.id, code]);
  const effects = async () => (await row(`SELECT (SELECT count(*) FROM hon.marketing_ai_invocations WHERE organization_id=$1)::int m, (SELECT count(*) FROM hon.teaching_ai_invocations WHERE organization_id=$1)::int t,
    (SELECT count(*) FROM hon.chad_follow_up_invocations WHERE organization_id=$1)::int c, (SELECT count(*) FROM hon.action_requests WHERE organization_id=$1)::int a`, [o.id]));
  fakes.hon.mode = 'RESULT'; fakes.hon.ready = 'READY';
  const quiet = { calls: { m: fakes.marcus.calls, t: fakes.claire.calls, c: fakes.chad.calls }, effects: await effects() };
  // 1. All three suggested for an owner (every capability): stored, on the receipt and the thread after reload, in order.
  fakes.hon.suggestions = ['marcus', 'kai', 'chad'];
  const r1 = await ask('Help me improve enrollment.');
  assert.deepEqual([r1.status, r1.replyDetail.suggestions, await stored(r1.turnId)], ['COMPLETED', ['marcus', 'kai', 'chad'], ['marcus', 'kai', 'chad']], JSON.stringify(r1));
  assert.deepEqual((await hon.read(scope, conv.id)).turns.at(-1).replyDetail.suggestions, ['marcus', 'kai', 'chad'], 'persisted after reload');
  // A suggestion runs nothing: no specialist call, invocation or Action Center request.
  assert.deepEqual([{ m: fakes.marcus.calls, t: fakes.claire.calls, c: fakes.chad.calls }, await effects()], [quiet.calls, quiet.effects], 'suggestions are data only');
  // 2. Shown only for agents the requester may use now: the stored row is unchanged evidence.
  await drop('marketing.assistant.use');
  assert.deepEqual((await hon.receipt(scope, r1.turnId)).replyDetail.suggestions, ['kai', 'chad'], 'marcus hidden without marketing.assistant.use');
  // 3. Stored only for agents the requester may use when recorded: marcus is never stored here, even after the grant returns.
  const r2 = await ask('What else could help?');
  assert.deepEqual([r2.replyDetail.suggestions, await stored(r2.turnId)], [['kai', 'chad'], ['kai', 'chad']]);
  await add('marketing.assistant.use');
  assert.deepEqual([(await hon.receipt(scope, r1.turnId)).replyDetail.suggestions, (await hon.receipt(scope, r2.turnId)).replyDetail.suggestions], [['marcus', 'kai', 'chad'], ['kai', 'chad']]);
  // 4. A concealed answer shows no suggestions (no reporting.view for a reporting-derived answer).
  await drop('reporting.view');
  const hidden = await hon.receipt(scope, r1.turnId);
  assert.deepEqual([hidden.reason, hidden.reply, hidden.replyDetail.suggestions], ['RESULT_CONCEALED', null, []]);
  await add('reporting.view');
  // 5. A cut-off answer never carries suggestions, and the table refuses any on it.
  fakes.hon.mode = 'TRUNCATED';
  const r3 = await hon.sendTurn(scope, conv.id, { text: 'Write the full plan.', delegation: null, replyMode: 'DETAILED' }, K());
  fakes.hon.mode = 'RESULT';
  assert.deepEqual([r3.status, r3.replyDetail.truncated, r3.replyDetail.suggestions, await stored(r3.turnId)], ['COMPLETED', true, [], []]);
  assert.equal((await settle(admin.query("UPDATE hon.hon_reply_invocations SET suggested_agents='{kai}' WHERE turn_id=$1", [r3.turnId]))).error?.code, '23514', 'no suggestions on a cut-off answer');
  for (const bad of ['{claire}', '{hon}', '{kai,chad,marcus,kai}']) {
    assert.equal((await settle(admin.query('UPDATE hon.hon_reply_invocations SET suggested_agents=$2::text[] WHERE turn_id=$1', [r1.turnId, bad]))).error?.code, '23514', `${bad} refused`);
  }
  // 6. The database refuses malformed suggestions from the API (closed set, unique, at most three) before any write.
  fakes.hon.mode = 'HOLD';
  const pending = settle(ask('Hold for a malformed record.'));
  for (const end = Date.now() + 15000; !(await row("SELECT count(*)::int n FROM hon.hon_reply_invocations WHERE organization_id=$1 AND status='SENDING'", [o.id])).n; await sleep(20)) assert.ok(Date.now() < end, 'reply never reached SENDING');
  const sending = (await row("SELECT turn_id FROM hon.hon_reply_invocations WHERE organization_id=$1 AND status='SENDING'", [o.id])).turn_id;
  const base = { reply: 'x', inputTokens: 1, outputTokens: 1, providerCostMicrounits: 0 };
  for (const suggestions of [['claire'], ['kai', 'kai'], ['kai', 'chad', 'marcus', 'kai'], 'kai', [1], [null]]) {
    const r = await settle(tenant(context(o), (client) => client.query('SELECT hon.record_hon_reply_result($1,$2::uuid,$3::jsonb)', [o.subject, sending, JSON.stringify({ ...base, suggestions })])));
    assert.equal(r.error?.code, '22023', `${JSON.stringify(suggestions)} refused`);
  }
  fakes.hon.suggestions = ['chad'];
  fakes.hon.complete(); fakes.hon.mode = 'RESULT';
  const r4 = (await pending).value;
  assert.deepEqual([r4?.status, r4?.replyDetail?.suggestions, await stored(sending)], ['COMPLETED', ['chad'], ['chad']], JSON.stringify(r4 ?? (await pending).error));
  fakes.hon.suggestions = [];
  assert.equal((await row("SELECT has_function_privilege($1,'hon.hon_reply_allowed_suggestions(uuid,uuid,uuid,text[])','EXECUTE') s", [runtimeRole])).s, false, 'internal helper');
  pass('INV-28', 'C3a: HON suggestions are a closed list (marcus, kai, chad; unique; at most three) stored with the reply only for agents the requester holds the capability for, shown only on a whole, visible COMPLETED answer and only for agents still held now (concealed and cut-off answers show none; the table refuses others), malformed suggestions are refused before any write, and a suggestion runs no specialist, invocation or Action Center request');
  }

  // ---- INV-29 (C3a, 0215): confirming HON's suggestions is an ordinary delegation, grouped with a derived status ----
  {
  const { deriveHonOrchestrationStatus, HON_TURN_STATUSES } = await import('@hon/contracts');
  const o = await makeOrg('inv-29');
  const other = await makeOrg('inv-29-other');
  const scope = { organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject };
  const otherScope = { organizationId: other.id, schoolId: other.school, principalId: other.principal, externalSubject: other.subject };
  const hon = new HonConversationService(db, agents.marcus.service, agents.claire.service, agents.chad.service, new AiTeamReadinessService(db, fakes.marcus, fakes.claire, fakes.chad, fakes.hon), honReplies);
  const code = async (p) => { const r = await settle(p); return r.error?.getResponse?.().code ?? r.error?.code ?? 'OK'; };
  const turnsOf = async (id) => (await row('SELECT count(*)::int n FROM hon.hon_conversation_turns WHERE conversation_id=$1', [id])).n;
  const conv = await hon.create(scope, { title: 'Improve enrollment' }, K());
  const ask = async (suggestions, text = 'Help me improve enrollment.', extra = {}) => { fakes.hon.suggestions = suggestions; try { return await hon.sendTurn(scope, conv.id, { text, delegation: null, ...extra }, K()); } finally { fakes.hon.suggestions = []; } };
  const marcus = (from, key = K()) => hon.sendTurn(scope, conv.id, { text: 'Draft a friendly trial-week post. Use placeholders for unprovided facts.', delegation: { agentKey: 'marcus', campaignId: o.campaign }, fromSuggestionTurnId: from }, key);
  const kai = (from) => hon.sendTurn(scope, conv.id, { text: 'Outline a first-class welcome practice.', delegation: { agentKey: 'kai', curriculumId: o.curriculum }, fromSuggestionTurnId: from }, K());
  const chad = (from) => hon.sendTurn(scope, conv.id, { text: 'Check in kindly about a trial class.', delegation: { agentKey: 'chad', leadId: o.lead, expectedLeadVersion: 1, purpose: 'CHECK_IN' }, fromSuggestionTurnId: from }, K());
  fakes.hon.mode = 'RESULT'; fakes.hon.ready = 'READY';
  const src = await ask(['marcus', 'kai', 'chad']);
  assert.deepEqual(src.replyDetail.suggestions, ['marcus', 'kai', 'chad']);
  assert.deepEqual(await hon.orchestrations(scope, conv.id), { items: [] }, 'nothing grouped before a human confirms');
  // 1. Confirming Marcus is an ordinary delegation (Action Center proposal) grouped under the answer; a resend replays.
  const km = K();
  const m1 = await marcus(src.turnId, km);
  assert.deepEqual([m1.status, m1.delegatedAgentKeys, m1.actionRequestIds.length], ['AWAITING_APPROVAL', ['marcus'], 1], JSON.stringify(m1));
  assert.deepEqual(await marcus(src.turnId, km), m1, 'resend replays');
  assert.deepEqual(await hon.orchestrations(scope, conv.id), { items: [{ sourceTurnId: src.turnId, status: 'NEEDS_REVIEW', members: [{ agentKey: 'marcus', turnId: m1.turnId, status: 'AWAITING_APPROVAL' }] }] });
  // 2. Each suggestion is confirmed at most once; a refusal records no turn.
  const n = await turnsOf(conv.id);
  assert.equal(await code(marcus(src.turnId)), 'HON_SUGGESTION_NOT_CONFIRMABLE');
  assert.equal(await turnsOf(conv.id), n, 'a refused confirmation records nothing');
  // 3. Kai and Chad join the same group; an UNKNOWN member makes the group UNKNOWN (never success).
  const k1 = await kai(src.turnId);
  fakes.chad.mode = 'UNKNOWN';
  const c1 = await chad(src.turnId);
  fakes.chad.mode = 'RESULT';
  assert.deepEqual([k1.status, c1.status], ['AWAITING_APPROVAL', 'UNKNOWN']);
  const g = (await hon.orchestrations(scope, conv.id)).items;
  assert.deepEqual(g.map((x) => [x.sourceTurnId, x.status, x.members.map((m) => [m.agentKey, m.turnId, m.status])]),
    [[src.turnId, 'UNKNOWN', [['marcus', m1.turnId, 'AWAITING_APPROVAL'], ['kai', k1.turnId, 'AWAITING_APPROVAL'], ['chad', c1.turnId, 'UNKNOWN']]]]);
  // 4. Only an agent the answer suggested, from a whole, visible COMPLETED answer of this human in this conversation.
  const onlyKai = await ask(['kai'], 'What should my instructors prepare?');
  assert.equal(await code(marcus(onlyKai.turnId)), 'HON_SUGGESTION_NOT_CONFIRMABLE', 'not suggested');
  await admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='marketing.assistant.use'", [o.role]);
  const fresh = await ask(['marcus'], 'Any marketing ideas?');
  assert.deepEqual(fresh.replyDetail.suggestions, [], 'not stored without the capability');
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'marketing.assistant.use')", [o.role, o.id]);
  const later = await ask(['marcus'], 'Marketing ideas again?');
  await admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='marketing.assistant.use'", [o.role]);
  assert.equal(await code(marcus(later.turnId)), 'HON_SUGGESTION_NOT_CONFIRMABLE', 'capability lapsed since the answer');
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'marketing.assistant.use')", [o.role, o.id]);
  await admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='reporting.view'", [o.role]);
  assert.equal(await code(marcus(later.turnId)), 'HON_SUGGESTION_NOT_CONFIRMABLE', 'a concealed answer cannot be confirmed');
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'reporting.view')", [o.role, o.id]);
  await admin.query("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [o.id]);
  assert.notEqual(await code(marcus(later.turnId)), 'OK', 'no confirmation without AI access');
  await restoreEntitlement(o);
  fakes.hon.mode = 'TRUNCATED';
  const cut = await ask(['marcus'], 'Write the whole plan.', { replyMode: 'DETAILED' });
  fakes.hon.mode = 'RESULT';
  assert.equal(await code(marcus(cut.turnId)), 'HON_SUGGESTION_NOT_CONFIRMABLE', 'a cut-off answer suggests nothing');
  const elsewhere = await hon.create(scope, { title: 'Elsewhere' }, K());
  assert.equal(await code(hon.sendTurn(scope, elsewhere.id, { text: 'Draft a post.', delegation: { agentKey: 'marcus', campaignId: o.campaign }, fromSuggestionTurnId: later.turnId }, K())), 'HON_SUGGESTION_NOT_CONFIRMABLE', 'another conversation');
  assert.equal(await code(marcus(m1.turnId)), 'HON_SUGGESTION_NOT_CONFIRMABLE', 'a delegation turn is not a HON answer');
  assert.equal(await code(hon.sendTurn(scope, conv.id, { text: 'A question', delegation: null, fromSuggestionTurnId: later.turnId }, K())), 'INVALID_HON_TURN', 'questions cannot confirm');
  assert.equal((await settle(tenant(context(o), (client) => client.query('SELECT hon.begin_hon_turn($1,$2,$3::jsonb,$4)', [o.subject, conv.id, JSON.stringify({ text: 'q', delegation: null, fromSuggestionTurnId: later.turnId }), K()])))).error?.message, 'INVALID_HON_TURN');
  assert.equal(await code(marcus(later.turnId)), 'OK', 'confirmable once access returns');
  // 4b. P2-158-1: eligibility lapses while the new group or member write waits on a lock. A blocker holds a SHARE lock on
  // one of the two tables (the duplicate read still works, the INSERT waits); the reporting grant behind a
  // reporting-derived answer, or the Marcus capability, goes during the wait. The confirmation is refused after the wait
  // with nothing persisted (no turn, count, group or member) and no specialist call.
  const groupsOf = async (from) => (await row('SELECT count(*)::int g, (SELECT count(*)::int FROM hon.hon_orchestration_members m JOIN hon.hon_orchestrations o ON o.id=m.orchestration_id WHERE o.source_turn_id=$1) m FROM hon.hon_orchestrations WHERE source_turn_id=$1', [from]));
  const lateWait = async (label, table, from, change, restore) => {
    const before = { turns: await turnsOf(conv.id), count: (await row('SELECT turn_count n FROM hon.hon_conversations WHERE id=$1', [conv.id])).n, groups: await groupsOf(from), calls: fakes.marcus.calls };
    const blocker = new pg.Client({ connectionString: ownerUrl, ssl: false });
    await blocker.connect();
    let out;
    try {
      await blocker.query('BEGIN');
      await blocker.query(`LOCK TABLE hon.${table} IN SHARE MODE`);
      const bpid = (await blocker.query('SELECT pg_backend_pid() p')).rows[0].p;
      let done = false;
      const pending = code(marcus(from)).then((r) => { done = true; return r; });
      for (const end = Date.now() + 5000; !(await row('SELECT count(*)::int n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [bpid])).n; await sleep(20)) {
        assert.ok(!done && Date.now() < end, `${label}: the confirmation never waited on ${table}`);
      }
      await change();
      await blocker.query('COMMIT');
      out = await pending;
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      await blocker.end();
      await restore();
    }
    assert.equal(out, 'HON_SUGGESTION_NOT_CONFIRMABLE', `${label}: refused after the wait`);
    assert.deepEqual({ turns: await turnsOf(conv.id), count: (await row('SELECT turn_count n FROM hon.hon_conversations WHERE id=$1', [conv.id])).n, groups: await groupsOf(from), calls: fakes.marcus.calls }, before, `${label}: nothing persisted, no specialist call`);
  };
  const dropCap = () => admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='marketing.assistant.use'", [o.role]);
  const addCap = () => admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'marketing.assistant.use')", [o.role, o.id]);
  const dropRep = () => admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='reporting.view'", [o.role]);
  const addRep = () => admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'reporting.view')", [o.role, o.id]);
  // Wait at the group table (first confirmation from this answer): the answer stops being visible.
  const w1 = await ask(['marcus', 'kai'], 'How are enrollments trending?');
  assert.equal((await row('SELECT used_reporting u FROM hon.hon_reply_invocations WHERE turn_id=$1', [w1.turnId])).u, true, 'reporting-derived answer');
  await lateWait('visibility at group', 'hon_orchestrations', w1.turnId, dropRep, addRep);
  await lateWait('capability at group', 'hon_orchestrations', w1.turnId, dropCap, addCap);
  // Wait at the member table (the group already exists from a Kai confirmation).
  await kai(w1.turnId);
  assert.deepEqual(await groupsOf(w1.turnId), { g: 1, m: 1 });
  await lateWait('visibility at member', 'hon_orchestration_members', w1.turnId, dropRep, addRep);
  await lateWait('capability at member', 'hon_orchestration_members', w1.turnId, dropCap, addCap);
  // Controls: with nothing lapsing, the same answer confirms; two concurrent fresh-key confirmations of one agent admit
  // exactly one; two concurrent sends of one key replay one turn.
  const w2 = await ask(['marcus'], 'Any quick marketing wins?');
  const racing = await Promise.all([settle(marcus(w2.turnId)), settle(marcus(w2.turnId))]);
  assert.deepEqual(racing.map((r) => (r.error ? (r.error.getResponse?.().code ?? r.error.code) : 'OK')).sort(), ['HON_SUGGESTION_NOT_CONFIRMABLE', 'OK'], 'fresh keys: one confirmation');
  assert.deepEqual(await groupsOf(w2.turnId), { g: 1, m: 1 });
  const w3 = await ask(['marcus'], 'One more marketing idea?');
  const kr = K();
  const replayed = await Promise.all([marcus(w3.turnId, kr), marcus(w3.turnId, kr)]);
  assert.equal(replayed[0].turnId, replayed[1].turnId, 'same key: one turn');
  assert.deepEqual(await groupsOf(w3.turnId), { g: 1, m: 1 });
  assert.equal(await code(marcus(w1.turnId)), 'OK', 'the lapsed answer confirms once access is back');
  // 5. Another school's human cannot read or confirm from this conversation.
  assert.equal(await code(hon.orchestrations(otherScope, conv.id)), 'HON_CONVERSATION_NOT_FOUND');
  assert.equal(await code(hon.sendTurn(otherScope, conv.id, { text: 'Draft.', delegation: { agentKey: 'marcus', campaignId: other.campaign }, fromSuggestionTurnId: src.turnId }, K())), 'HON_CONVERSATION_NOT_FOUND');
  // 6. Groups are append-only; the derived status in SQL equals the contract's for every member combination.
  for (const sql of ['UPDATE hon.hon_orchestrations SET created_at=created_at WHERE source_turn_id=$1', 'DELETE FROM hon.hon_orchestration_members WHERE turn_id=$1']) {
    assert.equal((await settle(admin.query(sql, [sql.startsWith('UPDATE') ? src.turnId : m1.turnId]))).error?.code, '55000', sql);
  }
  const combos = [];
  for (const a of HON_TURN_STATUSES) { combos.push([a]); for (const b of HON_TURN_STATUSES) { combos.push([a, b]); for (const c of HON_TURN_STATUSES) combos.push([a, b, c]); } }
  const sqlStatus = (await row('SELECT jsonb_agg(hon.hon_orchestration_status(ARRAY(SELECT jsonb_array_elements_text(x)))) r FROM jsonb_array_elements($1::jsonb) x', [JSON.stringify(combos)])).r;
  assert.deepEqual(sqlStatus, combos.map((x) => deriveHonOrchestrationStatus(x)), 'SQL and contract derivations agree');
  for (const t of ['hon_orchestrations', 'hon_orchestration_members']) assert.equal((await row(`SELECT has_table_privilege($1,'hon.${t}','SELECT') s`, [runtimeRole])).s, false, `${t}: functions only`);
  for (const f of ['hon_orchestration_status(text[])', 'hon_orchestration_immutable()']) assert.equal((await row(`SELECT has_function_privilege($1,'hon.${f}','EXECUTE') s`, [runtimeRole])).s, false, `${f}: internal`);
  assert.equal((await row("SELECT has_function_privilege($1,'hon.read_hon_orchestrations(text,uuid)','EXECUTE') s", [runtimeRole])).s, true);
  pass('INV-29', `C3a: a human confirms a HON suggestion as an ordinary delegation turn (own capability, plan and Action Center path; resend replays), grouped per answer with a status derived from the members' recorded statuses (${combos.length} combinations equal in SQL and contract; UNKNOWN never success); each suggestion confirms once; only suggested, capability-held agents from this human's own whole, visible COMPLETED answer in the same conversation with AI access, re-checked after the group and member writes wait (a lapse during either wait is refused with nothing persisted and no specialist call; concurrent fresh keys admit one, one key replays one turn); refusals record no turn; groups are append-only and readable only by their owner`);
  }

  // ---- INV-30 (C3b, 0228): HON summarizes a finished group's recorded outcomes; a summary is an ordinary question ----
  {
  const o = await makeOrg('inv-30');
  const scope = { organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject };
  const hon = new HonConversationService(db, agents.marcus.service, agents.claire.service, agents.chad.service, new AiTeamReadinessService(db, fakes.marcus, fakes.claire, fakes.chad, fakes.hon), honReplies);
  const code = async (p) => { const r = await settle(p); return r.error?.getResponse?.().code ?? r.error?.code ?? r.error?.message ?? 'OK'; };
  const turnsOf = async (id) => (await row('SELECT count(*)::int n FROM hon.hon_conversation_turns WHERE conversation_id=$1', [id])).n;
  const conv = await hon.create(scope, { title: 'Grow trials' }, K());
  const ask = async (suggestions, text) => { fakes.hon.suggestions = suggestions; try { return await hon.sendTurn(scope, conv.id, { text, delegation: null }, K()); } finally { fakes.hon.suggestions = []; } };
  const marcus = (from) => hon.sendTurn(scope, conv.id, { text: 'Draft a friendly trial-week post. Use placeholders for unprovided facts.', delegation: { agentKey: 'marcus', campaignId: o.campaign }, fromSuggestionTurnId: from }, K());
  const kai = (from) => hon.sendTurn(scope, conv.id, { text: 'Outline a first-class welcome practice.', delegation: { agentKey: 'kai', curriculumId: o.curriculum }, fromSuggestionTurnId: from }, K());
  const summarize = (from, key = K(), extra = {}) => hon.sendTurn(scope, conv.id, { text: 'Summarize what the team did.', delegation: null, summarizeTurnId: from, ...extra }, key);
  const dropRep = () => admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='reporting.view'", [o.role]);
  const addRep = () => admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'reporting.view')", [o.role, o.id]);
  fakes.hon.mode = 'RESULT'; fakes.hon.ready = 'READY';
  // 1. No group yet, and a group still awaiting review, cannot be summarized; a refusal records no turn.
  const pending = await ask(['marcus'], 'How do I fill the trial week?');
  let n = await turnsOf(conv.id);
  assert.equal(await code(summarize(pending.turnId)), 'HON_GROUP_NOT_SUMMARIZABLE', 'no group');
  await marcus(pending.turnId);
  n = await turnsOf(conv.id);
  assert.equal(await code(summarize(pending.turnId)), 'HON_GROUP_NOT_SUMMARIZABLE', 'NEEDS_REVIEW is not finished');
  assert.equal(await turnsOf(conv.id), n, 'a refused summary records nothing');
  // 2. A finished group (both members FAILED): the summary is an ordinary question whose facts carry only recorded outcomes.
  const src = await ask(['marcus', 'kai'], 'How are enrollments trending?');
  assert.equal((await row('SELECT used_reporting u FROM hon.hon_reply_invocations WHERE turn_id=$1', [src.turnId])).u, true, 'reporting-derived source');
  fakes.marcus.mode = 'FAILED'; fakes.claire.mode = 'FAILED';
  const m = await marcus(src.turnId), k = await kai(src.turnId);
  fakes.marcus.mode = 'RESULT'; fakes.claire.mode = 'RESULT';
  assert.deepEqual([m.status, k.status], ['FAILED', 'FAILED']);
  const specialistCalls = fakes.marcus.calls + fakes.claire.calls + fakes.chad.calls, honCalls = fakes.hon.calls;
  const key = K();
  const sum = await summarize(src.turnId, key);
  assert.deepEqual([sum.status, fakes.hon.calls - honCalls, fakes.marcus.calls + fakes.claire.calls + fakes.chad.calls - specialistCalls], ['COMPLETED', 1, 0], JSON.stringify(sum));
  const group = JSON.parse(fakes.hon.inputs.at(-1).facts).group;
  assert.deepEqual([group.status, group.sourceQuestion, group.sourceAnswer, group.members.map((x) => [x.agentKey, x.status])],
    ['FAILED', 'How are enrollments trending?', fakes.hon.reply, [['marcus', 'FAILED'], ['kai', 'FAILED']]]);
  for (const x of group.members) assert.deepEqual(Object.keys(x).filter((k2) => !['agentKey', 'status', 'reason'].includes(k2)), [], 'recorded outcome fields only');
  assert.doesNotMatch(fakes.hon.inputs.at(-1).facts, /Welcome to beginner classes|Practice outline/, 'no specialist drafts');
  const recorded = await row('SELECT summarizes_turn_id s, step, continues_turn_id c FROM hon.hon_reply_invocations WHERE turn_id=$1', [sum.turnId]);
  assert.deepEqual([recorded.s, recorded.step, recorded.c], [src.turnId, 1, null]);
  assert.deepEqual(await summarize(src.turnId, key), sum, 'resend replays');
  assert.equal(fakes.hon.calls - honCalls, 1, 'no second call');
  // 3. Refusals: another conversation, an unknown answer, a concealed source answer, a continuation, a delegation.
  const elsewhere = await hon.create(scope, { title: 'Elsewhere' }, K());
  assert.equal(await code(hon.sendTurn(scope, elsewhere.id, { text: 'Summarize.', delegation: null, summarizeTurnId: src.turnId }, K())), 'HON_GROUP_NOT_SUMMARIZABLE', 'another conversation');
  assert.equal(await code(summarize(K())), 'HON_GROUP_NOT_SUMMARIZABLE', 'unknown answer');
  await dropRep();
  assert.equal(await code(summarize(src.turnId)), 'HON_GROUP_NOT_SUMMARIZABLE', 'a concealed source answer');
  await addRep();
  for (const bad of [{ text: 'q', delegation: null, summarizeTurnId: src.turnId, continueTurnId: sum.turnId },
    { text: 'Draft.', delegation: { agentKey: 'marcus', campaignId: o.campaign }, summarizeTurnId: src.turnId }]) {
    assert.equal((await settle(tenant(context(o), (c) => c.query('SELECT hon.begin_hon_turn($1,$2,$3::jsonb,$4)', [o.subject, conv.id, JSON.stringify(bad), K()])))).error?.message, 'INVALID_HON_TURN', JSON.stringify(bad));
  }
  // 4. Eligibility lapses while the reply row write waits (a blocker holds SHARE on hon_reply_invocations): refused after
  //    the wait, nothing persisted.
  {
    const before = { turns: await turnsOf(conv.id), replies: (await row('SELECT count(*)::int n FROM hon.hon_reply_invocations WHERE conversation_id=$1', [conv.id])).n, calls: fakes.hon.calls };
    const blocker = new pg.Client({ connectionString: ownerUrl, ssl: false });
    await blocker.connect();
    let out;
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE hon.hon_reply_invocations IN SHARE MODE');
      const bpid = (await blocker.query('SELECT pg_backend_pid() p')).rows[0].p;
      let done = false;
      const p = code(summarize(src.turnId)).then((r) => { done = true; return r; });
      for (const end = Date.now() + 5000; !(await row('SELECT count(*)::int n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [bpid])).n; await sleep(20)) {
        assert.ok(!done && Date.now() < end, 'the summary never waited on the reply row');
      }
      await dropRep();
      await blocker.query('COMMIT');
      out = await p;
    } finally { await blocker.query('ROLLBACK').catch(() => {}); await blocker.end(); await addRep(); }
    assert.equal(out, 'HON_GROUP_NOT_SUMMARIZABLE', 'refused after the wait');
    assert.deepEqual({ turns: await turnsOf(conv.id), replies: (await row('SELECT count(*)::int n FROM hon.hon_reply_invocations WHERE conversation_id=$1', [conv.id])).n, calls: fakes.hon.calls }, before, 'nothing persisted');
  }
  // 5. A lapse between the turn and prepare: nothing is reserved and HON is not called.
  {
    const kTurn = K();
    const begun = await tenant(context(o), (c) => c.query('SELECT hon.begin_hon_turn($1,$2,$3::jsonb,$4) d', [o.subject, conv.id, JSON.stringify({ text: 'Summarize again.', delegation: null, summarizeTurnId: src.turnId }), kTurn]));
    const turnId = begun.rows[0].d.turnId;
    const ref = (await tenant(context(o), (c) => c.query('SELECT hon.hon_reply_planning_reference($1,$2::uuid) d', [o.subject, turnId]))).rows[0].d;
    const lim = ref.limits;
    const planned = await plans.plan({ ...context(o), idempotencyKey: ref.invocationId }, ref.workItemId, { expectedVersion: ref.workVersion, expectedState: 'READY', agentKey: 'hon', modality: 'TEXT', taskClass: lim.taskClass, inputBudget: lim.inputBudget, outputBudget: lim.outputBudget, maxProviderCostMicrounits: lim.maxProviderCostMicrounits });
    await dropRep();
    const calls = fakes.hon.calls;
    const prepared = await tenant(context(o), async (c) => { await c.query("SELECT set_config('app.hon_external_subject',$1,true)", [o.subject]); return (await c.query('SELECT hon.prepare_hon_reply($1,$2::uuid,$3::uuid,true) d', [o.subject, turnId, planned.plan.id])).rows[0].d; });
    await addRep();
    const r = await row('SELECT status, reason, reserved_credits FROM hon.hon_reply_invocations WHERE turn_id=$1', [turnId]);
    assert.deepEqual([prepared, r.status, r.reason, r.reserved_credits, fakes.hon.calls - calls], [null, 'BLOCKED', 'GROUP_NOT_SUMMARIZABLE', 0, 0]);
  }
  // 6. The table refuses a summary that continues an answer; the helper is internal.
  assert.equal((await settle(admin.query('UPDATE hon.hon_reply_invocations SET step=2 WHERE turn_id=$1', [sum.turnId]))).error?.code ?? 'OK', '23514');
  assert.equal((await row("SELECT has_function_privilege($1,'hon.hon_orchestration_summary_facts(text,uuid,uuid,uuid)','EXECUTE') s", [runtimeRole])).s, false);
  pass('INV-30', 'C3b: HON summarizes a confirmed group only when it is finished (COMPLETED, FAILED or PARTIAL; never no group, NEEDS_REVIEW or UNKNOWN), for this human\'s own group in the same conversation while the source answer is visible; the summary is an ordinary planned question (resend replays, one call) whose facts carry only the recorded group status, source question and answer and each member\'s specialist, status and reason (no drafts) and call no specialist; eligibility is re-checked after the reply row write waits and again in prepare (a lapse persists nothing, or reserves nothing and calls nothing); refusals record no turn; the helper is internal');
  }

  // ---- INV-31 (K2, 0229): Claire, Business Performance: a read-only analysis of the school's metrics ----
  {
  const o = await makeOrg('inv-31');
  const scope = { organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject };
  const hon = new HonConversationService(db, agents.marcus.service, agents.claire.service, agents.chad.service, new AiTeamReadinessService(db, fakes.marcus, fakes.claire, fakes.chad, fakes.hon), honReplies);
  const code = async (p) => { const r = await settle(p); return r.error?.getResponse?.().code ?? r.error?.code ?? r.error?.message ?? 'OK'; };
  const turnsOf = async (id) => (await row('SELECT count(*)::int n FROM hon.hon_conversation_turns WHERE conversation_id=$1', [id])).n;
  const conv = await hon.create(scope, { title: 'How are we doing' }, K());
  const claire = (text = 'How is retention this month?', key = K(), extra = {}) => hon.sendTurn(scope, conv.id, { text, delegation: { agentKey: 'claire' }, ...extra }, key);
  const dropRep = () => admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='reporting.view'", [o.role]);
  const addRep = () => admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'reporting.view')", [o.role, o.id]);
  fakes.hon.mode = 'RESULT'; fakes.hon.ready = 'READY'; fakes.hon.suggestions = [];
  // 1. A reporting user's question to Claire: one call, planned as claire/ANALYZE (DETAILED budgets), metrics and question only.
  await hon.sendTurn(scope, conv.id, { text: 'Earlier question for HON.', delegation: null }, K());
  const before = { hon: fakes.hon.calls, specialists: fakes.marcus.calls + fakes.claire.calls + fakes.chad.calls };
  const key = K();
  const a = await claire(undefined, key);
  assert.deepEqual([a.status, a.delegatedAgentKeys, a.reply, a.replyDetail.mode, a.replyDetail.step, a.replyDetail.canContinue, a.replyDetail.suggestions],
    ['COMPLETED', ['claire'], fakes.hon.reply, 'DETAILED', 1, false, []], JSON.stringify(a));
  assert.deepEqual([fakes.hon.calls - before.hon, fakes.marcus.calls + fakes.claire.calls + fakes.chad.calls - before.specialists], [1, 0], 'one analysis call, no draft specialist');
  const input = fakes.hon.inputs.at(-1);
  assert.deepEqual([input.specialist, input.replyMode, input.step, input.question], ['claire', 'DETAILED', 1, 'How is retention this month?']);
  assert.deepEqual(Object.keys(JSON.parse(input.facts)), ['school'], 'metrics only: no conversation history');
  assert.notEqual(JSON.parse(input.facts).school.availability, 'NOT_AUTHORIZED');
  const rec = await row(`SELECT r.specialist, r.used_reporting, p.agent_key, p.task_class, t.agent_key AS turn_agent FROM hon.hon_reply_invocations r
    JOIN hon.ai_invocation_plans p ON p.id = r.plan_id JOIN hon.hon_conversation_turns t ON t.id = r.turn_id WHERE r.turn_id=$1`, [a.turnId]);
  assert.deepEqual(rec, { specialist: 'claire', used_reporting: true, agent_key: 'claire', task_class: 'ANALYZE', turn_agent: 'claire' });
  assert.deepEqual(await claire(undefined, key), a, 'resend replays');
  assert.equal(fakes.hon.calls - before.hon, 1, 'no second call');
  const thread = await hon.read(scope, conv.id);
  assert.deepEqual([thread.turns.at(-1).role, thread.turns.at(-1).text], ['claire', fakes.hon.reply]);
  // HON's next answer sees Claire's turn as Claire's (not Kai's) and does not receive her answer text.
  await hon.sendTurn(scope, conv.id, { text: 'And what next?', delegation: null }, K());
  const hist = JSON.parse(fakes.hon.inputs.at(-1).facts).history;
  assert.deepEqual(hist.at(-1), { question: 'How is retention this month?', delegatedTo: 'claire' });
  // 2. Without reporting.view Claire is refused at begin and nothing is recorded.
  await dropRep();
  let n = await turnsOf(conv.id);
  assert.equal(await code(claire()), 'HON_CONVERSATION_FORBIDDEN');
  assert.equal(await turnsOf(conv.id), n, 'refused before any turn');
  await addRep();
  // 2b. reporting.view lapses while the reply row write waits (a blocker holds SHARE on hon_reply_invocations): refused
  //     after the wait, nothing persisted and no call.
  {
    const repliesOf = async () => (await row('SELECT count(*)::int n FROM hon.hon_reply_invocations WHERE conversation_id=$1', [conv.id])).n;
    const before2 = { turns: await turnsOf(conv.id), replies: await repliesOf(), calls: fakes.hon.calls };
    const blocker = new pg.Client({ connectionString: ownerUrl, ssl: false });
    await blocker.connect();
    let out;
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE hon.hon_reply_invocations IN SHARE MODE');
      const bpid = (await blocker.query('SELECT pg_backend_pid() p')).rows[0].p;
      let done = false;
      const p = code(claire('Lapse while waiting?')).then((r) => { done = true; return r; });
      for (const end = Date.now() + 5000; !(await row('SELECT count(*)::int n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [bpid])).n; await sleep(20)) {
        assert.ok(!done && Date.now() < end, 'the Claire turn never waited on the reply row');
      }
      await dropRep();
      await blocker.query('COMMIT');
      out = await p;
    } finally { await blocker.query('ROLLBACK').catch(() => {}); await blocker.end(); await addRep(); }
    assert.equal(out, 'HON_CONVERSATION_FORBIDDEN', 'refused after the wait');
    assert.deepEqual({ turns: await turnsOf(conv.id), replies: await repliesOf(), calls: fakes.hon.calls }, before2, 'nothing persisted');
  }
  // 3. A lapse between begin and prepare: BLOCKED, nothing reserved, no call.
  {
    const begun = await tenant(context(o), (c) => c.query('SELECT hon.begin_hon_turn($1,$2,$3::jsonb,$4) d', [o.subject, conv.id, JSON.stringify({ text: 'Revenue trend?', delegation: { agentKey: 'claire' } }), K()]));
    const turnId = begun.rows[0].d.turnId;
    assert.equal(begun.rows[0].d.agentKey, 'claire');
    const ref = (await tenant(context(o), (c) => c.query('SELECT hon.hon_reply_planning_reference($1,$2::uuid) d', [o.subject, turnId]))).rows[0].d;
    assert.deepEqual([ref.agentKey, ref.limits.replyMode, ref.limits.taskClass], ['claire', 'DETAILED', 'ANALYZE']);
    const lim = ref.limits;
    const planned = await plans.plan({ ...context(o), idempotencyKey: ref.invocationId }, ref.workItemId, { expectedVersion: ref.workVersion, expectedState: 'READY', agentKey: 'claire', modality: 'TEXT', taskClass: lim.taskClass, inputBudget: lim.inputBudget, outputBudget: lim.outputBudget, maxProviderCostMicrounits: lim.maxProviderCostMicrounits });
    await dropRep();
    const calls = fakes.hon.calls;
    const prepared = await tenant(context(o), async (c) => { await c.query("SELECT set_config('app.hon_external_subject',$1,true)", [o.subject]); return (await c.query('SELECT hon.prepare_hon_reply($1,$2::uuid,$3::uuid,true) d', [o.subject, turnId, planned.plan.id])).rows[0].d; });
    await addRep();
    const r = await row('SELECT status, reason, reserved_credits FROM hon.hon_reply_invocations WHERE turn_id=$1', [turnId]);
    assert.deepEqual([prepared, r.status, r.reason, r.reserved_credits, fakes.hon.calls - calls], [null, 'BLOCKED', 'SOURCE_ACCESS_REFUSED', 0, 0]);
  }
  // 4. A lapse after completion conceals the analysis; the usage evidence stays.
  await dropRep();
  const hidden = (await hon.read(scope, conv.id)).turns.find((t) => t.turnId === a.turnId && t.role === 'claire');
  assert.deepEqual([hidden.text, hidden.reason], [null, 'RESULT_CONCEALED']);
  assert.ok((await row('SELECT usage_id FROM hon.hon_reply_invocations WHERE turn_id=$1', [a.turnId])).usage_id, 'usage evidence stays');
  await addRep();
  // 5. The legacy 'claire' teaching alias is retired; Claire is not continued, summarized or confirmed from a suggestion.
  for (const [bad, expected] of [[{ text: 'Outline.', delegation: { agentKey: 'claire', curriculumId: o.curriculum } }, 'HON_DELEGATION_REQUIRED'],
    [{ text: 'x', delegation: { agentKey: 'claire' }, fromSuggestionTurnId: a.turnId }, 'HON_SUGGESTION_NOT_CONFIRMABLE'],
    [{ text: 'Continue', delegation: null, continueTurnId: a.turnId }, 'HON_REPLY_NOT_CONTINUABLE'],
    [{ text: '  ', delegation: { agentKey: 'claire' } }, 'INVALID_HON_TURN']]) {
    assert.equal((await settle(tenant(context(o), (c) => c.query('SELECT hon.begin_hon_turn($1,$2,$3::jsonb,$4)', [o.subject, conv.id, JSON.stringify(bad), K()])))).error?.message, expected, JSON.stringify(bad));
  }
  // 6. Table and planner rules: Claire rows are single DETAILED analyses; 'claire' plans are ANALYZE only.
  assert.equal((await settle(admin.query("UPDATE hon.hon_reply_invocations SET reply_mode='STANDARD' WHERE turn_id=$1", [a.turnId]))).error?.code ?? 'OK', '23514');
  assert.equal((await settle(admin.query("UPDATE hon.hon_reply_invocations SET suggested_agents='{marcus}' WHERE turn_id=$1", [a.turnId]))).error?.code ?? 'OK', '23514');
  assert.equal((await row("SELECT hon.ai_agent_capability_permission('claire') c")).c, 'reporting.view');
  assert.equal((await row("SELECT count(*)::int n FROM pg_constraint WHERE conname='ai_invocation_plans_claire_analysis_only' AND pg_get_constraintdef(oid) LIKE '%ANALYZE%'")).n, 1);
  // 7. Readiness lists Claire separately; she needs reporting.view.
  const ready = await new AiTeamReadinessService(db, fakes.marcus, fakes.claire, fakes.chad, fakes.hon).read(scope);
  const c7 = ready.data.agents.find((x) => x.agentKey === 'claire');
  assert.deepEqual([c7.agent, c7.authorized, c7.requestCredits], ['BUSINESS_PERFORMANCE', true, 15]);
  await dropRep();
  assert.equal((await new AiTeamReadinessService(db, fakes.marcus, fakes.claire, fakes.chad, fakes.hon).read(scope)).data.agents.find((x) => x.agentKey === 'claire').blockedBy, 'NOT_AUTHORIZED');
  await addRep();
  // 8. HQ usage (0267): Claire's calls count under BUSINESS_PERFORMANCE, never HON_REPLY, including a late provider
  //    expense recorded after an HQ write-off of her UNKNOWN call; a HON answer in the same school stays HON_REPLY.
  {
    const usageOf = async () => (await row('SELECT hon.read_ai_school_usage_from_hq($1,$2::timestamptz,$3::timestamptz) r',
      [hq.subject, new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString()])).r.schools.find((x) => x.schoolId === o.school);
    const claireLedger = (await row("SELECT count(*)::int n FROM hon.ai_usage_ledger u JOIN hon.hon_reply_invocations i ON i.id = u.source_invocation_id WHERE i.specialist='claire' AND u.organization_id=$1", [o.id])).n;
    assert.ok(claireLedger >= 1);
    const honLedger = (await row("SELECT count(*)::int n FROM hon.ai_usage_ledger u JOIN hon.hon_reply_invocations i ON i.id = u.source_invocation_id WHERE i.specialist='hon' AND u.organization_id=$1", [o.id])).n;
    let by = (await usageOf()).byClass.AGENT_INFERENCE.byAgent;
    assert.deepEqual([by.BUSINESS_PERFORMANCE?.entries, by.HON_REPLY?.entries ?? 0], [claireLedger, honLedger], JSON.stringify(by));
    fakes.hon.mode = 'UNKNOWN';
    let lostTurn;
    try { lostTurn = await claire('Usage attribution probe'); } finally { fakes.hon.mode = 'RESULT'; }
    assert.equal(lostTurn.status, 'UNKNOWN', JSON.stringify(lostTurn));
    const lost = await row('SELECT id FROM hon.hon_reply_invocations WHERE turn_id=$1', [lostTurn.turnId]);
    const off = await settle(admin.query('SELECT hon.resolve_ai_unknown_invocation($1,$2,$3::uuid,$4::jsonb,$5::uuid,$6::uuid,$7::uuid) r',
      [hq.subject, 'HON_REPLY', lost.id, JSON.stringify({ decision: 'WRITE_OFF', reason: 'Synthetic AI-0 K2 provider lookup unavailable', evidence: { estimatedProviderCostMicrounits: 700 } }), K(), K(), K()]));
    assert.ok(off.value, off.error?.message);
    const lateRec = await settle(admin.query('SELECT hon.record_ai_late_provider_expense($1,$2,$3::uuid,$4::jsonb,$5::uuid,$6::uuid,$7::uuid) r',
      [hq.subject, 'HON_REPLY', lost.id, JSON.stringify({ reason: 'Provider usage export showed the actual charge', evidence: { providerGenerationId: 'gen-ai0-claire-late', inputTokens: 900, outputTokens: 400, providerCostMicrounits: 650 } }), K(), K(), K()]));
    assert.ok(lateRec.value, lateRec.error?.message);
    by = (await usageOf()).byClass.AGENT_INFERENCE.byAgent;
    assert.deepEqual([by.BUSINESS_PERFORMANCE?.entries, by.BUSINESS_PERFORMANCE?.writeOffEntries, by.BUSINESS_PERFORMANCE?.lateProviderExpenseEntries,
      by.BUSINESS_PERFORMANCE?.lateProviderCostMicrounits, by.HON_REPLY?.entries ?? 0, by.HON_REPLY?.lateProviderExpenseEntries ?? 0], [claireLedger + 1, 1, 1, 650, honLedger, 0], JSON.stringify(by));
    const honAnswer = await hon.sendTurn(scope, conv.id, { text: 'And overall?', delegation: null }, K());
    assert.equal(honAnswer.status, 'COMPLETED', JSON.stringify(honAnswer));
    by = (await usageOf()).byClass.AGENT_INFERENCE.byAgent;
    assert.deepEqual([by.BUSINESS_PERFORMANCE?.entries, by.HON_REPLY?.entries], [claireLedger + 1, honLedger + 1], 'a HON answer stays HON_REPLY');
  }
  pass('INV-31', "K2: Claire (Business Performance) answers a question in text from the school's aggregate metrics only (planned as claire/ANALYZE with the fixed DETAILED budgets, one call, no draft specialist, no history; resend replays); she needs reporting.view at begin (refused, nothing recorded, also when it lapses while the reply row write waits) and in prepare (a lapse reserves and calls nothing); her answer is concealed when reporting.view lapses while usage evidence stays; HON sees her turn as Claire's without her text; the legacy 'claire' teaching alias is refused; Claire answers are never continued, summarized from or confirmed as suggestions; rows are single DETAILED analyses without suggestions and 'claire' plans are ANALYZE only; readiness lists BUSINESS_PERFORMANCE gated on reporting.view; HQ usage counts her calls (and a late provider expense after an HQ write-off) under BUSINESS_PERFORMANCE, never HON_REPLY");
  }

  // ---- INV-32 (0254): "Ask next" follow-ups and "Based on" sources are presentation data only ----
  {
  const o = await makeOrg('inv-32');
  const scope = { organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject };
  const hon = new HonConversationService(db, agents.marcus.service, agents.claire.service, agents.chad.service, new AiTeamReadinessService(db, fakes.marcus, fakes.claire, fakes.chad, fakes.hon), honReplies);
  const conv = await hon.create(scope, { title: 'Follow-ups' }, K());
  const ask = (text, extra = {}) => hon.sendTurn(scope, conv.id, { text, delegation: null, ...extra }, K());
  const stored = async (turnId) => row('SELECT follow_up_questions f, available_sources a, cited_sources c FROM hon.hon_reply_invocations WHERE turn_id=$1', [turnId]);
  const dropRep = () => admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='reporting.view'", [o.role]);
  const addRep = () => admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'reporting.view')", [o.role, o.id]);
  const set = (f, src) => { fakes.hon.followUps = f; fakes.hon.sources = src; };
  fakes.hon.mode = 'RESULT'; fakes.hon.ready = 'READY'; fakes.hon.suggestions = [];
  const metricKeys = ['newLeads24h', 'upcomingTrials24h', 'upcomingTestingEvents30d', 'pendingActionApprovals', 'outstandingWorkItems', 'membershipTermsEnding30d', 'paidInvoicesCreated30d'];
  // 1. First question: the server records the fact areas it sent (AVAILABLE metrics only, no conversation yet) and keeps only
  //    cited areas among them; follow-ups are stored and shown on the receipt and after reload.
  const usageBefore = Number((await row('SELECT coalesce(sum(customer_credits),0) n FROM hon.ai_usage_ledger WHERE organization_id=$1', [o.id])).n);
  const callsBefore = fakes.hon.calls;
  set(['Who should call the new leads?', 'How many trials are booked?'], ['revenue', 'newLeads24h', 'conversation']);
  const r1 = await ask('How are leads?');
  const s1 = await stored(r1.turnId);
  assert.deepEqual([r1.status, r1.replyDetail.followUps, r1.replyDetail.sources], ['COMPLETED', ['Who should call the new leads?', 'How many trials are booked?'], ['newLeads24h']], JSON.stringify(r1));
  assert.deepEqual([s1.a, s1.c], [metricKeys, ['newLeads24h']], 'only AVAILABLE metrics sent; UNAVAILABLE revenue and absent conversation are never cited');
  assert.deepEqual((await hon.read(scope, conv.id)).turns.at(-1).replyDetail.followUps, ['Who should call the new leads?', 'How many trials are booked?'], 'persisted');
  // Presentation data only: one provider call, the usual usage row, nothing else runs.
  assert.equal(fakes.hon.calls - callsBefore, 1);
  assert.equal(Number((await row('SELECT coalesce(sum(customer_credits),0) n FROM hon.ai_usage_ledger WHERE organization_id=$1', [o.id])).n) - usageBefore, 1, 'same usage as any answer');
  // 2. A later question sent the earlier conversation: it may be cited.
  set([], ['conversation', 'upcomingTrials24h']);
  const r2 = await ask('And what about trials?');
  assert.deepEqual([r2.replyDetail.followUps, r2.replyDetail.sources, (await stored(r2.turnId)).a], [[], ['conversation', 'upcomingTrials24h'], [...metricKeys, 'conversation']]);
  // 3. A concealed answer shows neither (stored evidence unchanged).
  await dropRep();
  const hidden = await hon.receipt(scope, r1.turnId);
  assert.deepEqual([hidden.reason, hidden.replyDetail.followUps, hidden.replyDetail.sources, (await stored(r1.turnId)).c], ['RESULT_CONCEALED', [], [], ['newLeads24h']]);
  // Without reporting.view no metrics are sent: a new answer can cite only the conversation.
  set(['Anything else?'], ['newLeads24h', 'conversation']);
  const r3 = await ask('What should I do today?');
  assert.deepEqual([r3.replyDetail.sources, (await stored(r3.turnId)).a], [['conversation'], ['conversation']]);
  await addRep();
  // 4. A cut-off answer keeps none, and the table refuses them on it; cited must be a subset of available; bad text refused.
  fakes.hon.mode = 'TRUNCATED'; set(['More?'], ['newLeads24h']);
  const r4 = await ask('Write the full plan.', { replyMode: 'DETAILED' });
  fakes.hon.mode = 'RESULT';
  assert.deepEqual([r4.replyDetail.truncated, r4.replyDetail.followUps, r4.replyDetail.sources], [true, [], []]);
  for (const [sql, args, why] of [
    ["UPDATE hon.hon_reply_invocations SET follow_up_questions='{\"More please?\"}' WHERE turn_id=$1", [r4.turnId], 'no follow-ups on a cut-off answer'],
    ["UPDATE hon.hon_reply_invocations SET cited_sources='{newLeads24h}' WHERE turn_id=$1", [r4.turnId], 'no sources on a cut-off answer'],
    ["UPDATE hon.hon_reply_invocations SET cited_sources='{revenue}' WHERE turn_id=$1", [r1.turnId], 'cited must have been sent'],
    ["UPDATE hon.hon_reply_invocations SET available_sources='{website}' WHERE turn_id=$1", [r1.turnId], 'closed source set'],
    ["UPDATE hon.hon_reply_invocations SET follow_up_questions=ARRAY['a','b','c','d']||'{}'::text[] WHERE turn_id=$1", [r2.turnId], 'at most three'],
    ["UPDATE hon.hon_reply_invocations SET follow_up_questions=ARRAY[E'Line\\nbreak?'] WHERE turn_id=$1", [r2.turnId], 'no newline'],
  ]) assert.equal((await settle(admin.query(sql, args))).error?.code, '23514', why);
  // 5. The database refuses malformed values from the API before any write.
  fakes.hon.mode = 'HOLD';
  const pending = settle(ask('Hold for malformed follow-ups.'));
  for (const end = Date.now() + 15000; !(await row("SELECT count(*)::int n FROM hon.hon_reply_invocations WHERE organization_id=$1 AND status='SENDING'", [o.id])).n; await sleep(20)) assert.ok(Date.now() < end, 'reply never reached SENDING');
  const sending = (await row("SELECT turn_id FROM hon.hon_reply_invocations WHERE organization_id=$1 AND status='SENDING'", [o.id])).turn_id;
  const base = { reply: 'x', inputTokens: 1, outputTokens: 1, providerCostMicrounits: 0 };
  const record = (result) => settle(tenant(context(o), (client) => client.query('SELECT hon.record_hon_reply_result($1,$2::uuid,$3::jsonb)', [o.subject, sending, JSON.stringify({ ...base, ...result })])));
  // Wrong shapes are refused: a list of more than three, a non-array, a non-string item; unknown, repeated or too many sources.
  for (const bad of [{ followUps: 'Why?' }, { followUps: ['a', 'b', 'c', 'd'].map((x) => `${x} question?`) }, { followUps: [1] }, { followUps: [null] },
    { sources: ['website'] }, { sources: ['revenue', 'revenue'] }, { sources: 'revenue' },
    { sources: ['newLeads24h', 'upcomingTrials24h', 'revenue', 'trialConversion', 'conversation', 'specialistResults'] }]) {
    assert.equal((await record(bad)).error?.code, '22023', `${JSON.stringify(bad)} refused`);
  }
  // Items that fail the text rule are hints, not evidence: dropped (never raised), so the answer and its usage are kept.
  // Lengths count code points and C1 controls fail, as in the API.
  const kept = await record({ followUps: ['\u{1F600}?', 'Next\u0085step?', 'Good question?'], sources: ['pendingActionApprovals'] });
  assert.equal(kept.error, undefined, String(kept.error));
  fakes.hon.complete(); fakes.hon.mode = 'RESULT';
  await pending; // The provider's late result finds the row already recorded: nothing is recorded twice.
  const s5 = await stored(sending);
  assert.deepEqual([s5.f, s5.c], [['Good question?'], ['pendingActionApprovals']]);
  const r5 = await hon.receipt(scope, sending);
  assert.deepEqual([r5.status, r5.replyDetail.followUps, r5.replyDetail.sources], ['COMPLETED', ['Good question?'], ['pendingActionApprovals']], JSON.stringify(r5));
  assert.equal((await row('SELECT count(*)::int n FROM hon.ai_usage_ledger WHERE source_invocation_id=(SELECT id FROM hon.hon_reply_invocations WHERE turn_id=$1)', [sending])).n, 1, 'one usage row');
  // The table refuses an invalid or repeated item written any other way.
  for (const bad of ['{"Hi"}', '{"Same?","Same?"}', `{"Next\u0085step?"}`]) {
    assert.equal((await settle(admin.query('UPDATE hon.hon_reply_invocations SET follow_up_questions=$2::text[] WHERE turn_id=$1', [sending, bad]))).error?.code, '23514', bad);
  }
  // 6. Claire may give follow-ups and cite metrics (never the conversation she is not sent).
  set(['What changed this month?'], ['conversation', 'outstandingWorkItems']);
  const c1 = await hon.sendTurn(scope, conv.id, { text: 'How is the school doing?', delegation: { agentKey: 'claire' } }, K());
  assert.deepEqual([c1.status, c1.replyDetail.followUps, c1.replyDetail.sources, c1.replyDetail.suggestions], ['COMPLETED', ['What changed this month?'], ['outstandingWorkItems'], []], JSON.stringify(c1));
  set([], []);
  pass('INV-32', '0254: follow-up questions (at most three, bounded plain text, unique) and cited sources (closed set, at most five, only fact areas the server recorded as sent: AVAILABLE metrics, the earlier conversation, group results) are stored with a whole answer only, shown only on a visible COMPLETED answer (concealed and cut-off answers show none; the table refuses others), malformed values are refused before any write, Claire may give them (no suggestions), and they add no provider call or usage beyond the answer');
  }

  // ---- INV-33 (0255): What HON remembers: school notes are saved on purpose, visible to every HON user, erasable ----
  {
  const o = await makeOrg('inv-33');
  const scope = { organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject };
  const hon = new HonConversationService(db, agents.marcus.service, agents.claire.service, agents.chad.service, new AiTeamReadinessService(db, fakes.marcus, fakes.claire, fakes.chad, fakes.hon), honReplies);
  const call = (fn, input, key = K()) => { const c = context(o); return tenant(c, (client) => client.query(`SELECT hon.${fn}($1,$2::jsonb,$3,$4::uuid,$5::uuid) r`, [o.subject, JSON.stringify(input), key, c.requestId, c.correlationId])).then((r) => r.rows[0].r); };
  const read = () => tenant(context(o), (client) => client.query('SELECT hon.read_hon_school_notes($1) r', [o.subject])).then((r) => r.rows[0].r);
  const code = async (p) => (await settle(p)).error?.code ?? 'OK';
  const drop = (c) => admin.query('DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code=$2', [o.role, c]);
  const add = (c) => admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [o.role, o.id, c]);
  const perm = await row("SELECT is_sensitive, is_staff_assignable FROM hon.permissions WHERE code='ai.school_notes.manage'");
  assert.deepEqual([perm.is_sensitive, perm.is_staff_assignable], [false, true], 'staff-assignable permission');
  // 1. A note is saved, listed for HON users, and replayed by key; a reused key with other input is refused.
  const key = K();
  const a = await call('add_hon_school_note', { text: 'We close the first week of August.' }, key);
  assert.deepEqual([a.replayed, a.record.note.text], [false, 'We close the first week of August.'], JSON.stringify(a));
  assert.equal((await call('add_hon_school_note', { text: 'We close the first week of August.' }, key)).replayed, true);
  assert.equal(await code(call('add_hon_school_note', { text: 'Something else entirely.' }, key)), '23505');
  const r1 = await read();
  assert.deepEqual([r1.notes.map((n) => n.text), r1.canManage, r1.limits], [['We close the first week of August.'], true, { maxNotes: 20, maxCharacters: 2000, noteCharacters: 200 }]);
  // 2. Never about a person, never a link: refused before any write.
  const before = (await row('SELECT count(*)::int n FROM hon.hon_school_notes WHERE organization_id=$1', [o.id])).n;
  for (const input of [{ text: 'Email coach@example.test for help' }, { text: 'Call 555 123 4567 after six' }, { text: 'Ring (555)123-4567' }, { text: 'See https://example.test' },
    { text: 'Visit www.example.test' }, { text: 'Use <b>bold</b>' }, { text: 'ab' }, { text: 'x'.repeat(201) }, { text: 'Two\nlines here' }, { text: ' padded note ' }, { text: 7 }, { text: 'ok note', extra: 1 }, {}]) {
    assert.equal(await code(call('add_hon_school_note', input)), '22023', JSON.stringify(input));
  }
  assert.equal((await row('SELECT count(*)::int n FROM hon.hon_school_notes WHERE organization_id=$1', [o.id])).n, before, 'nothing stored');
  // The rule is the contract's character for character: code points, C1 controls, line separators, Unicode spaces.
  for (const [text, ok] of [['\u{1F600}'.repeat(200), true], ['\u{1F600}'.repeat(201), false], ['Caf\u00e9 hours are 9 to 5.', true], ['Next\u0085step here', false],
    ['\u00a0padded note', false], ['padded note\u3000', false], ['Line\u2028break', false], ['555\u00a0123\u00a04567 is the line', false], ['mail a@b\u00a0x', false]]) {
    assert.equal((await row('SELECT hon.hon_school_note_ok($1) ok', [text])).ok, ok, JSON.stringify(text));
  }
  // 3. HON's context carries the notes (newest first) and may cite them; Claire's does not.
  await call('add_hon_school_note', { text: 'Kids classes are 45 minutes long.' });
  fakes.hon.mode = 'RESULT'; fakes.hon.ready = 'READY'; fakes.hon.suggestions = []; fakes.hon.followUps = []; fakes.hon.sources = ['schoolNotes'];
  const conv = await hon.create(scope, { title: 'Summer' }, K());
  const t1 = await hon.sendTurn(scope, conv.id, { text: 'When are we closed?', delegation: null }, K());
  assert.deepEqual(JSON.parse(fakes.hon.inputs.at(-1).facts).schoolNotes, ['Kids classes are 45 minutes long.', 'We close the first week of August.']);
  assert.deepEqual(t1.replyDetail.sources, ['schoolNotes']);
  await hon.sendTurn(scope, conv.id, { text: 'How is the school doing?', delegation: { agentKey: 'claire' } }, K());
  assert.equal(JSON.parse(fakes.hon.inputs.at(-1).facts).schoolNotes, undefined, 'Claire gets metrics only');
  // 4. Deleting erases the text at once (evidence keeps ids and times); HON no longer sees it; audit never holds text.
  const del = await call('delete_hon_school_note', { noteId: a.record.note.id });
  assert.deepEqual([del.replayed, del.record.noteId, del.record.deleted], [false, a.record.note.id, true]);
  const gone = await row('SELECT body, deleted_at IS NOT NULL d, deleted_by FROM hon.hon_school_notes WHERE id=$1', [a.record.note.id]);
  assert.deepEqual([gone.body, gone.d, gone.deleted_by], [null, true, o.principal]);
  assert.equal(await code(call('delete_hon_school_note', { noteId: a.record.note.id })), 'P0002', 'already deleted');
  assert.equal(await code(call('delete_hon_school_note', { noteId: K() })), 'P0002');
  assert.deepEqual((await read()).notes.map((n) => n.text), ['Kids classes are 45 minutes long.']);
  fakes.hon.sources = [];
  await hon.sendTurn(scope, conv.id, { text: 'Anything else?', delegation: null }, K());
  assert.deepEqual(JSON.parse(fakes.hon.inputs.at(-1).facts).schoolNotes, ['Kids classes are 45 minutes long.']);
  const leaked = (await row("SELECT count(*)::int n FROM hon.audit_events WHERE organization_id=$1 AND (coalesce(next_state::text,'') LIKE '%August%' OR coalesce(next_state::text,'') LIKE '%45 minutes%')", [o.id])).n;
  const outboxLeak = (await row("SELECT count(*)::int n FROM hon.outbox_events WHERE organization_id=$1 AND (payload::text LIKE '%August%' OR payload::text LIKE '%45 minutes%')", [o.id])).n;
  assert.deepEqual([leaked, outboxLeak], [0, 0], 'ids only in audit and outbox');
  assert.equal((await row("SELECT count(*)::int n FROM hon.audit_events WHERE organization_id=$1 AND action_code LIKE 'hon.school_note.%'", [o.id])).n, 3);
  // 5. Limits: at most 20 notes and 2,000 characters per school.
  for (let i = (await read()).notes.length; i < 20; i++) await call('add_hon_school_note', { text: `Note number ${String.fromCharCode(65 + i)} for the school.` });
  assert.equal(await code(call('add_hon_school_note', { text: 'One note too many.' })), '23514', 'at most 20');
  for (const n of (await read()).notes) await call('delete_hon_school_note', { noteId: n.id });
  for (let i = 0; i < 10; i++) await call('add_hon_school_note', { text: `${String.fromCharCode(65 + i)}${'a'.repeat(199)}` });
  assert.equal(await code(call('add_hon_school_note', { text: 'Too long now.' })), '23514', 'at most 2000 characters');
  // 6. Authority: manage needs ai.school_notes.manage; reading needs HON (ai.invocation.plan) or manage.
  await drop('ai.school_notes.manage');
  assert.equal(await code(call('add_hon_school_note', { text: 'Not allowed here.' })), '42501');
  assert.equal(await code(call('delete_hon_school_note', { noteId: (await read()).notes[0].id })), '42501');
  assert.equal((await read()).canManage, false);
  await drop('ai.invocation.plan');
  assert.equal(await code(read()), '42501');
  await add('ai.invocation.plan'); await add('ai.school_notes.manage');
  // 7. The tables are reached only through the three entry points; rows are never removed or rewritten except the erase.
  for (const t of ['hon_school_notes', 'hon_school_note_requests']) assert.equal((await row("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') p", [runtimeRole, `hon.${t}`])).p, false, t);
  for (const f of ['hon.read_hon_school_notes(text)', 'hon.add_hon_school_note(text,jsonb,text,uuid,uuid)', 'hon.delete_hon_school_note(text,jsonb,text,uuid,uuid)']) {
    assert.equal((await row("SELECT has_function_privilege($1,$2,'EXECUTE') p", [runtimeRole, f])).p, true, f);
  }
  const live = (await read()).notes[0].id;
  assert.equal((await settle(admin.query('DELETE FROM hon.hon_school_notes WHERE id=$1', [live]))).error?.code, '42501');
  assert.equal((await settle(admin.query("UPDATE hon.hon_school_notes SET body='Changed text here' WHERE id=$1", [live]))).error?.code, '42501');
  pass('INV-33', "0255: school notes are saved only by a human with ai.school_notes.manage (staff-assignable), listed for every HON user at the school, idempotent by key, refused when they look like a person's contact, a link or markup, limited to 20 notes and 2,000 characters, given to HON's context newest first and citable as schoolNotes (never to Claire), erased on delete (evidence keeps ids and times), audited and announced by id only, and reachable only through three runtime entry points");
  }

  // ---- INV-34 (0256): HON tone per school: the owner picks a closed key; HON and Kai receive it; Claire does not ----
  {
  const o = await makeOrg('inv-34');
  const scope = { organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject };
  const hon = new HonConversationService(db, agents.marcus.service, agents.claire.service, agents.chad.service, new AiTeamReadinessService(db, fakes.marcus, fakes.claire, fakes.chad, fakes.hon), honReplies);
  const set = (input, key = K()) => { const c = context(o); return tenant(c, (client) => client.query('SELECT hon.set_hon_school_tone($1,$2::jsonb,$3,$4::uuid,$5::uuid) r', [o.subject, JSON.stringify(input), key, c.requestId, c.correlationId])).then((r) => r.rows[0].r); };
  const read = () => tenant(context(o), (client) => client.query('SELECT hon.read_hon_school_tone($1) r', [o.subject])).then((r) => r.rows[0].r);
  const code = async (p) => (await settle(p)).error?.code ?? 'OK';
  const drop = (c) => admin.query('DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code=$2', [o.role, c]);
  const add = (c) => admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [o.role, o.id, c]);
  const perm = await row("SELECT is_sensitive, is_staff_assignable FROM hon.permissions WHERE code='ai.school_tone.manage'");
  assert.deepEqual([perm.is_sensitive, perm.is_staff_assignable], [false, false], 'owner-only permission');
  // 1. Default STANDARD; HON receives STANDARD.
  assert.deepEqual(await read(), { tone: 'STANDARD', canManage: true, updatedAt: null });
  fakes.hon.mode = 'RESULT'; fakes.hon.ready = 'READY'; fakes.hon.suggestions = []; fakes.hon.followUps = []; fakes.hon.sources = [];
  const conv = await hon.create(scope, { title: 'Tone' }, K());
  await hon.sendTurn(scope, conv.id, { text: 'How are leads?', delegation: null }, K());
  assert.equal(fakes.hon.inputs.at(-1).tone, 'STANDARD');
  // 2. Set, replay by key, reused key refused, same tone again is a no-op receipt; closed input only.
  const key = K();
  assert.deepEqual(await set({ tone: 'FRIENDLY_COACH' }, key), { tone: 'FRIENDLY_COACH', previousTone: 'STANDARD', replayed: false });
  assert.deepEqual(await set({ tone: 'FRIENDLY_COACH' }, key), { tone: 'FRIENDLY_COACH', previousTone: 'STANDARD', replayed: true });
  assert.equal(await code(set({ tone: 'FORMAL' }, key)), '23505');
  assert.deepEqual(await set({ tone: 'FRIENDLY_COACH' }), { tone: 'FRIENDLY_COACH', previousTone: 'FRIENDLY_COACH', replayed: false });
  for (const input of [{ tone: 'friendly_coach' }, { tone: 'PIRATE' }, { tone: 'FORMAL', extra: 1 }, {}, { tone: 7 }]) assert.equal(await code(set(input)), '22023', JSON.stringify(input));
  const r1 = await read();
  assert.deepEqual([r1.tone, r1.canManage, typeof r1.updatedAt], ['FRIENDLY_COACH', true, 'string']);
  // 3. HON and Kai receive the school's tone; Claire's analysis does not carry one.
  await hon.sendTurn(scope, conv.id, { text: 'How are trials?', delegation: null }, K());
  assert.equal(fakes.hon.inputs.at(-1).tone, 'FRIENDLY_COACH');
  await hon.sendTurn(scope, conv.id, { text: 'How is the school doing?', delegation: { agentKey: 'claire' } }, K());
  assert.equal(fakes.hon.inputs.at(-1).specialist, 'claire');
  assert.equal(fakes.hon.inputs.at(-1).tone, undefined, 'Claire keeps her own voice');
  fakes.claire.mode = 'RESULT';
  const nKai = fakes.claire.inputs.length;
  await agents.claire.service.submit(context(o), agents.claire.input(o));
  assert.equal(fakes.claire.inputs.length, nKai + 1, 'Kai called once');
  assert.equal(fakes.claire.inputs.at(-1).tone, 'FRIENDLY_COACH');
  // 4. Audit carries the keys only; the outbox is internal only.
  const audits = (await admin.query("SELECT next_state FROM hon.audit_events WHERE organization_id=$1 AND action_code='hon.school_tone.set' ORDER BY occurred_at", [o.id])).rows;
  assert.deepEqual(audits.map((a) => a.next_state), [{ tone: 'FRIENDLY_COACH', previousTone: 'STANDARD' }, { tone: 'FRIENDLY_COACH', previousTone: 'FRIENDLY_COACH' }]);
  assert.equal((await row("SELECT count(*)::int n FROM hon.outbox_events WHERE organization_id=$1 AND event_type='hon.school_tone.set' AND payload->>'internalOnly'='true'", [o.id])).n, 2);
  // 5. Authority: setting needs ai.school_tone.manage; reading needs HON, Kai or manage.
  await drop('ai.school_tone.manage');
  assert.equal(await code(set({ tone: 'FORMAL' })), '42501');
  assert.equal((await read()).canManage, false);
  await drop('ai.invocation.plan');
  assert.equal((await read()).tone, 'FRIENDLY_COACH', 'Kai users read it');
  await drop('teaching.assistant.use');
  assert.equal(await code(read()), '42501');
  await add('ai.invocation.plan'); await add('teaching.assistant.use'); await add('ai.school_tone.manage');
  // 6. Grants: runtime reaches the tables only through the three entry points; rows are never removed.
  for (const t of ['hon_school_tones', 'hon_school_tone_requests']) assert.equal((await row("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') p", [runtimeRole, `hon.${t}`])).p, false, t);
  for (const f of ['hon.read_hon_school_tone(text)', 'hon.set_hon_school_tone(text,jsonb,text,uuid,uuid)', 'hon.hon_ai_tone()']) assert.equal((await row("SELECT has_function_privilege($1,$2,'EXECUTE') p", [runtimeRole, f])).p, true, f);
  assert.equal((await settle(admin.query('DELETE FROM hon.hon_school_tones WHERE school_id=$1', [o.school]))).error?.code, '42501');
  assert.equal((await settle(admin.query('DELETE FROM hon.hon_school_tone_requests WHERE school_id=$1', [o.school]))).error?.code, '42501');
  assert.equal((await settle(admin.query("UPDATE hon.hon_school_tones SET tone='PIRATE' WHERE school_id=$1", [o.school]))).error?.code, '23514');
  pass('INV-34', "0256: each school's tone is a closed key (Standard by default) set only by a human with the owner-only ai.school_tone.manage, idempotent by key, audited with keys only, read by HON, Kai or manage users, sent to HON and Kai (never Claire), and reachable only through three runtime entry points");
  }

  // ---- INV-35 (0257): weekly briefing part 1: off by default, owner switch, "email me" for oneself, preview, no AI ----
  {
  const o = await makeOrg('inv-35');
  const call = (fn, input, key = K()) => { const c = context(o); return tenant(c, (client) => client.query(`SELECT hon.${fn}($1,$2::jsonb,$3,$4::uuid,$5::uuid) r`, [o.subject, JSON.stringify(input), key, c.requestId, c.correlationId])).then((r) => r.rows[0].r); };
  const read = () => tenant(context(o), (client) => client.query('SELECT hon.read_school_briefing($1) r', [o.subject])).then((r) => r.rows[0].r);
  const preview = () => tenant(context(o), (client) => client.query('SELECT hon.read_school_briefing_preview($1) r', [o.subject])).then((r) => r.rows[0].r);
  const code = async (p) => (await settle(p)).error?.code ?? 'OK';
  const drop = (c) => admin.query('DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code=$2', [o.role, c]);
  const add = (c) => admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [o.role, o.id, c]);
  const perm = await row("SELECT is_sensitive, is_staff_assignable FROM hon.permissions WHERE code='ai.school_briefing.manage'");
  assert.deepEqual([perm.is_sensitive, perm.is_staff_assignable], [false, false], 'owner-only permission');
  const calls0 = providerCalls;
  // 1. Off by default; nobody is subscribed.
  assert.deepEqual(await read(), { enabled: false, sendHour: 8, canManage: true, me: { email: false, canSubscribe: true } });
  // 2. Owner switch: replay by key, reused key refused, closed input.
  const key = K();
  const on = await call('set_school_briefing_settings', { enabled: true, sendHour: 7 }, key);
  assert.deepEqual([on.replayed, on.record.enabled, on.record.sendHour], [false, true, 7]);
  assert.equal((await call('set_school_briefing_settings', { enabled: true, sendHour: 7 }, key)).replayed, true);
  assert.equal(await code(call('set_school_briefing_settings', { enabled: false, sendHour: 7 }, key)), '23505');
  for (const input of [{ enabled: true, sendHour: 5 }, { enabled: true, sendHour: 12 }, { enabled: 'yes', sendHour: 8 }, { enabled: true }, { enabled: true, sendHour: 8, extra: 1 }, { enabled: true, sendHour: 8.5 }]) {
    assert.equal(await code(call('set_school_briefing_settings', input)), '22023', JSON.stringify(input));
  }
  // 3. Email me: for oneself only, closed input, replay.
  const me = await call('set_my_school_briefing', { email: true });
  assert.deepEqual(me.record.me, { email: true, canSubscribe: true });
  for (const input of [{ email: 'yes' }, { email: true, sms: true }, { sms: true }, {}]) assert.equal(await code(call('set_my_school_briefing', input)), '22023', JSON.stringify(input));
  assert.equal((await row('SELECT count(*)::int n FROM hon.school_briefing_subscriptions WHERE organization_id=$1 AND email_enabled', [o.id])).n, 1);
  // 4. Preview: fixed template over Command Center counts, the school name, how to stop; no provider call.
  const pv = await preview();
  assert.equal(pv.subject, 'HON weekly briefing: AI-0 synthetic school');
  assert.match(pv.text, /^New leads in the last 24 hours: \d+$/m);
  assert.match(pv.text, /Unanswered inquiries: not available yet/);
  assert.match(pv.text, /turn off "Email me" under Weekly briefing/);
  assert.doesNotMatch(pv.text, /Synthetic Lead|synthetic-lead@example\.test/, 'counts only, never names or addresses');
  assert.equal(providerCalls, calls0, 'no AI call');
  // 5. Audit and outbox carry values only (no address); the outbox is internal only.
  const audits = (await admin.query("SELECT action_code, next_state FROM hon.audit_events WHERE organization_id=$1 AND action_code LIKE 'hon.school_briefing.%' ORDER BY occurred_at", [o.id])).rows;
  assert.deepEqual(audits.map((a) => a.action_code), ['hon.school_briefing.settings', 'hon.school_briefing.me']);
  assert.doesNotMatch(JSON.stringify(audits), /@example\.test/);
  assert.equal((await row("SELECT count(*)::int n FROM hon.outbox_events WHERE organization_id=$1 AND event_type LIKE 'hon.school_briefing.%' AND payload->>'internalOnly'='true'", [o.id])).n, 2);
  // 6. Authority: settings need the owner permission; email me and the preview need reporting.view.
  await drop('ai.school_briefing.manage');
  assert.equal(await code(call('set_school_briefing_settings', { enabled: false, sendHour: 8 })), '42501');
  assert.equal((await read()).canManage, false);
  await drop('reporting.view');
  assert.deepEqual((await read()).me, { email: true, canSubscribe: false });
  assert.equal(await code(call('set_my_school_briefing', { email: true })), '42501');
  assert.equal(await code(preview()), '42501');
  assert.equal((await call('set_my_school_briefing', { email: false })).record.me.email, false, 'anyone may always turn their own email off');
  await drop('ai.invocation.plan');
  assert.equal(await code(read()), '42501');
  await add('ai.invocation.plan'); await add('reporting.view'); await add('ai.school_briefing.manage');
  // 7. Grants and guards: four runtime entry points (plus the read), tables never removed, values checked.
  for (const t of ['school_briefing_settings', 'school_briefing_subscriptions', 'school_briefing_requests']) assert.equal((await row("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') p", [runtimeRole, `hon.${t}`])).p, false, t);
  for (const f of ['hon.read_school_briefing(text)', 'hon.read_school_briefing_preview(text)', 'hon.set_school_briefing_settings(text,jsonb,text,uuid,uuid)', 'hon.set_my_school_briefing(text,jsonb,text,uuid,uuid)']) {
    assert.equal((await row("SELECT has_function_privilege($1,$2,'EXECUTE') p", [runtimeRole, f])).p, true, f);
  }
  assert.equal((await row("SELECT has_function_privilege($1,'hon.school_briefing_email(jsonb,text)','EXECUTE') p", [runtimeRole])).p, false);
  assert.equal((await settle(admin.query('DELETE FROM hon.school_briefing_settings WHERE school_id=$1', [o.school]))).error?.code, '42501');
  assert.equal((await settle(admin.query('UPDATE hon.school_briefing_settings SET send_hour=3 WHERE school_id=$1', [o.school]))).error?.code, '23514');
  assert.equal((await settle(admin.query('UPDATE hon.school_briefing_subscriptions SET sms_enabled=true WHERE school_id=$1', [o.school]))).error?.code, '23514', 'SMS is reserved for 0258');
  pass('INV-35', '0257: the weekly briefing is off by default, switched on and timed only by the owner (ai.school_briefing.manage), subscribed by email for oneself only with reporting.view (always possible to turn off), previewed from Command Center counts with no AI call and no names, audited without addresses, idempotent by key, and reachable only through four runtime entry points; SMS stays reserved for 0258');
  }

  // ---- INV-36 (0260): Alex, Jordan and Lena answer as read-only analysis specialists from their own facts ----
  {
  const o = await makeOrg('inv-36');
  const scope = { organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject };
  const hon = new HonConversationService(db, agents.marcus.service, agents.claire.service, agents.chad.service, new AiTeamReadinessService(db, fakes.marcus, fakes.claire, fakes.chad, fakes.hon), honReplies);
  const code = async (p) => { const r = await settle(p); return r.error?.getResponse?.().code ?? r.error?.code ?? r.error?.message ?? 'OK'; };
  const turnsOf = async (id) => (await row('SELECT count(*)::int n FROM hon.hon_conversation_turns WHERE conversation_id=$1', [id])).n;
  const drop = (perm) => admin.query('DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code=$2', [o.role, perm]);
  const add = (perm) => admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [o.role, o.id, perm]);
  const CAP = { alex: 'reporting.view', jordan: 'schedule.session.manage', lena: 'marketing.campaign.read' };
  // Synthetic aggregate facts: one scheduled class tomorrow with no instructor, one cancelled, one active campaign ending soon.
  const program = K();
  await admin.query("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'AI-0 synthetic program','SCHEDULED')", [program, o.id, o.school]);
  await admin.query("INSERT INTO hon.class_sessions(organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy) VALUES($1,$2,$3,'Synthetic class',clock_timestamp()+interval '1 day',clock_timestamp()+interval '1 day 1 hour',12,'WALK_IN')", [o.id, o.school, program]);
  await admin.query("INSERT INTO hon.class_sessions(organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy,status,cancellation_reason) VALUES($1,$2,$3,'Synthetic cancelled',clock_timestamp()+interval '2 days',clock_timestamp()+interval '2 days 1 hour',8,'WALK_IN','CANCELLED','Synthetic')", [o.id, o.school, program]);
  // (makeOrg already saved one DRAFT campaign; this one is activated through the guarded DRAFT -> ACTIVE path.)
  const camp = (await campaigns.save(context(o), null, { expectedVersion: 0, code: 'AI0INV36', name: 'Synthetic campaign', goal: 'Introduce beginner classes', offerLabel: '', channel: 'EMAIL',
    startsAt: new Date(Date.now() + 3_600_000).toISOString(), endsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), plannedBudgetMinor: 0, currency: 'USD' })).campaign;
  assert.equal((await campaigns.status(context(o), camp.id, { expectedVersion: camp.version, status: 'ACTIVE' })).campaign.status, 'ACTIVE');
  const conv = await hon.create(scope, { title: 'Ask the team' }, K());
  const ask = (agentKey, text = 'What should we look at this week?', key = K()) => hon.sendTurn(scope, conv.id, { text, delegation: { agentKey } }, key);
  fakes.hon.mode = 'RESULT'; fakes.hon.ready = 'READY'; fakes.hon.suggestions = [];
  await hon.sendTurn(scope, conv.id, { text: 'Earlier question for HON.', delegation: null }, K());
  const answered = {};
  for (const agent of ['alex', 'jordan', 'lena']) {
    // 1. One call each, planned as <agent>/ANALYZE (DETAILED budgets), own facts and the question only; resend replays.
    const before = { hon: fakes.hon.calls, specialists: fakes.marcus.calls + fakes.claire.calls + fakes.chad.calls };
    const key = K();
    const a = await ask(agent, `Question for ${agent}?`, key);
    assert.deepEqual([a.status, a.delegatedAgentKeys, a.reply, a.replyDetail.mode, a.replyDetail.step, a.replyDetail.canContinue, a.replyDetail.suggestions],
      ['COMPLETED', [agent], fakes.hon.reply, 'DETAILED', 1, false, []], `${agent}: ${JSON.stringify(a)}`);
    assert.deepEqual([fakes.hon.calls - before.hon, fakes.marcus.calls + fakes.claire.calls + fakes.chad.calls - before.specialists], [1, 0], `${agent}: one analysis call, no draft specialist`);
    const input = fakes.hon.inputs.at(-1);
    assert.deepEqual([input.specialist, input.replyMode, input.step, input.question], [agent, 'DETAILED', 1, `Question for ${agent}?`]);
    const facts = JSON.parse(input.facts);
    assert.deepEqual(Object.keys(facts), ['school'], `${agent}: own facts only, no conversation history or notes`);
    answered[agent] = { turn: a, facts: facts.school };
    const rec = await row(`SELECT r.specialist, r.used_reporting, r.source_permissions, p.agent_key, p.task_class, t.agent_key AS turn_agent FROM hon.hon_reply_invocations r
      JOIN hon.ai_invocation_plans p ON p.id = r.plan_id JOIN hon.hon_conversation_turns t ON t.id = r.turn_id WHERE r.turn_id=$1`, [a.turnId]);
    const perms = agent === 'alex' ? ['reporting.view', 'schedule.session.manage', 'marketing.campaign.read'] : [CAP[agent]];
    assert.deepEqual(rec, { specialist: agent, used_reporting: agent === 'alex', source_permissions: perms, agent_key: agent, task_class: 'ANALYZE', turn_agent: agent });
    assert.deepEqual(await ask(agent, `Question for ${agent}?`, key), a, `${agent}: resend replays`);
    assert.equal(fakes.hon.calls - before.hon, 1, `${agent}: no second call`);
  }
  // The facts are aggregate counts from this school only (no names, people or payment rows).
  const ops = answered.jordan.facts;
  assert.deepEqual([ops.availability, ops.next7Days.scheduledSessions, ops.next7Days.cancelledSessions, ops.next7Days.totalCapacity, ops.next7Days.sessionsWithoutInstructor, ops.next7Days.bookedSeats],
    ['AVAILABLE', 1, 1, 12, 1, 0], JSON.stringify(ops));
  const com = answered.lena.facts;
  assert.deepEqual([com.availability, com.campaigns.active, com.campaigns.activeEndingWithin14Days, com.membershipPlans.available, com.creativeStudioLast30Days.requests],
    ['AVAILABLE', 1, 1, 0, 0], JSON.stringify(com));
  assert.equal(com.campaigns.draft, 1, 'the makeOrg draft campaign');
  assert.deepEqual(Object.keys(answered.alex.facts).sort(), ['commandCenter', 'creativeCommerce', 'operations']);
  assert.deepEqual([answered.alex.facts.operations, answered.alex.facts.creativeCommerce], [ops, com], 'Alex sees the same sections when he holds their permissions');
  assert.doesNotMatch(JSON.stringify([ops, com]), /Synthetic class|Synthetic campaign|AI0INV36/, 'no record names leave the database');
  // HON's next answer sees each turn as that specialist's, never with their answer text.
  await hon.sendTurn(scope, conv.id, { text: 'And what next?', delegation: null }, K());
  assert.deepEqual(JSON.parse(fakes.hon.inputs.at(-1).facts).history.map((h) => h.delegatedTo ?? null).slice(-3), ['alex', 'jordan', 'lena']);
  assert.ok(JSON.parse(fakes.hon.inputs.at(-1).facts).history.slice(-3).every((h) => !('answer' in h)), 'no specialist text reaches HON');
  // 2. Without the capability each one is refused at begin and nothing is recorded.
  for (const agent of ['alex', 'jordan', 'lena']) {
    await drop(CAP[agent]);
    const n = await turnsOf(conv.id);
    try { assert.equal(await code(ask(agent)), 'HON_CONVERSATION_FORBIDDEN', `${agent} without ${CAP[agent]}`); } finally { await add(CAP[agent]); }
    assert.equal(await turnsOf(conv.id), n, `${agent}: refused before any turn`);
  }
  // 3. Alex without the operations or commerce permission: those sections are NOT_AUTHORIZED and not depended on.
  await drop('schedule.session.manage');
  try {
    const a = await ask('alex', 'Whole-school view without operations?');
    assert.equal(a.status, 'COMPLETED');
    const f = JSON.parse(fakes.hon.inputs.at(-1).facts).school;
    assert.deepEqual([f.operations, f.creativeCommerce.availability], [{ availability: 'NOT_AUTHORIZED' }, 'AVAILABLE']);
    assert.deepEqual((await row('SELECT source_permissions FROM hon.hon_reply_invocations WHERE turn_id=$1', [a.turnId])).source_permissions, ['reporting.view', 'marketing.campaign.read']);
  } finally { await add('schedule.session.manage'); }
  // 4. A lapse between begin and prepare: BLOCKED, nothing reserved, no call.
  for (const agent of ['jordan', 'lena']) {
    const begun = await tenant(context(o), (c) => c.query('SELECT hon.begin_hon_turn($1,$2,$3::jsonb,$4) d', [o.subject, conv.id, JSON.stringify({ text: 'Lapse?', delegation: { agentKey: agent } }), K()]));
    const turnId = begun.rows[0].d.turnId;
    const ref = (await tenant(context(o), (c) => c.query('SELECT hon.hon_reply_planning_reference($1,$2::uuid) d', [o.subject, turnId]))).rows[0].d;
    assert.deepEqual([ref.agentKey, ref.limits.replyMode, ref.limits.taskClass], [agent, 'DETAILED', 'ANALYZE']);
    const lim = ref.limits;
    const planned = await plans.plan({ ...context(o), idempotencyKey: ref.invocationId }, ref.workItemId, { expectedVersion: ref.workVersion, expectedState: 'READY', agentKey: agent, modality: 'TEXT', taskClass: lim.taskClass, inputBudget: lim.inputBudget, outputBudget: lim.outputBudget, maxProviderCostMicrounits: lim.maxProviderCostMicrounits });
    await drop(CAP[agent]);
    const calls = fakes.hon.calls;
    let prepared;
    try {
      prepared = await tenant(context(o), async (c) => { await c.query("SELECT set_config('app.hon_external_subject',$1,true)", [o.subject]); return (await c.query('SELECT hon.prepare_hon_reply($1,$2::uuid,$3::uuid,true) d', [o.subject, turnId, planned.plan.id])).rows[0].d; });
    } finally { await add(CAP[agent]); }
    const r = await row('SELECT status, reason, reserved_credits FROM hon.hon_reply_invocations WHERE turn_id=$1', [turnId]);
    assert.deepEqual([prepared, r.status, r.reason, r.reserved_credits, fakes.hon.calls - calls], [null, 'BLOCKED', 'SOURCE_ACCESS_REFUSED', 0, 0], agent);
  }
  // 5. A lapse after completion conceals the answer (each permission the facts used); usage evidence stays.
  for (const [agent, perm] of [['jordan', 'schedule.session.manage'], ['lena', 'marketing.campaign.read'], ['alex', 'reporting.view'], ['alex', 'schedule.session.manage']]) {
    await drop(perm);
    try {
      const hidden = (await hon.read(scope, conv.id)).turns.find((t) => t.turnId === answered[agent].turn.turnId && t.role === agent);
      assert.deepEqual([hidden.text, hidden.reason], [null, 'RESULT_CONCEALED'], `${agent} without ${perm}`);
    } finally { await add(perm); }
    assert.ok((await row('SELECT usage_id FROM hon.hon_reply_invocations WHERE turn_id=$1', [answered[agent].turn.turnId])).usage_id, 'usage evidence stays');
  }
  assert.equal((await hon.read(scope, conv.id)).turns.find((t) => t.turnId === answered.jordan.turn.turnId && t.role === 'jordan').text, fakes.hon.reply, 'shown again once restored');
  // 6. Never continued, confirmed from a suggestion, given a target, or empty.
  for (const [bad, expected] of [[{ text: 'x', delegation: { agentKey: 'jordan' }, fromSuggestionTurnId: answered.jordan.turn.turnId }, 'HON_SUGGESTION_NOT_CONFIRMABLE'],
    [{ text: 'Continue', delegation: null, continueTurnId: answered.lena.turn.turnId }, 'HON_REPLY_NOT_CONTINUABLE'],
    [{ text: 'Plan it', delegation: { agentKey: 'lena', campaignId: K() } }, 'HON_DELEGATION_REQUIRED'],
    [{ text: '  ', delegation: { agentKey: 'alex' } }, 'INVALID_HON_TURN']]) {
    assert.equal((await settle(tenant(context(o), (c) => c.query('SELECT hon.begin_hon_turn($1,$2,$3::jsonb,$4)', [o.subject, conv.id, JSON.stringify(bad), K()])))).error?.message, expected, JSON.stringify(bad));
  }
  // 7. Table and planner rules.
  assert.equal((await settle(admin.query("UPDATE hon.hon_reply_invocations SET reply_mode='STANDARD' WHERE turn_id=$1", [answered.jordan.turn.turnId]))).error?.code ?? 'OK', '23514');
  assert.equal((await settle(admin.query("UPDATE hon.hon_reply_invocations SET suggested_agents='{marcus}' WHERE turn_id=$1", [answered.lena.turn.turnId]))).error?.code ?? 'OK', '23514');
  assert.equal((await settle(admin.query("UPDATE hon.hon_reply_invocations SET source_permissions='{billing.membership.read}' WHERE turn_id=$1", [answered.alex.turn.turnId]))).error?.code ?? 'OK', '23514');
  assert.deepEqual((await row("SELECT hon.ai_agent_capability_permission('alex') a, hon.ai_agent_capability_permission('jordan') j, hon.ai_agent_capability_permission('lena') l")), { a: 'reporting.view', j: 'schedule.session.manage', l: 'marketing.campaign.read' });
  assert.equal((await row("SELECT count(*)::int n FROM pg_constraint WHERE conname='ai_invocation_plans_specialists_analysis_only' AND convalidated")).n, 1);
  for (const f of ['hon_school_operations_facts(uuid,uuid,timestamptz)', 'hon_school_creative_commerce_facts(uuid,uuid,timestamptz)', 'read_specialist_school_facts(text,text,uuid,uuid)']) {
    assert.equal((await row(`SELECT has_function_privilege($1, 'hon.${f}', 'EXECUTE') x`, [runtimeRole])).x, false, `${f} is internal`);
  }
  // 8. Readiness lists each with its own capability.
  const ready = (await new AiTeamReadinessService(db, fakes.marcus, fakes.claire, fakes.chad, fakes.hon).read(scope)).data.agents;
  assert.deepEqual(ready.filter((x) => ['alex', 'jordan', 'lena'].includes(x.agentKey)).map((x) => [x.agentKey, x.agent, x.authorized, x.requestCredits]),
    [['alex', 'GENERAL_MANAGEMENT', true, 15], ['jordan', 'OPERATIONS', true, 15], ['lena', 'CREATIVE_COMMERCE', true, 15]]);
  await drop('schedule.session.manage');
  try {
    const r8 = (await new AiTeamReadinessService(db, fakes.marcus, fakes.claire, fakes.chad, fakes.hon).read(scope)).data.agents;
    assert.deepEqual(['alex', 'jordan', 'lena'].map((k) => r8.find((x) => x.agentKey === k).blockedBy), [null, 'NOT_AUTHORIZED', null]);
  } finally { await add('schedule.session.manage'); }
  pass('INV-36', "0260: Alex (general management, reporting.view), Jordan (operations, schedule.session.manage) and Lena (creative & commerce, marketing.campaign.read) each answer a question in text from their own aggregate school facts (planned as <agent>/ANALYZE with the fixed DETAILED budgets, one call, no draft specialist, no history; resend replays; no record names); Alex's operations and commerce sections follow those permissions; each is refused at begin without its capability (nothing recorded) and blocked in prepare on a lapse (nothing reserved or sent); answers are concealed when any permission their facts used lapses while usage evidence stays; HON sees their turns without their text; never continued, confirmed from suggestions or given a target; rows are single DETAILED analyses, source permissions are a closed set, plans are ANALYZE only, the fact readers are internal; readiness lists GENERAL_MANAGEMENT, OPERATIONS and CREATIVE_COMMERCE gated on each capability");
  }

  // ---- INV-32 (R1, 0287): routing by task class through the HQ task profile ----
  {
  const o = await makeOrg('inv-32');
  const scope = { organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject };
  const hon = new HonConversationService(db, agents.marcus.service, agents.claire.service, agents.chad.service, new AiTeamReadinessService(db, fakes.marcus, fakes.claire, fakes.chad, fakes.hon), honReplies);
  fakes.hon.mode = 'RESULT'; fakes.hon.ready = 'READY'; fakes.hon.suggestions = [];
  const conv = await hon.create(scope, { title: 'Routing' }, K());
  // Five synthetic catalog models on this school's policy only (ordinals after the shared baseline model at 0).
  const m = {};
  for (const [name, cost, privacy] of [['standard', 1, []], ['detailed', 3, []], ['fallback', 1, ['NO_TRAINING', 'ZERO_RETENTION']], ['advanced', 1, []], ['business', 2, []]]) {
    m[name] = K();
    await admin.query("INSERT INTO hon.hq_ai_model_catalog(catalog_id,provider_id,model_id,display_name,capabilities,modalities,privacy_controls,active,minimum_tier,unit_cost_micros,cost_unit,effective_from) VALUES($1,'OPENROUTER',$2,'AI-0 routing model',ARRAY['TEXT'],ARRAY['TEXT'],$3,true,'COMPLETE',$4,'TOKEN','2020-01-01')", [m[name], `test/${name}`, privacy, cost]);
    await admin.query('INSERT INTO hon.hq_ai_routing_candidates(policy_id,ordinal,catalog_id) VALUES($1,(SELECT max(ordinal)+1 FROM hon.hq_ai_routing_candidates WHERE policy_id=$1),$2)', [o.policy, m[name]]);
  }
  const profile = async (agentKey, taskCategory, defaultId, fallbacks = [], advanced = null, patch = {}) => {
    const id = K();
    const p = { maxCostMicros: 80000, allowedProviderIds: ['OPENROUTER'], privacyControls: [], active: true, from: '2020-01-01', until: null, ...patch };
    await admin.query(`INSERT INTO hon.hq_ai_task_profiles(profile_id,routing_policy_id,agent_key,task_category,cost_unit,active,max_cost_micros,required_capabilities,required_modalities,allowed_provider_ids,privacy_controls,timeout_category,retry_category,effective_from,effective_until)
      VALUES($1,$2,$3,$4,'TOKEN',$5,$6,ARRAY['TEXT'],ARRAY['TEXT'],$7,$8,'STANDARD','NONE',$9,$10)`, [id, o.policy, agentKey, taskCategory, p.active, p.maxCostMicros, p.allowedProviderIds, p.privacyControls, p.from, p.until]);
    const cands = [['DEFAULT', 0, defaultId], ...fallbacks.map((f, i) => ['FALLBACK', i + 1, f]), ...(advanced ? [['ADVANCED', 0, advanced]] : [])];
    for (const [selection, ordinal, catalogId] of cands) await admin.query('INSERT INTO hon.hq_ai_task_profile_candidates(profile_id,routing_policy_id,selection,ordinal,catalog_id) VALUES($1,$2,$3,$4,$5)', [id, o.policy, selection, ordinal, catalogId]);
    return id;
  };
  const dropProfiles = async () => { await admin.query('DELETE FROM hon.hq_ai_task_profile_candidates WHERE routing_policy_id=$1', [o.policy]); await admin.query('DELETE FROM hon.hq_ai_task_profiles WHERE routing_policy_id=$1', [o.policy]); };
  const routed = async (turn) => row(`SELECT p.model_id, p.route_selection, p.task_profile_id, p.task_profile_version, r.status, r.reason FROM hon.hon_reply_invocations r
    LEFT JOIN hon.ai_invocation_plans p ON p.id = r.plan_id WHERE r.turn_id=$1`, [turn.turnId]);
  const ask = async (replyMode = 'STANDARD', extra = {}) => routed(await hon.sendTurn(scope, conv.id, { text: `Routing question ${K()}`, delegation: null, replyMode, ...extra }, K()));
  const callsBefore = fakes.hon.calls;
  // 1. No task profile: the legacy policy order (shared baseline model at ordinal 0), recorded as POLICY_ORDER.
  assert.deepEqual(await ask(), { model_id: 'approved/ai0-baseline', route_selection: 'POLICY_ORDER', task_profile_id: null, task_profile_version: null, status: 'COMPLETED', reason: null });
  // 2. HON Standard and HON Detailed each use their own profile's default.
  const std = await profile('hon', 'HON_STANDARD', m.standard, [m.fallback], m.advanced);
  const det = await profile('hon', 'HON_DETAILED', m.detailed, [m.standard]);
  assert.deepEqual(await ask('STANDARD'), { model_id: 'test/standard', route_selection: 'PROFILE_DEFAULT', task_profile_id: std, task_profile_version: 1, status: 'COMPLETED', reason: null });
  assert.deepEqual(await ask('DETAILED'), { model_id: 'test/detailed', route_selection: 'PROFILE_DEFAULT', task_profile_id: det, task_profile_version: 1, status: 'COMPLETED', reason: null });
  // 3. Claire's analysis routes by BUSINESS_PERFORMANCE, not by HON's Detailed profile.
  const bp = await profile('claire', 'BUSINESS_PERFORMANCE', m.business);
  assert.deepEqual(await routed(await hon.sendTurn(scope, conv.id, { text: 'How is retention?', delegation: { agentKey: 'claire' } }, K())),
    { model_id: 'test/business', route_selection: 'PROFILE_DEFAULT', task_profile_id: bp, task_profile_version: 1, status: 'COMPLETED', reason: null });
  // 4. Default ineligible -> the first eligible fallback (never the advanced model, never the policy order).
  const fallbackCases = [
    ['default catalog inactive', () => admin.query('UPDATE hon.hq_ai_model_catalog SET active=false WHERE catalog_id=$1', [m.standard]), () => admin.query('UPDATE hon.hq_ai_model_catalog SET active=true WHERE catalog_id=$1', [m.standard])],
    ['default over the profile cost ceiling', () => admin.query('UPDATE hon.hq_ai_model_catalog SET unit_cost_micros=9 WHERE catalog_id=$1', [m.standard]), () => admin.query('UPDATE hon.hq_ai_model_catalog SET unit_cost_micros=1 WHERE catalog_id=$1', [m.standard])],
    ['default lacks a required privacy control', () => admin.query("UPDATE hon.hq_ai_task_profiles SET privacy_controls=ARRAY['ZERO_RETENTION'] WHERE profile_id=$1", [std]), () => admin.query("UPDATE hon.hq_ai_task_profiles SET privacy_controls='{}' WHERE profile_id=$1", [std])],
  ];
  for (const [label, apply, undo] of fallbackCases) {
    await apply();
    try {
      assert.deepEqual(await ask('STANDARD'), { model_id: 'test/fallback', route_selection: 'PROFILE_FALLBACK', task_profile_id: std, task_profile_version: 1, status: 'COMPLETED', reason: null }, label);
    } finally { await undo(); }
  }
  // 5. A profile with no eligible candidate refuses the route: nothing planned, reserved or called (no escape to policy order).
  const refusals = [
    ['every candidate inactive', () => admin.query('UPDATE hon.hq_ai_model_catalog SET active=false WHERE catalog_id=ANY($1)', [[m.standard, m.fallback]]), () => admin.query('UPDATE hon.hq_ai_model_catalog SET active=true WHERE catalog_id=ANY($1)', [[m.standard, m.fallback]])],
    ['provider not allowed by the profile', () => admin.query("UPDATE hon.hq_ai_task_profiles SET allowed_provider_ids=ARRAY['DIRECT_LLM_API'] WHERE profile_id=$1", [std]), () => admin.query("UPDATE hon.hq_ai_task_profiles SET allowed_provider_ids=ARRAY['OPENROUTER'] WHERE profile_id=$1", [std])],
    ['profile ceiling below every candidate', () => admin.query('UPDATE hon.hq_ai_task_profiles SET max_cost_micros=100 WHERE profile_id=$1', [std]), () => admin.query('UPDATE hon.hq_ai_task_profiles SET max_cost_micros=80000 WHERE profile_id=$1', [std])],
    ['two active profiles for the same task', async () => { await profile('hon', 'HON_STANDARD', m.fallback); }, async () => {
      const extra = (await rows("SELECT profile_id FROM hon.hq_ai_task_profiles WHERE routing_policy_id=$1 AND task_category='HON_STANDARD' AND profile_id<>$2", [o.policy, std])).map((r) => r.profile_id);
      await admin.query('DELETE FROM hon.hq_ai_task_profile_candidates WHERE profile_id=ANY($1)', [extra]);
      await admin.query('DELETE FROM hon.hq_ai_task_profiles WHERE profile_id=ANY($1)', [extra]);
    }],
  ];
  for (const [label, apply, undo] of refusals) {
    await apply();
    const calls = fakes.hon.calls;
    try {
      assert.deepEqual(await ask('STANDARD'), { model_id: null, route_selection: null, task_profile_id: null, task_profile_version: null, status: 'BLOCKED', reason: 'NO_ELIGIBLE_ROUTE' }, label);
      assert.equal(fakes.hon.calls, calls, `${label}: no provider call`);
    } finally { await undo(); }
  }
  // 6. An inactive, expired or not-yet-effective profile is not a routing profile: the legacy order applies again.
  for (const [label, sql] of [['inactive', 'UPDATE hon.hq_ai_task_profiles SET active=false WHERE profile_id=$1'],
    ['expired', "UPDATE hon.hq_ai_task_profiles SET effective_from='2020-01-01', effective_until=clock_timestamp()-interval '1 minute' WHERE profile_id=$1"],
    ['future', "UPDATE hon.hq_ai_task_profiles SET effective_from=clock_timestamp()+interval '1 day', effective_until=NULL WHERE profile_id=$1"]]) {
    await admin.query(sql, [std]);
    assert.deepEqual(await ask('STANDARD'), { model_id: 'approved/ai0-baseline', route_selection: 'POLICY_ORDER', task_profile_id: null, task_profile_version: null, status: 'COMPLETED', reason: null }, label);
    await admin.query("UPDATE hon.hq_ai_task_profiles SET active=true, effective_from='2020-01-01', effective_until=NULL WHERE profile_id=$1", [std]);
  }
  // 7. The category is code-owned and closed; plan routing columns are as immutable as the rest of the plan.
  assert.deepEqual((await rows("SELECT a, t, hon.ai_route_task_category(a, t) c FROM (VALUES ('hon','SUMMARIZE'),('hon','ANALYZE'),('claire','ANALYZE'),('marcus','DRAFT_MARKETING'),('chad','DRAFT_FOLLOW_UP'),('kai','DRAFT_TEACHING'),('claire','DRAFT_TEACHING'),('hon','DRAFT_MARKETING'),('maya','SUMMARIZE')) v(a,t) ORDER BY 1,2")).map((r) => `${r.a}/${r.t}=${r.c}`),
    ['chad/DRAFT_FOLLOW_UP=CHAD_SALES', 'claire/ANALYZE=BUSINESS_PERFORMANCE', 'claire/DRAFT_TEACHING=null', 'hon/ANALYZE=HON_DETAILED', 'hon/DRAFT_MARKETING=null', 'hon/SUMMARIZE=HON_STANDARD', 'kai/DRAFT_TEACHING=KAI_TEACHING', 'marcus/DRAFT_MARKETING=MARCUS_MARKETING', 'maya/SUMMARIZE=null']);
  await assert.rejects(admin.query("UPDATE hon.ai_invocation_plans SET route_selection='POLICY_ORDER' WHERE task_profile_id=$1", [std]), /immutable/);
  // 8. The HQ owner can write a HON task profile through the reviewed HQ control plane (new agent keys and categories accepted).
  await dropProfiles();
  const hqProfile = K();
  const write = await row('SELECT hon.hq_ai_control_plane_write($1,$2,$3::jsonb,$4::uuid,$5::uuid) AS data', [hq.subject, 'TASK_PROFILE', JSON.stringify({
    profileId: hqProfile, routingPolicyId: o.policy, agentKey: 'hon', taskCategory: 'HON_STANDARD', costUnit: 'TOKEN', active: true, maxCostMicros: 80000,
    defaultCatalogId: m.standard, fallbackCatalogIds: [m.fallback], advancedCatalogId: null, requiredCapabilities: ['TEXT'], requiredModalities: ['TEXT'],
    allowedProviderIds: ['OPENROUTER'], privacyControls: [], timeoutCategory: 'STANDARD', retryCategory: 'NONE', effectiveFrom: '2020-01-01T00:00:00.000Z', effectiveUntil: null, expectedVersion: 0 }), K(), K()]);
  assert.equal(write.data.replayed ?? false, false, JSON.stringify(write.data));
  assert.deepEqual(await ask('STANDARD'), { model_id: 'test/standard', route_selection: 'PROFILE_DEFAULT', task_profile_id: hqProfile, task_profile_version: 1, status: 'COMPLETED', reason: null });
  assert.ok(fakes.hon.calls > callsBefore);
  pass('INV-32', 'R1: the planner routes by a code-owned task category (hon Standard/Detailed, Claire business performance, Marcus, Chad, Kai) through the single active effective HQ task profile on the school policy: its default, else the first eligible fallback (never advanced), each also inside the profile cost ceiling, provider list and privacy controls; no profile (or an inactive/expired/future one) keeps the legacy policy order; a profile with no eligible candidate or two active profiles refuse the route with no reservation or call; the profile and selection are recorded immutably on the plan; the HQ owner writes HON task profiles through the control plane');
  }

  // ---- INV-33 (R2, 0288): per-school internal AI cost ceiling, HQ levels and single-school pause ----
  {
  const o = await makeOrg('inv-33'), other = await makeOrg('inv-33-other');
  const scopeOf = (x) => ({ organizationId: x.id, schoolId: x.school, principalId: x.principal, externalSubject: x.subject });
  const conversations = new HonConversationService(db, agents.marcus.service, agents.claire.service, agents.chad.service, new AiTeamReadinessService(db, fakes.marcus, fakes.claire, fakes.chad, fakes.hon), honReplies);
  fakes.hon.mode = 'RESULT'; fakes.hon.ready = 'READY'; fakes.hon.suggestions = [];
  const convs = new Map();
  const ask = async (x = o) => {
    if (!convs.has(x.id)) convs.set(x.id, (await conversations.create(scopeOf(x), { title: 'Cost' }, K())).id);
    const turns = async () => (await row('SELECT count(*)::int n FROM hon.hon_conversation_turns WHERE conversation_id=$1', [convs.get(x.id)])).n;
    const n = await turns();
    const r = await settle(conversations.sendTurn(scopeOf(x), convs.get(x.id), { text: `Cost question ${K()}`, delegation: null }, K()));
    // A refusal at the turn's start records nothing (the existing S4 begin behavior for an HQ pause).
    if (r.error?.getResponse?.().code === 'HON_AI_SPEND_REFUSED') { assert.equal(await turns(), n, 'refused before any turn'); return { refused: r.error.getResponse().reason }; }
    if (r.error) throw r.error;
    return row('SELECT status, reason, reserved_credits::int AS reserved FROM hon.hon_reply_invocations WHERE turn_id=$1', [r.value.turnId]);
  };
  const committedCost = async (x = o) => Number((await row('SELECT hon.ai_school_committed_cost_micros($1,$2,clock_timestamp()) n', [x.id, x.school])).n);
  const cmdSql = 'SELECT hon.command_ai_school_cost_limit($1,$2::jsonb,$3::uuid) r';
  const limit = (patch = {}, x = o) => ({ schoolId: x.school, ceilingMicros: 15000000, paused: false, reason: 'Synthetic HQ cost limit change', expectedVersion: 0, ...patch });
  const command = async (input, key = K(), subject = hq.subject) => (await admin.query(cmdSql, [subject, JSON.stringify(input), key])).rows[0].r;
  const status = async (x = o) => (await row('SELECT hon.read_ai_school_cost_limits_from_hq($1) r', [hq.subject])).r.schools.find((s) => s.schoolId === x.school);
  const errCode = async (p) => { const r = await settle(p); return r.error ? `${r.error.code}:${r.error.message}` : 'OK'; };
  // 1. Default for a paying (non-trial) school: no ceiling (owner 2026-11-12: conversations are not capped), no record;
  //    a question completes and its verified cost (900) is counted. The $15 trial default is proven in the trial runtime
  //    proof (it needs a live trial).
  assert.deepEqual(await ask(), { status: 'COMPLETED', reason: null, reserved: 0 });
  assert.equal(await committedCost(), 900);
  let s = await status();
  assert.deepEqual([s.ceilingMicros, s.defaultCeiling, s.paused, s.version, s.recordedCostMicros, s.committedCostMicros, s.level, s.usedBasisPoints], [null, true, false, 0, 900, 900, 'NO_CEILING', null]);
  assert.equal(s.trial, false);
  assert.deepEqual((await rows('SELECT hon.ai_school_trial_default_ceiling_micros() t, hon.ai_school_default_ceiling_for($1,clock_timestamp()) o, hon.ai_school_cost_level(999999999,NULL) l', [o.id]))[0],
    { t: '15000000', o: null, l: 'NO_CEILING' });
  // 2. Levels: 75%, 90%, 100% of the ceiling (pure and as HQ reads them).
  assert.deepEqual((await rows('SELECT hon.ai_school_cost_level(c,1000) l FROM unnest(ARRAY[0,749,750,899,900,999,1000,5000]::bigint[]) c')).map((r) => r.l),
    ['NORMAL', 'NORMAL', 'WARNING_75', 'WARNING_75', 'WARNING_90', 'WARNING_90', 'CEILING_REACHED', 'CEILING_REACHED']);
  let v = (await command(limit({ ceilingMicros: 1200 }))).version;
  s = await status(); assert.deepEqual([s.level, s.usedBasisPoints, s.defaultCeiling, s.version], ['WARNING_75', 7500, false, 1]);
  v = (await command(limit({ ceilingMicros: 1000, expectedVersion: v }))).version;
  assert.equal((await status()).level, 'WARNING_90');
  // 3. Under the ceiling a question still runs; once the verified cost reaches it the next one is refused before any
  //    reservation or provider call (reason AI_PAUSED_BY_HQ), while another organization's school is unaffected.
  assert.deepEqual(await ask(), { status: 'COMPLETED', reason: null, reserved: 0 });
  assert.equal(await committedCost(), 1800);
  assert.equal((await status()).level, 'CEILING_REACHED');
  let calls = fakes.hon.calls;
  assert.deepEqual(await ask(), { refused: 'AI_PAUSED_BY_HQ' });
  assert.equal(fakes.hon.calls, calls, 'no provider call at the ceiling');
  const marcusRefusal = await settle(agents.marcus.service.submit(context(o), agents.marcus.input(o)));
  assert.equal(marcusRefusal.error?.getStatus?.(), 403, 'specialists are refused at begin too');
  assert.match(JSON.stringify(marcusRefusal.error.getResponse()), /AI_PAUSED_BY_HQ|FORBIDDEN|REFUSED/, JSON.stringify(marcusRefusal.error.getResponse()));
  assert.equal((await row('SELECT count(*)::int n FROM hon.marketing_ai_invocations WHERE organization_id=$1', [o.id])).n, 0, 'nothing recorded for the refused request');
  assert.deepEqual(await ask(other), { status: 'COMPLETED', reason: null, reserved: 0 });
  const readiness = await new AiTeamReadinessService(db, fakes.marcus, fakes.claire, fakes.chad, fakes.hon).read(scopeOf(o));
  assert.match(JSON.stringify(readiness), /AI_PAUSED_BY_HQ/, 'readiness reports the refusal');
  // 4. Raising the ceiling restores AI at once.
  v = (await command(limit({ ceilingMicros: 15000000, expectedVersion: v }))).version;
  assert.deepEqual(await ask(), { status: 'COMPLETED', reason: null, reserved: 0 });
  // 5. In-flight holds count at their plan maximum (80,000) until they are recorded.
  fakes.hon.mode = 'HOLD';
  const before = await committedCost();
  const pending = settle(ask());
  for (const end = Date.now() + 10000; (await row("SELECT count(*)::int n FROM hon.hon_reply_invocations WHERE organization_id=$1 AND status='SENDING'", [o.id])).n < 1; await sleep(20)) {
    if (Date.now() > end) throw new Error('INV-33: hold never started');
  }
  assert.equal(await committedCost(), before + 80000, 'a hold counts at its plan maximum');
  fakes.hon.complete(); fakes.hon.mode = 'RESULT';
  assert.equal((await pending).value.status, 'COMPLETED');
  assert.equal(await committedCost(), before + 900);
  // 6. Defense in depth: the reserve guard refuses a hold for a school at its ceiling even outside the prepare path.
  v = (await command(limit({ ceilingMicros: 0, expectedVersion: v }))).version;
  const raw = await row("SELECT id FROM hon.hon_reply_invocations WHERE organization_id=$1 AND status='COMPLETED' LIMIT 1", [o.id]);
  assert.match(await errCode(admin.query('UPDATE hon.hon_reply_invocations SET reserved_credits=reserved_credits+1 WHERE id=$1', [raw.id])), /AI_PAUSED_BY_HQ|immutable|IMMUTABLE/);
  // 7. Single-school pause (agent and creative classes) and resume, with the reason kept.
  v = (await command(limit({ ceilingMicros: 15000000, paused: true, reason: 'Synthetic school pause for review', expectedVersion: v }))).version;
  s = await status(); assert.deepEqual([s.paused, s.reason, s.version], [true, 'Synthetic school pause for review', v]);
  assert.deepEqual(await ask(), { refused: 'AI_PAUSED_BY_HQ' });
  assert.deepEqual((await row("SELECT set_config('app.hon_school_id',$2,true) x, hon.ai_spend_allowed($1,clock_timestamp(),'CREATIVE_MEDIA') c, hon.ai_spend_allowed($1,clock_timestamp(),'HQ_INTERNAL') h", [o.id, o.school])), { x: o.school, c: 'AI_PAUSED_BY_HQ', h: null });
  // The row's own school decides, with no session school (SaaS school paths forbid app.hon_school_id): the explicit
  // decision, the agent begin guard, the B3 credit reservation guard and the creative wallet reservation guard.
  const ownSchool = async () => {
    const d = await row("SELECT coalesce(current_setting('app.hon_school_id',true),'') x, hon.ai_spend_allowed($1,$2::uuid,clock_timestamp(),'CREATIVE_MEDIA') c, hon.ai_spend_allowed($1,$2::uuid,clock_timestamp(),'HQ_INTERNAL') h", [o.id, o.school]);
    const out = [d.x, d.c, d.h];
    for (const table of ['marketing_ai_invocations', 'saas_credit_reservations', 'saas_creative_reservations'])
      out.push(await errCode(admin.query(`INSERT INTO hon.${table}(organization_id, school_id) VALUES ($1,$2)`, [o.id, o.school])));
    return out;
  };
  assert.deepEqual(await ownSchool(), ['', 'AI_PAUSED_BY_HQ', null, '42501:AI_PAUSED_BY_HQ', '42501:AI_PAUSED_BY_HQ', '23514:SAAS_CREATIVE_AI_PAUSED_BY_HQ']);
  v = (await command(limit({ paused: false, expectedVersion: v }))).version;
  assert.deepEqual(await ask(), { status: 'COMPLETED', reason: null, reserved: 0 });
  const resumed = await ownSchool();
  assert.deepEqual(resumed.slice(0, 3), ['', null, null]);
  for (const e of resumed.slice(3)) assert.doesNotMatch(e, /PAUSED_BY_HQ/, 'a resumed school passes the guards (the bare row then fails its own constraints)');
  // 8. The command: HQ owner only, exact shape, versioned, idempotent; its log and the limits are immutable.
  assert.equal(await errCode(command(limit({ expectedVersion: v }), K(), o.subject)), '42501:SAAS_FORBIDDEN');
  assert.equal(await errCode(command(limit({ expectedVersion: v - 1 }))), '40001:SAAS_VERSION_CONFLICT');
  for (const bad of [{ reason: 'short' }, { ceilingMicros: -1 }, { ceilingMicros: 1000000001 }, { ceilingMicros: 1.5 }, { paused: 'no' }, { schoolId: 'school' }, { organizationId: o.id }])
    assert.match(await errCode(command(limit({ expectedVersion: v, ...bad }))), /^22023:/, JSON.stringify(bad));
  assert.equal(await errCode(command(limit({ schoolId: K(), expectedVersion: 0 }))), 'P0002:AI_SCHOOL_NOT_FOUND');
  const key = K(), input = limit({ ceilingMicros: 14000000, expectedVersion: v });
  const first = await command(input, key);
  assert.deepEqual(await command(input, key), { ...first, replayed: true });
  assert.equal(await errCode(command({ ...input, ceilingMicros: 13000000 }, key)), '23505:AI_SCHOOL_COST_LIMIT_KEY_REUSED');
  assert.equal((await row('SELECT count(*)::int n FROM hon.ai_school_cost_limit_commands WHERE school_id=$1', [o.school])).n, 7);
  assert.match(await errCode(admin.query('DELETE FROM hon.ai_school_cost_limit_commands WHERE school_id=$1', [o.school])), /IMMUTABLE/);
  assert.match(await errCode(admin.query('DELETE FROM hon.ai_school_cost_limits WHERE school_id=$1', [o.school])), /IMMUTABLE/);
  assert.match(await errCode(admin.query('UPDATE hon.ai_school_cost_limits SET paused=true WHERE school_id=$1', [o.school])), /IMMUTABLE/, 'only the command bumps the version');
  // 9. Only the two HQ entry points reach the runtime; the helpers and tables do not.
  const acl = await rows(`SELECT p.oid::regprocedure::text f, has_function_privilege($1,p.oid,'EXECUTE') x FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace
    AND p.proname IN ('command_ai_school_cost_limit','read_ai_school_cost_limits_from_hq','ai_school_spend_decision','ai_school_committed_cost_micros','ai_org_spend_allowed','ai_school_cost_level') ORDER BY 1`, [runtimeRole]);
  assert.deepEqual(acl.map((a) => `${a.f}=${a.x}`), ['hon.ai_org_spend_allowed(uuid,timestamp with time zone,text)=false', 'hon.ai_school_committed_cost_micros(uuid,uuid,timestamp with time zone)=false',
    'hon.ai_school_cost_level(bigint,bigint)=false', 'hon.ai_school_spend_decision(uuid,uuid,timestamp with time zone,text)=false',
    'hon.command_ai_school_cost_limit(text,jsonb,uuid)=true', 'hon.read_ai_school_cost_limits_from_hq(text)=true']);
  assert.equal((await row("SELECT has_table_privilege($1,'hon.ai_school_cost_limits','SELECT') OR has_table_privilege($1,'hon.ai_school_cost_limit_commands','SELECT') x", [runtimeRole])).x, false);
  pass('INV-33', 'R2: each school may have an internal monthly agent-AI cost ceiling (none by default for a paying school, $15 on a live trial, HQ-owner editable, versioned, idempotent, immutable command log) counted as verified ledger cost plus every counting hold at its plan maximum; HQ reads NO_CEILING/NORMAL/WARNING_75/WARNING_90/CEILING_REACHED per school; at the ceiling new work is refused before any reservation or provider call (HON prepare, specialist begin, readiness, reserve guard) as AI_PAUSED_BY_HQ while other schools are unaffected and a raised ceiling restores it at once; an HQ single-school pause covers agent and creative AI; only the HQ command and read reach the runtime');
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
