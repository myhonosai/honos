import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import {
  MembershipPauseHumanUiGuard,
  MembershipPausePolicyHumanUiGuard,
  MembershipPauseReadHumanUiGuard,
  MembershipRefundRecordHumanUiGuard,
  MembershipResumeHumanUiGuard,
} from './membership-activation-human-ui.guard.js';
import { PauseMembershipDto, RecordMembershipRefundDto, ResumeMembershipDto, SetSchoolMembershipPausePolicyDto } from './membership-pause.dto.js';
import { MembershipPauseService } from './membership-pause.service.js';
import type { MembershipLifecycleContext } from './membership.service.js';

const PAUSE = 'billing.membership.pause';
const POLICY = 'billing.membership.pause_policy.manage';
const REFUND = 'billing.membership.refund.record';
/** Any one of these, live at the route school, admits the matching read (the database re-checks the same set). */
const POLICY_READ = [PAUSE, POLICY, 'billing.membership.read'] as const;
const HISTORY_READ = ['billing.membership.read', PAUSE, REFUND] as const;

/** DTO instances may carry declared-but-absent fields as undefined; JSON bodies never do. */
function definedFields(input: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value !== undefined));
}

/**
 * Membership pause, resume and manual refund records (0224). Route identifiers are never authority: the guarded
 * boundary resolves the route scope from the verified session, and each protected database function re-proves the
 * direct human subject and the live school-scoped permission. No payment, schedule, invoice, provider refund, credit,
 * communication or automation is reachable from these routes.
 */
@Controller('organizations/:organizationId/schools/:schoolId/billing')
@UseGuards(HonIdentityGuard)
export class MembershipPauseController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly pauses: MembershipPauseService) {}

  @Get('membership-pause-policy')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(MembershipPauseReadHumanUiGuard)
  async readPolicy(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HonRequest,
  ) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(request, organizationId, schoolId, POLICY_READ, '');
    const data = await this.pauses.readPolicy(context);
    return { data, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Post('membership-pause-policy')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(MembershipPausePolicyHumanUiGuard)
  async setPolicy(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: SetSchoolMembershipPausePolicyDto,
    @Req() request: HonRequest,
  ) {
    const context = await this.context(request, organizationId, schoolId, [POLICY], this.key(idempotencyKey));
    const result = await this.pauses.setPolicy(context, definedFields(input));
    return { data: result.policy, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  @Post('memberships/:membershipId/pause')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(MembershipPauseHumanUiGuard)
  async pause(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('membershipId', new ParseUUIDPipe()) membershipId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: PauseMembershipDto,
    @Req() request: HonRequest,
  ) {
    const context = await this.context(request, organizationId, schoolId, [PAUSE], this.key(idempotencyKey));
    const result = await this.pauses.pause(context, membershipId, definedFields(input));
    return { data: result.pause, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  @Post('memberships/:membershipId/resume')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(MembershipResumeHumanUiGuard)
  async resume(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('membershipId', new ParseUUIDPipe()) membershipId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: ResumeMembershipDto,
    @Req() request: HonRequest,
  ) {
    const context = await this.context(request, organizationId, schoolId, [PAUSE], this.key(idempotencyKey));
    const result = await this.pauses.resume(context, membershipId, definedFields(input));
    return { data: result.pause, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  @Post('memberships/:membershipId/refund-records')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(MembershipRefundRecordHumanUiGuard)
  async recordRefund(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('membershipId', new ParseUUIDPipe()) membershipId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: RecordMembershipRefundDto,
    @Req() request: HonRequest,
  ) {
    const context = await this.context(request, organizationId, schoolId, [REFUND], this.key(idempotencyKey));
    const result = await this.pauses.recordRefund(context, membershipId, definedFields(input));
    return { data: result.refund, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  @Get('memberships/:membershipId/pauses-and-refunds')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(MembershipPauseReadHumanUiGuard)
  async history(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('membershipId', new ParseUUIDPipe()) membershipId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HonRequest,
  ) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(request, organizationId, schoolId, HISTORY_READ, '');
    const data = await this.pauses.history(context, membershipId);
    return { data, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  private key(idempotencyKey: string | undefined): string {
    const key = idempotencyKey?.trim();
    if (!key || key.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    return key;
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, permissions: readonly string[], idempotencyKey: string): Promise<MembershipLifecycleContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    for (const permission of permissions) {
      const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
      if (scope && scope.organizationId === organizationId && scope.schoolId === schoolId) {
        const requestId = randomUUID();
        return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
      }
    }
    throw new ForbiddenException('HON membership pauses are not authorized for this school.');
  }
}
