import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpStatus, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { SimpleInvoiceCreateHumanUiGuard, TuitionReadHumanUiGuard } from './membership-activation-human-ui.guard.js';
import { CreateSimpleInvoiceDto } from './simple-invoice.dto.js';
import { SimpleInvoiceService } from './simple-invoice.service.js';
import type { MembershipLifecycleContext } from './membership.service.js';

/** The 0280 readers: any one of these, live at the route school, admits the detail read (the database re-checks the set). */
const READ = ['billing.invoice.payment.record', 'billing.invoice.issue', 'billing.invoice.create'] as const;

/**
 * SI1 (0540): the simple invoice form and the printable invoice. Route identifiers are never authority: the guarded
 * boundary resolves the route scope from the verified session, and each protected database function re-proves the
 * direct human subject and the live school permission. Nothing here charges, sends or contacts a provider.
 */
@Controller('organizations/:organizationId/schools/:schoolId/billing/invoices')
@UseGuards(HonIdentityGuard)
export class SimpleInvoiceController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly invoices: SimpleInvoiceService) {}

  @Post('simple')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SimpleInvoiceCreateHumanUiGuard)
  async create(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CreateSimpleInvoiceDto,
    @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const key = idempotencyKey?.trim();
    if (!key || key.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    const context = await this.context(request, organizationId, schoolId, ['billing.invoice.create'], key);
    // The DTO only shapes the transport; the fields are checked again by the contract and by the database.
    const fields = Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value !== undefined));
    const result = await this.invoices.create(context, fields);
    response.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return { data: result.invoice, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  @Get(':invoiceId/detail')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(TuitionReadHumanUiGuard)
  async detail(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HonRequest,
  ) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const context = await this.context(request, organizationId, schoolId, READ, '');
    const data = await this.invoices.detail(context, invoiceId);
    return { data, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, permissions: readonly string[], idempotencyKey: string): Promise<MembershipLifecycleContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    for (const permission of permissions) {
      const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
      if (scope && scope.organizationId.toLowerCase() === organizationId.toLowerCase() && scope.schoolId.toLowerCase() === schoolId.toLowerCase()) {
        const requestId = randomUUID();
        return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
      }
    }
    throw new ForbiddenException({ code: 'TUITION_RECEIVABLES_FORBIDDEN' });
  }
}
