import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  validateCancelSchoolPayAutopayInput,
  validateChangeSchoolPayAutopayMethodInput,
  validateEnrollSchoolPayAutopayInput,
  validatePrepareSchoolPayAutopayCycleInput,
  validateSetSchoolPayAutopayStateInput,
  validateSetSchoolPayDiscountRuleInput,
  verifySchoolPayAutopayCycleReceipt,
  verifySchoolPayAutopayPlanReceipt,
  verifySchoolPayDiscountRuleRead,
  verifySchoolPayDiscountRuleReceipt,
  verifySchoolPayPayerAutopay,
  type SchoolPayAutopayCycle,
  type SchoolPayAutopayPlan,
  type SchoolPayDiscountRule,
  type SchoolPayDiscountRuleRead,
  type SchoolPayPayerAutopay,
} from '@hon/contracts';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { HUMAN_SETTINGS, READ_LIMITS, WRITE_LIMITS, translateSchoolPayError } from './school-payment.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTOPAY_FORBIDDEN = 'SCHOOL_PAY_AUTOPAY_FORBIDDEN';
const DISCOUNT_FORBIDDEN = 'SCHOOL_PAY_DISCOUNT_FORBIDDEN';
const READ_FORBIDDEN = 'SCHOOL_PAY_READ_FORBIDDEN';

// Exact 0322 error codes; every unknown database failure is unavailable, never success.
const ERRORS: Record<string, (code: string) => HttpException> = {
  VALIDATION_FAILED: code => new BadRequestException({ code }),
  SCHOOL_PAY_AUTOPAY_FORBIDDEN: code => new ForbiddenException({ code }),
  SCHOOL_PAY_DISCOUNT_FORBIDDEN: code => new ForbiddenException({ code }),
  SCHOOL_PAY_READ_FORBIDDEN: code => new ForbiddenException({ code }),
  SCHOOL_PAY_PAYER_NOT_FOUND: code => new NotFoundException({ code, detail: 'This payer is not in this school.' }),
  SCHOOL_PAY_AUTOPAY_NOT_FOUND: code => new NotFoundException({ code, detail: 'This autopay plan is not available.' }),
  SCHOOL_PAY_AUTOPAY_METHOD_UNUSABLE: code => new UnprocessableEntityException({ code, detail: 'This saved payment method cannot be used for autopay now.' }),
  SCHOOL_PAY_AUTOPAY_TOO_EARLY: code => new UnprocessableEntityException({ code, detail: 'A cycle can be prepared at most seven days ahead.' }),
  SCHOOL_PAY_AUTOPAY_TOO_MANY_LINES: code => new UnprocessableEntityException({ code, detail: 'This payer has too many charges due at once.' }),
  SCHOOL_PAY_SCHOOL_TIME_ZONE_INVALID: code => new UnprocessableEntityException({ code, detail: 'The school time zone is not set.' }),
  SCHOOL_PAY_AUTOPAY_EXISTS: code => new ConflictException({ code, detail: 'This payer already has autopay.' }),
  SCHOOL_PAY_AUTOPAY_STATE: code => new ConflictException({ code, detail: 'This autopay plan is not in a state that allows this.' }),
  SCHOOL_PAY_AUTOPAY_NOTHING_DUE: code => new ConflictException({ code, detail: 'Nothing is due for this payer on or before that day.' }),
  SCHOOL_PAY_DISCOUNT_UNCHANGED: code => new ConflictException({ code, detail: 'The sibling discount is already set this way.' }),
  VERSION_CONFLICT: code => new ConflictException({ code, detail: 'This has changed. Reload it and try again with a new Idempotency-Key.' }),
  IDEMPOTENCY_KEY_REUSED: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different command.' }),
  IDEMPOTENCY_IN_PROGRESS: code => new ConflictException({ code, detail: 'The matching command is being processed.' }),
};
function translate(error: unknown, forbidden: string): never { return translateSchoolPayError(error, forbidden, ERRORS); }

type Receipt<T> = Promise<{ receipt: T; replayed: boolean }>;

/**
 * B-TUI-2 piece 4 (0322): a payer's autopay plan and the school's sibling discount, test mode only. Each command is one
 * protected definer function that re-proves the direct human subject and the live school-scoped permission. Preparing a
 * cycle writes ISSUED invoices with the sibling discount; nothing here contacts a processor or charges anyone. No HON fee.
 */
