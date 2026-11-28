import pg from 'pg';
import { CHAMPIONS_OWNER_ROLE, CHAMPIONS_RUNTIME_ROLE, championsProofTargets, verifyChampionsProofConnection } from './champions-proof-target.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// 0690: AI website edits paid from the school's creative credits (CW1 wallet, 0202) when the school can use them, and from
// included AI exactly as in 0550 when it cannot (unpaid schools, the program off, no published rate). A free-trial school
// (0683) is eligible and pays from its own 1,500-credit TRIAL lot (owner decision 2026-11-24, W16). Real
// database, restricted runtime role, the real API services and a counted in-process fake provider (fetch is refused).
// DISPOSABLE DATABASE ONLY, TEST MODE, SIMULATED payments. Each check runs on its own so one failure never hides another.
await import('./test-champions-proof-target.mjs');
const targets = championsProofTargets(process.env);
if (Object.keys(process.env).some((key) => /^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key))) throw new Error('Provider credentials/execution switches are forbidden.');
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls += 1; throw new Error('EXTERNAL_NETWORK_FORBIDDEN'); };
process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
process.env.HON_RUNTIME_DATABASE_POOL_MAX = '12';
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { SaasBillingService } = await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const { SaasCreativeWalletService } = await import('../../../apps/api/dist/saas-billing/saas-creative-wallet.service.js');
const { SaasPaymentsService } = await import('../../../apps/api/dist/payments/saas-payments.service.js');
const { StripeTestModeAdapter } = await import('../../../apps/api/dist/payments/stripe-test-mode-adapter.js');
const { StripeSimulator } = await import('../../../apps/api/dist/payments/stripe-simulator.js');
const { AiInvocationPlanService } = await import('../../../apps/api/dist/ai/ai-invocation-plan.service.js');
const { SchoolWebsiteService } = await import('../../../apps/api/dist/website/school-website.service.js');
const { WebsiteAiService } = await import('../../../apps/api/dist/website/website-ai.service.js');
const { DesignDraftService } = await import('../../../apps/api/dist/creative-studio/design-draft.service.js');
const { WebsiteProviderRuntimeError } = await import('../../../apps/api/dist/ai/website-provider-runtime.js');
const contracts = await import('@hon/contracts');
const { SaasTrialsService } = await import('../../../apps/api/dist/saas-trials/saas-trials.service.js');
const { trialTerms, trialDefinition, trialApproval, trialPromoLimits, trialPromoBudget } = await import('./trial-governance-fixture.mjs');
const SECRET = 'whsec_disposableFixtureSecret0123456789', KEY = 'sk_test_disposableFixtureKey0123456789';
const sim = new StripeSimulator(SECRET);
const database = new RuntimeDatabaseService(), billing = new SaasBillingService(database), wallet = new SaasCreativeWalletService(billing);
const payments = new SaasPaymentsService(billing, database, new StripeTestModeAdapter({ secretKey: KEY, webhookSecret: SECRET, provider: 'STRIPE_SIMULATED', transport: sim.transport }));
const fake = { calls: 0, mode: 'OK', answer: null, hold: null };
const provider = {
  readiness: () => 'READY',
  generate: async () => {
    fake.calls += 1;
    if (fake.hold) await (typeof fake.hold === 'function' ? fake.hold() : fake.hold);
    if (fake.mode === 'UNKNOWN') throw new WebsiteProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
    if (fake.mode === 'FAILED') throw new WebsiteProviderRuntimeError('FAILED', 'PROVIDER_REJECTED');
    return { proposal: fake.answer, inputTokens: 900, outputTokens: 200, providerCostMicrounits: 1100 };
  },
};
const plans = new AiInvocationPlanService(database), sites = new SchoolWebsiteService(database), ai = new WebsiteAiService(database, plans, provider);
// 0706: AI designs (0705) on the same creative-credit path, with their own counted fake answer.
const designFake = { calls: 0 };
const designs = new DesignDraftService(database, plans, { readiness: () => 'READY', generate: async () => { designFake.calls += 1; fake.calls += 1;
  return { proposal: { options: [{ theme: 'camp', style: 'bold', words: { kicker: 'AGES 5 TO 12', head: 'SUMMER\nCAMP', sub: 'Weekly sessions', details: '', cta: 'Sign up now' }, schedule: null }] }, inputTokens: 700, outputTokens: 300, providerCostMicrounits: 800 }; } });
const askDesign = (k) => designs.request(ctx(k), { brief: 'Summer camp flyer for kids', size: 'FLYER_LETTER', language: 'en' });
const admin = new pg.Client(targets.owner);
const K = () => randomUUID(), iso = (d) => new Date(d).toISOString(), NOW = Date.now(), HOUR = 3600_000;
const humans = Object.fromEntries(['owner', 'ownerA', 'ownerB', 'ownerU'].map((k) => [k, { id: K(), user: K(), subject: `w670-${k}-${K()}` }]));
const H = (k) => humans[k].subject;
const S = {}, catalog = K();
const row = async (sql, params) => (await admin.query(sql, params)).rows[0];
const rows = async (sql, params) => (await admin.query(sql, params)).rows;
const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));
const goodAnswer = { summary: 'A warmer welcome.', edits: [{ op: 'setText', page: 'home', section: 'hero', prop: 'heading', value: 'Welcome to Synthetic Dojo' }] };
const badAnswer = { summary: 'Off the list.', edits: [{ op: 'setImage', page: 'home', section: 'hero', prop: 'image', value: 'x' }] };
const RATE = 5, DESIGN_RATE = 2;
const ctx = (k, patch = {}) => ({ organizationId: S[`org${k}`], schoolId: S[k], principalId: humans[`owner${k}`].id, externalSubject: H(`owner${k}`), principalType: 'HUMAN_USER',
  source: 'HUMAN_UI', requestId: K(), correlationId: K(), idempotencyKey: K(), ...patch });
