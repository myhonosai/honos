import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import {
  WalkInKioskDeskPaidHumanUiGuard, WalkInKioskDeviceEndHumanUiGuard, WalkInKioskDeviceStartHumanUiGuard, WalkInKioskReadHumanUiGuard, WalkInKioskSettingsHumanUiGuard,
} from './walk-in-kiosk-human-ui.guard.js';
import { WalkInKioskService } from './walk-in-kiosk.service.js';

const RUN = 'walkin_kiosk.run';
const MANAGE = 'walkin_kiosk.manage';

/**
 * Walk-in kiosk (0414): staff side (Classes > Walk-in kiosk). Route identifiers are never authority: the guarded boundary resolves
 * the scope from the verified session, and each protected database function re-proves the direct human subject and the live
 * permission at the school. Nothing here sends a message or charges anyone.
 */
@Controller('organizations/:organizationId/schools/:schoolId/walk-in-kiosk')
@UseGuards(HonIdentityGuard)
export class WalkInKioskController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly kiosk: WalkInKioskService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WalkInKioskReadHumanUiGuard)
  async overview(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: HonRequest) {
    const context = await this.readContext(request, organizationId, schoolId, idempotencyKey, RUN);
    return { data: await this.kiosk.overview(context), meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Get('settings')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WalkInKioskReadHumanUiGuard)
  async settings(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: HonRequest) {
    const context = await this.readContext(request, organizationId, schoolId, idempotencyKey, MANAGE);
    return { data: await this.kiosk.settings(context), meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Get('visits/:visitId')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WalkInKioskReadHumanUiGuard)
  async visit(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('visitId', new ParseUUIDPipe()) visitId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: HonRequest) {
    const context = await this.readContext(request, organizationId, schoolId, idempotencyKey, RUN);
    return { data: await this.kiosk.visit(context, visitId.toLowerCase()), meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Post('settings')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WalkInKioskSettingsHumanUiGuard)
  async saveSettings(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey), MANAGE);
    return this.receipt(context, await this.kiosk.saveSettings(context, input));
  }

  @Post('devices')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WalkInKioskDeviceStartHumanUiGuard)
  async startDevice(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey), RUN);
    return this.receipt(context, await this.kiosk.startDevice(context, input));
  }

  @Post('devices/:deviceId/end')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WalkInKioskDeviceEndHumanUiGuard)
  async endDevice(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('deviceId', new ParseUUIDPipe()) deviceId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey), RUN);
    return this.receipt(context, await this.kiosk.endDevice(context, deviceId.toLowerCase(), input));
  }

  @Post('visits/:visitId/desk-paid')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WalkInKioskDeskPaidHumanUiGuard)
  async deskPaid(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('visitId', new ParseUUIDPipe()) visitId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey), RUN);
    return this.receipt(context, await this.kiosk.deskPaid(context, visitId.toLowerCase(), input));
  }

  private receipt<R>(context: MembershipLifecycleContext, result: { receipt: R; replayed: boolean }) {
    return { data: result.receipt, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  private noQuery(request: HonRequest): void {
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  }

  private key(idempotencyKey: string | undefined): string {
    const key = idempotencyKey?.trim();
    if (!key || key.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    return key;
  }

  private async readContext(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string | undefined, permission: string) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    this.noQuery(request);
    return this.context(request, organizationId, schoolId, '', permission);
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string, permission: string): Promise<MembershipLifecycleContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) {
      throw new ForbiddenException({ code: 'WALKIN_KIOSK_FORBIDDEN' });
    }
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}

/** Walk-in kiosk (0414): the tablet side. No session, cookie or tenant id is read; the device token in the body is the only selector. */
@Controller('walk-in-kiosk')
export class PublicWalkInKioskController {
  constructor(private readonly kiosk: WalkInKioskService) {}

  @Post('terminal')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  async terminal(@Body() input: unknown) {
    const data = await this.kiosk.terminal(input);
    if (!data) throw new NotFoundException({ result: 'CLOSED' });
    return { data };
  }

  @Post('visits')
  @Header('Cache-Control', 'private, no-store')
  async submit(@Body() input: unknown, @Headers('idempotency-key') key: string, @Res() res: Response) {
    const outcome = await this.kiosk.submit(input, key);
    if (outcome.result === 'RATE_LIMITED') res.setHeader('Retry-After', '3600');
    const status = { RECORDED: 201, INVALID: 400, STALE: 409, CLOSED: 404, RATE_LIMITED: 429, UNAVAILABLE: 503 }[outcome.result];
    return res.status(status).json(outcome);
  }
}
