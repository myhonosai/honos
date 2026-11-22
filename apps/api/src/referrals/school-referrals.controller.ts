import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Injectable, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { SchoolReferralsService } from './school-referrals.service.js';

@Injectable()
export class SchoolReferralsReadGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'crm.referrals.read';
}
@Injectable()
export class SchoolReferralProgramGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'crm.referrals.program.save';
}
@Injectable()
export class SchoolReferralRewardGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'crm.referrals.reward';
}

/**
 * 0604 staff side of family referrals. Route identifiers are never authority: the scope comes from the verified session and
 * each database function re-proves the direct human subject and the live crm.referral.* permission.
 */
@Controller('organizations/:organizationId/schools/:schoolId/marketing/referrals')
@UseGuards(HonIdentityGuard)
export class SchoolReferralsController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly referrals: SchoolReferralsService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolReferralsReadGuard)
  async read(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: HonRequest) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(request, organizationId, schoolId, '', 'crm.referral.read');
    return { data: await this.referrals.read(context), meta: { requestId: context.requestId } };
  }

  @Post('program')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolReferralProgramGuard)
  async configure(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, idempotencyKey?.trim() ?? '', 'crm.referral.manage');
    const result = await this.referrals.configure(context, input);
    return { data: result.program, meta: { requestId: context.requestId, replayed: result.replayed } };
  }

  @Post(':referralId/reward')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolReferralRewardGuard)
  async reward(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('referralId', new ParseUUIDPipe()) referralId: string, @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, idempotencyKey?.trim() ?? '', 'crm.referral.manage');
    const result = await this.referrals.reward(context, referralId.toLowerCase(), input);
    return { data: result.referral, meta: { requestId: context.requestId, replayed: result.replayed } };
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string, permission: string): Promise<MembershipLifecycleContext> {
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException({ code: 'SCHOOL_REFERRAL_FORBIDDEN' });
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) {
      throw new ForbiddenException({ code: 'SCHOOL_REFERRAL_FORBIDDEN' });
    }
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
