/**
 * Frontend view of the A2P 10DLC registration assistant. This is a PROPOSED
 * presentation contract for coordination with Codex's A2P compliance backend;
 * no API implements it today. Every value the UI shows must come through an
 * adapter (./adapter.ts) and be narrowed by the parsers below, so an unknown
 * server value is never shown as a pass, a confirmation or an approval.
 *
 * Plain module (no 'use client'): server pages and tests import these constants.
 */

export const A2P_STEPS = ['CHECK_WEBSITE', 'FIX_WEBSITE', 'ANSWERS', 'REVIEW', 'STATUS'] as const;
export type A2pStep = typeof A2P_STEPS[number];

/** Closed website-check lifecycle. Anything else is UNKNOWN, never COMPLETED. */
export const A2P_CHECK_STATES = ['NOT_STARTED', 'QUEUED', 'CHECKING', 'COMPLETED', 'FAILED', 'UNKNOWN'] as const;
export type A2pCheckState = typeof A2P_CHECK_STATES[number];

/** Closed finding outcomes. An unrecognized outcome is UNABLE_TO_VERIFY, never PASSED. */
export const A2P_FINDING_OUTCOMES = ['PASSED', 'NEEDS_FIXING', 'REVIEW_REQUIRED', 'UNABLE_TO_VERIFY'] as const;
export type A2pFindingOutcome = typeof A2P_FINDING_OUTCOMES[number];

export const A2P_FINDING_AREAS = ['PRIVACY_POLICY', 'SMS_TERMS', 'OPT_IN', 'BUSINESS_IDENTITY', 'MESSAGE_CONTENT', 'HELP_STOP', 'OTHER'] as const;
export type A2pFindingArea = typeof A2P_FINDING_AREAS[number];

export const A2P_REVIEW_MARKS = ['NONE', 'MARKED_FOR_REVIEW'] as const;
export type A2pReviewMark = typeof A2P_REVIEW_MARKS[number];

/**
 * Where a registration answer came from. VERIFIED = backed by recorded website
 * evidence; OWNER_CONFIRMED = the owner attested it through an authorized
 * command; UNVERIFIED_DRAFT = generated wording nobody has confirmed. Unknown
 * values fall back to UNVERIFIED_DRAFT.
 */
export const A2P_PROVENANCE = ['VERIFIED', 'OWNER_CONFIRMED', 'UNVERIFIED_DRAFT'] as const;
export type A2pProvenance = typeof A2P_PROVENANCE[number];

export const A2P_ANSWER_KEYS = [
  'CAMPAIGN_DESCRIPTION', 'MESSAGE_FLOW', 'SAMPLE_MESSAGE_1', 'SAMPLE_MESSAGE_2', 'SAMPLE_MESSAGE_3',
  'HELP_RESPONSE', 'STOP_RESPONSE', 'WEBSITE_URL', 'PRIVACY_POLICY_URL', 'TERMS_URL',
] as const;
export type A2pAnswerKey = typeof A2P_ANSWER_KEYS[number];

/** Future provider-reported registration states; shown only when the server verifies one. */
export const A2P_REGISTRATION_STATUSES = ['NOT_STARTED', 'DRAFT', 'NEEDS_CORRECTION', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'UNKNOWN'] as const;
export type A2pRegistrationStatus = typeof A2P_REGISTRATION_STATUSES[number];

export const A2P_CONFIRMATION_KEYS = ['CONSENT_ONLY', 'NO_SHARING', 'MESSAGE_TYPES', 'NOT_CONDITION_OF_PURCHASE', 'HELP_STOP_HONORED'] as const;
export type A2pConfirmationKey = typeof A2P_CONFIRMATION_KEYS[number];

/** Who supplied the data on screen. SYNTHETIC_FIXTURE is only ever used by the gated reference preview. */
export type A2pSource = 'NOT_CONNECTED' | 'SERVER' | 'SYNTHETIC_FIXTURE';

export interface A2pCapabilities {
  websiteCheck: boolean;
  findingReview: boolean;
  answerDrafts: boolean;
  /** Explicit save of edited answers. Autosave is never assumed. */
  saveAnswers: boolean;
  ownerConfirmations: boolean;
  registrationStatus: boolean;
  /** Governed HON conversation for this feature. */
  assistant: boolean;
}
export const NO_A2P_CAPABILITIES: Readonly<A2pCapabilities> = Object.freeze({
  websiteCheck: false, findingReview: false, answerDrafts: false, saveAnswers: false, ownerConfirmations: false, registrationStatus: false, assistant: false,
});

