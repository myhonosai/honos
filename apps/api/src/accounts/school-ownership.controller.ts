import { Body, Controller, Get, Headers, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SchoolAccountHumanGuard } from './school-owner-invitation.controller.js';
import { SchoolOwnershipService } from './school-ownership.service.js';

/** B-ID-4: same human-only guard as owner invitations (no query, same-origin, x-hon-human-command: school-owner-account). */
@Controller() @UseGuards(SchoolAccountHumanGuard, HonIdentityGuard)
export class SchoolOwnershipController {
  constructor(private readonly ownership: SchoolOwnershipService) {}
  @Get('hq/schools/:schoolId/ownership')
  hqSchool(@Req() r: HonRequest, @Param('schoolId') s: string) { return this.ownership.hqSchool(r, s).then(data => ({ data })); }
  @Post('hq/school-ownership/primary-owner') @HttpCode(200)
  setPrimary(@Req() r: HonRequest, @Body() b: unknown, @Headers('idempotency-key') k: string) { return this.ownership.setPrimary(r, b, k).then(data => ({ data })); }
  @Get('account/schools/:schoolId/ownership')
  ownerView(@Req() r: HonRequest, @Param('schoolId') s: string) { return this.ownership.ownerView(r, s).then(data => ({ data })); }
}
