import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  SCHOOL_PAY_CHARGE_OPEN_STATES,
  validateStartSchoolPayChargeInput,
  verifySchoolPayChargeContext,
  verifySchoolPayChargeObservation,
  verifySchoolPayChargeReceipt,
  verifySchoolPayPayerCharges,
  type SchoolPayChargeAttempt,
  type SchoolPayChargeContext,
  type SchoolPayChargeObservation,
  type SchoolPayPayerCharges,
  type SchoolPayProviderCode,
} from '@hon/contracts';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { SCHOOL_PAYMENT_ADAPTERS, SchoolPaymentProviderError, type SchoolPaymentAdapter } from './school-payment-adapter.js';
import { HUMAN_SETTINGS, READ_LIMITS, WRITE_LIMITS, translateSchoolPayError } from './school-payment.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORBIDDEN = 'SCHOOL_PAY_AUTOPAY_FORBIDDEN';
const READ_FORBIDDEN = 'SCHOOL_PAY_READ_FORBIDDEN';
/** Stripe keeps idempotency keys for 24 hours; a resend is only safe well inside that window. */
const RESEND_WINDOW_MS = 23 * 60 * 60 * 1000;

// Exact 0337 error codes; every unknown database failure is unavailable, never success.
const ERRORS: Record<string, (code: string) => HttpException> = {
  VALIDATION_FAILED: code => new BadRequestException({ code }),
  SCHOOL_PAY_AUTOPAY_FORBIDDEN: code => new ForbiddenException({ code }),
  SCHOOL_PAY_READ_FORBIDDEN: code => new ForbiddenException({ code }),
  SCHOOL_PAY_PAYER_NOT_FOUND: code => new NotFoundException({ code, detail: 'This payer is not in this school.' }),
  SCHOOL_PAY_CYCLE_NOT_FOUND: code => new NotFoundException({ code, detail: 'This autopay cycle is not available.' }),
  SCHOOL_PAY_CHARGE_NOT_FOUND: code => new NotFoundException({ code, detail: 'This charge is not available.' }),
  SCHOOL_PAY_AUTOPAY_METHOD_UNUSABLE: code => new UnprocessableEntityException({ code, detail: 'This saved payment method cannot be used for autopay now.' }),
  SCHOOL_PAY_CHARGE_AMOUNT_MISMATCH: code => new UnprocessableEntityException({ code, detail: 'The amount does not match this cycle. Reload it and check the total.' }),
  SCHOOL_PAY_SCHOOL_TIME_ZONE_INVALID: code => new UnprocessableEntityException({ code, detail: 'The school time zone is not set.' }),
  SCHOOL_PAY_AUTOPAY_STATE: code => new ConflictException({ code, detail: 'This autopay plan is paused or cancelled.' }),
  SCHOOL_PAY_CHARGE_EXISTS: code => new ConflictException({ code, detail: 'This cycle already has a charge that is paid or still open.' }),
  SCHOOL_PAY_CHARGE_INVOICES_CHANGED: code => new ConflictException({ code, detail: 'An invoice of this cycle changed or has a recorded payment. Review the invoices first.' }),
  SCHOOL_PAY_CHARGE_STATE: code => new ConflictException({ code, detail: 'This charge is already settled.' }),
  SCHOOL_PAY_CHARGE_REF_MISMATCH: code => new ConflictException({ code, detail: 'The processor answered for a different charge. Nothing was recorded.' }),
  VERSION_CONFLICT: code => new ConflictException({ code, detail: 'This has changed. Reload it and try again with a new Idempotency-Key.' }),
  IDEMPOTENCY_KEY_REUSED: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different command.' }),
  IDEMPOTENCY_IN_PROGRESS: code => new ConflictException({ code, detail: 'The matching command is being processed.' }),
};
function translate(error: unknown, forbidden: string): never { return translateSchoolPayError(error, forbidden, ERRORS); }

type Receipt<T> = Promise<{ receipt: T; replayed: boolean }>;

/**
 * B-TUI-2 piece 5a (0337): charging one prepared autopay cycle with the payer's saved method, test mode only. The charge
 * is three steps: a database command writes a PENDING attempt; the processor is called with the attempt's idempotency
 * key; a second command records the processor's answer (SUCCEEDED pays the cycle invoices). A crash or a lost answer
 * leaves the attempt open, and reconcile settles it from the processor's own record, never from a guess. A charge that
 * never reached the processor is FAILED NOT_SENT, so the cycle can be charged again. HON takes no fee.
 */
