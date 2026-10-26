import {
  A2P_COPY_CONFIRMATION, A2P_ENGINE_VERSION, A2P_FINDING_CODES, A2P_STATUSES, A2P_TEMPLATES,
  type A2pDraft, type A2pFinding, type A2pFindingCode, type A2pSchoolScope, type A2pSource as A2pRuleSource, type A2pStatus,
  type A2pTemplate, type A2pWebsiteReview,
} from '@hon/contracts';

/**
 * Strict readers for Codex's A2P-1 preparation responses (PR #82). Every
 * response is checked against the exact closed shape before the UI sees it,
 * and the honesty invariants are re-checked here rather than trusted:
 * nothing is saved, submitted, approved or sent, and a review whose live
 * inspection is disabled cannot carry an observed outcome or evidence.
 */

export class A2pResponseError extends Error {
  constructor() { super('HON could not verify the A2P preparation response. Nothing is shown from it.'); }
}
function invalid(): never { throw new A2pResponseError(); }

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key))) invalid();
  return row;
}
const text = (value: unknown, max = 4096): string => (typeof value === 'string' && value.length <= max ? value : invalid());
const list = (value: unknown, max: number): unknown[] => (Array.isArray(value) && value.length <= max ? value : invalid());
const CODE = /^[A-Za-z][A-Za-z0-9._]{0,79}$/;
const codes = (value: unknown): string[] => list(value, 32).map((item) => (typeof item === 'string' && CODE.test(item) ? item : invalid()));
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const A2P_DIGEST = /^[a-f0-9]{64}$/;

/** Plain https link without credentials; anything else is shown as text only. */
export function a2pLink(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export interface A2pExpectedScope { organizationId: string; schoolId: string }

function scope(value: unknown, expected: A2pExpectedScope): A2pSchoolScope {
  const row = exact(value, ['organizationId', 'schoolId', 'schoolName', 'canConfirmOwnerFacts']);
  if (row.organizationId !== expected.organizationId || row.schoolId !== expected.schoolId || typeof row.canConfirmOwnerFacts !== 'boolean') invalid();
  return { organizationId: expected.organizationId, schoolId: expected.schoolId, schoolName: text(row.schoolName, 200), canConfirmOwnerFacts: row.canConfirmOwnerFacts };
}
function readOnly(row: Record<string, unknown>): void {
  if (row.readOnly !== true || row.persistence !== 'NONE') invalid();
}
function digest(value: unknown): string { return typeof value === 'string' && A2P_DIGEST.test(value) ? value : invalid(); }

function sources(value: unknown): A2pRuleSource[] {
  const rows = list(value, 16).map((item) => {
    const row = exact(item, ['id', 'url', 'reviewedOn']);
    if (typeof row.id !== 'string' || !CODE.test(row.id) || typeof row.reviewedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.reviewedOn)) invalid();
    return { id: row.id, url: text(row.url, 2048), reviewedOn: row.reviewedOn } as A2pRuleSource;
  });
  if (new Set(rows.map((row) => row.id)).size !== rows.length) invalid();
  return rows;
}

function finding(value: unknown, sourceIds: ReadonlySet<string>): A2pFinding {
  const row = exact(value, ['code', 'status', 'reason', 'remediation', 'sourceIds', 'evidence']);
  if (!A2P_FINDING_CODES.includes(row.code as A2pFindingCode) || !A2P_STATUSES.includes(row.status as A2pStatus)) invalid();
  const ids = codes(row.sourceIds);
  if (ids.some((id) => !sourceIds.has(id))) invalid();
  const evidence = list(row.evidence, 4).map((item) => {
    const e = exact(item, ['id', 'url', 'provenance', 'observedAt', 'excerpt']);
    // Only fixture evidence exists in A2P-1; any other provenance would be an unreviewed claim.
    if (e.provenance !== 'SYNTHETIC_FIXTURE' || typeof e.id !== 'string' || !/^[A-Z0-9_-]{1,80}$/.test(e.id)
      || typeof e.observedAt !== 'string' || !ISO.test(e.observedAt)) invalid();
    return { id: e.id, url: text(e.url, 2048), provenance: 'SYNTHETIC_FIXTURE' as const, observedAt: e.observedAt, excerpt: text(e.excerpt, 500) };
  });
  const reason = text(row.reason, 80);
  if (!CODE.test(reason)) invalid();
  return { code: row.code as A2pFindingCode, status: row.status as A2pStatus, reason, remediation: text(row.remediation, 1000), sourceIds: ids, evidence };
}

