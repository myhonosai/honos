import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import {
  CalendarBlockOutAddHumanUiGuard, CalendarBlockOutRemoveHumanUiGuard, CalendarBlockOutsReadHumanUiGuard, CalendarSettingsReadHumanUiGuard,
  CalendarShareSettingsSaveHumanUiGuard, ShareCalendarDeleteHumanUiGuard, ShareCalendarSaveHumanUiGuard,
} from './calendar-settings-human-ui.guard.js';
import { CalendarBlockOutDto, CalendarShareSettingsDto, CalendarVersionDto, ShareCalendarDto } from './calendar-settings.dto.js';
import { CalendarSettingsService } from './calendar-settings.service.js';

const MANAGE = 'schedule.session.manage';
const READ = 'schedule.session.read';

function fields(input: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value !== undefined));
}

/**
 * 0568 calendar settings: the school's public address and phone, block-out dates and share calendars. Route identifiers are
 * never authority: the guarded boundary resolves the route scope from the verified session, and each protected database
 * function re-proves the direct human subject and the live school-scoped permission. Nothing here contacts anyone.
 */
@Controller('organizations/:organizationId/schools/:schoolId/schedule/calendar')
@UseGuards(HonIdentityGuard)
export class CalendarSettingsController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly settings: CalendarSettingsService) {}

  @Get('settings')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(CalendarSettingsReadHumanUiGuard)
  async read(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: HonRequest) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, MANAGE, '');
    return { data: await this.settings.read(context), meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Get('block-outs')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(CalendarBlockOutsReadHumanUiGuard)
  async blockOuts(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const keys = Object.keys(query ?? {});
    if (keys.length !== 2 || !keys.includes('from') || !keys.includes('to') || Object.values(query).some(value => typeof value !== 'string')) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    }
    const context = await this.context(request, organizationId, schoolId, READ, '');
    return { data: await this.settings.blockOuts(context, { from: query.from, to: query.to }), meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Post('settings/profile')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(CalendarShareSettingsSaveHumanUiGuard)
  async saveSettings(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: CalendarShareSettingsDto, @Req() request: HonRequest) {
    const context = await this.command(request, organizationId, schoolId, idempotencyKey);
    return this.receipt(context, await this.settings.saveSettings(context, fields(input)));
  }

  @Post('settings/block-outs')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(CalendarBlockOutAddHumanUiGuard)
  async addBlockOut(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: CalendarBlockOutDto, @Req() request: HonRequest) {
    const context = await this.command(request, organizationId, schoolId, idempotencyKey);
    return this.receipt(context, await this.settings.addBlockOut(context, fields(input)));
  }

  @Post('settings/block-outs/:blockOutId/remove')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(CalendarBlockOutRemoveHumanUiGuard)
  async removeBlockOut(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('blockOutId', new ParseUUIDPipe()) blockOutId: string, @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CalendarVersionDto, @Req() request: HonRequest) {
    const context = await this.command(request, organizationId, schoolId, idempotencyKey);
    return this.receipt(context, await this.settings.removeBlockOut(context, blockOutId.toLowerCase(), fields(input)));
  }

  @Post('settings/share-calendars')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(ShareCalendarSaveHumanUiGuard)
  async createShareCalendar(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: ShareCalendarDto, @Req() request: HonRequest) {
    const context = await this.command(request, organizationId, schoolId, idempotencyKey);
    return this.receipt(context, await this.settings.saveShareCalendar(context, null, fields(input)));
  }

  @Post('settings/share-calendars/:shareCalendarId/edit')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(ShareCalendarSaveHumanUiGuard)
  async editShareCalendar(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('shareCalendarId', new ParseUUIDPipe()) shareCalendarId: string, @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: ShareCalendarDto, @Req() request: HonRequest) {
    const context = await this.command(request, organizationId, schoolId, idempotencyKey);
    return this.receipt(context, await this.settings.saveShareCalendar(context, shareCalendarId.toLowerCase(), fields(input)));
  }

  @Post('settings/share-calendars/:shareCalendarId/delete')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(ShareCalendarDeleteHumanUiGuard)
  async deleteShareCalendar(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('shareCalendarId', new ParseUUIDPipe()) shareCalendarId: string, @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CalendarVersionDto, @Req() request: HonRequest) {
    const context = await this.command(request, organizationId, schoolId, idempotencyKey);
    return this.receipt(context, await this.settings.deleteShareCalendar(context, shareCalendarId.toLowerCase(), fields(input)));
  }

  private async command(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string | undefined) {
    this.noQuery(request);
    return this.context(request, organizationId, schoolId, MANAGE, this.key(idempotencyKey));
  }

  private receipt(context: MembershipLifecycleContext, result: { receipt: unknown; replayed: boolean }) {
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

  private async context(request: HonRequest, organizationId: string, schoolId: string, permission: string, idempotencyKey: string): Promise<MembershipLifecycleContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) {
      throw new ForbiddenException({ code: permission === READ ? 'CLASS_SESSIONS_READ_FORBIDDEN' : 'CLASS_SERIES_FORBIDDEN' });
    }
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}

/** 0568 shared calendars: the public side. No session, cookie or tenant id is read; the public link id is the only selector. */
@Controller('public/calendars')
export class PublicShareCalendarController {
  constructor(private readonly settings: CalendarSettingsService) {}

  @Get(':publicId')
  @Header('Cache-Control', 'no-store')
  async published(@Param('publicId') publicId: string) {
    const data = await this.settings.published(publicId);
    if (!data) throw new NotFoundException({ result: 'INVALID' });
    return { data };
  }
}
