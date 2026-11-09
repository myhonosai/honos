import { COMMUNICATION_CONSENT_SOURCES, accountClosed, accountUuid, type CommunicationConsentStatus, type CommunicationConsentSummary } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';
import type { PeopleScope } from './http';

/**
 * A person's contact consent at the selected school (email and text messages). The read lists what was recorded; the
 * record command sends one staff-captured choice with the exact human-command marker and an idempotency key. The server
 * decides authority, tenancy and the version check. Recording a choice sends no message.
 */
export const CONSENT_CHANNELS = ['EMAIL', 'SMS'] as const;
export type ConsentChannel = typeof CONSENT_CHANNELS[number];
export const CONSENT_HUMAN_COMMAND = 'communication.consent.record';
export type ConsentErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed to read or record consent at this school. Nothing changed. */ | 'DENIED'
  /** The person is not at this school. */ | 'MISSING'
  /** The consent changed since it was read. Nothing changed. */ | 'CONFLICT'
  /** Not accepted as sent. Nothing changed. */ | 'INVALID'
  /** The same request is still being recorded; the same request may be sent again. */ | 'BUSY'
  /** The outcome is not known; only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class ConsentError extends Error { constructor(readonly kind: ConsentErrorKind, readonly code: string | null = null) { super(kind); } }
export type ConsentInput = Readonly<{ status: CommunicationConsentStatus; source: 'STAFF'; capturedAt: string; expectedVersion?: number }>;
export type Owned = () => boolean;

const RESPONSE_MAX = 65_536;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const path = (scope: PeopleScope, personId: string) =>
  `/api/v1/organizations/${accountUuid(scope.organizationId)}/schools/${accountUuid(scope.schoolId)}/people/${accountUuid(personId).toLowerCase()}/communication-consents`;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;

/** What a refused answer means. Only these exact answers are definitive; anything else is UNKNOWN. */
export function consentErrorFor(status: number, code: string | null): ConsentError {
  if (status === 403) return new ConsentError('DENIED', code);
  if (status === 404) return new ConsentError('MISSING', code);
  if (status === 400) return new ConsentError('INVALID', code);
  if (status === 409 && (code === 'VERSION_CONFLICT' || code === 'VERSION_REQUIRED' || code === 'VERSION_NOT_ALLOWED_ON_CREATE')) return new ConsentError('CONFLICT', code);
  if (status === 409 && code === 'IDEMPOTENCY_IN_PROGRESS') return new ConsentError('BUSY', code);
  if (status === 409 && code === 'IDEMPOTENCY_KEY_REUSED') return new ConsentError('INVALID', code);
  return new ConsentError('UNKNOWN', code);
}
/** Only an unknown outcome or a request still in progress keeps the exact request for Try again. */
export const keepConsentForRetry = (error: unknown) => !(error instanceof ConsentError) || error.kind === 'UNKNOWN' || error.kind === 'BUSY';

function summary(v: unknown): CommunicationConsentSummary {
  const o = accountClosed(v, ['channel', 'status', 'source', 'capturedAt', 'version', 'updatedAt']);
  if (!['SMS', 'EMAIL', 'PUSH'].includes(o.channel as string) || (o.status !== 'OPTED_IN' && o.status !== 'OPTED_OUT')
    || !(COMMUNICATION_CONSENT_SOURCES as readonly unknown[]).includes(o.source) || typeof o.capturedAt !== 'string' || !ISO.test(o.capturedAt)
    || typeof o.updatedAt !== 'string' || !ISO.test(o.updatedAt) || !Number.isSafeInteger(o.version) || (o.version as number) < 1) throw new Error('shape');
  return o as unknown as CommunicationConsentSummary;
}
function data(v: unknown): unknown {
  const o = accountClosed(v, ['data', 'meta']);
  if (!o.meta || typeof o.meta !== 'object' || Array.isArray(o.meta)) throw new Error('shape');
  return o.data;
}

async function exchange(url: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  let r: Response;
  try {
    r = await fetch(url, { method: command ? 'PUT' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
      headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': CONSENT_HUMAN_COMMAND, 'Idempotency-Key': command.key } : {}) },
      ...(command ? { body: command.body } : {}) });
  } catch (error) { if (signal.aborted && !command) throw error; throw new ConsentError('UNKNOWN'); }
  if (signal.aborted && !command) signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new ConsentError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  let text: string;
  try { text = await r.text(); } catch { throw new ConsentError('UNKNOWN'); }
  if (text.length > RESPONSE_MAX) throw new ConsentError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}

export const consentApi = {
  /** The recorded consent for this person, one entry per channel that has a record. */
  async list(scope: PeopleScope, personId: string, signal: AbortSignal, owned: Owned): Promise<readonly CommunicationConsentSummary[]> {
    const { status, value } = await exchange(path(scope, personId), signal, owned);
    if (status !== 200) throw consentErrorFor(status, codeOf(value));
    try {
      const rows = data(value);
      if (!Array.isArray(rows) || rows.length > 3) throw new Error('shape');
      const items = rows.map(summary);
      if (new Set(items.map((x) => x.channel)).size !== items.length) throw new Error('duplicate');
      return items;
    } catch { throw new ConsentError('UNKNOWN'); }
  },
  /** Record one staff-captured choice. The same key and body replay the saved answer; it is never recorded twice. */
  async record(scope: PeopleScope, personId: string, channel: ConsentChannel, input: ConsentInput, key: string, signal: AbortSignal, owned: Owned)
    : Promise<Readonly<{ consent: CommunicationConsentSummary; replayed: boolean }>> {
    let url: string, k: string;
    try {
      if (!(CONSENT_CHANNELS as readonly string[]).includes(channel) || (input.status !== 'OPTED_IN' && input.status !== 'OPTED_OUT') || input.source !== 'STAFF'
        || !ISO.test(input.capturedAt) || (input.expectedVersion !== undefined && (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1))) throw new Error('input');
      url = `${path(scope, personId)}/${channel}`; k = accountUuid(key);
    } catch { throw new ConsentError('INVALID'); }
    const body = { status: input.status, source: 'STAFF', capturedAt: input.capturedAt, ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}) };
    const { status, value } = await exchange(url, signal, owned, { body: JSON.stringify(body), key: k });
    if (status !== 200 && status !== 201) throw consentErrorFor(status, codeOf(value));
    try {
      const o = accountClosed(value, ['data', 'meta']), meta = o.meta as Record<string, unknown> | null;
      if (!meta || typeof meta !== 'object' || Array.isArray(meta) || typeof meta.replayed !== 'boolean') throw new Error('shape');
      const row = summary(o.data);
      if (row.channel !== channel || row.status !== input.status || row.source !== 'STAFF' || Date.parse(row.capturedAt) !== Date.parse(input.capturedAt)
        || row.version !== (input.expectedVersion === undefined ? 1 : input.expectedVersion + 1)) throw new Error('mismatch');
      return { consent: row, replayed: meta.replayed };
    } catch { throw new ConsentError('UNKNOWN'); }
  },
};
export type ConsentApi = typeof consentApi;
