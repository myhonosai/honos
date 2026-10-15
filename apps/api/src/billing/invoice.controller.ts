import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { CommandContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/manus-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CreateInvoiceDraftDto } from './create-invoice-draft.dto.js';
import { IssueInvoiceDto } from './issue-invoice.dto.js';
import { InvoiceService } from './invoice.service.js';

@Controller('organizations/:organizationId/schools/:schoolId/billing/invoices')
@UseGuards(HonIdentityGuard)
export class InvoiceController {
  constructor(
    private readonly database: RuntimeDatabaseService,
    private readonly invoices: InvoiceService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createDraft(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CreateInvoiceDraftDto,
    @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const normalizedIdempotencyKey = idempotencyKey?.trim();
    if (!normalizedIdempotencyKey || normalizedIdempotencyKey.length > 200) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        detail: 'A unique Idempotency-Key header is required for invoice draft creation.',
      });
    }

    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(
      identity.externalSubject,
      schoolId,
      'billing.invoice.create',
    );
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) {
      throw new ForbiddenException('HON invoice draft creation is not authorized for this school.');
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
    const result = await this.invoices.createDraft(context, input);
    response.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return {
      data: result.invoice,
      meta: { requestId, correlationId: requestId, replayed: result.replayed },
    };
  }

  /**
   * A human operator issues exactly one RLS-visible DRAFT invoice. The guarded
   * boundary derives every authority and attribution field; the body provides
   * only the optimistic version observed by that operator.
   */
  @Post(':invoiceId/issue')
  @HttpCode(HttpStatus.OK)
  async issue(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: IssueInvoiceDto,
    @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const normalizedIdempotencyKey = idempotencyKey?.trim();
    if (!normalizedIdempotencyKey || normalizedIdempotencyKey.length > 200) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        detail: 'A unique Idempotency-Key header is required for invoice issuance.',
      });
    }

    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(
      identity.externalSubject,
      schoolId,
      'billing.invoice.issue',
    );
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) {
      throw new ForbiddenException('HON invoice issuance is not authorized for this school.');
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
    const result = await this.invoices.issue(context, invoiceId, input);
    response.status(HttpStatus.OK);
    return {
      data: result.invoice,
      meta: { requestId, correlationId: requestId, replayed: result.replayed },
    };
  }
}
