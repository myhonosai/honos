import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  validateReceivablesQuery,
  validateRecordTuitionPaymentInput,
  validateSchoolInvoiceListQuery,
  validateVoidTuitionPaymentInput,
  verifyInvoicePayments,
  verifySchoolInvoiceList,
  verifySchoolReceivables,
  verifyTuitionPaymentReceipt,
  type InvoicePayments,
  type ReceivablesQuery,
  type SchoolInvoiceList,
  type SchoolInvoiceListQuery,
  type SchoolReceivables,
  type TuitionPaymentReceipt,
} from '@hon/contracts';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from './membership.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const WRITE_LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";

// Exact 0240 error codes; every unknown database failure is unavailable, never success.
const TUITION_ERRORS: Record<string, (code: string) => HttpException> = {
  VALIDATION_FAILED: code => new BadRequestException({ code }),
  INVOICE_PAYMENT_RECORD_FORBIDDEN: code => new ForbiddenException({ code }),
  TUITION_RECEIVABLES_FORBIDDEN: code => new ForbiddenException({ code }),
  INVOICE_NOT_FOUND: code => new NotFoundException({ code, detail: 'The invoice is not available in this school.' }),
  INVOICE_PAYMENT_NOT_FOUND: code => new NotFoundException({ code, detail: 'The recorded payment is not available in this school.' }),
  INVOICE_NOT_PAYABLE: code => new ConflictException({ code, detail: 'Payments can be recorded only against an issued invoice.' }),
  INVOICE_CURRENCY_MISMATCH: code => new UnprocessableEntityException({ code, detail: 'The payment currency must match the invoice currency.' }),
  INVOICE_PAYMENT_EXCEEDS_BALANCE: code => new UnprocessableEntityException({ code, detail: 'The payment is more than the invoice\'s remaining balance.' }),
  INVOICE_PAYMENT_ALREADY_VOIDED: code => new ConflictException({ code, detail: 'This payment was already voided.' }),
  VERSION_CONFLICT: code => new ConflictException({ code, detail: 'The invoice has changed. Reload it and try again with a new Idempotency-Key.' }),
  IDEMPOTENCY_KEY_REUSED: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different command.' }),
  IDEMPOTENCY_IN_PROGRESS: code => new ConflictException({ code, detail: 'The matching command is being processed.' }),
  SCHOOL_TIMEZONE_INVALID: code => new ConflictException({ code, detail: 'The school timezone is not a valid IANA timezone.' }),
};
function translateTuitionError(error: unknown, forbidden: string): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = TUITION_ERRORS[message];
  if (known && ['22023', '42501', 'P0002', '40001', '23505'].includes(sqlState)) throw known(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: forbidden });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'TUITION_PAYMENT_CONFLICT' });
  if (['22023', '22P02', '22003', '22007', '22008'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'TUITION_PAYMENTS_UNAVAILABLE' });
}

/**
 * B-TUI-1 (0240): record and void tuition payments the school received outside HON, and read unpaid balances. Each call
 * runs one protected definer function that re-proves the direct human subject and the live school-scoped permission;
 * the runtime has no privilege on the payment record table. Nothing here charges, refunds, contacts a provider, sends a
 * communication or runs an automation.
 */
