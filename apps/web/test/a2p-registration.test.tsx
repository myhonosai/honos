import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOCALE, en, es, ko, translate, type TranslationKey } from '@hon/design-system';
import {
  A2P_ANSWER_KEYS, A2P_REGISTRATION_STATUSES, normalizeWebsiteInput, type A2pStep, parseAnswerSet, parseFinding, parseStatusView, parseWebsiteCheck, safeExternalUrl,
} from '../src/components/a2p-registration/contract';
import { A2P_NOT_CONNECTED_ADAPTER, A2pNotConnectedError, type A2pRegistrationAdapter } from '../src/components/a2p-registration/adapter';
import { A2pController, a2pReadiness, answerProvenance, answerValue } from '../src/components/a2p-registration/controller';
import { createSyntheticA2pAdapter } from '../src/components/a2p-registration/synthetic-fixtures';
import { A2pRegistrationView, buildA2pExport } from '../src/components/a2p-registration/a2p-registration-view';

vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ t: (key: TranslationKey, params?: Record<string, string | number>) => translate('en', key, params), date: (value: string) => value, preferences: DEFAULT_LOCALE }) }));

const t = (key: TranslationKey, params?: Readonly<Record<string, string | number>>) => translate('en', key, params);
const noSleep = () => Promise.resolve();
let n = 0;
const keys = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const web = join(__dirname, '..');
const source = (path: string) => readFileSync(join(web, path), 'utf8');

async function syntheticFlow(scenario: Parameters<typeof createSyntheticA2pAdapter>[0] = 'ready') {
  const controller = new A2pController(createSyntheticA2pAdapter(scenario), { sleep: noSleep, newKey: keys });
  await controller.load();
  controller.setWebsiteInput('sample-dojo.example');
  await controller.startWebsiteCheck();
  return controller;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('A2P contract parsers never upgrade an unknown value', () => {
  it('maps unknown states to UNKNOWN / UNABLE_TO_VERIFY / UNVERIFIED_DRAFT and requires evidence for a pass', () => {
    expect(parseWebsiteCheck({ state: 'DONE_ISH' }).state).toBe('UNKNOWN');
    expect(parseStatusView({ status: 'APPROVED!!' }).status).toBe('UNKNOWN');
    expect(parseFinding({ id: 'a', outcome: 'GREAT' })!.outcome).toBe('UNABLE_TO_VERIFY');
    expect(parseFinding({ id: 'a', outcome: 'PASSED' })!.outcome).toBe('UNABLE_TO_VERIFY');
    expect(parseFinding({ id: 'a', outcome: 'PASSED', observedAt: '2026-10-25T09:00:00Z' })!.outcome).toBe('PASSED');
    expect(parseFinding({ outcome: 'PASSED' })).toBeNull();
    const set = parseAnswerSet({ answers: [{ key: 'HELP_RESPONSE', value: 'x', provenance: 'TRUST_ME' }, { key: 'NOT_A_FIELD', value: 'y' }] });
    expect(set.answers.find((answer) => answer.key === 'HELP_RESPONSE')!.provenance).toBe('UNVERIFIED_DRAFT');
    expect(set.answers.map((answer) => answer.key)).toEqual([...A2P_ANSWER_KEYS]);
  });
  it('shows findings only for a completed check and confirmations only with a recorded time', () => {
    expect(parseWebsiteCheck({ state: 'CHECKING', findings: [{ id: 'a', outcome: 'NEEDS_FIXING' }] }).findings).toEqual([]);
    const set = parseAnswerSet({ confirmations: [{ key: 'CONSENT_ONLY', confirmed: true }, { key: 'NO_SHARING', confirmed: true, confirmedAt: '2026-10-25T09:00:00Z' }] });
    expect(set.confirmations.find((item) => item.key === 'CONSENT_ONLY')!.confirmed).toBe(false);
    expect(set.confirmations.find((item) => item.key === 'NO_SHARING')!.confirmed).toBe(true);
  });
  it('allows only plain http(s) links from the server', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('https://user:pw@sample-dojo.example/')).toBeNull();
    expect(safeExternalUrl('https://sample-dojo.example/privacy')).toBe('https://sample-dojo.example/privacy');
    expect(parseFinding({ id: 'a', location: { pageUrl: 'data:text/html,hi' } })!.location.pageUrl).toBeNull();
  });
  it('tidies what the owner types and refuses local or credentialed addresses', () => {
    expect(normalizeWebsiteInput(' sample-dojo.example ')).toEqual({ ok: true, url: 'https://sample-dojo.example/' });
    expect(normalizeWebsiteInput('')).toEqual({ ok: false, reason: 'EMPTY' });
    expect(normalizeWebsiteInput('not a site')).toEqual({ ok: false, reason: 'INVALID' });
    for (const value of ['localhost', 'http://127.0.0.1', 'https://a.example:8443', 'ftp://a.example', 'https://u:p@a.example', 'intranet', 'printer.local']) expect(normalizeWebsiteInput(value).ok).toBe(false);
  });
});

