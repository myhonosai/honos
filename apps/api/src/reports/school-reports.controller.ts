import { BadRequestException, ConflictException, Controller, ForbiddenException, Get, Header, Headers, Injectable, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { SchoolReportsService } from './school-reports.service.js';

/** R1 (0331): the school reports read is its own same-origin browser read. */
@Injectable()
export class SchoolReportsHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'reporting.school-reports';
}

/**
 * R1 (0331): month by month attendance, enrollment, retention and revenue for one school. Route identifiers are never
 * authority: the scope is resolved from the verified session and the database function re-proves reporting.view.
 */
@Controller('organizations/:organizationId/schools/:schoolId/reports/monthly')
@UseGuards(HonIdentityGuard, SchoolReportsHumanUiGuard)
export class SchoolReportsController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly reports: SchoolReportsService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async read(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    const { context, input } = await this.context(organizationId, schoolId, idempotencyKey, query, request);
    return { data: await this.reports.read(context, input), meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  /** R2 (0332): every location of this organization where the same person may see reports, read from the school in use. */
  @Get('locations')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async locations(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    const { context, input } = await this.context(organizationId, schoolId, idempotencyKey, query, request);
    return { data: await this.reports.readLocations(context, input), meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  private async context(organizationId: string, schoolId: string, idempotencyKey: string | undefined, query: Record<string, unknown>, request: HonRequest) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    if (Object.keys(query ?? {}).some(key => key !== 'months') || Object.values(query ?? {}).some(value => typeof value !== 'string')) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    }
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'reporting.view');
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) {
      throw new ForbiddenException({ code: 'SCHOOL_REPORTS_FORBIDDEN' });
    }
    const requestId = randomUUID();
    const context = { ...scope, principalType: 'HUMAN_USER' as const, requestId, correlationId: requestId, idempotencyKey: '', source: 'HUMAN_UI' as const,
      externalSubject: identity.externalSubject };
    return { context, input: query.months === undefined ? {} : { months: query.months } };
  }
}
