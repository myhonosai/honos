import { Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { RuntimeDatabaseService } from './runtime-database.service.js';
import { HonIdentityGuard } from './hon-identity.guard.js';
import type { HonRequest } from './manus-identity.service.js';

@Controller('organizations/:organizationId/schools/:schoolId')
@UseGuards(HonIdentityGuard)
export class SessionContextController {
  constructor(private readonly database: RuntimeDatabaseService) {}

  @Get('session-context')
  async sessionContext(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Req() request: HonRequest,
  ): Promise<{ principalId: string; organizationId: string; schoolId: string }> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');

    const scope = await this.database.resolveAuthorizedScope(
      identity.externalSubject,
      schoolId,
      'school.view',
    );
    if (!scope || scope.organizationId !== organizationId) {
      throw new ForbiddenException('HON school scope is not authorized.');
    }

    return scope;
  }
}