export type A2pAvailability =
  | { state: 'NOT_CONNECTED' }
  | { state: 'DENIED' }
  | { state: 'ERROR' }
  | { state: 'READY'; source: Exclude<A2pSource, 'NOT_CONNECTED'>; capabilities: A2pCapabilities };

export interface A2pFindingLocation { pageUrl: string | null; sectionLabel: string | null }
export interface A2pFinding {
  id: string;
  area: A2pFindingArea;
  outcome: A2pFindingOutcome;
  title: string;
  explanation: string;
  whyItMatters: string;
  location: A2pFindingLocation;
  originalText: string | null;
  suggestedText: string | null;
  /** When the evidence was observed; null means nothing was observed. */
  observedAt: string | null;
  review: A2pReviewMark;
}

export interface A2pWebsiteCheck {
  checkId: string | null;
  state: A2pCheckState;
  websiteUrl: string | null;
  pagesChecked: number | null;
  pagesPlanned: number | null;
  completedAt: string | null;
  findings: A2pFinding[];
}

export interface A2pAnswer {
  key: A2pAnswerKey;
  value: string;
  provenance: A2pProvenance;
  /** Short evidence or caveat lines supplied by the server. */
  notes: string[];
}

export interface A2pConfirmation { key: A2pConfirmationKey; confirmed: boolean; confirmedAt: string | null }

export interface A2pContradiction { id: string; summary: string; answerKeys: A2pAnswerKey[]; findingIds: string[] }

export interface A2pAnswerSet {
  answers: A2pAnswer[];
  confirmations: A2pConfirmation[];
  contradictions: A2pContradiction[];
  revision: number | null;
}

export interface A2pStatusView { status: A2pRegistrationStatus; reportedAt: string | null; providerReference: string | null; reasons: string[] }

// ---------- parsers: every server value is narrowed before display ----------

const oneOf = <T extends string>(values: readonly T[], value: unknown, fallback: T): T => (values as readonly unknown[]).includes(value) ? value as T : fallback;
const text = (value: unknown, max = 4000): string => typeof value === 'string' ? value.slice(0, max) : '';
const nullableText = (value: unknown, max = 4000): string | null => typeof value === 'string' && value.trim() ? value.slice(0, max) : null;
const timestamp = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown, max = 200): unknown[] => Array.isArray(value) ? value.slice(0, max) : [];

export const parseCheckState = (value: unknown): A2pCheckState => oneOf(A2P_CHECK_STATES, value, 'UNKNOWN');
export const parseFindingOutcome = (value: unknown): A2pFindingOutcome => oneOf(A2P_FINDING_OUTCOMES, value, 'UNABLE_TO_VERIFY');
export const parseProvenance = (value: unknown): A2pProvenance => oneOf(A2P_PROVENANCE, value, 'UNVERIFIED_DRAFT');
export const parseRegistrationStatus = (value: unknown): A2pRegistrationStatus => oneOf(A2P_REGISTRATION_STATUSES, value, 'UNKNOWN');

/** Links from the server are shown only when they are plain http(s) URLs. */
export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}

export function parseFinding(value: unknown): A2pFinding | null {
  const row = record(value);
  const id = nullableText(row.id, 120);
  if (!id) return null;
  const location = record(row.location);
  const outcome = parseFindingOutcome(row.outcome);
  const observedAt = timestamp(row.observedAt);
  return {
    id,
    area: oneOf(A2P_FINDING_AREAS, row.area, 'OTHER'),
    // A pass without recorded evidence is not a pass.
    outcome: outcome === 'PASSED' && !observedAt ? 'UNABLE_TO_VERIFY' : outcome,
    title: text(row.title, 200),
    explanation: text(row.explanation),
    whyItMatters: text(row.whyItMatters),
    location: { pageUrl: safeExternalUrl(location.pageUrl), sectionLabel: nullableText(location.sectionLabel, 200) },
    originalText: nullableText(row.originalText),
    suggestedText: nullableText(row.suggestedText),
    observedAt,
    review: oneOf(A2P_REVIEW_MARKS, row.review, 'NONE'),
  };
}

