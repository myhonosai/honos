import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Injectable, NotFoundException,
  Param, ParseUUIDPipe, Post, Query, Req, ServiceUnavailableException, UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SAAS_COMMANDS, SCHOOL_A2P_CANCEL_COMMAND, SCHOOL_A2P_REQUEST_COMMAND, SCHOOL_A2P_STATUSES, type SchoolA2pStatus } from '@hon/contracts';
import { HonIdentityGuard } from '../../foundation/hon-identity.guard.js';
import type { HonRequest } from '../../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../../foundation/runtime-database.service.js';
import { MembershipActivationHumanUiGuard } from '../../billing/membership-activation-human-ui.guard.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard, SaasReadQuery } from '../../saas-billing/saas-billing.guards.js';
import { SchoolA2pService } from './school-a2p.service.js';
import type { SchoolNumberContext } from './school-number.service.js';

const PERMISSION = 'communication.sender.manage';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 0553: the registration list is a same-origin GET; submitting and withdrawing are each their own browser command. */
@Injectable()
export class SchoolA2pReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'communication.a2p.read';
}
@Injectable()
export class SchoolA2pRequestHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SCHOOL_A2P_REQUEST_COMMAND;
}
@Injectable()
export class SchoolA2pCancelHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SCHOOL_A2P_CANCEL_COMMAND;
}

/** T3a (0553): the school owner's A2P registration. Route ids are never authority; the database re-proves the owner. */
@Controller('organizations/:organizationId/schools/:schoolId/communications/a2p-registrations')
@UseGuards(HonIdentityGuard)
export class SchoolA2pController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly registrations: SchoolA2pService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolA2pReadHumanUiGuard)
  async list(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: HonRequest) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'INVALID_A2P_REGISTRATION' });
    const context = await this.context(request, organizationId, schoolId, '');
    return { data: { registrations: await this.registrations.list(context) }, meta: { requestId: context.requestId } };
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolA2pRequestHumanUiGuard)
  async request(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() body: unknown, @Req() request: HonRequest) {
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'INVALID_A2P_REGISTRATION' });
    const context = await this.context(request, organizationId, schoolId, key(idempotencyKey));
    return { data: await this.registrations.request(context, body), meta: { requestId: context.requestId } };
  }

  @Post(':registrationId/cancel')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolA2pCancelHumanUiGuard)
  async cancel(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('registrationId', new ParseUUIDPipe()) registrationId: string, @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown, @Req() request: HonRequest) {
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'INVALID_A2P_REGISTRATION' });
    const context = await this.context(request, organizationId, schoolId, key(idempotencyKey));
    return { data: await this.registrations.cancel(context, registrationId, body), meta: { requestId: context.requestId } };
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string): Promise<SchoolNumberContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, PERMISSION);
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException({ code: 'SENDER_MANAGE_FORBIDDEN' });
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}

function key(idempotencyKey: string | undefined): string {
  if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  return idempotencyKey;
}

/** T3a (0553): HQ sees every school's A2P registrations; a human HQ owner approves or rejects each submission. */
@Controller('hq/saas/school-a2p-registrations')
@UseGuards(HonIdentityGuard)
export class SchoolA2pHqController {
  constructor(private readonly database: RuntimeDatabaseService) {}

  @Get() @UseGuards(SaasReadGuard) @SaasReadQuery(['status'])
  async list(@Req() req: HonRequest, @Query('status') status?: string) {
    if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
    if (status !== undefined && !SCHOOL_A2P_STATUSES.includes(status as SchoolA2pStatus)) throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
    try {
      return { data: await this.database.callSaasBilling('readHqSchoolA2pRegistrations', [req.honIdentity.externalSubject, status ?? null]) };
    } catch (error) { return hqError(error); }
  }

  @Post(':registrationId/decision') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.decideSchoolA2pRegistration)
  async decide(@Req() req: HonRequest, @Param('registrationId') registrationId: string, @Body() body: unknown) {
    if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
    if (!UUID.test(registrationId)) throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
    const input = validateA2pDecision(body);
    try {
      return { data: await this.database.callSaasBilling('decideSchoolA2pRegistration', [req.honIdentity.externalSubject, registrationId, input.decision,
        input.note ?? null, String(input.expectedVersion)]) };
    } catch (error) { return hqError(error); }
  }
}

export function validateA2pDecision(body: unknown): { decision: 'APPROVE' | 'REJECT'; note?: string; expectedVersion: number } {
  const input = body as Record<string, unknown> | null;
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((k) => !['decision', 'note', 'expectedVersion'].includes(k))
    || (input.decision !== 'APPROVE' && input.decision !== 'REJECT')
    || (input.note !== undefined && (typeof input.note !== 'string' || input.note.length < 1 || input.note.length > 500 || input.note.trim() !== input.note))
    || !Number.isSafeInteger(input.expectedVersion) || (input.expectedVersion as number) < 1) {
    throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
  }
  // A rejection always says why, so the school owner sees a reason.
  if (input.decision === 'REJECT' && input.note === undefined) throw new BadRequestException({ code: 'REJECTION_NOTE_REQUIRED' });
  return { decision: input.decision, expectedVersion: input.expectedVersion as number, ...(input.note === undefined ? {} : { note: input.note as string }) };
}

function hqError(error: unknown): never {
  const code = (error as { code?: string })?.code, message = (error as { message?: string })?.message;
  if (code === '42501') throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
  if (code === 'P0002') throw new NotFoundException({ code: 'A2P_REGISTRATION_NOT_FOUND' });
  if (code === '40001') throw new ConflictException({ code: 'VERSION_CONFLICT' });
  if (code === '55000') throw new ConflictException({ code: message === 'A2P_REGISTRATION_NOT_PENDING' ? message : 'A2P_REGISTRATION_CONFLICT' });
  if (code === '22023') throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
  throw new ServiceUnavailableException({ code: 'SAAS_UNAVAILABLE' });
}
