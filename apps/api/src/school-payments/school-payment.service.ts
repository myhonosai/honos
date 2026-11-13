import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  NO_SCHOOL_PAY_CAPABILITIES,
  narrowSchoolPayCapabilities,
  validateDisconnectSchoolPayInput,
  validateFinishSchoolPayOnboardingInput,
  validateSchoolPayVersionInput,
  validateStartSchoolPayConnectionInput,
  verifySchoolPayConnectionReceipt,
  verifySchoolPayObservation,
  verifySchoolPaymentProcessors,
  type SchoolPayConnection,
  type SchoolPayConnectionReceipt,
  type SchoolPayConnectionState,
  type SchoolPayObservation,
  type SchoolPayProviderCode,
  type SchoolPaymentProcessors,
} from '@hon/contracts';
import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { SCHOOL_PAYMENT_ADAPTERS, SchoolPaymentProviderError, type SchoolPaymentAdapter } from './school-payment-adapter.js';
import { SCHOOL_PAYMENT_VAULT, type SchoolPayCredential, type SchoolPaymentVault } from './school-payment-vault.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const WRITE_LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";
const RECORD_STATUS = 'SELECT hon.record_school_payment_status($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data';
const RECORD_STATUS_WITH_CREDENTIAL = 'SELECT hon.record_school_payment_status_with_credential($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data';
const CONNECTED: readonly SchoolPayConnectionState[] = ['CONNECTED_RESTRICTED', 'CONNECTED_ACTIVE', 'REAUTHORIZATION_REQUIRED'];

// Exact 0258 error codes; every unknown database failure is unavailable, never success.
const ERRORS: Record<string, (code: string) => HttpException> = {
  VALIDATION_FAILED: code => new BadRequestException({ code }),
  SCHOOL_PAY_MANAGE_FORBIDDEN: code => new ForbiddenException({ code }),
  SCHOOL_PAY_READ_FORBIDDEN: code => new ForbiddenException({ code }),
  SCHOOL_PAY_ONBOARDING_STATE_MISMATCH: code => new ForbiddenException({ code, detail: 'This return link is not the latest one for this connection. Start the connection again.' }),
  SCHOOL_PAY_CONNECTION_NOT_FOUND: code => new NotFoundException({ code, detail: 'The payment connection is not available in this school.' }),
  SCHOOL_PAY_PROVIDER_UNAVAILABLE: code => new UnprocessableEntityException({ code, detail: 'This payment provider is not available.' }),
  SCHOOL_PAY_CONNECTION_EXISTS: code => new ConflictException({ code, detail: 'This school already has an open connection to this provider.' }),
  SCHOOL_PAY_CONNECTION_STATE: code => new ConflictException({ code, detail: 'The connection is not in a state that allows this.' }),
  SCHOOL_PAY_ALREADY_DEFAULT: code => new ConflictException({ code, detail: 'This connection is already the default.' }),
  SCHOOL_PAY_ACCOUNT_MISMATCH: code => new UnprocessableEntityException({ code, detail: 'The provider account does not match this connection.' }),
  SCHOOL_PAY_ACCOUNT_LINKED_ELSEWHERE: code => new ConflictException({ code, detail: 'This provider account is already connected to another organization.' }),
  VERSION_CONFLICT: code => new ConflictException({ code, detail: 'The connection has changed. Reload it and try again with a new Idempotency-Key.' }),
  IDEMPOTENCY_KEY_REUSED: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different command.' }),
  IDEMPOTENCY_IN_PROGRESS: code => new ConflictException({ code, detail: 'The matching command is being processed.' }),
  SCHOOL_PAY_CREDENTIAL_CONFLICT: code => new ConflictException({ code, detail: 'The connection changed while it was being checked. Try again.' }),
  SCHOOL_PAY_CREDENTIAL_NOT_FOUND: code => new ConflictException({ code, detail: 'HON no longer has access to this account. Disconnect it and connect again.' }),
  SCHOOL_PAY_CREDENTIAL_REQUIRED: code => new ServiceUnavailableException({ code, detail: 'The provider did not give HON access to the account. Start the connection again.' }),
};
const CREDENTIAL_UNAVAILABLE = () => new ServiceUnavailableException({ code: 'SCHOOL_PAY_CREDENTIAL_UNAVAILABLE', detail: 'HON cannot use the saved access to this account here. Disconnect it and connect again.' });
function translate(error: unknown, forbidden: string): never {
  if (error instanceof HttpException) throw error;
  if (error instanceof SchoolPaymentProviderError) {
    if (error.reason === 'NOT_CONFIGURED') throw new ServiceUnavailableException({ code: 'SCHOOL_PAY_PROVIDER_NOT_CONFIGURED', detail: 'This payment provider is not set up in this environment.' });
    if (error.outcome === 'UNKNOWN') throw new ServiceUnavailableException({ code: 'SCHOOL_PAY_PROVIDER_UNKNOWN', detail: 'The payment provider did not answer. Try again.' });
    if (error.outcome === 'FAILED') throw new BadGatewayException({ code: 'SCHOOL_PAY_PROVIDER_REJECTED', detail: 'The payment provider refused the request.' });
    throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  }
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = ERRORS[message];
  if (known && ['22023', '42501', 'P0002', '40001', '23505', '23514'].includes(sqlState)) throw known(message);
  if (message === 'SCHOOL_PAY_VAULT_REFUSED') throw CREDENTIAL_UNAVAILABLE();
  if (sqlState === '42501') throw new ForbiddenException({ code: forbidden });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'SCHOOL_PAY_CONFLICT' });
  if (['22023', '22P02', '22003', '22007', '22008'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'SCHOOL_PAYMENTS_UNAVAILABLE' });
}

