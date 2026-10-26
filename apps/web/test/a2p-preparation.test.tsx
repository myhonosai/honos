import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { A2P_COPY_CONFIRMATION, A2P_FACT_CONFIRMATION, A2P_FINDING_CODES, type A2pDraftInput, type A2pTemplate } from '@hon/contracts';
import { DEFAULT_LOCALE, en, es, ko, translate, type TranslationKey } from '@hon/design-system';
import { evaluateA2pWebsite, generateA2pDraft, type A2pInspection } from '../../../packages/domain/src/a2p-registration';
import {
  parseA2pCopyResponse, parseA2pDraftResponse, parseA2pValidationResponse, parseA2pWebsiteResponse,
} from '../src/components/a2p-registration/preparation-contract';
import { A2P_HTTP_PREPARATION_CLIENT, A2pPreparationError, type A2pPreparationClient } from '../src/components/a2p-registration/preparation-http';
import { A2pPreparationController } from '../src/components/a2p-registration/preparation-controller';
import { A2pPreparationView } from '../src/components/a2p-registration/preparation-view';

vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ t: (key: TranslationKey, params?: Record<string, string | number>) => translate('en', key, params), date: (value: string) => value, preferences: DEFAULT_LOCALE }) }));

/** Synthetic identifiers and facts only; responses come from Codex's real domain functions. */
const SCHOOL = { organizationId: '11111111-1111-4111-8111-111111111111', schoolId: '22222222-2222-4222-8222-222222222222' };
const OTHER = { organizationId: SCHOOL.organizationId, schoolId: '33333333-3333-4333-8333-333333333333' };
const scope = (canConfirmOwnerFacts = true, schoolName = 'Synthetic Dojo') => ({ ...SCHOOL, schoolName, canConfirmOwnerFacts });
const FACTS = {
  businessName: 'Synthetic Dojo', websiteUrl: 'https://dojo.example.com/', privacyUrl: 'https://dojo.example.com/privacy', termsUrl: 'https://dojo.example.com/terms',
  optInUrl: 'https://dojo.example.com/contact', supportContact: 'support@dojo.example.com',
  messageFlow: 'Adults requesting trial information use our public contact form and voluntarily select a separate SMS consent box.', messageFrequency: 'Up to four messages monthly',
};
const DISABLED: A2pInspection = { kind: 'UNAVAILABLE', reason: 'LIVE_INSPECTION_DISABLED' };
const FIXTURE: A2pInspection = { kind: 'SYNTHETIC_FIXTURE', observations: [
  { code: 'PRIVACY_PUBLIC', outcome: 'PRESENT', evidence: [{ id: 'FIX_PRIVACY', url: 'https://dojo.example.com/privacy', provenance: 'SYNTHETIC_FIXTURE', observedAt: '2026-10-25T00:00:00.000Z', excerpt: 'Controlled fixture page. Not live website evidence.' }] },
  { code: 'RATES', outcome: 'MISSING', evidence: [{ id: 'FIX_RATES', url: 'https://dojo.example.com/contact', provenance: 'SYNTHETIC_FIXTURE', observedAt: '2026-10-25T00:00:00.000Z', excerpt: 'Controlled fixture page. Not live website evidence.' }] },
] };
const D1 = 'a'.repeat(64), D2 = 'b'.repeat(64);
const websiteRaw = (inspection: A2pInspection = DISABLED, patch: Record<string, unknown> = {}) => ({ scope: scope(), review: evaluateA2pWebsite(inspection), computationDigest: D1, readOnly: true, persistence: 'NONE', ...patch });
const draftRaw = (input: A2pDraftInput, s = scope(), digest = D2) => ({ scope: s, draft: generateA2pDraft(input, 'Synthetic Dojo'), computationDigest: digest, readOnly: true, persistence: 'NONE' });
const validationRaw = (input: A2pDraftInput, s = scope(), digest = D2) => {
  const raw = draftRaw(input, s, digest);
  return { ...raw, validation: { readyForCopyPreparation: raw.draft.copyPreparationAvailable, missingFields: raw.draft.missingFields, warnings: raw.draft.warnings, providerEligibility: 'NOT_VERIFIED', approval: 'NOT_REQUESTED' } };
};
const input = (patch: Partial<A2pDraftInput> = {}): A2pDraftInput => ({ facts: FACTS, purpose: 'SERVICE_NOTIFICATIONS', templates: ['TRIAL_CONFIRMATION', 'TRIAL_REMINDER'], marketingConsent: 'NOT_APPLICABLE', ownerConfirmation: A2P_FACT_CONFIRMATION, ...patch });
const web = join(__dirname, '..');
const source = (path: string) => readFileSync(join(web, path), 'utf8');

