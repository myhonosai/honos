import { Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { OperationsReportQueryDto } from './operations-report.dto.js';
import { OperationsSummaryService } from './operations-summary.service.js';

@Controller('organizations/:organizationId/operations/summary')
@UseGuards(HonIdentityGuard)
export class OperationsSummaryController {
  constructor(private readonly summaries: OperationsSummaryService) {}

  @Get()
  async read(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Query() query: OperationsReportQueryDto,
    @Req() request: HonRequest,
  ) {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException({ code: 'OPERATIONS_SUMMARY_FORBIDDEN', detail: 'Verified HON identity is required.' });
    // Neither a selected school nor client tier/principal is authority. The fixed
    // projection resolves ALL permitted schools and the live tier itself.
    const operationsSummary = await this.summaries.read(identity.externalSubject, organizationId, query);
    const requestId = randomUUID();
    return { data: { operationsSummary }, meta: { requestId, correlationId: requestId } };
  }
}
