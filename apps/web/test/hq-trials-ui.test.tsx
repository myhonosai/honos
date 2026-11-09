import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { validateTrialGovernanceView } from '@hon/contracts';
import { TRIALS_LANGUAGES } from '../src/components/hq-trials/copy';
import { TrialsError, trialsApi } from '../src/components/hq-trials/http';
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

it('shows the program as off, the rules in force, campaigns and history, with no command anywhere', () => {
  const html = view(), t = text(html);
  expect(t).toContain('Free Trials');
  expect(t).toContain('The trial program is off: no school can sign up for or start a trial, and no promotional credits are issued.');
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
  expect(hidden).toContain('Hidden because your session ended.');
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
