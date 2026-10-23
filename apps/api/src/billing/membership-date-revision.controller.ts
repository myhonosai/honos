import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Header, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import {
  ConfirmMembershipDateRevisionDto,
  MembershipDateConfirmationQueueDto,
  MembershipDateHistoryDto,
  MembershipDateRevisionPreviewDto,
} from './membership-date-revision.dto.js';
import { MembershipDateRevisionService } from './membership-date-revision.service.js';
import type { MembershipLifecycleContext } from './membership.service.js';
import {
  MembershipDateHistoryHumanUiGuard,
  MembershipDatePreviewHumanUiGuard,
  MembershipDateQueueHumanUiGuard,
  MembershipDateRevisionHumanUiGuard,
} from './membership-activation-human-ui.guard.js';

const REVISE = 'billing.membership.dates.revise';
/** Any one of these, live at the route school, admits the read-only history (the database re-checks the same set). */
const HISTORY_PERMISSIONS = ['billing.membership.read', 'billing.membership.activate', REVISE] as const;

/** DTO instances may carry declared-but-absent fields as undefined; JSON bodies never do. */
function definedFields(input: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value !== undefined));
}

/**
 * E1b-1 membership date management (0178). Route identifiers are never authority: the guarded boundary resolves the
 * route scope from the verified session, and each protected database function re-proves the direct human subject and
 * the live school-scoped permission. These routes change dates only; no payment, schedule, invoice, refund, credit,
 * agreement, consent, payer, price, entitlement or communication action is reachable from them.
 */
@Controller('organizations/:organizationId/schools/:schoolId/billing/memberships')
@UseGuards(HonIdentityGuard)
export class MembershipDateRevisionController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly dates: MembershipDateRevisionService) {}

  /** Step one: read-only preview of one change kind with the suggested dates or one exact date pair. No Idempotency-Key. */
  @Post(':membershipId/effective-period/preview')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(MembershipDatePreviewHumanUiGuard)
  async preview(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('membershipId', new ParseUUIDPipe()) membershipId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: MembershipDateRevisionPreviewDto,
    @Req() request: HonRequest,
  ) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(request, organizationId, schoolId, [REVISE], '');
    const data = await this.dates.preview(context, membershipId, definedFields(input));
    return { data, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: false } };
  }

  /** Step two: confirms exactly one previewed date revision. An exact retry with the same key replays the receipt. */
  @Post(':membershipId/effective-period/revisions')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(MembershipDateRevisionHumanUiGuard)
  async revise(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('membershipId', new ParseUUIDPipe()) membershipId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: ConfirmMembershipDateRevisionDto,
    @Req() request: HonRequest,
  ) {
    const key = idempotencyKey?.trim();
    if (!key || key.length > 200) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required to change membership dates.' });
    }
    const context = await this.context(request, organizationId, schoolId, [REVISE], key);
    const result = await this.dates.revise(context, membershipId, definedFields(input));
    return { data: result.receipt, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  /** Read-only confirmed date history. POST with `{}` so the browser command header binds the read. */
  @Post(':membershipId/effective-period/history')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(MembershipDateHistoryHumanUiGuard)
  async history(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('membershipId', new ParseUUIDPipe()) membershipId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: MembershipDateHistoryDto,
    @Req() request: HonRequest,
  ) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(request, organizationId, schoolId, HISTORY_PERMISSIONS, '');
    const data = await this.dates.history(context, membershipId, definedFields(input));
    return { data, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  /** E1b-D7 legacy queue: ACTIVE memberships whose dates were never confirmed in HON. Each is confirmed individually. */
  @Post('date-confirmation-queue')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(MembershipDateQueueHumanUiGuard)
  async queue(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: MembershipDateConfirmationQueueDto,
    @Req() request: HonRequest,
  ) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(request, organizationId, schoolId, [REVISE], '');
    const data = await this.dates.confirmationQueue(context, definedFields(input));
    return { data, meta: { requestId: context.requestId, correlationId: context.correlationId } };
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
    throw new ForbiddenException('HON membership date management is not authorized for this school.');
  }
}