export interface OnboardingLinkResult extends SchoolPayConnectionReceipt { onboardingUrl: string | null }

/**
 * B-TUI-2 piece 1 (0258): the school's own Stripe/Square connections, test mode only. Provider calls go through the
 * school payment adapters only; every state change is one protected definer command that re-proves the direct human
 * subject and the live school-scoped permission. Nothing here charges, refunds, stores a card or token, or messages anyone.
 */
@Injectable()
export class SchoolPaymentService {
  constructor(private readonly database: RuntimeDatabaseService,
    @Inject(SCHOOL_PAYMENT_ADAPTERS) private readonly adapters: Map<SchoolPayProviderCode, SchoolPaymentAdapter>,
    @Optional() @Inject(SCHOOL_PAYMENT_VAULT) private readonly vault: SchoolPaymentVault | null = null) {}

  async processors(context: MembershipLifecycleContext): Promise<SchoolPaymentProcessors> {
    this.assertHumanContext(context, 'SCHOOL_PAY_READ_FORBIDDEN', false);
    return this.readProcessors(context, 'SCHOOL_PAY_READ_FORBIDDEN');
  }

  async start(context: MembershipLifecycleContext, value: unknown): Promise<{ receipt: SchoolPayConnectionReceipt; replayed: boolean }> {
    this.assertHumanContext(context, 'SCHOOL_PAY_MANAGE_FORBIDDEN', true);
    const input = this.validated(() => validateStartSchoolPayConnectionInput(value));
    if (this.adapter(input.providerCode).readiness() !== 'READY') return translate(new SchoolPaymentProviderError('PRE_SEND', 'NOT_CONFIGURED'), 'SCHOOL_PAY_MANAGE_FORBIDDEN');
    return this.write(context, 'SELECT hon.start_school_payment_connection($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data',
      [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
      data => verifySchoolPayConnectionReceipt(data, { providerCode: input.providerCode, states: ['PENDING_ONBOARDING'] }));
  }

  /** A fresh hosted onboarding link. The one-time state goes only into the URL; the database keeps its SHA-256. */
  async onboardingLink(context: MembershipLifecycleContext, connectionId: string, value: unknown, returnUrl: string): Promise<{ receipt: OnboardingLinkResult; replayed: boolean }> {
    this.assertHumanContext(context, 'SCHOOL_PAY_MANAGE_FORBIDDEN', true);
    this.assertId(connectionId);
    const input = this.validated(() => validateSchoolPayVersionInput(value));
    const connection = await this.openConnection(context, connectionId, ['PENDING_ONBOARDING']);
    const adapter = this.adapter(connection.providerCode);
    const state = randomBytes(32).toString('base64url');
    let link: { onboardingUrl: string; accountRef: string | null };
    try { link = await adapter.beginOnboarding({ connectionId: connection.connectionId, accountRef: connection.accountRef, state, returnUrl }); }
    catch (error) { return translate(error, 'SCHOOL_PAY_MANAGE_FORBIDDEN'); }
    const body = { expectedVersion: input.expectedVersion, onboardingStateHash: createHash('sha256').update(state, 'utf8').digest('hex'),
      ...(link.accountRef === null ? {} : { accountRef: link.accountRef }) };
    const result = await this.write(context, 'SELECT hon.set_school_payment_onboarding_link($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
      [context.externalSubject, connectionId, JSON.stringify(body), context.idempotencyKey, context.requestId, context.correlationId],
      data => verifySchoolPayConnectionReceipt(data, { connectionId, states: ['PENDING_ONBOARDING'] }));
    // A replay returns the stored receipt only: the earlier link's state is not kept, so ask for a new link instead.
    return { receipt: { ...result.receipt, onboardingUrl: result.replayed ? null : link.onboardingUrl }, replayed: result.replayed };
  }

  /** The school came back from the provider: exchange (Square) or confirm (Stripe), retrieve the status, then finish. */
  async finish(context: MembershipLifecycleContext, connectionId: string, value: unknown): Promise<{ receipt: SchoolPayConnectionReceipt; replayed: boolean }> {
    this.assertHumanContext(context, 'SCHOOL_PAY_MANAGE_FORBIDDEN', true);
    this.assertId(connectionId);
    const input = this.validated(() => validateFinishSchoolPayOnboardingInput(value));
    const connection = await this.openConnection(context, connectionId, ['PENDING_ONBOARDING']);
    const adapter = this.adapter(connection.providerCode);
    const vault = this.vaultFor(adapter);
    // A one-time provider code is spent only after the database confirms this return's state (0320 V4).
    if (vault) await this.checkOnboardingState(context, connectionId, input.expectedVersion, input.state);
    let observation: SchoolPayObservation;
    let credential: SchoolPayCredential | undefined;
    try {
      const completed = await adapter.completeOnboarding({ connectionId: connection.connectionId, accountRef: connection.accountRef,
        ...(input.authorizationCode === undefined ? {} : { authorizationCode: input.authorizationCode }) });
      credential = completed.credential;
      if (vault && !credential) throw new SchoolPaymentProviderError('UNKNOWN', 'PROVIDER_UNKNOWN');
      observation = this.narrowed(adapter, await adapter.retrieveStatus({ accountRef: completed.accountRef, ...(credential ? { credential } : {}) }));
    } catch (error) { return translate(error, 'SCHOOL_PAY_MANAGE_FORBIDDEN'); }
    const body: Record<string, unknown> = { expectedVersion: input.expectedVersion, kind: 'FINISH', onboardingState: input.state, observation };
    if (vault && credential) {
      // Sealed in memory and stored in the same transaction as the accepted finish (0320 V3); never logged or returned.
      body.credential = { keyId: vault.keyId, accessExpiresAt: credential.accessExpiresAt, expectedCredentialVersion: 0,
        sealed: vault.seal({ connectionId: connection.connectionId, providerCode: connection.providerCode, accountRef: observation.accountRef }, credential) };
    }
    return this.write(context, vault ? RECORD_STATUS_WITH_CREDENTIAL : RECORD_STATUS,
      [context.externalSubject, connectionId, JSON.stringify(body), context.idempotencyKey, context.requestId, context.correlationId],
      data => verifySchoolPayConnectionReceipt(data, { connectionId, states: CONNECTED }));
  }

  async refresh(context: MembershipLifecycleContext, connectionId: string, value: unknown): Promise<{ receipt: SchoolPayConnectionReceipt; replayed: boolean }> {
    this.assertHumanContext(context, 'SCHOOL_PAY_MANAGE_FORBIDDEN', true);
    this.assertId(connectionId);
    const input = this.validated(() => validateSchoolPayVersionInput(value));
    const connection = await this.openConnection(context, connectionId, CONNECTED);
    const adapter = this.adapter(connection.providerCode);
    const vault = this.vaultFor(adapter);
    const accountRef = connection.accountRef!;
    const binding = { connectionId: connection.connectionId, providerCode: connection.providerCode, accountRef };
    let observation: SchoolPayObservation;
    let rotated: { credential: SchoolPayCredential; expectedCredentialVersion: number } | null = null;
    let credential: SchoolPayCredential | undefined;
    let revoked = false;
    if (vault) {
      const stored = await this.readCredential(context, connectionId);
      if (stored.accountRef !== accountRef || stored.providerCode !== connection.providerCode) throw CREDENTIAL_UNAVAILABLE();
      try { credential = vault.open(binding, stored.keyId, stored.sealed); } catch { throw CREDENTIAL_UNAVAILABLE(); }
      if (adapter.needsRenewal?.(credential) && adapter.renewCredential) {
        try {
          credential = await adapter.renewCredential({ accountRef, credential });
          rotated = { credential, expectedCredentialVersion: stored.credentialVersion };
        } catch (error) {
          // The school withdrew HON's access: record reauthorization required (no rotation), so later work sees it.
          if (!(error instanceof SchoolPaymentProviderError && error.reason === 'GRANT_REVOKED')) return translate(error, 'SCHOOL_PAY_MANAGE_FORBIDDEN');
          revoked = true;
        }
      }
    }
    if (revoked) observation = verifySchoolPayObservation({ accountRef, chargesEnabled: false, payoutsEnabled: false, requirementsDue: true,
      reauthorizationRequired: true, capabilities: { ...NO_SCHOOL_PAY_CAPABILITIES } });
    else {
      try { observation = this.narrowed(adapter, await adapter.retrieveStatus({ accountRef, ...(credential ? { credential } : {}) })); }
      catch (error) { return translate(error, 'SCHOOL_PAY_MANAGE_FORBIDDEN'); }
    }
    const body: Record<string, unknown> = { expectedVersion: input.expectedVersion, kind: 'REFRESH', observation };
    if (vault && rotated) {
      body.credential = { keyId: vault.keyId, accessExpiresAt: rotated.credential.accessExpiresAt, expectedCredentialVersion: rotated.expectedCredentialVersion,
        sealed: vault.seal(binding, rotated.credential) };
    }
    return this.write(context, body.credential ? RECORD_STATUS_WITH_CREDENTIAL : RECORD_STATUS,
      [context.externalSubject, connectionId, JSON.stringify(body), context.idempotencyKey, context.requestId, context.correlationId],
      data => verifySchoolPayConnectionReceipt(data, { connectionId, states: CONNECTED }));
  }

  async setDefault(context: MembershipLifecycleContext, connectionId: string, value: unknown): Promise<{ receipt: SchoolPayConnectionReceipt; replayed: boolean }> {
    this.assertHumanContext(context, 'SCHOOL_PAY_MANAGE_FORBIDDEN', true);
    this.assertId(connectionId);
    const input = this.validated(() => validateSchoolPayVersionInput(value));
    return this.write(context, 'SELECT hon.set_default_school_payment_connection($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
      [context.externalSubject, connectionId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
      data => verifySchoolPayConnectionReceipt(data, { connectionId, states: ['CONNECTED_ACTIVE'] }));
  }

  /** Ends the connection in HON first, then asks the provider to revoke HON's access (reported, never assumed). */
  async disconnect(context: MembershipLifecycleContext, connectionId: string, value: unknown): Promise<{ receipt: SchoolPayConnectionReceipt; replayed: boolean; providerRevoked: boolean }> {
    this.assertHumanContext(context, 'SCHOOL_PAY_MANAGE_FORBIDDEN', true);
    this.assertId(connectionId);
    const input = this.validated(() => validateDisconnectSchoolPayInput(value));
    const result = await this.write(context, 'SELECT hon.disconnect_school_payment_connection($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
      [context.externalSubject, connectionId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
      data => verifySchoolPayConnectionReceipt(data, { connectionId, states: ['DISCONNECTED', 'ABANDONED'] }));
    const { connection } = result.receipt;
    let providerRevoked = false;
    if (connection.accountRef !== null) {
      // A provider revoke ends HON's access to the whole account, so it is skipped while another connection still uses it.
      try {
        if (!(await this.accountOpenElsewhere(context, connectionId))) {
          await this.adapter(connection.providerCode).disconnect({ accountRef: connection.accountRef }); providerRevoked = true;
        }
      } catch { providerRevoked = false; }
    }
    return { ...result, providerRevoked };
  }

  /** The vault when this provider keeps per-school credentials; such a provider without a vault is not configured. */
  private vaultFor(adapter: SchoolPaymentAdapter): SchoolPaymentVault | null {
    if (adapter.credentialKind !== 'OAUTH_TOKENS') return null;
    if (!this.vault) throw new ServiceUnavailableException({ code: 'SCHOOL_PAY_PROVIDER_NOT_CONFIGURED', detail: 'This payment provider is not set up in this environment.' });
    return this.vault;
  }

  private async readOnly<T>(context: MembershipLifecycleContext, statement: string, values: unknown[], verify: (data: unknown) => T): Promise<T> {
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async (client: PoolClient) => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>(statement, values);
        if (result.rows.length !== 1) throw new Error('Unverified school payment read.');
        return verify(result.rows[0]!.data);
      });
    } catch (error) { return translate(error, 'SCHOOL_PAY_MANAGE_FORBIDDEN'); }
  }