export interface A2pReviewResult { scope: A2pSchoolScope; review: A2pWebsiteReview; digest: string }

export function parseA2pWebsiteResponse(value: unknown, expected: A2pExpectedScope): A2pReviewResult {
  const row = exact(value, ['scope', 'review', 'computationDigest', 'readOnly', 'persistence']);
  readOnly(row);
  const r = exact(row.review, ['engineVersion', 'inspection', 'overallStatus', 'findings', 'sources', 'carrierApproval', 'legalCompliance']);
  if (r.engineVersion !== A2P_ENGINE_VERSION || (r.inspection !== 'LIVE_INSPECTION_DISABLED' && r.inspection !== 'SYNTHETIC_FIXTURE')
    || !A2P_STATUSES.includes(r.overallStatus as A2pStatus) || r.carrierApproval !== 'NOT_REQUESTED' || r.legalCompliance !== 'NOT_DETERMINED') invalid();
  const ruleSources = sources(r.sources);
  const known = new Set(ruleSources.map((source) => source.id));
  const findings = list(r.findings, A2P_FINDING_CODES.length).map((item) => finding(item, known));
  // All thirteen checks, once each, in the engine's order: a dropped check must not look like a pass.
  if (findings.length !== A2P_FINDING_CODES.length || findings.some((item, index) => item.code !== A2P_FINDING_CODES[index])) invalid();
  // With live inspection disabled nothing was looked at, so no check may claim an outcome or evidence.
  if (r.inspection === 'LIVE_INSPECTION_DISABLED' && (r.overallStatus !== 'UNAVAILABLE' || findings.some((item) => item.status !== 'UNAVAILABLE' || item.evidence.length))) invalid();
  // Evidence-free outcomes are not observations.
  if (findings.some((item) => item.status !== 'UNAVAILABLE' && !item.evidence.length)) invalid();
  if (r.overallStatus === 'PASS') invalid();
  return {
    scope: scope(row.scope, expected), digest: digest(row.computationDigest),
    review: { engineVersion: A2P_ENGINE_VERSION, inspection: r.inspection, overallStatus: r.overallStatus as A2pStatus, findings, sources: ruleSources, carrierApproval: 'NOT_REQUESTED', legalCompliance: 'NOT_DETERMINED' },
  };
}

export interface A2pFindingResult { scope: A2pSchoolScope; finding: A2pFinding; sources: A2pRuleSource[] }

export function parseA2pFindingResponse(value: unknown, expected: A2pExpectedScope, code: A2pFindingCode): A2pFindingResult {
  const row = exact(value, ['scope', 'finding', 'sources', 'readOnly', 'persistence']);
  readOnly(row);
  const ruleSources = sources(row.sources);
  const result = finding(row.finding, new Set(ruleSources.map((source) => source.id)));
  if (result.code !== code || (result.status === 'UNAVAILABLE') !== (result.evidence.length === 0)) invalid();
  return { scope: scope(row.scope, expected), finding: result, sources: ruleSources };
}

const ANSWER_KEYS = ['campaignUseCase', 'campaignDescription', 'messageFlow', 'websiteUrl', 'privacyPolicyUrl', 'termsAndConditionsUrl', 'optInUrl'] as const;
export type A2pDraftAnswerKey = typeof ANSWER_KEYS[number];
export const A2P_DRAFT_ANSWER_KEYS = ANSWER_KEYS;

