import type { A2pDraftInput, A2pFindingCode, A2pWebsiteReviewInput } from '@hon/contracts';
import { StaffDashboardAccessError } from '../staff-dashboard-http';
import { loadCurrentStaffReportingSchool } from '../current-staff-reporting-school-http';
import {
  A2P_COPY_ACKNOWLEDGEMENT, A2P_DIGEST, A2pResponseError, parseA2pCopyResponse, parseA2pDraftResponse, parseA2pFindingResponse,
  parseA2pValidationResponse, parseA2pWebsiteResponse,
  type A2pCopyResult, type A2pDraftResult, type A2pExpectedScope, type A2pFindingResult, type A2pReviewResult, type A2pValidationResult,
} from './preparation-contract';

/**
 * HTTP adapter for Codex's five read-only A2P-1 preparation routes (PR #82).
 *
 * Scope comes only from the verified current-school resolver, never from a
 * URL, form or query value. Business facts travel only in the JSON body.
 * No route stores, submits or sends anything, so no idempotency key is used.
 */

export type A2pPreparationErrorKind =
  | 'UNAUTHORIZED' | 'DENIED' | 'OWNER_CONFIRMATION_REQUIRED' | 'NO_SCHOOL'
  | 'INVALID_INPUT' | 'URL_NOT_ALLOWED' | 'CAMPAIGN_MISMATCH'
  | 'SCHOOL_CHANGED' | 'DRAFT_CHANGED' | 'DRAFT_INCOMPLETE'
  | 'UNAVAILABLE' | 'INVALID_RESPONSE';

export class A2pPreparationError extends Error {
  constructor(readonly kind: A2pPreparationErrorKind) { super(`A2P preparation failed: ${kind}`); }
}

/** Only closed backend codes select copy; bodies are never displayed. */
const CODE_KIND: Readonly<Record<string, A2pPreparationErrorKind>> = {
  HUMAN_UI_REQUIRED: 'DENIED', A2P_PREPARATION_FORBIDDEN: 'DENIED', A2P_OWNER_FACT_CONFIRMATION_REQUIRED: 'OWNER_CONFIRMATION_REQUIRED',
  INVALID_A2P_INPUT: 'INVALID_INPUT', A2P_URL_NOT_ALLOWED: 'URL_NOT_ALLOWED', A2P_CAMPAIGN_MISMATCH: 'CAMPAIGN_MISMATCH',
  A2P_SCHOOL_CHANGED: 'SCHOOL_CHANGED', A2P_DRAFT_CHANGED: 'DRAFT_CHANGED', A2P_DRAFT_INCOMPLETE: 'DRAFT_INCOMPLETE',
  A2P_PREPARATION_UNAVAILABLE: 'UNAVAILABLE', HUMAN_UI_ORIGIN_NOT_CONFIGURED: 'UNAVAILABLE',
};
const STATUS_CODES: Readonly<Record<number, readonly string[]>> = {
  400: ['INVALID_A2P_INPUT', 'A2P_URL_NOT_ALLOWED', 'A2P_CAMPAIGN_MISMATCH'],
  403: ['HUMAN_UI_REQUIRED', 'A2P_PREPARATION_FORBIDDEN', 'A2P_OWNER_FACT_CONFIRMATION_REQUIRED'],
  409: ['A2P_SCHOOL_CHANGED', 'A2P_DRAFT_CHANGED', 'A2P_DRAFT_INCOMPLETE'],
  503: ['A2P_PREPARATION_UNAVAILABLE', 'HUMAN_UI_ORIGIN_NOT_CONFIGURED'],
};
const FALLBACK: Readonly<Record<number, A2pPreparationErrorKind>> = { 400: 'INVALID_INPUT', 401: 'UNAUTHORIZED', 403: 'DENIED', 409: 'DRAFT_CHANGED' };

