/**
 * 0647 (P7): the send plan on a Chad draft and what happened when it was approved. The requester sets the plan before review;
 * approval by another staff member queues the message, and the school's usual delivery checks (consent, STOP, quiet hours) still
 * apply at send time. Fixed same-origin paths only.
 */
const base = '/api/v1/staff/leads/assistant';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO = /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type ChadSendChannel = 'SMS' | 'EMAIL' | 'NONE';
export type ChadSendPlan = { version: number; channel: ChadSendChannel; sendAt: string | null };
export type ChadSendOutcome = 'QUEUED' | 'NO_CONSENT' | 'NO_ADDRESS' | 'DAILY_CAP';
export type ChadSendRecord = { outcome: ChadSendOutcome; messageId: string | null; channel: 'SMS' | 'EMAIL'; scheduledAt: string; approvedBy: string;
  approvedAt: string; approvalMethod: 'BUTTON' | 'VOICE'; cancelled: boolean; delivery: string | null };
export type ChadSendView = { invocationId: string; plan: ChadSendPlan | null; send: ChadSendRecord | null };

export const CHAD_SEND_ERROR: Readonly<Record<string, string>> = {
  CHAD_SEND_PLAN_INVALID: 'Pick text or email (or no send), and now or a time up to 30 days ahead.',
  CHAD_SEND_PLAN_NO_CONSENT: 'This contact has not agreed to messages on that channel, so it cannot be sent there.',
  CHAD_SEND_PLAN_NO_ADDRESS: 'This contact has no phone number or email for that channel.',
  CHAD_SEND_PLAN_CLOSED: 'This draft was already reviewed, so its send plan can no longer change.',
  CHAD_SEND_NOT_CANCELLABLE: 'This message is already being sent, or was never queued.',
  FOLLOW_UP_DRAFT_UNAVAILABLE: 'This draft is not available to you.',
  IDEMPOTENCY_KEY_REUSED: 'That change was already saved differently. Refresh and try again.',
};
export class ChadSendError extends Error { constructor(message: string, readonly status: number, readonly code: string) { super(message); } }

const str = (v: unknown): v is string => typeof v === 'string';
export function verifyChadSendView(value: unknown, invocationId: string): ChadSendView {
  const bad = (): never => { throw new Error('Unverified send plan response.'); };
  const v = value as Record<string, unknown>;
  if (!v || typeof v !== 'object' || v.invocationId !== invocationId) bad();
  const p = v.plan as Record<string, unknown> | null, s = v.send as Record<string, unknown> | null;
  if (p !== null && (!p || typeof p !== 'object' || !Number.isSafeInteger(p.version) || !['SMS', 'EMAIL', 'NONE'].includes(p.channel as string)
    || !(p.sendAt === null || (str(p.sendAt) && ISO.test(p.sendAt))))) bad();
  if (s !== null && (!s || typeof s !== 'object' || !['QUEUED', 'NO_CONSENT', 'NO_ADDRESS', 'DAILY_CAP'].includes(s.outcome as string)
    || !['SMS', 'EMAIL'].includes(s.channel as string) || !str(s.scheduledAt) || !ISO.test(s.scheduledAt) || !str(s.approvedAt) || !ISO.test(s.approvedAt)
    || !str(s.approvedBy) || !UUID.test(s.approvedBy) || !['BUTTON', 'VOICE'].includes(s.approvalMethod as string) || typeof s.cancelled !== 'boolean'
    || !(s.messageId === null || (str(s.messageId) && UUID.test(s.messageId))) || !(s.delivery === null || str(s.delivery)))) bad();
  return { invocationId, plan: p as ChadSendPlan | null, send: s as ChadSendRecord | null };
}

async function call(path: string, body?: unknown, key?: string): Promise<unknown> {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', referrerPolicy: 'no-referrer', cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-HON-Human-Command': 'chad-follow-up-assistant', 'Idempotency-Key': key ?? globalThis.crypto.randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const payload = await response.json().catch(() => null) as { data?: unknown; code?: string; message?: { code?: string } } | null;
  if (!response.ok) {
    const code = (payload && (payload.code ?? payload.message?.code)) || '';
    throw new ChadSendError(CHAD_SEND_ERROR[code] ?? (response.status === 401 ? 'Sign in again.' : 'HON could not confirm this. Refresh to see what was saved.'), response.status, code);
  }
  if (!payload || !Object.hasOwn(payload, 'data')) throw new Error('Unverified send plan response.');
  return payload.data;
}
const path = (id: string, tail: string) => { if (!UUID.test(id)) throw new Error('A draft id is required.'); return `${base}/${id.toLowerCase()}/${tail}`; };

export type ChadSendApi = {
  read(id: string): Promise<ChadSendView>;
  setPlan(id: string, plan: { channel: ChadSendChannel; sendAt: string | null }, key: string): Promise<ChadSendView>;
  cancel(id: string): Promise<ChadSendView>;
};
export const chadSendApi: ChadSendApi = {
  read: async (id) => verifyChadSendView(await call(path(id, 'send')), id),
  setPlan: async (id, plan, key) => verifyChadSendView(await call(path(id, 'send-plan'), plan, key), id),
  cancel: async (id) => verifyChadSendView(await call(path(id, 'send/cancel'), {}), id),
};

/** A local date-time input value (YYYY-MM-DDTHH:MM) as the exact UTC millisecond string the server accepts. */
export function sendAtFromLocal(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const at = new Date(local); return Number.isNaN(at.getTime()) ? null : at.toISOString();
}