export function parseWebsiteCheck(value: unknown): A2pWebsiteCheck {
  const row = record(value);
  const state = parseCheckState(row.state);
  return {
    checkId: nullableText(row.checkId, 120),
    state,
    websiteUrl: safeExternalUrl(row.websiteUrl),
    pagesChecked: count(row.pagesChecked),
    pagesPlanned: count(row.pagesPlanned),
    completedAt: state === 'COMPLETED' ? timestamp(row.completedAt) : null,
    // Findings are shown only for a completed check; partial results are never presented as an evaluation.
    findings: state === 'COMPLETED' ? list(row.findings).map(parseFinding).filter((finding): finding is A2pFinding => finding !== null) : [],
  };
}

export function parseAnswerSet(value: unknown): A2pAnswerSet {
  const row = record(value);
  const answers = new Map<A2pAnswerKey, A2pAnswer>();
  for (const item of list(row.answers)) {
    const answer = record(item);
    const key = oneOf<A2pAnswerKey | 'INVALID'>([...A2P_ANSWER_KEYS], answer.key, 'INVALID');
    if (key === 'INVALID' || answers.has(key)) continue;
    answers.set(key, { key, value: text(answer.value, 2000), provenance: parseProvenance(answer.provenance), notes: list(answer.notes, 6).map((note) => text(note, 400)).filter(Boolean) });
  }
  const confirmations = A2P_CONFIRMATION_KEYS.map((key) => {
    const match = list(row.confirmations).map(record).find((item) => item.key === key);
    const confirmedAt = timestamp(match?.confirmedAt);
    // A confirmation counts only with the server's recorded time.
    return { key, confirmed: match?.confirmed === true && confirmedAt !== null, confirmedAt };
  });
  const contradictions = list(row.contradictions, 50).map(record).flatMap((item) => {
    const id = nullableText(item.id, 120), summary = nullableText(item.summary, 600);
    if (!id || !summary) return [];
    return [{
      id, summary,
      answerKeys: list(item.answerKeys, 10).filter((key): key is A2pAnswerKey => (A2P_ANSWER_KEYS as readonly unknown[]).includes(key)),
      findingIds: list(item.findingIds, 20).map((entry) => text(entry, 120)).filter(Boolean),
    }];
  });
  return { answers: A2P_ANSWER_KEYS.map((key) => answers.get(key) ?? blankAnswer(key)), confirmations, contradictions, revision: count(row.revision) };
}

export function parseStatusView(value: unknown): A2pStatusView {
  const row = record(value);
  return {
    status: parseRegistrationStatus(row.status),
    reportedAt: timestamp(row.reportedAt),
    providerReference: nullableText(row.providerReference, 120),
    reasons: list(row.reasons, 10).map((reason) => text(reason, 600)).filter(Boolean),
  };
}

export function blankAnswer(key: A2pAnswerKey): A2pAnswer {
  return { key, value: '', provenance: 'UNVERIFIED_DRAFT', notes: [] };
}
export function blankAnswerSet(): A2pAnswerSet {
  return {
    answers: A2P_ANSWER_KEYS.map(blankAnswer),
    confirmations: A2P_CONFIRMATION_KEYS.map((key) => ({ key, confirmed: false, confirmedAt: null })),
    contradictions: [],
    revision: null,
  };
}

export type A2pWebsiteInput = { ok: true; url: string } | { ok: false; reason: 'EMPTY' | 'INVALID' | 'UNSUPPORTED' };

/**
 * Client-side tidy-up of what the owner typed. This is a usability check only;
 * the backend must still enforce its own URL and network-safety rules.
 */
export function normalizeWebsiteInput(raw: string): A2pWebsiteInput {
  const value = raw.trim();
  if (!value) return { ok: false, reason: 'EMPTY' };
  if (value.length > 2048 || /\s/.test(value)) return { ok: false, reason: 'INVALID' };
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`); } catch { return { ok: false, reason: 'INVALID' }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'UNSUPPORTED' };
  if (url.username || url.password || url.port) return { ok: false, reason: 'UNSUPPORTED' };
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host.endsWith('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || /^[\d.]+$/.test(host) || host.startsWith('[')) return { ok: false, reason: 'UNSUPPORTED' };
  url.hash = '';
  return { ok: true, url: url.toString() };
}
