import { SCHOOL_DEMO_DATA_LOAD_COMMAND, SCHOOL_DEMO_DATA_REMOVE_COMMAND, validateRemoveSchoolDemoDataInput, verifySchoolDemoDataInUseTables,
  verifySchoolDemoDataView, type RemoveSchoolDemoDataInput, type SchoolDemoDataView } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * Settings > Demo data (0439). The read sends no Idempotency-Key; load and remove each send their own X-HON-Human-Command
 * and an Idempotency-Key. The server decides the permission, the version and what removal may delete.
 */
export type DemoErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed for this staff member at this school, or the school has no paid or trial access. Nothing changed. */ | 'DENIED'
  /** Demo data is already loaded (load), or it changed or is gone since it was read (remove). Nothing changed. */ | 'CHANGED'
  /** Real records point at demo records, so nothing was removed. `tables` says which. */ | 'IN_USE'
  /** The request was not accepted as sent. Nothing changed. */ | 'INVALID'
  /** Too many requests. Nothing changed. */ | 'RATE'
  /** Busy, or the outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class DemoError extends Error {
  constructor(readonly kind: DemoErrorKind, readonly code: string | null = null, readonly tables: readonly string[] = []) { super(kind); }
}
export type Owned = () => boolean;
export type DemoScope = Readonly<{ organizationId: string; schoolId: string }>;
/** Sent on window after a load or remove answer, so the staff banner reads the status again. */
export const HON_DEMO_DATA_CHANGED_EVENT = 'hon:demo-data-changed';

const RESPONSE_MAX = 100_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const codeOf = (v: unknown): string | null => typeof record(v)?.code === 'string' ? record(v)!.code as string : null;
function data(value: unknown): unknown {
  const row = record(value);
  if (!row || !Object.hasOwn(row, 'data') || !record(row.meta)) throw new Error('shape');
  return row.data;
}
function id(value: string): string { if (!UUID.test(value)) throw new DemoError('INVALID'); return value.toLowerCase(); }
function base(scope: DemoScope): string { return `/api/v1/organizations/${id(scope.organizationId)}/schools/${id(scope.schoolId)}/settings/demo-data`; }

async function exchange(url: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ name: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(url, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.name, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  // A retired request (aborted, or no longer the one shown) never ends a newer session.
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new DemoError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new DemoError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}

/** What a refused answer means. Only these exact answers are definitive; anything else (busy, 5xx, drift) is UNKNOWN. */
export function demoErrorFor(status: number, value: unknown): DemoError {
  const code = codeOf(value);
  if (status === 403) return new DemoError('DENIED', code);
  if (status === 400) return new DemoError('INVALID', code);
  if (status === 429) return new DemoError('RATE', code);
  if (status === 404 && code === 'DEMO_DATA_NOT_LOADED') return new DemoError('CHANGED', code);
  if (status === 409 && (code === 'VERSION_CONFLICT' || code === 'DEMO_DATA_ALREADY_LOADED')) return new DemoError('CHANGED', code);
  if (status === 409 && code === 'IDEMPOTENCY_KEY_REUSED') return new DemoError('INVALID', code);
  if (status === 409 && code === 'DEMO_DATA_IN_USE') {
    let tables: string[] = [];
    try { tables = verifySchoolDemoDataInUseTables(record(value)?.tables); } catch { tables = []; }
    return new DemoError('IN_USE', code, tables);
  }
  // A lock wait, IDEMPOTENCY_IN_PROGRESS, 5xx: the same request may be sent again.
  return new DemoError('UNKNOWN', code);
}

async function send(url: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ name: string; body: string; key: string }>): Promise<unknown> {
  let answer: { status: number; value: unknown };
  try { answer = await exchange(url, signal, owned, command); }
  catch (error) { if (error instanceof DemoError || (!command && signal.aborted)) throw error; throw new DemoError('UNKNOWN'); }
  if (answer.status !== 200) throw demoErrorFor(answer.status, answer.value);
  try { return data(answer.value); } catch { throw new DemoError('UNKNOWN'); }
}

export const demoDataApi = {
  /** Whether demo data is loaded at this school, with its counts. */
  async read(scope: DemoScope, signal: AbortSignal, owned: Owned): Promise<SchoolDemoDataView> {
    const value = await send(base(scope), signal, owned);
    try { return verifySchoolDemoDataView(value); } catch { throw new DemoError('UNKNOWN'); }
  },
  /** Load the demo school. The receipt must say LOADED. */
  async load(scope: DemoScope, key: string, signal: AbortSignal, owned: Owned): Promise<SchoolDemoDataView> {
    if (typeof key !== 'string' || !UUID.test(key)) throw new DemoError('INVALID');
    const value = await send(`${base(scope)}/load`, signal, owned, { name: SCHOOL_DEMO_DATA_LOAD_COMMAND, body: '{}', key });
    try { return verifySchoolDemoDataView(value, 'LOADED'); } catch { throw new DemoError('UNKNOWN'); }
  },
  /** Remove exactly the set that was read. The receipt must say NONE. */
  async remove(scope: DemoScope, input: RemoveSchoolDemoDataInput, key: string, signal: AbortSignal, owned: Owned): Promise<SchoolDemoDataView> {
    if (typeof key !== 'string' || !UUID.test(key)) throw new DemoError('INVALID');
    let body: RemoveSchoolDemoDataInput;
    try { body = validateRemoveSchoolDemoDataInput(input); } catch { throw new DemoError('INVALID'); }
    const value = await send(`${base(scope)}/remove`, signal, owned, { name: SCHOOL_DEMO_DATA_REMOVE_COMMAND, body: JSON.stringify(body), key });
    try { return verifySchoolDemoDataView(value, 'NONE'); } catch { throw new DemoError('UNKNOWN'); }
  },
};
export type DemoDataApi = typeof demoDataApi;

/** Whether a failed command may be sent again with the same key: only when its outcome is not known, or nothing was sent (rate limit). */
export const keepForRetry = (error: unknown) => !(error instanceof DemoError) || error.kind === 'UNKNOWN' || error.kind === 'RATE';
