import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { CommandContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { ActivateMembershipDto, MembershipActivationPreviewDto } from './activate-membership.dto.js';
import { CancelMembershipDto } from './cancel-membership.dto.js';
import { CreateMembershipDto } from './create-membership.dto.js';
import { MembershipService, type MembershipLifecycleContext } from './membership.service.js';
import { MembershipActivationHumanUiGuard, MembershipActivationPreviewHumanUiGuard, MembershipCancelHumanUiGuard } from './membership-activation-human-ui.guard.js';

/** DTO instances may carry declared-but-absent fields as undefined; JSON bodies never do. */
function definedFields(input: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value !== undefined));
}

@Controller('organizations/:organizationId/schools/:schoolId/billing/memberships')
@UseGuards(HonIdentityGuard)
export class MembershipController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly memberships: MembershipService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createDraft(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CreateMembershipDto,
    @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey || idempotencyKey.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required for membership creation.' });
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'billing.membership.create');
    if (!scope || scope.organizationId !== organizationId) throw new ForbiddenException('HON membership creation is not authorized for this school.');
    const requestId = randomUUID();
    const command: CommandContext = { organizationId: scope.organizationId, schoolId: scope.schoolId, principalId: scope.principalId, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI' };
    const result = await this.memberships.createDraft(command, input);
    response.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return { data: result.membership, meta: { requestId, correlationId: requestId, replayed: result.replayed } };
  }

  /** No list/search or related-record context: exactly one already-known ID. */
  @Get(':membershipId/activation-context')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(MembershipActivationHumanUiGuard)
  async activationContext(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('membershipId', new ParseUUIDPipe()) membershipId: string,
    @Query() query: Record<string, unknown>,
    @Req() request: HonRequest,
  ) {
    if (Object.keys(query).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'billing.membership.activate');
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) {
      throw new ForbiddenException('HON membership activation is not authorized for this school.');
    }
    const requestId = randomUUID();
    const context: CommandContext = { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey: '', source: 'HUMAN_UI' };
    const data = await this.memberships.readActivationContext(context, membershipId);
    return { data, meta: { requestId, correlationId: requestId } };
  }

  /**
   * Step one of two-step activation (0177): read-only preview of one known membership. No Idempotency-Key, no
   * effects. The body is `{}` (suggested dates) or one exact `{ startDate, endDate }` pair in the school timezone.
   */
  @Post(':membershipId/activation-preview')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(MembershipActivationPreviewHumanUiGuard)
  async activationPreview(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('membershipId', new ParseUUIDPipe()) membershipId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: MembershipActivationPreviewDto,
    @Req() request: HonRequest,
  ) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'billing.membership.activate');
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) {
      throw new ForbiddenException('HON membership activation is not authorized for this school.');
    }
    const requestId = randomUUID();
    const context: MembershipLifecycleContext = { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey: '',
      source: 'HUMAN_UI', externalSubject: identity.externalSubject };
    const data = await this.memberships.previewActivation(context, membershipId, definedFields(input));
    return { data, meta: { requestId, correlationId: requestId, replayed: false } };
  }

  /**
   * Step two: a human operator confirms exactly one previewed DRAFT membership. The guarded boundary resolves the
   * route scope; the database re-proves live school-scoped authority, re-derives the preview facts and records the
   * decision. A pre-0177 `{ expectedVersion }` body fails closed with ACTIVATION_TWO_STEP_CONFIRMATION_REQUIRED.
   */
  @Post(':membershipId/activate')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(MembershipActivationHumanUiGuard)
  async activate(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('membershipId', new ParseUUIDPipe()) membershipId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: ActivateMembershipDto,
    @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const normalizedIdempotencyKey = idempotencyKey?.trim();
    if (!normalizedIdempotencyKey || normalizedIdempotencyKey.length > 200) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        detail: 'A unique Idempotency-Key header is required for membership activation.',
      });
    }
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const scope = await this.database.resolveAuthorizedScope(
      identity.externalSubject,
      schoolId,
      'billing.membership.activate',
    );
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) {
      throw new ForbiddenException('HON membership activation is not authorized for this school.');
    }
    const requestId = randomUUID();
    const context: MembershipLifecycleContext = {
      organizationId: scope.organizationId,
      schoolId: scope.schoolId,
      principalId: scope.principalId,
      principalType: 'HUMAN_USER',
      requestId,
      correlationId: requestId,
      idempotencyKey: normalizedIdempotencyKey,
      source: 'HUMAN_UI',
      externalSubject: identity.externalSubject,
    };
    const result = await this.memberships.activate(context, membershipId, definedFields(input));
    response.status(HttpStatus.OK);
    return {
      data: result.membership,
      meta: { requestId, correlationId: requestId, replayed: result.replayed },
    };
  }

  /**
   * A human operator directly cancels exactly one RLS-visible ACTIVE membership.
   * The route derives actor, tenant, permission, source, and attribution; the
   * request body cannot select an Action Engine, delegate, payment action, or
   * related billing/scheduling resource. Only a same-origin browser command
   * naming billing.membership.cancel reaches it (no cross-site, delegated or
   * source-selected call).
   */
  @Post(':membershipId/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(MembershipCancelHumanUiGuard)
  async cancel(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('membershipId', new ParseUUIDPipe()) membershipId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CancelMembershipDto,
    @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const normalizedIdempotencyKey = idempotencyKey?.trim();
    if (!normalizedIdempotencyKey || normalizedIdempotencyKey.length > 200) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        detail: 'A unique Idempotency-Key header is required for membership cancellation.',
      });
    }
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(
      identity.externalSubject,
      schoolId,
      'billing.membership.cancel',
    );
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) {
      throw new ForbiddenException('HON membership cancellation is not authorized for this school.');
    }
    const requestId = randomUUID();
    const context: MembershipLifecycleContext = {
      organizationId: scope.organizationId,
      schoolId: scope.schoolId,
      principalId: scope.principalId,
      principalType: 'HUMAN_USER',
      requestId,
      correlationId: requestId,
      idempotencyKey: normalizedIdempotencyKey,
      source: 'HUMAN_UI',
      externalSubject: identity.externalSubject,
    };
    const result = await this.memberships.cancel(context, membershipId, input);
    response.status(HttpStatus.OK);
    return {
      data: result.membership,
      meta: { requestId, correlationId: requestId, replayed: result.replayed },
    };
  }
}
