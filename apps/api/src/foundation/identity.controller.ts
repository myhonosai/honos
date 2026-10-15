import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { HonIdentityGuard } from './hon-identity.guard.js';
import type { HonRequest } from './manus-identity.service.js';

@Controller('identity')
@UseGuards(HonIdentityGuard)
export class IdentityController {
  @Get('me')
  me(@Req() request: HonRequest) {
    return { data: { externalSubject: request.honIdentity?.externalSubject } };
  }
}
