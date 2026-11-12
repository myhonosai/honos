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
  validateFinishSchoolPayMethodSetupInput,
  validateRemoveSchoolPayMethodInput,
  validateSchoolPayMethodVersionInput,
  validateStartSchoolPayMethodSetupInput,
  verifySchoolPayExpiringMethods,
  verifySchoolPayMethodObservation,
  verifySchoolPayMethodReceipt,
  verifySchoolPayMethodRemoval,
  verifySchoolPayPayerMethods,
  verifySchoolPaySetupReceipt,
  type SchoolPayExpiringMethods,
  type SchoolPayMethodConnection,
  type SchoolPayMethodObservation,
  type SchoolPayMethodReceipt,
  type SchoolPayPayerMethods,
  type SchoolPayProviderCode,
  type SchoolPaySetupReceipt,
} from '@hon/contracts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { SCHOOL_PAYMENT_ADAPTERS, type SchoolPaymentAdapter } from './school-payment-adapter.js';
import { HUMAN_SETTINGS, READ_LIMITS, WRITE_LIMITS, translateSchoolPayError } from './school-payment.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORBIDDEN = 'SCHOOL_PAY_METHOD_FORBIDDEN';

// Exact 0265 error codes; every unknown database failure is unavailable, never success.
const ERRORS: Record<string, (code: string) => HttpException> = {
  VALIDATION_FAILED: code => new BadRequestException({ code }),
  SCHOOL_PAY_METHOD_FORBIDDEN: code => new ForbiddenException({ code }),
  SCHOOL_PAY_READ_FORBIDDEN: code => new ForbiddenException({ code }),
  SCHOOL_PAY_SETUP_STATE_MISMATCH: code => new ForbiddenException({ code, detail: 'This return link is not the latest one for this card setup. Start again.' }),
  SCHOOL_PAY_PAYER_NOT_FOUND: code => new NotFoundException({ code, detail: 'This payer is not in this school.' }),
  SCHOOL_PAY_SETUP_NOT_FOUND: code => new NotFoundException({ code, detail: 'This card setup is not available.' }),
  SCHOOL_PAY_METHOD_NOT_FOUND: code => new NotFoundException({ code, detail: 'This saved payment method is not available.' }),
  SCHOOL_PAY_CONNECTION_NOT_FOUND: code => new NotFoundException({ code, detail: 'The payment connection is not available in this school.' }),
  SCHOOL_PAY_METHODS_UNAVAILABLE: code => new UnprocessableEntityException({ code, detail: 'This payment connection cannot save this kind of payment method now.' }),
  SCHOOL_PAY_CUSTOMER_MISMATCH: code => new UnprocessableEntityException({ code, detail: 'The provider customer does not match this payer.' }),
  SCHOOL_PAY_SETUP_EXPIRED: code => new UnprocessableEntityException({ code, detail: 'This card setup expired. Start again.' }),
  SCHOOL_PAY_SCHOOL_TIME_ZONE_INVALID: code => new UnprocessableEntityException({ code, detail: 'The school time zone is not set.' }),
  SCHOOL_PAY_SETUP_STATE: code => new ConflictException({ code, detail: 'This card setup is already finished or replaced.' }),
  SCHOOL_PAY_METHOD_STATE: code => new ConflictException({ code, detail: 'This payment method was already removed.' }),
  SCHOOL_PAY_METHOD_ALREADY_DEFAULT: code => new ConflictException({ code, detail: 'This payment method is already the default.' }),
  SCHOOL_PAY_METHOD_EXISTS: code => new ConflictException({ code, detail: 'This payment method is already saved.' }),
  VERSION_CONFLICT: code => new ConflictException({ code, detail: 'This has changed. Reload it and try again with a new Idempotency-Key.' }),
  IDEMPOTENCY_KEY_REUSED: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different command.' }),
  IDEMPOTENCY_IN_PROGRESS: code => new ConflictException({ code, detail: 'The matching command is being processed.' }),
};
function translate(error: unknown, forbidden: string): never { return translateSchoolPayError(error, forbidden, ERRORS); }

export interface MethodSetupStart extends SchoolPaySetupReceipt { setupUrl: string | null }
export interface MethodRemovalResult extends SchoolPayMethodReceipt { providerDetached: boolean }

/**
 * B-TUI-2 piece 3 (0265): a payer's saved cards and US bank accounts at the school's own processor, test mode only.
 * The payer enters the card on the provider's hosted page; HON keeps the provider reference, brand, last four, expiry and
 * consent version only, from an authenticated provider retrieval. Every change is one protected definer command that
 * re-proves the direct human subject and the live school-scoped permission. Nothing here charges anyone; HON takes no fee.
 */
@Injectable()
export class SchoolPayMethodService {
  constructor(private readonly database: RuntimeDatabaseService,
    @Inject(SCHOOL_PAYMENT_ADAPTERS) private readonly adapters: Map<SchoolPayProviderCode, SchoolPaymentAdapter>) {}