describe('production adapter is not connected and performs no network request', () => {
  it('reports NOT_CONNECTED, refuses every command and never calls fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const controller = new A2pController(A2P_NOT_CONNECTED_ADAPTER, { sleep: noSleep, newKey: keys });
    await controller.load();
    controller.setWebsiteInput('sample-dojo.example');
    await controller.startWebsiteCheck();
    await controller.draftAnswers();
    controller.editAnswer('HELP_RESPONSE', 'My own wording');
    await controller.saveAnswers();
    await controller.setConfirmation('CONSENT_ONLY', true);
    const snapshot = controller.snapshot();
    expect(snapshot.availability).toEqual({ state: 'NOT_CONNECTED' });
    expect(snapshot.check).toBeNull();
    expect(snapshot.checkPhase).toBe('IDLE');
    expect(snapshot.answerPhase).toBe('IDLE');
    expect(snapshot.savePhase).toBe('IDLE');
    expect(snapshot.status).toEqual({ state: 'UNAVAILABLE' });
    expect(snapshot.answers.confirmations.every((item) => !item.confirmed)).toBe(true);
    expect(answerValue(snapshot, 'HELP_RESPONSE')).toBe('My own wording');
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const call of [() => A2P_NOT_CONNECTED_ADAPTER.startWebsiteCheck('https://a.example/', 'k'), () => A2P_NOT_CONNECTED_ADAPTER.registrationStatus(), () => A2P_NOT_CONNECTED_ADAPTER.draftAnswers('k')]) {
      await expect(call()).rejects.toBeInstanceOf(A2pNotConnectedError);
    }
  });
  it('refuses a READY response that claims synthetic data from a non-synthetic adapter', async () => {
    const adapter: A2pRegistrationAdapter = { ...A2P_NOT_CONNECTED_ADAPTER, source: 'SERVER', availability: async () => ({ state: 'READY', source: 'SYNTHETIC_FIXTURE', capabilities: { websiteCheck: true, findingReview: true, answerDrafts: true, saveAnswers: true, ownerConfirmations: true, registrationStatus: true, assistant: true } }) };
    const controller = new A2pController(adapter);
    await controller.load();
    expect(controller.snapshot().availability).toEqual({ state: 'ERROR' });
  });
});

