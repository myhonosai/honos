import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { TuitionPaymentRecordHumanUiGuard, TuitionPaymentVoidHumanUiGuard, TuitionReadHumanUiGuard } from './membership-activation-human-ui.guard.js';
import { RecordTuitionPaymentDto, VoidTuitionPaymentDto } from './tuition-payment.dto.js';
import { TuitionPaymentService } from './tuition-payment.service.js';
import type { MembershipLifecycleContext } from './membership.service.js';

const RECORD = 'billing.invoice.payment.record';
/** Any one of these, live at the route school, admits the reads (the database re-checks the same set). */
const READ = [RECORD, 'billing.invoice.issue', 'billing.invoice.create'] as const;

function definedFields(input: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value !== undefined));
}

/**
 * B-TUI-1 (0240): tuition payments the school received outside HON, and its unpaid balances. Route identifiers are never
 * authority: the guarded boundary resolves the route scope from the verified session, and each protected database
 * function re-proves the direct human subject and the live school-scoped permission. No charge, refund, provider,
 * communication or automation is reachable from these routes.
 */
@Controller('organizations/:organizationId/schools/:schoolId/billing')
@UseGuards(HonIdentityGuard)
export class TuitionPaymentController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly tuition: TuitionPaymentService) {}

  @Get('receivables')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(TuitionReadHumanUiGuard)
  async receivables(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Query() query: Record<string, unknown>,
    @Req() request: HonRequest,
  ) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const keys = Object.keys(query ?? {});
    if (keys.some(key => !['filter', 'after'].includes(key)) || Object.values(query ?? {}).some(value => typeof value !== 'string')) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    }
    const context = await this.context(request, organizationId, schoolId, READ, '');
    const data = await this.tuition.receivables(context, { filter: query.filter ?? 'OPEN', ...(query.after === undefined ? {} : { after: query.after }) });
    return { data, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  /** B-TUI-1b (0280): GET .../billing/invoices?status=ALL|DRAFT|ISSUED|PAID|VOID|UNCOLLECTIBLE&after=<invoice id>. */
  @Get('invoices')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(TuitionReadHumanUiGuard)
  async invoices(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Query() query: Record<string, unknown>,
    @Req() request: HonRequest,
  ) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const keys = Object.keys(query ?? {});
    if (keys.some(key => !['status', 'after'].includes(key)) || Object.values(query ?? {}).some(value => typeof value !== 'string')) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    }
    const context = await this.context(request, organizationId, schoolId, READ, '');
    const data = await this.tuition.invoices(context, { status: query.status ?? 'ALL', ...(query.after === undefined ? {} : { after: query.after }) });
    return { data, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Get('invoices/:invoiceId/payments')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(TuitionReadHumanUiGuard)
  async payments(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HonRequest,
  ) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, READ, '');
    const data = await this.tuition.payments(context, invoiceId);
    return { data, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Post('invoices/:invoiceId/payments')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(TuitionPaymentRecordHumanUiGuard)
  async record(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: RecordTuitionPaymentDto,
    @Req() request: HonRequest,
  ) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, [RECORD], this.key(idempotencyKey));
    const result = await this.tuition.record(context, invoiceId, definedFields(input));
    return { data: result.receipt, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  @Post('invoice-payments/:paymentId/void')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(TuitionPaymentVoidHumanUiGuard)
  async void(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('paymentId', new ParseUUIDPipe()) paymentId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: VoidTuitionPaymentDto,
    @Req() request: HonRequest,
  ) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, [RECORD], this.key(idempotencyKey));
    const result = await this.tuition.void(context, paymentId, definedFields(input));
    return { data: result.receipt, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  private noQuery(request: HonRequest): void {
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  }

  private key(idempotencyKey: string | undefined): string {
    const key = idempotencyKey?.trim();
    if (!key || key.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    return key;
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
    throw new ForbiddenException({ code: permissions.length === 1 ? 'INVOICE_PAYMENT_RECORD_FORBIDDEN' : 'TUITION_RECEIVABLES_FORBIDDEN' });
  }
}
