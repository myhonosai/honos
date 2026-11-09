import { BadRequestException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { accountUuid, validateHqSchoolOwnership, validateSchoolOwnerOwnershipView, validateSchoolOwnershipReceipt,
  validateSetPrimaryOwnerInput } from '@hon/contracts';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService, type SchoolOwnershipOperation } from '../foundation/runtime-database.service.js';
import { SchoolAccountRateLimit } from './school-account-rate-limit.js';

/** B-ID-4 (0223 proposed): the HQ-owner ownership read and primary-owner command, and the school owner's own ownership view. */
@Injectable()
export class SchoolOwnershipService {
  private readonly rateLimit = new SchoolAccountRateLimit();
  constructor(private readonly database: RuntimeDatabaseService) {}
  private admit(req: HonRequest, operation: string) {
    const wait = this.rateLimit.admit(req.honIdentity!.externalSubject, operation === 'hqRead' || operation === 'ownerRead' ? 'list' : 'revoke');
    if (wait) {
      req.res?.setHeader('Retry-After', String(wait));
      throw new HttpException({ code: 'ACCOUNT_RATE_LIMITED', outcome: 'NOT_SUBMITTED', retryAfterSeconds: wait }, 429);
    }
  }
  private async run(operation: SchoolOwnershipOperation, args: (string | null)[]): Promise<unknown> {
    try { return await this.database.callSchoolOwnership(operation, args); }
    catch (e) {
      const { code, message } = e as { code?: string; message?: string };
      if (code === '42501') throw new ForbiddenException({ code: 'ACCOUNT_FORBIDDEN' });
      if (code === 'P0002') throw new HttpException({ code: message === 'OWNERSHIP_OWNER_NOT_LIVE' ? 'OWNERSHIP_OWNER_NOT_LIVE' : 'ACCOUNT_UNAVAILABLE' }, 404);
      if (code === '23505' || code === '55P03') throw new HttpException({ code: 'ACCOUNT_CONFLICT' }, 409);
      if (code === '22023' || code === '22P02') throw new BadRequestException({ code: 'ACCOUNT_INPUT_INVALID' });
      throw new ServiceUnavailableException({ code: 'ACCOUNT_UNAVAILABLE', outcome: 'UNKNOWN_OR_RETRY_REQUIRED' });
    }
  }
  private static drift<T>(validate: () => T): T {
    try { return validate(); } catch { throw new ServiceUnavailableException({ code: 'ACCOUNT_UNAVAILABLE' }); }
  }
  private static school(raw: unknown): string {
    try { return accountUuid(raw); } catch { throw new BadRequestException({ code: 'ACCOUNT_INPUT_INVALID' }); }
  }
  async hqSchool(req: HonRequest, schoolId: unknown) {
    const school = SchoolOwnershipService.school(schoolId);
    this.admit(req, 'hqRead');
    const data = await this.run('hqRead', [req.honIdentity!.externalSubject, school]);
    return SchoolOwnershipService.drift(() => validateHqSchoolOwnership(data));
  }
  async ownerView(req: HonRequest, schoolId: unknown) {
    const school = SchoolOwnershipService.school(schoolId);
    this.admit(req, 'ownerRead');
    const data = await this.run('ownerRead', [req.honIdentity!.externalSubject, school]);
    return SchoolOwnershipService.drift(() => validateSchoolOwnerOwnershipView(data));
  }
  async setPrimary(req: HonRequest, raw: unknown, key: unknown) {
    let input: object;
    try { accountUuid(key); input = validateSetPrimaryOwnerInput(raw); }
    catch { throw new BadRequestException({ code: 'ACCOUNT_INPUT_INVALID' }); }
    this.admit(req, 'setPrimary');
    const data = await this.run('setPrimary', [req.honIdentity!.externalSubject, JSON.stringify(input), key as string]);
    return SchoolOwnershipService.drift(() => validateSchoolOwnershipReceipt(data));
  }
}
