import { BadRequestException, Controller, ForbiddenException, Get, Header, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { CommandCenterService } from './command-center.service.js';
import { CommandCenterQueryDto } from './command-center.dto.js';

@Controller('organizations/:organizationId/schools/:schoolId/command-center')
@UseGuards(HonIdentityGuard)
export class CommandCenterController {
  constructor(private readonly commandCenter: CommandCenterService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async read(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: CommandCenterQueryDto,
    @Req() request: HonRequest,
  ) {
    // The endpoint accepts no date/tier/principal/action/scope override. Known
    // IDs select the projection only; the SQL boundary independently authorizes.
    if (Object.keys(query).length) throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Command Center does not accept query parameters.' });
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException({ code: 'COMMAND_CENTER_FORBIDDEN', detail: 'Verified HON identity is required.' });
    const commandCenter = await this.commandCenter.read(identity.externalSubject, organizationId, schoolId);
    const requestId = randomUUID();
    return { data: { commandCenter }, meta: { requestId, correlationId: requestId } };
  }
}