  private checkOnboardingState(context: MembershipLifecycleContext, connectionId: string, expectedVersion: number, onboardingState: string): Promise<void> {
    return this.readOnly(context, 'SELECT hon.check_school_payment_onboarding_state($1,$2::uuid,$3::jsonb) AS data',
      [context.externalSubject, connectionId, JSON.stringify({ expectedVersion, onboardingState })], data => {
        const row = data as Record<string, unknown> | null;
        if (!row || row.matches !== true || String(row.connectionId).toLowerCase() !== connectionId.toLowerCase()) throw new Error('Unverified onboarding state check.');
      });
  }

  private readCredential(context: MembershipLifecycleContext, connectionId: string): Promise<{ providerCode: string; accountRef: string; keyId: string; sealed: string; credentialVersion: number }> {
    return this.readOnly(context, 'SELECT hon.read_school_payment_credential($1,$2::uuid) AS data', [context.externalSubject, connectionId], data => {
      const row = data as Record<string, unknown> | null;
      if (!row || String(row.connectionId).toLowerCase() !== connectionId.toLowerCase() || typeof row.providerCode !== 'string' || typeof row.accountRef !== 'string'
        || typeof row.keyId !== 'string' || typeof row.sealed !== 'string' || !Number.isInteger(row.credentialVersion) || (row.credentialVersion as number) < 1) {
        throw new Error('Unverified school payment credential.');
      }
      return { providerCode: row.providerCode, accountRef: row.accountRef, keyId: row.keyId, sealed: row.sealed, credentialVersion: row.credentialVersion as number };
    });
  }

