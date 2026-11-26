import { BadRequestException, ConflictException, Controller, ForbiddenException, Get, Headers, HttpCode, HttpStatus, Injectable, NotFoundException, Param, Post, Req,
  ServiceUnavailableException, UseGuards, Body, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { configuredPublicOrigin } from '@hon/auth';
import { HQ_SCHOOL_LIFECYCLE_COMMAND, hqSchoolLifecycleUuid, validateHqSchoolArchiveDates, validateHqSchoolLifecycleInput, validateHqSchoolLifecycleReceipt,
  type HqSchoolArchiveDates, type HqSchoolLifecycleReceipt } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { assertHqEntitlementHumanRequest } from './hq-entitlement.dto.js';

const INVALID = 'INVALID_HQ_SCHOOL_LIFECYCLE_INPUT';

/** Same-origin browser POST from the configured HON origin with the screen's command marker; no delegated/agent/tenant context. */
@Injectable()
export class HqSchoolLifecycleHumanGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HonRequest>();
    const res = context.switchToHttp().getResponse();
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    assertHqEntitlementHumanRequest(req);
    let origin: string | undefined;
    try { origin = configuredPublicOrigin(process.env); } catch { /* fail closed */ }
    if (!origin) throw new ServiceUnavailableException({ code: 'HUMAN_UI_ORIGIN_NOT_CONFIGURED' });
    if (req.method !== 'POST' || req.headers.authorization !== undefined || req.headers.origin !== origin
      || Object.keys(req.headers).some(key => key.toLowerCase().startsWith('x-hon-') && key.toLowerCase() !== 'x-hon-human-command')
      || req.headers['x-hon-human-command'] !== HQ_SCHOOL_LIFECYCLE_COMMAND
      || req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-mode'] !== 'same-origin'
      || req.headers['sec-fetch-dest'] !== 'empty' || req.headers['sec-fetch-user'] !== undefined
      || typeof req.headers['content-type'] !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'])) {
      throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    }
    if (Object.keys(req.query ?? {}).length || req.originalUrl?.includes('?')) throw new BadRequestException({ code: INVALID });
    try { hqSchoolLifecycleUuid(req.params.schoolId); validateHqSchoolLifecycleInput(req.body); }
    catch { throw new BadRequestException({ code: INVALID }); }
    try { hqSchoolLifecycleUuid(req.headers['idempotency-key']); }
    catch { throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED' }); }
    return true;
  }
}

@Injectable()
export class HqSchoolLifecycleService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async transition(externalSubject: string, schoolId: unknown, body: unknown, idempotencyKey: unknown): Promise<HqSchoolLifecycleReceipt> {
    let school: string; let key: string; let input;
    try { school = hqSchoolLifecycleUuid(schoolId); key = hqSchoolLifecycleUuid(idempotencyKey); input = validateHqSchoolLifecycleInput(body); }
    catch { throw new BadRequestException({ code: INVALID }); }
    let result: unknown;
    try {
      result = await this.database.transitionSchoolLifecycleFromHq(externalSubject, school, input, key, randomUUID(), randomUUID());
    } catch (error) {
      const code = (error as { code?: string })?.code;
      const message = (error as { message?: string })?.message ?? '';
      if (code === '42501') throw new ForbiddenException({ code: 'HQ_SCHOOL_LIFECYCLE_FORBIDDEN' });
      if (code === 'P0002') throw new NotFoundException({ code: 'HQ_SCHOOL_LIFECYCLE_UNAVAILABLE' });
      if (code === '40001' && message.includes('BILLING_ACTIVE')) throw new ConflictException({ code: 'HQ_SCHOOL_LIFECYCLE_BILLING_ACTIVE', detail: 'This school has an active HON subscription. End its billing first.' });
      if (code === '40001') throw new ConflictException({ code: 'HQ_SCHOOL_LIFECYCLE_STATUS_CONFLICT', detail: 'The school changed. Reload the list and try again.' });
      if (code === '23505') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
      if (code === '55P03' || code === '57014') throw new ConflictException({ code: 'HQ_SCHOOL_LIFECYCLE_OUTCOME_UNKNOWN', detail: 'Retry the identical request with the same key.' });
      if (code === '22023' && message.includes('NAME_MISMATCH')) throw new BadRequestException({ code: 'HQ_SCHOOL_LIFECYCLE_NAME_MISMATCH' });
      if (['22023', '22P02', '22003', '23514'].includes(code ?? '')) throw new BadRequestException({ code: INVALID });
      throw new ServiceUnavailableException({ code: 'HQ_SCHOOL_LIFECYCLE_UNAVAILABLE' });
    }
    try { return validateHqSchoolLifecycleReceipt(result); }
    catch { throw new ServiceUnavailableException({ code: 'HQ_SCHOOL_LIFECYCLE_UNAVAILABLE' }); }
  }

  async readArchives(externalSubject: string): Promise<HqSchoolArchiveDates> {
    let result: unknown;
    try { result = await this.database.readHqSchoolArchiveDates(externalSubject); }
    catch (error) {
      if ((error as { code?: string })?.code === '42501') throw new ForbiddenException({ code: 'HQ_SCHOOLS_FORBIDDEN' });
      throw new ServiceUnavailableException({ code: 'HQ_SCHOOLS_UNAVAILABLE' });
    }
    try { return validateHqSchoolArchiveDates(result); }
    catch { throw new ServiceUnavailableException({ code: 'HQ_SCHOOLS_UNAVAILABLE' }); }
  }
}

@Controller('hq')
export class HqSchoolLifecycleController {
  constructor(private readonly lifecycle: HqSchoolLifecycleService) {}

  /** Archived schools with their erase dates. The verified subject is the only input. */
  @Get('school-archives')
  @UseGuards(HonIdentityGuard)
  async archives(@Req() request: HonRequest) {
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'HQ_SCHOOLS_SELECTOR_REJECTED' });
    if (!request.honIdentity) throw new ForbiddenException({ code: 'HQ_SCHOOLS_FORBIDDEN' });
    return { data: await this.lifecycle.readArchives(request.honIdentity.externalSubject) };
  }

  /** Pause, resume, archive (typed name) or restore one school. Authority is decided again in the database. */
  @Post('schools/:schoolId/lifecycle')
  @UseGuards(HqSchoolLifecycleHumanGuard, HonIdentityGuard)
  @HttpCode(HttpStatus.OK)
  async transition(@Req() request: HonRequest, @Param('schoolId') schoolId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    assertHqEntitlementHumanRequest(request);
    if (!request.honIdentity) throw new ForbiddenException({ code: 'HQ_SCHOOL_LIFECYCLE_FORBIDDEN' });
    return { data: await this.lifecycle.transition(request.honIdentity.externalSubject, schoolId, body, key) };
  }
}
