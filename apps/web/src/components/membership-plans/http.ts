import {
  CRM_ADULT_MEMBERSHIP_DRAFT_UUID, MEMBERSHIP_PLAN_CATALOG_READ_COMMAND, MEMBERSHIP_PLAN_CREATE_COMMAND, MEMBERSHIP_PLAN_REVISE_COMMAND,
  CRM_ADULT_MEMBERSHIP_PLAN_OPTIONS_COMMAND, CRM_ADULT_MEMBERSHIP_DRAFT_FROM_PLAN_COMMAND,
  validateCreateMembershipPlanInput, validateReviseMembershipPlanInput, validateCrmAdultMembershipDraftFromPlanInput, validateMembershipPlanReadInput,
  verifyMembershipPlanCatalog, verifyMembershipPlanVersionSummary, verifyCrmAdultMembershipPlanOptions, verifyCrmAdultMembershipDraftFromPlan,
  type CreateMembershipPlanInput, type ReviseMembershipPlanInput, type CrmAdultMembershipDraftFromPlanInput,
  type MembershipPlanCatalog, type MembershipPlanVersionSummary, type CrmAdultMembershipPlanOptions, type CrmAdultMembershipDraftFromPlan,
} from '@hon/contracts';

export type PlanScope = Readonly<{ organizationId: string; schoolId: string }>;
export type PlanRequest = Readonly<{ kind: 'create' | 'revise' | 'draft'; path: string; body: string; key: string }>;
export type PlanResult = { kind: 'create' | 'revise'; plan: MembershipPlanVersionSummary; replayed: boolean }
  | { kind: 'draft'; draft: CrmAdultMembershipDraftFromPlan; replayed: boolean };
