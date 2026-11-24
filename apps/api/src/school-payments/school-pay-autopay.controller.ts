import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import {
  CancelSchoolPayAutopayDto, ChangeSchoolPayAutopayMethodDto, EnrollSchoolPayAutopayDto, PrepareSchoolPayAutopayCycleDto, SetSchoolPayAutopayStateDto,
  SetSchoolPayDiscountRuleDto,
} from './school-payment.dto.js';
import {
  SchoolPayAutopayCancelHumanUiGuard, SchoolPayAutopayCycleHumanUiGuard, SchoolPayAutopayEnrollHumanUiGuard, SchoolPayAutopayMethodHumanUiGuard,
  SchoolPayAutopayReadHumanUiGuard, SchoolPayAutopayStateHumanUiGuard, SchoolPayDiscountReadHumanUiGuard, SchoolPayDiscountSetHumanUiGuard,
} from './school-payment-human-ui.guard.js';
import { SchoolPayAutopayService } from './school-pay-autopay.service.js';

const AUTOPAY = 'school_pay.autopay.manage';
const DISCOUNT = 'school_pay.discount.manage';
/** Any one, live at the route school, admits the reads (the database re-checks the same set). */
const AUTOPAY_READ = [AUTOPAY, 'school_pay.read'] as const;
const DISCOUNT_READ = [DISCOUNT, AUTOPAY, 'school_pay.read'] as const;

function definedFields(input: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value !== undefined));
}

/**
 * B-TUI-2 piece 4 (0322): a payer's autopay plan and the school's sibling discount, test mode only. Route identifiers are
 * never authority: the guarded boundary resolves the route scope from the verified session, and each protected database
 * function re-proves the direct human subject and the live school-scoped permission. No charge, provider call, message or
 * automation is reachable from these routes, and HON takes no fee.
 */
@Controller('organizations/:organizationId/schools/:schoolId/payments')
@UseGuards(HonIdentityGuard)
export class SchoolPayAutopayController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly autopay: SchoolPayAutopayService) {}

  @Get('payers/:billingAccountId/autopay')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolPayAutopayReadHumanUiGuard)
  async payer(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('billingAccountId', new ParseUUIDPipe()) billingAccountId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HonRequest,
  ) {
    const context = await this.readContext(request, organizationId, schoolId, AUTOPAY_READ, idempotencyKey);
    return { data: await this.autopay.payer(context, billingAccountId), meta: this.meta(context) };
  }

  @Get('sibling-discount')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolPayDiscountReadHumanUiGuard)
  async discountRule(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HonRequest,
  ) {
    const context = await this.readContext(request, organizationId, schoolId, DISCOUNT_READ, idempotencyKey);
    return { data: await this.autopay.discountRule(context), meta: this.meta(context) };
  }

  @Post('sibling-discount')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolPayDiscountSetHumanUiGuard)
  async setDiscountRule(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: SetSchoolPayDiscountRuleDto,
    @Req() request: HonRequest,
  ) {
    const context = await this.commandContext(request, organizationId, schoolId, DISCOUNT, idempotencyKey);
    const result = await this.autopay.setDiscountRule(context, definedFields(input));
    return { data: { rule: result.receipt }, meta: { ...this.meta(context), replayed: result.replayed } };
  }

  @Post('payers/:billingAccountId/autopay')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolPayAutopayEnrollHumanUiGuard)
  async enroll(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('billingAccountId', new ParseUUIDPipe()) billingAccountId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: EnrollSchoolPayAutopayDto,
    @Req() request: HonRequest,
  ) {
    const context = await this.commandContext(request, organizationId, schoolId, AUTOPAY, idempotencyKey);
    const result = await this.autopay.enroll(context, billingAccountId, definedFields(input));
    return { data: { plan: result.receipt }, meta: { ...this.meta(context), replayed: result.replayed } };
  }

  @Post('autopay/:planId/method')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolPayAutopayMethodHumanUiGuard)
  async changeMethod(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('planId', new ParseUUIDPipe()) planId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: ChangeSchoolPayAutopayMethodDto,
    @Req() request: HonRequest,
  ) {
    const context = await this.commandContext(request, organizationId, schoolId, AUTOPAY, idempotencyKey);
    const result = await this.autopay.changeMethod(context, planId, definedFields(input));
    return { data: { plan: result.receipt }, meta: { ...this.meta(context), replayed: result.replayed } };
  }

  @Post('autopay/:planId/state')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolPayAutopayStateHumanUiGuard)
  async setState(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('planId', new ParseUUIDPipe()) planId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: SetSchoolPayAutopayStateDto,
    @Req() request: HonRequest,
  ) {
    const context = await this.commandContext(request, organizationId, schoolId, AUTOPAY, idempotencyKey);
    const result = await this.autopay.setState(context, planId, definedFields(input));
    return { data: { plan: result.receipt }, meta: { ...this.meta(context), replayed: result.replayed } };
  }

  @Post('autopay/:planId/cancel')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolPayAutopayCancelHumanUiGuard)
  async cancel(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('planId', new ParseUUIDPipe()) planId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CancelSchoolPayAutopayDto,
    @Req() request: HonRequest,
  ) {
    const context = await this.commandContext(request, organizationId, schoolId, AUTOPAY, idempotencyKey);
    const result = await this.autopay.cancel(context, planId, definedFields(input));
    return { data: { plan: result.receipt }, meta: { ...this.meta(context), replayed: result.replayed } };
  }

  @Post('autopay/:planId/cycles')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolPayAutopayCycleHumanUiGuard)
  async prepareCycle(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('planId', new ParseUUIDPipe()) planId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: PrepareSchoolPayAutopayCycleDto,
    @Req() request: HonRequest,
  ) {
    const context = await this.commandContext(request, organizationId, schoolId, AUTOPAY, idempotencyKey);
    const result = await this.autopay.prepareCycle(context, planId, definedFields(input));
    return { data: { cycle: result.receipt }, meta: { ...this.meta(context), replayed: result.replayed } };
  }

  private meta(context: MembershipLifecycleContext) { return { requestId: context.requestId, correlationId: context.correlationId }; }

  private readContext(request: HonRequest, organizationId: string, schoolId: string, permissions: readonly string[], idempotencyKey: string | undefined) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    this.noQuery(request);
    return this.context(request, organizationId, schoolId, permissions, '', 'SCHOOL_PAY_READ_FORBIDDEN');
  }

  private commandContext(request: HonRequest, organizationId: string, schoolId: string, permission: string, idempotencyKey: string | undefined) {
    this.noQuery(request);
    const key = idempotencyKey?.trim();
    if (!key || key.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    return this.context(request, organizationId, schoolId, [permission], key, permission === DISCOUNT ? 'SCHOOL_PAY_DISCOUNT_FORBIDDEN' : 'SCHOOL_PAY_AUTOPAY_FORBIDDEN');
  }

  private noQuery(request: HonRequest): void {
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, permissions: readonly string[], idempotencyKey: string, denial: string): Promise<MembershipLifecycleContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    for (const permission of permissions) {
      const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
      if (scope && scope.organizationId.toLowerCase() === organizationId.toLowerCase() && scope.schoolId.toLowerCase() === schoolId.toLowerCase()) {
        const requestId = randomUUID();
        return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
      }
    }
    throw new ForbiddenException({ code: denial });
  }
}
