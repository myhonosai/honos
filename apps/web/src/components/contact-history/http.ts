import {
  CONTACT_EMAIL_RESEND_COMMAND, validateContactEmailResendInput, validateContactHistoryQuery, verifyContactEmailResendReceipt, verifyContactEmailView,
  verifyContactHistory, type ContactEmailResendReceipt, type ContactEmailView, type ContactHistory, type ContactHistoryQuery,
} from '@hon/contracts';

/**
 * Contact message history (0424): same-origin browser calls only. The shell's school scope is sent and checked again by the
 * server (conversation.read to look; conversation.manage and communication.message.queue to resend); nothing here decides
 * permission. Reads are plain GETs with no command marker or Idempotency-Key; a resend sends its own marker and key.
 */
export class ContactHistoryAccessError extends Error { constructor(readonly reason: 'SESSION' | 'FORBIDDEN', readonly status: number) { super(reason); } }
/** A definite refusal (nothing queued). A retry is a new command. */
export class ContactHistoryRefusal extends Error { constructor(readonly code: string) { super(code); } }
/** The answer could not be checked or the outcome is unknown: a resend may or may not have been queued. */
export class ContactHistoryUnknown extends Error {}
export type ContactHistoryScope = Readonly<{ organizationId: string; schoolId: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Codes the server returns for a definite refusal. Anything else is treated as unknown. */
export const CONTACT_HISTORY_REFUSALS = [
  'VALIDATION_FAILED', 'CONTACT_NOT_FOUND', 'CONTACT_MESSAGE_NOT_FOUND', 'IDEMPOTENCY_KEY_REUSED', 'CONTACT_RESEND_NOT_SENT',
  'CONTACT_RESEND_EMAIL_MISSING', 'CONTACT_RESEND_CONSENT_REQUIRED', 'CONTACT_RESEND_LIMIT_REACHED',
] as const;
const REFUSAL = new Set<string>(CONTACT_HISTORY_REFUSALS);
function invalid(): never { throw new ContactHistoryUnknown('unverified'); }
/** An answer that fails its check is an unknown outcome, never a success. */
function checked<T>(fn: () => T): T { try { return fn(); } catch { invalid(); } }

async function call(url: string, method: 'GET' | 'POST', body?: unknown, key?: string): Promise<{ data: unknown; meta?: unknown }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method === 'POST') { headers['Content-Type'] = 'application/json'; headers['X-HON-Human-Command'] = CONTACT_EMAIL_RESEND_COMMAND; if (key) headers['Idempotency-Key'] = key; }
  let response: Response;
  try {
    response = await fetch(url, { method, credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', headers,
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
  } catch { throw new ContactHistoryUnknown('network'); }
  if (response.status === 401) throw new ContactHistoryAccessError('SESSION', 401);
  if (response.status === 403) throw new ContactHistoryAccessError('FORBIDDEN', 403);
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
  const value: unknown = await response.json().catch(() => invalid());
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const root = value as Record<string, unknown>;
  if (!response.ok) {
    if (REFUSAL.has(String(root.code))) throw new ContactHistoryRefusal(String(root.code));
    throw new ContactHistoryUnknown(String(response.status));
  }
  if (!Object.hasOwn(root, 'data')) invalid();
  return root as { data: unknown; meta?: unknown };
}
function id(value: string): string { if (!UUID.test(value)) invalid(); return value.toLowerCase(); }
function base(scope: ContactHistoryScope, personId: string): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) invalid();
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/people/${id(personId)}/messages`;
}

/** Filters go out as plain query strings; the keyset cursor is the previous page's nextCursor, unchanged. */
export async function loadContactHistory(scope: ContactHistoryScope, personId: string, filters: ContactHistoryQuery = {}): Promise<ContactHistory> {
  const query = checked(() => validateContactHistoryQuery(filters));
  const params = new URLSearchParams();
  if (query.range && query.range !== 'ALL') params.set('range', query.range);
  if (query.search) params.set('search', query.search);
  if (query.before) { params.set('beforeAt', query.before.at); params.set('beforeId', query.before.id); }
  const text = params.toString();
  const { data } = await call(base(scope, personId) + (text ? `?${text}` : ''), 'GET');
  return checked(() => verifyContactHistory(data, id(personId)));
}
/** The exact email: subject and plain-text body as stored, delivery evidence and resends. */
export async function loadContactEmail(scope: ContactHistoryScope, personId: string, messageId: string): Promise<ContactEmailView> {
  const expected = { personId: id(personId), messageId: id(messageId) };
  const { data } = await call(`${base(scope, personId)}/${expected.messageId}/email`, 'GET');
  return checked(() => verifyContactEmailView(data, expected));
}
/** Queues one copy to the person's current saved address. The same key is reused only to retry this same resend. */
export async function resendContactEmail(scope: ContactHistoryScope, personId: string, messageId: string, key: string): Promise<{ receipt: ContactEmailResendReceipt; replayed: boolean }> {
  const input = checked(() => validateContactEmailResendInput({ personId: id(personId), messageId: id(messageId) }));
  if (!UUID.test(key)) invalid();
  const out = await call(`${base(scope, input.personId)}/${input.messageId}/resend`, 'POST', {}, key);
  const meta = out.meta as { replayed?: unknown } | undefined;
  if (!meta || typeof meta.replayed !== 'boolean') invalid();
  return { receipt: checked(() => verifyContactEmailResendReceipt(out.data, input)), replayed: meta.replayed };
}
