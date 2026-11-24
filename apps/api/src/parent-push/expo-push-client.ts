import { Injectable } from '@nestjs/common';

/** One message for one phone. Title is the school's name, body the announcement title (0601 P5). */
export interface ExpoPushMessage { to: string; title: string; body: string; data: { type: 'school_announcement'; announcementId: string } }
/** How one send ended, in the 0601 record shape. */
export type ExpoSendOutcome =
  | { outcome: 'SENT'; ticketId: string }
  | { outcome: 'FAILED' | 'UNKNOWN' | 'RETRYABLE'; failureCode: string };
export type ExpoReceiptOutcome = { outcome: 'DELIVERED' } | { outcome: 'PENDING' } | { outcome: 'FAILED'; failureCode: string };

export interface ExpoPushTransport {
  /** READY only when the owner approved real sends (HON_PARENT_PUSH_APPROVED=true). */
  readiness(): 'READY' | 'NOT_APPROVED';
  send(messages: ExpoPushMessage[]): Promise<ExpoSendOutcome[]>;
  receipts(ticketIds: string[]): Promise<Map<string, ExpoReceiptOutcome>>;
}
export const EXPO_PUSH_TRANSPORT = Symbol('EXPO_PUSH_TRANSPORT');

export const EXPO_SEND_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
export const EXPO_SEND_BATCH = 100;
export const EXPO_RECEIPT_BATCH = 300;
const TICKET = /^[A-Za-z0-9-]{1,100}$/;
const CODE = /^[A-Za-z_]{1,64}$/;
const TIMEOUT_MS = 10_000;

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

function code(value: unknown, fallback: string): string { return typeof value === 'string' && CODE.test(value) ? value : fallback; }
function errorCode(row: Record<string, unknown>): string {
  const details = row.details && typeof row.details === 'object' ? row.details as Record<string, unknown> : {};
  return code(details.error, 'PROVIDER_ERROR');
}

/**
 * Expo's push service (it forwards to Apple and Google). No account is needed to send to the HON Family app's tokens; an
 * optional EXPO_ACCESS_TOKEN is sent when the project turns on Expo's enhanced push security. Nothing is sent unless
 * HON_PARENT_PUSH_APPROVED is exactly "true". A request with no answer is UNKNOWN; only Expo's rate limit is retryable.
 */
@Injectable()
export class ExpoPushClient implements ExpoPushTransport {
  /** Replaced only by tests; never configurable at runtime. */
  fetcher: Fetch = (url, init) => globalThis.fetch(url, init);

  readiness(): 'READY' | 'NOT_APPROVED' { return process.env.HON_PARENT_PUSH_APPROVED === 'true' ? 'READY' : 'NOT_APPROVED'; }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
    const token = process.env.EXPO_ACCESS_TOKEN;
    if (token && /^[\x21-\x7e]{1,200}$/.test(token)) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  async send(messages: ExpoPushMessage[]): Promise<ExpoSendOutcome[]> {
    if (this.readiness() !== 'READY') throw new Error('PARENT_PUSH_NOT_APPROVED');
    if (messages.length < 1 || messages.length > EXPO_SEND_BATCH) throw new Error('PARENT_PUSH_BATCH_INVALID');
    const all = (outcome: ExpoSendOutcome): ExpoSendOutcome[] => messages.map(() => outcome);
    let response;
    try {
      response = await this.fetcher(EXPO_SEND_URL, { method: 'POST', headers: this.headers(), signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify(messages.map(m => ({ to: m.to, title: m.title, body: m.body, data: m.data, sound: 'default', priority: 'high' }))) });
    } catch { return all({ outcome: 'UNKNOWN', failureCode: 'NO_ANSWER' }); }
    // Expo refused the whole request before taking it: a rate limit may be retried; a rejected request is final.
    if (response.status === 429) return all({ outcome: 'RETRYABLE', failureCode: 'RATE_LIMITED' });
    if (response.status >= 400 && response.status < 500) return all({ outcome: 'FAILED', failureCode: 'REQUEST_REJECTED' });
    if (response.status !== 200) return all({ outcome: 'UNKNOWN', failureCode: 'PROVIDER_ERROR' });
    let body: unknown;
    try { body = await response.json(); } catch { return all({ outcome: 'UNKNOWN', failureCode: 'UNVERIFIED_ANSWER' }); }
    const data = body && typeof body === 'object' ? (body as { data?: unknown }).data : undefined;
    if (!Array.isArray(data) || data.length !== messages.length) return all({ outcome: 'UNKNOWN', failureCode: 'UNVERIFIED_ANSWER' });
    return data.map((ticket): ExpoSendOutcome => {
      const row = ticket && typeof ticket === 'object' ? ticket as Record<string, unknown> : {};
      if (row.status === 'ok' && typeof row.id === 'string' && TICKET.test(row.id)) return { outcome: 'SENT', ticketId: row.id };
      if (row.status === 'error') {
        const failure = errorCode(row);
        return failure === 'MessageRateExceeded' ? { outcome: 'RETRYABLE', failureCode: failure } : { outcome: 'FAILED', failureCode: failure };
      }
      return { outcome: 'UNKNOWN', failureCode: 'UNVERIFIED_ANSWER' };
    });
  }

  async receipts(ticketIds: string[]): Promise<Map<string, ExpoReceiptOutcome>> {
    if (this.readiness() !== 'READY') throw new Error('PARENT_PUSH_NOT_APPROVED');
    if (ticketIds.length < 1 || ticketIds.length > EXPO_RECEIPT_BATCH || ticketIds.some(id => !TICKET.test(id))) throw new Error('PARENT_PUSH_BATCH_INVALID');
    const found = new Map<string, ExpoReceiptOutcome>();
    let body: unknown;
    try {
      const response = await this.fetcher(EXPO_RECEIPTS_URL, { method: 'POST', headers: this.headers(), signal: AbortSignal.timeout(TIMEOUT_MS), body: JSON.stringify({ ids: ticketIds }) });
      if (response.status !== 200) return found;
      body = await response.json();
    } catch { return found; }
    const data = body && typeof body === 'object' ? (body as { data?: unknown }).data : undefined;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return found;
    for (const id of ticketIds) {
      const row = (data as Record<string, unknown>)[id];
      if (!row || typeof row !== 'object') continue;
      const receipt = row as Record<string, unknown>;
      if (receipt.status === 'ok') found.set(id, { outcome: 'DELIVERED' });
      else if (receipt.status === 'error') found.set(id, { outcome: 'FAILED', failureCode: errorCode(receipt) });
    }
    return found;
  }
}
