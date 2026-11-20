import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Injectable, Post, Query, Req, UseGuards } from '@nestjs/common';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { ParentPushService } from './parent-push.service.js';

/** 0601: registering and letting go of a phone are each their own human command. */
@Injectable()
export class ParentPushRegisterGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'parent.push_device.register';
}
@Injectable()
export class ParentPushUnregisterGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'parent.push_device.unregister';
}
@Injectable()
export class ParentPushStatusGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'parent.push_device.status';
}

function subjectOf(request: HonRequest, query: Record<string, unknown>): string {
  if (Object.keys(query ?? {}).length || request.originalUrl?.includes('?')) throw new BadRequestException({ code: 'PARENT_PUSH_SELECTORS_NOT_ACCEPTED' });
  if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
  return request.honIdentity.externalSubject;
}

/** The signed-in family member's phone. Family, school and organization come only from the verified session. */
@Controller('parent/push-devices')
@UseGuards(HonIdentityGuard)
export class ParentPushController {
  constructor(private readonly push: ParentPushService) {}

  /** Whether this server sends notifications at all, so the app asks for permission only when they would arrive. */
  @Get('status')
  @UseGuards(ParentPushStatusGuard)
  @Header('Cache-Control', 'private, no-store')
  status(@Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    subjectOf(request, query);
    return { data: this.push.status() };
  }

  @Post()
  @HttpCode(200)
  @UseGuards(ParentPushRegisterGuard)
  @Header('Cache-Control', 'private, no-store')
  async register(@Query() query: Record<string, unknown>, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    return { data: await this.push.register(subjectOf(request, query), body, key ?? '') };
  }

  @Post('unregister')
  @HttpCode(200)
  @UseGuards(ParentPushUnregisterGuard)
  @Header('Cache-Control', 'private, no-store')
  async unregister(@Query() query: Record<string, unknown>, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    return { data: await this.push.unregister(subjectOf(request, query), body, key ?? '') };
  }
}
