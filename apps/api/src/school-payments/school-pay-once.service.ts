import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  SCHOOL_PAY_ONCE_SETTLED_STATES,
  SCHOOL_PAY_ONCE_SURFACES,
  validateSchoolPayOnceId,
  verifySchoolPayOnceContext,
  verifySchoolPayOnceDue,
  verifySchoolPayOnceObservation,
  verifySchoolPayOnceReceipt,
  type SchoolPayOnceContext,
  type SchoolPayOnceObservation,
  type SchoolPayOncePayment,
  type SchoolPayOnceResult,
  type SchoolPayOnceStart,
  type SchoolPayOnceState,
  type SchoolPayOnceSurface,
  type SchoolPayProviderCode,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { SCHOOL_PAYMENT_ADAPTERS, SchoolPaymentProviderError, type SchoolPaymentAdapter, type SchoolPayOnceSession } from './school-payment-adapter.js';
import { translateSchoolPayError } from './school-payment.service.js';

const READ = 'SELECT hon.read_school_pay_once($1::uuid) AS data';
const START = 'SELECT hon.start_school_pay_once($1::uuid,$2::jsonb) AS data';
const RECORD = 'SELECT hon.record_school_pay_once($1::uuid,$2::jsonb) AS data';
const DUE = 'SELECT hon.list_due_school_pay_once($1::integer) AS data';

// Exact 0462 error codes; every unknown database failure is unavailable, never success.
const ERRORS: Record<string, (code: string) => HttpException> = {
  VALIDATION_FAILED: code => new BadRequestException({ code }),
  SCHOOL_PAY_ONCE_NOT_FOUND: code => new NotFoundException({ code, detail: 'This payment is not available.' }),
  SCHOOL_PAY_ONCE_NOT_AVAILABLE: code => new UnprocessableEntityException({ code, detail: 'This school cannot take a card payment here now.' }),
  SCHOOL_PAY_ONCE_START_MISMATCH: code => new ConflictException({ code, detail: 'This payment was already started another way.' }),
  SCHOOL_PAY_ONCE_STATE: code => new ConflictException({ code, detail: 'This payment is already settled.' }),
  SCHOOL_PAY_ONCE_EXPIRED: code => new ConflictException({ code, detail: 'This payment has expired. Start a new one.' }),
  SCHOOL_PAY_ONCE_AMOUNT_MISMATCH: code => new ConflictException({ code, detail: 'The processor answered for a different amount. Nothing was recorded.' }),
  SCHOOL_PAY_ONCE_REF_MISMATCH: code => new ConflictException({ code, detail: 'The processor answered for a different payment. Nothing was recorded.' }),
};
function translate(error: unknown): never { return translateSchoolPayError(error, 'SCHOOL_PAY_ONCE_FORBIDDEN', ERRORS); }
const unavailable = (): never => {
  throw new ServiceUnavailableException({ code: 'SCHOOL_PAY_PROVIDER_UNKNOWN', detail: 'The payment provider did not answer. The payment stays as it is; try again.' });
};

/**
 * B-TUI-2 0462: the shared one-time payment, TEST/SANDBOX mode only, for callers that already opened a payment in their
 * own database function (checkout page, walk-in kiosk, point of sale). This service holds no authority of its own: a
 * caller's route decides who may ask, and it only ever records what the processor itself answers on retrieval.
 *   start   fixes the surface and return address once (before any provider call), then creates or gets back the provider
 *           session with the payment's idempotency key.
 *   confirm retrieves the session and records it; a payable session past the payment's expiry is expired at the
 *           processor first, so it can never be paid later unseen.
 *   cancel  expires the session at the processor and records what the processor then says (CANCELED, or SUCCEEDED when
 *           the payer had already paid), so a caller can switch to paying at the desk without a double charge.
 * HON takes no fee; no card data reaches HON.
 */