@Injectable()
export class SchoolPayChargeService {
  constructor(private readonly database: RuntimeDatabaseService,
    @Inject(SCHOOL_PAYMENT_ADAPTERS) private readonly adapters: Map<SchoolPayProviderCode, SchoolPaymentAdapter>) {}

  payer(context: MembershipLifecycleContext, billingAccountId: string): Promise<SchoolPayPayerCharges> {
    this.assertHumanContext(context, READ_FORBIDDEN, false); this.assertId(billingAccountId);
    return this.read(context, 'SELECT hon.read_school_pay_autopay_charges($1,$2::uuid) AS data', [context.externalSubject, billingAccountId],
      data => verifySchoolPayPayerCharges(data, billingAccountId), READ_FORBIDDEN);
  }

  /**
   * Charge one cycle. A replay of the same request returns the attempt as it stands; when the earlier request stopped
   * between the processor call and the record, the processor's own record settles it first.
   */
  async charge(context: MembershipLifecycleContext, cycleId: string, value: unknown): Receipt<SchoolPayChargeAttempt> {
    this.assertHumanContext(context, FORBIDDEN, true); this.assertId(cycleId);
    const input = this.validated(() => validateStartSchoolPayChargeInput(value));
    const begun = await this.write(context, 'SELECT hon.begin_school_pay_charge($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
      [context.externalSubject, cycleId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
      data => verifySchoolPayChargeReceipt(data, { cycleId }));
    const started = begun.receipt.attempt;
    if (started.amountMinor !== input.totalMinor || started.currency !== input.currency) throw new Error('Unverified school charge.');
    const current = await this.context(context, started.attemptId);
    // Only the request that wrote this attempt records its first answer; anything later is reconcile's job.
    if (current.attempt.state !== 'PENDING') return { receipt: current.attempt, replayed: begun.replayed };
    const observation = await this.observe(current, !begun.replayed);
    const finished = await this.finish(context, current.attempt, observation, this.derivedKey(context.idempotencyKey, 'finish'));
    return { receipt: finished.receipt, replayed: begun.replayed };
  }

  /** Settle an open attempt (PENDING after a crash, PROCESSING, UNKNOWN) from the processor's own record. */
  async reconcile(context: MembershipLifecycleContext, attemptId: string, value: unknown): Receipt<SchoolPayChargeAttempt> {
    this.assertHumanContext(context, FORBIDDEN, true); this.assertId(attemptId);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const current = await this.context(context, attemptId);
    if (!SCHOOL_PAY_CHARGE_OPEN_STATES.includes(current.attempt.state)) {
      throw new ConflictException({ code: 'SCHOOL_PAY_CHARGE_STATE', detail: 'This charge is already settled.' });
    }
    const observation = await this.observe(current, false);
    return this.finish(context, current.attempt, observation, context.idempotencyKey);
  }

  /**
   * The processor's answer for one attempt. `fresh`: this request just wrote the attempt, so nothing can have been sent
   * yet. Otherwise the processor's record is looked up first; a resend (same idempotency key) only happens inside the
   * key window, and an attempt the processor never saw after that window is FAILED NOT_SENT.
   */
  private async observe({ attempt, provider }: SchoolPayChargeContext, fresh: boolean): Promise<SchoolPayChargeObservation> {
    const expect = { amountMinor: attempt.amountMinor, currency: attempt.currency };
    // A provider with no test credentials here cannot have been called by this request: nothing was sent.
    if (fresh && !this.ready(provider.providerCode)) return { outcome: 'FAILED', chargeRef: null, failureClass: 'NOT_SENT', ...expect };
    const adapter = this.adapter(provider.providerCode);
    const unknown: SchoolPayChargeObservation = { outcome: 'UNKNOWN', chargeRef: null, failureClass: null, ...expect };
    if (!fresh) {
      let found: SchoolPayChargeObservation | null;
      try {
        found = await adapter.findCharge({ accountRef: provider.accountRef, customerRef: provider.customerRef, attemptId: attempt.attemptId, ...expect, createdAt: attempt.createdAt });
      } catch (error) { return this.fromProviderError(error, unknown, expect); }
      if (found) return verifySchoolPayChargeObservation(found, expect);
      if (attempt.state !== 'PENDING' && attempt.state !== 'UNKNOWN') return unknown;
      if (Date.now() - Date.parse(attempt.createdAt) >= RESEND_WINDOW_MS) return { outcome: 'FAILED', chargeRef: null, failureClass: 'NOT_SENT', ...expect };
    }
    try {
      return verifySchoolPayChargeObservation(await adapter.chargeOffSession({ accountRef: provider.accountRef, customerRef: provider.customerRef,
        methodRef: provider.methodRef, methodKind: provider.methodKind, attemptId: attempt.attemptId, ...expect }), expect);
    } catch (error) { return this.fromProviderError(error, unknown, expect); }
  }

  /** PRE_SEND: nothing reached the processor (FAILED NOT_SENT). FAILED: it refused the request. Anything else: UNKNOWN. */
  private fromProviderError(error: unknown, unknown: SchoolPayChargeObservation, expect: { amountMinor: number; currency: string }): SchoolPayChargeObservation {
    if (error instanceof SchoolPaymentProviderError && error.outcome === 'PRE_SEND') return { outcome: 'FAILED', chargeRef: null, failureClass: 'NOT_SENT', ...expect };
    if (error instanceof SchoolPaymentProviderError && error.outcome === 'FAILED') return { outcome: 'FAILED', chargeRef: null, failureClass: 'OTHER', ...expect };
    return unknown;
  }

  private async finish(context: MembershipLifecycleContext, attempt: SchoolPayChargeAttempt, observation: SchoolPayChargeObservation, key: string): Receipt<SchoolPayChargeAttempt> {
    const body = {
      expectedVersion: attempt.version, outcome: observation.outcome, amountMinor: observation.amountMinor, currency: observation.currency,
      ...(observation.chargeRef !== null ? { chargeRef: observation.chargeRef } : {}), ...(observation.failureClass !== null ? { failureClass: observation.failureClass } : {}),
    };
    const result = await this.write({ ...context, idempotencyKey: key }, 'SELECT hon.finish_school_pay_charge($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
      [context.externalSubject, attempt.attemptId, JSON.stringify(body), key, context.requestId, context.correlationId],
      data => verifySchoolPayChargeReceipt(data, { attemptId: attempt.attemptId, cycleId: attempt.cycleId }));
    return { receipt: result.receipt.attempt, replayed: result.replayed };
  }

  private context(context: MembershipLifecycleContext, attemptId: string): Promise<SchoolPayChargeContext> {
    return this.read({ ...context, idempotencyKey: '' }, 'SELECT hon.read_school_pay_charge_attempt($1,$2::uuid) AS data', [context.externalSubject, attemptId],
      data => verifySchoolPayChargeContext(data, attemptId), FORBIDDEN);
  }

  /** The finish command's own key, derived from the request's key so a replayed request reuses it. */
  private derivedKey(key: string, step: string): string {
    return `charge-${step}-${createHash('sha256').update(`${key}\u0000${step}`, 'utf8').digest('hex')}`;
  }

  private ready(code: string): boolean {
    const adapter = this.adapters.get(code as SchoolPayProviderCode);
    return !!adapter && adapter.providerCode === code && adapter.readiness() === 'READY';
  }

  private adapter(code: string): SchoolPaymentAdapter {
    const adapter = this.adapters.get(code as SchoolPayProviderCode);
    if (!adapter || adapter.providerCode !== code || adapter.readiness() !== 'READY') {
      throw new ServiceUnavailableException({ code: 'SCHOOL_PAY_PROVIDER_NOT_CONFIGURED', detail: 'This payment provider is not set up in this environment. The charge stays open; reconcile it later.' });
    }
    return adapter;
  }

  private async read<T>(context: MembershipLifecycleContext, statement: string, values: unknown[], verify: (data: unknown) => T, forbidden: string): Promise<T> {
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async (client: PoolClient) => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>(statement, values);
        if (result.rows.length !== 1) throw new Error('Unverified school charge read.');
        return verify(result.rows[0]!.data);
      });
    } catch (error) { return translate(error, forbidden); }
  }

  private async write<T>(context: MembershipLifecycleContext, statement: string, values: unknown[], verify: (data: unknown) => T): Promise<{ receipt: T; replayed: boolean }> {
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: Record<string, unknown> }>(statement, values);
        const data = result.rows[0]?.data;
        if (result.rows.length !== 1 || !data || Object.keys(data).sort().join(',') !== 'receipt,replayed' || typeof data.replayed !== 'boolean') {
          throw new Error('Unverified school charge receipt.');
        }
        return { receipt: verify(data.receipt), replayed: data.replayed };
      });
    } catch (error) { return translate(error, FORBIDDEN); }
  }

  private validated<T>(run: () => T): T {
    try { return run(); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
  }

  private assertId(id: string): void {
    if (!UUID.test(id)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  }

  private assertHumanContext(context: MembershipLifecycleContext, forbidden: string, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Autopay charges accept only direct human commands.' });
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