export type A2pRoute = 'website-review' | 'finding-details' | 'registration-draft' | 'draft-validation' | 'copy-preparation';
export const A2P_ROUTES: readonly A2pRoute[] = ['website-review', 'finding-details', 'registration-draft', 'draft-validation', 'copy-preparation'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function a2pRoutePath(school: A2pExpectedScope, route: A2pRoute): string {
  if (!UUID.test(school.organizationId) || !UUID.test(school.schoolId)) throw new A2pPreparationError('NO_SCHOOL');
  return `/api/v1/organizations/${school.organizationId}/schools/${school.schoolId}/a2p/${route}`;
}

async function post(school: A2pExpectedScope, route: A2pRoute, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const path = a2pRoutePath(school, route);
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-HON-Human-Command': 'a2p-prepare' },
      body: JSON.stringify(body), ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new A2pPreparationError('UNAVAILABLE');
  }
  if (!response.ok) {
    let code: unknown;
    try { const parsed: unknown = await response.json(); if (parsed && typeof parsed === 'object' && 'code' in parsed) code = parsed.code; } catch { /* closed fallback below */ }
    const allowed = STATUS_CODES[response.status] ?? [];
    if (typeof code === 'string' && allowed.includes(code)) throw new A2pPreparationError(CODE_KIND[code]!);
    throw new A2pPreparationError(FALLBACK[response.status] ?? 'UNAVAILABLE');
  }
  if (response.status !== 200 || response.redirected
    || !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('Cache-Control') ?? '')
    || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '')) throw new A2pPreparationError('INVALID_RESPONSE');
  if (response.url && (typeof location === 'undefined' || response.url !== new URL(path, location.origin).href)) throw new A2pPreparationError('INVALID_RESPONSE');
  let envelope: unknown;
  try { envelope = await response.json(); } catch { throw new A2pPreparationError('INVALID_RESPONSE'); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).length !== 1 || !Object.hasOwn(envelope, 'data')) throw new A2pPreparationError('INVALID_RESPONSE');
  return (envelope as { data: unknown }).data;
}

function verified<T>(parse: () => T): T {
  try { return parse(); } catch (error) {
    if (error instanceof A2pResponseError) throw new A2pPreparationError('INVALID_RESPONSE');
    throw error;
  }
}

export interface A2pPreparationClient {
  /** The current school, re-verified on every call; never cached across a school or session change. */
  currentSchool(): Promise<A2pExpectedScope>;
  websiteReview(school: A2pExpectedScope, input: A2pWebsiteReviewInput, signal?: AbortSignal): Promise<A2pReviewResult>;
  findingDetails(school: A2pExpectedScope, review: A2pWebsiteReviewInput, code: A2pFindingCode, signal?: AbortSignal): Promise<A2pFindingResult>;
  registrationDraft(school: A2pExpectedScope, input: A2pDraftInput, signal?: AbortSignal): Promise<A2pDraftResult>;
  draftValidation(school: A2pExpectedScope, input: A2pDraftInput, signal?: AbortSignal): Promise<A2pValidationResult>;
  copyPreparation(school: A2pExpectedScope, input: A2pDraftInput, expectedDigest: string, signal?: AbortSignal): Promise<A2pCopyResult>;
}

export const A2P_HTTP_PREPARATION_CLIENT: A2pPreparationClient = Object.freeze<A2pPreparationClient>({
  async currentSchool() {
    let school;
    try { school = await loadCurrentStaffReportingSchool(); } catch (error) {
      if (error instanceof StaffDashboardAccessError && error.status === 401) throw new A2pPreparationError('UNAUTHORIZED');
      if (error instanceof StaffDashboardAccessError && error.status === 403) throw new A2pPreparationError('DENIED');
      throw new A2pPreparationError('UNAVAILABLE');
    }
    if (school.state !== 'RESOLVED') throw new A2pPreparationError('NO_SCHOOL');
    return { organizationId: school.organizationId, schoolId: school.schoolId };
  },
  async websiteReview(school, input, signal) {
    const data = await post(school, 'website-review', input, signal);
    return verified(() => parseA2pWebsiteResponse(data, school));
  },
  async findingDetails(school, review, code, signal) {
    const data = await post(school, 'finding-details', { review, findingCode: code }, signal);
    return verified(() => parseA2pFindingResponse(data, school, code));
  },
  async registrationDraft(school, input, signal) {
    const data = await post(school, 'registration-draft', input, signal);
    return verified(() => parseA2pDraftResponse(data, school, input.templates));
  },
  async draftValidation(school, input, signal) {
    const data = await post(school, 'draft-validation', input, signal);
    return verified(() => parseA2pValidationResponse(data, school, input.templates));
  },
  async copyPreparation(school, input, expectedDigest, signal) {
    if (!A2P_DIGEST.test(expectedDigest)) throw new A2pPreparationError('DRAFT_CHANGED');
    const data = await post(school, 'copy-preparation', { input, expectedDigest, acknowledgement: A2P_COPY_ACKNOWLEDGEMENT }, signal);
    return verified(() => parseA2pCopyResponse(data, school, expectedDigest));
  },
});
