import { BadRequestException, Controller, ForbiddenException, Get, Header, Injectable, Query, Req, UseGuards } from '@nestjs/common';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { ParentAttendanceStreaksService } from './parent-attendance-streaks.service.js';

/** 0602: the attendance streak read is its own human command; GET only. */
@Injectable()
export class ParentAttendanceStreaksReadGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'parent.attendance_streaks.read';
}

/** Parent side: weekly attendance streaks for the signed-in family (flame count on the HON Family app Home screen). */
@Controller('parent/attendance-streaks')
@UseGuards(HonIdentityGuard)
export class ParentAttendanceStreaksController {
  constructor(private readonly streaks: ParentAttendanceStreaksService) {}

  @Get()
  @UseGuards(ParentAttendanceStreaksReadGuard)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async read(@Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    if (Object.keys(query ?? {}).length || request.originalUrl?.includes('?')) throw new BadRequestException({ code: 'ATTENDANCE_STREAKS_SELECTORS_NOT_ACCEPTED' });
    if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    return { data: await this.streaks.read(request.honIdentity.externalSubject) };
  }
}
