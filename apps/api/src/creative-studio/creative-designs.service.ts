import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, PayloadTooLargeException, ServiceUnavailableException } from '@nestjs/common';
import {
  validateAddCreativeDesignPhotoInput, validateCreativeDesignsQuery, validateSaveCreativeDesignInput, validateSetCreativeDesignStatusInput,
  verifyCreativeDesign, verifyCreativeDesignList, verifyCreativeDesignPhoto, verifyCreativeDesignPhotoReceipt, verifyCreativeDesignReceipt,
  type CreativeDesign, type CreativeDesignList, type CreativeDesignPhoto, type CreativeDesignPhotoReceipt, type CreativeDesignReceipt,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { stripImageMetadata } from '../paper-import/image-metadata.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const WRITE_LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Exact 0617 error codes; every unknown database failure is unavailable, never success.
const ERRORS: Record<string, { states: string[]; make: (code: string) => HttpException }> = {
  VALIDATION_FAILED: { states: ['22023'], make: code => new BadRequestException({ code }) },
  CREATIVE_DESIGN_PHOTO_REFUSED: { states: ['22023'], make: code => new BadRequestException({ code, detail: 'Use a JPEG, PNG or WebP photo.' }) },
  CREATIVE_DESIGN_FORBIDDEN: { states: ['42501'], make: code => new ForbiddenException({ code }) },
  CREATIVE_DESIGN_NOT_FOUND: { states: ['P0002'], make: code => new NotFoundException({ code }) },
  CREATIVE_DESIGN_PHOTO_NOT_FOUND: { states: ['P0002'], make: code => new NotFoundException({ code }) },
  CREATIVE_DESIGN_ARCHIVED: { states: ['55000'], make: code => new ConflictException({ code, detail: 'Restore this design before changing it.' }) },
  CREATIVE_DESIGN_STATUS_UNCHANGED: { states: ['55000'], make: code => new ConflictException({ code, detail: 'The design is already in that state.' }) },
  CREATIVE_DESIGN_NAME_TAKEN: { states: ['23505'], make: code => new ConflictException({ code, detail: 'Another design already has that name.' }) },
  CREATIVE_DESIGN_LIMIT: { states: ['54000'], make: code => new PayloadTooLargeException({ code, detail: 'This school has reached the design limit. Archive one first.' }) },
  CREATIVE_DESIGN_PHOTO_LIMIT: { states: ['54000'], make: code => new PayloadTooLargeException({ code, detail: 'This school has reached the photo limit.' }) },
  VERSION_CONFLICT: { states: ['40001'], make: code => new ConflictException({ code, detail: 'The design has changed. Reload it and try again with a new Idempotency-Key.' }) },
  IDEMPOTENCY_KEY_REUSED: { states: ['23505'], make: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different command.' }) },
  IDEMPOTENCY_IN_PROGRESS: { states: ['40001'], make: code => new ConflictException({ code, detail: 'The matching command is being processed.' }) },
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = ERRORS[message];
  if (known && known.states.includes(sqlState)) throw known.make(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: 'CREATIVE_DESIGN_FORBIDDEN' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'CREATIVE_DESIGN_CONFLICT' });
  if (['22023', '22P02', '22003', '23514'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'CREATIVE_DESIGN_UNAVAILABLE', detail: 'No verified design answer is available.' });
}

/**
 * 0617 (D1) the school's saved designs and their photos for the Creative Studio design editor. Each read and command is
 * one protected definer call that re-proves the direct human subject and creative.design.read or .manage. Nothing here
 * sends, publishes, prints, charges or calls an outside service. Photos lose their metadata here before they are stored.
 */
@Injectable()
export class CreativeDesignsService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async list(context: MembershipLifecycleContext, query: unknown): Promise<CreativeDesignList> {
    this.assertHuman(context, false);
    let input;
    try { input = validateCreativeDesignsQuery(query); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    return this.read(context, 'SELECT hon.read_school_creative_designs($1,$2::jsonb) AS data', input, data => verifyCreativeDesignList(data, input));
  }

  async get(context: MembershipLifecycleContext, designId: string): Promise<CreativeDesign> {
    this.assertHuman(context, false);
    if (!UUID.test(designId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    return this.read(context, 'SELECT hon.read_school_creative_design($1,$2::jsonb) AS data', { designId }, data => {
      const design = verifyCreativeDesign(data);
      if (design.designId !== designId) throw new Error('Another design.');
      return design;
    });
  }

  async photo(context: MembershipLifecycleContext, photoId: string): Promise<CreativeDesignPhoto> {
    this.assertHuman(context, false);
    if (!UUID.test(photoId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    return this.read(context, 'SELECT hon.read_school_creative_design_photo($1,$2::jsonb) AS data', { photoId }, data => verifyCreativeDesignPhoto(data, photoId));
  }

  async save(context: MembershipLifecycleContext, value: unknown): Promise<CreativeDesignReceipt> {
    this.assertHuman(context, true);
    let input;
    try { input = validateSaveCreativeDesignInput(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    return this.command(context, 'SELECT hon.save_school_creative_design($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data', input,
      data => verifyCreativeDesignReceipt(data, { version: input.expectedVersion + 1, designId: input.designId, sizeCode: input.sizeCode, status: 'ACTIVE' }));
  }

  async setStatus(context: MembershipLifecycleContext, value: unknown): Promise<CreativeDesignReceipt> {
    this.assertHuman(context, true);
    let input;
    try { input = validateSetCreativeDesignStatusInput(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    return this.command(context, 'SELECT hon.set_school_creative_design_status($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data', input,
      data => verifyCreativeDesignReceipt(data, { version: input.expectedVersion + 1, designId: input.designId, status: input.status }));
  }

  /** The bytes must be the declared type; metadata (location, camera, comments) is removed before the database sees them. */
  async addPhoto(context: MembershipLifecycleContext, value: unknown): Promise<CreativeDesignPhotoReceipt> {
    this.assertHuman(context, true);
    let input;
    try { input = validateAddCreativeDesignPhotoInput(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    let clean: Buffer;
    try { clean = stripImageMetadata(input.mediaType, Buffer.from(input.data, 'base64')); }
    catch { throw new BadRequestException({ code: 'CREATIVE_DESIGN_PHOTO_REFUSED', detail: 'Use a JPEG, PNG or WebP photo.' }); }
    if (clean.length < 1) throw new BadRequestException({ code: 'CREATIVE_DESIGN_PHOTO_REFUSED', detail: 'Use a JPEG, PNG or WebP photo.' });
    const stored = { mediaType: input.mediaType, data: clean.toString('base64') };
    return this.command(context, 'SELECT hon.add_school_creative_design_photo($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data', stored,
      data => verifyCreativeDesignPhotoReceipt(data, { mediaType: input.mediaType }));
  }

  private async read<T>(context: MembershipLifecycleContext, statement: string, input: object, verify: (data: unknown) => T): Promise<T> {
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>(statement, [context.externalSubject, JSON.stringify(input)]);
        if (result.rows.length !== 1) throw new Error('Unverified design answer.');
        return verify(result.rows[0]!.data);
      });
    } catch (error) { return translate(error); }
  }

  private async command<T>(context: MembershipLifecycleContext, statement: string, input: object, verify: (data: unknown) => T): Promise<T> {
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>(statement,
          [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        if (result.rows.length !== 1) throw new Error('Unverified design receipt.');
        return verify(result.rows[0]!.data);
      });
    } catch (error) { return translate(error); }
  }

  private assertHuman(context: MembershipLifecycleContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Designs accept only direct human commands.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.length > 200 || subject.trim() !== subject) throw new ForbiddenException({ code: 'CREATIVE_DESIGN_FORBIDDEN' });
    if (!command) {
      if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
      return;
    }
    if (!context.idempotencyKey || context.idempotencyKey !== context.idempotencyKey.trim() || context.idempotencyKey.length > 200) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
  }
}
