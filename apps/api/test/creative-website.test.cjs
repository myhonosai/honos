const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
require('reflect-metadata');
const { CreativeWebsiteService } = require('../dist/creative-studio/creative-website.service.js');
const { SyntheticWebsiteDraftRuntime, UnconfiguredWebsiteDraftRuntime } = require('../dist/creative-studio/website-draft-runtime.js');
const contracts = require('@hon/contracts');

// WB1 AI website drafts (migration 0344): one draft = one CW1 reservation of a WEBSITE rate, per page, then one provider call.
const T = '2026-11-13T12:00:00.000Z', T2 = '2026-11-13T12:00:05.000Z', U = () => randomUUID(), school = U(), subject = 'wb1-subject';
const kinds = ['INCLUDED_MONTHLY', 'ADJUSTMENT', 'PROMOTIONAL', 'PURCHASED_TOPUP'];
const balance = () => ({ availableCredits: 11550, heldCredits: 0, byKind: kinds.map((kind, i) => ({ kind, grantedCredits: i ? 0 : 12000,
  availableCredits: i ? 0 : 11550, heldCredits: 0, consumedCredits: i ? 0 : 450, expiredCredits: 0, debitedCredits: 0 })) });
const BRIEF = 'Family taekwondo school. Kids classes after school, adults in the evening.';
const input = (patch = {}) => ({ operationCode: 'website.draft', pages: ['HOME', 'PROGRAMS', 'CONTACT'], brief: BRIEF, ...patch });
const draft = (patch = {}) => ({ draftId: U(), schoolId: school, operationCode: 'website.draft', pages: ['HOME', 'PROGRAMS', 'CONTACT'], brief: BRIEF,
  status: 'GENERATING', failureReason: null, reservedCredits: 450, chargedCredits: null, createdAt: T, completedAt: null, content: null, ...patch });
const page = (pageKey) => ({ pageKey, title: 'Welcome', sections: [{ heading: 'Hello', body: 'Body text.' }], origin: 'SYNTHETIC' });

/** A billing stand-in: answers create with `created`, record by echoing a settled draft, and logs every call. */
function billingWith(created) {
  const calls = [];
  return { calls, async call(op, params, validate) {
    calls.push([op, params]);
    if (op === 'createCreativeWebsiteDraft') return validate(created);
    if (op === 'recordCreativeWebsiteDraftResult') {
      const o = JSON.parse(params[2]), d = created.draft;
      const settled = o.outcome === 'SUCCEEDED'
        ? { ...d, status: 'SUCCEEDED', chargedCredits: o.pages.length * 150, completedAt: T2, content: o.pages.map(p => ({ ...p, origin: 'SYNTHETIC' })) }
        : o.outcome === 'UNKNOWN' ? { ...d, status: 'UNDER_REVIEW', failureReason: o.failureReason, completedAt: T2 }
        : { ...d, status: 'FAILED', failureReason: o.failureReason, completedAt: T2 };
      return validate({ draft: settled, balance: balance(), replayed: false });
    }
    throw new Error(`unexpected ${op}`);
  } };
}

test('WB1 input is closed: a known operation, 1..8 known pages in order, a brief; never a provider, price, units or school', () => {
  assert.deepEqual(contracts.validateCreativeWebsiteDraftInput(input()), input());
  assert.equal(contracts.SAAS_COMMANDS.createCreativeWebsiteDraft, 'saas-creative-website-draft-create');
  assert.doesNotThrow(() => contracts.validateCreativeWebsiteDraftInput(input({ pages: [...contracts.CREATIVE_WEBSITE_PAGES] })));
  for (const bad of [input({ pages: [] }), input({ pages: ['CONTACT', 'HOME'] }), input({ pages: ['HOME', 'HOME'] }), input({ pages: ['BLOG'] }),
    input({ brief: '' }), input({ brief: 'x'.repeat(1001) }), input({ brief: ' padded' }), input({ units: 3 }), input({ providerId: 'X' }), input({ operationCode: 'Bad' })]) {
    assert.throws(() => contracts.validateCreativeWebsiteDraftInput(bad), JSON.stringify(bad));
  }
});

test('WB1 rate contracts: a WEBSITE rate is per PAGE, at most 8, never with cost evidence; image and video rules are unchanged', () => {
  const rate = (patch = {}) => ({ termsReference: 'Fixture rates', rates: [{ operationCode: 'website.draft', mediaKind: 'WEBSITE', displayName: 'AI website draft',
    billingUnit: 'PAGE', creditsPerUnit: 150, maxUnitsPerRequest: 8, costEvidenceId: null, ...patch }] });
  assert.doesNotThrow(() => contracts.validateSaasCreativeRatesInput(rate()));
  for (const bad of [rate({ billingUnit: 'REQUEST' }), rate({ maxUnitsPerRequest: 9 }), rate({ costEvidenceId: U() }), rate({ mediaKind: 'IMAGE' }), rate({ mediaKind: 'VIDEO' })]) {
    assert.throws(() => contracts.validateSaasCreativeRatesInput(bad), JSON.stringify(bad.rates[0]));
  }
  assert.equal(contracts.saasCreativeUnitFitsKind('VIDEO', 'IMAGE'), true, 'the 0202 VIDEO/IMAGE pairing stays valid');
  assert.equal(contracts.saasCreativeUnitFitsKind('IMAGE', 'VIDEO_SECOND'), false);
});

