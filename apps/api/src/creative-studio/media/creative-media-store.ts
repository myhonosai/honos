import { createHash } from 'node:crypto';
import type { SaasCreativeMediaKind } from '@hon/contracts';
import type { CreativeDownload, CreativeResultAsset } from '../creative-provider-runtime.js';
import { allowedDownloadUrl, type CreativeFetch } from '../providers/creative-provider-http.js';
import { CreativeMediaRejected, inspectCreativeMedia } from './creative-media-inspect.js';

export const CREATIVE_MEDIA_STORE = Symbol('CREATIVE_MEDIA_STORE');
export const CREATIVE_MEDIA_INGEST = Symbol('CREATIVE_MEDIA_INGEST');
export const CREATIVE_MEDIA_LIMITS = { imageBytes: 26_214_400, videoBytes: 209_715_200, signedReadSeconds: 300, redirects: 3 } as const;

/** HON's private media bucket. Keys come from the database (creative/<jobId>/<ordinal>); reads are short-lived signed URLs. */
export interface CreativeMediaStore {
  readiness(): 'READY' | 'CONFIGURATION_REQUIRED';
  put(key: string, bytes: Buffer, mediaType: string): Promise<void>;
  signedReadUrl(key: string, seconds: number): Promise<string>;
  remove(key: string): Promise<void>;
}
export class CreativeMediaStoreError extends Error { constructor(readonly operation: 'PUT' | 'SIGN' | 'REMOVE') { super(`creative media store ${operation} failed`); } }

const KEY = /^creative\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[1-8]$/;
export const isCreativeStorageKey = (k: unknown): k is string => typeof k === 'string' && KEY.test(k);

/** No storage configured: nothing can be stored, read or removed. */
export class UnconfiguredCreativeMediaStore implements CreativeMediaStore {
  readiness() { return 'CONFIGURATION_REQUIRED' as const; }
  async put(): Promise<void> { throw new CreativeMediaStoreError('PUT'); }
  async signedReadUrl(): Promise<string> { throw new CreativeMediaStoreError('SIGN'); }
  async remove(): Promise<void> { throw new CreativeMediaStoreError('REMOVE'); }
}

/**
 * Supabase Storage (one private bucket). READY only with HON_CREATIVE_MEDIA_STORAGE_APPROVED exactly "true", an https
 * project URL in HON_CREATIVE_MEDIA_STORAGE_URL and a service key in HON_CREATIVE_MEDIA_STORAGE_KEY (pasted by the owner,
 * server side only). Bucket HON_CREATIVE_MEDIA_BUCKET (default creative-media) must be private.
 */
export class SupabaseCreativeMediaStore implements CreativeMediaStore {
  private readonly send: CreativeFetch;
  constructor(private readonly environment: () => NodeJS.ProcessEnv = () => process.env, options: { send?: CreativeFetch } = {}) {
    this.send = options.send ?? ((url, init) => fetch(url, init));
  }
  private config(): { base: string; key: string; bucket: string } | null {
    const env = this.environment();
    if (env.HON_CREATIVE_MEDIA_STORAGE_APPROVED !== 'true') return null;
    const key = env.HON_CREATIVE_MEDIA_STORAGE_KEY, bucket = env.HON_CREATIVE_MEDIA_BUCKET ?? 'creative-media';
    let url: URL;
    try { url = new URL(env.HON_CREATIVE_MEDIA_STORAGE_URL ?? ''); } catch { return null; }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    if (!key || !/^[A-Za-z0-9._-]{20,4096}$/.test(key) || !/^[a-z0-9][a-z0-9-]{2,62}$/.test(bucket)) return null;
    return { base: url.origin, key, bucket };
  }
  readiness() { return this.config() ? 'READY' as const : 'CONFIGURATION_REQUIRED' as const; }
  private async call(operation: 'PUT' | 'SIGN' | 'REMOVE', path: string, init: { method: string; headers?: Record<string, string>; body?: string | Uint8Array }): Promise<Response> {
    const c = this.config();
    if (!c) throw new CreativeMediaStoreError(operation);
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), operation === 'PUT' ? 120_000 : 15_000);
    try {
      const response = await this.send(`${c.base}/storage/v1${path.replace('{bucket}', c.bucket)}`, { method: init.method, redirect: 'error', credentials: 'omit',
        referrerPolicy: 'no-referrer', signal: abort.signal, headers: { Authorization: `Bearer ${c.key}`, apikey: c.key, ...init.headers }, ...(init.body ? { body: init.body } : {}) });
      if (response.status < 200 || response.status > 299) { await response.body?.cancel().catch(() => undefined); throw new CreativeMediaStoreError(operation); }
      return response;
    } catch (error) {
      if (error instanceof CreativeMediaStoreError) throw error;
      throw new CreativeMediaStoreError(operation); // never the key, URL or response body
    } finally { clearTimeout(timer); }
  }
  async put(key: string, bytes: Buffer, mediaType: string): Promise<void> {
    if (!isCreativeStorageKey(key)) throw new CreativeMediaStoreError('PUT');
    // Upsert: the key is fixed per job and ordinal, so a retried store after a lost lease overwrites the same object.
    const r = await this.call('PUT', `/object/{bucket}/${key}`, { method: 'POST', body: new Uint8Array(bytes),
      headers: { 'Content-Type': mediaType, 'x-upsert': 'true', 'Cache-Control': 'private, max-age=0' } });
    await r.body?.cancel().catch(() => undefined);
  }
  async signedReadUrl(key: string, seconds: number): Promise<string> {
    if (!isCreativeStorageKey(key) || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > CREATIVE_MEDIA_LIMITS.signedReadSeconds) throw new CreativeMediaStoreError('SIGN');
    const r = await this.call('SIGN', `/object/sign/{bucket}/${key}`, { method: 'POST', body: JSON.stringify({ expiresIn: seconds }), headers: { 'Content-Type': 'application/json' } });
    let body: unknown;
    try { body = JSON.parse(Buffer.from(await r.arrayBuffer()).subarray(0, 8192).toString('utf8')); } catch { throw new CreativeMediaStoreError('SIGN'); }
    const signed = body && typeof body === 'object' ? (body as Record<string, unknown>).signedURL : undefined;
    const base = this.config()?.base;
    if (typeof signed !== 'string' || !base || !signed.startsWith(`/object/sign/`)) throw new CreativeMediaStoreError('SIGN');
    return `${base}/storage/v1${signed}`;
  }
  async remove(key: string): Promise<void> {
    if (!isCreativeStorageKey(key)) throw new CreativeMediaStoreError('REMOVE');
    const r = await this.call('REMOVE', '/object/{bucket}', { method: 'DELETE', body: JSON.stringify({ prefixes: [key] }), headers: { 'Content-Type': 'application/json' } });
    await r.body?.cancel().catch(() => undefined);
  }
}

