import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { validateTrialGovernanceView, validateTrialPublicationPreview } from '@hon/contracts';
import { TRIALS_LANGUAGES } from '../src/components/hq-trials/copy';
import { TrialsError, keepForRetry, toMinor, trialsApi, trialsErrorFor, utcDay } from '../src/components/hq-trials/http';
import { trialRequest } from '../src/components/hq-trials/hq-trials';
import { TrialsView, campaignsOf, ruleState, type TrialsViewProps } from '../src/components/hq-trials/view';
import { HQ_REVENUE } from '../src/components/hq-modern/catalog';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
import { id } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const principal = id(9), policy1 = id(10), policy2 = id(11), decision1 = id(20), decision2 = id(21), campaign = id(30), campaign2 = id(31),
  v1 = id(40), v2 = id(41), v3 = id(42), pub1 = id(50);
const DIGEST = 'a'.repeat(64);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as TrialsError; } throw new Error('expected a failure'); };

const terms = (over: Record<string, unknown> = {}) => ({ allowedDurationsDays: [14, 30], allowedCapabilityProfiles: ['CORE', 'COMPLETE'], allowedEligibilityCodes: ['NEW_ORGANIZATIONS_ONLY'],
  allowedLinkModes: ['PRIVATE_INVITATION'], maxEnrollmentCapacity: 50, maxEnrollmentWindowDays: 90, maxPublishedCampaigns: 3, maxTotalEnrollmentCapacity: 120,
  termsReference: 'hon-trial-terms/v1', promotionalLimits: null, ...over });
const definition = (over: Record<string, unknown> = {}) => ({ name: 'Spring pilot schools', durationDays: 30, capabilityProfile: 'COMPLETE', eligibility: 'NEW_ORGANIZATIONS_ONLY',
  linkMode: 'PRIVATE_INVITATION', enrollmentOpensAt: '2026-11-15T00:00:00.000Z', enrollmentClosesAt: '2026-12-15T00:00:00.000Z', maximumEnrollments: 20,
  termsReference: 'hon-trial-terms/v1', promotionalBudget: null, ...over });
const policyVersion = (policyId: string, version: number, over: Record<string, unknown> = {}) => ({ policyId, version, status: 'PROPOSED', terms: terms(),
  reason: 'Owner-approved pilot trial rules', actorPrincipalId: principal, recordedAt: `2026-11-0${version}T10:00:00.000Z`, ...over });
const decision = (over: Record<string, unknown> = {}) => ({ decisionId: decision1, revision: 1, policyId: policy2, decision: 'APPROVED', validFrom: '2026-11-01T00:00:00.000Z',
  validUntil: '2027-02-01T00:00:00.000Z', reason: 'Approved for the pilot window', actorPrincipalId: principal, recordedAt: '2026-11-03T10:00:00.000Z', ...over });
const campaignVersion = (versionId: string, campaignId: string, version: number, over: Record<string, unknown> = {}) => ({ versionId, campaignId, version,
  definition: definition(), reason: 'Draft for the first pilot cohort', actorPrincipalId: principal, recordedAt: `2026-11-0${3 + version}T10:00:00.000Z`, ...over });
const publication = (over: Record<string, unknown> = {}) => ({ publicationId: pub1, campaignId: campaign, revision: 1, kind: 'PUBLISHED', versionId: v1, policyDecisionId: decision1,
  previewDigest: DIGEST, reason: 'Definition recorded for the pilot', actorPrincipalId: principal, recordedAt: '2026-11-05T12:00:00.000Z', activationAvailable: false, ...over });
