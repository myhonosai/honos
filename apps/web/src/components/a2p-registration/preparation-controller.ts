import {
  A2P_FACT_CONFIRMATION, A2P_FINDING_CODES, A2P_TEMPLATES, validateA2pDraftInput, validateA2pWebsiteReview,
  type A2pDraftFacts, type A2pDraftInput, type A2pFindingCode, type A2pSchoolScope, type A2pTemplate, type A2pWebsiteReviewInput,
} from '@hon/contracts';
import { A2pPreparationError, type A2pPreparationClient, type A2pPreparationErrorKind } from './preparation-http';
import type { A2pCopyResult, A2pDraftResult, A2pExpectedScope, A2pFindingResult, A2pReviewResult, A2pValidationResult } from './preparation-contract';

/**
 * Framework-free state for the connected A2P assistant (integration with
 * Codex's read-only preparation API). Results live only in page memory, are
 * tied to the exact input that produced them, and are dropped when that input
 * changes, when the page is hidden, or when the school, session or
 * authorization changes. Nothing is saved, submitted or sent.
 */

export const A2P_FACT_KEYS = ['businessName', 'websiteUrl', 'privacyUrl', 'termsUrl', 'optInUrl', 'supportContact', 'messageFlow', 'messageFrequency'] as const;
export type A2pFactKey = typeof A2P_FACT_KEYS[number];
const REVIEW_FACTS: readonly A2pFactKey[] = ['businessName', 'websiteUrl', 'privacyUrl', 'termsUrl', 'optInUrl', 'messageFlow'];
export const A2P_URL_FACTS: readonly A2pFactKey[] = ['websiteUrl', 'privacyUrl', 'termsUrl', 'optInUrl'];
export const A2P_FACT_LIMITS: Readonly<Record<A2pFactKey, number>> = { businessName: 120, websiteUrl: 2048, privacyUrl: 2048, termsUrl: 2048, optInUrl: 2048, supportContact: 160, messageFlow: 2048, messageFrequency: 160 };
export type A2pFactError = 'REQUIRED' | 'INVALID' | 'URL_NOT_ALLOWED';
export type A2pPurpose = A2pDraftInput['purpose'];
export type A2pMarketingConsent = A2pDraftInput['marketingConsent'];
export type A2pCampaignError = 'TEMPLATES' | 'CAMPAIGN_MISMATCH' | null;

export type A2pAccess =
  | { state: 'LOADING' }
  | { state: 'READY'; school: A2pExpectedScope; scope: A2pSchoolScope }
  | { state: 'UNAUTHORIZED' | 'DENIED' | 'NO_SCHOOL' | 'UNAVAILABLE' };
export type A2pOpPhase = 'IDLE' | 'WORKING' | 'DONE' | 'FAILED';
export interface A2pOp<T> { phase: A2pOpPhase; result: T | null; error: A2pPreparationErrorKind | null }
export type A2pClearReason = 'HIDDEN' | 'SCHOOL_CHANGED' | 'SESSION' | 'DENIED' | null;

export interface A2pPrepSnapshot {
  access: A2pAccess;
  facts: Record<A2pFactKey, string>;
  factErrors: Partial<Record<A2pFactKey, A2pFactError>>;
  purpose: A2pPurpose;
  templates: A2pTemplate[];
  marketingConsent: A2pMarketingConsent;
  /** The owner's per-request attestation; sent only when the server grants canConfirmOwnerFacts. */
  ownerConfirmed: boolean;
  campaignError: A2pCampaignError;
  review: A2pOp<A2pReviewResult>;
  details: { code: A2pFindingCode } & A2pOp<A2pFindingResult> | null;
  draft: A2pOp<A2pDraftResult>;
  validation: A2pOp<A2pValidationResult>;
  copyAcknowledged: boolean;
  copy: A2pOp<A2pCopyResult>;
  cleared: A2pClearReason;
}

const idle = <T>(): A2pOp<T> => ({ phase: 'IDLE', result: null, error: null });
const blankFacts = (): Record<A2pFactKey, string> => Object.fromEntries(A2P_FACT_KEYS.map((key) => [key, ''])) as Record<A2pFactKey, string>;

