import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Headers, HttpCode, HttpStatus, Injectable, NotFoundException, Param, Post, Req,
  ServiceUnavailableException, UseGuards, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { configuredPublicOrigin } from '@hon/auth';
import { HQ_SCHOOL_VISIT_COMMAND, hqSchoolVisitUuid, validateHqSchoolVisitEnterInput, validateHqSchoolVisitEnterReceipt, validateHqSchoolVisitLeaveInput,
  validateHqSchoolVisitLeaveReceipt, validateHqSchoolVisits, type HqSchoolVisitEnterReceipt, type HqSchoolVisitLeaveReceipt, type HqSchoolVisits } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { assertHqEntitlementHumanRequest } from './hq-entitlement.dto.js';

const INVALID = 'INVALID_HQ_SCHOOL_VISIT_INPUT';

/** Same-origin browser POST from the configured HON origin with the screen's command marker; no delegated/agent/tenant context. */
@Injectable()
export class HqSchoolVisitHumanGuard implements CanActivate {
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
      || req.headers['x-hon-human-command'] !== HQ_SCHOOL_VISIT_COMMAND
      || req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-mode'] !== 'same-origin'
      || req.headers['sec-fetch-dest'] !== 'empty' || req.headers['sec-fetch-user'] !== undefined
      || typeof req.headers['content-type'] !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'])) {
      throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    }
    if (Object.keys(req.query ?? {}).length || req.originalUrl?.includes('?')) throw new BadRequestException({ code: INVALID });
    try {
      hqSchoolVisitUuid(req.params.schoolId);
      if (req.path?.endsWith('/leave') || req.originalUrl?.endsWith('/leave')) validateHqSchoolVisitLeaveInput(req.body);
      else validateHqSchoolVisitEnterInput(req.body);
    } catch { throw new BadRequestException({ code: INVALID }); }
    try { hqSchoolVisitUuid(req.headers['idempotency-key']); }
    catch { throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED' }); }
    return true;
  }
}

function mapError(error: unknown): never {
  const code = (error as { code?: string })?.code;
  if (code === '42501') throw new ForbiddenException({ code: 'HQ_SCHOOL_VISIT_FORBIDDEN' });
  if (code === 'P0002') throw new NotFoundException({ code: 'HQ_SCHOOL_VISIT_UNAVAILABLE', detail: 'This school is paused, removed or not found.' });
  if (code === '23505') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
  if (code === '55P03' || code === '57014' || code === '40001' || code === '40P01') throw new ConflictException({ code: 'HQ_SCHOOL_VISIT_OUTCOME_UNKNOWN', detail: 'Retry the identical request with the same key.' });
  if (['22023', '22P02', '22003', '23514'].includes(code ?? '')) throw new BadRequestException({ code: INVALID });
  throw new ServiceUnavailableException({ code: 'HQ_SCHOOL_VISIT_UNAVAILABLE' });
}

@Injectable()
export class HqSchoolVisitService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async enter(externalSubject: string, schoolId: unknown, body: unknown, idempotencyKey: unknown): Promise<HqSchoolVisitEnterReceipt> {
    let school: string; let key: string; let input;
    try { school = hqSchoolVisitUuid(schoolId); key = hqSchoolVisitUuid(idempotencyKey); input = validateHqSchoolVisitEnterInput(body); }
    catch { throw new BadRequestException({ code: INVALID }); }
    let result: unknown;
    try { result = await this.database.enterSchoolAsHq(externalSubject, school, input.reason ?? null, key, randomUUID(), randomUUID()); }
    catch (error) { mapError(error); }
    try { return validateHqSchoolVisitEnterReceipt(result); }
    catch { throw new ServiceUnavailableException({ code: 'HQ_SCHOOL_VISIT_UNAVAILABLE' }); }
  }

  async leave(externalSubject: string, schoolId: unknown, body: unknown, idempotencyKey: unknown): Promise<HqSchoolVisitLeaveReceipt> {
    let school: string; let key: string;
    try { school = hqSchoolVisitUuid(schoolId); key = hqSchoolVisitUuid(idempotencyKey); validateHqSchoolVisitLeaveInput(body); }
    catch { throw new BadRequestException({ code: INVALID }); }
    let result: unknown;
    try { result = await this.database.leaveSchoolAsHq(externalSubject, school, key, randomUUID(), randomUUID()); }
    catch (error) { mapError(error); }
    try { return validateHqSchoolVisitLeaveReceipt(result); }
    catch { throw new ServiceUnavailableException({ code: 'HQ_SCHOOL_VISIT_UNAVAILABLE' }); }
  }

  async mine(externalSubject: string): Promise<HqSchoolVisits> {
    let result: unknown;
    try { result = await this.database.readMyHqSchoolVisits(externalSubject); }
    catch (error) {
      if ((error as { code?: string })?.code === '42501') throw new ForbiddenException({ code: 'HQ_SCHOOL_VISIT_FORBIDDEN' });
      throw new ServiceUnavailableException({ code: 'HQ_SCHOOL_VISIT_UNAVAILABLE' });
    }
    try { return validateHqSchoolVisits(result); }
    catch { throw new ServiceUnavailableException({ code: 'HQ_SCHOOL_VISIT_UNAVAILABLE' }); }
  }
}

@Controller('hq')
export class HqSchoolVisitController {
  constructor(private readonly visits: HqSchoolVisitService) {}

  /** The signed-in person's own live visits (HQ list and the in-school banner). The verified subject is the only input. */
  @Get('school-visits')
  @UseGuards(HonIdentityGuard)
  async mine(@Req() request: HonRequest) {
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'HQ_SCHOOL_VISIT_SELECTOR_REJECTED' });
    if (!request.honIdentity) throw new ForbiddenException({ code: 'HQ_SCHOOL_VISIT_FORBIDDEN' });
    return { data: await this.visits.mine(request.honIdentity.externalSubject) };
  }

  /** Go inside a school for 4 hours (or stay longer). HQ authority is decided again in the database. */
  @Post('schools/:schoolId/enter')
  @UseGuards(HqSchoolVisitHumanGuard, HonIdentityGuard)
  @HttpCode(HttpStatus.OK)
  async enter(@Req() request: HonRequest, @Param('schoolId') schoolId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    assertHqEntitlementHumanRequest(request);
    if (!request.honIdentity) throw new ForbiddenException({ code: 'HQ_SCHOOL_VISIT_FORBIDDEN' });
    return { data: await this.visits.enter(request.honIdentity.externalSubject, schoolId, body, key) };
  }

  /** Leave now. */
  @Post('schools/:schoolId/leave')
  @UseGuards(HqSchoolVisitHumanGuard, HonIdentityGuard)
  @HttpCode(HttpStatus.OK)
  async leave(@Req() request: HonRequest, @Param('schoolId') schoolId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    assertHqEntitlementHumanRequest(request);
    if (!request.honIdentity) throw new ForbiddenException({ code: 'HQ_SCHOOL_VISIT_FORBIDDEN' });
    return { data: await this.visits.leave(request.honIdentity.externalSubject, schoolId, body, key) };
  }
}
