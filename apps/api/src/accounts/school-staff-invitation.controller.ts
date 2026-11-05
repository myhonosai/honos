import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, Injectable, Param, Post, Req, ServiceUnavailableException, UseGuards, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { configuredPublicOrigin } from '@hon/auth';
import { STAFF_ACCOUNT_HUMAN_COMMAND } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { assertHqEntitlementHumanRequest } from '../hq/hq-entitlement.dto.js';
import { SchoolStaffInvitationService } from './school-staff-invitation.service.js';

/** Same-origin human browser commands only; the school and role are checked again by the database. */
@Injectable()
export class SchoolStaffAccountHumanGuard implements CanActivate {
  canActivate(c: ExecutionContext) {
    const r=c.switchToHttp().getRequest<HonRequest>(); const s=c.switchToHttp().getResponse();
    s.setHeader('Cache-Control','private, no-store'); s.setHeader('Referrer-Policy','no-referrer');
    assertHqEntitlementHumanRequest(r);
    if(r.headers.authorization||Object.keys(r.headers).some(k=>k.startsWith('x-hon-')&&k!=='x-hon-human-command')) throw new ForbiddenException({code:'HUMAN_UI_REQUIRED'});
    if(r.originalUrl?.includes('?')||Object.keys(r.query??{}).length) throw new BadRequestException({code:'ACCOUNT_INPUT_INVALID'});
    if(r.method==='GET') { if(r.headers['sec-fetch-site']&&r.headers['sec-fetch-site']!=='same-origin') throw new ForbiddenException({code:'HUMAN_UI_REQUIRED'}); return true; }
    let origin: string | undefined; try { origin=configuredPublicOrigin(process.env); } catch { throw new ServiceUnavailableException({code:'HUMAN_UI_ORIGIN_NOT_CONFIGURED'}); }
    if(!origin||r.method!=='POST'||r.headers.origin!==origin||r.headers['sec-fetch-site']!=='same-origin'||r.headers['sec-fetch-mode']!=='same-origin'
      ||r.headers['sec-fetch-dest']!=='empty'||r.headers['sec-fetch-user']!==undefined||r.headers['x-hon-human-command']!==STAFF_ACCOUNT_HUMAN_COMMAND
      ||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(r.headers['content-type']??'')) throw new ForbiddenException({code:'HUMAN_UI_REQUIRED'});
    return true;
  }
}

@Controller() @UseGuards(SchoolStaffAccountHumanGuard,HonIdentityGuard)
export class SchoolStaffInvitationController {
  constructor(private readonly invitations: SchoolStaffInvitationService) {}
  @Post('school/staff-invitations') @HttpCode(200)
  invite(@Req() r: HonRequest,@Body() b: unknown,@Headers('idempotency-key') k: string) { return this.invitations.command(r,'invite',b,k).then(data=>({data})); }
  @Post('school/staff-invitations/revoke') @HttpCode(200)
  revoke(@Req() r: HonRequest,@Body() b: unknown,@Headers('idempotency-key') k: string) { return this.invitations.command(r,'revoke',b,k).then(data=>({data})); }
  @Post('account/staff-invitations/accept') @HttpCode(200)
  accept(@Req() r: HonRequest,@Body() b: unknown,@Headers('idempotency-key') k: string) { return this.invitations.command(r,'accept',b,k).then(data=>({data})); }
  @Get('school/schools/:schoolId/staff-invitations')
  list(@Req() r: HonRequest,@Param('schoolId') s: string) { return this.invitations.list(r,s).then(data=>({data})); }
}
