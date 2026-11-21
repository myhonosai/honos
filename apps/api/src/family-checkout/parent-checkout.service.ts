import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  validateFamilyCheckoutOrderId,
  validateOpenParentCheckoutOrderInput,
  verifyFamilyCheckoutOrder,
  verifyParentCheckoutOrderResult,
  verifyParentCheckoutOrderStart,
  verifyParentCheckoutPages,
  type FamilyCheckoutOrder,
  type FamilyCheckoutPayState,
  type ParentCheckoutOrderResult,
  type ParentCheckoutOrderStart,
  type ParentCheckoutPages,
  type SchoolPayProviderCode,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { SchoolPayOnceService } from '../school-payments/school-pay-once.service.js';

const LIST = 'SELECT hon.read_parent_checkout_pages($1::text) AS data';
const OPEN = 'SELECT hon.open_parent_checkout_order($1::text,$2::jsonb,$3::text) AS data';
const LATEST = 'SELECT hon.read_parent_checkout_order($1::text,$2::uuid) AS data';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROVIDERS = ['STRIPE_CONNECT', 'SQUARE'] as const;
const PAY_STATES = ['OPEN', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELED'] as const;

// Exact 0598/0529 refusals; every other database failure is unavailable, never success.
const KNOWN: Record<string, () => HttpException> = {
  FAMILY_CHECKOUT_FORBIDDEN: () => new ForbiddenException({ code: 'FAMILY_CHECKOUT_FORBIDDEN', detail: 'Current guardian family access is required.' }),
  FAMILY_CHECKOUT_NOT_FOUND: () => new NotFoundException({ code: 'FAMILY_CHECKOUT_NOT_FOUND', detail: 'This page or order is not available.' }),
  FAMILY_CHECKOUT_CHANGED: () => new ConflictException({ code: 'FAMILY_CHECKOUT_CHANGED', detail: 'This page changed. Refresh and try again.' }),
  FAMILY_CHECKOUT_OPTION_UNAVAILABLE: () => new ConflictException({ code: 'FAMILY_CHECKOUT_OPTION_UNAVAILABLE', detail: 'This option is no longer available.' }),
  FAMILY_CHECKOUT_FULL: () => new ConflictException({ code: 'FAMILY_CHECKOUT_FULL', detail: 'There are not enough places left.' }),
  FAMILY_CHECKOUT_WAIVER_REQUIRED: () => new UnprocessableEntityException({ code: 'FAMILY_CHECKOUT_WAIVER_REQUIRED', detail: 'Please accept the waiver first.' }),
  FAMILY_CHECKOUT_RATE_LIMITED: () => new HttpException({ code: 'FAMILY_CHECKOUT_RATE_LIMITED', detail: 'Too many orders today. Please try again tomorrow.' }, 429),
  IDEMPOTENCY_KEY_REUSED: () => new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', detail: 'The idempotency key was already used for a different order.' }),
  SCHOOL_PAY_ONCE_NOT_AVAILABLE: () => new UnprocessableEntityException({ code: 'FAMILY_CHECKOUT_PAY_NOT_AVAILABLE', detail: 'Your school cannot take a card payment in the app right now.' }),
  VALIDATION_FAILED: () => new BadRequestException({ code: 'VALIDATION_FAILED' }),
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const message = (error as { message?: string })?.message ?? '';
  const sqlState = (error as { code?: string })?.code ?? '';
  if (KNOWN[message] && ['22023', '42501', 'P0002', '40001', '53400', '23505'].includes(sqlState)) throw KNOWN[message]!();
  if (sqlState === '42501') throw KNOWN.FAMILY_CHECKOUT_FORBIDDEN!();
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'FAMILY_CHECKOUT_CONFLICT', detail: 'Please try again.' });
  throw new ServiceUnavailableException({ code: 'FAMILY_CHECKOUT_UNAVAILABLE', detail: 'Checkout is not available right now.' });
}

/**
 * 0598: a signed-in guardian orders a one-time option of one of the school's published checkout pages for their own
 * children and pays on the school's own processor page (HOSTED, the shared one-time payment 0529), TEST mode only.
 * Who, what and how much are decided by the database from the verified session; the app names only a page, its
 * version, an option, children, answers and add-ons it read here. The payment id is taken only from the guardian's own
 * scoped order read (0529 caller rule) and never leaves the API. The database settles the order on the processor's answer.
 */
@Injectable()
export class ParentCheckoutService {
  constructor(private readonly database: RuntimeDatabaseService, private readonly once: SchoolPayOnceService) {}

  /** Where the processor page returns to: a fixed page on the HON site (no data in the address). */
  returnUrl(): string {
    const origin = process.env.HON_PUBLIC_ORIGIN;
    if (!origin || !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      throw new ServiceUnavailableException({ code: 'FAMILY_CHECKOUT_NOT_CONFIGURED', detail: 'Payments are not set up here.' });
    }
    return `${origin}/parent/payment-return`;
  }

