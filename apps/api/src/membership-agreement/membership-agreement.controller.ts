import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Injectable, NotFoundException, Param, Post, Query, Req, Res, UseGuards, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Response } from 'express';
import { FAMILY_MEMBERSHIP_AGREEMENT_SIGN_COMMAND, FAMILY_PERSON_PHOTO_COMMAND, MEMBERSHIP_AGREEMENT_HUMAN_COMMAND, MEMBERSHIP_AGREEMENT_LINK_COMMAND } from '@hon/contracts';
import { assertSchoolAccountHumanRequest } from '../accounts/school-staff-invitation.controller.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { MembershipAgreementService } from './membership-agreement.service.js';

/** 0463: same-origin human browser requests only, with the agreement's own command header; never cached. */
@Injectable()
export class MembershipAgreementHumanGuard implements CanActivate {
  canActivate(c: ExecutionContext) { return assertSchoolAccountHumanRequest(c, MEMBERSHIP_AGREEMENT_HUMAN_COMMAND); }
}
/** 0499: staff sending a signing link use their own command header. */
@Injectable()
export class MembershipAgreementLinkHumanGuard implements CanActivate {
  canActivate(c: ExecutionContext) { return assertSchoolAccountHumanRequest(c, MEMBERSHIP_AGREEMENT_LINK_COMMAND); }
}
/** Parent-portal guards: never cached (refusals included), then the same-origin human browser checks. */
function noStore(c: ExecutionContext) {
  const s = c.switchToHttp().getResponse<{ setHeader(name: string, value: string): void }>();
  s.setHeader('Cache-Control', 'private, no-store'); s.setHeader('Referrer-Policy', 'no-referrer');
}
@Injectable()
export class FamilyMembershipAgreementSignGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = FAMILY_MEMBERSHIP_AGREEMENT_SIGN_COMMAND;
  override canActivate(c: ExecutionContext): boolean { noStore(c); return super.canActivate(c); }
}
@Injectable()
export class FamilyPersonPhotoGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = FAMILY_PERSON_PHOTO_COMMAND;
  override canActivate(c: ExecutionContext): boolean { noStore(c); return super.canActivate(c); }
}

@Controller() @UseGuards(MembershipAgreementHumanGuard, HonIdentityGuard)
export class MembershipAgreementController {
  constructor(private readonly agreement: MembershipAgreementService) {}
  @Get('school/schools/:schoolId/membership-agreement')
  read(@Req() r: HonRequest, @Param('schoolId') s: string) { return this.agreement.read(r, s).then(data => ({ data })); }
  @Post('school/membership-agreement/draft') @HttpCode(200)
  draft(@Req() r: HonRequest, @Body() b: unknown, @Headers('idempotency-key') k: string) { return this.agreement.saveDraft(r, b, k).then(data => ({ data })); }
  @Post('school/membership-agreement/publish') @HttpCode(200)
  publish(@Req() r: HonRequest, @Body() b: unknown, @Headers('idempotency-key') k: string) { return this.agreement.publish(r, b, k).then(data => ({ data })); }
}

function noSelectors(request: HonRequest, query: Record<string, unknown>): string {
  if (Object.keys(query).length || request.originalUrl?.includes('?')) throw new BadRequestException({ code: 'MEMBERSHIP_AGREEMENT_SELECTORS_NOT_ACCEPTED' });
  if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
  return request.honIdentity.externalSubject;
}

/** Parent portal: the family comes only from the parent's one live family grant; the read is GET only. */
@Controller('parent')
export class FamilyMembershipAgreementController {
  constructor(private readonly agreement: MembershipAgreementService) {}

  @Get('membership-agreement')
  @UseGuards(FamilyMembershipAgreementSignGuard, HonIdentityGuard)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async read(@Query() q: Record<string, unknown>, @Req() r: HonRequest) { return { data: await this.agreement.familyRead(noSelectors(r, q)) }; }

  @Post('membership-agreement/sign') @HttpCode(200)
  @UseGuards(FamilyMembershipAgreementSignGuard, HonIdentityGuard)
  @Header('Cache-Control', 'private, no-store')
  async sign(@Query() q: Record<string, unknown>, @Body() b: unknown, @Headers('idempotency-key') k: string | undefined, @Req() r: HonRequest) {
    return { data: await this.agreement.familySign(noSelectors(r, q), b, k) };
  }

  @Post('person-photo/set') @HttpCode(200)
  @UseGuards(FamilyPersonPhotoGuard, HonIdentityGuard)
  @Header('Cache-Control', 'private, no-store')
  async setPhoto(@Query() q: Record<string, unknown>, @Body() b: unknown, @Headers('idempotency-key') k: string | undefined, @Req() r: HonRequest) {
    return { data: await this.agreement.familyPhotoSet(noSelectors(r, q), b, k) };
  }

  @Post('person-photo/remove') @HttpCode(200)
  @UseGuards(FamilyPersonPhotoGuard, HonIdentityGuard)
  @Header('Cache-Control', 'private, no-store')
  async removePhoto(@Query() q: Record<string, unknown>, @Body() b: unknown, @Headers('idempotency-key') k: string | undefined, @Req() r: HonRequest) {
    return { data: await this.agreement.familyPhotoRemove(noSelectors(r, q), b, k) };
  }
}

/** 0499: staff read who can receive a link for one student's family, and send a new link by email and/or text. */
@Controller() @UseGuards(MembershipAgreementLinkHumanGuard, HonIdentityGuard)
export class MembershipAgreementLinkController {
  constructor(private readonly agreement: MembershipAgreementService) {}
  @Get('school/schools/:schoolId/people/:personId/membership-agreement-link')
  @Header('Cache-Control', 'private, no-store')
  read(@Req() r: HonRequest, @Param('schoolId') s: string, @Param('personId') p: string) { return this.agreement.sendRead(r, s, p).then(data => ({ data })); }
  @Post('school/membership-agreement-link/send') @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  send(@Req() r: HonRequest, @Body() b: unknown, @Headers('idempotency-key') k: string) { return this.agreement.sendLink(r, b, k).then(data => ({ data })); }
}

/** 0499: the family's signing link. No account, cookie or tenant id is read: the random token in the link is the only key. */
@Controller('public/membership-agreement-links')
export class PublicMembershipAgreementLinkController {
  constructor(private readonly agreement: MembershipAgreementService) {}

  @Get(':token')
  @Header('Cache-Control', 'no-store') @Header('Referrer-Policy', 'no-referrer') @Header('X-Robots-Tag', 'noindex')
  async read(@Param('token') token: string) {
    const data = await this.agreement.linkRead(token);
    if (!data) throw new NotFoundException({ result: 'GONE' });
    return { data };
  }

  @Post(':token/sign')
  @Header('Cache-Control', 'no-store') @Header('Referrer-Policy', 'no-referrer')
  async sign(@Param('token') token: string, @Body() body: unknown, @Res() res: Response) {
    const result = await this.agreement.linkSign(token, body);
    const status = { SIGNED: 201, ALREADY_SIGNED: 200, CHANGED: 409, INVALID: 400, GONE: 410, UNAVAILABLE: 503 }[result];
    return res.status(status).json({ result });
  }
}
