import { Body, Controller, Get, Headers, HttpCode, Injectable, Param, Post, Req, UseGuards, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { FAMILY_ACCOUNT_HUMAN_COMMAND } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { assertSchoolAccountHumanRequest } from './school-staff-invitation.controller.js';
import { SchoolFamilyAccessInvitationService } from './school-family-access-invitation.service.js';

/** Same-origin human browser commands only, with their own command header; the database re-checks school and family. */
@Injectable()
export class SchoolFamilyAccountHumanGuard implements CanActivate {
  canActivate(c: ExecutionContext) { return assertSchoolAccountHumanRequest(c,FAMILY_ACCOUNT_HUMAN_COMMAND); }
}

@Controller() @UseGuards(SchoolFamilyAccountHumanGuard,HonIdentityGuard)
export class SchoolFamilyAccessInvitationController {
  constructor(private readonly invitations: SchoolFamilyAccessInvitationService) {}
  @Post('school/family-access-invitations') @HttpCode(200)
  invite(@Req() r: HonRequest,@Body() b: unknown,@Headers('idempotency-key') k: string) { return this.invitations.command(r,'invite',b,k).then(data=>({data})); }
  @Post('school/family-access-invitations/revoke') @HttpCode(200)
  revoke(@Req() r: HonRequest,@Body() b: unknown,@Headers('idempotency-key') k: string) { return this.invitations.command(r,'revoke',b,k).then(data=>({data})); }
  @Post('school/family-access-invitations/end') @HttpCode(200)
  end(@Req() r: HonRequest,@Body() b: unknown,@Headers('idempotency-key') k: string) { return this.invitations.command(r,'end',b,k).then(data=>({data})); }
  @Post('account/family-access-invitations/accept') @HttpCode(200)
  accept(@Req() r: HonRequest,@Body() b: unknown,@Headers('idempotency-key') k: string) { return this.invitations.command(r,'accept',b,k).then(data=>({data})); }
  @Get('school/schools/:schoolId/family-access-invitations')
  list(@Req() r: HonRequest,@Param('schoolId') s: string) { return this.invitations.list(r,s).then(data=>({data})); }
}