@Injectable()
export class TuitionPaymentService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async receivables(context: MembershipLifecycleContext, value: unknown): Promise<SchoolReceivables> {
    this.assertHumanContext(context, 'TUITION_RECEIVABLES_FORBIDDEN', false);
    const query: ReceivablesQuery = this.validated(() => validateReceivablesQuery(value));
    return this.read(context, 'TUITION_RECEIVABLES_FORBIDDEN', async client => {
      const result = await client.query<{ data: unknown }>('SELECT hon.read_school_receivables($1,$2::jsonb) AS data', [context.externalSubject, JSON.stringify(query)]);
      if (result.rows.length !== 1) throw new Error('Unverified receivables.');
      return verifySchoolReceivables(result.rows[0]!.data, query);
    });
  }

  /** B-TUI-1b (0280): the school's invoices, every status or one, newest first. Same readers as receivables. */
  async invoices(context: MembershipLifecycleContext, value: unknown): Promise<SchoolInvoiceList> {
    this.assertHumanContext(context, 'TUITION_RECEIVABLES_FORBIDDEN', false);
    const query: SchoolInvoiceListQuery = this.validated(() => validateSchoolInvoiceListQuery(value));
    return this.read(context, 'TUITION_RECEIVABLES_FORBIDDEN', async client => {
      const result = await client.query<{ data: unknown }>('SELECT hon.read_school_invoices($1,$2::jsonb) AS data', [context.externalSubject, JSON.stringify(query)]);
      if (result.rows.length !== 1) throw new Error('Unverified invoice list.');
      return verifySchoolInvoiceList(result.rows[0]!.data, query);
    });
  }

  async payments(context: MembershipLifecycleContext, invoiceId: string): Promise<InvoicePayments> {
    this.assertHumanContext(context, 'TUITION_RECEIVABLES_FORBIDDEN', false);
    this.assertId(invoiceId);
    return this.read(context, 'TUITION_RECEIVABLES_FORBIDDEN', async client => {
      const result = await client.query<{ data: unknown }>('SELECT hon.read_invoice_payments($1,$2::uuid) AS data', [context.externalSubject, invoiceId]);
      if (result.rows.length !== 1) throw new Error('Unverified invoice payments.');
      return verifyInvoicePayments(result.rows[0]!.data, invoiceId);
    });
  }

  async record(context: MembershipLifecycleContext, invoiceId: string, value: unknown): Promise<{ receipt: TuitionPaymentReceipt; replayed: boolean }> {
    this.assertHumanContext(context, 'INVOICE_PAYMENT_RECORD_FORBIDDEN', true);
    this.assertId(invoiceId);
    const input = this.validated(() => validateRecordTuitionPaymentInput(value));
    return this.write(context, 'SELECT hon.record_invoice_payment($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
      [context.externalSubject, invoiceId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
      data => verifyTuitionPaymentReceipt(data, { invoiceId, voided: false }));
  }

  async void(context: MembershipLifecycleContext, paymentId: string, value: unknown): Promise<{ receipt: TuitionPaymentReceipt; replayed: boolean }> {
    this.assertHumanContext(context, 'INVOICE_PAYMENT_RECORD_FORBIDDEN', true);
    this.assertId(paymentId);
    const input = this.validated(() => validateVoidTuitionPaymentInput(value));
    return this.write(context, 'SELECT hon.void_invoice_payment($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
      [context.externalSubject, paymentId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
      data => verifyTuitionPaymentReceipt(data, { paymentId, voided: true }));
  }

  private async read<T>(context: MembershipLifecycleContext, forbidden: string, run: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        return run(client);
      });
    } catch (error) { return translateTuitionError(error, forbidden); }
  }

  private async write(context: MembershipLifecycleContext, statement: string, values: unknown[],
    verify: (data: unknown) => TuitionPaymentReceipt): Promise<{ receipt: TuitionPaymentReceipt; replayed: boolean }> {
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: Record<string, unknown> }>(statement, values);
        const data = result.rows[0]?.data;
        if (result.rows.length !== 1 || !data || Object.keys(data).sort().join(',') !== 'receipt,replayed' || typeof data.replayed !== 'boolean') {
          throw new Error('Unverified tuition payment receipt.');
        }
        return { receipt: verify(data.receipt), replayed: data.replayed };
      });
    } catch (error) { return translateTuitionError(error, 'INVOICE_PAYMENT_RECORD_FORBIDDEN'); }
  }

  private validated<T>(run: () => T): T {
    try { return run(); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
  }

  private assertId(id: string): void {
    if (!UUID.test(id)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  }

  private assertHumanContext(context: MembershipLifecycleContext, forbidden: string, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Tuition payment records accept only direct human commands.' });
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
