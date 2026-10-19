const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { SaasBillingHqController } = require('../dist/saas-billing/saas-billing.controller.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

const T = '2026-10-18T12:00:00.000Z', U = () => randomUUID();
const plan = (code, credits) => ({ planCode:code, entitlementTier:code, availability:code === 'ESSENTIAL' ? 'LEGACY_ONLY' : 'PUBLIC', displayName:`HON ${code}`,
  plannedMonthlyPremiumCredits:credits, capabilities:[...contracts.SAAS_PLAN_CAPABILITIES[code]], ordinaryUseConsumesCredits:false });
const catalog = (patch = {}) => ({ catalogId:U(), catalogVersion:1, status:'PUBLISHED', currency:'USD', termsReference:'Fixture terms',
  plans:[plan('CORE', 5000), plan('COMPLETE', 12000), plan('ESSENTIAL', null)],
  offers:[{ offerId:U(), planCode:'CORE', offerKind:'REGULAR_MONTHLY', billingInterval:'MONTHLY', priceMinor:14900, founder:false, allowance:'FULL_MONTHLY_PLAN_ALLOWANCE' },
    { offerId:U(), planCode:'COMPLETE', offerKind:'FOUNDER_LIFETIME', billingInterval:'LIFETIME', priceMinor:357600, founder:true, allowance:'FULL_MONTHLY_PLAN_ALLOWANCE' }],
  founderProgram:{ totalLimit:50, lifetimeLimit:20, monthlyLimit:30, eligibility:'ANY_ACTIVE_ORGANIZATION', reservationHoldDays:7, opensAt:T, closesAt:null },
  chargesEnabled:false, creditGrantsEnabled:false, createdAt:T, publishedAt:T, retiredAt:null, ...patch });
const inventory = { status:'CONFIGURED', totalLimit:50, lifetimeLimit:20, monthlyLimit:30, lifetime:{ allocated:1, held:0 }, monthly:{ allocated:0, held:2 }, remaining:{ total:47, lifetime:19, monthly:28 } };
const policies = contracts.SAAS_POLICY_CODES.map((policyCode, i) => i % 2 ? { policyCode, status:'UNDECIDED', decision:null, summary:null, blocks:'Refused until the owner decides', actionsEnabled:false, version:1 }
  : { policyCode, status:'DECIDED', decision:'OWNER_DECISION', summary:'Recorded owner direction', blocks:'Still blocked until terms are authorized', actionsEnabled:false, version:2 });
const view = (patch = {}) => ({ published:catalog(), drafts:[], policies, founderInventory:inventory, chargesEnabled:false, creditGrantsEnabled:false, paymentProvider:'NOT_CONFIGURED', ...patch });
const subscription = (patch = {}) => ({ subscriptionId:U(), organizationId:U(), organizationName:'Fixture Dojo', source:'CATALOG_OFFER', catalogVersion:1, offerId:U(),
  planCode:'CORE', entitlementTier:'CORE', offerKind:'REGULAR_MONTHLY', billingInterval:'MONTHLY', priceMinor:14900, currency:'USD', founderReservationId:null,
  status:'IN_SERVICE', statusReason:'SERVICE_STARTED', version:2, serviceStartedAt:T, currentPeriod:{ index:0, startsAt:T, endsAt:'2026-11-18T12:00:00.000Z' },
  paymentStatus:'NOT_BILLED', paidThroughAt:null, chargesEnabled:false, premiumCredits:{ plannedMonthlyAllowance:5000, status:'NOT_GRANTED' }, createdAt:T, updatedAt:T, ...patch });

test('contracts: owner-approved draft, canonical Core/Complete entitlements, Essential legacy only', () => {
  const draft = contracts.SAAS_OWNER_APPROVED_DRAFT;
  assert.deepEqual(contracts.validateSaasCatalogDraftInput(draft), draft);
  assert.deepEqual(draft.offers.map(o => o.priceMinor), [14900, 7900, 189600, 24900, 14900, 357600]);
  assert.deepEqual(draft.plans.map(p => p.plannedMonthlyPremiumCredits), [5000, 12000]);
  assert.equal(draft.founderProgram.eligibility, 'UNDECIDED');
  assert.ok(!contracts.SAAS_CORE_CAPABILITIES.some(c => contracts.SAAS_COMPLETE_ONLY_CAPABILITIES.includes(c)));
  assert.ok(contracts.SAAS_PLAN_CAPABILITIES.COMPLETE.includes('ai.workforce') && !contracts.SAAS_PLAN_CAPABILITIES.CORE.includes('ai.workforce'));
  for (const bad of [{ ...draft, plans:[...draft.plans, { planCode:'ESSENTIAL', displayName:'Essential', plannedMonthlyPremiumCredits:null }] },
    { ...draft, offers:[{ planCode:'ESSENTIAL', offerKind:'REGULAR_MONTHLY', priceMinor:9900 }] }, { ...draft, chargesEnabled:false },
    { ...draft, offers:[...draft.offers, draft.offers[0]] }, { ...draft, founderProgram:{ ...draft.founderProgram, lifetimeLimit:51 } },
    { ...draft, offers:[{ planCode:'CORE', offerKind:'REGULAR_MONTHLY', priceMinor:14900.5 }] }, { ...draft, plans:[draft.plans[0], draft.plans[0]] }])
    assert.throws(() => contracts.validateSaasCatalogDraftInput(bad));
  // Annual kinds are recognized so the database can refuse them explicitly (SAAS_POLICY_UNDECIDED).
  assert.doesNotThrow(() => contracts.validateSaasCatalogDraftInput({ ...draft, offers:[{ planCode:'CORE', offerKind:'REGULAR_ANNUAL', priceMinor:149000 }] }));
  assert.throws(() => contracts.validateSaasSubscriptionCommand({ action:'REFUND', expectedVersion:1, reasonCode:'SCHOOL_REQUEST' }));
  assert.throws(() => contracts.validateSaasSubscriptionRecordInput({ source:'CATALOG_OFFER', organizationId:U(), offerId:U() }));
});

test('response contracts fail closed on any financial activation, payment claim or entitlement drift', () => {
  assert.doesNotThrow(() => contracts.validateSaasCatalogView(view()));
  assert.doesNotThrow(() => contracts.validateSaasSubscriptionList({ subscriptions:[subscription()], limit:200, chargesEnabled:false }));
  const coreWithWorkforce = catalog(); coreWithWorkforce.plans[0].capabilities.push('ai.workforce');
  const essentialPublic = catalog(); essentialPublic.plans[2].availability = 'PUBLIC';
  for (const bad of [view({ chargesEnabled:true }), view({ creditGrantsEnabled:true }), view({ paymentProvider:'STRIPE' }), view({ published:catalog({ chargesEnabled:true }) }),
    view({ published:coreWithWorkforce }), view({ published:essentialPublic }), view({ policies:[{ ...policies[0], actionsEnabled:true }, ...policies.slice(1)] }), view({ policies:policies.map((p, i) => i === 1 ? { ...p, decision:'X' } : p) }),
    view({ policies:[{ ...policies[0], status:'PROPOSED', decision:null }, ...policies.slice(1)] }),
    view({ published:catalog({ offers:[{ offerId:U(), planCode:'CORE', offerKind:'REGULAR_ANNUAL', billingInterval:'ANNUAL', priceMinor:149000, founder:false, allowance:'FULL_MONTHLY_PLAN_ALLOWANCE' }] }) }),
    view({ published:catalog({ offers:[{ offerId:U(), planCode:'ESSENTIAL', offerKind:'REGULAR_MONTHLY', billingInterval:'MONTHLY', priceMinor:9900, founder:false, allowance:'FULL_MONTHLY_PLAN_ALLOWANCE' }] }) })])
    assert.throws(() => contracts.validateSaasCatalogView(bad));
  for (const bad of [subscription({ paymentStatus:'PAID' }), subscription({ paidThroughAt:T }), subscription({ chargesEnabled:true }),
    subscription({ premiumCredits:{ plannedMonthlyAllowance:5000, status:'GRANTED' } }), subscription({ planCode:'COMPLETE' }),
    subscription({ offerKind:'FOUNDER_MONTHLY' }), subscription({ source:'LEGACY_ENTITLEMENT' }), subscription({ status:'PENDING_ACTIVATION' }),
    { ...subscription(), balance:5000 }])
    assert.throws(() => contracts.validateSaasSubscriptionList({ subscriptions:[bad], limit:200, chargesEnabled:false }));
});

async function boot(respond) {
  const calls = [];
  const module = await Test.createTestingModule({ controllers:[SaasBillingHqController], providers:[SaasBillingService, SaasCommandGuard, SaasReadGuard,
    { provide:RuntimeDatabaseService, useValue:{ callSaasBilling:async (operation, params) => { calls.push([operation, params]); return respond(operation, params); } } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject:'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  return { app, calls, base:`http://127.0.0.1:${app.getHttpServer().address().port}/v1/hq/saas` };
}
// node:http (not fetch): fetch forces its own sec-fetch-* headers.
const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status:res.statusCode, headers:res.headers, body:Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
const human = command => ({ 'content-type':'application/json', origin:'https://hon.example', 'x-hon-human-command':command, 'sec-fetch-site':'same-origin',
  'sec-fetch-mode':'same-origin', 'sec-fetch-dest':'empty', 'idempotency-key':randomUUID() });

test('HTTP routes: subject-only reads, exact human commands, no payment routes', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const sub = subscription();
  const { app, calls, base } = await boot(operation => operation === 'readCatalog' ? view()
    : operation === 'commandSubscription' ? { subscription:sub, action:'SUSPEND', replayed:false } : { subscriptions:[sub], limit:200, chargesEnabled:false });
  try {
    const read = await send(`${base}/catalog`); assert.equal(read.status, 200); assert.match(read.headers['cache-control'], /no-store/);
    assert.deepEqual(calls.at(-1), ['readCatalog', ['verified-human']]);
    assert.equal((await send(`${base}/catalog?organizationId=x`)).status, 400);
    assert.equal((await send(`${base}/subscriptions?status=IN_SERVICE`)).status, 200); assert.deepEqual(calls.at(-1), ['readSubscriptions', ['verified-human', 'IN_SERVICE']]);
    assert.equal((await send(`${base}/subscriptions?status=PAID`)).status, 400);
    const before = calls.length;
    for (const path of ['checkout', 'charges', 'refunds/execute', 'credits/grants', 'subscriptions/x/activate-payment'])
      assert.equal((await send(`${base}/${path}`, { method:'POST', headers:human('saas-subscription-command'), body:'{}' })).status, 404, path);
    assert.equal(calls.length, before);
    const id = randomUUID(), body = JSON.stringify({ action:'SUSPEND', expectedVersion:2, reasonCode:'OWNER_HOLD' });
    const ok = await send(`${base}/subscriptions/${id}/commands`, { method:'POST', headers:human('saas-subscription-command'), body });
    assert.equal(ok.status, 200, ok.body);
    const [operation, params] = calls.at(-1);
    assert.equal(operation, 'commandSubscription'); assert.equal(params[0], 'verified-human'); assert.equal(params[1], id);
    assert.deepEqual(JSON.parse(params[2]), { action:'SUSPEND', expectedVersion:2, reasonCode:'OWNER_HOLD' });
    const n = calls.length;
    for (const extra of [{ 'x-hon-human-command':'saas-catalog-publish' }, { origin:'https://attacker.example' }, { 'sec-fetch-site':'cross-site' },
      { 'x-hon-organization-id':randomUUID() }, { 'content-type':'text/plain' }])
      assert.equal((await send(`${base}/subscriptions/${id}/commands`, { method:'POST', headers:{ ...human('saas-subscription-command'), ...extra }, body })).status, 403);
    assert.equal((await send(`${base}/subscriptions/${id}/commands?x=1`, { method:'POST', headers:human('saas-subscription-command'), body })).status, 400);
    assert.equal((await send(`${base}/catalog/drafts/${id}/publish`, { method:'POST', headers:human('saas-catalog-publish'), body:'{"force":true}' })).status, 400);
    assert.equal((await send(`${base}/subscriptions/not-a-uuid/commands`, { method:'POST', headers:human('saas-subscription-command'), body })).status, 400);
    assert.equal(calls.length, n);
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});

test('database refusals map to stable codes; private messages and response drift never leak', async () => {
  const cases = [[{ code:'23514', message:'SAAS_POLICY_UNDECIDED' }, 422, 'SAAS_POLICY_UNDECIDED'], [{ code:'23514', message:'SAAS_FOUNDER_SOLD_OUT' }, 422, 'SAAS_FOUNDER_SOLD_OUT'],
    [{ code:'23514', message:'saas_subscriptions_check' }, 400, 'INVALID_SAAS_INPUT'], [{ code:'42501', message:'SAAS_FORBIDDEN' }, 403, 'SAAS_FORBIDDEN'],
    [{ code:'40001', message:'SAAS_TRANSITION_NOT_ALLOWED' }, 409, 'SAAS_TRANSITION_NOT_ALLOWED'], [{ code:'40001', message:'internal' }, 409, 'SAAS_VERSION_CONFLICT'],
    [{ code:'23505', message:'SAAS_KEY_REUSED' }, 409, 'IDEMPOTENCY_KEY_REUSED'], [{ code:'55P03' }, 409, 'SAAS_OUTCOME_UNKNOWN'], [{ code:'P0002' }, 404, 'SAAS_UNAVAILABLE'],
    [{ code:'XX000', message:'boom' }, 503, 'SAAS_UNAVAILABLE']];
  for (const [error, status, code] of cases) {
    const service = new SaasBillingService({ callSaasBilling:async () => { throw Object.assign(new Error(error.message ?? 'x'), error); } });
    await assert.rejects(service.readCatalog('verified-human'), e => e.getStatus() === status && e.getResponse().code === code);
  }
  const drifted = new SaasBillingService({ callSaasBilling:async () => view({ chargesEnabled:true }) });
  await assert.rejects(drifted.readCatalog('verified-human'), e => e.getStatus() === 503 && e.getResponse().code === 'SAAS_UNAVAILABLE');
  const never = new SaasBillingService({ callSaasBilling:async () => { throw new Error('must not be called'); } });
  await assert.rejects(never.createCatalogDraft('verified-human', { ...contracts.SAAS_OWNER_APPROVED_DRAFT, plans:[] }, randomUUID()), e => e.getStatus() === 400);
  await assert.rejects(never.recordSubscription('verified-human', { source:'LEGACY_ENTITLEMENT', organizationId:randomUUID() }, 'not-a-key'), e => e.getStatus() === 400);
});
