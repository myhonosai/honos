import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isStaffShiftWeekStart } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { SaveTimeEntryDto, TimeClockPunchDto, TimesheetDecisionDto } from './staff-time.dto.js';
import { StaffTimeEntrySaveHumanUiGuard, StaffTimePunchHumanUiGuard, StaffTimeReadHumanUiGuard, StaffTimesheetDecideHumanUiGuard } from './staff-time-human-ui.guard.js';
import { StaffTimeService } from './staff-time.service.js';

const CLOCK = 'staff.time.clock';
const MANAGE = 'staff.timesheet.manage';

function definedFields(input: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value !== undefined));
}

/**
 * 0468: the staff time clock and timesheets. Route identifiers are never authority: the boundary resolves the route scope
 * from the verified session, and each protected database function re-proves the direct human subject and the live
 * permission (staff.time.clock for one's own clock, staff.timesheet.manage for everyone's week). Punches use the database
 * clock. Nothing here messages staff, pays anyone or calculates pay.
 */
@Controller('organizations/:organizationId/schools/:schoolId/staff/time')
@UseGuards(HonIdentityGuard)
export class StaffTimeController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly time: StaffTimeService) {}

  @Get('clock')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(StaffTimeReadHumanUiGuard)
  async clock(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HonRequest,
  ) {
    this.readOnly(request, idempotencyKey);
    const context = await this.context(request, organizationId, schoolId, '', CLOCK);
    const data = await this.time.myClock(context);
    return { data, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Post('clock')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(StaffTimePunchHumanUiGuard)
  async punch(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: TimeClockPunchDto,
    @Req() request: HonRequest,
  ) {
    const context = await this.context(request, organizationId, schoolId, this.key(request, idempotencyKey), CLOCK);
    const result = await this.time.punch(context, definedFields(input));
    return { data: result.entry, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  @Get('weeks/:weekStart')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(StaffTimeReadHumanUiGuard)
  async week(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('weekStart') weekStart: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HonRequest,
  ) {
    this.readOnly(request, idempotencyKey);
    if (!isStaffShiftWeekStart(weekStart)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const context = await this.context(request, organizationId, schoolId, '', MANAGE);
    const data = await this.time.timesheet(context, weekStart);
    return { data, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Post('entries')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(StaffTimeEntrySaveHumanUiGuard)
  async saveEntry(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: SaveTimeEntryDto,
    @Req() request: HonRequest,
  ) {
    const context = await this.context(request, organizationId, schoolId, this.key(request, idempotencyKey), MANAGE);
    const result = await this.time.saveEntry(context, definedFields(input));
    return { data: result.entry, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  @Post('weeks')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(StaffTimesheetDecideHumanUiGuard)
  async decide(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: TimesheetDecisionDto,
    @Req() request: HonRequest,
  ) {
    const context = await this.context(request, organizationId, schoolId, this.key(request, idempotencyKey), MANAGE);
    const result = await this.time.decide(context, definedFields(input));
    return { data: result.approval, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  private readOnly(request: HonRequest, idempotencyKey: string | undefined): void {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    this.noQuery(request);
  }

  private key(request: HonRequest, idempotencyKey: string | undefined): string {
    this.noQuery(request);
    const key = idempotencyKey?.trim();
    if (!key || key.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    return key;
  }

  private noQuery(request: HonRequest): void {
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  }

  /** The session must hold the permission at exactly this route's school; the database decides again. */
  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string, permission: string): Promise<MembershipLifecycleContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) {
      throw new ForbiddenException({ code: 'STAFF_TIME_FORBIDDEN' });
    }
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