export class PlanAccessError extends Error {}
export class PlanUnknownError extends Error {}
export class PlanReadError extends Error {}
export class PlanRejectedError extends Error { constructor(readonly code: string, readonly status: number, message: string) { super(message); } }
const markers = { create: MEMBERSHIP_PLAN_CREATE_COMMAND, revise: MEMBERSHIP_PLAN_REVISE_COMMAND, draft: CRM_ADULT_MEMBERSHIP_DRAFT_FROM_PLAN_COMMAND };
function invalid(): never { throw new Error('Unverified membership plan response.'); }
function uuid(value: unknown): string { if (typeof value !== 'string' || !CRM_ADULT_MEMBERSHIP_DRAFT_UUID.test(value)) invalid(); return value.toLowerCase(); }
function closed(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(k => !Object.hasOwn(row, k))) invalid();
  return row;
}
const root = (s: PlanScope) => `/api/v1/organizations/${uuid(s.organizationId)}/schools/${uuid(s.schoolId)}/billing`;
export function createPlanRequest(s: PlanScope, input: CreateMembershipPlanInput, key: string): PlanRequest {
  return Object.freeze({ kind: 'create', path: `${root(s)}/membership-plans`, body: JSON.stringify(validateCreateMembershipPlanInput(input)), key: uuid(key) });
}
export function revisePlanRequest(s: PlanScope, planId: string, input: ReviseMembershipPlanInput, key: string): PlanRequest {
  return Object.freeze({ kind: 'revise', path: `${root(s)}/membership-plans/${uuid(planId)}/revisions`, body: JSON.stringify(validateReviseMembershipPlanInput(input)), key: uuid(key) });
}
export function draftFromPlanRequest(s: PlanScope, input: CrmAdultMembershipDraftFromPlanInput, key: string): PlanRequest {
  return Object.freeze({ kind: 'draft', path: `${root(s)}/crm-adult-membership-drafts/from-plan`, body: JSON.stringify(validateCrmAdultMembershipDraftFromPlanInput(input)), key: uuid(key) });
}
function verifyRequest(request: PlanRequest): void {
  closed(request, ['kind', 'path', 'body', 'key']);
  const match = request.path.match(/^\/api\/v1\/organizations\/([^/]+)\/schools\/([^/]+)\/billing\/(.+)$/); if (!match) invalid();
  const scope = { organizationId: match[1]!, schoolId: match[2]! }, input = JSON.parse(request.body);
  let expected: PlanRequest;
  if (request.kind === 'create') expected = createPlanRequest(scope, input, request.key);
  else if (request.kind === 'revise') { const plan = match[3]!.match(/^membership-plans\/([^/]+)\/revisions$/)?.[1]; if (!plan) invalid(); expected = revisePlanRequest(scope, plan, input, request.key); }
  else if (request.kind === 'draft') expected = draftFromPlanRequest(scope, input, request.key);
  else invalid();
  if (request.path !== expected.path || request.body !== expected.body || request.key !== expected.key) invalid();
}
const MESSAGES: Record<string, string> = {
  MEMBERSHIP_PLAN_VERSION_STALE: 'This plan changed since you loaded it. Reload and review the current version before submitting again.',
  MEMBERSHIP_PLAN_CODE_TAKEN: 'That plan code is already used at this school. Choose another code.',
  MEMBERSHIP_PLAN_CURRENCY_MISMATCH: 'The plan currency differs from the verified billing account. Choose a matching plan.',
  MEMBERSHIP_PLAN_LIMIT: 'The school has reached its plan or version limit. Contact your school owner.',
  MEMBERSHIP_PLAN_UNCHANGED: 'No published terms changed. Edit a field before publishing a new version.',
  MEMBERSHIP_PLAN_UNAVAILABLE: 'This plan is no longer available. Reload the current school plans.',
  MEMBERSHIP_PLAN_PROGRAM_UNAVAILABLE: 'This program is no longer available. Reload the current school plans.',
  IDEMPOTENCY_KEY_REUSED: 'The request key conflicts with another action. Reload current records before starting a new action.',
  CRM_ADULT_MEMBERSHIP_UNAVAILABLE: 'This adult is no longer ready for a new DRAFT. Close setup and use Resume setup to verify the current state.',
};
async function exchange(path: string, marker: string, body: string, key?: string, signal?: AbortSignal): Promise<{ data: unknown; replayed: boolean }> {
  const response = await fetch(path, { method: 'POST', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': marker, ...(key ? { 'Idempotency-Key': key } : {}) }, body,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
  if (response.status === 401 || response.status === 403) throw new PlanAccessError('Your session or school access is unavailable. Sign in again or choose an authorized school.');
  if ([400, 404, 405, 409, 413, 415, 422].includes(response.status)) {
    let code = '';
    try { const text = await response.text(); if (text.length < 4000) { const error = JSON.parse(text); if (typeof error?.code === 'string') code = error.code; } } catch { /* Never expose arbitrary response text. */ }
    throw new PlanRejectedError(code, response.status, Object.hasOwn(MESSAGES, code) ? MESSAGES[code]! : (response.status === 400 ? 'Review the plan fields and confirmation. Nothing has been reported as recorded.' : 'The request could not be completed against current records. Reload and review before starting again.'));
  }
  if (response.status !== 200 || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
    || !/^private,\s*no-store$/i.test(response.headers.get('cache-control') ?? '')) invalid();
  const text = await response.text(); if (text.length > 1_000_000) invalid();
  const envelope = closed(JSON.parse(text), ['data', 'meta']), meta = closed(envelope.meta, ['requestId', 'correlationId', 'replayed']);
  if (uuid(meta.requestId) !== uuid(meta.correlationId) || typeof meta.replayed !== 'boolean' || !key && meta.replayed) invalid();
  return { data: envelope.data, replayed: meta.replayed as boolean };
}
export async function readPlanCatalog(scope: PlanScope, signal?: AbortSignal): Promise<MembershipPlanCatalog> {
  const path = `${root(scope)}/membership-plans/catalog`;
  try { return verifyMembershipPlanCatalog((await exchange(path, MEMBERSHIP_PLAN_CATALOG_READ_COMMAND, JSON.stringify(validateMembershipPlanReadInput({})), undefined, signal)).data); }
  catch (e) { if (e instanceof PlanAccessError || e instanceof PlanRejectedError) throw e; throw new PlanReadError('The catalog could not be verified. Try loading it again.'); }
}
export async function readAdultPlanOptions(scope: PlanScope, signal?: AbortSignal): Promise<CrmAdultMembershipPlanOptions> {
  const path = `${root(scope)}/crm-adult-membership-drafts/plan-options`;
  try { return verifyCrmAdultMembershipPlanOptions((await exchange(path, CRM_ADULT_MEMBERSHIP_PLAN_OPTIONS_COMMAND, JSON.stringify(validateMembershipPlanReadInput({})), undefined, signal)).data); }
  catch (e) { if (e instanceof PlanAccessError || e instanceof PlanRejectedError) throw e; throw new PlanReadError('Available plans could not be verified. Try loading them again.'); }
}
function sameTerms(plan: MembershipPlanVersionSummary, input: CreateMembershipPlanInput | ReviseMembershipPlanInput): boolean {
  return ['displayName', 'availability', 'currency', 'priceMinor', 'billingFrequency', 'termKind'].every(k => plan[k as keyof MembershipPlanVersionSummary] === input[k as keyof typeof input])
    && plan.description === (input.description ?? null) && plan.programId === (input.programId ?? null) && plan.termMonths === (input.termMonths ?? null);
}
export async function sendPlanRequest(request: PlanRequest, signal?: AbortSignal): Promise<PlanResult> {
  verifyRequest(request);
  try {
    const result = await exchange(request.path, markers[request.kind], request.body, request.key, signal), input = JSON.parse(request.body);
    if (request.kind === 'draft') return { kind: 'draft', draft: verifyCrmAdultMembershipDraftFromPlan(result.data, validateCrmAdultMembershipDraftFromPlanInput(input)), replayed: result.replayed };
    const plan = verifyMembershipPlanVersionSummary(result.data);
    if (request.kind === 'create' ? plan.planCode !== input.planCode || plan.version !== 1
      : plan.planId !== request.path.split('/').at(-2) || plan.version !== input.expectedVersion + 1) invalid();
    if (!sameTerms(plan, input)) invalid();
    return { kind: request.kind, plan, replayed: result.replayed };
  } catch (e) {
    if (e instanceof PlanAccessError || e instanceof PlanRejectedError) throw e;
    throw new PlanUnknownError('The outcome is unverified. Retry only the exact saved request, or discard this local retry and reload current records.');
  }
}
