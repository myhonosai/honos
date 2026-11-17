import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Injectable, Param, Post, Query, Req, UseGuards, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { FAMILY_MEMBERSHIP_AGREEMENT_SIGN_COMMAND, FAMILY_PERSON_PHOTO_COMMAND, MEMBERSHIP_AGREEMENT_HUMAN_COMMAND } from '@hon/contracts';
import { assertSchoolAccountHumanRequest } from '../accounts/school-staff-invitation.controller.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { MembershipAgreementService } from './membership-agreement.service.js';

/** 0454: same-origin human browser requests only, with the agreement's own command header; never cached. */
@Injectable()
export class MembershipAgreementHumanGuard implements CanActivate {
  canActivate(c: ExecutionContext) { return assertSchoolAccountHumanRequest(c, MEMBERSHIP_AGREEMENT_HUMAN_COMMAND); }
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
