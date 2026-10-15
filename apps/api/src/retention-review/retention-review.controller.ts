import { BadRequestException, Controller, ForbiddenException, Get, Header, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { RetentionReviewSignalsContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { RetentionReviewHumanUiGuard } from './retention-review.dto.js';
import { RetentionReviewService, retentionReviewId } from './retention-review.service.js';

@Controller('staff/retention/review')
@UseGuards(HonIdentityGuard, RetentionReviewHumanUiGuard)
export class RetentionReviewController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly retention: RetentionReviewService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async read(@Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    if (!query || Object.keys(query).length !== 2 || !Object.hasOwn(query, 'schoolId') || !Object.hasOwn(query, 'membershipId')) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Only known schoolId and membershipId selectors are accepted.' });
    }
    retentionReviewId(query.schoolId); retentionReviewId(query.membershipId);
    if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    const externalSubject = request.honIdentity.externalSubject;
    const scope = await this.database.resolveRetentionReviewScope(externalSubject, query.schoolId);
    if (!scope) throw new ForbiddenException({ code: 'RETENTION_REVIEW_SCOPE_DENIED' });
    const requestId = randomUUID();
    const context: RetentionReviewSignalsContext = {
      ...scope,
      externalSubject,
      principalType: 'HUMAN_USER',
      source: 'HUMAN_UI',
      requestId,
      correlationId: requestId,
    };
    return { data: { retentionReviewSignals: await this.retention.read(context, query.membershipId) }, meta: { requestId, correlationId: requestId } };
  }
}
