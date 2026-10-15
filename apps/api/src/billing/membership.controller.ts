import { Body, ConflictException, Controller, ForbiddenException, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { CommandContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/manus-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
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
}
