import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Injectable, Param, Post, Query, Req, UseGuards, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { FACE_CHECKIN_HUMAN_COMMAND, FACE_CHECKIN_SCAN_COMMAND, FAMILY_FACE_CHECKIN_COMMAND, FAMILY_FACE_CHECKIN_WITHDRAW_COMMAND } from '@hon/contracts';
import { assertSchoolAccountHumanRequest } from '../accounts/school-staff-invitation.controller.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { FaceCheckInService } from './face-checkin.service.js';

/** 0443: same-origin human browser requests only, managing and scanning each with their own command header; never cached. */
@Injectable()
export class FaceCheckInHumanGuard implements CanActivate {
  canActivate(c: ExecutionContext) { return assertSchoolAccountHumanRequest(c, FACE_CHECKIN_HUMAN_COMMAND); }
}
@Injectable()
export class FaceCheckInScanHumanGuard implements CanActivate {
  canActivate(c: ExecutionContext) { return assertSchoolAccountHumanRequest(c, FACE_CHECKIN_SCAN_COMMAND); }
}
/** Parent-portal guards: never cached (refusals included), then the same-origin human browser checks. */
function noStore(c: ExecutionContext) {
  const s = c.switchToHttp().getResponse<{ setHeader(name: string, value: string): void }>();
  s.setHeader('Cache-Control', 'private, no-store'); s.setHeader('Referrer-Policy', 'no-referrer');
}
@Injectable()
export class FamilyFaceCheckInSignGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = FAMILY_FACE_CHECKIN_COMMAND;
  override canActivate(c: ExecutionContext): boolean { noStore(c); return super.canActivate(c); }
}
@Injectable()
export class FamilyFaceCheckInWithdrawGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = FAMILY_FACE_CHECKIN_WITHDRAW_COMMAND;
  override canActivate(c: ExecutionContext): boolean { noStore(c); return super.canActivate(c); }
}

@Controller() @UseGuards(FaceCheckInHumanGuard, HonIdentityGuard)
export class FaceCheckInController {
  constructor(private readonly face: FaceCheckInService) {}
  @Get('school/schools/:schoolId/face-check-in')
  read(@Req() r: HonRequest, @Param('schoolId') s: string) { return this.face.read(r, s).then(data => ({ data })); }
  @Post('school/face-check-in/settings') @HttpCode(200)
  settings(@Req() r: HonRequest, @Body() b: unknown, @Headers('idempotency-key') k: string) { return this.face.saveSettings(r, b, k).then(data => ({ data })); }
  @Post('school/face-check-in/consent') @HttpCode(200)
  consent(@Req() r: HonRequest, @Body() b: unknown, @Headers('idempotency-key') k: string) { return this.face.recordConsent(r, b, k).then(data => ({ data })); }
  @Post('school/face-check-in/withdraw') @HttpCode(200)
  withdraw(@Req() r: HonRequest, @Body() b: unknown, @Headers('idempotency-key') k: string) { return this.face.withdrawConsent(r, b, k).then(data => ({ data })); }
  @Post('school/face-check-in/enroll') @HttpCode(200)
  enroll(@Req() r: HonRequest, @Body() b: unknown, @Headers('idempotency-key') k: string) { return this.face.enroll(r, b, k).then(data => ({ data })); }
}

@Controller() @UseGuards(FaceCheckInScanHumanGuard, HonIdentityGuard)
export class FaceCheckInScanController {
  constructor(private readonly face: FaceCheckInService) {}
  @Post('school/face-check-in/match') @HttpCode(200)
  match(@Req() r: HonRequest, @Body() b: unknown, @Headers('idempotency-key') k: string) { return this.face.match(r, b, k).then(data => ({ data })); }
  @Post('school/face-check-in/confirm') @HttpCode(200)
  confirm(@Req() r: HonRequest, @Body() b: unknown, @Headers('idempotency-key') k: string) { return this.face.confirm(r, b, k).then(data => ({ data })); }
}

function noSelectors(request: HonRequest, query: Record<string, unknown>): string {
  if (Object.keys(query).length || request.originalUrl?.includes('?')) throw new BadRequestException({ code: 'FACE_CHECKIN_SELECTORS_NOT_ACCEPTED' });
  if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
  return request.honIdentity.externalSubject;
}

/** Parent portal: the family comes only from the parent's one live family grant; the read is GET only. */
@Controller('parent/face-check-in')
export class FamilyFaceCheckInController {
  constructor(private readonly face: FaceCheckInService) {}

  @Get()
  @UseGuards(FamilyFaceCheckInSignGuard, HonIdentityGuard)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async read(@Query() q: Record<string, unknown>, @Req() r: HonRequest) { return { data: await this.face.familyRead(noSelectors(r, q)) }; }

  @Post('sign') @HttpCode(200)
  @UseGuards(FamilyFaceCheckInSignGuard, HonIdentityGuard)
  @Header('Cache-Control', 'private, no-store')
  async sign(@Query() q: Record<string, unknown>, @Body() b: unknown, @Headers('idempotency-key') k: string | undefined, @Req() r: HonRequest) {
    return { data: await this.face.familySign(noSelectors(r, q), b, k) };
  }

  @Post('withdraw') @HttpCode(200)
  @UseGuards(FamilyFaceCheckInWithdrawGuard, HonIdentityGuard)
  @Header('Cache-Control', 'private, no-store')
  async withdraw(@Query() q: Record<string, unknown>, @Body() b: unknown, @Headers('idempotency-key') k: string | undefined, @Req() r: HonRequest) {
    return { data: await this.face.familyWithdraw(noSelectors(r, q), b, k) };
  }
}