describe('synthetic preview flow through the controller', () => {
  it('polls a website check to completion and keeps the four outcome groups', async () => {
    const controller = await syntheticFlow();
    const snapshot = controller.snapshot();
    expect(snapshot.checkPhase).toBe('DONE');
    expect(snapshot.check!.findings.map((finding) => finding.outcome).sort()).toEqual(['NEEDS_FIXING', 'NEEDS_FIXING', 'NEEDS_FIXING', 'PASSED', 'PASSED', 'REVIEW_REQUIRED', 'UNABLE_TO_VERIFY']);
    expect(a2pReadiness(snapshot).label).toBe('OPEN_ITEMS');
  });
  it('reports a failed check and a stalled check without showing results', async () => {
    const failed = await syntheticFlow('check-failed');
    expect(failed.snapshot().checkPhase).toBe('FAILED');
    expect(failed.snapshot().check!.findings).toEqual([]);
    const stalled = new A2pController(createSyntheticA2pAdapter('ready'), { sleep: noSleep, maxPolls: 1, newKey: keys });
    await stalled.load();
    stalled.setWebsiteInput('sample-dojo.example');
    await stalled.startWebsiteCheck();
    expect(stalled.snapshot().checkPhase).toBe('TIMED_OUT');
    expect(stalled.snapshot().check!.findings).toEqual([]);
  });
  it('resumes an unfinished check on load and shows progress, never a guessed result', async () => {
    const controller = new A2pController(createSyntheticA2pAdapter('checking'), { sleep: noSleep, maxPolls: 3, newKey: keys });
    await controller.load();
    expect(['POLLING', 'TIMED_OUT']).toContain(controller.snapshot().checkPhase);
    await vi.waitFor(() => expect(controller.snapshot().checkPhase).toBe('TIMED_OUT'));
    expect(controller.snapshot().check!.pagesChecked).toBe(2);
    expect(controller.snapshot().check!.findings).toEqual([]);
  });
  it('rejects bad input before any adapter call', async () => {
    const adapter = createSyntheticA2pAdapter('ready');
    const start = vi.spyOn(adapter, 'startWebsiteCheck');
    const controller = new A2pController(adapter, { sleep: noSleep });
    await controller.load();
    controller.setWebsiteInput('localhost');
    await controller.startWebsiteCheck();
    expect(controller.snapshot().inputError).toBe('UNSUPPORTED');
    expect(start).not.toHaveBeenCalled();
  });
  it('marks findings for review, drafts answers, keeps edits local until an explicit save and records confirmations', async () => {
    const controller = await syntheticFlow();
    await controller.toggleReview('syn-business-name');
    expect(controller.snapshot().check!.findings.find((finding) => finding.id === 'syn-business-name')!.review).toBe('MARKED_FOR_REVIEW');
    await controller.draftAnswers();
    const drafted = controller.snapshot();
    expect(drafted.answers.answers.find((answer) => answer.key === 'WEBSITE_URL')!.provenance).toBe('VERIFIED');
    expect(drafted.answers.answers.find((answer) => answer.key === 'HELP_RESPONSE')!.provenance).toBe('OWNER_CONFIRMED');
    expect(drafted.answers.contradictions).toHaveLength(2);
    controller.editAnswer('STOP_RESPONSE', 'Sample Dojo: You are unsubscribed. No more texts will be sent.');
    expect(controller.snapshot().edits.STOP_RESPONSE).toBeDefined();
    expect(a2pReadiness(controller.snapshot()).unsavedEdits).toBe(1);
    await controller.saveAnswers();
    expect(controller.snapshot().savePhase).toBe('SAVED');
    expect(controller.snapshot().edits).toEqual({});
    expect(answerValue(controller.snapshot(), 'STOP_RESPONSE')).toContain('No more texts');
    await controller.setConfirmation('CONSENT_ONLY', true);
    expect(controller.snapshot().answers.confirmations.find((item) => item.key === 'CONSENT_ONLY')!.confirmed).toBe(true);
  });
  it('keeps edits and reports UNKNOWN when a save cannot be confirmed', async () => {
    const adapter = createSyntheticA2pAdapter('ready');
    vi.spyOn(adapter, 'saveAnswers').mockRejectedValue(new Error('network'));
    const controller = new A2pController(adapter, { sleep: noSleep, newKey: keys });
    await controller.load();
    await controller.draftAnswers();
    controller.editAnswer('CAMPAIGN_DESCRIPTION', 'Changed');
    await controller.saveAnswers();
    expect(controller.snapshot().savePhase).toBe('UNKNOWN');
    expect(controller.snapshot().edits.CAMPAIGN_DESCRIPTION).toBe('Changed');
  });
});

