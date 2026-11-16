/**
 * New text or email (Texts & email page, docs/architecture/SCHOOL_APP_TARGET_LAYOUT.md L4). Two existing human commands
 * (0047): create one DRAFT, then queue it with the version the server returned. The server checks the school permission and
 * the contact's current consent for the channel at queue time. Nothing here delivers; HON's delivery worker sends queued
 * messages only where delivery is turned on.
 */
export type ComposeScope = Readonly<{ organizationId: string; schoolId: string }>;
export type ComposeChannel = 'SMS' | 'EMAIL';
export type ComposeDraft = Readonly<{ messageId: string; version: number }>;
export const COMPOSE_MAX = 4000;

/** The server refused for a definite reason: nothing more happened, and a retry is a new message. */
export class ComposeRefusal extends Error {
  constructor(readonly reason: 'CONSENT' | 'ACCESS' | 'INVALID' | 'CONFLICT') { super(reason); }
}
/** The outcome is unknown: only the same step with the same key may be retried. */
export class ComposeUncertain extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const base = (scope: ComposeScope) =>
  `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/communications/messages`;

/** Local syntax only; the server owns permission, consent and the recipient. */
export function composeOk(personId: string, channel: string, content: string): boolean {
  return UUID.test(personId) && (channel === 'SMS' || channel === 'EMAIL') && content.trim().length > 0 && content.length <= COMPOSE_MAX && !CONTROL.test(content);
}

async function post(path: string, key: string, body: unknown): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(path, { method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  } catch { throw new ComposeUncertain('No answer came back.'); }
  let value: unknown = null;
  if (/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) value = await response.json().catch(() => null);
  const code = value && typeof value === 'object' && !Array.isArray(value) ? (value as { code?: unknown }).code : undefined;
  if (response.status === 401) throw new ComposeRefusal('ACCESS');
  if (response.status === 403) throw new ComposeRefusal(code === 'COMMUNICATION_CONSENT_REQUIRED' ? 'CONSENT' : 'ACCESS');
  if (response.status === 400 || response.status === 404) throw new ComposeRefusal('INVALID');
  if (response.status === 409 && (code === 'VERSION_CONFLICT' || code === 'MESSAGE_NOT_DRAFT')) throw new ComposeRefusal('CONFLICT');
  if (!response.ok || !value || typeof value !== 'object' || Array.isArray(value)) throw new ComposeUncertain('The answer could not be checked.');
  return value as Record<string, unknown>;
}
function message(value: Record<string, unknown>, expect: Readonly<{ lifecycle: 'DRAFT' | 'QUEUED'; personId?: string; channel?: ComposeChannel; messageId?: string }>): ComposeDraft {
  const data = value.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object' || typeof data.id !== 'string' || !UUID.test(data.id) || !Number.isSafeInteger(data.version) || (data.version as number) < 1
    || data.lifecycle !== expect.lifecycle || (expect.personId && String(data.recipientPersonId).toLowerCase() !== expect.personId.toLowerCase())
    || (expect.channel && data.channel !== expect.channel) || (expect.messageId && data.id.toLowerCase() !== expect.messageId.toLowerCase())) {
    throw new ComposeUncertain('The answer did not match this message.');
  }
  return Object.freeze({ messageId: data.id, version: data.version as number });
}

/** Step 1: one DRAFT for one contact and channel. */
export async function createDraft(scope: ComposeScope, personId: string, channel: ComposeChannel, content: string, key: string): Promise<ComposeDraft> {
  if (!composeOk(personId, channel, content)) throw new ComposeRefusal('INVALID');
  return message(await post(base(scope), key, { recipientPersonId: personId.toLowerCase(), channel, content }), { lifecycle: 'DRAFT', personId, channel });
}
/** Step 2: queue that exact DRAFT at the version the server returned. */
export async function queueDraft(scope: ComposeScope, draft: ComposeDraft, key: string): Promise<ComposeDraft> {
  if (!UUID.test(draft.messageId)) throw new ComposeRefusal('INVALID');
  return message(await post(`${base(scope)}/${draft.messageId.toLowerCase()}/queue`, key, { expectedVersion: draft.version }), { lifecycle: 'QUEUED', messageId: draft.messageId });
}
