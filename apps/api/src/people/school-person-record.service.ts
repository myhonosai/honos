import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { accountUuid, validatePersonRecord, validatePersonRecordUpdateInput, validatePersonRecordUpdateResult, validateStudentBirthDateUpdateInput, validateStudentBirthDateUpdateResult } from '@hon/contracts';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

/** B-CRM-1a/1b. Subject comes only from the signed HON session; school, organization and principal are decided by the database. */
@Injectable()
export class SchoolPersonRecordService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  private async run(operation: 'read'|'update'|'birthDate', args: (string|null)[]): Promise<unknown> {
    try { return await this.database.callSchoolPersonRecord(operation, args); }
    catch (e) {
      const { code, message } = e as { code?: string; message?: string };
      if (code === '42501' && message === 'PERSON_BIRTH_DATE_OWNER_REQUIRED') throw new ForbiddenException({ code: 'PERSON_BIRTH_DATE_OWNER_REQUIRED' });
      if (code === '42501') throw new ForbiddenException({ code: 'PERSON_FORBIDDEN' });
      if (code === 'P0002') throw new NotFoundException({ code: 'PERSON_UNAVAILABLE' });
      if (code === '40001') throw new ConflictException({ code: 'PERSON_VERSION_CONFLICT', outcome: 'NOT_SUBMITTED' });
      if (code === '23514') throw new ConflictException({ code: 'PERSON_CONTACT_CONSENT_REVIEW_REQUIRED', outcome: 'NOT_SUBMITTED' });
      if (code === '23505') throw new ConflictException({ code: 'PERSON_IDEMPOTENCY_CONFLICT' });
      if (code === '55P03') throw new HttpException({ code: 'PERSON_BUSY', outcome: 'NOT_SUBMITTED' }, 503);
      if (code === '22023' && message === 'PERSON_UNCHANGED') throw new BadRequestException({ code: 'PERSON_UNCHANGED' });
      if (code === '22023' || code === '22P02') throw new BadRequestException({ code: 'PERSON_INPUT_INVALID' });
      throw new ServiceUnavailableException({ code: 'PERSON_UNAVAILABLE', outcome: 'UNKNOWN_OR_RETRY_REQUIRED' });
    }
  }

  async read(req: HonRequest, schoolId: unknown, personId: unknown) {
    try { accountUuid(schoolId); accountUuid(personId); } catch { throw new BadRequestException({ code: 'PERSON_INPUT_INVALID' }); }
    return validatePersonRecord(await this.run('read', [req.honIdentity!.externalSubject, schoolId as string, personId as string]));
  }

  async update(req: HonRequest, raw: unknown, key: unknown) {
    let input;
    try { accountUuid(key); input = validatePersonRecordUpdateInput(raw); } catch { throw new BadRequestException({ code: 'PERSON_INPUT_INVALID' }); }
    return validatePersonRecordUpdateResult(await this.run('update', [req.honIdentity!.externalSubject, JSON.stringify(input), key as string]));
  }

  async updateBirthDate(req: HonRequest, raw: unknown, key: unknown) {
    let input;
    try { accountUuid(key); input = validateStudentBirthDateUpdateInput(raw); } catch { throw new BadRequestException({ code: 'PERSON_INPUT_INVALID' }); }
    return validateStudentBirthDateUpdateResult(await this.run('birthDate', [req.honIdentity!.externalSubject, JSON.stringify(input), key as string]));
  }
}