test('WB1 create: one provider call with the recorded pages and brief, then the verified pages are recorded once', async () => {
  const d = draft(), billing = billingWith({ draft: d, balance: balance(), replayed: false }), fake = new SyntheticWebsiteDraftRuntime('SUCCEED');
  const out = await new CreativeWebsiteService(billing, fake).create(subject, school, input(), U());
  assert.deepEqual([out.draft.status, out.draft.chargedCredits, out.draft.content.map(p => p.pageKey)], ['SUCCEEDED', 450, ['HOME', 'PROGRAMS', 'CONTACT']]);
  assert.deepEqual(fake.calls.map(c => [c.providerRequestId, c.pages, c.brief]), [[d.draftId, d.pages, BRIEF]]);
  assert.deepEqual(billing.calls.map(c => c[0]), ['createCreativeWebsiteDraft', 'recordCreativeWebsiteDraftResult']);
  const provider = JSON.parse(billing.calls[0][1][3]);
  assert.deepEqual(provider, { providerId: 'HIGGSFIELD', modelCode: 'synthetic-website-1' }, 'the server route, never the client');
  const recorded = JSON.parse(billing.calls[1][1][2]);
  assert.deepEqual([recorded.outcome, recorded.providerCostMicrounits, recorded.pages.length], ['SUCCEEDED', 6000, 3]);
});

test('WB1 untrusted results: an unrequested page is held UNKNOWN; refusals, pre-send and unknown map to their records', async () => {
  for (const [behaviour, outcome, reason, cost] of [['UNVERIFIED', 'UNKNOWN', 'UNVERIFIED_RESULT', null], ['UNKNOWN', 'UNKNOWN', 'PROVIDER_UNKNOWN', null],
    ['REJECT', 'FAILED', 'PROVIDER_REJECTED', null], ['REJECT_WITH_COST', 'FAILED', 'PROVIDER_REJECTED', 250], ['PRE_SEND', 'NOT_SENT', 'INVALID_REQUEST', null]]) {
    const billing = billingWith({ draft: draft(), balance: balance(), replayed: false });
    await new CreativeWebsiteService(billing, new SyntheticWebsiteDraftRuntime(behaviour)).create(subject, school, input(), U());
    const recorded = JSON.parse(billing.calls[1][1][2]);
    assert.deepEqual([recorded.outcome, recorded.failureReason, recorded.providerCostMicrounits, recorded.pages], [outcome, reason, cost, null], behaviour);
  }
});

test('WB1 no website provider connected: refused before anything is reserved; a replay never calls the provider again', async () => {
  const billing = billingWith({ draft: draft(), balance: balance(), replayed: false });
  await assert.rejects(new CreativeWebsiteService(billing, new UnconfiguredWebsiteDraftRuntime()).create(subject, school, input(), U()),
    e => e.getStatus() === 503 && e.getResponse().code === 'CREATIVE_PROVIDER_NOT_CONNECTED');
  assert.equal(billing.calls.length, 0);
  const done = draft({ status: 'SUCCEEDED', chargedCredits: 450, completedAt: T2 }), fake = new SyntheticWebsiteDraftRuntime();
  const replay = billingWith({ draft: done, balance: balance(), replayed: true });
  const out = await new CreativeWebsiteService(replay, fake).create(subject, school, input(), U());
  assert.deepEqual([out.replayed, fake.calls.length, replay.calls.length], [true, 0, 1]);
});

test('WB1 reads are closed: a list never carries page text, and content only on a succeeded draft in page order', () => {
  const ok = draft({ status: 'SUCCEEDED', chargedCredits: 300, completedAt: T2, content: [page('HOME'), page('CONTACT')] });
  assert.doesNotThrow(() => contracts.validateCreativeWebsiteDraft(ok));
  assert.throws(() => contracts.validateCreativeWebsiteDraftRecords({ drafts: [ok], limit: 50 }), 'list with page text');
  assert.throws(() => contracts.validateCreativeWebsiteDraft({ ...ok, content: [page('CONTACT'), page('HOME')] }), 'out of order');
  assert.throws(() => contracts.validateCreativeWebsiteDraft({ ...ok, content: [page('FAQ')] }), 'unrequested page');
  assert.throws(() => contracts.validateCreativeWebsiteDraft({ ...draft({ status: 'FAILED', failureReason: 'PROVIDER_REJECTED', completedAt: T2 }), content: [page('HOME')] }));
  assert.throws(() => contracts.validateCreativeWebsiteDraft({ ...ok, providerId: 'X' }), 'no provider identity');
});
