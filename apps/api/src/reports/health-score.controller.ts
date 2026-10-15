import { BadRequestException, Controller, ForbiddenException, Get, Header, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { HealthScoreService } from './health-score.service.js';
import { HealthScoreQueryDto } from './health-score.dto.js';

@Controller('organizations/:organizationId/schools/:schoolId/health-score')
@UseGuards(HonIdentityGuard)
export class HealthScoreController {
  constructor(private readonly healthScore: HealthScoreService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async read(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: HealthScoreQueryDto,
    @Req() request: HonRequest,
  ) {
    // No client can provide a formula version, window, tier, principal, action,
    // source, or scope override. Fixed SQL independently authorizes selectors.
    if (Object.keys(query).length) throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'School Health Score does not accept query parameters.' });
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException({ code: 'SCHOOL_HEALTH_SCORE_FORBIDDEN', detail: 'Verified HON identity is required.' });
    const healthScore = await this.healthScore.read(identity.externalSubject, organizationId, schoolId);
    const requestId = randomUUID();
    return { data: { healthScore }, meta: { requestId, correlationId: requestId } };
  }
}
