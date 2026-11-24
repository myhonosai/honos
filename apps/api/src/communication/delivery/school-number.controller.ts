import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, NotFoundException,
  Param, ParseUUIDPipe, Post, Query, Req, ServiceUnavailableException, UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SAAS_COMMANDS, SCHOOL_NUMBER_ORDER_STATUSES, type SchoolNumberOrderStatus } from '@hon/contracts';
import { HonIdentityGuard } from '../../foundation/hon-identity.guard.js';
import type { HonRequest } from '../../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../../foundation/runtime-database.service.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard, SaasReadQuery } from '../../saas-billing/saas-billing.guards.js';
import { SchoolNumberCancelHumanUiGuard, SchoolNumberOrderHumanUiGuard, SchoolNumberReadHumanUiGuard } from './school-number.guard.js';
import { SchoolNumberService, type SchoolNumberContext } from './school-number.service.js';

const PERMISSION = 'communication.sender.manage';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** T2 (0352): the school owner's number search and orders. Route ids are never authority; the database re-proves scope. */
@Controller('organizations/:organizationId/schools/:schoolId/communications/numbers')
@UseGuards(HonIdentityGuard)
export class SchoolNumberController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly numbers: SchoolNumberService) {}

  @Get('search')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolNumberReadHumanUiGuard)
  async search(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: Record<string, unknown>, @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: HonRequest) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(request, organizationId, schoolId, '');
    return { data: await this.numbers.search(context, { ...query }), meta: { requestId: context.requestId } };
  }

  @Get('orders')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolNumberReadHumanUiGuard)
  async list(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: HonRequest) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'INVALID_NUMBER_ORDER' });
    const context = await this.context(request, organizationId, schoolId, '');
    return { data: { orders: await this.numbers.list(context) }, meta: { requestId: context.requestId } };
  }

  @Post('orders')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolNumberOrderHumanUiGuard)
  async order(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() body: unknown, @Req() request: HonRequest) {
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'INVALID_NUMBER_ORDER' });
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey));
    return { data: await this.numbers.order(context, body), meta: { requestId: context.requestId } };
  }

  @Post('orders/:orderId/cancel')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolNumberCancelHumanUiGuard)
  async cancel(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('orderId', new ParseUUIDPipe()) orderId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() body: unknown, @Req() request: HonRequest) {
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'INVALID_NUMBER_ORDER' });
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey));
    return { data: await this.numbers.cancel(context, orderId, body), meta: { requestId: context.requestId } };
  }

  private key(idempotencyKey: string | undefined): string {
    if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    return idempotencyKey;
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

/** T2 (0352): HQ sees every school's number orders; a human HQ owner approves or rejects each one before anything is bought. */
@Controller('hq/saas/school-number-orders')
@UseGuards(HonIdentityGuard)
export class SchoolNumberOrderHqController {
  constructor(private readonly database: RuntimeDatabaseService) {}

  @Get() @UseGuards(SaasReadGuard) @SaasReadQuery(['status'])
  async list(@Req() req: HonRequest, @Query('status') status?: string) {
    if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
    if (status !== undefined && !SCHOOL_NUMBER_ORDER_STATUSES.includes(status as SchoolNumberOrderStatus)) throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
    try {
      return { data: await this.database.callSaasBilling('readHqSchoolNumberOrders', [req.honIdentity.externalSubject, status ?? null]) };
    } catch (error) { return hqError(error); }
  }

  /** T2c (0358): after checking the school's Twilio subaccount, the HQ owner says whether the number was bought. */
  @Post(':orderId/settle') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.settleSchoolNumberOrder)
  async settle(@Req() req: HonRequest, @Param('orderId') orderId: string, @Body() body: unknown) {
    if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
    if (!UUID.test(orderId)) throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
    const input = validateNumberOrderSettle(body);
    try {
      return { data: await this.database.callSaasBilling('settleSchoolNumberOrder', [req.honIdentity.externalSubject, orderId, input.finding,
        input.note, String(input.expectedVersion)]) };
    } catch (error) { return hqError(error); }
  }

  @Post(':orderId/decision') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.decideSchoolNumberOrder)
  async decide(@Req() req: HonRequest, @Param('orderId') orderId: string, @Body() body: unknown) {
    if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
    if (!UUID.test(orderId)) throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
    const input = validateNumberOrderDecision(body);
    try {
      return { data: await this.database.callSaasBilling('decideSchoolNumberOrder', [req.honIdentity.externalSubject, orderId, input.decision,
        input.note ?? null, String(input.expectedVersion)]) };
    } catch (error) { return hqError(error); }
  }
}

export function validateNumberOrderSettle(body: unknown): { finding: 'BOUGHT' | 'NOT_BOUGHT'; note: string; expectedVersion: number } {
  const input = body as Record<string, unknown> | null;
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'expectedVersion,finding,note'
    || (input.finding !== 'BOUGHT' && input.finding !== 'NOT_BOUGHT')
    || typeof input.note !== 'string' || input.note.trim().length < 1 || input.note.length > 500
    || !Number.isSafeInteger(input.expectedVersion) || (input.expectedVersion as number) < 1) {
    throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
  }
  return { finding: input.finding, note: input.note.trim(), expectedVersion: input.expectedVersion as number };
}

export function validateNumberOrderDecision(body: unknown): { decision: 'APPROVE' | 'REJECT'; note?: string; expectedVersion: number } {
  const input = body as Record<string, unknown> | null;
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !['decision', 'note', 'expectedVersion'].includes(key))
    || (input.decision !== 'APPROVE' && input.decision !== 'REJECT')
    || (input.note !== undefined && (typeof input.note !== 'string' || input.note.trim().length < 1 || input.note.length > 500))
    || !Number.isSafeInteger(input.expectedVersion) || (input.expectedVersion as number) < 1) {
    throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
  }
  // A rejection always says why, so the school owner sees a reason.
  if (input.decision === 'REJECT' && input.note === undefined) throw new BadRequestException({ code: 'REJECTION_NOTE_REQUIRED' });
  return { decision: input.decision, expectedVersion: input.expectedVersion as number, ...(input.note === undefined ? {} : { note: (input.note as string).trim() }) };
}

function hqError(error: unknown): never {
  const code = (error as { code?: string })?.code, message = (error as { message?: string })?.message;
  if (code === '42501') throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
  if (code === 'P0002') throw new NotFoundException({ code: 'NUMBER_ORDER_NOT_FOUND' });
  if (code === '40001') throw new ConflictException({ code: 'VERSION_CONFLICT' });
  if (code === '55000') throw new ConflictException({ code: message === 'NUMBER_ORDER_NOT_PENDING' || message === 'NUMBER_ORDER_NOT_UNSETTLED' || message === 'NUMBER_ORDER_OPEN' ? message : 'NUMBER_ORDER_CONFLICT' });
  if (code === '22023') throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
  throw new ServiceUnavailableException({ code: 'SAAS_UNAVAILABLE' });
}