const readCtx = (k) => ctx(k, { idempotencyKey: '' });
const draftRevision = async (k) => (await sites.read(readCtx(k))).website.draftRevision;
const ask = async (k, text = 'Make the welcome warmer', patch = {}) => ai.request(ctx(k, patch), { expectedRevision: await draftRevision(k), request: text });
const balance = async (k) => row("SELECT (b->>'availableCredits')::int available, (b->>'heldCredits')::int held FROM hon.saas_creative_balance_json($1, clock_timestamp()) b", [S[k]]);
const linkOf = (id) => row('SELECT x.* FROM hon.ai_text_creative_reservations c JOIN hon.saas_creative_reservations x ON x.id=c.reservation_id WHERE c.proposal_id=$1', [id]);
const usageOf = (id) => rows('SELECT customer_credits::int c, provider_cost_microunits::bigint cost, spend_class, modality FROM hon.ai_usage_ledger WHERE source_invocation_id=$1', [id]);
const pause = (action, organizationId, spendClass) => admin.query('SELECT hon.command_ai_spend_pause($1,$2::jsonb,$3) r', [H('owner'), JSON.stringify({ action, organizationId, spendClass, reason: 'Fixture emergency pause for the 0690 proof' }), K()]);
const results = [];
async function check(id, title, fn) {
  try { await fn(); results.push([id, 'PASS', title]); console.log(`PASS ${id}: ${title}`); }
  catch (e) { results.push([id, 'FAIL', title]); console.log(`FAIL ${id}: ${title}\n  ${String(e?.stack ?? e).split('\n').slice(0, 8).join('\n  ')}`); }
}
const details = (k) => ({ legalName: `W670 Fixture Dojo ${k} LLC`, displayName: `W670 Dojo ${k}`, schoolName: `W670 Dojo ${k} Main`, schoolSlug: `w670-dojo-${k.toLowerCase()}`, timezone: 'America/Chicago' });
const register = (who, p) => admin.query('SELECT hon.initialize_saas_hon_os_school_account($1,$2::jsonb,$3,$4,$5) r', [H(who), JSON.stringify(p), K(), K(), K()]).then((r) => r.rows[0].r);
const offer = (code, kind, priceMinor, displayName) => {
  const interval = contracts.saasHonOsOfferBillingInterval(kind);
  return { offerCode: code, offerKind: kind, displayName, priceMinor, salesOpensAt: iso(NOW - HOUR), salesClosesAt: null, eligibility: 'ANY_ACTIVE_ORGANIZATION', saleLimit: null,
    priceLock: 'WHILE_CONTINUOUSLY_SUBSCRIBED', priceLockMonths: null, annualRenewal: interval === 'ANNUAL' ? 'AUTO_RENEW_AT_LOCKED_PRICE' : null, plannedMonthlyPremiumCredits: 12000,
    aiFairUseReference: null, refundWindowDays: 30, cancellationTiming: 'END_OF_PAID_PERIOD' };
};
async function setAccessProgram(active) {
  await admin.query('BEGIN');
  await admin.query('ALTER TABLE hon.saas_access_program DISABLE TRIGGER USER');
  if (active) { await admin.query('ALTER TABLE hon.saas_access_program DROP CONSTRAINT IF EXISTS saas_access_program_status_check'); await admin.query("UPDATE hon.saas_access_program SET status='ACTIVE'"); }
  else {
    await admin.query("UPDATE hon.saas_access_program SET status='INACTIVE'");
    if (!(await admin.query("SELECT 1 FROM pg_constraint WHERE conname='saas_access_program_status_check' AND conrelid='hon.saas_access_program'::regclass")).rowCount)
      await admin.query("ALTER TABLE hon.saas_access_program ADD CONSTRAINT saas_access_program_status_check CHECK (status = 'INACTIVE')");
  }
  await admin.query('ALTER TABLE hon.saas_access_program ENABLE TRIGGER USER');
  await admin.query('COMMIT');
}
/** The website and the routing every school needs (WB5 shape). */
async function website(k) {
  const policy = K();
  await admin.query("INSERT INTO hon.hq_ai_routing_policies(policy_id,organization_id,school_id,capability,active,minimum_tier,max_cost_micros,effective_from) VALUES($1,$2,$3,'TEXT',true,'COMPLETE',150000,'2020-01-01')", [policy, S[`org${k}`], S[k]]);
  await admin.query('INSERT INTO hon.hq_ai_routing_candidates(policy_id,ordinal,catalog_id) VALUES($1,0,$2)', [policy, catalog]);
  await sites.mutate(ctx(k), 'create', { publicSlug: `w670-${k.toLowerCase()}-${S[k].slice(0, 8)}`, name: 'Synthetic Dojo', document: contracts.buildWebsiteFromTemplate('MODERN_CLEAN', { schoolName: 'Synthetic Dojo' }) });
}

