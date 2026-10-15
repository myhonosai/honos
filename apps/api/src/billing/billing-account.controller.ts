import { Body, ConflictException, Controller, ForbiddenException, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { CommandContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CreateBillingAccountDto } from './create-billing-account.dto.js';
import { BillingAccountService } from './billing-account.service.js';

@Controller('organizations/:organizationId/schools/:schoolId/billing/accounts')
@UseGuards(HonIdentityGuard)
export class BillingAccountController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly accounts: BillingAccountService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CreateBillingAccountDto,
    @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey || idempotencyKey.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required for billing account creation.' });
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'billing.account.create');
    if (!scope || scope.organizationId !== organizationId) throw new ForbiddenException('HON billing account creation is not authorized for this school.');
    const requestId = randomUUID();
    const command: CommandContext = { organizationId: scope.organizationId, schoolId: scope.schoolId, principalId: scope.principalId, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI' };
    const result = await this.accounts.create(command, input);
    response.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return { data: result.account, meta: { requestId, correlationId: requestId, replayed: result.replayed } };
  }
}