/** A download that may work later (network, timeout, 5xx): the job stays open for the next poll. */
export class CreativeDownloadRetry extends Error { constructor() { super('creative download not finished'); } }

/**
 * One provider file, followed through at most 3 redirects with the host rule re-checked on every hop, streamed with a
 * hard size cap and a timeout. Never sends HON credentials or cookies to the provider's file host.
 */
export async function downloadCreativeFile(send: CreativeFetch, download: CreativeDownload, maxBytes: number, timeoutMs = 120_000): Promise<Buffer> {
  let url = allowedDownloadUrl(download.url, download.allowedHosts);
  if (!url) throw new CreativeMediaRejected('download host not allowed');
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    for (let hop = 0; hop <= CREATIVE_MEDIA_LIMITS.redirects; hop += 1) {
      let response: Response;
      try { response = await send(url, { method: 'GET', redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', signal: abort.signal }); }
      catch { throw new CreativeDownloadRetry(); }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        const next = response.headers.get('location');
        const resolved = next ? (() => { try { return new URL(next, url!).toString(); } catch { return null; } })() : null;
        url = allowedDownloadUrl(resolved, download.allowedHosts);
        if (!url) throw new CreativeMediaRejected('redirect host not allowed');
        continue;
      }
      if (response.status >= 500 || response.status === 429 || response.status === 408) { await response.body?.cancel().catch(() => undefined); throw new CreativeDownloadRetry(); }
      if (response.status !== 200) { await response.body?.cancel().catch(() => undefined); throw new CreativeMediaRejected(`download status ${response.status}`); }
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > maxBytes) { await response.body?.cancel().catch(() => undefined); throw new CreativeMediaRejected('file too large'); }
      const reader = response.body?.getReader();
      if (!reader) throw new CreativeDownloadRetry();
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          let part: { done: boolean; value?: Uint8Array };
          try { part = await reader.read(); } catch { throw new CreativeDownloadRetry(); }
          if (part.done || !part.value) break;
          length += part.value.byteLength;
          if (length > maxBytes) { await reader.cancel().catch(() => undefined); throw new CreativeMediaRejected('file too large'); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      return Buffer.concat(chunks);
    }
    throw new CreativeMediaRejected('too many redirects');
  } finally { clearTimeout(timer); }
}

export interface StoredCreativeObject { byteSize: number; sha256: string }
export interface CreativeIngestJob { jobId: string; mediaKind: SaasCreativeMediaKind }

/**
 * C3 ingest for the worker: download, inspect, strip and store every file of a finished job under the database's key
 * for it. Returns the measured assets (in order) and their stored objects. CreativeDownloadRetry / a store error mean
 * "try again on the next poll"; CreativeMediaRejected means the provider's result cannot be trusted (UNKNOWN for HQ).
 */
export class CreativeMediaIngest {
  private readonly send: CreativeFetch;
  constructor(private readonly store: CreativeMediaStore, options: { send?: CreativeFetch } = {}) {
    this.send = options.send ?? ((url, init) => fetch(url, init));
  }
  readiness() { return this.store.readiness(); }
  async ingest(job: CreativeIngestJob, downloads: CreativeDownload[], claimed: CreativeResultAsset[]): Promise<{ assets: CreativeResultAsset[]; objects: StoredCreativeObject[] }> {
    if (!downloads.length || downloads.length !== claimed.length || downloads.length > 8) throw new CreativeMediaRejected('file count does not match the result');
    const max = job.mediaKind === 'VIDEO' ? CREATIVE_MEDIA_LIMITS.videoBytes : CREATIVE_MEDIA_LIMITS.imageBytes;
    const assets: CreativeResultAsset[] = [], objects: StoredCreativeObject[] = [], stored: string[] = [];
    try {
      for (const [i, download] of downloads.entries()) {
        const media = inspectCreativeMedia(await downloadCreativeFile(this.send, download, max), job.mediaKind);
        const key = `creative/${job.jobId}/${i + 1}`;
        await this.store.put(key, media.bytes, media.mediaType);
        stored.push(key);
        assets.push({ mediaType: media.mediaType, width: media.width, height: media.height, durationSeconds: media.durationSeconds,
          providerAssetReference: claimed[i]!.providerAssetReference });
        objects.push({ byteSize: media.bytes.length, sha256: createHash('sha256').update(media.bytes).digest('hex') });
      }
    } catch (error) {
      // A rejected result is never recorded, so files already stored for it would have no row: remove them (best effort;
      // a retry of the same job overwrites the same keys anyway).
      if (error instanceof CreativeMediaRejected) for (const key of stored) await this.store.remove(key).catch(() => undefined);
      throw error;
    }
    return { assets, objects };
  }
}
