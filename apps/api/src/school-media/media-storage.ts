import { Injectable } from '@nestjs/common';

/**
 * BL3a (0628) private picture storage: one private Supabase Storage bucket on HON's existing Supabase project, reached
 * over its REST API with the server-side key (owner decision 2026-11-22 "Allow media storage"; no new provider or CDN).
 *
 * Off unless the deployment sets HON_MEDIA_STORAGE_APPROVED=true together with HON_MEDIA_STORAGE_URL (https project
 * URL), HON_MEDIA_STORAGE_KEY and HON_MEDIA_STORAGE_BUCKET. While off, nothing is stored or signed and uploads answer
 * MEDIA_STORAGE_OFF. Keys are always media/<assetId> as fixed by the database; the bucket must be private, so a file is
 * reachable only through a signed link of at most five minutes.
 */
export const MEDIA_SIGNED_LINK_SECONDS = 300;
const OBJECT_KEY = /^media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BUCKET = /^[a-z0-9][a-z0-9_-]{1,62}$/;

export class MediaStorageOff extends Error { constructor() { super('MEDIA_STORAGE_OFF'); } }
export class MediaStorageFailed extends Error { constructor() { super('MEDIA_STORAGE_FAILED'); } }

export interface MediaStorageSettings { baseUrl: string; key: string; bucket: string }
type Fetch = typeof fetch;

/** The storage settings, or null while media storage is not switched on (any missing or malformed value keeps it off). */
export function mediaStorageSettings(env: Record<string, string | undefined> = process.env): MediaStorageSettings | null {
  if (env.HON_MEDIA_STORAGE_APPROVED !== 'true') return null;
  const url = env.HON_MEDIA_STORAGE_URL, key = env.HON_MEDIA_STORAGE_KEY, bucket = env.HON_MEDIA_STORAGE_BUCKET;
  if (!url || !key || !bucket || !BUCKET.test(bucket) || key.length < 20 || key.length > 4096 || /\s/.test(key)) return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  const local = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname) && env.NODE_ENV !== 'production';
  if ((parsed.protocol !== 'https:' && !local) || parsed.username || parsed.password || parsed.search || parsed.hash || !/^\/?$/.test(parsed.pathname)) return null;
  return { baseUrl: parsed.origin, key, bucket };
}

@Injectable()
export class MediaStorage {
  private readonly fetcher: Fetch;
  constructor() { this.fetcher = globalThis.fetch.bind(globalThis); }

  /** For tests: a client with fixed settings and a stand-in fetch. */
  static withSettings(settings: MediaStorageSettings | null, fetcher: Fetch): MediaStorage {
    const storage = new MediaStorage();
    Object.assign(storage, { fetcher, fixed: settings, hasFixed: true });
    return storage;
  }
  private readonly fixed: MediaStorageSettings | null = null;
  private readonly hasFixed: boolean = false;

  get configured(): boolean { return this.settings() !== null; }

  async put(objectKey: string, bytes: Buffer, contentType: string): Promise<void> {
    const settings = this.require(objectKey);
    const response = await this.send(`${settings.baseUrl}/storage/v1/object/${settings.bucket}/${objectKey}`, {
      method: 'POST',
      headers: { ...this.auth(settings), 'Content-Type': contentType, 'x-upsert': 'true', 'Cache-Control': 'max-age=300' },
      body: bytes,
    });
    if (!response.ok) throw new MediaStorageFailed();
  }

  /** A signed link to the file, valid for five minutes. */
  async signedUrl(objectKey: string): Promise<string> {
    const settings = this.require(objectKey);
    const response = await this.send(`${settings.baseUrl}/storage/v1/object/sign/${settings.bucket}/${objectKey}`, {
      method: 'POST', headers: { ...this.auth(settings), 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: MEDIA_SIGNED_LINK_SECONDS }),
    });
    if (!response.ok) throw new MediaStorageFailed();
    let body: unknown;
    try { body = await response.json(); } catch { throw new MediaStorageFailed(); }
    const signed = (body as { signedURL?: unknown })?.signedURL;
    const prefix = `/object/sign/${settings.bucket}/${objectKey}?token=`;
    if (typeof signed !== 'string' || !signed.startsWith(prefix) || !/^[A-Za-z0-9._~-]{20,4096}$/.test(signed.slice(prefix.length))) throw new MediaStorageFailed();
    return `${settings.baseUrl}/storage/v1${signed}`;
  }

  /** Removes the file; a file that is already gone counts as removed. */
  async remove(objectKey: string): Promise<void> {
    const settings = this.require(objectKey);
    const response = await this.send(`${settings.baseUrl}/storage/v1/object/${settings.bucket}`, {
      method: 'DELETE', headers: { ...this.auth(settings), 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [objectKey] }),
    });
    if (!response.ok) throw new MediaStorageFailed();
  }

  private settings(): MediaStorageSettings | null { return this.hasFixed ? this.fixed : mediaStorageSettings(); }
  private require(objectKey: string): MediaStorageSettings {
    const settings = this.settings();
    if (!settings) throw new MediaStorageOff();
    if (!OBJECT_KEY.test(objectKey)) throw new MediaStorageFailed();
    return settings;
  }
  private auth(settings: MediaStorageSettings): Record<string, string> {
    return { Authorization: `Bearer ${settings.key}`, apikey: settings.key };
  }
  private async send(url: string, init: RequestInit): Promise<Response> {
    try { return await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(60_000) }); }
    catch { throw new MediaStorageFailed(); }
  }
}