const READY_ALL = { state: 'READY' as const, source: 'SERVER' as const, capabilities: { websiteCheck: true, findingReview: true, answerDrafts: true, saveAnswers: true, ownerConfirmations: true, registrationStatus: false, assistant: false } };
const observedFinding = (id: string, outcome = 'PASSED') => ({ id, area: 'PRIVACY_POLICY', outcome, title: id, explanation: 'x', whyItMatters: 'y', location: { pageUrl: 'https://school.example.com/privacy', sectionLabel: 'Footer' }, originalText: 'We may share data.', suggestedText: 'We never share numbers.', observedAt: '2026-10-25T09:00:00Z', review: 'NONE' });
function serverAdapter(inspection: unknown, overrides: Partial<A2pRegistrationAdapter> = {}): A2pRegistrationAdapter {
  return { ...A2P_NOT_CONNECTED_ADAPTER, source: 'SERVER', availability: async () => READY_ALL, latestWebsiteCheck: async () => null,
    startWebsiteCheck: async () => ({ checkId: 'c1', state: 'COMPLETED', inspection, websiteUrl: 'https://school.example.com/', completedAt: '2026-10-25T09:00:00Z', findings: [observedFinding('f-pass'), observedFinding('f-fix', 'NEEDS_FIXING')] }),
    markFinding: async () => observedFinding('f-fix', 'PASSED'),
    draftAnswers: async () => ({ revision: 3, answers: [{ key: 'WEBSITE_URL', value: 'https://school.example.com/', provenance: 'VERIFIED', evidenceIds: ['f-pass'] }, { key: 'PRIVACY_POLICY_URL', value: 'https://school.example.com/privacy', provenance: 'VERIFIED' }, { key: 'HELP_RESPONSE', value: 'Help', provenance: 'OWNER_CONFIRMED' }] }),
    ...overrides };
}
async function serverFlow(inspection: unknown, overrides: Partial<A2pRegistrationAdapter> = {}) {
  const controller = new A2pController(serverAdapter(inspection, overrides), { sleep: noSleep, newKey: keys });
  await controller.load();
  controller.setWebsiteInput('school.example.com');
  await controller.startWebsiteCheck();
  await controller.draftAnswers();
  return controller;
}

describe('final review: no claimed scan, save or verification without server evidence', () => {
  it('treats disabled, missing or unknown inspection as "nothing inspected": no pass, no seen wording', async () => {
    for (const inspection of ['LIVE_INSPECTION_DISABLED', undefined, 'LIVE?', 'SYNTHETIC_FIXTURE']) {
      const controller = await serverFlow(inspection);
      const check = controller.snapshot().check!;
      expect(check.inspection).toBe(inspection === 'LIVE_INSPECTION_DISABLED' ? 'LIVE_INSPECTION_DISABLED' : 'UNKNOWN');
      expect(check.findings.every((finding) => finding.outcome === 'UNABLE_TO_VERIFY' && finding.observedAt === null && finding.originalText === null)).toBe(true);
      expect(answerProvenance(controller.snapshot(), 'WEBSITE_URL')).toBe('UNVERIFIED_DRAFT');
      await controller.toggleReview('f-fix');
      expect(controller.snapshot().check!.findings.find((finding) => finding.id === 'f-fix')!.outcome).toBe('UNABLE_TO_VERIFY');
      const html = renderToStaticMarkup(<A2pRegistrationView controller={controller} snapshot={controller.snapshot()} theme="modern" initialStep="CHECK_WEBSITE" />);
      expect(html).toContain('data-testid="a2p-inspection-off"');
      expect(html).not.toContain('Check finished');
      const fix = renderToStaticMarkup(<A2pRegistrationView controller={controller} snapshot={controller.snapshot()} theme="modern" initialStep="FIX_WEBSITE" />);
      expect(fix).not.toContain('data-outcome="PASSED"');
      expect(fix).not.toContain('We may share data.');
      expect(fix).not.toContain('Verified from website');
    }
  });
  it('shows VERIFIED only for a live check whose observed findings back the answer', async () => {
    const controller = await serverFlow('LIVE');
    expect(controller.snapshot().check!.findings.find((finding) => finding.id === 'f-pass')!.outcome).toBe('PASSED');
    expect(answerProvenance(controller.snapshot(), 'WEBSITE_URL')).toBe('VERIFIED');
    expect(answerProvenance(controller.snapshot(), 'PRIVACY_POLICY_URL')).toBe('UNVERIFIED_DRAFT');
    expect(answerProvenance(controller.snapshot(), 'HELP_RESPONSE')).toBe('UNVERIFIED_DRAFT');
  });
  it('never reports Saved unless the server returns a newer recorded revision', async () => {
    for (const revision of [3, 2, null, undefined]) {
      const controller = await serverFlow('LIVE', { saveAnswers: async () => ({ revision, answers: [] }) });
      controller.editAnswer('CAMPAIGN_DESCRIPTION', 'Mine');
      await controller.saveAnswers();
      expect(controller.snapshot().savePhase).toBe('UNKNOWN');
      expect(controller.snapshot().edits.CAMPAIGN_DESCRIPTION).toBe('Mine');
      const html = renderToStaticMarkup(<A2pRegistrationView controller={controller} snapshot={controller.snapshot()} theme="modern" initialStep="ANSWERS" />);
      expect(html).not.toContain(en['a2p.answers.saved']);
    }
    const ok = await serverFlow('LIVE', { saveAnswers: async () => ({ revision: 4, answers: [] }) });
    ok.editAnswer('CAMPAIGN_DESCRIPTION', 'Mine');
    await ok.saveAnswers();
    expect(ok.snapshot().savePhase).toBe('SAVED');
  });
});