  async payer(context: MembershipLifecycleContext, billingAccountId: string): Promise<SchoolPayPayerMethods> {
    this.assertHumanContext(context, 'SCHOOL_PAY_READ_FORBIDDEN', false);
    this.assertId(billingAccountId);
    return this.readPayer(context, billingAccountId, 'SCHOOL_PAY_READ_FORBIDDEN');
  }

  async expiring(context: MembershipLifecycleContext): Promise<SchoolPayExpiringMethods> {
    this.assertHumanContext(context, 'SCHOOL_PAY_READ_FORBIDDEN', false);
    return this.read(context, 'SELECT hon.read_school_pay_expiring_methods($1) AS data', [context.externalSubject], verifySchoolPayExpiringMethods, 'SCHOOL_PAY_READ_FORBIDDEN');
  }

  /**
   * Start a hosted setup: the payer's provider customer (created once), then a provider setup page that returns to HON with
   * a one-time state. The state goes only into the URL; the database keeps its SHA-256. A replay returns the stored setup
   * without a link (the earlier state is not kept), so the staff member starts again for a fresh link.
   */
  async start(context: MembershipLifecycleContext, billingAccountId: string, value: unknown, returnUrlFor: (setupId: string) => string): Promise<{ receipt: MethodSetupStart; replayed: boolean }> {
    this.assertHumanContext(context, FORBIDDEN, true);
    this.assertId(billingAccountId);
    const input = this.validated(() => validateStartSchoolPayMethodSetupInput(value));
    const view = await this.managedPayer(context, billingAccountId);
    const connection = this.connection(view, input.connectionId);
    if (input.methodKinds.includes('US_BANK_ACCOUNT') && !connection.bankDebit) {
      throw new UnprocessableEntityException({ code: 'SCHOOL_PAY_METHODS_UNAVAILABLE', detail: 'This payment connection cannot save this kind of payment method now.' });
    }
    const adapter = this.adapter(connection.providerCode);
    const setupId = randomUUID(), state = randomBytes(32).toString('base64url');
    let customerRef: string, setup: { setupRef: string; setupUrl: string };
    try {
      ({ customerRef } = await adapter.ensureCustomer({ accountRef: connection.accountRef, billingAccountId: view.billingAccountId, customerRef: connection.customerRef }));
      if (connection.customerRef !== null && customerRef !== connection.customerRef) throw new UnprocessableEntityException({ code: 'SCHOOL_PAY_CUSTOMER_MISMATCH' });
      setup = await adapter.beginMethodSetup({ accountRef: connection.accountRef, customerRef, setupId, methodKinds: input.methodKinds, state, returnUrl: returnUrlFor(setupId) });
    } catch (error) { return translate(error, FORBIDDEN); }
    const body = { billingAccountId: view.billingAccountId, connectionId: connection.connectionId, consentTextVersion: input.consentTextVersion, customerRef,
      methodKinds: input.methodKinds, setupId, setupRef: setup.setupRef, setupStateHash: createHash('sha256').update(state, 'utf8').digest('hex') };
    const result = await this.write(context, 'SELECT hon.start_school_pay_method_setup($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data',
      [context.externalSubject, JSON.stringify(body), context.idempotencyKey, context.requestId, context.correlationId],
      data => verifySchoolPaySetupReceipt(data, { billingAccountId: view.billingAccountId, connectionId: connection.connectionId }));
    return { receipt: { ...result.receipt, setupUrl: result.replayed ? null : setup.setupUrl }, replayed: result.replayed };
  }

  /** The payer came back from the provider page: retrieve the saved method from the provider, then record it. */
  async finish(context: MembershipLifecycleContext, billingAccountId: string, setupId: string, value: unknown): Promise<{ receipt: SchoolPayMethodReceipt; replayed: boolean }> {
    this.assertHumanContext(context, FORBIDDEN, true);
    this.assertId(billingAccountId); this.assertId(setupId);
    const input = this.validated(() => validateFinishSchoolPayMethodSetupInput(value));
    const view = await this.managedPayer(context, billingAccountId);
    const setup = view.setups.find(s => s.setupId === setupId.toLowerCase());
    if (!setup) throw new NotFoundException({ code: 'SCHOOL_PAY_SETUP_NOT_FOUND', detail: 'This card setup is not available.' });
    const connection = this.connection(view, setup.connectionId);
    if (connection.customerRef === null) throw new UnprocessableEntityException({ code: 'SCHOOL_PAY_CUSTOMER_MISMATCH' });
    let observation: SchoolPayMethodObservation;
    try {
      observation = verifySchoolPayMethodObservation(await this.adapter(connection.providerCode).retrieveMethodSetup({
        accountRef: connection.accountRef, customerRef: connection.customerRef, setupRef: setup.setupRef }));
    } catch (error) { return translate(error, FORBIDDEN); }
    const body = { expectedVersion: input.expectedVersion, observation, setupState: input.setupState };
    return this.write(context, 'SELECT hon.finish_school_pay_method_setup($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
      [context.externalSubject, setup.setupId, JSON.stringify(body), context.idempotencyKey, context.requestId, context.correlationId],
      data => verifySchoolPayMethodReceipt(data, { billingAccountId: view.billingAccountId, status: 'ACTIVE' }));
  }

