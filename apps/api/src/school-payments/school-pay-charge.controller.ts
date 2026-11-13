import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { ReconcileSchoolPayChargeDto, StartSchoolPayChargeDto } from './school-payment.dto.js';
import {
  SchoolPayAutopayChargeHumanUiGuard, SchoolPayAutopayReadHumanUiGuard, SchoolPayAutopayReconcileHumanUiGuard,
} from './school-payment-human-ui.guard.js';
import { SchoolPayChargeService } from './school-pay-charge.service.js';

const AUTOPAY = 'school_pay.autopay.manage';
/** Any one, live at the route school, admits the read (the database re-checks the same set). */
const AUTOPAY_READ = [AUTOPAY, 'school_pay.read'] as const;

function definedFields(input: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value !== undefined));
}

/**
 * B-TUI-2 piece 5a (0337): a staff member charges one prepared autopay cycle with the plan's saved method at the school's
 * own processor (test mode only), and reconciles a charge whose outcome is still open. Route identifiers are never
 * authority: the guarded boundary resolves the route scope from the verified session, and each protected database function
 * re-proves the direct human subject and the live school-scoped permission. The browser never sends an outcome or an
 * amount other than the confirmed cycle total, and never sees a provider reference. No message is sent; HON takes no fee.
 */
@Controller('organizations/:organizationId/schools/:schoolId/payments')
@UseGuards(HonIdentityGuard)
export class SchoolPayChargeController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly charges: SchoolPayChargeService) {}

  @Get('payers/:billingAccountId/autopay/charges')
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
    return { data: await this.charges.payer(context, billingAccountId), meta: this.meta(context) };
  }

  @Post('autopay/cycles/:cycleId/charge')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolPayAutopayChargeHumanUiGuard)
  async charge(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('cycleId', new ParseUUIDPipe()) cycleId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: StartSchoolPayChargeDto,
    @Req() request: HonRequest,
  ) {
    const context = await this.commandContext(request, organizationId, schoolId, idempotencyKey);
    const result = await this.charges.charge(context, cycleId, definedFields(input));
    return { data: { attempt: result.receipt }, meta: { ...this.meta(context), replayed: result.replayed } };
  }

  @Post('autopay/charges/:attemptId/reconcile')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolPayAutopayReconcileHumanUiGuard)
  async reconcile(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('attemptId', new ParseUUIDPipe()) attemptId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: ReconcileSchoolPayChargeDto,
    @Req() request: HonRequest,
  ) {
    const context = await this.commandContext(request, organizationId, schoolId, idempotencyKey);
    const result = await this.charges.reconcile(context, attemptId, definedFields(input));
    return { data: { attempt: result.receipt }, meta: { ...this.meta(context), replayed: result.replayed } };
  }

  private meta(context: MembershipLifecycleContext) { return { requestId: context.requestId, correlationId: context.correlationId }; }

  private readContext(request: HonRequest, organizationId: string, schoolId: string, permissions: readonly string[], idempotencyKey: string | undefined) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    this.noQuery(request);
    return this.context(request, organizationId, schoolId, permissions, '', 'SCHOOL_PAY_READ_FORBIDDEN');
  }

  private commandContext(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string | undefined) {
    this.noQuery(request);
    const key = idempotencyKey?.trim();
    if (!key || key.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    return this.context(request, organizationId, schoolId, [AUTOPAY], key, 'SCHOOL_PAY_AUTOPAY_FORBIDDEN');
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
