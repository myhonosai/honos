import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  validateParentInvoiceId,
  verifyParentInvoicePayResult,
  verifyParentInvoicePayStart,
  verifyParentInvoicePayments,
  type ParentInvoicePayOutcome,
  type ParentInvoicePayResult,
  type ParentInvoicePayStart,
  type ParentInvoicePayments,
  type SchoolPayProviderCode,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { SchoolPayOnceService } from '../school-payments/school-pay-once.service.js';

const LIST = 'SELECT hon.read_parent_invoice_payments($1::text) AS data';
const LATEST = 'SELECT hon.read_parent_invoice_payment($1::text,$2::uuid) AS data';
const OPEN = 'SELECT hon.open_parent_invoice_payment($1::text,$2::uuid) AS data';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROVIDERS = ['STRIPE_CONNECT', 'SQUARE'] as const;
const STATES = ['OPEN', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELED'] as const;

// Exact 0530/0529 refusals; every other database failure is unavailable, never success.
const KNOWN: Record<string, () => HttpException> = {
  PARENT_INVOICE_PAY_FORBIDDEN: () => new ForbiddenException({ code: 'PARENT_INVOICE_PAY_FORBIDDEN', detail: 'Current guardian family access is required.' }),
  PARENT_INVOICE_PAY_NOT_FOUND: () => new NotFoundException({ code: 'PARENT_INVOICE_PAY_NOT_FOUND', detail: 'This invoice is not available.' }),
  PARENT_INVOICE_PAY_NOT_PAYABLE: () => new ConflictException({ code: 'PARENT_INVOICE_PAY_NOT_PAYABLE', detail: 'This invoice has nothing left to pay.' }),
  PARENT_INVOICE_PAY_AUTOPAY_IN_PROGRESS: () => new ConflictException({ code: 'PARENT_INVOICE_PAY_AUTOPAY_IN_PROGRESS', detail: 'Your school is already charging this invoice.' }),
  SCHOOL_PAY_ONCE_EXISTS: () => new ConflictException({ code: 'PARENT_INVOICE_PAY_IN_PROGRESS', detail: 'A payment for this invoice is already in progress.' }),
  SCHOOL_PAY_ONCE_AMOUNT_MISMATCH: () => new ConflictException({ code: 'PARENT_INVOICE_PAY_CHANGED', detail: 'This invoice changed. Refresh and try again.' }),
  SCHOOL_PAY_ONCE_NOT_AVAILABLE: () => new UnprocessableEntityException({ code: 'PARENT_INVOICE_PAY_NOT_AVAILABLE', detail: 'Your school cannot take a card payment in the app right now.' }),
  VALIDATION_FAILED: () => new BadRequestException({ code: 'VALIDATION_FAILED' }),
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const message = (error as { message?: string })?.message ?? '';
  const sqlState = (error as { code?: string })?.code ?? '';
  if (KNOWN[message] && ['22023', '42501', 'P0002', '40001'].includes(sqlState)) throw KNOWN[message]!();
  if (sqlState === '42501') throw KNOWN.PARENT_INVOICE_PAY_FORBIDDEN!();
  if (['40001', '40P01', '55P03'].includes(sqlState)) throw new ConflictException({ code: 'PARENT_INVOICE_PAY_CONFLICT', detail: 'Please try again.' });
  throw new ServiceUnavailableException({ code: 'PARENT_INVOICE_PAY_UNAVAILABLE', detail: 'Payments are not available right now.' });
}

/**
 * 0530: the signed-in guardian pays an invoice's open balance on the school's own processor page (HOSTED), TEST mode
 * only. Who may pay and how much are decided by the database from the verified session; the app names only an invoice
 * it read here. The payment id is taken only from the guardian's own scoped read (0529 caller rule) and never leaves
 * the API. The processor's answer is recorded by SchoolPayOnceService; the database then pays the invoice.
 */
@Injectable()
export class ParentInvoicePayService {
  constructor(private readonly database: RuntimeDatabaseService, private readonly once: SchoolPayOnceService) {}

  /** Where the processor page returns to: a fixed page on the HON site (no data in the address). */
  returnUrl(): string {
    const origin = process.env.HON_PUBLIC_ORIGIN;
    if (!origin || !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      throw new ServiceUnavailableException({ code: 'PARENT_INVOICE_PAY_NOT_CONFIGURED', detail: 'Payments are not set up here.' });
    }
    return `${origin}/parent/payment-return`;
  }

  async list(subject: string): Promise<ParentInvoicePayments> {
    const raw = await this.call(LIST, [subject]) as { providerCode: unknown; invoices: unknown };
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.invoices)) throw new Error('Unverified parent invoice list.');
    const provider = raw.providerCode === null ? null : PROVIDERS.find(p => p === raw.providerCode);
    if (provider === undefined) throw new Error('Unverified parent invoice list.');
    const canPay = provider !== null && this.once.supports(provider as SchoolPayProviderCode, 'HOSTED');
    return verifyParentInvoicePayments({
      canPay, testMode: true,
      invoices: raw.invoices.map((item: Record<string, unknown>) => {
        const payState = item.payState;
        const balance = item.balanceMinor;
        return {
          invoiceId: item.invoiceId, childName: item.participantName, currency: item.currency, totalMinor: item.totalMinor, balanceMinor: balance,
          dueAt: item.dueAt, payState,
          payable: canPay && item.status === 'ISSUED' && typeof balance === 'number' && balance > 0 && (payState === 'NONE' || payState === 'OPEN')
            && item.autopayInProgress === false,
        };
      }),
    });
  }

  /** Opens (or gets back) the payment and its processor page. A payment that may have been paid is checked first. */
  async start(subject: string, invoiceId: unknown): Promise<ParentInvoicePayStart> {
    const invoice = this.invoice(invoiceId);
    // Checked before anything is read or opened, so NOT_CONFIGURED is a definite no the app can show as such.
    const returnUrl = this.returnUrl();
    const latest = await this.latest(subject, invoice);
    if (latest && (latest.state === 'OPEN' || latest.state === 'PROCESSING')) {
      const checked = await this.once.confirm(latest.paymentId);
      if (checked.state === 'PROCESSING' || checked.state === 'SUCCEEDED') {
        return verifyParentInvoicePayStart({ state: checked.state, url: null, expiresAt: null, amountMinor: checked.amountMinor, currency: checked.currency });
      }
    }
    const opened = await this.call(OPEN, [subject, invoice]) as { paymentId?: unknown; amountMinor?: unknown; currency?: unknown };
    if (!opened || typeof opened.paymentId !== 'string' || !UUID.test(opened.paymentId)) throw new Error('Unverified parent invoice payment.');
    const page = await this.once.start(opened.paymentId, { surface: 'HOSTED', returnUrl });
    return verifyParentInvoicePayStart({ state: 'OPEN', url: page.url, expiresAt: page.expiresAt, amountMinor: opened.amountMinor, currency: opened.currency });
  }

  /** The processor's answer for the invoice's latest payment, recorded (the database pays the invoice on SUCCEEDED). */
  async confirm(subject: string, invoiceId: unknown): Promise<ParentInvoicePayResult> {
    const latest = await this.latest(subject, this.invoice(invoiceId));
    if (!latest) return verifyParentInvoicePayResult({ state: 'NONE' });
    return verifyParentInvoicePayResult({ state: (await this.once.confirm(latest.paymentId)).state });
  }

  /** Close the invoice's open payment page; the processor decides CANCELED, or SUCCEEDED when it was already paid. */
  async cancel(subject: string, invoiceId: unknown): Promise<ParentInvoicePayResult> {
    const latest = await this.latest(subject, this.invoice(invoiceId));
    if (!latest) return verifyParentInvoicePayResult({ state: 'NONE' });
    return verifyParentInvoicePayResult({ state: (await this.once.cancel(latest.paymentId)).state });
  }

  private invoice(value: unknown): string {
    try { return validateParentInvoiceId(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
  }
  private async latest(subject: string, invoice: string): Promise<{ paymentId: string; state: ParentInvoicePayOutcome } | null> {
    const raw = await this.call(LATEST, [subject, invoice]) as { paymentId?: unknown; state?: unknown };
    if (!raw || typeof raw !== 'object') throw new Error('Unverified parent invoice payment.');
    if (raw.paymentId === null && raw.state === null) return null;
    if (typeof raw.paymentId !== 'string' || !UUID.test(raw.paymentId) || !STATES.includes(raw.state as typeof STATES[number])) throw new Error('Unverified parent invoice payment.');
    return { paymentId: raw.paymentId, state: raw.state as ParentInvoicePayOutcome };
  }
  private async call(statement: string, values: unknown[]): Promise<unknown> {
    try { return await this.database.runParentInvoicePayCall(statement, values); } catch (error) { return translate(error); }
  }
}