await admin.connect();
await verifyChampionsProofConnection(admin, CHAMPIONS_OWNER_ROLE);
await verifyChampionsProofConnection({ query: (...a) => database['getPool']().query(...a) }, CHAMPIONS_RUNTIME_ROLE);
try {
  assert.equal((await row("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).m, 'HON disposable Champions Club validation');
  assert.equal((await row('SELECT count(*)::int n FROM hon.saas_creative_reservations')).n, 0, 'run on a freshly set up fixture');
  // ---------- fixture: two paid HON OS organizations (A, B) and one unpaid Complete organization (U) ----------
  await admin.query('BEGIN');
  for (const h of Object.values(humans)) {
    await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')", [h.user, h.subject, `${h.user}@example.test`]);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)", [h.id, h.user]);
  }
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER','{}',clock_timestamp()-interval '1 hour')", [humans.owner.id]);
  await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state) VALUES('HIGGSFIELD','Fixture image provider','DISABLED') ON CONFLICT DO NOTHING");
  await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state,credential_secret_ref) VALUES('OPENROUTER','W670 synthetic route','HEALTHY',$1)", [`hon-secret:${K()}`]);
  await admin.query("INSERT INTO hon.hq_ai_model_catalog(catalog_id,provider_id,model_id,display_name,capabilities,modalities,active,minimum_tier,unit_cost_micros,cost_unit,effective_from) VALUES($1,'OPENROUTER','approved/w670-synthetic','W670 synthetic model',ARRAY['TEXT'],ARRAY['TEXT'],true,'COMPLETE',2,'TOKEN','2020-01-01')", [catalog]);
  await admin.query('COMMIT');
  const d = structuredClone(contracts.SAAS_OWNER_APPROVED_DRAFT);
  d.termsReference = 'Fixture HON plan terms (not customer terms)';
  d.founderProgram = { ...d.founderProgram, eligibility: 'ANY_ACTIVE_ORGANIZATION', opensAt: iso(NOW - HOUR) };
  await billing.publishCatalog(H('owner'), (await billing.createCatalogDraft(H('owner'), d, K())).catalog.catalogId, K());
  const pub = await billing.publishOfferSet(H('owner'), ...await (async () => {
    const dr = await billing.createOfferSetDraft(H('owner'), { basedOnSetId: null, termsReference: 'Fixture HON OS terms v1 (not customer terms)', founderTotalLimit: 3,
      offers: [offer('OS_MONTHLY', 'REGULAR_MONTHLY', 24900, 'Monthly')] }, K());
    return [dr.set.setId, { expectedRevision: dr.set.revision, previewDigest: dr.preview.previewDigest, approval: contracts.SAAS_HON_OS_OFFER_PUBLISH_APPROVAL }, K()];
  })());
  await payments.setPaymentProgram(H('owner'), { action: 'ENABLE_TEST_MODE', expectedVersion: 1, authorizationReference: 'Fixture owner test-mode authorization (disposable)',
    provider: 'STRIPE_SIMULATED', testTaxReference: 'TEST MODE: no tax collected; TAXES undecided (fixture)' }, K());
  await setAccessProgram(true);
  for (const k of ['A', 'B']) {
    const r = await register(`owner${k}`, details(k)); S[`org${k}`] = r.organizationId; S[k] = r.schoolId;
    const co = await payments.startSchoolHonOsCheckout(H(`owner${k}`), r.schoolId, { offerId: pub.set.offers[0].offerId }, K());
    const done = sim.completeCheckout(co.checkout.providerSessionId).completed;
    assert.deepEqual([(await payments.handleWebhook(done.raw, done.signature)).event.detail], ['ACCESS_ACTIVATED'], `${k} paid`);
  }
  // U: an active Complete organization with no HON OS subscription (a trial or unpaid school).
  S.orgU = K(); S.U = K(); const roleU = K();
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'W670 unpaid organization','W670 unpaid organization')", [S.orgU]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'W670 unpaid school',$1::uuid::text,'UTC')", [S.U, S.orgU]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day')", [S.orgU]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','W670 unpaid owner',true)", [roleU, S.orgU]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions', [roleU, S.orgU]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')", [S.orgU, S.U, humans.ownerU.id, roleU]);
  await admin.query('COMMIT');
  for (const k of ['A', 'B', 'U']) await website(k);
  fake.answer = goodAnswer;

  await check('W1', 'custody: both new tables forced deny-all RLS with no runtime privilege; the runtime executes the price read and none of the private helpers; the registry is fixed', async () => {
    for (const t of ['hon.ai_text_creative_billing', 'hon.ai_text_creative_reservations']) {
      const c = await row('SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE oid=$1::regclass', [t]); assert(c.r && c.f, t);
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) assert.equal((await row('SELECT has_table_privilege($1,$2,$3) ok', [CHAMPIONS_RUNTIME_ROLE, t, p])).ok, false, t + p);
    }
    for (const [f, ok] of [['hon.read_school_website_ai_price(text)', true], ['hon.ai_text_creative_reserve(hon.ai_text_proposals,hon.ai_invocation_plans)', false],
      ['hon.ai_text_creative_applies(hon.ai_text_proposals,timestamptz)', false], ['hon.ai_text_creative_settle()', false]])
      assert.equal((await row("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [CHAMPIONS_RUNTIME_ROLE, f])).ok, ok, f);
    assert.deepEqual(await rows('SELECT kind, operation_code FROM hon.ai_text_creative_billing ORDER BY kind'), [{ kind: 'DESIGN_DRAFT', operation_code: 'design.generate' }, { kind: 'WEBSITE_EDIT', operation_code: 'website.edit' }]);
    assert.equal((await row("SELECT has_function_privilege($1,'hon.read_design_draft_price(text)','EXECUTE') ok", [CHAMPIONS_RUNTIME_ROLE])).ok, true);
    await assert.rejects(admin.query("UPDATE hon.ai_text_creative_billing SET operation_code='image.generate'"));
  });

  await check('W2', 'not priced, program off: every school asks on included AI exactly as in 0550 (credits counted, no reservation), and the price says so', async () => {
    for (const k of ['A', 'U']) assert.deepEqual(await ai.price(readCtx(k)), { paidWith: 'INCLUDED_AI', creditsPerEdit: null, availableCredits: null });
    for (const k of ['A', 'U']) assert.deepEqual(await designs.price(readCtx(k)), { paidWith: 'INCLUDED_AI', creditsPerDesign: null, availableCredits: null });
    const before = fake.calls;
    const v = await ask('A');
    assert.equal(v.status, 'RESULT_RECORDED'); assert.equal(fake.calls, before + 1);
    assert.equal(await linkOf(v.id), undefined);
    assert.deepEqual(await usageOf(v.id), [{ c: 2, cost: '1100', spend_class: 'AGENT_INFERENCE', modality: 'TEXT' }]);
    await ai.dismiss(ctx('A'), v.id);
  });

  // HQ publishes the website rate (per REQUEST, one unit, provisional) and switches the creative program on.
  await check('W3', 'HQ rate publishing accepts WEBSITE only as one provisional REQUEST, and the public CW1 reserve refuses a website reservation', async () => {
    const base = { operationCode: 'website.edit', mediaKind: 'WEBSITE', displayName: 'AI website edit', billingUnit: 'REQUEST', creditsPerUnit: RATE, maxUnitsPerRequest: 1, costEvidenceId: null };
    for (const bad of [{ ...base, maxUnitsPerRequest: 2 }, { ...base, billingUnit: 'IMAGE' }, { ...base, costEvidenceId: K() }])
      assert.throws(() => contracts.validateSaasCreativeRatesInput({ termsReference: 'Fixture', rates: [bad] }));
    await assert.rejects(admin.query("SELECT hon.publish_saas_creative_rates($1,$2::jsonb,$3,$4,$5)", [H('owner'), JSON.stringify({ termsReference: 'Fixture', rates: [{ ...base, maxUnitsPerRequest: 2 }] }), K(), K(), K()]));
    await wallet.publishRates(H('owner'), { termsReference: 'Fixture provisional creative rates (not final prices)', rates: [
      { operationCode: 'image.generate', mediaKind: 'IMAGE', displayName: 'AI image', billingUnit: 'IMAGE', creditsPerUnit: 10, maxUnitsPerRequest: 8, costEvidenceId: null }, base,
      { ...base, operationCode: 'design.generate', displayName: 'AI design', creditsPerUnit: DESIGN_RATE }] }, K());
    await wallet.setProgram(H('owner'), { action: 'ACTIVATE', expectedVersion: 1, authorizationReference: 'Fixture owner creative authorization (disposable)' }, K());
    const schoolView = await wallet.readSchoolWallet(H('ownerA'), S.A);
    assert(schoolView.rates.rates.some((r) => r.operationCode === 'website.edit' && r.mediaKind === 'WEBSITE'));
    const refused = await settle(wallet.reserveCredits(H('ownerA'), S.A, { operationCode: 'website.edit', units: 1, providerId: 'OPENROUTER', modelCode: 'approved/w670-synthetic' }, K()));
    assert(refused.error, 'public reserve must refuse a website reservation');
    assert.equal((await row("SELECT count(*)::int n FROM hon.saas_creative_reservations WHERE media_kind='WEBSITE'")).n, 0);
  });

  let a1;
  await check('W4', 'a paid school pays one edit with creative credits: reserved before the call, finalized at the rate, included AI untouched, the dollar cost recorded once', async () => {
    const price = await ai.price(readCtx('A'));
    assert.equal(price.paidWith, 'CREATIVE_CREDITS'); assert.equal(price.creditsPerEdit, RATE); assert.equal(price.availableCredits, 12000, 'this month counts before its lot is granted');
    const committed = async () => (await row('SELECT hon.ai_org_committed_credits($1, clock_timestamp())::int n', [S.orgA])).n;
    const c0 = await committed(), before = fake.calls;
    let held = null;
    fake.hold = async () => { held = await balance('A'); held.link = (await rows("SELECT status FROM hon.saas_creative_reservations WHERE school_id=$1 AND media_kind='WEBSITE'", [S.A])); };
    a1 = await ask('A');
    fake.hold = null;
    assert.equal(a1.status, 'RESULT_RECORDED'); assert.equal(fake.calls, before + 1);
    assert.deepEqual(held.link, [{ status: 'RESERVED' }], 'the reservation exists while the provider runs');
    assert.equal(held.held, RATE);
    const r = await linkOf(a1.id);
    assert.deepEqual([r.status, r.status_reason, r.final_units, r.final_credits, r.reserved_credits, r.media_kind, r.operation_code, r.cost_status, Number(r.provider_cost_microunits), r.cost_reference],
      ['FINALIZED', 'PROVIDER_SUCCEEDED', 1, RATE, RATE, 'WEBSITE', 'website.edit', 'RECORDED', 1100, 'AI_TEXT_PROPOSAL_USAGE']);
    const usage = await usageOf(a1.id);
    assert.deepEqual(usage, [{ c: 0, cost: '1100', spend_class: 'AGENT_INFERENCE', modality: 'TEXT' }]);
    assert.equal(r.usage_id, (await row('SELECT usage_id FROM hon.ai_text_proposals WHERE id=$1', [a1.id])).usage_id);
    assert.equal((await row("SELECT count(*)::int n FROM hon.ai_usage_ledger WHERE school_id=$1 AND spend_class='CREATIVE_MEDIA'", [S.A])).n, 0, 'no second cost row');
    assert.equal((await row('SELECT reserved_credits FROM hon.ai_text_proposals WHERE id=$1', [a1.id])).reserved_credits, 0);
    assert.equal(await committed(), c0, 'included AI credits untouched');
    assert.deepEqual(await balance('A'), { available: 12000 - RATE, held: 0 });
    assert.equal((await ai.price(readCtx('A'))).availableCredits, 12000 - RATE);
  });

  await check('W5', 'a replay with the same key returns the same edit with no second call and no second charge', async () => {
    const key = K(), rev = await draftRevision('A'), before = fake.calls;
    const v = await ai.request(ctx('A', { idempotencyKey: key }), { expectedRevision: rev, request: 'Bolder colours' });
    const again = await ai.request(ctx('A', { idempotencyKey: key }), { expectedRevision: rev, request: 'Bolder colours' });
    assert.equal(again.id, v.id); assert.equal(fake.calls, before + 1);
    assert.equal((await row("SELECT count(*)::int n FROM hon.ai_text_creative_reservations WHERE proposal_id=$1", [v.id])).n, 1);
    assert.deepEqual(await balance('A'), { available: 12000 - 2 * RATE, held: 0 });
    await ai.dismiss(ctx('A'), v.id);
  });

  await check('W6', 'a rejected answer and a provider failure give the credits back; a pre-send failure never reserved', async () => {
    const b0 = (await balance('A')).available;
    fake.answer = badAnswer;
    const rej = await ask('A', 'Use my photo');
    fake.answer = goodAnswer;
    assert.equal(rej.status, 'RESULT_REJECTED');
    const rr = await linkOf(rej.id);
    assert.deepEqual([rr.status, rr.final_credits, rr.cost_status, Number(rr.provider_cost_microunits)], ['RELEASED', null, 'RECORDED', 1100]);
    assert.deepEqual(await usageOf(rej.id), [{ c: 0, cost: '1100', spend_class: 'AGENT_INFERENCE', modality: 'TEXT' }]);
    fake.mode = 'FAILED';
    const failed = await ask('A', 'Add a camp page');
    fake.mode = 'OK';
    assert.equal(failed.status, 'FAILED');
    const fr = await linkOf(failed.id);
    assert.equal(fr.status, 'RELEASED');
    assert.deepEqual(await balance('A'), { available: b0, held: 0 });
  });

  await check('W7', 'an unknown outcome holds the credits for the HQ owner; it is not in the S4 included-credit queue; the CW1 resolution gives them back', async () => {
    const b0 = (await balance('A')).available;
    fake.mode = 'UNKNOWN';
    const u = await settle(ask('A', 'Rewrite the about page'));
    fake.mode = 'OK';
    const p = await row('SELECT * FROM hon.ai_text_proposals WHERE school_id=$1 ORDER BY created_at DESC LIMIT 1', [S.A]);
    assert.equal(p.status, 'UNKNOWN', JSON.stringify(u.error?.getResponse?.() ?? u.value?.status)); assert.equal(p.reserved_credits, 0);
    const r = await linkOf(p.id);
    assert.deepEqual([r.status, r.status_reason], ['OUTCOME_UNKNOWN', 'PROVIDER_OUTCOME_UNKNOWN']);
    assert.deepEqual(await balance('A'), { available: b0 - RATE, held: RATE });
    const queue = JSON.stringify((await admin.query('SELECT hon.read_ai_unknown_invocations_from_hq($1) q', [H('owner')])).rows[0].q);
    assert(!queue.includes(p.id), 'the creative-paid edit is not an included-credit hold');
    await wallet.resolveReservation(H('owner'), r.id, { resolution: 'NOT_CHARGED', expectedVersion: r.version, finalUnits: null, providerCostMicrounits: 0, evidenceReference: 'Fixture: provider shows no request' }, K());
    assert.deepEqual(await balance('A'), { available: b0, held: 0 });
    assert.equal((await linkOf(p.id)).status, 'RELEASED');
  });

  await check('W8', 'an S4 creative-media pause blocks the edit before any call (AI_SPEND_STOPPED) and never falls back to included AI', async () => {
    await pause('PAUSE', S.orgA, 'CREATIVE_MEDIA');
    const before = fake.calls, b0 = await balance('A');
    const v = await ask('A', 'Paused request');
    assert.deepEqual([v.status, v.reason], ['BLOCKED', 'AI_SPEND_STOPPED']); assert.equal(fake.calls, before);
    assert.equal(await linkOf(v.id), undefined); assert.deepEqual(await usageOf(v.id), []);
    assert.deepEqual(await balance('A'), b0);
    await pause('RESUME', S.orgA, 'CREATIVE_MEDIA');
  });

  await check('W9', 'out of creative credits: the edit is blocked CREATIVE_CREDITS_EXHAUSTED before any call, with no reservation and no included-AI fallback', async () => {
    const lot = await row("SELECT id FROM hon.saas_creative_lots WHERE school_id=$1 AND lot_kind='INCLUDED_MONTHLY'", [S.A]);
    const b0 = await balance('A');
    await wallet.debitLot(H('owner'), lot.id, { credits: b0.available - (RATE - 1), reasonCode: 'BILLING_CORRECTION', note: 'Fixture: leave fewer credits than one edit' }, K());
    assert.equal((await ai.price(readCtx('A'))).availableCredits, RATE - 1);
    const before = fake.calls;
    const v = await ask('A', 'One more change');
    assert.deepEqual([v.status, v.reason], ['BLOCKED', 'CREATIVE_CREDITS_EXHAUSTED']); assert.equal(fake.calls, before);
    assert.equal(await linkOf(v.id), undefined); assert.deepEqual(await usageOf(v.id), []);
    assert.deepEqual(await balance('A'), { available: RATE - 1, held: 0 });
  });

  await check('W10', 'an unpaid Complete school keeps AI website edits on included AI (owner decision 2026-11-24) while the program is on', async () => {
    assert.deepEqual(await ai.price(readCtx('U')), { paidWith: 'INCLUDED_AI', creditsPerEdit: null, availableCredits: null });
    const v = await ask('U');
    assert.equal(v.status, 'RESULT_RECORDED');
    assert.equal(await linkOf(v.id), undefined);
    assert.deepEqual(await usageOf(v.id), [{ c: 2, cost: '1100', spend_class: 'AGENT_INFERENCE', modality: 'TEXT' }]);
    assert.equal((await row('SELECT count(*)::int n FROM hon.saas_creative_reservations WHERE school_id=$1', [S.U])).n, 0);
  });

  await check('W17', 'AI designs (0706): a paid school pays 2 creative credits a design on the same path (reserved before the call, finalized, included AI untouched), is blocked with nothing sent when out of credits, and an unpaid school stays on included AI', async () => {
    const b0 = (await balance('A')).available;
    assert(b0 >= DESIGN_RATE && b0 < 2 * DESIGN_RATE + DESIGN_RATE, `fixture balance ${b0}`);
    assert.deepEqual(await designs.price(readCtx('A')), { paidWith: 'CREATIVE_CREDITS', creditsPerDesign: DESIGN_RATE, availableCredits: b0 });
    const committed = async () => (await row('SELECT hon.ai_org_committed_credits($1, clock_timestamp())::int n', [S.orgA])).n;
    const c0 = await committed(), before = designFake.calls;
    const v = await askDesign('A');
    assert.equal(v.status, 'RESULT_RECORDED', JSON.stringify(v)); assert.equal(designFake.calls, before + 1);
    const r = await linkOf(v.id);
    assert.deepEqual([r.status, r.final_credits, r.reserved_credits, r.media_kind, r.operation_code, Number(r.provider_cost_microunits)], ['FINALIZED', DESIGN_RATE, DESIGN_RATE, 'WEBSITE', 'design.generate', 800]);
    assert.deepEqual(await usageOf(v.id), [{ c: 0, cost: '800', spend_class: 'AGENT_INFERENCE', modality: 'TEXT' }]);
    assert.equal(await committed(), c0, 'included AI credits untouched');
    assert.deepEqual(await balance('A'), { available: b0 - DESIGN_RATE, held: 0 });
    // Spend down to below one design: the next one is blocked before any call, with no reservation and no fallback.
    while ((await balance('A')).available >= DESIGN_RATE) assert.equal((await askDesign('A')).status, 'RESULT_RECORDED');
    const calls = designFake.calls, left = await balance('A');
    const blocked = await askDesign('A');
    assert.deepEqual([blocked.status, blocked.reason], ['BLOCKED', 'CREATIVE_CREDITS_EXHAUSTED']); assert.equal(designFake.calls, calls);
    assert.equal(await linkOf(blocked.id), undefined); assert.deepEqual(await usageOf(blocked.id), []);
    assert.deepEqual(await balance('A'), left);
    // The unpaid Complete school: included AI, no reservation.
    assert.deepEqual(await designs.price(readCtx('U')), { paidWith: 'INCLUDED_AI', creditsPerDesign: null, availableCredits: null });
    const u = await askDesign('U');
    assert.equal(u.status, 'RESULT_RECORDED'); assert.equal(await linkOf(u.id), undefined);
    assert.equal((await usageOf(u.id))[0].c > 0, true);
    assert.equal((await row('SELECT count(*)::int n FROM hon.saas_creative_reservations WHERE school_id=$1', [S.U])).n, 0);
  });

  await check('W16', 'a free-trial school (0683) pays AI website edits from its own 1,500-credit TRIAL lot at the website rate (owner decision 2026-11-24), never from included AI', async () => {
    // HQ owner approves a synthetic trial policy and publishes one public 14-day campaign; programs opened to TEST_MODE in this disposable database only.
    // The AI planner still checks its estimate (20 credits for a website edit) against the trial's agent-AI per-request cap,
    // so this campaign sets 20; a lower HQ trial setting refuses the edit before any reservation or call (nothing is charged).
    const trials = new SaasTrialsService(billing), why = 'DISPOSABLE SYNTHETIC 0690 TRIAL WEBSITE EDIT ONLY';
    const pv = Number((await row('SELECT coalesce(max(version),0) v FROM hon.saas_trial_policy_versions')).v);
    const policy = (await trials.propose(H('owner'), { expectedVersion: pv, terms: trialTerms({ termsReference: 'HON_OS_TRIAL_SYNTHETIC_TERMS', promotionalLimits: trialPromoLimits({ maxPerRequestCreditCap: 20 }) }), reason: why }, K())).policyVersion;
    await trials.decide(H('owner'), trialApproval(policy.policyId, Number((await row('SELECT coalesce(max(revision),0) r FROM hon.saas_trial_policy_decisions')).r)), K());
    const v = (await trials.draft(H('owner'), { campaignId: null, expectedVersion: 0, definition: trialDefinition({ name: 'Synthetic 0690 trial', durationDays: 14, termsReference: 'HON_OS_TRIAL_SYNTHETIC_TERMS',
      linkMode: 'PUBLIC', maximumEnrollments: 1, enrollmentOpensAt: iso(Date.now() - 60_000), promotionalBudget: trialPromoBudget({ perRequestCreditCap: 20 }) }), reason: why }, K())).campaignVersion;
    const preview = await trials.preview(H('owner'), v.versionId); assert.equal(preview.ready, true, JSON.stringify(preview.blockers));
    await trials.publish(H('owner'), preview.campaignId, { versionId: preview.versionId, expectedRevision: preview.expectedRevision, previewDigest: preview.digest, confirmation: 'PUBLISH_TRIAL_CAMPAIGN_DEFINITION_ONLY', reason: why }, K());
    for (const t of ['hon_os_signup_program', 'hon_os_trial_program']) await admin.query(`UPDATE hon.${t} SET status='TEST_MODE',recorded_at=clock_timestamp() WHERE program_id=1`);
    const runtime = database['getPool']();
    const subject = `oidc:w690-trial:${K()}`, terms = (await row('SELECT id FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1')).id;
    const reg = (await runtime.query('SELECT hon.register_hon_os_school($1,$2,$3::jsonb,$4) r', [subject, `w690-${K()}@example.invalid`, JSON.stringify({ ownerName: 'Synthetic trial owner',
      schoolName: 'W690 Trial Dojo', legalName: 'W690 Trial Dojo LLC', timezone: 'America/Chicago', termsVersionId: terms, confirmation: contracts.SIGNUP_CONFIRMATION }), K()])).rows[0].r;
    const trial = (await runtime.query('SELECT hon.start_hon_os_trial($1,$2::jsonb,$3) r', [subject, JSON.stringify({ schoolId: reg.schoolId, campaignId: preview.campaignId, confirmation: contracts.TRIAL_CONFIRMATION }), K()])).rows[0].r;
    assert.deepEqual(trial.creativeCredits, { credits: 1500, available: 1500, expiresAt: trial.endsAt });
    const pid = (await row('SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject=$1', [subject])).id;
    humans.ownerT = { id: pid, subject }; S.orgT = reg.organizationId; S.T = reg.schoolId;
    await website('T');
    assert.deepEqual(await ai.price(readCtx('T')), { paidWith: 'CREATIVE_CREDITS', creditsPerEdit: RATE, availableCredits: 1500 });
    const before = fake.calls, committed = async () => (await row('SELECT hon.ai_org_committed_credits($1, clock_timestamp())::int n', [S.orgT])).n, c0 = await committed();
    const t1 = await ask('T');
    assert.equal(t1.status, 'RESULT_RECORDED'); assert.equal(fake.calls, before + 1);
    const r = await linkOf(t1.id);
    assert.deepEqual([r.status, r.final_credits, r.media_kind, r.operation_code], ['FINALIZED', RATE, 'WEBSITE', 'website.edit']);
    assert.deepEqual(await rows("SELECT l.lot_kind k, g.entry_kind e, g.credits::int c FROM hon.saas_creative_ledger g JOIN hon.saas_creative_lots l ON l.id=g.lot_id WHERE g.reservation_id=$1 AND g.entry_kind='RESERVE'", [r.id]),
      [{ k: 'TRIAL', e: 'RESERVE', c: RATE }], 'the TRIAL lot pays the edit');
    assert.deepEqual(await usageOf(t1.id), [{ c: 0, cost: '1100', spend_class: 'AGENT_INFERENCE', modality: 'TEXT' }], 'no included trial AI credits used');
    assert.equal(await committed(), c0, 'included AI credits untouched');
    assert.deepEqual(await balance('T'), { available: 1500 - RATE, held: 0 });
    assert.equal((await ai.price(readCtx('T'))).availableCredits, 1500 - RATE);
  });

  await check('W11', 'exact-school isolation: school A\'s edits never touch school B\'s wallet; B pays its own edit; one school\'s owner cannot read another school\'s price', async () => {
    assert.equal((await row('SELECT count(*)::int n FROM hon.saas_creative_reservations WHERE school_id=$1', [S.B])).n, 0);
    const a0 = await balance('A');
    const v = await ask('B');
    assert.equal(v.status, 'RESULT_RECORDED');
    assert.equal((await linkOf(v.id)).school_id, S.B);
    assert.deepEqual(await balance('B'), { available: 12000 - RATE, held: 0 });
    assert.deepEqual(await balance('A'), a0, 'B\'s edit never touches A\'s wallet (A spent its last credits on W9 and W17)');
    const cross = await settle(ai.price({ ...readCtx('B'), organizationId: S.orgA, schoolId: S.A }));
    assert(cross.error, 'B\'s owner has no access at A');
  });

  await check('W12', 'concurrency on one wallet: website edits and image reservations race without deadlock, and never spend more than the wallet holds', async () => {
    const lot = await row("SELECT id FROM hon.saas_creative_lots WHERE school_id=$1 AND lot_kind='INCLUDED_MONTHLY'", [S.B]);
    const b0 = await balance('B'), t0 = (await row('SELECT clock_timestamp() t')).t;
    await wallet.debitLot(H('owner'), lot.id, { credits: b0.available - 40, reasonCode: 'BILLING_CORRECTION', note: 'Fixture: 40 credits for the race' }, K());
    let release; fake.hold = new Promise((r) => { release = r; });
    const edits = [1, 2, 3, 4].map((n) => settle(ask('B', `Race edit ${n}`)));
    const images = [1, 2].map(() => settle(wallet.reserveCredits(H('ownerB'), S.B, { operationCode: 'image.generate', units: 1, providerId: 'HIGGSFIELD', modelCode: 'fixture-image-1' }, K())));
    const imageResults = await Promise.all(images);
    await new Promise((r) => setTimeout(r, 300));
    release(); fake.hold = null;
    const editResults = await Promise.all(edits);
    for (const x of [...editResults, ...imageResults]) if (x.error) assert.notEqual(x.error?.code, '40P01', 'no deadlock');
    const all = await rows('SELECT media_kind, status, reserved_credits FROM hon.saas_creative_reservations WHERE school_id=$1 AND reserved_at > $2', [S.B, t0]);
    const spentOrHeld = all.filter((r) => r.status !== 'RELEASED').reduce((n, r) => n + r.reserved_credits, 0);
    assert(spentOrHeld <= 40, `spent or held ${spentOrHeld} of 40`);
    const bal = await balance('B');
    assert(bal.available >= 0 && bal.available + spentOrHeld === 40, JSON.stringify({ bal, spentOrHeld }));
    const okEdits = editResults.filter((x) => x.value?.status === 'RESULT_RECORDED').length, okImages = imageResults.filter((x) => x.value).length;
    assert(okEdits * RATE + okImages * 10 <= 40 && okEdits >= 1 && okImages === 2, JSON.stringify({ okEdits, okImages }));
    for (const x of editResults) if (x.value?.status === 'BLOCKED') assert(['CREATIVE_CREDITS_EXHAUSTED', 'CREATIVE_EDIT_IN_PROGRESS'].includes(x.value.reason), x.value.reason);
  });

  await check('W14', 'one creative-paid edit in flight per school: a second edit while the first is with the provider is blocked CREATIVE_EDIT_IN_PROGRESS with no call; after it settles the next one runs', async () => {
    const lot = await row("SELECT id FROM hon.saas_creative_lots WHERE school_id=$1 AND lot_kind='PROMOTIONAL'", [S.B]);
    if (!lot) await wallet.grantCredits(H('owner'), S.B, { kind: 'PROMOTIONAL', credits: 100, reasonCode: 'PROMOTION', note: 'Fixture credits for the in-flight check' }, K());
    let release, entered; const inside = new Promise((r) => { entered = r; });
    fake.hold = () => { entered(); return new Promise((r) => { release = r; }); };
    const first = settle(ask('B', 'First of two'));
    await inside;
    fake.hold = null;
    const before = fake.calls;
    const second = await ask('B', 'Second while the first runs');
    assert.deepEqual([second.status, second.reason], ['BLOCKED', 'CREATIVE_EDIT_IN_PROGRESS']); assert.equal(fake.calls, before);
    assert.equal(await linkOf(second.id), undefined);
    release();
    assert.equal((await first).value?.status, 'RESULT_RECORDED');
    const third = await ask('B', 'After the first settled');
    assert.equal(third.status, 'RESULT_RECORDED');
  });

  await check('W15', 'an edit whose API died after prepare (SENDING over 90 seconds) stops blocking: the next edit times it out to UNKNOWN, its reservation goes to OUTCOME_UNKNOWN for the HQ CW1 queue, and the next edit runs', async () => {
    let release, entered; const inside = new Promise((r) => { entered = r; });
    fake.hold = () => { entered(); return new Promise((r) => { release = r; }); };
    const dead = settle(ask('B', 'Edit whose API process dies'));
    await inside;
    fake.hold = null;
    const lost = await row("SELECT id FROM hon.ai_text_proposals WHERE school_id=$1 AND status='SENDING' ORDER BY created_at DESC LIMIT 1", [S.B]);
    assert(lost, 'the held edit is SENDING');
    assert.equal((await linkOf(lost.id)).status, 'RESERVED');
    await admin.query("UPDATE hon.ai_text_proposals SET updated_at = clock_timestamp() - interval '2 minutes' WHERE id=$1", [lost.id]);
    const next = await ask('B', 'Next edit after the lost one');
    assert.equal(next.status, 'RESULT_RECORDED', JSON.stringify(next));
    const was = await row('SELECT status, reason FROM hon.ai_text_proposals WHERE id=$1', [lost.id]);
    assert.deepEqual([was.status, was.reason], ['UNKNOWN', 'PROVIDER_UNKNOWN']);
    const held = await linkOf(lost.id);
    assert.deepEqual([held.status, held.status_reason, held.reserved_credits], ['OUTCOME_UNKNOWN', 'PROVIDER_OUTCOME_UNKNOWN', RATE]);
    release();
    await dead;
    assert.equal((await linkOf(lost.id)).status, 'OUTCOME_UNKNOWN', 'a late answer does not settle a timed-out edit');
  });

  await check('W13', 'the 011 exact verification for 0690 and the shared 0550 core passes on this database', async () => {
    const fs = await import('node:fs/promises');
    const sql = await fs.readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
    for (const marker of ['-- Shared AI text proposals exact verification (0550)', '-- AI website edits on creative credits exact verification (0690)', '-- Design AI creative credits exact verification (0706)']) {
      const start = sql.indexOf(marker); assert(start >= 0, marker);
      const block = sql.slice(sql.indexOf('DO $$', start), sql.indexOf('END $$;', start) + 'END $$;'.length);
      await admin.query(block.replaceAll("'hon_runtime'", `'${CHAMPIONS_RUNTIME_ROLE}'`));
    }
  });
} finally {
  await admin.end().catch(() => {});
  await database.onModuleDestroy?.().catch?.(() => {});
}
const failed = results.filter((r) => r[1] === 'FAIL');
console.log(`0690 website AI edits on creative credits: ${results.length - failed.length}/${results.length} checks passed, ${fake.calls} fake provider calls, ${networkCalls} network calls`);
if (failed.length || networkCalls) process.exit(1);
process.exit(0);
