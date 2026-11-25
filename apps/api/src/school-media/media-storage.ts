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
const OBJECT_KEY = /^media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.720\.mp4|\.poster\.jpg)?$/;
const ORIGINAL_KEY = /^media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 0654: the three files of a video (original, 720p copy, poster); a picture has only the first. */
export const videoObjectKeys = (originalKey: string): string[] => [originalKey, `${originalKey}.720.mp4`, `${originalKey}.poster.jpg`];
/** The first bytes of a stored file and its total size, from a ranged read. */
export interface StoredFileHead { totalBytes: number; head: Buffer }
const PROBE_BYTES = 4096;
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

  /** Stores a file from disk (the 0654 video copy) without holding it in memory. */
  async putFile(objectKey: string, path: string, byteSize: number, contentType: string): Promise<void> {
    const settings = this.require(objectKey);
    const { createReadStream } = await import('node:fs');
    const { Readable } = await import('node:stream');
    const response = await this.send(`${settings.baseUrl}/storage/v1/object/${settings.bucket}/${objectKey}`, {
      method: 'POST',
      headers: { ...this.auth(settings), 'Content-Type': contentType, 'Content-Length': String(byteSize), 'x-upsert': 'true', 'Cache-Control': 'max-age=300' },
      body: Readable.toWeb(createReadStream(path)) as unknown as RequestInit['body'], duplex: 'half',
    } as RequestInit, 30 * 60_000);
    if (!response.ok) throw new MediaStorageFailed();
  }

  /**
   * 0654: a one-time signed upload link for a video's original (media/<id> only), so the browser stores it straight into the
   * private bucket. The link names exactly this key; nothing else can be written with it.
   */
  async signedUploadUrl(objectKey: string): Promise<string> {
    const settings = this.require(objectKey);
    if (!ORIGINAL_KEY.test(objectKey)) throw new MediaStorageFailed();
    // x-upsert: a retried start signs a new link for the same key, which may already hold a partial upload.
    const response = await this.send(`${settings.baseUrl}/storage/v1/object/upload/sign/${settings.bucket}/${objectKey}`, {
      method: 'POST', headers: { ...this.auth(settings), 'Content-Type': 'application/json', 'x-upsert': 'true' }, body: '{}',
    });
    if (!response.ok) throw new MediaStorageFailed();
    let body: unknown;
    try { body = await response.json(); } catch { throw new MediaStorageFailed(); }
    const signed = (body as { url?: unknown })?.url;
    const prefix = `/object/upload/sign/${settings.bucket}/${objectKey}?token=`;
    if (typeof signed !== 'string' || !signed.startsWith(prefix) || !/^[A-Za-z0-9._~-]{20,4096}$/.test(signed.slice(prefix.length))) throw new MediaStorageFailed();
    return `${settings.baseUrl}/storage/v1${signed}`;
  }

  /** The total size and first 4 KiB of a stored file, or null when there is no such file. */
  async head(objectKey: string): Promise<StoredFileHead | null> {
    const settings = this.require(objectKey);
    const response = await this.send(`${settings.baseUrl}/storage/v1/object/authenticated/${settings.bucket}/${objectKey}`, {
      method: 'GET', headers: { ...this.auth(settings), Range: `bytes=0-${PROBE_BYTES - 1}` },
    });
    if (response.status === 404 || response.status === 400) { await response.body?.cancel().catch(() => undefined); return null; }
    if (response.status !== 206 && response.status !== 200) { await response.body?.cancel().catch(() => undefined); throw new MediaStorageFailed(); }
    let bytes: Buffer;
    try { bytes = Buffer.from(await response.arrayBuffer()); } catch { throw new MediaStorageFailed(); }
    let totalBytes: number;
    if (response.status === 206) {
      const range = /^bytes 0-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
      if (!range) throw new MediaStorageFailed();
      totalBytes = Number(range[2]);
      if (Number(range[1]) + 1 !== bytes.length) throw new MediaStorageFailed();
    } else totalBytes = bytes.length;
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 1 || bytes.length > PROBE_BYTES || bytes.length > totalBytes) throw new MediaStorageFailed();
    return { totalBytes, head: bytes };
  }

  /** Removes the files; a file that is already gone counts as removed. */
  async remove(objectKey: string | readonly string[]): Promise<void> {
    const keys = typeof objectKey === 'string' ? [objectKey] : [...objectKey];
    if (keys.length < 1 || keys.length > 3) throw new MediaStorageFailed();
    let settings: MediaStorageSettings | undefined;
    for (const key of keys) settings = this.require(key);
    const response = await this.send(`${settings!.baseUrl}/storage/v1/object/${settings!.bucket}`, {
      method: 'DELETE', headers: { ...this.auth(settings!), 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: keys }),
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
  private async send(url: string, init: RequestInit, timeoutMs = 60_000): Promise<Response> {
    try { return await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); }
    catch { throw new MediaStorageFailed(); }
  }
}
