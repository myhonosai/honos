import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { configuredPublicOrigin } from '@hon/auth';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { FinishSchoolPayMethodSetupDto, RemoveSchoolPayMethodDto, SchoolPayVersionDto, StartSchoolPayMethodSetupDto } from './school-payment.dto.js';
import {
  SchoolPayExpiringReadHumanUiGuard, SchoolPayMethodDefaultHumanUiGuard, SchoolPayMethodFinishHumanUiGuard, SchoolPayMethodRemoveHumanUiGuard,
  SchoolPayMethodSetupHumanUiGuard, SchoolPayMethodsReadHumanUiGuard,
} from './school-payment-human-ui.guard.js';
import { SchoolPayMethodService } from './school-pay-method.service.js';

const MANAGE = 'school_pay.method.manage';
/** Either one, live at the route school, admits the reads (the database re-checks the same set). */
const READ = [MANAGE, 'school_pay.read'] as const;
/** The staff page the provider's hosted setup returns to. */
export const SCHOOL_PAY_METHOD_RETURN_PATH = '/staff/billing/saved-payment-methods';

function definedFields(input: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value !== undefined));
}

/**
 * B-TUI-2 piece 3 (0265): a payer's saved cards and bank accounts at the school's own processor, test mode only. Route
 * identifiers are never authority: the guarded boundary resolves the route scope from the verified session, and each
 * protected database function re-proves the direct human subject and the live school-scoped permission. No charge,
 * card number, token secret, message or automation is reachable from these routes, and HON takes no fee.
 */
@Controller('organizations/:organizationId/schools/:schoolId/payments')
@UseGuards(HonIdentityGuard)
export class SchoolPayMethodController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly methods: SchoolPayMethodService) {}

  @Get('payers/:billingAccountId/methods')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolPayMethodsReadHumanUiGuard)
  async payer(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('billingAccountId', new ParseUUIDPipe()) billingAccountId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HonRequest,
  ) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, READ, '');
    const data = await this.methods.payer(context, billingAccountId);
    return { data: this.forBrowser(data), meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Get('saved-methods/expiring')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolPayExpiringReadHumanUiGuard)
  async expiring(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HonRequest,
  ) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, READ, '');
    const data = await this.methods.expiring(context);
    return { data, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Post('payers/:billingAccountId/method-setups')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolPayMethodSetupHumanUiGuard)
  async start(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('billingAccountId', new ParseUUIDPipe()) billingAccountId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: StartSchoolPayMethodSetupDto,
    @Req() request: HonRequest,
  ) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, [MANAGE], this.key(idempotencyKey));
    let origin: string | undefined;
    try { origin = configuredPublicOrigin(process.env); } catch { origin = undefined; }
    if (!origin) throw new ServiceUnavailableException({ code: 'HUMAN_UI_ORIGIN_NOT_CONFIGURED' });
    const returnUrlFor = (setupId: string) => {
      const url = new URL(SCHOOL_PAY_METHOD_RETURN_PATH, origin);
      url.searchParams.set('payer', billingAccountId.toLowerCase());
      url.searchParams.set('setup', setupId);
      return url.toString();
    };
    const result = await this.methods.start(context, billingAccountId, definedFields(input), returnUrlFor);
    return { data: result.receipt, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  @Post('payers/:billingAccountId/method-setups/:setupId/finish')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolPayMethodFinishHumanUiGuard)
  async finish(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('billingAccountId', new ParseUUIDPipe()) billingAccountId: string,
    @Param('setupId', new ParseUUIDPipe()) setupId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: FinishSchoolPayMethodSetupDto,
    @Req() request: HonRequest,
  ) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, [MANAGE], this.key(idempotencyKey));
    const result = await this.methods.finish(context, billingAccountId, setupId, definedFields(input));
    return { data: result.receipt, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  @Post('payers/:billingAccountId/methods/:methodId/default')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolPayMethodDefaultHumanUiGuard)
  async setDefault(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('billingAccountId', new ParseUUIDPipe()) billingAccountId: string,
    @Param('methodId', new ParseUUIDPipe()) methodId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: SchoolPayVersionDto,
    @Req() request: HonRequest,
  ) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, [MANAGE], this.key(idempotencyKey));
    const result = await this.methods.setDefault(context, billingAccountId, methodId, definedFields(input));
    return { data: result.receipt, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  @Post('payers/:billingAccountId/methods/:methodId/remove')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolPayMethodRemoveHumanUiGuard)
  async remove(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('billingAccountId', new ParseUUIDPipe()) billingAccountId: string,
    @Param('methodId', new ParseUUIDPipe()) methodId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: RemoveSchoolPayMethodDto,
    @Req() request: HonRequest,
  ) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, [MANAGE], this.key(idempotencyKey));
    const result = await this.methods.remove(context, billingAccountId, methodId, definedFields(input));
    return { data: { method: result.receipt.method }, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed, providerDetached: result.receipt.providerDetached } };
  }

  /** The provider account and customer references are for the API's provider calls only; the browser never needs them. */
  private forBrowser(data: Awaited<ReturnType<SchoolPayMethodService['payer']>>) {
    return { ...data, connections: data.connections.map(({ accountRef: _a, customerRef, ...rest }) => ({ ...rest, hasCustomer: customerRef !== null })) };
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
    throw new ForbiddenException({ code: permissions.length === 1 ? 'SCHOOL_PAY_METHOD_FORBIDDEN' : 'SCHOOL_PAY_READ_FORBIDDEN' });
  }
}
