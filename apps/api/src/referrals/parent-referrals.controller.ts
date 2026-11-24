import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, HttpCode, Injectable, Post, Query, Req, UseGuards } from '@nestjs/common';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { ParentReferralsService } from './parent-referrals.service.js';

/** 0604: the referral read and the link request are each their own human command. */
@Injectable()
export class ParentReferralsReadGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'parent.referrals.read';
}
@Injectable()
export class ParentReferralLinkGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'parent.referrals.link';
}

function subjectOf(request: HonRequest, query: Record<string, unknown>): string {
  if (Object.keys(query ?? {}).length || request.originalUrl?.includes('?')) throw new BadRequestException({ code: 'PARENT_REFERRALS_SELECTORS_NOT_ACCEPTED' });
  if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
  return request.honIdentity.externalSubject;
}

/** Family side (More > Refer a friend in the HON Family app). Family, school and organization come only from the session. */
@Controller('parent/referrals')
@UseGuards(HonIdentityGuard)
export class ParentReferralsController {
  constructor(private readonly referrals: ParentReferralsService) {}

  @Get()
  @UseGuards(ParentReferralsReadGuard)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async read(@Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    return { data: await this.referrals.read(subjectOf(request, query)) };
  }

  /** The family's personal share link, created the first time (guardians only). Takes no body. */
  @Post('link')
  @HttpCode(200)
  @UseGuards(ParentReferralLinkGuard)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async link(@Query() query: Record<string, unknown>, @Body() body: unknown, @Req() request: HonRequest) {
    if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body) || Object.keys(body as object).length > 0)) {
      throw new BadRequestException({ code: 'PARENT_REFERRALS_SELECTORS_NOT_ACCEPTED' });
    }
    return { data: await this.referrals.link(subjectOf(request, query)) };
  }
}
