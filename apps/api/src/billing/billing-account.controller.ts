import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { validateCreateBillingAccountInput, type CommandContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CreateBillingAccountDto } from './create-billing-account.dto.js';
import { BillingAccountPayerLookupDto } from './billing-account-payer-lookup.dto.js';
import { BillingAccountHumanUiGuard } from './billing-account-human-ui.guard.js';
import { BillingAccountService } from './billing-account.service.js';

@Controller('organizations/:organizationId/schools/:schoolId/billing/accounts')
export class BillingAccountController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly accounts: BillingAccountService) {}

  @Post()
  @UseGuards(HonIdentityGuard, BillingAccountHumanUiGuard)
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
    try { validateCreateBillingAccountInput(input); }
    catch { throw new BadRequestException({ code: 'INVALID_BILLING_ACCOUNT_INPUT', detail: 'Billing account input must be a closed current-person command.' }); }
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'billing.account.create');
    if (!scope || scope.organizationId !== organizationId) throw new ForbiddenException('HON billing account creation is not authorized for this school.');
    const requestId = randomUUID();
    const command: CommandContext = { organizationId: scope.organizationId, schoolId: scope.schoolId, principalId: scope.principalId, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI' };
    const result = await this.accounts.create(command, input);
    response.status(result.replayed || ('reused' in result.account && result.account.reused) ? HttpStatus.OK : HttpStatus.CREATED);
    return { data: result.account, meta: { requestId, correlationId: requestId, replayed: result.replayed } };
  }

  /** Explicit bounded payer search; no account history, automatic selection, or command effect. */
  @Post('payer-lookup')
  @UseGuards(HonIdentityGuard, BillingAccountHumanUiGuard)
  @HttpCode(HttpStatus.OK)
  async lookupPayers(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: BillingAccountPayerLookupDto,
    @Req() request: HonRequest,
  ) {
    if (idempotencyKey !== undefined) throw new BadRequestException({ code: 'LOOKUP_IDEMPOTENCY_NOT_ACCEPTED' });
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'billing.account.create');
    if (!scope || scope.organizationId !== organizationId) throw new ForbiddenException('Billing payer lookup is not authorized for this school.');
    const requestId = randomUUID();
    const payers = await this.accounts.lookupPayers({ organizationId: scope.organizationId, schoolId: scope.schoolId,
      principalId: scope.principalId, principalType: 'HUMAN_USER', requestId, correlationId: requestId, source: 'HUMAN_UI' }, input.query);
    return { data: payers.map((payer) => ({ id: payer.id, displayName: payer.displayName })) };
  }
}
