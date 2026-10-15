import { Body, ConflictException, Controller, ForbiddenException, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { CommandContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { ActivateMembershipDto } from './activate-membership.dto.js';
import { CreateMembershipDto } from './create-membership.dto.js';
import { MembershipService } from './membership.service.js';

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

  /**
   * A human operator activates exactly one RLS-visible DRAFT membership. The
   * guarded boundary resolves all authority and attribution; the body carries
   * only the optimistic version observed by that operator.
   */
  @Post(':membershipId/activate')
  @HttpCode(HttpStatus.OK)
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
    const scope = await this.database.resolveAuthorizedScope(
      identity.externalSubject,
      schoolId,
      'billing.membership.activate',
    );
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) {
      throw new ForbiddenException('HON membership activation is not authorized for this school.');
    }
    const requestId = randomUUID();
    const context: CommandContext = {
      organizationId: scope.organizationId,
      schoolId: scope.schoolId,
      principalId: scope.principalId,
      principalType: 'HUMAN_USER',
      requestId,
      correlationId: requestId,
      idempotencyKey: normalizedIdempotencyKey,
      source: 'HUMAN_UI',
    };
    const result = await this.memberships.activate(context, membershipId, input);
    response.status(HttpStatus.OK);
    return {
      data: result.membership,
      meta: { requestId, correlationId: requestId, replayed: result.replayed },
    };
  }
}