  private accountOpenElsewhere(context: MembershipLifecycleContext, connectionId: string): Promise<boolean> {
    return this.readOnly(context, 'SELECT hon.read_school_payment_account_use($1,$2::uuid) AS data', [context.externalSubject, connectionId], data => {
      const row = data as Record<string, unknown> | null;
      if (!row || typeof row.openElsewhere !== 'boolean') throw new Error('Unverified account use.');
      return row.openElsewhere;
    });
  }

  private narrowed(adapter: SchoolPaymentAdapter, value: unknown): SchoolPayObservation {
    const observation = verifySchoolPayObservation(value);
    return { ...observation, capabilities: narrowSchoolPayCapabilities(adapter.manifest, observation.capabilities) };
  }

  private adapter(code: string): SchoolPaymentAdapter {
    const adapter = this.adapters.get(code as SchoolPayProviderCode);
    if (!adapter || adapter.providerCode !== code) throw new ServiceUnavailableException({ code: 'SCHOOL_PAY_PROVIDER_NOT_CONFIGURED', detail: 'This payment provider is not set up in this environment.' });
    return adapter;
  }

  /** The open connection by id, read under the same live authority (the command re-checks everything under lock). */
  private async openConnection(context: MembershipLifecycleContext, connectionId: string, states: readonly SchoolPayConnectionState[]): Promise<SchoolPayConnection> {
    const view = await this.readProcessors({ ...context, idempotencyKey: '' }, 'SCHOOL_PAY_MANAGE_FORBIDDEN');
    if (!view.canManage) throw new ForbiddenException({ code: 'SCHOOL_PAY_MANAGE_FORBIDDEN' });
    const connection = view.connections.find(c => c.connectionId.toLowerCase() === connectionId.toLowerCase());
    if (!connection) throw new NotFoundException({ code: 'SCHOOL_PAY_CONNECTION_NOT_FOUND', detail: 'The payment connection is not available in this school.' });
    if (!states.includes(connection.state)) throw new ConflictException({ code: 'SCHOOL_PAY_CONNECTION_STATE', detail: 'The connection is not in a state that allows this.' });
    return connection;
  }

