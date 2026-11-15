import { BadRequestException, ConflictException, Controller, ForbiddenException, Get, Header, Headers, Injectable, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { MonthlyGoalPlanService } from './monthly-goal-plan.service.js';

const QUERY_KEYS = new Set(['month', 'goalMinor', 'currency', 'historyMonths', 'bookRate', 'showRate', 'closeRate', 'renewalRate',
  'avgNewMinor', 'plannedUpgrades', 'upgradeValueMinor']);

/** G1 (0370): the monthly goal plan read is its own same-origin browser read. */
@Injectable()
export class MonthlyGoalPlanHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'planning.monthly-goal';
}

/**
 * G1 (0370): a monthly goal broken down into renewals, upgrades, new enrollments, shows, appointments and leads from the
 * school's records, with pace. Route identifiers are never authority: the scope comes from the verified session and the
 * database function re-proves reporting.view.
 */
@Controller('organizations/:organizationId/schools/:schoolId/planning/monthly-goal')
@UseGuards(HonIdentityGuard, MonthlyGoalPlanHumanUiGuard)
export class MonthlyGoalPlanController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly plans: MonthlyGoalPlanService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async read(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    if (Object.keys(query ?? {}).some(key => !QUERY_KEYS.has(key)) || Object.values(query ?? {}).some(value => typeof value !== 'string')) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    }
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'reporting.view');
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) {
      throw new ForbiddenException({ code: 'MONTHLY_GOAL_PLAN_FORBIDDEN' });
    }
    const requestId = randomUUID();
    const context = { ...scope, principalType: 'HUMAN_USER' as const, requestId, correlationId: requestId, idempotencyKey: '', source: 'HUMAN_UI' as const,
      externalSubject: identity.externalSubject };
    return { data: await this.plans.read(context, { ...query }), meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }
}