describe('rendered experience', () => {
  it('production markup says not connected, shows no synthetic data, no live composer and no approval claim', async () => {
    const controller = new A2pController(A2P_NOT_CONNECTED_ADAPTER);
    await controller.load();
    for (const step of ['CHECK_WEBSITE', 'FIX_WEBSITE', 'ANSWERS', 'REVIEW', 'STATUS'] as const) {
      const html = renderToStaticMarkup(<A2pRegistrationView controller={controller} snapshot={controller.snapshot()} theme="modern" initialStep={step} />);
      expect(html).toContain('data-testid="a2p-not-connected"');
      expect(html).not.toMatch(/Synthetic|sample-dojo|Sample Dojo/i);
      expect(html).toMatch(/<textarea[^>]*disabled/);
      expect(html).toContain(en['a2p.hon.notConnected']);
      expect(html).not.toMatch(/compliant|guaranteed approval|you are approved/i);
      if (step === 'STATUS') expect(html).toContain('data-testid="a2p-status-unavailable"');
      if (step === 'CHECK_WEBSITE') expect(html).toMatch(/<input[^>]*type="url"[^>]*disabled/);
      if (step === 'REVIEW') { expect(html).toContain(en['a2p.review.contradictionsUnavailable']); expect(html).toMatch(/<button[^>]*disabled[^>]*>Submit registration/); }
    }
  });
  it('synthetic preview is labeled and shows findings, comparison, answers, review and all eight status meanings', async () => {
    const controller = await syntheticFlow();
    await controller.draftAnswers();
    const render = (step: A2pStep, theme: 'modern' | 'classic' | 'big-button' = 'modern') => renderToStaticMarkup(<A2pRegistrationView controller={controller} snapshot={controller.snapshot()} theme={theme} initialStep={step} />);
    const fix = render('FIX_WEBSITE');
    expect(fix).toContain('data-testid="a2p-synthetic"');
    expect(fix).toContain('Text-message checkbox is already ticked');
    for (const label of ['Needs fixing', 'Review required', 'Unable to verify', 'Passed', 'Your current wording', 'Suggested wording', 'Mark for review', 'Why it matters']) expect(fix).toContain(label);
    expect(fix).toContain('rel="noopener noreferrer"');
    const answers = render('ANSWERS', 'classic');
    expect(answers).not.toContain('>Verified from website<');
    for (const label of ['Matches sample evidence (synthetic)', 'Confirmed by you', 'Unverified draft', 'Campaign description', 'HELP reply', 'STOP reply', 'Sample message 3']) expect(answers).toContain(label);
    expect(answers).toContain('data-interface-theme="classic"');
    const fixHtml = render('FIX_WEBSITE');
    expect(fixHtml).toContain('Synthetic sample evidence · not a live scan');
    expect(render('CHECK_WEBSITE')).toContain('data-testid="a2p-inspection-sample"');
    const review = render('REVIEW', 'big-button');
    expect(review).toContain('Items still open');
    expect(review).toContain(en['a2p.review.labelNote']);
    expect(review).toContain('Your message-flow answer says the checkbox starts unticked');
    const status = render('STATUS');
    for (const value of A2P_REGISTRATION_STATUSES) expect(status).toContain(`>${en[`a2p.status.${value}` as TranslationKey]}<`);
  });
  it('error availability shows a retry and no data', async () => {
    const controller = new A2pController(createSyntheticA2pAdapter('error'));
    await controller.load();
    const html = renderToStaticMarkup(<A2pRegistrationView controller={controller} snapshot={controller.snapshot()} theme="modern" />);
    expect(html).toContain(en['a2p.error.title']);
    expect(html).toContain('Try again');
  });
  it('export is a local text draft that is labeled when synthetic', async () => {
    const controller = await syntheticFlow();
    await controller.draftAnswers();
    const text = buildA2pExport(controller.snapshot(), t, (value) => value, 'SYNTHETIC_FIXTURE', new Date('2026-10-25T10:00:00Z'));
    expect(text).toContain(en['a2p.export.synthetic']);
    expect(text).toContain('### Campaign description [Unverified draft]');
    expect(text).toContain(en['a2p.noGuarantee']);
  });
});