export function initialA2pPrepSnapshot(): A2pPrepSnapshot {
  return {
    access: { state: 'LOADING' }, facts: blankFacts(), factErrors: {}, purpose: 'SERVICE_NOTIFICATIONS', templates: ['TRIAL_CONFIRMATION', 'TRIAL_REMINDER'],
    marketingConsent: 'NOT_APPLICABLE', ownerConfirmed: false, campaignError: null,
    review: idle(), details: null, draft: idle(), validation: idle(), copyAcknowledged: false, copy: idle(), cleared: null,
  };
}

/** The server's own validator decides; this only maps a field to a visible message. */
function factError(key: A2pFactKey, value: string): A2pFactError | null {
  if (!value) return null;
  const facts = Object.fromEntries(A2P_FACT_KEYS.map((k) => [k, k === key ? value : null])) as unknown as A2pDraftFacts;
  try {
    validateA2pDraftInput({ facts, purpose: 'SERVICE_NOTIFICATIONS', templates: ['TRIAL_CONFIRMATION'], marketingConsent: 'NOT_APPLICABLE', ownerConfirmation: 'NOT_CONFIRMED' });
    return null;
  } catch (error) { return (error as Error).message === 'A2P_URL_NOT_ALLOWED' ? 'URL_NOT_ALLOWED' : 'INVALID'; }
}
const trimmed = (facts: Record<A2pFactKey, string>, key: A2pFactKey): string | null => facts[key].trim() || null;

/** A fixed, fact-free input used only to learn the caller's current authority. */
const PROBE: A2pDraftInput = Object.freeze({
  facts: Object.freeze(Object.fromEntries(A2P_FACT_KEYS.map((key) => [key, null])) as unknown as A2pDraftFacts),
  purpose: 'SERVICE_NOTIFICATIONS', templates: Object.freeze(['TRIAL_CONFIRMATION'] as A2pTemplate[]), marketingConsent: 'NOT_APPLICABLE', ownerConfirmation: 'NOT_CONFIRMED',
});

export class A2pPreparationController {
  private current = initialA2pPrepSnapshot();
  private listeners = new Set<(snapshot: A2pPrepSnapshot) => void>();
  private generation = 0;
  private aborts = new Set<AbortController>();

  constructor(private readonly client: A2pPreparationClient) {}

