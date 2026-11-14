/**
 * Bounded JSON request for the creative provider adapters (C2). One request, no retries, no redirects, no cookies, a
 * hard timeout and a body size cap. It never logs or returns request headers, credentials or raw provider bodies: the
 * caller gets only the status code and the parsed JSON (or undefined when the body is not JSON).
 */
export type CreativeFetch = (input: string, init: RequestInit) => Promise<Response>;
export interface CreativeHttpAnswer { status: number; body: unknown }

/** Thrown when no status was received (network error, timeout) or the body broke a limit. The request MAY have arrived. */
export class CreativeTransportError extends Error {
  constructor(readonly kind: 'NETWORK' | 'TIMEOUT' | 'BODY') { super(`creative provider transport ${kind}`); }
}

export async function creativeRequestJson(send: CreativeFetch, url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: unknown },
  limits: { timeoutMs: number; maxBytes: number }): Promise<CreativeHttpAnswer> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), limits.timeoutMs);
  let response: Response;
  try {
    response = await send(url, { method: init.method, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: abort.signal,
      headers: { Accept: 'application/json', ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
  } catch {
    clearTimeout(timer);
    throw new CreativeTransportError(abort.signal.aborted ? 'TIMEOUT' : 'NETWORK');
  }
  try {
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel().catch(() => undefined);
      return { status: response.status, body: undefined };
    }
    const reader = response.body?.getReader();
    if (!reader) return { status: response.status, body: undefined };
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        length += value.byteLength;
        if (length > limits.maxBytes) { await reader.cancel().catch(() => undefined); throw new CreativeTransportError('BODY'); }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof CreativeTransportError) throw error;
      throw new CreativeTransportError(abort.signal.aborted ? 'TIMEOUT' : 'BODY');
    } finally { reader.releaseLock(); }
    try { return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }; }
    catch { return { status: response.status, body: undefined }; }
  } finally { clearTimeout(timer); }
}

export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A provider download URL is accepted only as https on an allowed host (exact host or a subdomain of it), with no
 * credentials and no port. It is handed to the storage step (C3) in memory only and is never stored or shown.
 */
export function allowedDownloadUrl(value: unknown, hosts: readonly string[]): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  return hosts.some(h => host === h || host.endsWith(`.${h}`)) ? url.toString() : null;
}

/**
 * Submit status mapping shared by both adapters. A clear refusal before the provider took the job is FAILED (credits
 * returned); anything that might have been accepted is UNKNOWN (credits held for HQ, never resent).
 */
export const SUBMIT_REFUSED_STATUSES: readonly number[] = [400, 401, 402, 403, 404, 413, 415, 422, 429];