const governance = (over: Record<string, unknown> = {}) => ({ scope: 'CUSTOMER_TRIAL_GOVERNANCE_ONLY',
  program: { status: 'INACTIVE', signupEnabled: false, enrollmentEnabled: false, promotionalIssuanceEnabled: false },
  policyVersions: [policyVersion(policy2, 2), policyVersion(policy1, 1)], policyDecisions: [decision()],
  campaignVersions: [campaignVersion(v1, campaign, 1), campaignVersion(v2, campaign, 2, { definition: definition({ maximumEnrollments: 25 }) }),
    campaignVersion(v3, campaign2, 1, { definition: definition({ name: 'Founder schools', capabilityProfile: 'CORE', durationDays: 14,
      promotionalBudget: { currency: 'USD', creditsPerEnrollment: 500, creditExpiryDays: 14, dailyCreditCap: 100, perRequestCreditCap: 20, maximumCampaignCostMinor: 25_000 } }) })],
  publications: [publication()], limit: 100, hasMore: { policyVersions: false, policyDecisions: false, campaignVersions: false, publications: false },
  existingPrograms: { paidAccess: 'INACTIVE', aiCredits: 'INACTIVE', payments: 'TEST_MODE' }, asOf: '2026-11-09T05:00:00.000Z', ...over });
const preview = (over: Record<string, unknown> = {}) => ({ campaignId: campaign, versionId: v2, version: 2, expectedRevision: 1, policyDecisionId: decision1, policyId: policy2,
  digest: DIGEST, ready: false, blockers: ['CAPACITY_EXCEEDS_POLICY', 'SOMETHING_NEW'], activationAvailable: false, promotionalCreditsAvailable: false,
  plannedExposure: { enrollments: 25, promotionalCostMinor: 0, currency: 'USD' }, asOf: '2026-11-09T05:01:00.000Z', ...over });
const NOW = Date.parse('2026-11-09T05:00:00.000Z');
const view = (over: Partial<TrialsViewProps> = {}) => renderToStaticMarkup(<TrialsView language="en" concealed={false} now={NOW} preview={null}
  governance={{ state: 'READY', view: validateTrialGovernanceView(governance()) }} onRefresh={() => {}} onCheck={() => {}} {...over}/>);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

