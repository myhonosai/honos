import {
  A2P_ANSWER_KEYS, NO_A2P_CAPABILITIES, blankAnswerSet, findingForInspection, normalizeWebsiteInput, parseAnswerSet, parseFinding, parseStatusView, parseWebsiteCheck,
  type A2pAnswerKey, type A2pAnswerSet, type A2pAvailability, type A2pCapabilities, type A2pConfirmationKey, type A2pFinding, type A2pReviewMark,
  type A2pStatusView, type A2pWebsiteCheck,
} from './contract';
import type { A2pRegistrationAdapter } from './adapter';

/**
 * Framework-free state for the A2P assistant so behaviour is testable without a
 * DOM. It never invents a result: until the adapter reports READY every
 * section stays empty, and an interrupted or unrecognized outcome is UNKNOWN.
 */

export type A2pAvailabilityView = { state: 'LOADING' } | A2pAvailability;
export type A2pCheckPhase = 'IDLE' | 'STARTING' | 'POLLING' | 'DONE' | 'FAILED' | 'TIMED_OUT';
export type A2pCommandPhase = 'IDLE' | 'WORKING' | 'DONE' | 'FAILED';
export type A2pSavePhase = 'IDLE' | 'SAVING' | 'SAVED' | 'FAILED' | 'UNKNOWN';
export type A2pStatusSection = { state: 'UNAVAILABLE' | 'LOADING' | 'ERROR' } | { state: 'READY'; view: A2pStatusView };
export type A2pInputError = 'EMPTY' | 'INVALID' | 'UNSUPPORTED' | null;

export interface A2pSnapshot {
  availability: A2pAvailabilityView;
  websiteInput: string;
  inputError: A2pInputError;
  checkPhase: A2pCheckPhase;
  check: A2pWebsiteCheck | null;
  reviewPending: string[];
  reviewFailed: string[];
  answerPhase: A2pCommandPhase;
  answers: A2pAnswerSet;
  /** Owner edits kept in this page's memory only, until an authorized save succeeds. */
  edits: Partial<Record<A2pAnswerKey, string>>;
  savePhase: A2pSavePhase;
  confirmationPending: A2pConfirmationKey[];
  confirmationFailed: A2pConfirmationKey[];
  status: A2pStatusSection;
}

export function initialA2pSnapshot(): A2pSnapshot {
  return {
    availability: { state: 'LOADING' }, websiteInput: '', inputError: null, checkPhase: 'IDLE', check: null, reviewPending: [], reviewFailed: [],
    answerPhase: 'IDLE', answers: blankAnswerSet(), edits: {}, savePhase: 'IDLE', confirmationPending: [], confirmationFailed: [], status: { state: 'UNAVAILABLE' },
  };
}

export function a2pCapabilities(snapshot: Pick<A2pSnapshot, 'availability'>): A2pCapabilities {
  return snapshot.availability.state === 'READY' ? snapshot.availability.capabilities : NO_A2P_CAPABILITIES;
}

export interface A2pControllerOptions {
  pollIntervalMs?: number;
  maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
  newKey?: () => string;
}

const defaultSleep = (ms: number) => new Promise<void>((done) => { setTimeout(done, ms); });

export class A2pController {
  private current = initialA2pSnapshot();
  private listeners = new Set<(snapshot: A2pSnapshot) => void>();
  private generation = 0;
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly newKey: () => string;

  constructor(private readonly adapter: A2pRegistrationAdapter, options: A2pControllerOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 2500;
    this.maxPolls = options.maxPolls ?? 40;
    this.sleep = options.sleep ?? defaultSleep;
    this.newKey = options.newKey ?? (() => crypto.randomUUID());
  }

