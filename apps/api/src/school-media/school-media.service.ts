import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, PayloadTooLargeException, ServiceUnavailableException } from '@nestjs/common';
import {
  schoolMediaTitleOk, validateDeleteSchoolMedia, validateRenameSchoolMedia, verifySchoolMediaAsset, verifySchoolMediaLibrary,
  SCHOOL_MEDIA_LINK_TOKEN, SCHOOL_MEDIA_LIMITS, type SchoolMediaAsset, type SchoolMediaDeleteReceipt, type SchoolMediaLibrary, type SchoolMediaReceipt,
} from '@hon/contracts';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { MediaImageRefused, prepareMediaImage } from './media-image.js';
import { MediaStorage, MediaStorageOff } from './media-storage.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const WRITE_LIMITS = "SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const PUBLIC_MEDIA_LINK = 'SELECT hon.resolve_school_media_link($1) AS data';

// Exact 0628 error codes; every unknown database failure is unavailable, never success.
const ERRORS: Record<string, { states: string[]; make: (code: string) => HttpException }> = {
  VALIDATION_FAILED: { states: ['22023'], make: code => new BadRequestException({ code }) },
  SCHOOL_MEDIA_FORBIDDEN: { states: ['42501'], make: code => new ForbiddenException({ code }) },
  MEDIA_NOT_FOUND: { states: ['P0002'], make: code => new NotFoundException({ code }) },
  MEDIA_STORAGE_FULL: { states: ['55000'], make: code => new ConflictException({ code, detail: 'This school has used its 5 GB of picture storage. Delete pictures you no longer need.' }) },
  MEDIA_MONTHLY_LIMIT: { states: ['55000'], make: code => new ConflictException({ code, detail: 'This school has uploaded 10 GB this month. Try again next month.' }) },
  MEDIA_UPLOAD_MISMATCH: { states: ['22023'], make: code => new ConflictException({ code }) },
  MEDIA_NOT_PENDING: { states: ['55000'], make: code => new ConflictException({ code }) },
  MEDIA_NOT_DELETED: { states: ['55000'], make: code => new ConflictException({ code }) },
  VERSION_CONFLICT: { states: ['40001'], make: code => new ConflictException({ code, detail: 'This changed. Reload and try again with a new Idempotency-Key.' }) },
  IDEMPOTENCY_KEY_REUSED: { states: ['23505'], make: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different command.' }) },
  IDEMPOTENCY_IN_PROGRESS: { states: ['40001'], make: code => new ConflictException({ code, detail: 'The matching command is being processed.' }) },
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = ERRORS[message];
  if (known && known.states.includes(sqlState)) throw known.make(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: 'SCHOOL_MEDIA_FORBIDDEN' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'SCHOOL_MEDIA_CONFLICT' });
  if (['22023', '22P02', '22003', '22007', '22008', '23514'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'SCHOOL_MEDIA_UNAVAILABLE' });
}
class Unverified extends Error { constructor() { super('Unverified school media answer.'); } }
function unverified(): never { throw new Unverified(); }
function invalidInput(): never { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
const storageOff = () => new ServiceUnavailableException({ code: 'MEDIA_STORAGE_OFF', detail: 'Media storage is not switched on for HON yet, so nothing was stored.' });
const storageFailed = () => new ServiceUnavailableException({ code: 'MEDIA_STORAGE_FAILED', detail: 'The picture could not be stored. Try again.' });

/** A database answer that carries the picture plus its fixed storage key (and replayed=true on a replay). */
interface KeyedAnswer { row: Record<string, unknown>; objectKey: string; replayed: boolean; state: string }
function keyed(value: unknown, assetId?: string): KeyedAnswer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unverified();
  const { objectKey, replayed, ...row } = value as Record<string, unknown>;
  const id = row.assetId;
  if (typeof id !== 'string' || !UUID.test(id) || (assetId && id !== assetId.toLowerCase()) || objectKey !== `media/${id}`) unverified();
  if (replayed !== undefined && replayed !== true) unverified();
  if (!['PENDING', 'READY', 'DELETED', 'REMOVED'].includes(row.state as string)) unverified();
  return { row, objectKey: objectKey as string, replayed: replayed === true, state: row.state as string };
}

export interface SchoolMediaUploadInput { title: unknown; mediaType: unknown; bytes: unknown }

