import { validateLeadIntakeMonitorForm, validatePublicFormConfig, validatePublicFormSubmission, validatePublishedLeadForm, validateStaffLeadForm, type LeadIntakeMonitorForm, type StaffLeadForm, type PublishedLeadForm, type PublicFormResult } from '@hon/contracts';

const staffBase = '/api/v1/marketing/forms';
const monitorPath = `${staffBase}/intake-monitor`;
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const staffPath = new RegExp(`^${staffBase}(?:/${uuid}/(?:configuration|publish|disable))?$`);
const validKey = (key: unknown): key is string => typeof key === 'string' && key.trim() === key && /^[A-Za-z0-9_-]{16,100}$/.test(key);
export class FormUiError extends Error {
  constructor(message: string, readonly denied = false) { super(message); }
}
function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every(k => keys.includes(k));
}
/** Read through a byte budget, not response.json() on an unbounded server body. */
async function requestJson(path: string, options: RequestInit, cap: number): Promise<{ status: number; body: unknown }> {
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 10000);
  const cancel = () => abort.abort();
  if (options.signal?.aborted) abort.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const response = await fetch(path, { ...options, signal: abort.signal, cache: 'no-store', redirect: 'error' });
    const origin = typeof window !== 'undefined' ? window.location.origin : 'http://hon.invalid';
    if (response.redirected || (response.url && (new URL(response.url).origin !== origin || new URL(response.url).pathname !== path || new URL(response.url).search || new URL(response.url).hash))) { await response.body?.cancel(); throw new FormUiError('No verified form response.'); }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new FormUiError('Exact current human school permission is required.', true);
    }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '') || Number(response.headers.get('content-length') ?? 0) > cap) { await response.body?.cancel(); throw new FormUiError('No verified form response.'); }
    if (!response.body) throw new FormUiError('No verified form response.');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    const stopReading = () => { void reader.cancel(); };
    abort.signal.addEventListener('abort', stopReading, { once: true });
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > cap) throw new FormUiError('No verified form response.');
        chunks.push(next.value);
      }
      if (abort.signal.aborted) throw new FormUiError('No success confirmed. Retry unchanged with the retained key.');
    } finally { abort.signal.removeEventListener('abort', stopReading); await reader.cancel(); reader.releaseLock(); }
    const data = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return { status: response.status, body: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) as unknown };
  } catch (error) {
    if (error instanceof FormUiError) throw error;
    throw new FormUiError('No success confirmed. Retry unchanged with the retained key.');
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); }
}
export interface FormMutation { form: StaffLeadForm; replayed: boolean }
export function formStaffRequest(path: string): Promise<StaffLeadForm[]>;
export function formStaffRequest(path: string, input: object, key: string): Promise<FormMutation>;
export async function formStaffRequest(path: string, input?: object, key?: string): Promise<StaffLeadForm[] | FormMutation> {
  // No absolute URLs, percent encoding, query/hash, dot segments, extra endpoints or GET commands.
  if (!staffPath.test(path) || new URL(path, 'http://hon.invalid').pathname !== path || (!input && path !== staffBase)) throw new FormUiError('Only the fixed same-origin form API is allowed.');
  if (input) {
    if (!validKey(key)) throw new FormUiError('A bounded retry key is required.');
    if (path === staffBase || path.endsWith('/configuration')) validatePublicFormConfig(input);
    else if (!exactObject(input, ['expectedVersion']) || !Number.isInteger(input.expectedVersion) || (input.expectedVersion as number) < 1 || (input.expectedVersion as number) > 999999998) throw new FormUiError('Invalid form command.');
    if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 4096) throw new FormUiError('Invalid form command.');
  }
  const result = await requestJson(path, { method: input ? 'POST' : 'GET', credentials: 'same-origin', headers: input ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': 'public-lead-form', 'Idempotency-Key': key! } : {}, ...(input ? { body: JSON.stringify(input) } : {}) }, 262144);
  if (result.status !== 200) throw new FormUiError(result.status === 409 ? 'Version or retry conflict. Reload the current state.' : 'No success confirmed. Check configuration; retry unchanged with the retained key.');
  try {
    if (!input) {
      if (!exactObject(result.body, ['data']) || !Array.isArray(result.body.data) || result.body.data.length > 100) throw new Error('INVALID');
      result.body.data.forEach(validateStaffLeadForm);
      if (new Set(result.body.data.map(f => f.id)).size !== result.body.data.length) throw new Error('INVALID');
      return result.body.data;
    }
    if (!exactObject(result.body, ['data','meta']) || !exactObject(result.body.meta, ['replayed']) || typeof result.body.meta.replayed !== 'boolean') throw new Error('INVALID');
    validateStaffLeadForm(result.body.data);
    if (path !== staffBase && !path.startsWith(`${staffBase}/${result.body.data.id}/`)) throw new Error('INVALID');
    return { form: result.body.data, replayed: result.body.meta.replayed };
  } catch { throw new FormUiError('No verified form state. Reload current authority.'); }
}

/** Browser-safe monitor read. Never call the full form-configuration list here. */
export async function loadLeadIntakeMonitor(): Promise<LeadIntakeMonitorForm[]> {
  const result = await requestJson(monitorPath, { method: 'GET', credentials: 'same-origin' }, 65536);
  if (result.status !== 200) throw new FormUiError('No verified intake-monitor response.');
  try {
    if (!exactObject(result.body, ['data']) || !Array.isArray(result.body.data) || result.body.data.length > 100) throw new Error('INVALID');
    result.body.data.forEach(validateLeadIntakeMonitorForm);
    return result.body.data;
  } catch { throw new FormUiError('No verified intake-monitor response.'); }
}
export async function loadPublicLeadForm(publicId: string, signal?: AbortSignal): Promise<PublishedLeadForm> {
  if (publicId.length !== 48 || !/^[a-f0-9]{48}$/.test(publicId)) throw new FormUiError('This form is unavailable.');
  const result = await requestJson(`/api/v1/public/forms/${publicId}`, { credentials: 'omit', ...(signal ? { signal } : {}) }, 8192);
  if (signal?.aborted || result.status !== 200 || !exactObject(result.body, ['data'])) throw new FormUiError('This form is unavailable.');
  validatePublishedLeadForm(result.body.data);
  if (result.body.data.publicId !== publicId) throw new FormUiError('This form is unavailable.');
  return result.body.data;
}
export async function sendPublicLeadForm(publicId: string, input: object, key: string): Promise<PublicFormResult> {
  if (publicId.length !== 48 || !/^[a-f0-9]{48}$/.test(publicId) || !validKey(key)) return 'invalid';
  try { validatePublicFormSubmission(input); if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 8192) return 'invalid'; }
  catch { return 'invalid'; }
  try {
    const { status, body } = await requestJson(`/api/v1/public/forms/${publicId}/submissions`, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(input) }, 256);
    if (!exactObject(body, ['result'])) return 'unavailable';
    if (status === 202 && body.result === 'accepted') return 'accepted';
    if (status === 400 && body.result === 'invalid') return 'invalid';
    if (status === 429 && body.result === 'rate-limited') return 'rate-limited';
  } catch { /* Never display server text; uncertain retries retain the same key and body. */ }
  return 'unavailable';
}