  async list(subject: string): Promise<ParentCheckoutPages> {
    const raw = await this.call(LIST, [subject]) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Unverified parent checkout pages.');
    const provider = raw.providerCode === null ? null : PROVIDERS.find(p => p === raw.providerCode);
    if (provider === undefined) throw new Error('Unverified parent checkout pages.');
    const { providerCode: _provider, ...rest } = raw;
    return verifyParentCheckoutPages({ ...rest, canPay: provider !== null && this.once.supports(provider as SchoolPayProviderCode, 'HOSTED'), testMode: true });
  }

  /** Places the order (an exact repeat under the same key returns it again) and opens its processor page when not free. */
  async order(subject: string, value: unknown, key: string): Promise<ParentCheckoutOrderStart> {
    let input;
    try { input = validateOpenParentCheckoutOrderInput(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    if (typeof key !== 'string' || !key || key.trim() !== key || key.length > 200) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
    // Checked before anything is written, so NOT_CONFIGURED is a definite no the app can show as such.
    const returnUrl = this.returnUrl();
    const opened = await this.call(OPEN, [subject, JSON.stringify(input), key]) as { orderId?: unknown };
    if (!opened || typeof opened.orderId !== 'string' || !UUID.test(opened.orderId)) throw new Error('Unverified parent checkout order.');
    return this.pay(subject, opened.orderId, returnUrl);
  }

  /** Gets back (or opens) the processor page of an unpaid order. A payment that may have been paid is checked first. */
  async start(subject: string, orderId: unknown): Promise<ParentCheckoutOrderStart> {
    const id = this.orderId(orderId);
    return this.pay(subject, id, this.returnUrl());
  }

  /** The processor's answer for the order's payment, recorded (the database then settles the order). */
  async confirm(subject: string, orderId: unknown): Promise<ParentCheckoutOrderResult> {
    const id = this.orderId(orderId);
    const latest = await this.latest(subject, id);
    if (!latest.paymentId) return verifyParentCheckoutOrderResult({ order: latest.order, payState: 'NONE' });
    const state = (await this.once.confirm(latest.paymentId)).state;
    return verifyParentCheckoutOrderResult({ order: (await this.latest(subject, id)).order, payState: state });
  }

  /** Close the order's open processor page; the processor decides CANCELED, or SUCCEEDED when it was already paid. */
  async cancel(subject: string, orderId: unknown): Promise<ParentCheckoutOrderResult> {
    const id = this.orderId(orderId);
    const latest = await this.latest(subject, id);
    if (!latest.paymentId) return verifyParentCheckoutOrderResult({ order: latest.order, payState: 'NONE' });
    const state = (await this.once.cancel(latest.paymentId)).state;
    return verifyParentCheckoutOrderResult({ order: (await this.latest(subject, id)).order, payState: state });
  }

  private async pay(subject: string, orderId: string, returnUrl: string): Promise<ParentCheckoutOrderStart> {
    let latest = await this.latest(subject, orderId);
    const answer = (payState: FamilyCheckoutPayState, page: { url: string; expiresAt: string } | null = null) => verifyParentCheckoutOrderStart({
      orderId, status: latest.order.status, payState, amountMinor: latest.order.amountMinor, currency: latest.order.currency,
      url: page?.url ?? null, expiresAt: page?.expiresAt ?? null,
    });
    if (!latest.paymentId) return answer('NONE');
    let state: FamilyCheckoutPayState = latest.paymentState!;
    if (state === 'OPEN' || state === 'PROCESSING') state = (await this.once.confirm(latest.paymentId)).state;
    if (state !== 'OPEN') { latest = await this.latest(subject, orderId); return answer(state); }
    const page = await this.once.start(latest.paymentId, { surface: 'HOSTED', returnUrl });
    if (!page.url) throw new Error('Unverified parent checkout payment page.');
    return answer('OPEN', { url: page.url, expiresAt: page.expiresAt });
  }

  private orderId(value: unknown): string {
    try { return validateFamilyCheckoutOrderId(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
  }
  private async latest(subject: string, orderId: string): Promise<{ order: FamilyCheckoutOrder; paymentId: string | null; paymentState: FamilyCheckoutPayState | null }> {
    const raw = await this.call(LATEST, [subject, orderId]) as { order?: unknown; paymentId?: unknown; paymentState?: unknown };
    if (!raw || typeof raw !== 'object') throw new Error('Unverified parent checkout order.');
    const order = verifyFamilyCheckoutOrder(raw.order);
    if (order.orderId !== orderId) throw new Error('Unverified parent checkout order.');
    if (raw.paymentId === null && raw.paymentState === null) return { order, paymentId: null, paymentState: null };
    if (typeof raw.paymentId !== 'string' || !UUID.test(raw.paymentId) || !PAY_STATES.includes(raw.paymentState as typeof PAY_STATES[number])) {
      throw new Error('Unverified parent checkout order.');
    }
    return { order, paymentId: raw.paymentId, paymentState: raw.paymentState as FamilyCheckoutPayState };
  }
  private async call(statement: string, values: unknown[]): Promise<unknown> {
    try { return await this.database.runParentCheckoutCall(statement, values); } catch (error) { return translate(error); }
  }
}
