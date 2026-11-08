import {
  HON_DELEGATE_AGENTS, validateHonConversationCreate, validateHonConversationSummary, validateHonConversationThread, validateHonTurnReceipt, validateHonTurnRequest,
  type HonConversationPage, type HonConversationReadiness, type HonConversationSummary, type HonConversationThread, type HonTurnReceipt,
  type HonTurnRequest,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';
import { crmLeadListPath } from '../crm-leads-http';
import {
  HonTargetDrift, verifyCampaignTargets, verifyCurriculumTargets, verifyLeadTargets, verifyOrchestrations, type HonDelegateTarget,
} from './hon-suggestions';
import type { HonDelegateAgentKey, HonOrchestrationList } from '@hon/contracts';

/**
 * C1/C2 HON conversation transport. Fixed same-origin paths for exactly one verified school; the ids are selectors only and
 * the API re-derives the human, school and permission from the signed session. Writes carry the human-UI command header
 * and a fresh UUID Idempotency-Key that is frozen with the body, so an unknown outcome is retried byte-for-byte and the
 * server never creates a second turn or a second provider call.
 */
export type HonConversationFailure = 'SESSION' | 'FORBIDDEN' | 'INVALID' | 'CONFLICT' | 'UNAVAILABLE' | 'UNKNOWN';
export class HonConversationError extends Error {
  constructor(readonly kind: HonConversationFailure, readonly code: string | null = null) { super('The HON conversation could not be verified.'); }
}
export const HON_CONVERSATION_COMMAND = 'hon-conversation';
/**
 * True only while the caller still owns the request (mounted, same privacy epoch, still the pending command or current read).
 * A 401 for a retired request is never reported as this session's end: it may belong to a session that was already replaced.
 */
export type Owned = () => boolean;
const always: Owned = () => true;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const READ = { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' } as const;
const DEFINITIVE_CONFLICTS: ReadonlySet<string> = new Set(['HON_IDEMPOTENCY_CONFLICT', 'HON_CONVERSATION_FULL']);
const drift = (): never => { throw new HonConversationError('UNAVAILABLE'); };

export type HonSchool = Readonly<{ organizationId: string; schoolId: string }>;
export function honConversationBase(school: HonSchool): string {
  const organization = school.organizationId.trim().toLowerCase(), id = school.schoolId.trim().toLowerCase();
  if (!UUID.test(organization) || !UUID.test(id)) throw new HonConversationError('INVALID');
  return `/api/v1/organizations/${organization}/schools/${id}/hon`;
}

function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return drift();
  const own = Object.keys(value);
  if (own.length !== keys.length || keys.some((key) => !own.includes(key))) return drift();
  return value as Record<string, unknown>;
}

/** Readiness is composed server-side from AI-R1; any drift means the composer stays closed. */
export function verifyHonReadiness(envelope: unknown): HonConversationReadiness {
  const root = closed(envelope, ['data', 'meta']);
  const r = closed(root.data, ['contract', 'providerRoute', 'entitlement', 'authorization', 'availableAgentKeys', 'honReply', 'asOf']);
  if (r.contract !== true || typeof r.providerRoute !== 'boolean' || typeof r.entitlement !== 'boolean' || typeof r.authorization !== 'boolean'
    || typeof r.honReply !== 'boolean' || typeof r.asOf !== 'string' || !TIME.test(r.asOf) || !Array.isArray(r.availableAgentKeys)
    || r.availableAgentKeys.some((key) => !(HON_DELEGATE_AGENTS as readonly unknown[]).includes(key)) || new Set(r.availableAgentKeys).size !== r.availableAgentKeys.length) drift();
  return r as unknown as HonConversationReadiness;
}

export function verifyHonPage(envelope: unknown): HonConversationPage {
  const page = closed(closed(envelope, ['data']).data, ['items', 'nextCursor']);
  if (!Array.isArray(page.items) || page.items.length > 50 || !(page.nextCursor === null || (typeof page.nextCursor === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(page.nextCursor)))) drift();
  try { return { items: (page.items as unknown[]).map((item) => validateHonConversationSummary(item)), nextCursor: page.nextCursor as string | null }; } catch { return drift(); }
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    const code = body && typeof body === 'object' && !Array.isArray(body) ? (body as { code?: unknown }).code : undefined;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : null;
  } catch { return null; }
}

async function read<T>(path: string, verify: (value: unknown) => T, signal: AbortSignal, owned: Owned = always): Promise<T> {
  let response: Response;
  try { response = await fetch(path, { ...READ, headers: { Accept: 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) }); }
  catch (error) { if (signal.aborted) throw error; throw new HonConversationError('UNAVAILABLE'); }
  signal.throwIfAborted();
  if (response.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new HonConversationError('SESSION'); }
  if (response.status === 403) throw new HonConversationError('FORBIDDEN');
  if (response.status !== 200) throw new HonConversationError('UNAVAILABLE');
  let body: unknown;
  try { body = await response.json(); } catch { return drift(); }
  return verify(body);
}

/** One frozen write: path, body and key never change between a send and its explicit retry. */
export type PreparedHonCommand = Readonly<{ path: string; key: string; body: string }>;

export function prepareConversation(school: HonSchool, title: string): PreparedHonCommand {
  let checked: { title: string };
  try { checked = validateHonConversationCreate({ title }); } catch { throw new HonConversationError('INVALID'); }
  return Object.freeze({ path: `${honConversationBase(school)}/conversations`, key: crypto.randomUUID(), body: JSON.stringify(checked) });
}