  snapshot(): A2pPrepSnapshot { return this.current; }
  subscribe(listener: (snapshot: A2pPrepSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private set(next: Partial<A2pPrepSnapshot>, generation = this.generation): void {
    if (generation !== this.generation) return;
    this.current = { ...this.current, ...next };
    for (const listener of this.listeners) listener(this.current);
  }
  private get ready(): Extract<A2pAccess, { state: 'READY' }> | null { return this.current.access.state === 'READY' ? this.current.access : null; }
  private results(): Partial<A2pPrepSnapshot> { return { review: idle(), details: null, draft: idle(), validation: idle(), copy: idle(), copyAcknowledged: false }; }
  private draftResults(): Partial<A2pPrepSnapshot> { return { draft: idle(), validation: idle(), copy: idle(), copyAcknowledged: false }; }

  /** Drops every result and cancels in-flight requests; late responses can never repaint. */
  private conceal(reason: A2pClearReason, keepFacts: boolean): number {
    for (const abort of this.aborts) abort.abort();
    this.aborts.clear();
    const generation = ++this.generation;
    const base = keepFacts ? {} : { facts: blankFacts(), factErrors: {}, ownerConfirmed: false };
    this.set({ ...this.results(), ...base, cleared: reason }, generation);
    return generation;
  }

  /** Resolves the current school, then learns the caller's authority from a fact-free read-only probe. */
  async load(reason: A2pClearReason = null): Promise<void> {
    const generation = this.conceal(reason, reason === null || reason === 'HIDDEN');
    this.set({ access: { state: 'LOADING' } }, generation);
    try {
      const school = await this.client.currentSchool();
      if (generation !== this.generation) return;
      const probe = await this.client.draftValidation(school, PROBE, this.signal());
      this.set({ access: { state: 'READY', school, scope: probe.scope }, ...(probe.scope.canConfirmOwnerFacts ? {} : { ownerConfirmed: false }) }, generation);
    } catch (error) {
      if (generation !== this.generation || (error instanceof Error && error.name === 'AbortError')) return;
      const kind = error instanceof A2pPreparationError ? error.kind : 'UNAVAILABLE';
      const state = kind === 'UNAUTHORIZED' ? 'UNAUTHORIZED' : kind === 'DENIED' ? 'DENIED' : kind === 'NO_SCHOOL' ? 'NO_SCHOOL' : 'UNAVAILABLE';
      this.set({ access: { state } }, generation);
    }
  }

  /** Hidden page: conceal results. On return, re-verify the school before anything is shown again. */
  async visibility(visible: boolean): Promise<void> {
    if (!visible) { this.conceal('HIDDEN', true); return; }
    const ready = this.ready;
    if (!ready) return;
    try {
      const school = await this.client.currentSchool();
      if (school.organizationId !== ready.school.organizationId || school.schoolId !== ready.school.schoolId) await this.load('SCHOOL_CHANGED');
    } catch (error) { this.fail(error, this.generation); }
  }

  private signal(): AbortSignal {
    const abort = new AbortController();
    this.aborts.add(abort);
    return abort.signal;
  }

  /** Re-verifies the current school before each command, so a school switch elsewhere never reuses scope. */
  private async begin(): Promise<{ school: A2pExpectedScope; generation: number; signal: AbortSignal } | null> {
    const ready = this.ready;
    if (!ready) return null;
    const generation = this.generation;
    const school = await this.client.currentSchool();
    if (generation !== this.generation) return null;
    if (school.organizationId !== ready.school.organizationId || school.schoolId !== ready.school.schoolId) { await this.load('SCHOOL_CHANGED'); return null; }
    return { school, generation, signal: this.signal() };
  }

  /** Applies server authority from a fresh response; a lost confirmation right also drops the attestation. */
  private accept(scope: A2pSchoolScope, generation: number): boolean {
    const ready = this.ready;
    if (!ready || generation !== this.generation) return false;
    if (scope.schoolName !== ready.scope.schoolName) { void this.load('SCHOOL_CHANGED'); return false; }
    const lost = ready.scope.canConfirmOwnerFacts && !scope.canConfirmOwnerFacts;
    this.set({ access: { ...ready, scope }, ...(lost ? { ownerConfirmed: false, ...this.draftResults() } : {}) }, generation);
    return !lost;
  }

  /** Returns the error kind for the failed operation, or null when the page was reset instead. */
  private fail(error: unknown, generation: number): A2pPreparationErrorKind | null {
    if (generation !== this.generation || (error instanceof Error && error.name === 'AbortError')) return null;
    const kind = error instanceof A2pPreparationError ? error.kind : 'UNAVAILABLE';
    if (kind === 'UNAUTHORIZED') { this.conceal('SESSION', false); this.set({ access: { state: 'UNAUTHORIZED' } }); return null; }
    if (kind === 'DENIED' || kind === 'NO_SCHOOL') { this.conceal('DENIED', false); this.set({ access: { state: kind } }); return null; }
    if (kind === 'SCHOOL_CHANGED') { void this.load('SCHOOL_CHANGED'); return null; }
    if (kind === 'OWNER_CONFIRMATION_REQUIRED') {
      const ready = this.ready;
      if (ready) this.set({ access: { ...ready, scope: { ...ready.scope, canConfirmOwnerFacts: false } }, ownerConfirmed: false }, generation);
    }
    return kind;
  }

  setFact(key: A2pFactKey, value: string): void {
    const facts = { ...this.current.facts, [key]: value.slice(0, A2P_FACT_LIMITS[key]) };
    const factErrors = { ...this.current.factErrors };
    delete factErrors[key];
    // Results belong to the exact facts that produced them; the attestation covers those facts only.
    this.set({ facts, factErrors, ownerConfirmed: false, ...this.draftResults(), ...(REVIEW_FACTS.includes(key) ? { review: idle(), details: null } : {}) });
  }

  setPurpose(purpose: A2pPurpose): void {
    let templates = this.current.templates;
    if (purpose === 'MARKETING') templates = ['PROMOTIONAL'];
    if (purpose === 'SERVICE_NOTIFICATIONS') templates = templates.filter((t) => t !== 'PROMOTIONAL');
    if (purpose === 'MIXED' && !templates.includes('PROMOTIONAL')) templates = [...templates, 'PROMOTIONAL'];
    if (purpose !== 'MARKETING' && !templates.some((t) => t !== 'PROMOTIONAL')) templates = ['TRIAL_CONFIRMATION', ...templates];
    this.set({ purpose, ...this.campaign(sorted(templates)), ...this.draftResults() });
  }

  toggleTemplate(template: A2pTemplate): void {
    const has = this.current.templates.includes(template);
    if (!has && this.current.templates.length >= 5) { this.set({ campaignError: 'TEMPLATES' }); return; }
    this.set({ ...this.campaign(sorted(has ? this.current.templates.filter((t) => t !== template) : [...this.current.templates, template])), ...this.draftResults() });
  }

  setMarketingConsent(value: A2pMarketingConsent): void {
    if (!this.current.templates.includes('PROMOTIONAL') || value === 'NOT_APPLICABLE') return;
    this.set({ marketingConsent: value, ...this.draftResults() });
  }

  private campaign(templates: A2pTemplate[]): Partial<A2pPrepSnapshot> {
    const promotional = templates.includes('PROMOTIONAL');
    const marketingConsent: A2pMarketingConsent = !promotional ? 'NOT_APPLICABLE' : this.current.marketingConsent === 'NOT_APPLICABLE' ? 'NOT_CONFIRMED' : this.current.marketingConsent;
    return { templates, marketingConsent, campaignError: null };
  }

  setOwnerConfirmed(value: boolean): void {
    const ready = this.ready;
    if (value && !ready?.scope.canConfirmOwnerFacts) return;
    this.set({ ownerConfirmed: value, ...this.draftResults() });
  }

  setCopyAcknowledged(value: boolean): void { this.set({ copyAcknowledged: value, copy: idle() }); }

  private checkFacts(keys: readonly A2pFactKey[], required: readonly A2pFactKey[]): boolean {
    const factErrors: Partial<Record<A2pFactKey, A2pFactError>> = {};
    for (const key of keys) {
      const value = this.current.facts[key].trim();
      const error = !value && required.includes(key) ? 'REQUIRED' : factError(key, value);
      if (error) factErrors[key] = error;
    }
    this.set({ factErrors });
    return Object.keys(factErrors).length === 0;
  }

  reviewInput(): A2pWebsiteReviewInput | null {
    const f = this.current.facts;
    try {
      return validateA2pWebsiteReview({ websiteUrl: f.websiteUrl.trim(), businessName: trimmed(f, 'businessName'), privacyUrl: trimmed(f, 'privacyUrl'),
        termsUrl: trimmed(f, 'termsUrl'), optInUrl: trimmed(f, 'optInUrl'), messageFlow: trimmed(f, 'messageFlow') });
    } catch { return null; }
  }

  draftInput(): A2pDraftInput | null {
    const ready = this.ready, s = this.current;
    try {
      return validateA2pDraftInput({
        facts: Object.fromEntries(A2P_FACT_KEYS.map((key) => [key, trimmed(s.facts, key)])),
        purpose: s.purpose, templates: s.templates, marketingConsent: s.marketingConsent,
        ownerConfirmation: s.ownerConfirmed && ready?.scope.canConfirmOwnerFacts ? A2P_FACT_CONFIRMATION : 'NOT_CONFIRMED',
      });
    } catch (error) {
      this.set({ campaignError: (error as Error).message === 'A2P_CAMPAIGN_MISMATCH' ? 'CAMPAIGN_MISMATCH' : s.templates.length ? null : 'TEMPLATES' });
      return null;
    }
  }

  async reviewWebsite(): Promise<void> {
    if (!this.ready || this.current.review.phase === 'WORKING') return;
    if (!this.checkFacts(REVIEW_FACTS, ['websiteUrl'])) return;
    const input = this.reviewInput();
    if (!input) return;
    this.set({ review: { phase: 'WORKING', result: null, error: null }, details: null });
    let started;
    try { started = await this.begin(); } catch (error) { this.reviewFailed(error, this.generation); return; }
    if (!started) return;
    try {
      const result = await this.client.websiteReview(started.school, input, started.signal);
      if (this.accept(result.scope, started.generation)) this.set({ review: { phase: 'DONE', result, error: null } }, started.generation);
    } catch (error) { this.reviewFailed(error, started.generation); }
  }
  private reviewFailed(error: unknown, generation: number): void {
    const kind = this.fail(error, generation);
    if (kind) this.set({ review: { phase: 'FAILED', result: null, error: kind } }, generation);
  }

  /** Re-runs the review server-side and shows only the requested check, with its rule sources. */
  async findingDetails(code: A2pFindingCode): Promise<void> {
    const review = this.current.review.result;
    if (!review || !A2P_FINDING_CODES.includes(code) || this.current.details?.phase === 'WORKING') return;
    const input = this.reviewInput();
    if (!input) return;
    this.set({ details: { code, phase: 'WORKING', result: null, error: null } });
    let started;
    try { started = await this.begin(); } catch (error) { const kind = this.fail(error, this.generation); if (kind) this.set({ details: { code, phase: 'FAILED', result: null, error: kind } }); return; }
    if (!started) return;
    try {
      const result = await this.client.findingDetails(started.school, input, code, started.signal);
      if (this.accept(result.scope, started.generation)) this.set({ details: { code, phase: 'DONE', result, error: null } }, started.generation);
    } catch (error) {
      const kind = this.fail(error, started.generation);
      if (kind) this.set({ details: { code, phase: 'FAILED', result: null, error: kind } }, started.generation);
    }
  }

  async generateDraft(): Promise<void> { await this.runDraft('draft'); }
  async validateDraft(): Promise<void> { await this.runDraft('validation'); }

  private async runDraft(which: 'draft' | 'validation'): Promise<void> {
    if (!this.ready || this.current[which].phase === 'WORKING') return;
    if (!this.checkFacts(A2P_FACT_KEYS, [])) return;
    const input = this.draftInput();
    if (!input) return;
    this.set({ [which]: { phase: 'WORKING', result: null, error: null }, copy: idle() } as Partial<A2pPrepSnapshot>);
    let started;
    try { started = await this.begin(); } catch (error) { this.draftFailed(which, error, this.generation); return; }
    if (!started) return;
    try {
      const result = which === 'draft'
        ? await this.client.registrationDraft(started.school, input, started.signal)
        : await this.client.draftValidation(started.school, input, started.signal);
      if (this.accept(result.scope, started.generation)) this.set({ [which]: { phase: 'DONE', result, error: null } } as Partial<A2pPrepSnapshot>, started.generation);
    } catch (error) { this.draftFailed(which, error, started.generation); }
  }
  private draftFailed(which: 'draft' | 'validation', error: unknown, generation: number): void {
    const kind = this.fail(error, generation);
    if (kind) this.set({ [which]: { phase: 'FAILED', result: null, error: kind } } as Partial<A2pPrepSnapshot>, generation);
  }

  /** The digest the copy request must match: the latest validation of the current input. */
  copyDigest(): string | null {
    const v = this.current.validation.result;
    return v && v.validation.readyForCopyPreparation ? v.digest : null;
  }

  async prepareCopy(): Promise<void> {
    const digest = this.copyDigest();
    if (!this.ready || !digest || !this.current.copyAcknowledged || this.current.copy.phase === 'WORKING') return;
    const input = this.draftInput();
    if (!input) return;
    this.set({ copy: { phase: 'WORKING', result: null, error: null } });
    let started;
    try { started = await this.begin(); } catch (error) { this.copyFailed(error, this.generation); return; }
    if (!started) return;
    try {
      const result = await this.client.copyPreparation(started.school, input, digest, started.signal);
      if (this.accept(result.scope, started.generation)) this.set({ copy: { phase: 'DONE', result, error: null } }, started.generation);
    } catch (error) { this.copyFailed(error, started.generation); }
  }
  private copyFailed(error: unknown, generation: number): void {
    const kind = this.fail(error, generation);
    // A changed draft needs a fresh validation and digest before copying again.
    if (kind) this.set({ copy: { phase: 'FAILED', result: null, error: kind }, ...(kind === 'DRAFT_CHANGED' || kind === 'DRAFT_INCOMPLETE' ? { validation: idle() } : {}) }, generation);
  }

  dismissCleared(): void { this.set({ cleared: null }); }

  /** Cancels in-flight work so a late response cannot repaint; subscriptions are owned by the caller. */
  dispose(): void {
    for (const abort of this.aborts) abort.abort();
    this.aborts.clear();
    this.generation += 1;
  }
}

function sorted(templates: A2pTemplate[]): A2pTemplate[] {
  return [...new Set(templates)].sort((a, b) => A2P_TEMPLATES.indexOf(a) - A2P_TEMPLATES.indexOf(b));
}