  private async readProcessors(context: MembershipLifecycleContext, forbidden: string): Promise<SchoolPaymentProcessors> {
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async (client: PoolClient) => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_school_payment_processors($1) AS data', [context.externalSubject]);
        if (result.rows.length !== 1) throw new Error('Unverified school payment processors.');
        return verifySchoolPaymentProcessors(result.rows[0]!.data);
      });
    } catch (error) { return translate(error, forbidden); }
  }

  private async write(context: MembershipLifecycleContext, statement: string, values: unknown[],
    verify: (data: unknown) => SchoolPayConnectionReceipt): Promise<{ receipt: SchoolPayConnectionReceipt; replayed: boolean }> {
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: Record<string, unknown> }>(statement, values);
        const data = result.rows[0]?.data;
        if (result.rows.length !== 1 || !data || Object.keys(data).sort().join(',') !== 'receipt,replayed' || typeof data.replayed !== 'boolean') {
          throw new Error('Unverified school payment receipt.');
        }
        return { receipt: verify(data.receipt), replayed: data.replayed };
      });
    } catch (error) { return translate(error, 'SCHOOL_PAY_MANAGE_FORBIDDEN'); }
  }

  private validated<T>(run: () => T): T {
    try { return run(); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
  }

  private assertId(id: string): void {
    if (!UUID.test(id)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  }

  private assertHumanContext(context: MembershipLifecycleContext, forbidden: string, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'School payment connections accept only direct human commands.' });
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