function draft(value: unknown, templates: readonly A2pTemplate[]): A2pDraft {
  const d = exact(value, ['engineVersion', 'language', 'state', 'missingFields', 'warnings', 'answers', 'sampleMessages', 'helpResponseSample',
    'stopResponseSample', 'copyPreparationAvailable', 'factsProvenance', 'consentRecorded', 'saved', 'submitted', 'messagesSent']);
  if (d.engineVersion !== A2P_ENGINE_VERSION || d.language !== 'en' || (d.state !== 'NEEDS_INPUT' && d.state !== 'DRAFT_FOR_OWNER_REVIEW')
    || d.factsProvenance !== 'OWNER_STATEMENTS_NOT_INDEPENDENTLY_VERIFIED'
    || d.consentRecorded !== false || d.saved !== false || d.submitted !== false || d.messagesSent !== 0 || typeof d.copyPreparationAvailable !== 'boolean') invalid();
  const ready = d.state === 'DRAFT_FOR_OWNER_REVIEW';
  const missingFields = codes(d.missingFields), warnings = codes(d.warnings);
  // A draft is copy-ready exactly when nothing is missing; any disagreement is an unreviewed claim.
  if (d.copyPreparationAvailable !== ready || ready !== (missingFields.length === 0)) invalid();
  let answers: A2pDraft['answers'] = null;
  if (ready) {
    const a = exact(d.answers, ANSWER_KEYS);
    answers = Object.fromEntries(ANSWER_KEYS.map((key) => [key, text(a[key], 4096)])) as unknown as NonNullable<A2pDraft['answers']>;
  } else if (d.answers !== null) invalid();
  const samples = list(d.sampleMessages, 5).map((item) => {
    const s = exact(item, ['template', 'content']);
    if (!templates.includes(s.template as A2pTemplate)) invalid();
    return { template: s.template as A2pTemplate, content: text(s.content, 1024) };
  });
  if (ready ? samples.length < 2 : samples.length !== 0) invalid();
  const help = d.helpResponseSample === null ? null : text(d.helpResponseSample, 320);
  const stop = d.stopResponseSample === null ? null : text(d.stopResponseSample, 320);
  if (ready ? help === null || stop === null : help !== null || stop !== null) invalid();
  return {
    engineVersion: A2P_ENGINE_VERSION, language: 'en', state: d.state as A2pDraft['state'], missingFields, warnings, answers, sampleMessages: samples,
    helpResponseSample: help, stopResponseSample: stop, copyPreparationAvailable: ready, factsProvenance: 'OWNER_STATEMENTS_NOT_INDEPENDENTLY_VERIFIED',
    consentRecorded: false, saved: false, submitted: false, messagesSent: 0,
  };
}

export interface A2pDraftResult { scope: A2pSchoolScope; draft: A2pDraft; digest: string }
export interface A2pValidationResult extends A2pDraftResult {
  validation: { readyForCopyPreparation: boolean; missingFields: string[]; warnings: string[]; providerEligibility: 'NOT_VERIFIED'; approval: 'NOT_REQUESTED' };
}

export function parseA2pDraftResponse(value: unknown, expected: A2pExpectedScope, templates: readonly A2pTemplate[]): A2pDraftResult {
  const row = exact(value, ['scope', 'draft', 'computationDigest', 'readOnly', 'persistence']);
  readOnly(row);
  return { scope: scope(row.scope, expected), draft: draft(row.draft, templates), digest: digest(row.computationDigest) };
}

export function parseA2pValidationResponse(value: unknown, expected: A2pExpectedScope, templates: readonly A2pTemplate[]): A2pValidationResult {
  const row = exact(value, ['scope', 'draft', 'computationDigest', 'readOnly', 'persistence', 'validation']);
  readOnly(row);
  const parsed = draft(row.draft, templates);
  const v = exact(row.validation, ['readyForCopyPreparation', 'missingFields', 'warnings', 'providerEligibility', 'approval']);
  const missingFields = codes(v.missingFields), warnings = codes(v.warnings);
  if (v.readyForCopyPreparation !== parsed.copyPreparationAvailable || v.providerEligibility !== 'NOT_VERIFIED' || v.approval !== 'NOT_REQUESTED'
    || missingFields.join() !== parsed.missingFields.join() || warnings.join() !== parsed.warnings.join()) invalid();
  return {
    scope: scope(row.scope, expected), draft: parsed, digest: digest(row.computationDigest),
    validation: { readyForCopyPreparation: parsed.copyPreparationAvailable, missingFields, warnings, providerEligibility: 'NOT_VERIFIED', approval: 'NOT_REQUESTED' },
  };
}

export interface A2pCopyResult { scope: A2pSchoolScope; digest: string; filename: 'hon-a2p-draft.txt'; content: string }

export function parseA2pCopyResponse(value: unknown, expected: A2pExpectedScope, expectedDigest: string): A2pCopyResult {
  const row = exact(value, ['scope', 'computationDigest', 'format', 'filename', 'content', 'readOnly', 'persistence', 'submitted', 'messagesSent']);
  readOnly(row);
  if (row.format !== 'TEXT' || row.filename !== 'hon-a2p-draft.txt' || row.submitted !== false || row.messagesSent !== 0 || row.computationDigest !== expectedDigest) invalid();
  return { scope: scope(row.scope, expected), digest: expectedDigest, filename: 'hon-a2p-draft.txt', content: text(row.content, 32768) };
}

export const A2P_COPY_ACKNOWLEDGEMENT = A2P_COPY_CONFIRMATION;
export const A2P_TEMPLATE_ORDER = A2P_TEMPLATES;
