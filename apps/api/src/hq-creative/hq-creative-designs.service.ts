import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, PayloadTooLargeException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import {
  saasUuid, validateAddCreativeDesignPhotoInput, validateCreativeDesignsQuery, validateSaveCreativeDesignInput, validateSetCreativeDesignStatusInput,
  verifyCreativeDesign, verifyCreativeDesignList, verifyCreativeDesignPhoto, verifyCreativeDesignPhotoReceipt, verifyCreativeDesignReceipt,
  type CreativeDesign, type CreativeDesignList, type CreativeDesignPhoto, type CreativeDesignPhotoReceipt, type CreativeDesignReceipt,
} from '@hon/contracts';
import { RuntimeDatabaseService, type SaasBillingOperation } from '../foundation/runtime-database.service.js';
import { stripImageMetadata } from '../paper-import/image-metadata.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PHOTO_REFUSED = () => new BadRequestException({ code: 'CREATIVE_DESIGN_PHOTO_REFUSED', detail: 'Use a JPEG, PNG or WebP photo.' });

/** Exact 0678 refusals, as the same codes the school editor shows (so one set of plain words serves both). */
const RULES: Record<string, () => HttpException> = {
  CREATIVE_DESIGN_NAME_TAKEN: () => new ConflictException({ code: 'CREATIVE_DESIGN_NAME_TAKEN', detail: 'Another design already has that name.' }),
  CREATIVE_DESIGN_ARCHIVED: () => new ConflictException({ code: 'CREATIVE_DESIGN_ARCHIVED', detail: 'Restore this design before changing it.' }),
  CREATIVE_DESIGN_STATUS_UNCHANGED: () => new ConflictException({ code: 'CREATIVE_DESIGN_STATUS_UNCHANGED', detail: 'The design is already in that state.' }),
  CREATIVE_DESIGN_LIMIT: () => new PayloadTooLargeException({ code: 'CREATIVE_DESIGN_LIMIT', detail: 'HQ has reached the design limit. Archive one first.' }),
  CREATIVE_DESIGN_PHOTO_LIMIT: () => new PayloadTooLargeException({ code: 'CREATIVE_DESIGN_PHOTO_LIMIT', detail: 'HQ has reached the photo limit.' }),
  CREATIVE_DESIGN_PHOTO_REFUSED: PHOTO_REFUSED,
};
const MISSING: Record<string, string> = { CREATIVE_DESIGN_NOT_FOUND: 'CREATIVE_DESIGN_NOT_FOUND', CREATIVE_DESIGN_PHOTO_NOT_FOUND: 'CREATIVE_DESIGN_PHOTO_NOT_FOUND' };

function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const { code, message } = (error ?? {}) as { code?: string; message?: string };
  if (code === '42501') throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
  if (code === 'P0002' && MISSING[message ?? '']) throw new NotFoundException({ code: MISSING[message!] });
  if (code === '23514' && RULES[message ?? '']) throw RULES[message!]!();
  if (code === '40001' && message === 'SAAS_VERSION_CONFLICT') throw new ConflictException({ code: 'VERSION_CONFLICT', detail: 'The design has changed. Reload it and try again.' });
  if (code === '23505') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', detail: 'The idempotency key was already used for a different command.' });
  if (['40001', '40P01', '55P03', '57014'].includes(code ?? '')) throw new ConflictException({ code: 'SAAS_OUTCOME_UNKNOWN', detail: 'Retry the identical request with the same key.' });
  if (['22023', '22P02', '22003', '23514'].includes(code ?? '')) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'SAAS_UNAVAILABLE' });
}
function parse<T>(work: () => T): T {
  try { return work(); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
}

/**
 * 0678 HQ Creative designs: HON's own flyers, posters and social graphics, in HQ-only tables (no organization or school).
 * Each call is one fixed, subject-only definer function that re-proves the HQ marketing person (read: hq.marketing.read
 * or manage; change: HQ owner or hq.marketing.manage). Photos lose their metadata here before the database sees them.
 * Nothing here sends, publishes, prints, charges, spends credits or calls an AI or outside service.
 */
@Injectable()
export class HqCreativeDesignsService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async list(subject: string, query: unknown): Promise<CreativeDesignList> {
    const input = parse(() => validateCreativeDesignsQuery(query));
    return this.call('readHqCreativeDesigns', [subject, JSON.stringify(input)], data => verifyCreativeDesignList(data, input));
  }

  async get(subject: string, designId: string): Promise<CreativeDesign> {
    if (!UUID.test(designId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    return this.call('readHqCreativeDesign', [subject, JSON.stringify({ designId })], data => {
      const design = verifyCreativeDesign(data);
      if (design.designId !== designId) throw new Error('Another design.');
      return design;
    });
  }

  async photo(subject: string, photoId: string): Promise<CreativeDesignPhoto> {
    if (!UUID.test(photoId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    return this.call('readHqCreativeDesignPhoto', [subject, JSON.stringify({ photoId })], data => verifyCreativeDesignPhoto(data, photoId));
  }

  async save(subject: string, body: unknown, key: unknown): Promise<CreativeDesignReceipt> {
    const [input, k] = parse(() => [validateSaveCreativeDesignInput(body), saasUuid(key)] as const);
    return this.call('saveHqCreativeDesign', [subject, JSON.stringify(input), k],
      data => verifyCreativeDesignReceipt(data, { version: input.expectedVersion + 1, designId: input.designId, sizeCode: input.sizeCode, status: 'ACTIVE' }));
  }

  async setStatus(subject: string, body: unknown, key: unknown): Promise<CreativeDesignReceipt> {
    const [input, k] = parse(() => [validateSetCreativeDesignStatusInput(body), saasUuid(key)] as const);
    return this.call('setHqCreativeDesignStatus', [subject, JSON.stringify(input), k],
      data => verifyCreativeDesignReceipt(data, { version: input.expectedVersion + 1, designId: input.designId, status: input.status }));
  }

  /** The bytes must be the declared type; metadata (location, camera, comments) is removed before storing. */
  async addPhoto(subject: string, body: unknown, key: unknown): Promise<CreativeDesignPhotoReceipt> {
    const [input, k] = parse(() => [validateAddCreativeDesignPhotoInput(body), saasUuid(key)] as const);
    let clean: Buffer;
    try { clean = stripImageMetadata(input.mediaType, Buffer.from(input.data, 'base64')); } catch { throw PHOTO_REFUSED(); }
    if (clean.length < 1) throw PHOTO_REFUSED();
    return this.call('addHqCreativeDesignPhoto', [subject, JSON.stringify({ mediaType: input.mediaType, data: clean.toString('base64') }), k],
      data => verifyCreativeDesignPhotoReceipt(data, { mediaType: input.mediaType }));
  }

  private async call<T>(operation: SaasBillingOperation, params: string[], verify: (data: unknown) => T): Promise<T> {
    let data: unknown;
    try { data = await this.database.callSaasBilling(operation, params); } catch (error) { return translate(error); }
    try { return verify(data); } catch { throw new ServiceUnavailableException({ code: 'SAAS_UNAVAILABLE' }); }
  }
}