afterEach(() => { vi.unstubAllGlobals(); });

describe('preparation response readers (Codex PR #82 shapes)', () => {
  it('accepts the production review: all 13 checks, every one UNAVAILABLE, no evidence', () => {
    const parsed = parseA2pWebsiteResponse(websiteRaw(), SCHOOL);
    expect(parsed.review.findings.map((f) => f.code)).toEqual([...A2P_FINDING_CODES]);
    expect(parsed.review.findings.every((f) => f.status === 'UNAVAILABLE' && f.reason === 'LIVE_INSPECTION_DISABLED' && f.evidence.length === 0)).toBe(true);
    expect(parsed.review.inspection).toBe('LIVE_INSPECTION_DISABLED');
    expect(parsed.review.sources.length).toBeGreaterThan(0);
  });
  it('refuses any review that claims a scan while inspection is disabled, drops a check, or claims persistence', () => {
    const base = websiteRaw();
    const findings = base.review.findings.map((f) => ({ ...f }));
    const claimed = { ...base, review: { ...base.review, findings: findings.map((f, i) => (i === 1 ? { ...f, status: 'PASS' } : f)) } };
    const evidence = { ...base, review: { ...base.review, findings: findings.map((f, i) => (i === 1 ? { ...f, evidence: FIXTURE.kind === 'SYNTHETIC_FIXTURE' ? FIXTURE.observations[0]!.evidence : [] } : f)) } };
    for (const bad of [claimed, evidence, { ...base, review: { ...base.review, findings: findings.slice(1) } }, { ...base, review: { ...base.review, overallStatus: 'PASS' } },
      { ...base, persistence: 'SAVED' }, { ...base, readOnly: false }, { ...base, scope: { ...base.scope, schoolId: OTHER.schoolId } }, { ...base, computationDigest: 'nope' },
      { ...base, review: { ...base.review, carrierApproval: 'APPROVED' } }, { ...base, extra: 1 }]) {
      expect(() => parseA2pWebsiteResponse(bad, SCHOOL)).toThrow();
    }
  });
  it('keeps fixture evidence, labelled as such, and still never accepts an overall pass', () => {
    const parsed = parseA2pWebsiteResponse(websiteRaw(FIXTURE), SCHOOL);
    expect(parsed.review.inspection).toBe('SYNTHETIC_FIXTURE');
    expect(parsed.review.findings.find((f) => f.code === 'PRIVACY_PUBLIC')!.evidence[0]!.provenance).toBe('SYNTHETIC_FIXTURE');
    expect(parsed.review.findings.find((f) => f.code === 'HELP')!.status).toBe('UNAVAILABLE');
  });
  it('accepts real drafts and refuses saved, sent, non-English or inconsistent ones', () => {
    const templates: A2pTemplate[] = ['TRIAL_CONFIRMATION', 'TRIAL_REMINDER'];
    const ready = parseA2pDraftResponse(draftRaw(input()), SCHOOL, templates);
    expect(ready.draft.state).toBe('DRAFT_FOR_OWNER_REVIEW');
    expect(ready.draft.sampleMessages).toHaveLength(2);
    const incomplete = parseA2pDraftResponse(draftRaw(input({ ownerConfirmation: 'NOT_CONFIRMED' })), SCHOOL, templates);
    expect(incomplete.draft.missingFields).toContain('ownerConfirmation');
    expect(incomplete.draft.answers).toBeNull();
    const raw = draftRaw(input());
    for (const patch of [{ saved: true }, { submitted: true }, { messagesSent: 1 }, { consentRecorded: true }, { language: 'ko' }, { copyPreparationAvailable: false }, { missingFields: ['businessName'] }, { answers: null }]) {
      expect(() => parseA2pDraftResponse({ ...raw, draft: { ...raw.draft, ...patch } }, SCHOOL, templates)).toThrow();
    }
    expect(() => parseA2pDraftResponse(raw, SCHOOL, ['CLASS_CHANGE'])).toThrow();
    const v = validationRaw(input());
    expect(parseA2pValidationResponse(v, SCHOOL, templates).validation.readyForCopyPreparation).toBe(true);
    expect(() => parseA2pValidationResponse({ ...v, validation: { ...v.validation, approval: 'APPROVED' } }, SCHOOL, templates)).toThrow();
    expect(() => parseA2pValidationResponse({ ...v, validation: { ...v.validation, readyForCopyPreparation: false } }, SCHOOL, templates)).toThrow();
  });
  it('accepts copy text only for the expected digest and never a submitted one', () => {
    const copy = { scope: scope(), computationDigest: D2, format: 'TEXT', filename: 'hon-a2p-draft.txt', content: 'text', readOnly: true, persistence: 'NONE', submitted: false, messagesSent: 0 };
    expect(parseA2pCopyResponse(copy, SCHOOL, D2).content).toBe('text');
    expect(() => parseA2pCopyResponse(copy, SCHOOL, D1)).toThrow();
    expect(() => parseA2pCopyResponse({ ...copy, submitted: true }, SCHOOL, D2)).toThrow();
    expect(() => parseA2pCopyResponse({ ...copy, filename: '../x.txt' }, SCHOOL, D2)).toThrow();
  });
});