  get source() { return this.adapter.source; }
  /** Fixture evidence is accepted only from the synthetic preview adapter. */
  private get parseOptions() { return { allowSynthetic: this.adapter.source === 'SYNTHETIC_FIXTURE' }; }
  snapshot(): A2pSnapshot { return this.current; }
  subscribe(listener: (snapshot: A2pSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private set(next: Partial<A2pSnapshot>, generation = this.generation): void {
    if (generation !== this.generation) return;
    this.current = { ...this.current, ...next };
    for (const listener of this.listeners) listener(this.current);
  }
  private capable(key: keyof A2pCapabilities): boolean { return a2pCapabilities(this.current)[key]; }

  /** Reads availability first; no other read happens unless the adapter reports READY. */
  async load(): Promise<void> {
    const generation = ++this.generation;
    this.current = initialA2pSnapshot();
    this.set({}, generation);
    let availability: A2pAvailability;
    try { availability = await this.adapter.availability(); } catch { availability = { state: 'ERROR' }; }
    if (availability.state === 'READY' && availability.source === 'SYNTHETIC_FIXTURE' && this.adapter.source !== 'SYNTHETIC_FIXTURE') availability = { state: 'ERROR' };
    this.set({ availability }, generation);
    if (availability.state !== 'READY') return;
    const reads: Promise<void>[] = [];
    if (availability.capabilities.websiteCheck) reads.push(this.adapter.latestWebsiteCheck().then((raw) => {
      if (raw === null || raw === undefined) return;
      const check = parseWebsiteCheck(raw, this.parseOptions);
      this.set({ websiteInput: check.websiteUrl ?? '' }, generation);
      if (check.state === 'NOT_STARTED') return;
      // An unfinished check is resumed, so its progress is shown rather than guessed.
      void this.follow(check, generation);
    }).catch(() => undefined));
    if (availability.capabilities.registrationStatus) {
      this.set({ status: { state: 'LOADING' } }, generation);
      reads.push(this.adapter.registrationStatus().then((raw) => this.set({ status: { state: 'READY', view: parseStatusView(raw) } }, generation)).catch(() => this.set({ status: { state: 'ERROR' } }, generation)));
    }
    await Promise.all(reads);
  }

  setWebsiteInput(value: string): void { this.set({ websiteInput: value.slice(0, 2048), inputError: null }); }

  async startWebsiteCheck(): Promise<void> {
    if (!this.capable('websiteCheck') || this.current.checkPhase === 'STARTING' || this.current.checkPhase === 'POLLING') return;
    const input = normalizeWebsiteInput(this.current.websiteInput);
    if (!input.ok) { this.set({ inputError: input.reason }); return; }
    const generation = this.generation;
    this.set({ websiteInput: input.url, inputError: null, checkPhase: 'STARTING', check: null }, generation);
    let check: A2pWebsiteCheck;
    try { check = parseWebsiteCheck(await this.adapter.startWebsiteCheck(input.url, this.newKey()), this.parseOptions); }
    catch { this.set({ checkPhase: 'FAILED', check: null }, generation); return; }
    await this.follow(check, generation);
  }

  private async follow(initial: A2pWebsiteCheck, generation: number): Promise<void> {
    let check = initial;
    this.set({ check, checkPhase: 'POLLING' }, generation);
    for (let poll = 0; ; poll += 1) {
      if (check.state === 'COMPLETED') { this.set({ check, checkPhase: 'DONE' }, generation); return; }
      if (check.state === 'FAILED') { this.set({ check, checkPhase: 'FAILED' }, generation); return; }
      if (check.state === 'UNKNOWN' || check.state === 'NOT_STARTED' || !check.checkId || poll >= this.maxPolls) { this.set({ check, checkPhase: 'TIMED_OUT' }, generation); return; }
      await this.sleep(this.pollIntervalMs);
      if (generation !== this.generation) return;
      try { check = parseWebsiteCheck(await this.adapter.readWebsiteCheck(check.checkId), this.parseOptions); }
      catch { this.set({ check: { ...check, state: 'UNKNOWN' }, checkPhase: 'TIMED_OUT' }, generation); return; }
      this.set({ check }, generation);
    }
  }

  async toggleReview(findingId: string): Promise<void> {
    const check = this.current.check;
    const finding = check?.findings.find((item) => item.id === findingId);
    if (!check || !finding || !this.capable('findingReview') || this.current.reviewPending.includes(findingId)) return;
    const generation = this.generation;
    const next: A2pReviewMark = finding.review === 'MARKED_FOR_REVIEW' ? 'NONE' : 'MARKED_FOR_REVIEW';
    this.set({ reviewPending: [...this.current.reviewPending, findingId], reviewFailed: this.current.reviewFailed.filter((id) => id !== findingId) }, generation);
    try {
      const updated = parseFinding(await this.adapter.markFinding(findingId, next, this.newKey()));
      if (!updated || updated.id !== findingId) throw new Error('mismatch');
      this.replaceFinding(updated, generation);
    } catch {
      this.set({ reviewFailed: [...this.current.reviewFailed, findingId] }, generation);
    } finally {
      this.set({ reviewPending: this.current.reviewPending.filter((id) => id !== findingId) }, generation);
    }
  }
  private replaceFinding(updated: A2pFinding, generation: number): void {
    const check = this.current.check;
    if (!check) return;
    const finding = findingForInspection(updated, check.inspection);
    this.set({ check: { ...check, findings: check.findings.map((item) => item.id === finding.id ? finding : item) } }, generation);
  }

  async draftAnswers(): Promise<void> {
    if (!this.capable('answerDrafts') || this.current.answerPhase === 'WORKING') return;
    const generation = this.generation;
    this.set({ answerPhase: 'WORKING' }, generation);
    try { this.set({ answers: parseAnswerSet(await this.adapter.draftAnswers(this.newKey())), edits: {}, savePhase: 'IDLE', answerPhase: 'DONE' }, generation); }
    catch { this.set({ answerPhase: 'FAILED' }, generation); }
  }

  /** Local edit only. Nothing is saved unless the owner presses Save and the backend supports it. */
  editAnswer(key: A2pAnswerKey, value: string): void {
    const original = this.current.answers.answers.find((answer) => answer.key === key)?.value ?? '';
    const edits = { ...this.current.edits };
    if (value === original) delete edits[key]; else edits[key] = value.slice(0, 2000);
    this.set({ edits, savePhase: this.current.savePhase === 'UNKNOWN' ? 'UNKNOWN' : 'IDLE' });
  }

  async saveAnswers(): Promise<void> {
    if (!this.capable('saveAnswers') || this.current.savePhase === 'SAVING' || !Object.keys(this.current.edits).length) return;
    const generation = this.generation;
    const payload = A2P_ANSWER_KEYS.map((key) => ({ key, value: answerValue(this.current, key) }));
    this.set({ savePhase: 'SAVING' }, generation);
    try {
      const previous = this.current.answers.revision;
      const saved = parseAnswerSet(await this.adapter.saveAnswers(payload, previous, this.newKey()));
      // "Saved" needs server evidence: a recorded revision newer than the one edited.
      if (saved.revision === null || (previous !== null && saved.revision <= previous)) throw new Error('unconfirmed');
      this.set({ answers: saved, edits: {}, savePhase: 'SAVED' }, generation);
    } catch {
      // The outcome is unknown: keep the owner's edits and never assume the save happened.
      this.set({ savePhase: 'UNKNOWN' }, generation);
    }
  }

  async setConfirmation(key: A2pConfirmationKey, confirmed: boolean): Promise<void> {
    if (!this.capable('ownerConfirmations') || this.current.confirmationPending.includes(key)) return;
    const generation = this.generation;
    this.set({ confirmationPending: [...this.current.confirmationPending, key], confirmationFailed: this.current.confirmationFailed.filter((item) => item !== key) }, generation);
    try {
      const set = parseAnswerSet(await this.adapter.setConfirmation(key, confirmed, this.newKey()));
      this.set({ answers: { ...this.current.answers, confirmations: set.confirmations, contradictions: set.contradictions, revision: set.revision ?? this.current.answers.revision } }, generation);
    } catch {
      this.set({ confirmationFailed: [...this.current.confirmationFailed, key] }, generation);
    } finally {
      this.set({ confirmationPending: this.current.confirmationPending.filter((item) => item !== key) }, generation);
    }
  }

  dispose(): void { this.generation += 1; this.listeners.clear(); }
}

export function answerValue(snapshot: Pick<A2pSnapshot, 'answers' | 'edits'>, key: A2pAnswerKey): string {
  return snapshot.edits[key] ?? snapshot.answers.answers.find((answer) => answer.key === key)?.value ?? '';
}

export type A2pDisplayProvenance = 'VERIFIED' | 'VERIFIED_SAMPLE' | 'OWNER_CONFIRMED' | 'UNVERIFIED_DRAFT' | 'EDITED' | 'EMPTY';

/**
 * The label an answer may show right now. VERIFIED also needs every evidence
 * id to match an observed finding in the current completed check; fixture
 * evidence is shown as VERIFIED_SAMPLE, never as a real website verification.
 */
export function answerProvenance(snapshot: Pick<A2pSnapshot, 'answers' | 'edits' | 'check'>, key: A2pAnswerKey): A2pDisplayProvenance {
  if (snapshot.edits[key] !== undefined) return 'EDITED';
  const answer = snapshot.answers.answers.find((item) => item.key === key);
  if (!answer || !answer.value.trim()) return 'EMPTY';
  if (answer.provenance !== 'VERIFIED') return answer.provenance;
  const check = snapshot.check;
  const observed = check?.state === 'COMPLETED' && (check.inspection === 'LIVE' || check.inspection === 'SYNTHETIC_FIXTURE')
    && answer.evidenceIds.every((id) => check.findings.some((finding) => finding.id === id && finding.observedAt !== null));
  if (!observed) return 'UNVERIFIED_DRAFT';
  return check.inspection === 'LIVE' ? 'VERIFIED' : 'VERIFIED_SAMPLE';
}

export type A2pReadinessLabel = 'NOT_CHECKED' | 'OPEN_ITEMS' | 'NO_OPEN_ITEMS';
export interface A2pReadiness {
  label: A2pReadinessLabel;
  needsFixing: number;
  reviewRequired: number;
  unableToVerify: number;
  passed: number;
  markedForReview: number;
  missingConfirmations: number;
  emptyAnswers: number;
  unverifiedAnswers: number;
  unsavedEdits: number;
  contradictions: number;
}

/**
 * Counts only what is on screen. NO_OPEN_ITEMS means HON found nothing left to
 * do in this draft; it is not a compliance finding or an approval prediction.
 */
export function a2pReadiness(snapshot: Pick<A2pSnapshot, 'check' | 'answers' | 'edits'>): A2pReadiness {
  const findings = snapshot.check?.state === 'COMPLETED' ? snapshot.check.findings : [];
  const by = (outcome: A2pFinding['outcome']) => findings.filter((finding) => finding.outcome === outcome).length;
  const values = A2P_ANSWER_KEYS.map((key) => answerValue(snapshot, key));
  const readiness = {
    needsFixing: by('NEEDS_FIXING'),
    reviewRequired: by('REVIEW_REQUIRED'),
    unableToVerify: by('UNABLE_TO_VERIFY'),
    passed: by('PASSED'),
    markedForReview: findings.filter((finding) => finding.review === 'MARKED_FOR_REVIEW').length,
    missingConfirmations: snapshot.answers.confirmations.filter((item) => !item.confirmed).length,
    emptyAnswers: values.filter((value) => !value.trim()).length,
    unverifiedAnswers: A2P_ANSWER_KEYS.filter((key) => answerProvenance(snapshot, key) === 'UNVERIFIED_DRAFT').length,
    unsavedEdits: Object.keys(snapshot.edits).length,
    contradictions: snapshot.answers.contradictions.length,
  };
  const open = readiness.needsFixing + readiness.reviewRequired + readiness.unableToVerify + readiness.markedForReview + readiness.missingConfirmations
    + readiness.emptyAnswers + readiness.unverifiedAnswers + readiness.unsavedEdits + readiness.contradictions;
  return { ...readiness, label: snapshot.check?.state !== 'COMPLETED' ? 'NOT_CHECKED' : open ? 'OPEN_ITEMS' : 'NO_OPEN_ITEMS' };
}
