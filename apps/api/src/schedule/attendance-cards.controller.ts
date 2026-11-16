import { Body, Controller, Get, Headers, HttpCode, Injectable, Param, Post, Req, UseGuards, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { ATTENDANCE_CARDS_HUMAN_COMMAND, ATTENDANCE_SCAN_HUMAN_COMMAND } from '@hon/contracts';
import { assertSchoolAccountHumanRequest } from '../accounts/school-staff-invitation.controller.js';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { AttendanceCardsService } from './attendance-cards.service.js';

/** 0394: same-origin human browser requests only, each command with its own header; never cached. */
@Injectable()
export class AttendanceCardsHumanGuard implements CanActivate {
  canActivate(c: ExecutionContext) { return assertSchoolAccountHumanRequest(c, ATTENDANCE_CARDS_HUMAN_COMMAND); }
}
@Injectable()
export class AttendanceScanHumanGuard implements CanActivate {
  canActivate(c: ExecutionContext) { return assertSchoolAccountHumanRequest(c, ATTENDANCE_SCAN_HUMAN_COMMAND); }
}

@Controller() @UseGuards(AttendanceCardsHumanGuard, HonIdentityGuard)
export class AttendanceCardsController {
  constructor(private readonly cards: AttendanceCardsService) {}
  @Get('school/schools/:schoolId/attendance/cards')
  read(@Req() r: HonRequest, @Param('schoolId') s: string) { return this.cards.read(r, s).then(data => ({ data })); }
  @Post('school/attendance/cards/settings') @HttpCode(200)
  configure(@Req() r: HonRequest, @Body() b: unknown, @Headers('idempotency-key') k: string) { return this.cards.configure(r, b, k).then(data => ({ data })); }
  @Post('school/attendance/cards/print') @HttpCode(200)
  issue(@Req() r: HonRequest, @Body() b: unknown, @Headers('idempotency-key') k: string) { return this.cards.issue(r, b, k).then(data => ({ data })); }
  @Post('school/attendance/cards/cancel') @HttpCode(200)
  revoke(@Req() r: HonRequest, @Body() b: unknown, @Headers('idempotency-key') k: string) { return this.cards.revoke(r, b, k).then(data => ({ data })); }
  @Post('school/attendance/cards/photo-consent') @HttpCode(200)
  photoConsent(@Req() r: HonRequest, @Body() b: unknown, @Headers('idempotency-key') k: string) { return this.cards.photoConsent(r, b, k).then(data => ({ data })); }
}

@Controller() @UseGuards(AttendanceScanHumanGuard, HonIdentityGuard)
export class AttendanceScanController {
  constructor(private readonly cards: AttendanceCardsService) {}
  @Post('school/attendance/check-in') @HttpCode(200)
  checkIn(@Req() r: HonRequest, @Body() b: unknown, @Headers('idempotency-key') k: string) { return this.cards.checkIn(r, b, k).then(data => ({ data })); }
}