@Injectable()
export class SchoolPayOnceService {
  /** The API's clock for the payment's own expiry (the database checks its own clock as well). Tests may replace it. */
  now: () => number = Date.now;

  constructor(private readonly database: RuntimeDatabaseService,
    @Inject(SCHOOL_PAYMENT_ADAPTERS) private readonly adapters: Map<SchoolPayProviderCode, SchoolPaymentAdapter>) {}

  /** Whether `providerCode` can show a one-time payment on `surface` in this environment. */
  supports(providerCode: SchoolPayProviderCode, surface: SchoolPayOnceSurface): boolean {
    const adapter = this.adapters.get(providerCode);
    return !!adapter && adapter.providerCode === providerCode && adapter.readiness() === 'READY' && adapter.oneTimeSurfaces().includes(surface);
  }

  async start(paymentId: string, input: { surface: SchoolPayOnceSurface; returnUrl: string }): Promise<SchoolPayOnceStart> {
    const id = this.id(paymentId);
    if (!input || !SCHOOL_PAY_ONCE_SURFACES.includes(input.surface) || !this.returnUrlOk(input.returnUrl)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const current = await this.read(id);
    // Nothing is fixed in the database for a processor or surface that cannot be used here: nothing is sent either.
    if (!this.supports(current.payment.providerCode, input.surface)) {
      throw new UnprocessableEntityException({ code: 'SCHOOL_PAY_ONCE_SURFACE_UNSUPPORTED', detail: 'This payment cannot be shown this way here.' });
    }
    if (current.payment.state !== 'OPEN') throw new ConflictException({ code: 'SCHOOL_PAY_ONCE_STATE', detail: 'This payment is already settled.' });
    if (this.now() >= Date.parse(current.payment.expiresAt)) throw new ConflictException({ code: 'SCHOOL_PAY_ONCE_EXPIRED', detail: 'This payment has expired. Start a new one.' });
    const started = verifySchoolPayOnceContext(await this.call(START, [id, JSON.stringify({ surface: input.surface, returnUrl: input.returnUrl })]), id);
    if (started.payment.state !== 'OPEN') throw new ConflictException({ code: 'SCHOOL_PAY_ONCE_STATE', detail: 'This payment is already settled.' });
    let session: SchoolPayOnceSession;
    try { session = await this.begin(started); } catch (error) { return translate(error); }
    if (started.sessionRef !== null && session.sessionRef !== started.sessionRef) throw new ConflictException({ code: 'SCHOOL_PAY_ONCE_REF_MISMATCH' });
    const recorded = await this.record(started.payment, { outcome: 'OPEN', sessionRef: session.sessionRef, paymentRef: null, failureClass: null,
      amountMinor: started.payment.amountMinor, currency: started.payment.currency });
    if (recorded.state !== 'OPEN') throw new ConflictException({ code: 'SCHOOL_PAY_ONCE_STATE', detail: 'This payment is already settled.' });
    if ((input.surface === 'EMBEDDED') !== (session.clientSecret !== null) || (input.surface === 'HOSTED') !== (session.url !== null)) throw new Error('Unverified school one-time payment session.');
    return { paymentId: id, providerCode: started.payment.providerCode, surface: input.surface, clientSecret: session.clientSecret, url: session.url,
      accountRef: input.surface === 'EMBEDDED' ? started.provider.accountRef : null, expiresAt: started.payment.expiresAt };
  }

  /** The processor's answer for one payment, recorded. A payable session past the payment's expiry is closed first. */
  async confirm(paymentId: string): Promise<SchoolPayOnceResult> {
    const current = await this.read(this.id(paymentId));
    if (SCHOOL_PAY_ONCE_SETTLED_STATES.includes(current.payment.state)) return this.result(current.payment);
    const expired = this.now() >= Date.parse(current.payment.expiresAt);
    const sessionRef = await this.session(current);
    if (sessionRef === null) return expired ? this.result(await this.endWithoutSession(current, 'EXPIRED')) : this.result(current.payment);
    let observed = await this.find(current, sessionRef);
    if (observed.outcome === 'OPEN' && expired) {
      await this.expire(current, sessionRef);
      observed = await this.find(current, sessionRef);
      if (observed.outcome === 'OPEN') return unavailable();
    }
    return this.result(await this.record(current.payment, observed));
  }

  /** Close the payment so it can no longer be paid; the processor's own answer decides CANCELED or SUCCEEDED. */
  async cancel(paymentId: string): Promise<SchoolPayOnceResult> {
    const current = await this.read(this.id(paymentId));
    if (SCHOOL_PAY_ONCE_SETTLED_STATES.includes(current.payment.state)) return this.result(current.payment);
    if (current.payment.state === 'PROCESSING') throw new ConflictException({ code: 'SCHOOL_PAY_ONCE_IN_PROGRESS', detail: 'This payment is still being processed.' });
    const sessionRef = await this.session(current);
    if (sessionRef === null) return this.result(await this.endWithoutSession(current, 'CANCELED'));
    await this.expire(current, sessionRef);
    const observed = await this.find(current, sessionRef);
    if (observed.outcome === 'OPEN') return unavailable();
    return this.result(await this.record(current.payment, observed.outcome === 'EXPIRED' ? { ...observed, outcome: 'CANCELED' } : observed));
  }

  /** Settle every payment past its expiry that is still OPEN or PROCESSING (up to `limit`). One failure never stops the rest. */
  async reconcileDue(limit = 25): Promise<{ checked: number; settled: number; failed: number }> {
    const ids = verifySchoolPayOnceDue(await this.call(DUE, [limit]));
    let settled = 0, failed = 0;
    for (const id of ids) {
      try { if (SCHOOL_PAY_ONCE_SETTLED_STATES.includes((await this.confirm(id)).state)) settled += 1; } catch { failed += 1; }
    }
    return { checked: ids.length, settled, failed };
  }

  /**
   * The provider session of a started payment: the recorded one, or (when the earlier answer was lost) the same session
   * got back with the payment's idempotency key and recorded. null: never started, or the processor refused to create one.
   */
  private async session(current: SchoolPayOnceContext): Promise<string | null> {
    if (current.sessionRef !== null) return current.sessionRef;
    if (current.payment.surface === null) return null;
    let session: SchoolPayOnceSession;
    try { session = await this.begin(current); } catch (error) {
      if (error instanceof SchoolPaymentProviderError && (error.outcome === 'PRE_SEND' || error.outcome === 'FAILED') && error.reason !== 'NOT_CONFIGURED') return null;
      if (error instanceof SchoolPaymentProviderError && error.reason === 'NOT_CONFIGURED') return translate(error);
      return unavailable();
    }
    await this.record(current.payment, { outcome: 'OPEN', sessionRef: session.sessionRef, paymentRef: null, failureClass: null,
      amountMinor: current.payment.amountMinor, currency: current.payment.currency });
    return session.sessionRef;
  }

  private begin(context: SchoolPayOnceContext): Promise<SchoolPayOnceSession> {
    const { payment } = context;
    if (payment.surface === null || context.returnUrl === null || context.providerExpiresAt === null) throw new Error('Unverified school one-time payment start.');
    return this.adapter(payment.providerCode).beginOneTimePayment({ accountRef: context.provider.accountRef, paymentId: payment.paymentId,
      amountMinor: payment.amountMinor, currency: payment.currency, label: payment.label, payerEmail: context.payerEmail, surface: payment.surface,
      returnUrl: context.returnUrl, providerExpiresAt: context.providerExpiresAt });
  }

  private async find(context: SchoolPayOnceContext, sessionRef: string): Promise<SchoolPayOnceObservation> {
    const { payment } = context, expect = { amountMinor: payment.amountMinor, currency: payment.currency };
    try {
      return verifySchoolPayOnceObservation(await this.adapter(payment.providerCode).findOneTimePayment({ accountRef: context.provider.accountRef,
        paymentId: payment.paymentId, sessionRef, ...expect }), { ...expect, sessionRef });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof SchoolPaymentProviderError && error.reason === 'NOT_CONFIGURED') return translate(error);
      return unavailable();
    }
  }

