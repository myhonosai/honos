import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isStaffShiftWeekStart } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { SaveStaffShiftDto } from './staff-shifts.dto.js';
import { StaffShiftReadHumanUiGuard, StaffShiftSaveHumanUiGuard } from './staff-shifts-human-ui.guard.js';
import { StaffShiftService } from './staff-shifts.service.js';

const MANAGE = 'staff.shift.manage';
const VIEW_OWN = 'staff.shift.view_own';

function definedFields(input: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value !== undefined));
}

/**
 * 0467: the staff shift schedule. Route identifiers are never authority: the boundary resolves the route scope from the
 * verified session, and each protected database function re-proves the direct human subject and the live permission
 * (staff.shift.manage, or staff.shift.view_own for one's own week). Nothing here messages staff or pays anyone.
 */
@Controller('organizations/:organizationId/schools/:schoolId/staff/shifts')
@UseGuards(HonIdentityGuard)
export class StaffShiftController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly shifts: StaffShiftService) {}

  @Get('weeks/:weekStart')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(StaffShiftReadHumanUiGuard)
  async week(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('weekStart') weekStart: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HonRequest,
  ) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    this.noQuery(request);
    if (!isStaffShiftWeekStart(weekStart)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const context = await this.context(request, organizationId, schoolId, '', [MANAGE, VIEW_OWN]);
    const data = await this.shifts.week(context, weekStart);
    return { data, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(StaffShiftSaveHumanUiGuard)
  async save(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: SaveStaffShiftDto,
    @Req() request: HonRequest,
  ) {
    this.noQuery(request);
    const key = idempotencyKey?.trim();
    if (!key || key.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    const context = await this.context(request, organizationId, schoolId, key, [MANAGE]);
    const result = await this.shifts.save(context, definedFields(input));
    return { data: result.shift, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  private noQuery(request: HonRequest): void {
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  }

  /** The first permission the session holds at exactly this route's school; the database decides again. */
  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string, permissions: readonly string[]): Promise<MembershipLifecycleContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    for (const permission of permissions) {
      const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
      if (!scope) continue;
      if (scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) break;
      const requestId = randomUUID();
      return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
    }
    throw new ForbiddenException({ code: 'STAFF_SHIFT_FORBIDDEN' });
  }
}