export function prepareTurn(school: HonSchool, conversationId: string, request: HonTurnRequest): PreparedHonCommand {
  if (!UUID.test(conversationId)) throw new HonConversationError('INVALID');
  let checked: HonTurnRequest;
  try { checked = validateHonTurnRequest(request); } catch { throw new HonConversationError('INVALID'); }
  return Object.freeze({ path: `${honConversationBase(school)}/conversations/${conversationId.toLowerCase()}/turns`, key: crypto.randomUUID(), body: JSON.stringify(checked) });
}

async function send<T>(prepared: PreparedHonCommand, verify: (value: unknown) => T, owned: Owned = always): Promise<T> {
  let response: Response;
  try {
    response = await fetch(prepared.path, { method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': HON_CONVERSATION_COMMAND, 'Idempotency-Key': prepared.key },
      body: prepared.body, signal: AbortSignal.timeout(90000) });
  } catch { throw new HonConversationError('UNKNOWN'); }
  if (response.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new HonConversationError('SESSION'); }
  if (response.status === 403) throw new HonConversationError('FORBIDDEN', await errorCode(response));
  if (response.status === 400 || response.status === 404) throw new HonConversationError('INVALID', await errorCode(response));
  if (response.status === 409) {
    const code = await errorCode(response);
    // Only a reused key or a full conversation is definitive (both roll back); any other 409 may have committed.
    throw new HonConversationError(code !== null && DEFINITIVE_CONFLICTS.has(code) ? 'CONFLICT' : 'UNKNOWN', code);
  }
  // Every other non-200 (including 5xx and timeouts) may have committed: keep the exact request for an explicit retry.
  if (response.status !== 200) throw new HonConversationError('UNKNOWN', await errorCode(response));
  let body: unknown;
  try { body = await response.json(); } catch { throw new HonConversationError('UNKNOWN'); }
  try { return verify(closed(body, ['data']).data); } catch { throw new HonConversationError('UNKNOWN'); }
}

export interface HonConversationApi {
  readiness(school: HonSchool, signal: AbortSignal, owned?: Owned): Promise<HonConversationReadiness>;
  list(school: HonSchool, signal: AbortSignal, cursor?: string | null, owned?: Owned): Promise<HonConversationPage>;
  thread(school: HonSchool, conversationId: string, signal: AbortSignal, owned?: Owned): Promise<HonConversationThread>;
  create(prepared: PreparedHonCommand, owned?: Owned): Promise<HonConversationSummary>;
  sendTurn(prepared: PreparedHonCommand, owned?: Owned): Promise<HonTurnReceipt>;
  /** C3a: the grouped confirmations of this conversation's HON answers. */
  orchestrations(school: HonSchool, conversationId: string, signal: AbortSignal, owned?: Owned): Promise<HonOrchestrationList>;
  /** C3a: the targets one specialist accepts, from that specialist's own list API for this signed-in human. */
  targets(agent: HonDelegateAgentKey, school: HonSchool, signal: AbortSignal, owned?: Owned): Promise<HonDelegateTarget[]>;
}

const verifyTargets = (verify: (value: unknown) => HonDelegateTarget[]) => (body: unknown) => {
  try { return verify(body); } catch (error) { if (error instanceof HonTargetDrift) return drift(); throw error; }
};
export function honTargetPath(agent: HonDelegateAgentKey, school: HonSchool): string {
  honConversationBase(school);
  if (agent === 'marcus') return '/api/v1/marketing/campaigns';
  if (agent === 'kai') return '/api/v1/staff/teaching-assistant/curricula';
  try { return crmLeadListPath(school.organizationId.trim(), school.schoolId.trim(), 'OPEN'); } catch { throw new HonConversationError('INVALID'); }
}

export const HON_CONVERSATION_API: HonConversationApi = {
  readiness: (school, signal, owned) => read(`${honConversationBase(school)}/readiness`, verifyHonReadiness, signal, owned),
  list: (school, signal, cursor = null, owned) => read(`${honConversationBase(school)}/conversations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, verifyHonPage, signal, owned),
  thread: (school, conversationId, signal, owned) => {
    if (!UUID.test(conversationId)) throw new HonConversationError('INVALID');
    return read(`${honConversationBase(school)}/conversations/${conversationId.toLowerCase()}`, (body) => {
      try { return validateHonConversationThread(closed(body, ['data']).data); } catch { return drift(); }
    }, signal, owned);
  },
  create: (prepared, owned) => send(prepared, (value) => validateHonConversationSummary(value), owned),
  sendTurn: (prepared, owned) => send(prepared, validateHonTurnReceipt, owned),
  orchestrations: (school, conversationId, signal, owned) => {
    if (!UUID.test(conversationId)) throw new HonConversationError('INVALID');
    return read(`${honConversationBase(school)}/conversations/${conversationId.toLowerCase()}/orchestrations`, (body) => {
      try { return verifyOrchestrations(body); } catch { return drift(); }
    }, signal, owned);
  },
  targets: (agent, school, signal, owned) => read(honTargetPath(agent, school),
    verifyTargets(agent === 'marcus' ? verifyCampaignTargets : agent === 'kai' ? verifyCurriculumTargets : verifyLeadTargets), signal, owned),
};
