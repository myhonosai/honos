import { Controller, ForbiddenException, Get, Req, UseGuards } from '@nestjs/common';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

@Controller('hq')
@UseGuards(HonIdentityGuard)
export class HqController {
  constructor(private readonly database: RuntimeDatabaseService) {}

  @Get('session')
  async session(@Req() request: HonRequest) {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveHqOperatorScope(identity.externalSubject, 'hq.dashboard.view');
    if (!scope) throw new ForbiddenException('HON HQ access is not provisioned for this account.');
    return { data: scope };
  }
}