/**
 * BL3a (0628): the school media library. Every read and command is a protected definer call that re-proves the direct human
 * subject and the live permission; this service only cleans pictures, moves bytes to and from private storage, and signs
 * five-minute file links. The database fixes every storage key, so no key is ever taken from a request.
 */
@Injectable()
export class SchoolMediaService {
  constructor(private readonly database: RuntimeDatabaseService, private readonly storage: MediaStorage) {}

  async library(context: MembershipLifecycleContext): Promise<SchoolMediaLibrary> {
    this.assertHumanContext(context, false);
    return this.read(context, 'SELECT hon.read_school_media($1) AS data', [context.externalSubject], verifySchoolMediaLibrary);
  }

  /** Clean, reserve (PENDING, within the caps), store, confirm (READY). A replay stores only while still PENDING. */
  async upload(context: MembershipLifecycleContext, input: SchoolMediaUploadInput): Promise<SchoolMediaReceipt> {
    this.assertHumanContext(context, true);
    if (!schoolMediaTitleOk(input.title) || typeof input.mediaType !== 'string') invalidInput();
    if (!Buffer.isBuffer(input.bytes) || input.bytes.length < 1) invalidInput();
    if (input.bytes.length > SCHOOL_MEDIA_LIMITS.maxBytes) throw new PayloadTooLargeException({ code: 'MEDIA_TOO_LARGE', detail: 'A picture can be at most 25 MB.' });
    if (!this.storage.configured) throw storageOff();
    let image;
    try { image = prepareMediaImage(input.mediaType, input.bytes); }
    catch (error) {
      if (error instanceof MediaImageRefused) throw new BadRequestException({ code: 'MEDIA_IMAGE_REFUSED', detail: 'Choose a JPEG, PNG or GIF picture.' });
      throw error;
    }
    const begun = await this.write(context, 'SELECT hon.begin_school_media_upload($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data',
      [JSON.stringify({ title: input.title, mediaType: image.mediaType, byteSize: image.byteSize, sha256: image.sha256, width: image.width, height: image.height }), context.idempotencyKey],
      value => keyed(value));
    if (begun.state === 'DELETED' || begun.state === 'REMOVED') throw new ConflictException({ code: 'MEDIA_DELETED', detail: 'This picture was deleted.' });
    const assetId = begun.row.assetId as string;
    if (begun.state === 'READY') return { asset: this.asset(begun.row, assetId), replayed: begun.replayed };
    try { await this.storage.put(begun.objectKey, image.bytes, image.mediaType); }
    catch (error) {
      await this.abandon(context, assetId, begun.row.version);
      if (error instanceof MediaStorageOff) throw storageOff();
      throw storageFailed();
    }
    const ready = await this.write(context, 'SELECT hon.finish_school_media_upload($1,$2::jsonb,$3::uuid,$4::uuid) AS data',
      [JSON.stringify({ assetId, byteSize: image.byteSize, sha256: image.sha256 })], value => this.asset(value, assetId));
    if (ready.state !== 'READY') unverified();
    return { asset: ready, replayed: begun.replayed };
  }

  async rename(context: MembershipLifecycleContext, value: unknown): Promise<SchoolMediaReceipt> {
    this.assertHumanContext(context, true);
    let input;
    try { input = validateRenameSchoolMedia(value); } catch { invalidInput(); }
    return this.write(context, 'SELECT hon.rename_school_media($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data', [JSON.stringify(input), context.idempotencyKey], data => {
      if (!data || typeof data !== 'object') unverified();
      const { replayed, ...row } = data as Record<string, unknown>;
      if (replayed !== undefined && replayed !== true) unverified();
      const asset = this.asset(row, input.assetId);
      if (asset.title !== input.title || asset.version !== input.expectedVersion + 1) unverified();
      return { asset, replayed: replayed === true };
    });
  }

  /** Links stop as soon as the database marks it DELETED; the file is then removed and the removal confirmed. */
  async delete(context: MembershipLifecycleContext, value: unknown): Promise<SchoolMediaDeleteReceipt> {
    this.assertHumanContext(context, true);
    let input;
    try { input = validateDeleteSchoolMedia(value); } catch { invalidInput(); }
    const deleted = await this.write(context, 'SELECT hon.delete_school_media($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data', [JSON.stringify(input), context.idempotencyKey],
      data => keyed(data, input.assetId));
    if (deleted.state === 'PENDING' || deleted.state === 'READY') unverified();
    const removed = deleted.state === 'REMOVED' || await this.removeFile(context, input.assetId, deleted.objectKey);
    return { assetId: input.assetId, removed, replayed: deleted.replayed };
  }

