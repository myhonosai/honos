import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { OperationsReportQueryDto } from './operations-report.dto.js';
import { OperationsReportService } from './operations-report.service.js';

@Controller('organizations/:organizationId/schools/:schoolId/reports/operations')
@UseGuards(HonIdentityGuard)
export class OperationsReportController {
  constructor(
    private readonly database: RuntimeDatabaseService,
    private readonly reports: OperationsReportService,
  ) {}

  @Get()
  async read(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: OperationsReportQueryDto,
    @Req() request: HonRequest,
  ) {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');

    // Route identifiers are not authority. The SECURITY DEFINER resolver derives
    // the live human principal and tenant scope from the verified session identity.
    const scope = await this.database.resolveAuthorizedScope(
      identity.externalSubject,
      schoolId,
      'reporting.view',
    );
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) {
      throw new ForbiddenException('HON operations reporting is not authorized for this school.');
    }

    const requestId = randomUUID();
    const operationalSnapshot = await this.reports.read({
      ...scope,
      principalType: 'HUMAN_USER',
      requestId,
    }, query);
    return {
      data: { operationalSnapshot },
      meta: { requestId, correlationId: requestId },
    };
  }
}