@Injectable()
export class SchoolPayAutopayService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  payer(context: MembershipLifecycleContext, billingAccountId: string): Promise<SchoolPayPayerAutopay> {
    this.assertHumanContext(context, READ_FORBIDDEN, false); this.assertId(billingAccountId);
    return this.read(context, 'SELECT hon.read_school_pay_autopay($1,$2::uuid) AS data', [context.externalSubject, billingAccountId],
      data => verifySchoolPayPayerAutopay(data, billingAccountId));
  }

  discountRule(context: MembershipLifecycleContext): Promise<SchoolPayDiscountRuleRead> {
    this.assertHumanContext(context, READ_FORBIDDEN, false);
    return this.read(context, 'SELECT hon.read_school_pay_discount_rule($1) AS data', [context.externalSubject], verifySchoolPayDiscountRuleRead);
  }

  async setDiscountRule(context: MembershipLifecycleContext, value: unknown): Receipt<SchoolPayDiscountRule> {
    this.assertHumanContext(context, DISCOUNT_FORBIDDEN, true);
    const input = this.validated(() => validateSetSchoolPayDiscountRuleInput(value));
    const result = await this.write(context, 'SELECT hon.set_school_pay_discount_rule($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data',
      [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId], verifySchoolPayDiscountRuleReceipt, DISCOUNT_FORBIDDEN);
    return { receipt: result.receipt.rule, replayed: result.replayed };
  }

  async enroll(context: MembershipLifecycleContext, billingAccountId: string, value: unknown): Receipt<SchoolPayAutopayPlan> {
    this.assertHumanContext(context, AUTOPAY_FORBIDDEN, true); this.assertId(billingAccountId);
    const input = this.validated(() => validateEnrollSchoolPayAutopayInput(value));
    return this.plan(context, 'hon.enroll_school_pay_autopay', billingAccountId, input, { billingAccountId, state: 'ACTIVE' });
  }

  changeMethod(context: MembershipLifecycleContext, planId: string, value: unknown): Receipt<SchoolPayAutopayPlan> {
    this.assertHumanContext(context, AUTOPAY_FORBIDDEN, true); this.assertId(planId);
    const input = this.validated(() => validateChangeSchoolPayAutopayMethodInput(value));
    return this.plan(context, 'hon.change_school_pay_autopay_method', planId, input, { planId });
  }

  setState(context: MembershipLifecycleContext, planId: string, value: unknown): Receipt<SchoolPayAutopayPlan> {
    this.assertHumanContext(context, AUTOPAY_FORBIDDEN, true); this.assertId(planId);
    const input = this.validated(() => validateSetSchoolPayAutopayStateInput(value));
    return this.plan(context, 'hon.set_school_pay_autopay_state', planId, input, { planId, state: input.state });
  }

  cancel(context: MembershipLifecycleContext, planId: string, value: unknown): Receipt<SchoolPayAutopayPlan> {
    this.assertHumanContext(context, AUTOPAY_FORBIDDEN, true); this.assertId(planId);
    const input = this.validated(() => validateCancelSchoolPayAutopayInput(value));
    return this.plan(context, 'hon.cancel_school_pay_autopay', planId, input, { planId, state: 'CANCELLED' });
  }

  async prepareCycle(context: MembershipLifecycleContext, planId: string, value: unknown): Receipt<SchoolPayAutopayCycle> {
    this.assertHumanContext(context, AUTOPAY_FORBIDDEN, true); this.assertId(planId);
    const input = this.validated(() => validatePrepareSchoolPayAutopayCycleInput(value));
    const result = await this.write(context, 'SELECT hon.prepare_school_pay_autopay_cycle($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
      [context.externalSubject, planId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
      data => verifySchoolPayAutopayCycleReceipt(data, { planId }), AUTOPAY_FORBIDDEN);
    if (result.receipt.cycle.cycleDate !== input.cycleDate) throw new Error('Unverified school autopay cycle.');
    return { receipt: result.receipt.cycle, replayed: result.replayed };
  }

  private async plan(context: MembershipLifecycleContext, fn: string, target: string, input: object,
    expect: { planId?: string; billingAccountId?: string; state?: SchoolPayAutopayPlan['state'] }): Receipt<SchoolPayAutopayPlan> {
    const result = await this.write(context, `SELECT ${fn}($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data`,
      [context.externalSubject, target, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
      data => verifySchoolPayAutopayPlanReceipt(data, expect), AUTOPAY_FORBIDDEN);
    return { receipt: result.receipt.plan, replayed: result.replayed };
  }

  private async read<T>(context: MembershipLifecycleContext, statement: string, values: unknown[], verify: (data: unknown) => T): Promise<T> {
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async (client: PoolClient) => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>(statement, values);
        if (result.rows.length !== 1) throw new Error('Unverified school autopay read.');
        return verify(result.rows[0]!.data);
      });
    } catch (error) { return translate(error, READ_FORBIDDEN); }
  }

  private async write<T>(context: MembershipLifecycleContext, statement: string, values: unknown[], verify: (data: unknown) => T, forbidden: string): Promise<{ receipt: T; replayed: boolean }> {
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: Record<string, unknown> }>(statement, values);
        const data = result.rows[0]?.data;
        if (result.rows.length !== 1 || !data || Object.keys(data).sort().join(',') !== 'receipt,replayed' || typeof data.replayed !== 'boolean') {
          throw new Error('Unverified school autopay receipt.');
        }
        return { receipt: verify(data.receipt), replayed: data.replayed };
      });
    } catch (error) { return translate(error, forbidden); }
  }

  private validated<T>(run: () => T): T {
    try { return run(); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
  }

  private assertId(id: string): void {
    if (!UUID.test(id)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  }

  private assertHumanContext(context: MembershipLifecycleContext, forbidden: string, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Autopay accepts only direct human commands.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 200) throw new ForbiddenException({ code: forbidden });
    if (!command) {
      if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
      return;
    }
    if (!context.idempotencyKey || context.idempotencyKey !== context.idempotencyKey.trim() || context.idempotencyKey.length > 200) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
  }
}
