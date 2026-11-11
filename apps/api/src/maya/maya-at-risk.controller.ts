import { BadRequestException, ConflictException, Controller, ForbiddenException, Get, Header, Headers, Injectable, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { MayaAtRiskService } from './maya-at-risk.service.js';

/** Browser reads only: no delegated, automated or Action Engine selectors. */
@Injectable()
export class MayaAtRiskReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'retention.at_risk.read';
}

const PERMISSION = 'retention.review.read';

/**
 * Maya M1 (0259): GET the school's students at risk. Route identifiers are never authority: the scope is resolved from
 * the verified session for retention.review.read at the route school, and the database re-proves it.
 */
@Controller('organizations/:organizationId/schools/:schoolId/retention')
@UseGuards(HonIdentityGuard)
export class MayaAtRiskController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly maya: MayaAtRiskService) {}

  @Get('at-risk')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(MayaAtRiskReadHumanUiGuard)
  async list(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Query() query: Record<string, unknown>,
    @Req() request: HonRequest,
  ) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    if (Object.keys(query ?? {}).some(key => key !== 'after') || Object.values(query ?? {}).some(value => typeof value !== 'string')) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    }
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, PERMISSION);
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) {
      throw new ForbiddenException({ code: 'MAYA_AT_RISK_FORBIDDEN' });
    }
    const requestId = randomUUID();
    const context = { ...scope, principalType: 'HUMAN_USER' as const, requestId, correlationId: requestId, idempotencyKey: '', source: 'HUMAN_UI' as const, externalSubject: identity.externalSubject };
    const data = await this.maya.list(context, query.after === undefined ? {} : { after: query.after });
    return { data, meta: { requestId, correlationId: requestId } };
  }
}