it('reads governance as a plain same-origin GET with no command headers and refuses drift', async () => {
  const f = stub(json({ data: governance() }));
  const read = await trialsApi.governance(signal(), () => true);
  expect(read.policyVersions).toHaveLength(2);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/hq/saas/trials/governance');
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
  expect(Object.keys(init.headers as object).some((k) => /^x-hon|idempotency|content-type/i.test(k))).toBe(false);
  expect(init.body).toBeUndefined();
  // A program shown as on, or an extra key, is not trusted.
  stub(json({ data: governance({ program: { status: 'ACTIVE', signupEnabled: true, enrollmentEnabled: false, promotionalIssuanceEnabled: false } }) }));
  expect((await fails(trialsApi.governance(signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: governance(), extra: 1 }));
  expect((await fails(trialsApi.governance(signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ code: 'SAAS_FORBIDDEN' }, 403));
  expect((await fails(trialsApi.governance(signal(), () => true))).kind).toBe('DENIED');
  stub(json({ code: 'BUSY' }, 503));
  expect((await fails(trialsApi.governance(signal(), () => true))).kind).toBe('UNKNOWN');
});

it('reads a readiness preview only for the version asked, and a 401 ends the session only for an owned read', async () => {
  const f = stub(json({ data: preview() }));
  const p = await trialsApi.preview(v2.toUpperCase(), signal(), () => true);
  expect(p.blockers).toEqual(['CAPACITY_EXCEEDS_POLICY', 'SOMETHING_NEW']);
  expect((f.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/hq/saas/trials/campaign-versions/${v2}/publication-preview`);
  stub(json({ data: preview({ versionId: v3 }) }));
  expect((await fails(trialsApi.preview(v2, signal(), () => true))).kind).toBe('UNKNOWN');
  const bad = stub(json({ data: preview() }));
  expect((await fails(trialsApi.preview('../governance', signal(), () => true))).kind).toBe('UNKNOWN');
  expect(bad).not.toHaveBeenCalled();
  const ended = vi.fn(); window.addEventListener(HON_SESSION_INVALIDATED_EVENT, ended);
  stub(new Response('', { status: 401 }));
  expect((await fails(trialsApi.preview(v2, signal(), () => false))).kind).toBe('SESSION');
  expect(ended).not.toHaveBeenCalled();
  stub(new Response('', { status: 401 }));
  expect((await fails(trialsApi.preview(v2, signal(), () => true))).kind).toBe('SESSION');
  expect(ended).toHaveBeenCalledTimes(1);
});

it('derives the current rule state from the decision with the highest revision', () => {
  const g = (decisions: unknown[]) => validateTrialGovernanceView(governance({ policyDecisions: decisions }));
  expect(ruleState(g([]), NOW)).toEqual({ kind: 'NONE' });
  expect(ruleState(g([decision()]), NOW)).toMatchObject({ kind: 'IN_FORCE', version: 2 });
  expect(ruleState(g([decision()]), Date.parse('2026-10-01T00:00:00.000Z')).kind).toBe('NOT_YET');
  expect(ruleState(g([decision()]), Date.parse('2027-02-01T00:00:00.000Z')).kind).toBe('EXPIRED');
  const withdrawn = decision({ decisionId: decision2, revision: 2, decision: 'WITHDRAWN', recordedAt: '2026-11-08T10:00:00.000Z' });
  expect(ruleState(g([withdrawn, decision()]), NOW).kind).toBe('WITHDRAWN');
});

it('groups campaign versions and publications by campaign, newest version first', () => {
  const rows = campaignsOf(validateTrialGovernanceView(governance()));
  expect(rows.map((r) => [r.latest.definition.name, r.latest.version, r.status, r.publishedVersion])).toEqual([
    ['Spring pilot schools', 2, 'PUBLISHED', 1], ['Founder schools', 1, 'DRAFT', null]]);
  const withdrawn = campaignsOf(validateTrialGovernanceView(governance({ publications: [publication(),
    publication({ publicationId: id(51), revision: 2, kind: 'WITHDRAWN', previewDigest: null, recordedAt: '2026-11-06T12:00:00.000Z' })] })));
  expect(withdrawn.find((r) => r.campaignId === campaign)).toMatchObject({ status: 'WITHDRAWN', publishedVersion: null });
});

it('shows the program as off, the rules in force, campaigns and history; without onOpen there is no command', () => {
  const html = view(), t = text(html);
  expect(t).toContain('Free Trials');
  expect(t).toContain('The trial program stays off whatever is recorded: no school can sign up for or start a trial, and no promotional credits are issued.');
  expect(t).toContain('Trial sign-up: Disabled');
  expect(t).toContain('Payments: Test mode only');
  expect(t).toContain('Approved rules v2 are in force from Nov 1, 2026, 12:00 AM UTC until Feb 1, 2027, 12:00 AM UTC.');
  expect(t).toContain('Allowed lengths 14 days, 30 days');
  expect(t).toContain('No promotional credits allowed');
  expect(t).toContain('Spring pilot schools');
  expect(t).toContain('Published (definition only)');
  expect(t).toContain('Version 1 is published; version 2 is a newer draft.');
  expect(t).toContain('Nothing is live: no sign-up link works and no school can join.');
  expect(t).toContain('500 credits per school, expiring in 14 days; 100 per day, 20 per request; at most $250.00 for the campaign');
  expect(t).toContain('Published version 1, revision 1');
  // Read only: the only buttons are Refresh and the readiness checks.
  const buttons = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
  expect(buttons).toEqual(['Refresh', 'Check publication readiness', 'Check publication readiness']);
  expect(html).not.toMatch(/<form|<input|<textarea|<select/);
});

it('shows readiness blockers in plain words, unknown codes by name, and the planned exposure as nothing issued', () => {
  const p = validateTrialGovernanceView(governance());
  const blocked = text(view({ preview: { state: 'READY', versionId: v2, preview: preview() as never } }));
  expect(blocked).toContain('Version 2 cannot be published yet:');
  expect(blocked).toContain('It allows more schools than the rules permit.');
  expect(blocked).toContain('Another rule is not met (SOMETHING_NEW).');
  expect(blocked).toContain('If published: up to 25 schools, at most $0.00 in promotional credit value. Nothing is issued now.');
  const ready = text(view({ preview: { state: 'READY', versionId: v2, preview: preview({ ready: true, blockers: [] }) as never } }));
  expect(ready).toContain('Version 2 meets the approved rules and could be published.');
  expect(text(view({ preview: { state: 'UNAVAILABLE', versionId: v2 } }))).toContain('Readiness could not be checked. Nothing changed.');
  expect(text(view({ preview: { state: 'DENIED', versionId: v2 } }))).toContain('Your HQ access does not include this check.');
  expect(p.campaignVersions).toHaveLength(3);
});

it('shows nothing when the read is denied, unavailable or the session ended, and states missing rules honestly', () => {
  expect(text(view({ governance: { state: 'DENIED' } }))).toContain('Your HQ access does not include free-trial governance. Nothing is shown.');
  expect(text(view({ governance: { state: 'UNAVAILABLE' } }))).toContain('This could not be read or checked. Nothing is shown.');
  const hidden = text(view({ concealed: true }));
  expect(hidden).toContain('Hidden while you were away.');
  expect(hidden).not.toContain('Spring pilot schools');
  const none = text(view({ governance: { state: 'READY', view: validateTrialGovernanceView(governance({ policyVersions: [], policyDecisions: [], campaignVersions: [], publications: [] })) } }));
  expect(none).toContain('No decision recorded. Campaigns cannot be published without approved rules.');
  expect(none).toContain('No trial rules have been proposed yet.');
  expect(none).toContain('No trial campaigns have been drafted yet.');
  const more = text(view({ governance: { state: 'READY', view: validateTrialGovernanceView(governance({ hasMore: { policyVersions: true, policyDecisions: false, campaignVersions: false, publications: false } })) } }));
  expect(more).toContain('Only the latest 100 entries are shown here.');
});

it('has every wording key in Korean and Spanish, and is listed under Revenue', () => {
  const keys = Object.keys(TRIALS_LANGUAGES.en).sort();
  for (const language of ['ko', 'es'] as const) expect(Object.keys(TRIALS_LANGUAGES[language]).sort()).toEqual(keys);
  expect(text(view({ language: 'ko' }))).toContain('무료 체험');
  expect(text(view({ language: 'es' }))).toContain('Pruebas gratuitas');
  expect(HQ_REVENUE.some((entry) => entry.path === '/hq/revenue/trials' && entry.title === 'Free Trials')).toBe(true);
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: { path: string }[] };
  expect(manifest.routes.filter((r) => r.path === '/hq/revenue/trials')).toHaveLength(1);
});

const g = () => validateTrialGovernanceView(governance());
const fields = (over: Record<string, string> = {}) => ({ reason: 'Recorded for the pilot cohort', ...over });

it('sends each command as a same-origin POST with its own marker and key, and checks the receipt against the request', async () => {
  const body = { expectedVersion: 2, terms: terms(), reason: 'Third version of the trial rules' };
  const f = stub(json({ data: { policyVersion: policyVersion(id(12), 3, { reason: body.reason }), replayed: false } }));
  const r = await trialsApi.propose(body, id(77), signal(), () => true);
  expect(r.policyVersion.version).toBe(3);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/hq/saas/trials/policy-versions');
  expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'saas-trial-policy-propose', 'Idempotency-Key': id(77) } });
  expect(JSON.parse(init.body as string)).toEqual(body);
  // A receipt for another version is not trusted.
  stub(json({ data: { policyVersion: policyVersion(id(12), 4, { reason: body.reason }), replayed: false } }));
  expect((await fails(trialsApi.propose(body, id(77), signal(), () => true))).kind).toBe('UNKNOWN');
  // Bad input never leaves the browser.
  const none = stub(json({}));
  expect((await fails(trialsApi.propose({ ...body, reason: 'short' }, id(77), signal(), () => true))).kind).toBe('INVALID');
  expect(none).not.toHaveBeenCalled();
  const pf = stub(json({ data: { publication: publication({ revision: 2, versionId: v2, campaignId: campaign }), replayed: true } }));
  const pub = await trialsApi.publish(campaign, { versionId: v2, expectedRevision: 1, previewDigest: DIGEST, confirmation: 'PUBLISH_TRIAL_CAMPAIGN_DEFINITION_ONLY', reason: 'Publishing the larger cohort' }, id(78), signal(), () => true);
  expect(pub.replayed).toBe(true);
  expect((pf.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/hq/saas/trials/campaigns/${campaign}/publish`);
  stub(json({ data: { publication: publication({ revision: 2, kind: 'WITHDRAWN', previewDigest: null }), replayed: false } }));
  expect((await trialsApi.withdraw(campaign, { expectedRevision: 1, reason: 'Pilot paused by HQ owner' }, id(79), signal(), () => true)).publication.kind).toBe('WITHDRAWN');
});

it('maps refusals to definite outcomes and keeps only unknown or rate-limited requests for Try again', () => {
  expect(trialsErrorFor(403, 'SAAS_FORBIDDEN').kind).toBe('DENIED');
  expect(trialsErrorFor(409, 'SAAS_VERSION_CONFLICT').kind).toBe('CHANGED');
  expect(trialsErrorFor(409, 'SAAS_TRIAL_PREVIEW_STALE').kind).toBe('CHANGED');
  expect(trialsErrorFor(409, 'SAAS_TRIAL_POLICY_STALE').kind).toBe('CHANGED');
  expect(trialsErrorFor(422, 'SAAS_TRIAL_PUBLICATION_BLOCKED').kind).toBe('REFUSED');
  expect(trialsErrorFor(422, 'SAAS_TRIAL_POLICY_WINDOW_INVALID').kind).toBe('REFUSED');
  expect(trialsErrorFor(409, 'SAAS_OUTCOME_UNKNOWN').kind).toBe('UNKNOWN');
  expect(trialsErrorFor(422, 'SOMETHING_ELSE').kind).toBe('UNKNOWN');
  expect(trialsErrorFor(409, 'IDEMPOTENCY_KEY_REUSED').kind).toBe('INVALID');
  expect(trialsErrorFor(404, 'SAAS_UNAVAILABLE').kind).toBe('CHANGED');
  expect(trialsErrorFor(503, null).kind).toBe('UNKNOWN');
  expect(keepForRetry(new TrialsError('UNKNOWN'))).toBe(true);
  expect(keepForRetry(new TrialsError('RATE'))).toBe(true);
  for (const kind of ['DENIED', 'CHANGED', 'REFUSED', 'INVALID', 'SESSION'] as const) expect(keepForRetry(new TrialsError(kind))).toBe(false);
  expect(toMinor('250')).toBe(25_000); expect(toMinor('0.5')).toBe(50); expect(toMinor('1.234')).toBeNull(); expect(toMinor('-1')).toBeNull();
  expect(utcDay('2026-11-15')).toBe('2026-11-15T00:00:00.000Z'); expect(utcDay('2026-02-30')).toBeNull(); expect(utcDay('11/15/2026')).toBeNull();
});

it('builds each request from the form and the read it was opened on', () => {
  const propose = trialRequest({ kind: 'propose' }, fields({ dur: '14,30,60', profile: 'COMPLETE', elig: 'HQ_REVIEW_REQUIRED', link: 'PRIVATE_INVITATION,PROMOTIONAL',
    capacity: '30', totalCapacity: '90', windowDays: '60', maxCampaigns: '2', termsReference: 'hon-trial-terms/v2', promo: 'on', promoCredits: '500', promoExpiry: '30',
    promoDaily: '100', promoRequest: '20', promoCost: '250', promoTotal: '1000' }), g(), null);
  expect(propose).toEqual({ action: 'propose', body: { expectedVersion: 2, reason: 'Recorded for the pilot cohort', terms: { allowedDurationsDays: [14, 30, 60],
    allowedCapabilityProfiles: ['COMPLETE'], allowedEligibilityCodes: ['HQ_REVIEW_REQUIRED'], allowedLinkModes: ['PRIVATE_INVITATION', 'PROMOTIONAL'], maxEnrollmentCapacity: 30,
    maxEnrollmentWindowDays: 60, maxPublishedCampaigns: 2, maxTotalEnrollmentCapacity: 90, termsReference: 'hon-trial-terms/v2',
    promotionalLimits: { maxCreditsPerEnrollment: 500, maxCreditExpiryDays: 30, maxDailyCreditCap: 100, maxPerRequestCreditCap: 20, maxCampaignCostMinor: 25_000, maxTotalCampaignCostMinor: 100_000 } } } });
  // Approval names the latest version and the latest decision revision, and needs the confirmation box.
  expect(() => trialRequest({ kind: 'approve' }, fields({ validFrom: '2026-11-10', validUntil: '2027-01-10' }), g(), null)).toThrow(TrialsError);
  expect(trialRequest({ kind: 'approve' }, fields({ validFrom: '2026-11-10', validUntil: '2027-01-10', confirm: 'on' }), g(), null)).toEqual({ action: 'approve', body: {
    decision: 'APPROVED', policyId: policy2, expectedRevision: 1, validFrom: '2026-11-10T00:00:00.000Z', validUntil: '2027-01-10T00:00:00.000Z',
    reason: 'Recorded for the pilot cohort', confirmation: 'APPROVE_CUSTOMER_TRIAL_POLICY_ONLY' } });
  expect(trialRequest({ kind: 'end', decision: 'REVOKED' }, fields(), g(), null)).toEqual({ action: 'end', body: { decision: 'REVOKED', expectedRevision: 1, reason: 'Recorded for the pilot cohort' } });
  // The next version of a campaign expects its newest version.
  const draft = trialRequest({ kind: 'draft', campaignId: campaign }, fields({ name: 'Spring pilot schools', duration: '30', profile: 'COMPLETE', elig: 'NEW_ORGANIZATIONS_ONLY',
    link: 'PRIVATE_INVITATION', opens: '2026-11-15', closes: '2026-12-15', maxEnrollments: '20', termsReference: 'hon-trial-terms/v1' }), g(), null);
  expect(draft).toMatchObject({ action: 'draft', body: { campaignId: campaign, expectedVersion: 2, definition: { maximumEnrollments: 20, promotionalBudget: null } } });
  expect(trialRequest({ kind: 'draft', campaignId: null }, fields({ name: 'New', duration: '14', profile: 'CORE', elig: 'NEW_ORGANIZATIONS_ONLY', link: 'PUBLIC',
    opens: '2026-11-15', closes: '2026-12-15', maxEnrollments: '5', termsReference: 'hon-trial-terms/v1' }), g(), null)).toMatchObject({ body: { campaignId: null, expectedVersion: 0 } });
  expect(() => trialRequest({ kind: 'draft', campaignId: null }, fields({ name: 'New', duration: '14', maxEnrollments: 'ten', opens: '2026-11-15', closes: '2026-12-15' }), g(), null)).toThrow(TrialsError);
  // Publishing is bound to a ready preview of the campaign's newest version: its revision and digest.
  const ready = validateTrialPublicationPreview(preview({ ready: true, blockers: [] }));
  expect(trialRequest({ kind: 'publish', campaignId: campaign }, fields({ confirm: 'on' }), g(), ready)).toEqual({ action: 'publish', campaignId: campaign, body: {
    versionId: v2, expectedRevision: 1, previewDigest: DIGEST, confirmation: 'PUBLISH_TRIAL_CAMPAIGN_DEFINITION_ONLY', reason: 'Recorded for the pilot cohort' } });
  expect(() => trialRequest({ kind: 'publish', campaignId: campaign }, fields({ confirm: 'on' }), g(), validateTrialPublicationPreview(preview()))).toThrow(TrialsError);
  expect(() => trialRequest({ kind: 'publish', campaignId: campaign2 }, fields({ confirm: 'on' }), g(), ready)).toThrow(TrialsError);
  expect(() => trialRequest({ kind: 'publish', campaignId: campaign }, fields(), g(), ready)).toThrow(TrialsError);
  expect(trialRequest({ kind: 'withdraw', campaignId: campaign }, fields(), g(), null)).toEqual({ action: 'withdraw', campaignId: campaign, body: { expectedRevision: 1, reason: 'Recorded for the pilot cohort' } });
  expect(() => trialRequest({ kind: 'withdraw', campaignId: campaign2 }, fields(), g(), null)).toThrow(TrialsError);
});

it('offers the HQ owner commands that fit the current state, each form labelled, and Try again only for a kept request', () => {
  const open = () => {};
  const t = text(view({ onOpen: open, form: null }));
  for (const label of ['Propose new rules', 'Approve rules v2', 'Revoke approval', 'Draft a new campaign', 'Draft next version', 'Withdraw campaign']) expect(t).toContain(label);
  expect(t).not.toContain('Withdraw approval');
  expect(t).not.toContain('Publish version');
  // Publish appears only after a readiness check says the newest version is ready.
  const readyView = text(view({ onOpen: open, form: null, preview: { state: 'READY', versionId: v2, preview: preview({ ready: true, blockers: [] }) as never } }));
  expect(readyView).toContain('Publish version 2');
  const approve = view({ onOpen: open, form: { kind: 'approve' } });
  expect(approve).toContain('data-form="approve"');
  expect(text(approve)).toContain('I approve these trial rules as policy only. This does not turn trials on.');
  for (const name of ['validFrom', 'validUntil', 'confirm', 'reason']) expect(approve).toContain(`name="${name}"`);
  const propose = view({ onOpen: open, form: { kind: 'propose' } });
  const dur = [...propose.matchAll(/<input[^>]*name="dur"[^>]*>/g)].map((m) => [/value="(\d+)"/.exec(m[0])![1], m[0].includes('checked=""')]);
  expect(dur).toEqual([['7', false], ['14', true], ['30', true], ['60', false], ['90', false]]);
  expect(propose).toContain('<legend>Allowed lengths</legend>');
  const publish = text(view({ onOpen: open, form: { kind: 'publish', campaignId: campaign }, preview: { state: 'READY', versionId: v2, preview: preview({ ready: true, blockers: [] }) as never } }));
  expect(publish).toContain('I am publishing this campaign definition only. It does not go live.');
  const unknown = view({ onOpen: open, outcome: { kind: 'UNKNOWN', action: 'publish' }, canRetry: true, locked: true, onTryAgain: open, onStop: open });
  expect(text(unknown)).toContain('Try again sends the exact same request and cannot apply twice.');
  expect(unknown).toMatch(/data-testid="trial-outcome" data-kind="UNKNOWN"/);
  expect([...unknown.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])).toEqual(expect.arrayContaining(['Try again', 'Stop and review']));
  const refused = text(view({ onOpen: open, outcome: { kind: 'REFUSED', action: 'publish' }, canRetry: false }));
  expect(refused).toContain('The trial rules do not allow this');
  expect(refused).not.toContain('Try again');
  expect(text(view({ onOpen: open, outcome: { kind: 'DONE', action: 'publish', replayed: false } }))).toContain('The campaign definition is published. Nothing is live.');
});
