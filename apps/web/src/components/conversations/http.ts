import {
  CONVERSATION_MARK_READ_COMMAND, CONVERSATION_REPLY_COMMAND, CONVERSATION_UPDATE_COMMAND,
  validateConversationListQuery, validateMarkConversationReadInput, validateReplyConversationInput, validateUpdateConversationInput,
  verifyConversationDetail, verifyConversationList, verifyConversationReadMark, verifyConversationReplyReceipt, verifyConversationUpdateReceipt,
  type ConversationDetail, type ConversationList, type ConversationListQuery, type ConversationReadMark, type ConversationReplyReceipt,
  type ConversationStatus, type ConversationUpdateReceipt,
} from '@hon/contracts';

/**
 * School conversations (0364): same-origin browser commands only. The shell's school scope is sent and checked again by
 * the server with conversation.read / conversation.manage; nothing here decides permission. A reply only queues a text:
 * the delivery worker re-checks consent, quiet hours and the number before anything is sent.
 */
export class ConversationsAccessError extends Error { constructor(readonly reason: 'SESSION' | 'FORBIDDEN', readonly status: number) { super(reason); } }
/** A definite refusal (nothing stored): the code tells the screen which plain message to show; a retry is a new command. */
export class ConversationsRefusal extends Error { constructor(readonly code: string) { super(code); } }
/** The answer could not be checked or the outcome is unknown: a reply may or may not have been queued. */
export class ConversationsUnknown extends Error {}
export type ConversationsScope = Readonly<{ organizationId: string; schoolId: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Codes the server returns for a definite refusal. Anything else is treated as unknown. */
export const CONVERSATION_REFUSALS = [
  'VALIDATION_FAILED', 'CONVERSATION_NOT_FOUND', 'CONVERSATION_VERSION_CONFLICT', 'IDEMPOTENCY_KEY_REUSED', 'CONVERSATION_NOT_LINKED',
  'CONVERSATION_ADDRESS_MISMATCH', 'CONVERSATION_NO_SENDER', 'CONVERSATION_CONSENT_REQUIRED', 'CONVERSATION_CHANNEL_UNSUPPORTED',
  'CONVERSATION_ASSIGNEE_INVALID', 'CONVERSATION_LINK_INVALID', 'CONVERSATION_ALREADY_LINKED', 'CONVERSATION_PIPELINE_INVALID',
] as const;
const REFUSAL = new Set<string>(CONVERSATION_REFUSALS);
function invalid(): never { throw new ConversationsUnknown('unverified'); }

async function call(url: string, method: 'GET' | 'POST', command?: string, body?: unknown, key?: string): Promise<{ data: unknown; meta?: unknown }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method === 'POST') { headers['Content-Type'] = 'application/json'; headers['X-HON-Human-Command'] = command!; if (key) headers['Idempotency-Key'] = key; }
  let response: Response;
  try {
    response = await fetch(url, { method, credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', headers,
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
  } catch { throw new ConversationsUnknown('network'); }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
  const value: unknown = await response.json().catch(() => invalid());
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const root = value as Record<string, unknown>;
  if (!response.ok) {
    if (response.status === 401) throw new ConversationsAccessError('SESSION', 401);
    if (response.status === 403) throw new ConversationsAccessError('FORBIDDEN', 403);
    if (REFUSAL.has(String(root.code))) throw new ConversationsRefusal(String(root.code));
    throw new ConversationsUnknown(String(response.status));
  }
  if (!Object.hasOwn(root, 'data')) invalid();
  return root as { data: unknown; meta?: unknown };
}
function replayed(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object' || typeof (meta as { replayed?: unknown }).replayed !== 'boolean') invalid();
  return (meta as { replayed: boolean }).replayed;
}
function base(scope: ConversationsScope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) invalid();
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/conversations`;
}
function id(value: string): string { if (!UUID.test(value)) invalid(); return value.toLowerCase(); }

/** List filters go out as plain query strings; the keyset cursor is the previous page's nextCursor, unchanged. */
export async function loadConversations(scope: ConversationsScope, filters: ConversationListQuery = {}): Promise<ConversationList> {
  const query = validateConversationListQuery(filters);
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.assigned) params.set('assigned', query.assigned);
  if (query.unreadOnly !== undefined) params.set('unreadOnly', String(query.unreadOnly));
  if (query.tag) params.set('tag', query.tag);
  if (query.search) params.set('search', query.search);
  if (query.before) { params.set('beforeAt', query.before.at); params.set('beforeId', query.before.id); }
  const text = params.toString();
  return verifyConversationList((await call(base(scope) + (text ? `?${text}` : ''), 'GET')).data);
}
export async function loadConversation(scope: ConversationsScope, conversationId: string, before?: string): Promise<ConversationDetail> {
  const cid = id(conversationId);
  const suffix = before ? `?before=${id(before)}` : '';
  return verifyConversationDetail((await call(`${base(scope)}/${cid}${suffix}`, 'GET')).data, cid);
}
/** throughMessageId is the newest message on screen: the read mark never moves past what the staff member saw. */
export async function markConversationRead(scope: ConversationsScope, conversationId: string, throughMessageId: string): Promise<ConversationReadMark> {
  const input = validateMarkConversationReadInput({ conversationId: id(conversationId), throughMessageId: id(throughMessageId) });
  return verifyConversationReadMark((await call(`${base(scope)}/${input.conversationId}/read`, 'POST', CONVERSATION_MARK_READ_COMMAND,
    { throughMessageId: input.throughMessageId })).data, input.conversationId);
}
export async function replyConversation(scope: ConversationsScope, conversationId: string, expectedVersion: number, text: string, key: string):
  Promise<{ receipt: ConversationReplyReceipt; replayed: boolean }> {
  const input = validateReplyConversationInput({ conversationId: id(conversationId), expectedVersion, body: text });
  const out = await call(`${base(scope)}/${input.conversationId}/replies`, 'POST', CONVERSATION_REPLY_COMMAND, { expectedVersion: input.expectedVersion, body: input.body }, key);
  return { receipt: verifyConversationReplyReceipt(out.data, { conversationId: input.conversationId, body: input.body }), replayed: replayed(out.meta) };
}
export async function updateConversation(scope: ConversationsScope, conversationId: string, expectedVersion: number,
  change: { status?: ConversationStatus; tags?: string[]; assignedPrincipalId?: string | null }, key: string): Promise<{ receipt: ConversationUpdateReceipt; replayed: boolean }> {
  const input = validateUpdateConversationInput({ conversationId: id(conversationId), expectedVersion, ...change });
  const { conversationId: cid, ...body } = input;
  const out = await call(`${base(scope)}/${cid}/update`, 'POST', CONVERSATION_UPDATE_COMMAND, body, key);
  return { receipt: verifyConversationUpdateReceipt(out.data, cid), replayed: replayed(out.meta) };
}

/** Keep the idempotency key only while the same command is retried; any change starts a new command. */
export function commandAttempt(fingerprint: string, previous: { fingerprint: string; key: string } | null, newKey: () => string): { fingerprint: string; key: string } {
  return previous && previous.fingerprint === fingerprint ? previous : { fingerprint, key: newKey() };
}