  /** The public /m/<token> link: a five-minute signed file link, or null when the token names no READY picture. */
  async publicLink(token: string): Promise<string | null> {
    if (typeof token !== 'string' || !SCHOOL_MEDIA_LINK_TOKEN.test(token)) return null;
    let data: unknown;
    try { data = await this.database.runPublicEventCall(PUBLIC_MEDIA_LINK, [token]); }
    catch { throw new ServiceUnavailableException({ result: 'UNAVAILABLE' }); }
    if (data === null) return null;
    const row = data as { objectKey?: unknown; mediaType?: unknown } | null;
    if (!row || typeof row !== 'object' || Object.keys(row).length !== 2 || typeof row.objectKey !== 'string' || !/^media\/[0-9a-f-]{36}$/.test(row.objectKey)
      || !['image/jpeg', 'image/png', 'image/gif'].includes(row.mediaType as string)) throw new ServiceUnavailableException({ result: 'UNAVAILABLE' });
    if (!this.storage.configured) return null;
    try { return await this.storage.signedUrl(row.objectKey); }
    catch { throw new ServiceUnavailableException({ result: 'UNAVAILABLE' }); }
  }

  private async removeFile(context: MembershipLifecycleContext, assetId: string, objectKey: string): Promise<boolean> {
    if (!this.storage.configured) return false;
    try { await this.storage.remove(objectKey); } catch { return false; }
    try {
      await this.write(context, 'SELECT hon.confirm_school_media_removed($1,$2::uuid,$3::uuid,$4::uuid) AS data', [assetId], data => {
        const row = data as { assetId?: unknown; state?: unknown } | null;
        if (!row || row.assetId !== assetId || row.state !== 'REMOVED') unverified();
        return row;
      });
      return true;
    } catch { return false; }
  }

  /** A picture whose bytes could not be stored is deleted and any partial file removed (best effort), so it does not hold storage. */
  private async abandon(context: MembershipLifecycleContext, assetId: string, version: unknown): Promise<void> {
    if (typeof version !== 'number') return;
    const abandon = { ...context, idempotencyKey: `media-abandon:${randomUUID()}` };
    const deleted = await this.write(abandon, 'SELECT hon.delete_school_media($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data',
      [JSON.stringify({ assetId, expectedVersion: version }), abandon.idempotencyKey], data => keyed(data, assetId)).catch(() => null);
    if (deleted?.state === 'DELETED') await this.removeFile(context, assetId, deleted.objectKey);
  }

  private asset(value: unknown, assetId: string): SchoolMediaAsset {
    let asset;
    try { asset = verifySchoolMediaAsset(value); } catch { unverified(); }
    if (asset.assetId !== assetId.toLowerCase()) unverified();
    return asset;
  }

  private async read<T>(context: MembershipLifecycleContext, sql: string, params: unknown[], verify: (value: unknown) => T): Promise<T> {
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async (client: PoolClient) => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>(sql, params);
        if (result.rows.length !== 1) unverified();
        return verify(result.rows[0]!.data);
      });
    } catch (error) { return this.fail(error); }
  }

  /** One definer call in one transaction: (subject, ...params, request, correlation). */
  private async write<T>(context: MembershipLifecycleContext, sql: string, params: unknown[], verify: (value: unknown) => T): Promise<T> {
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>(sql, [context.externalSubject, ...params, context.requestId, context.correlationId]);
        if (result.rows.length !== 1) unverified();
        return verify(result.rows[0]!.data);
      });
    } catch (error) { return this.fail(error); }
  }

  private fail(error: unknown): never {
    if (error instanceof Unverified) throw new ServiceUnavailableException({ code: 'SCHOOL_MEDIA_UNAVAILABLE' });
    return translate(error);
  }

  private assertHumanContext(context: MembershipLifecycleContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'The media library accepts only direct human commands.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 2048) throw new ForbiddenException({ code: 'SCHOOL_MEDIA_FORBIDDEN' });
    if (!command) {
      if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
      return;
    }
    if (!context.idempotencyKey || context.idempotencyKey !== context.idempotencyKey.trim() || context.idempotencyKey.length > 200) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
  }
}
