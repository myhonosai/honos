import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { configuredPublicOrigin } from '@hon/auth';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { DisconnectSchoolPayDto, FinishSchoolPayOnboardingDto, SchoolPayVersionDto, StartSchoolPayConnectionDto } from './school-payment.dto.js';
import {
  SchoolPayDefaultHumanUiGuard, SchoolPayDisconnectHumanUiGuard, SchoolPayFinishHumanUiGuard, SchoolPayOnboardingLinkHumanUiGuard,
  SchoolPayReadHumanUiGuard, SchoolPayRefreshHumanUiGuard, SchoolPayStartHumanUiGuard,
} from './school-payment-human-ui.guard.js';
import { SchoolPaymentService } from './school-payment.service.js';

const MANAGE = 'school_pay.connection.manage';
/** Either one, live at the route school, admits the read (the database re-checks the same set). */
const READ = [MANAGE, 'school_pay.read'] as const;
/** The staff page the provider's hosted onboarding returns to. */
export const SCHOOL_PAY_RETURN_PATH = '/staff/billing/payment-processors';

function definedFields(input: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value !== undefined));
}

/**
 * B-TUI-2 piece 1 (0258): the school's own payment processor connections (Stripe, Square), test mode only. Route
 * identifiers are never authority: the guarded boundary resolves the route scope from the verified session, and each
 * protected database function re-proves the direct human subject and the live school-scoped permission. No charge,
 * refund, stored card, token, message or automation is reachable from these routes, and HON takes no fee.
 */
@Controller('organizations/:organizationId/schools/:schoolId/payments/processors')
@UseGuards(HonIdentityGuard)
export class SchoolPaymentController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly payments: SchoolPaymentService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolPayReadHumanUiGuard)
  async processors(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HonRequest,
  ) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, READ, '');
    const data = await this.payments.processors(context);
    return { data, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Post('connections')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolPayStartHumanUiGuard)
  async start(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: StartSchoolPayConnectionDto,
    @Req() request: HonRequest,
  ) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, [MANAGE], this.key(idempotencyKey));
    const result = await this.payments.start(context, definedFields(input));
    return { data: result.receipt, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  @Post('connections/:connectionId/onboarding-link')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolPayOnboardingLinkHumanUiGuard)
  async onboardingLink(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('connectionId', new ParseUUIDPipe()) connectionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: SchoolPayVersionDto,
    @Req() request: HonRequest,
  ) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, [MANAGE], this.key(idempotencyKey));
    let origin: string | undefined;
    try { origin = configuredPublicOrigin(process.env); } catch { origin = undefined; }
    if (!origin) throw new ServiceUnavailableException({ code: 'HUMAN_UI_ORIGIN_NOT_CONFIGURED' });
    const returnUrl = new URL(SCHOOL_PAY_RETURN_PATH, origin);
    returnUrl.searchParams.set('connection', connectionId.toLowerCase());
    const result = await this.payments.onboardingLink(context, connectionId, definedFields(input), returnUrl.toString());
    return { data: result.receipt, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  @Post('connections/:connectionId/finish')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolPayFinishHumanUiGuard)
  async finish(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('connectionId', new ParseUUIDPipe()) connectionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: FinishSchoolPayOnboardingDto,
    @Req() request: HonRequest,
  ) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, [MANAGE], this.key(idempotencyKey));
    const result = await this.payments.finish(context, connectionId, definedFields(input));
    return { data: result.receipt, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  @Post('connections/:connectionId/refresh')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolPayRefreshHumanUiGuard)
  async refresh(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('connectionId', new ParseUUIDPipe()) connectionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: SchoolPayVersionDto,
    @Req() request: HonRequest,
  ) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, [MANAGE], this.key(idempotencyKey));
    const result = await this.payments.refresh(context, connectionId, definedFields(input));
    return { data: result.receipt, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  @Post('connections/:connectionId/default')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolPayDefaultHumanUiGuard)
  async setDefault(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('connectionId', new ParseUUIDPipe()) connectionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: SchoolPayVersionDto,
    @Req() request: HonRequest,
  ) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, [MANAGE], this.key(idempotencyKey));
    const result = await this.payments.setDefault(context, connectionId, definedFields(input));
    return { data: result.receipt, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  @Post('connections/:connectionId/disconnect')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolPayDisconnectHumanUiGuard)
  async disconnect(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('connectionId', new ParseUUIDPipe()) connectionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: DisconnectSchoolPayDto,
    @Req() request: HonRequest,
  ) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, [MANAGE], this.key(idempotencyKey));
    const result = await this.payments.disconnect(context, connectionId, definedFields(input));
    return { data: result.receipt, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed, providerRevoked: result.providerRevoked } };
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
    throw new ForbiddenException({ code: permissions.length === 1 ? 'SCHOOL_PAY_MANAGE_FORBIDDEN' : 'SCHOOL_PAY_READ_FORBIDDEN' });
  }
}