type Call = { url: string; init: RequestInit };
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('location', { origin: 'https://hon.example' });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return handler(url, init); }));
  return calls;
}
const json = (status: number, body: unknown, cache = 'private, no-store') => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': cache } });

describe('HTTP adapter for the five POST routes', () => {
  it('resolves scope from the verified current school and posts JSON with the human-command posture and no idempotency key', async () => {
    const calls = stubFetch((url) => {
      if (url === '/api/v1/staff/current-reporting-school') return json(200, { data: { state: 'RESOLVED', ...SCHOOL } });
      if (url.endsWith('/website-review') || url.endsWith('/finding-details')) return json(200, { data: url.endsWith('/website-review') ? websiteRaw() : { scope: scope(), finding: evaluateA2pWebsite(DISABLED).findings[10], sources: evaluateA2pWebsite(DISABLED).sources, readOnly: true, persistence: 'NONE' } });
      if (url.endsWith('/registration-draft')) return json(200, { data: draftRaw(input()) });
      if (url.endsWith('/draft-validation')) return json(200, { data: validationRaw(input()) });
      return json(200, { data: { scope: scope(), computationDigest: D2, format: 'TEXT', filename: 'hon-a2p-draft.txt', content: 'text', readOnly: true, persistence: 'NONE', submitted: false, messagesSent: 0 } });
    });
    const client = A2P_HTTP_PREPARATION_CLIENT;
    const school = await client.currentSchool();
    expect(school).toEqual(SCHOOL);
    const review = { websiteUrl: FACTS.websiteUrl, businessName: FACTS.businessName, privacyUrl: null, termsUrl: null, optInUrl: null, messageFlow: null };
    await client.websiteReview(school, review);
    await client.findingDetails(school, review, 'HELP');
    await client.registrationDraft(school, input());
    await client.draftValidation(school, input());
    await client.copyPreparation(school, input(), D2);
    const posts = calls.filter((call) => call.init.method === 'POST');
    expect(posts.map((call) => call.url)).toEqual(['website-review', 'finding-details', 'registration-draft', 'draft-validation', 'copy-preparation']
      .map((route) => `/api/v1/organizations/${SCHOOL.organizationId}/schools/${SCHOOL.schoolId}/a2p/${route}`));
    for (const call of posts) {
      expect(call.init).toMatchObject({ mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
      expect(call.init.headers).toEqual({ 'Content-Type': 'application/json', Accept: 'application/json', 'X-HON-Human-Command': 'a2p-prepare' });
      expect(call.url).not.toContain('?');
      expect(call.url).not.toContain('dojo');
    }
    expect(JSON.parse(posts[1]!.init.body as string)).toEqual({ review, findingCode: 'HELP' });
    expect(JSON.parse(posts[4]!.init.body as string)).toEqual({ input: input(), expectedDigest: D2, acknowledgement: A2P_COPY_CONFIRMATION });
  });
  it('maps only closed error codes for their own status and refuses cacheable or reshaped success', async () => {
    const cases: Array<[Response, string]> = [
      [json(401, {}), 'UNAUTHORIZED'], [json(403, { code: 'A2P_OWNER_FACT_CONFIRMATION_REQUIRED' }), 'OWNER_CONFIRMATION_REQUIRED'],
      [json(403, { code: 'A2P_PREPARATION_FORBIDDEN' }), 'DENIED'], [json(403, { code: 'SOMETHING_ELSE' }), 'DENIED'],
      [json(400, { code: 'A2P_URL_NOT_ALLOWED' }), 'URL_NOT_ALLOWED'], [json(400, { code: 'A2P_DRAFT_CHANGED' }), 'INVALID_INPUT'],
      [json(409, { code: 'A2P_SCHOOL_CHANGED' }), 'SCHOOL_CHANGED'], [json(409, { code: 'A2P_DRAFT_INCOMPLETE' }), 'DRAFT_INCOMPLETE'],
      [json(503, { code: 'A2P_PREPARATION_UNAVAILABLE' }), 'UNAVAILABLE'], [json(500, { message: 'select * from secrets' }), 'UNAVAILABLE'],
      [json(200, { data: draftRaw(input()) }, 'max-age=60'), 'INVALID_RESPONSE'], [json(200, { data: draftRaw(input()), extra: 1 }), 'INVALID_RESPONSE'],
      [json(200, { data: { ...draftRaw(input()), persistence: 'SAVED' } }), 'INVALID_RESPONSE'],
    ];
    for (const [response, kind] of cases) {
      stubFetch(() => response);
      await expect(A2P_HTTP_PREPARATION_CLIENT.registrationDraft(SCHOOL, input())).rejects.toMatchObject({ kind });
    }
    stubFetch(() => json(200, { data: { state: 'MANUAL_ENTRY_REQUIRED' } }));
    await expect(A2P_HTTP_PREPARATION_CLIENT.currentSchool()).rejects.toMatchObject({ kind: 'NO_SCHOOL' });
    await expect(A2P_HTTP_PREPARATION_CLIENT.copyPreparation(SCHOOL, input(), 'not-a-digest')).rejects.toMatchObject({ kind: 'DRAFT_CHANGED' });
  });
});

/** In-memory client that answers with Codex's real domain output and records every request. */
function fakeClient(options: { canConfirm?: boolean; deny?: boolean; school?: () => typeof SCHOOL } = {}) {
  const calls: Array<{ route: string; body?: unknown }> = [];
  let canConfirm = options.canConfirm ?? true;
  let gate: Promise<void> | null = null;
  let failNext: A2pPreparationError | null = null;
  const step = async (route: string, body?: unknown) => {
    calls.push({ route, body });
    if (gate) await gate;
    if (failNext) { const error = failNext; failNext = null; throw error; }
    if (options.deny) throw new A2pPreparationError('DENIED');
  };
  const client: A2pPreparationClient = {
    async currentSchool() { calls.push({ route: 'current-school' }); return options.school?.() ?? SCHOOL; },
    async websiteReview(school, review) { await step('website-review', review); return parseA2pWebsiteResponse({ ...websiteRaw(), scope: scope(canConfirm) }, school); },
    async findingDetails() { throw new Error('unused'); },
    async registrationDraft(school, body) { await step('registration-draft', body); return parseA2pDraftResponse(draftRaw(body, scope(canConfirm)), school, body.templates); },
    async draftValidation(school, body) { await step('draft-validation', body); return parseA2pValidationResponse(validationRaw(body, scope(canConfirm)), school, body.templates); },
    async copyPreparation(school, body, digest) {
      await step('copy-preparation', { body, digest });
      return parseA2pCopyResponse({ scope: scope(canConfirm), computationDigest: digest, format: 'TEXT', filename: 'hon-a2p-draft.txt', content: 'Draft text', readOnly: true, persistence: 'NONE', submitted: false, messagesSent: 0 }, school, digest);
    },
  };
  return {
    client, calls,
    revokeOwner() { canConfirm = false; },
    hold() { let release!: () => void; gate = new Promise((done) => { release = done; }); return () => { gate = null; release(); }; },
    failOnce(kind: ConstructorParameters<typeof A2pPreparationError>[0]) { failNext = new A2pPreparationError(kind); },
  };
}
function fill(controller: A2pPreparationController) { for (const [key, value] of Object.entries(FACTS)) controller.setFact(key as keyof typeof FACTS, value); }

describe('connected controller', () => {
  it('learns authority from a fact-free probe and stops when access is denied', async () => {
    const ok = fakeClient();
    const controller = new A2pPreparationController(ok.client);
    await controller.load();
    expect(controller.snapshot().access).toMatchObject({ state: 'READY', scope: { canConfirmOwnerFacts: true, schoolName: 'Synthetic Dojo' } });
    expect((ok.calls[1]!.body as A2pDraftInput).facts).toEqual(Object.fromEntries(Object.keys(FACTS).map((key) => [key, null])));
    const denied = new A2pPreparationController(fakeClient({ deny: true }).client);
    await denied.load();
    expect(denied.snapshot().access.state).toBe('DENIED');
  });
  it('validates facts with the server rules before any request and shows all 13 unchecked items', async () => {
    const f = fakeClient();
    const controller = new A2pPreparationController(f.client);
    await controller.load();
    await controller.reviewWebsite();
    expect(controller.snapshot().factErrors.websiteUrl).toBe('REQUIRED');
    controller.setFact('websiteUrl', 'https://dojo.test/');
    controller.setFact('privacyUrl', 'http://dojo.example.com/privacy');
    await controller.reviewWebsite();
    expect(controller.snapshot().factErrors).toMatchObject({ websiteUrl: 'URL_NOT_ALLOWED', privacyUrl: 'URL_NOT_ALLOWED' });
    expect(f.calls.some((call) => call.route === 'website-review')).toBe(false);
    fill(controller);
    await controller.reviewWebsite();
    const review = controller.snapshot().review.result!.review;
    expect(review.findings).toHaveLength(13);
    expect(review.findings.every((finding) => finding.status === 'UNAVAILABLE')).toBe(true);
    controller.setFact('businessName', 'Synthetic Dojo North');
    expect(controller.snapshot().review.phase).toBe('IDLE');
  });
  it('sends the owner attestation only with server authority, and drops it when authority is lost', async () => {
    const staff = fakeClient({ canConfirm: false });
    const asStaff = new A2pPreparationController(staff.client);
    await asStaff.load();
    fill(asStaff);
    asStaff.setOwnerConfirmed(true);
    expect(asStaff.snapshot().ownerConfirmed).toBe(false);
    await asStaff.generateDraft();
    expect((staff.calls.at(-1)!.body as A2pDraftInput).ownerConfirmation).toBe('NOT_CONFIRMED');
    expect(asStaff.snapshot().draft.result!.draft.missingFields).toContain('ownerConfirmation');

    const owner = fakeClient();
    const asOwner = new A2pPreparationController(owner.client);
    await asOwner.load();
    fill(asOwner);
    asOwner.setOwnerConfirmed(true);
    await asOwner.generateDraft();
    expect((owner.calls.at(-1)!.body as A2pDraftInput).ownerConfirmation).toBe(A2P_FACT_CONFIRMATION);
    expect(asOwner.snapshot().draft.result!.draft.state).toBe('DRAFT_FOR_OWNER_REVIEW');
    owner.revokeOwner();
    await asOwner.validateDraft();
    expect(asOwner.snapshot()).toMatchObject({ ownerConfirmed: false, validation: { phase: 'IDLE' }, draft: { phase: 'IDLE' } });
    expect(asOwner.snapshot().access).toMatchObject({ scope: { canConfirmOwnerFacts: false } });

    const rejected = fakeClient();
    const c = new A2pPreparationController(rejected.client);
    await c.load();
    fill(c);
    c.setOwnerConfirmed(true);
    rejected.failOnce('OWNER_CONFIRMATION_REQUIRED');
    await c.generateDraft();
    expect(c.snapshot()).toMatchObject({ ownerConfirmed: false, draft: { phase: 'FAILED', error: 'OWNER_CONFIRMATION_REQUIRED' } });
  });
  it('keeps purpose and templates consistent with the campaign rules', async () => {
    const controller = new A2pPreparationController(fakeClient().client);
    await controller.load();
    controller.setPurpose('MARKETING');
    expect(controller.snapshot()).toMatchObject({ templates: ['PROMOTIONAL'], marketingConsent: 'NOT_CONFIRMED' });
    controller.setPurpose('MIXED');
    expect(controller.snapshot().templates).toEqual(['TRIAL_CONFIRMATION', 'PROMOTIONAL']);
    controller.setPurpose('SERVICE_NOTIFICATIONS');
    expect(controller.snapshot()).toMatchObject({ templates: ['TRIAL_CONFIRMATION'], marketingConsent: 'NOT_APPLICABLE' });
    for (const t of ['TRIAL_REMINDER', 'ENROLLMENT_FOLLOW_UP', 'CLASS_CHANGE', 'SCHOOL_CLOSURE', 'TUITION_NOTIFICATION'] as const) controller.toggleTemplate(t);
    expect(controller.snapshot()).toMatchObject({ campaignError: 'TEMPLATES' });
    expect(controller.snapshot().templates).toHaveLength(5);
  });
  it('copies only a validated draft, with its digest and acknowledgement, and needs a fresh check after a change', async () => {
    const f = fakeClient();
    const controller = new A2pPreparationController(f.client);
    await controller.load();
    fill(controller);
    controller.setOwnerConfirmed(true);
    await controller.prepareCopy();
    expect(f.calls.some((call) => call.route === 'copy-preparation')).toBe(false);
    await controller.validateDraft();
    expect(controller.copyDigest()).toBe(D2);
    await controller.prepareCopy();
    expect(f.calls.some((call) => call.route === 'copy-preparation')).toBe(false);
    controller.setCopyAcknowledged(true);
    await controller.prepareCopy();
    expect(f.calls.at(-1)).toMatchObject({ route: 'copy-preparation', body: { digest: D2 } });
    expect(controller.snapshot().copy.result!.content).toBe('Draft text');
    controller.setFact('messageFrequency', 'Two messages monthly');
    expect(controller.snapshot()).toMatchObject({ ownerConfirmed: false, copyAcknowledged: false, copy: { phase: 'IDLE' }, validation: { phase: 'IDLE' } });
    expect(controller.copyDigest()).toBeNull();
    controller.setOwnerConfirmed(true);
    await controller.validateDraft();
    controller.setCopyAcknowledged(true);
    f.failOnce('DRAFT_CHANGED');
    await controller.prepareCopy();
    expect(controller.snapshot()).toMatchObject({ copy: { phase: 'FAILED', error: 'DRAFT_CHANGED' }, validation: { phase: 'IDLE' } });
  });
  it('clears everything on a school change, session loss or denial, and late responses never repaint', async () => {
    let current = SCHOOL;
    const f = fakeClient({ school: () => current });
    const controller = new A2pPreparationController(f.client);
    await controller.load();
    fill(controller);
    await controller.reviewWebsite();
    current = OTHER;
    await controller.generateDraft();
    expect(controller.snapshot()).toMatchObject({ cleared: 'SCHOOL_CHANGED', review: { phase: 'IDLE', result: null }, draft: { phase: 'IDLE' } });
    expect(controller.snapshot().facts.businessName).toBe('');
    expect(f.calls.filter((call) => call.route === 'registration-draft')).toHaveLength(0);

    const g = fakeClient();
    const c = new A2pPreparationController(g.client);
    await c.load();
    fill(c);
    const release = g.hold();
    const pending = c.reviewWebsite();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    await c.visibility(false);
    release();
    await pending;
    expect(c.snapshot()).toMatchObject({ cleared: 'HIDDEN', review: { phase: 'IDLE', result: null } });
    expect(c.snapshot().facts.businessName).toBe(FACTS.businessName);

    g.failOnce('UNAUTHORIZED');
    await c.reviewWebsite();
    expect(c.snapshot()).toMatchObject({ access: { state: 'UNAUTHORIZED' }, cleared: 'SESSION', review: { result: null } });
    expect(c.snapshot().facts.businessName).toBe('');
  });
});

describe('connected rendering', () => {
  async function ready(canConfirm = true) {
    const f = fakeClient({ canConfirm });
    const controller = new A2pPreparationController(f.client);
    await controller.load();
    fill(controller);
    controller.setOwnerConfirmed(true);
    await controller.reviewWebsite();
    await controller.generateDraft();
    await controller.validateDraft();
    controller.setCopyAcknowledged(true);
    await controller.prepareCopy();
    return controller;
  }
  const render = (controller: A2pPreparationController, step: 'CHECK_WEBSITE' | 'FIX_WEBSITE' | 'ANSWERS' | 'REVIEW' | 'STATUS', theme: 'modern' | 'classic' | 'big-button' = 'modern') =>
    renderToStaticMarkup(<A2pPreparationView controller={controller} snapshot={controller.snapshot()} theme={theme} initialStep={step} />);

  it('shows all 13 checks as Not checked, with sources, and never a scan, pass or approval claim', async () => {
    const controller = await ready();
    const facts = render(controller, 'CHECK_WEBSITE');
    expect(facts).toContain('data-testid="a2p-prep-inspection-disabled"');
    expect(facts).toContain(en['a2p.prep.facts.noCrawl']);
    const checks = render(controller, 'FIX_WEBSITE', 'classic');
    for (const code of A2P_FINDING_CODES) expect(checks).toContain(`>${en[`a2p.prep.code.${code}.title` as TranslationKey]}<`);
    expect(checks.match(/data-outcome="UNAVAILABLE"/g)).toHaveLength(13);
    expect(checks.match(/data-testid="a2p-prep-no-evidence"/g)).toHaveLength(13);
    expect(checks).toContain('Twilio: campaign registration fields');
    expect(checks).toContain('rel="noopener noreferrer"');
    expect(checks).not.toMatch(/Found in evidence<\/span>|Synthetic fixture · not your website/);
    for (const step of ['CHECK_WEBSITE', 'FIX_WEBSITE', 'ANSWERS', 'REVIEW'] as const) {
      const html = render(controller, step);
      for (const claim of ['a2p.provenance.VERIFIED', 'a2p.answers.saved', 'a2p.status.APPROVED', 'a2p.status.SUBMITTED', 'a2p.check.done'] as const) expect(html).not.toContain(`>${en[claim]}<`);
      expect(html).not.toMatch(/\bcompliant\b|you are approved|guaranteed/i);
      expect(html).toMatch(/<textarea[^>]*disabled/);
    }
  });
  it('labels the English-only draft, keeps it unverified, and shows copy text with a disabled submit', async () => {
    const controller = await ready();
    const answers = render(controller, 'ANSWERS', 'big-button');
    expect(answers).toContain(en['a2p.prep.englishOnly']);
    expect(answers).toContain('lang="en"');
    expect(answers).toContain('Unverified draft');
    expect(answers).toContain('Synthetic Dojo: Your requested trial is scheduled');
    const review = render(controller, 'REVIEW');
    expect(review).toContain('data-testid="a2p-prep-copy-result"');
    expect(review).toContain('Download hon-a2p-draft.txt');
    expect(review).toContain(en['a2p.prep.final.NOT_VERIFIED']);
    expect(review).toMatch(/<button[^>]*disabled[^>]*>Submit registration/);
    expect(render(controller, 'STATUS')).toContain('data-testid="a2p-status-unavailable"');
  });
  it('disables the owner attestation for staff and explains why', async () => {
    const controller = await ready(false);
    const html = render(controller, 'ANSWERS');
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*disabled[^>]*data-testid="a2p-prep-attest"/);
    expect(html).toContain('data-testid="a2p-prep-attest-unavailable"');
    expect(render(controller, 'REVIEW')).toContain('data-testid="a2p-prep-copy-locked"');
  });
  it('renders denied and session-expired states without any school data', async () => {
    const denied = new A2pPreparationController(fakeClient({ deny: true }).client);
    await denied.load();
    const html = render(denied, 'CHECK_WEBSITE');
    expect(html).toContain('data-testid="a2p-prep-DENIED"');
    expect(html).not.toContain('Synthetic Dojo');
  });
});

describe('localization and boundaries for the connected assistant', () => {
  it('ships Korean and Spanish copy for every preparation key', () => {
    const keys = Object.keys(en).filter((key) => key.startsWith('a2p.prep.'));
    expect(keys.length).toBeGreaterThan(200);
    for (const catalog of [ko, es] as Array<Record<string, string>>) for (const key of keys) expect(catalog[key]?.trim(), key).toBeTruthy();
    expect(ko['a2p.prep.intro' as keyof typeof ko]).not.toBe(en['a2p.prep.intro' as keyof typeof en]);
  });
  it('production uses only the HTTP adapter; no storage, raw HTML, idempotency keys or provider calls', () => {
    const entry = source('src/components/a2p-registration/production-entry.tsx');
    expect(entry).toContain('A2P_HTTP_PREPARATION_CLIENT');
    expect(entry).not.toMatch(/synthetic-fixtures|createSyntheticA2pAdapter|A2P_NOT_CONNECTED_ADAPTER/);
    const files = ['preparation-contract.ts', 'preparation-http.ts', 'preparation-controller.ts', 'preparation-view.tsx', 'production-entry.tsx'].map((file) => source(`src/components/a2p-registration/${file}`)).join('\n');
    expect(files).not.toMatch(/localStorage|sessionStorage|indexedDB|dangerouslySetInnerHTML|Idempotency-Key|twilio\.com\/|sendSms|navigator\.sendBeacon/i);
    expect(source('src/components/a2p-registration/preparation-http.ts').match(/fetch\(/g)).toHaveLength(1);
  });
});
