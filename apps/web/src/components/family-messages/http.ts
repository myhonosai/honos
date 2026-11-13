import {
  validateReplyFamilyMessageInput, validateSendFamilyMessageInput, verifyFamilyMessageInbox, verifyFamilyMessageReadMark, verifyFamilyMessageReceipt,
  verifyFamilyMessageThread, verifyParentFamilyMessages,
  type FamilyMessageInbox, type FamilyMessageReadMark, type FamilyMessageReceipt, type FamilyMessageThread, type ParentFamilyMessages,
} from '@hon/contracts';

/**
 * Family messages (0330): same-origin browser commands only. Parents send no school, family or child selector; staff send the
 * shell's school scope, which the server checks again with family_messages.manage. Nothing here texts, emails or pushes.
 */
export class FamilyMessagesAccessError extends Error { constructor(message: string, readonly status: number) { super(message); } }
/** A definite refusal: nothing was stored, so a retry is a new send. Other failures keep the key for an exact retry. */
export class FamilyMessagesRefusal extends Error {}
export type FamilyMessagesScope = Readonly<{ organizationId: string; schoolId: string }>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function invalid(): never { throw new Error('The answer could not be checked. Nothing is assumed. Refresh to see the current messages.'); }
const MESSAGES: Record<string, string> = {
  FAMILY_MESSAGES_RATE_LIMITED: 'Too many messages were sent in the last hour. Please try again later.',
  FAMILY_MESSAGES_NOT_FOUND: 'That conversation is not available.',
  VALIDATION_FAILED: 'Messages are plain text of 1 to 2,000 characters.',
  IDEMPOTENCY_KEY_REUSED: 'This send could not be matched to the earlier one. Refresh and write it again.',
};

async function call(url: string, method: 'GET' | 'POST', command?: string, body?: unknown, key?: string): Promise<{ data: unknown; meta?: unknown }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method === 'POST') { headers['Content-Type'] = 'application/json'; headers['X-HON-Human-Command'] = command!; if (key) headers['Idempotency-Key'] = key; }
  const response = await fetch(url, { method, credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', headers,
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
  const value: unknown = await response.json().catch(() => invalid());
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const root = value as Record<string, unknown>;
  if (!response.ok) {
    if (response.status === 401) throw new FamilyMessagesAccessError('Your session has ended. Sign in again.', 401);
    if (response.status === 403) throw new FamilyMessagesAccessError('Messages are not available on this account right now.', 403);
    if (MESSAGES[String(root.code)]) throw new FamilyMessagesRefusal(MESSAGES[String(root.code)]!);
    throw new Error('Messages are unavailable right now. If you were sending, it may or may not have gone through. Refresh to check.');
  }
  if (!Object.hasOwn(root, 'data')) invalid();
  return root as { data: unknown; meta?: unknown };
}
function replayed(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object' || typeof (meta as { replayed?: unknown }).replayed !== 'boolean') invalid();
  return (meta as { replayed: boolean }).replayed;
}

// Parent side.
export async function loadParentFamilyMessages(): Promise<ParentFamilyMessages> {
  return verifyParentFamilyMessages((await call('/api/v1/parent/messages/school', 'GET')).data);
}
export async function sendParentFamilyMessage(text: string, key: string): Promise<{ receipt: FamilyMessageReceipt; replayed: boolean }> {
  const input = validateSendFamilyMessageInput({ body: text });
  const out = await call('/api/v1/parent/messages/school', 'POST', 'parent.family_messages.send', input, key);
  return { receipt: verifyFamilyMessageReceipt(out.data, { from: 'FAMILY', body: input.body }), replayed: replayed(out.meta) };
}

// Staff side.
function base(scope: FamilyMessagesScope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) invalid();
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/family-messages`;
}
function thread(threadId: string): string { if (!UUID.test(threadId)) invalid(); return threadId.toLowerCase(); }
export async function loadFamilyMessageInbox(scope: FamilyMessagesScope): Promise<FamilyMessageInbox> {
  return verifyFamilyMessageInbox((await call(base(scope), 'GET')).data);
}
export async function loadFamilyMessageThread(scope: FamilyMessagesScope, threadId: string): Promise<FamilyMessageThread> {
  const id = thread(threadId);
  return verifyFamilyMessageThread((await call(`${base(scope)}/${id}`, 'GET')).data, id);
}
export async function markFamilyMessageThreadRead(scope: FamilyMessagesScope, threadId: string): Promise<FamilyMessageReadMark> {
  const id = thread(threadId);
  return verifyFamilyMessageReadMark((await call(`${base(scope)}/${id}/read`, 'POST', 'family_messages.mark_read', {})).data, id);
}
export async function replyFamilyMessage(scope: FamilyMessagesScope, threadId: string, text: string, key: string): Promise<{ receipt: FamilyMessageReceipt; replayed: boolean }> {
  const input = validateReplyFamilyMessageInput({ threadId: thread(threadId), body: text });
  const out = await call(`${base(scope)}/${input.threadId}/replies`, 'POST', 'family_messages.reply', { body: input.body }, key);
  return { receipt: verifyFamilyMessageReceipt(out.data, { from: 'SCHOOL', body: input.body, threadId: input.threadId }), replayed: replayed(out.meta) };
}

/** An unknown send outcome keeps its key so Try again repeats the same send; editing the text starts a new send. */
export function sendAttempt(text: string, previous: { text: string; key: string } | null, key: () => string) {
  return previous?.text === text ? previous : { text, key: key() };
}