describe('localization and source boundaries', () => {
  it('ships complete Korean and Spanish copy for every A2P key', () => {
    const a2pKeys = Object.keys(en).filter((key) => key.startsWith('a2p.'));
    expect(a2pKeys.length).toBeGreaterThan(200);
    for (const catalog of [ko, es] as Array<Record<string, string>>) for (const key of a2pKeys) expect(catalog[key]?.trim(), key).toBeTruthy();
    expect(ko['a2p.title' as keyof typeof ko]).not.toBe(en['a2p.title']);
    expect(es['a2p.title' as keyof typeof es]).not.toBe(en['a2p.title']);
  });
  it('keeps synthetic fixtures out of the production route and gates the reference route', async () => {
    const production = source('src/components/a2p-registration/production-entry.tsx') + source('src/app/settings/communications/business-texting/a2p-registration/page.tsx') + source('src/components/a2p-registration/a2p-registration-view.tsx') + source('src/components/a2p-registration/controller.ts');
    expect(production).not.toMatch(/synthetic-fixtures|createSyntheticA2pAdapter/);
    expect(source('src/components/a2p-registration/production-entry.tsx')).toContain('A2P_NOT_CONNECTED_ADAPTER');
    expect(source('src/app/settings/communications/business-texting/a2p-registration/page.tsx')).toContain('await requireVerifiedWebSession()');
    const all = ['adapter.ts', 'contract.ts', 'controller.ts', 'synthetic-fixtures.ts', 'a2p-registration-view.tsx', 'production-entry.tsx', 'preview-entry.tsx'].map((file) => source(`src/components/a2p-registration/${file}`)).join('\n');
    expect(all).not.toMatch(/twilio\.com|api\.|fetch\(|sendSms|localStorage|sessionStorage/i);
    vi.resetModules();
    const notFound = vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); });
    vi.doMock('next/navigation', () => ({ notFound }));
    const previous = process.env.HON_REFERENCE_PREVIEW;
    delete process.env.HON_REFERENCE_PREVIEW;
    try {
      const page = await import('../src/app/reference/a2p-registration/page');
      await expect(page.default({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_NOT_FOUND');
      process.env.HON_REFERENCE_PREVIEW = '1';
      const element = await page.default({ searchParams: Promise.resolve({ scenario: 'javascript:x', theme: 'nope', step: 'STATUS' }) });
      expect(element.props).toMatchObject({ scenario: 'ready', theme: 'modern', step: 'STATUS' });
    } finally {
      if (previous === undefined) delete process.env.HON_REFERENCE_PREVIEW; else process.env.HON_REFERENCE_PREVIEW = previous;
      vi.doUnmock('next/navigation');
    }
  });
});