  async setDefault(context: MembershipLifecycleContext, billingAccountId: string, methodId: string, value: unknown): Promise<{ receipt: SchoolPayMethodReceipt; replayed: boolean }> {
    this.assertHumanContext(context, FORBIDDEN, true);
    this.assertId(billingAccountId); this.assertId(methodId);
    const input = this.validated(() => validateSchoolPayMethodVersionInput(value));
    await this.payerMethod(context, billingAccountId, methodId);
    return this.write(context, 'SELECT hon.set_default_school_pay_method($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
      [context.externalSubject, methodId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
      data => verifySchoolPayMethodReceipt(data, { methodId, billingAccountId, status: 'ACTIVE' }));
  }

  /** Removes the method in HON first, then asks the provider to detach it (reported, never assumed). */
  async remove(context: MembershipLifecycleContext, billingAccountId: string, methodId: string, value: unknown): Promise<{ receipt: MethodRemovalResult; replayed: boolean }> {
    this.assertHumanContext(context, FORBIDDEN, true);
    this.assertId(billingAccountId); this.assertId(methodId);
    const input = this.validated(() => validateRemoveSchoolPayMethodInput(value));
    const view = await this.payerMethod(context, billingAccountId, methodId);
    let removal!: ReturnType<typeof verifySchoolPayMethodRemoval>;
    const result = await this.write(context, 'SELECT hon.remove_school_pay_method($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
      [context.externalSubject, methodId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
      data => { removal = verifySchoolPayMethodRemoval(data, { methodId, billingAccountId }); return { method: removal.method }; });
    let providerDetached = false;
    const connection = view.connections.find(c => c.connectionId === removal.connectionId);
    const adapter = connection ? this.adapters.get(connection.providerCode as SchoolPayProviderCode) : undefined;
    if (connection && adapter && adapter.providerCode === connection.providerCode) {
      try { await adapter.detachMethod({ accountRef: connection.accountRef, methodRef: removal.providerMethodRef }); providerDetached = true; } catch { providerDetached = false; }
    }
    // The provider reference never leaves the API.
    return { receipt: { method: result.receipt.method, providerDetached }, replayed: result.replayed };
  }

  private async managedPayer(context: MembershipLifecycleContext, billingAccountId: string): Promise<SchoolPayPayerMethods> {
    const view = await this.readPayer({ ...context, idempotencyKey: '' }, billingAccountId, FORBIDDEN);
    if (!view.canManage) throw new ForbiddenException({ code: FORBIDDEN });
    return view;
  }

  private async payerMethod(context: MembershipLifecycleContext, billingAccountId: string, methodId: string): Promise<SchoolPayPayerMethods> {
    const view = await this.managedPayer(context, billingAccountId);
    if (!view.methods.some(m => m.methodId === methodId.toLowerCase())) throw new NotFoundException({ code: 'SCHOOL_PAY_METHOD_NOT_FOUND', detail: 'This saved payment method is not available.' });
    return view;
  }

  private connection(view: SchoolPayPayerMethods, connectionId: string): SchoolPayMethodConnection {
    const connection = view.connections.find(c => c.connectionId === connectionId.toLowerCase());
    if (!connection) throw new UnprocessableEntityException({ code: 'SCHOOL_PAY_METHODS_UNAVAILABLE', detail: 'This payment connection cannot save this kind of payment method now.' });
    return connection;
  }

  private adapter(code: string): SchoolPaymentAdapter {
    const adapter = this.adapters.get(code as SchoolPayProviderCode);
    if (!adapter || adapter.providerCode !== code || adapter.readiness() !== 'READY') {
      throw new ServiceUnavailableException({ code: 'SCHOOL_PAY_PROVIDER_NOT_CONFIGURED', detail: 'This payment provider is not set up in this environment.' });
    }
    return adapter;
  }

  private readPayer(context: MembershipLifecycleContext, billingAccountId: string, forbidden: string): Promise<SchoolPayPayerMethods> {
    return this.read(context, 'SELECT hon.read_school_pay_payer_methods($1,$2::uuid) AS data', [context.externalSubject, billingAccountId],
      data => verifySchoolPayPayerMethods(data, billingAccountId), forbidden);
  }

  private async read<T>(context: MembershipLifecycleContext, statement: string, values: unknown[], verify: (data: unknown) => T, forbidden: string): Promise<T> {
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async (client: PoolClient) => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>(statement, values);
        if (result.rows.length !== 1) throw new Error('Unverified school payment methods.');
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
          throw new Error('Unverified school payment method receipt.');
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
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Saved payment methods accept only direct human commands.' });
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