  private async expire(context: SchoolPayOnceContext, sessionRef: string): Promise<void> {
    const { payment } = context;
    try {
      await this.adapter(payment.providerCode).expireOneTimePayment({ accountRef: context.provider.accountRef, paymentId: payment.paymentId, sessionRef,
        amountMinor: payment.amountMinor, currency: payment.currency });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof SchoolPaymentProviderError && error.reason === 'NOT_CONFIGURED') return translate(error);
      return unavailable();
    }
  }

  private endWithoutSession(context: SchoolPayOnceContext, outcome: 'EXPIRED' | 'CANCELED'): Promise<SchoolPayOncePayment> {
    return this.recordBody(context.payment, { outcome, amountMinor: context.payment.amountMinor, currency: context.payment.currency });
  }

  private record(payment: SchoolPayOncePayment, observation: Omit<SchoolPayOnceObservation, 'outcome'> & { outcome: SchoolPayOnceObservation['outcome'] | 'CANCELED' }): Promise<SchoolPayOncePayment> {
    return this.recordBody(payment, {
      outcome: observation.outcome, amountMinor: observation.amountMinor, currency: observation.currency, sessionRef: observation.sessionRef,
      ...(observation.paymentRef !== null ? { paymentRef: observation.paymentRef } : {}), ...(observation.failureClass !== null ? { failureClass: observation.failureClass } : {}),
    });
  }

  private async recordBody(payment: SchoolPayOncePayment, body: Record<string, unknown>): Promise<SchoolPayOncePayment> {
    if (body.amountMinor !== payment.amountMinor || body.currency !== payment.currency) {
      throw new ConflictException({ code: 'SCHOOL_PAY_ONCE_AMOUNT_MISMATCH', detail: 'The processor answered for a different amount. Nothing was recorded.' });
    }
    return verifySchoolPayOnceReceipt(await this.call(RECORD, [payment.paymentId, JSON.stringify(body)]), payment.paymentId).payment;
  }

  private async read(id: string): Promise<SchoolPayOnceContext> { return verifySchoolPayOnceContext(await this.call(READ, [id]), id); }

  private async call(statement: string, values: unknown[]): Promise<unknown> {
    try { return await this.database.runSchoolPayOnceCall(statement, values); } catch (error) { return translate(error); }
  }

  private result(payment: SchoolPayOncePayment): SchoolPayOnceResult {
    return { paymentId: payment.paymentId, state: payment.state as SchoolPayOnceState, amountMinor: payment.amountMinor, currency: payment.currency, settledAt: payment.settledAt };
  }

  private id(value: string): string {
    try { return validateSchoolPayOnceId(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
  }

  /** https, or http on this machine only (local development); no credentials, no fragment, at most 2000 characters. */
  private returnUrlOk(value: unknown): value is string {
    if (typeof value !== 'string' || value.length < 10 || value.length > 2000 || /[\s\x00-\x1f\x7f]/.test(value)) return false;
    let url: URL;
    try { url = new URL(value); } catch { return false; }
    if (url.username || url.password || url.hash) return false;
    return url.protocol === 'https:' || (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost'));
  }

  private adapter(code: SchoolPayProviderCode): SchoolPaymentAdapter {
    const adapter = this.adapters.get(code);
    if (!adapter || adapter.providerCode !== code || adapter.readiness() !== 'READY') throw new SchoolPaymentProviderError('PRE_SEND', 'NOT_CONFIGURED');
    return adapter;
  }
}
