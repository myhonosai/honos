import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  PERSON_PHOTO_MAX_BYTES, accountUuid, validatePersonPhotoRead, validatePersonPhotoRemoveInput, validatePersonPhotoRemoveResult,
  validatePersonPhotoSetInput, validatePersonPhotoSetResult, type PersonPhotoRead, type PersonPhotoRemoveResult, type PersonPhotoSetResult,
} from '@hon/contracts';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { ImageRefused, stripImageMetadata } from '../paper-import/image-metadata.js';

const REFUSED = 'Use a JPEG, PNG or WebP photo of up to 400 KB.';
const ERRORS: Record<string, (code: string) => HttpException> = {
  PERSON_PHOTO_INVALID: code => new BadRequestException({ code }),
  PERSON_PHOTO_FORBIDDEN: code => new ForbiddenException({ code }),
  PERSON_PHOTO_NOT_FOUND: code => new NotFoundException({ code }),
  PERSON_PHOTO_IMAGE_REFUSED: code => new BadRequestException({ code, detail: REFUSED }),
  PERSON_PHOTO_VERSION_CONFLICT: code => new ConflictException({ code, outcome: 'NOT_SUBMITTED', detail: 'The photo changed. Reload it and try again.' }),
  PERSON_PHOTO_KEY_REUSED: code => new ConflictException({ code }),
  PERSON_PHOTO_BUSY: code => new HttpException({ code, outcome: 'NOT_SUBMITTED' }, 503),
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = ERRORS[message];
  if (known && ['22023', '42501', 'P0002', '40001', '23505', '55P03'].includes(sqlState)) throw known(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: 'PERSON_PHOTO_FORBIDDEN' });
  if (['22023', '22P02'].includes(sqlState)) throw new BadRequestException({ code: 'PERSON_PHOTO_INVALID' });
  throw new ServiceUnavailableException({ code: 'PERSON_PHOTO_UNAVAILABLE', outcome: 'UNKNOWN_OR_RETRY_REQUIRED' });
}

/**
 * 0390 contact photos. The subject comes only from the signed HON session; the database decides school, organization,
 * principal and permission (people.read to see, people.update to change). Photos are stripped of metadata here and the
 * table refuses any that still carries it.
 */
@Injectable()
export class SchoolPersonPhotoService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async read(req: HonRequest, schoolId: unknown, personId: unknown): Promise<PersonPhotoRead> {
    let school: string, person: string;
    try { school = accountUuid(schoolId).toLowerCase(); person = accountUuid(personId).toLowerCase(); } catch { throw new BadRequestException({ code: 'PERSON_PHOTO_INVALID' }); }
    let raw: unknown;
    try { raw = await this.database.callSchoolPersonPhoto('read', [req.honIdentity!.externalSubject, school, person]); } catch (e) { translate(e); }
    const read = validatePersonPhotoRead(raw);
    if (read.personId !== person) throw new ServiceUnavailableException({ code: 'PERSON_PHOTO_UNAVAILABLE' });
    return read;
  }

  async set(req: HonRequest, body: unknown, key: unknown): Promise<PersonPhotoSetResult> {
    let input, k: string;
    try { k = accountUuid(key); input = validatePersonPhotoSetInput(body); } catch { throw new BadRequestException({ code: 'PERSON_PHOTO_INVALID' }); }
    const raw = Buffer.from(input.data, 'base64');
    if (raw.length < 1 || raw.length > PERSON_PHOTO_MAX_BYTES || raw.toString('base64') !== input.data) throw new BadRequestException({ code: 'PERSON_PHOTO_IMAGE_REFUSED', detail: REFUSED });
    let clean: Buffer;
    try { clean = stripImageMetadata(input.mediaType, raw); } catch (error) {
      if (error instanceof ImageRefused) throw new BadRequestException({ code: 'PERSON_PHOTO_IMAGE_REFUSED', detail: REFUSED });
      throw error;
    }
    let result: unknown;
    try {
      result = await this.database.callSchoolPersonPhoto('set', [req.honIdentity!.externalSubject,
        JSON.stringify({ schoolId: input.schoolId, personId: input.personId, expectedVersion: input.expectedVersion, mediaType: input.mediaType, data: clean.toString('base64') }), k]);
    } catch (e) { translate(e); }
    const out = validatePersonPhotoSetResult(result);
    if (out.photo.personId !== input.personId) throw new ServiceUnavailableException({ code: 'PERSON_PHOTO_UNAVAILABLE' });
    return out;
  }

  async remove(req: HonRequest, body: unknown, key: unknown): Promise<PersonPhotoRemoveResult> {
    let input, k: string;
    try { k = accountUuid(key); input = validatePersonPhotoRemoveInput(body); } catch { throw new BadRequestException({ code: 'PERSON_PHOTO_INVALID' }); }
    let result: unknown;
    try { result = await this.database.callSchoolPersonPhoto('remove', [req.honIdentity!.externalSubject, JSON.stringify(input), k]); } catch (e) { translate(e); }
    const out = validatePersonPhotoRemoveResult(result);
    if (out.personId !== input.personId) throw new ServiceUnavailableException({ code: 'PERSON_PHOTO_UNAVAILABLE' });
    return out;
  }
}
