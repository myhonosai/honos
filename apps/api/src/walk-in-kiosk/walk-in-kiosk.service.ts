import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { configuredPublicOrigin } from '@hon/auth';
import {
  validateEndWalkInDeviceInput, validateStartWalkInDeviceInput, validateWalkInDeskPaidInput, validateWalkInSettingsInput, verifyWalkInDeviceReceipt,
  verifyWalkInOverview, verifyWalkInSettingsRead, verifyWalkInSettingsReceipt, verifyWalkInTerminal, verifyWalkInVisitDetail, verifyWalkInVisitOutcome,
  verifyWalkInVisitReceipt, WALKIN_CARD_SURFACES, WALKIN_TOKEN,
  type SchoolPayProviderCode, type StartedWalkInDevice, type WalkInCardOutcome, type WalkInCardSurface, type WalkInDevice, type WalkInOverview, type WalkInSettings, type WalkInSettingsRead, type WalkInTerminal, type WalkInVisit,
  type WalkInVisitDetail, type WalkInVisitOutcome,
} from '@hon/contracts';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { SchoolPayOnceService } from '../school-payments/school-pay-once.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{16,100}$/;
const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const WRITE_LIMITS = "SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";

// Exact 0414 error codes; every unknown database failure is unavailable, never success.
const ERRORS: Record<string, (code: string) => HttpException> = {
  VALIDATION_FAILED: code => new BadRequestException({ code }),
  WALKIN_KIOSK_FORBIDDEN: code => new ForbiddenException({ code }),
  WALKIN_KIOSK_PIPELINE_INVALID: code => new UnprocessableEntityException({ code, detail: 'Choose a pipeline and stage of this school.' }),
  WALKIN_KIOSK_OFF: code => new ConflictException({ code, detail: 'Turn the walk-in kiosk on in its settings first.' }),
  WALKIN_KIOSK_DEVICE_LIMIT: code => new ConflictException({ code, detail: 'At most 10 tablets can run at once. End one first.' }),
  WALKIN_KIOSK_DEVICE_NOT_FOUND: code => new NotFoundException({ code, detail: 'That tablet is not in this school.' }),
  WALKIN_KIOSK_DEVICE_ENDED: code => new ConflictException({ code, detail: 'That tablet has already ended.' }),
  WALKIN_VISIT_NOT_FOUND: code => new NotFoundException({ code, detail: 'That walk-in is not in this school.' }),
  WALKIN_VISIT_NOT_DUE: code => new ConflictException({ code, detail: 'This walk-in has nothing to pay at the desk.' }),
  VERSION_CONFLICT: code => new ConflictException({ code, detail: 'This has changed. Reload it and try again.' }),
  IDEMPOTENCY_KEY_REUSED: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different command.' }),
  IDEMPOTENCY_IN_PROGRESS: code => new ConflictException({ code, detail: 'The matching command is being processed.' }),
  WALKIN_CARD_PAYMENT_OPEN: code => new ConflictException({ code, detail: 'A card payment for this walk-in is still open. Try again.' }),
  WALKIN_CARD_PAYMENT_IN_PROGRESS: code => new ConflictException({ code, detail: 'The card payment for this walk-in is still being processed. Try again in a minute.' }),
};
// 0533 tablet card calls: the three fixed definer functions (the payment id they return never leaves the API).
const CARD_PROVIDER = 'SELECT hon.read_walkin_card_provider($1) AS data';
const CARD_OPEN = 'SELECT hon.open_walkin_card_payment($1,$2) AS data';
const CARD_SETTLE = 'SELECT hon.settle_walkin_card_payment($1,$2) AS data';
const CARD_ROW_RESULTS = ['OPEN', 'PROCESSING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELED', 'NONE', 'NOT_DUE', 'NOT_AVAILABLE', 'NOT_FOUND', 'INVALID', 'CLOSED', 'RATE_LIMITED'] as const;
type CardRow = { result: (typeof CARD_ROW_RESULTS)[number]; paymentId: string | null; providerCode: SchoolPayProviderCode | null };
/** A definer card answer: exactly {result} or, for OPEN/PROCESSING, {result, paymentId[, providerCode]}. Anything else is unverified. */
function cardRow(value: unknown, withProvider: boolean): CardRow {
  const unverified = (): never => { throw new Error('Unverified walk-in card answer.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) unverified();
  const row = value as Record<string, unknown>;
  const result = CARD_ROW_RESULTS.find(entry => entry === row.result) ?? unverified();
  const live = result === 'OPEN' || result === 'PROCESSING';
  const keys = live ? (withProvider ? 'paymentId,providerCode,result' : 'paymentId,result') : 'result';
  if (Object.keys(row).sort().join(',') !== keys) unverified();
  if (live && (typeof row.paymentId !== 'string' || !UUID.test(row.paymentId))) unverified();
  if (live && withProvider && row.providerCode !== 'STRIPE_CONNECT' && row.providerCode !== 'SQUARE') unverified();
  return { result, paymentId: live ? row.paymentId as string : null, providerCode: live && withProvider ? row.providerCode as SchoolPayProviderCode : null };
}
const codeOf = (error: unknown): string | undefined => {
  const body = error instanceof HttpException ? error.getResponse() : null;
  return body && typeof body === 'object' ? (body as { code?: string }).code : undefined;
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = ERRORS[message];
  if (known && ['22023', '42501', 'P0002', '40001', '23505'].includes(sqlState)) throw known(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: 'WALKIN_KIOSK_FORBIDDEN' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'WALKIN_KIOSK_CONFLICT' });
  if (['22023', '22P02', '22003', '22007', '22008'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'WALKIN_KIOSK_UNAVAILABLE' });
}
/** The only form of a device token the database ever sees. */
export function walkInTokenDigest(token: string): string { return createHash('sha256').update(token, 'utf8').digest('hex'); }

/**
 * Walk-in kiosk (0414). Staff calls run one protected definer function that re-proves the direct human subject and live
 * walkin_kiosk.manage or walkin_kiosk.run; tablet calls run the two fixed public functions as the restricted runtime with only
 * the SHA-256 digest of the device token. No message, charge or AI.
 */
@Injectable()
export class WalkInKioskService {
  constructor(private readonly database: RuntimeDatabaseService, private readonly payOnce: SchoolPayOnceService) {}

  async overview(context: MembershipLifecycleContext): Promise<WalkInOverview> {
    this.assertHuman(context, false);
    return this.read(context, async client => verifyWalkInOverview(await this.one(client, 'SELECT hon.read_walkin_kiosk($1) AS data', [context.externalSubject])));
  }

  async settings(context: MembershipLifecycleContext): Promise<WalkInSettingsRead> {
    this.assertHuman(context, false);
    return this.read(context, async client => verifyWalkInSettingsRead(await this.one(client, 'SELECT hon.read_walkin_kiosk_settings($1) AS data', [context.externalSubject])));
  }

  async visit(context: MembershipLifecycleContext, visitId: string): Promise<WalkInVisitDetail> {
    this.assertHuman(context, false);
    if (!UUID.test(visitId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    return this.read(context, async client => verifyWalkInVisitDetail(await this.one(client, 'SELECT hon.read_walkin_visit($1,$2::uuid) AS data', [context.externalSubject, visitId]), visitId));
  }

  async saveSettings(context: MembershipLifecycleContext, value: unknown): Promise<{ receipt: { settings: WalkInSettings }; replayed: boolean }> {
    this.assertHuman(context, true);
    const input = this.validated(() => validateWalkInSettingsInput(value));
    return this.write(context, 'SELECT hon.save_walkin_kiosk_settings($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data',
      [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId], verifyWalkInSettingsReceipt);
  }

  /**
   * Starts a tablet. The token is made here and shown once; only its digest is stored. A replay of the same command returns the
   * device without a token (the first answer's token is never kept anywhere), so a lost answer means starting a new tablet.
   */
  async startDevice(context: MembershipLifecycleContext, value: unknown): Promise<{ receipt: StartedWalkInDevice; replayed: boolean }> {
    this.assertHuman(context, true);
    const input = this.validated(() => validateStartWalkInDeviceInput(value));
    const token = randomBytes(32).toString('base64url');
    const result = await this.write(context, 'SELECT hon.start_walkin_kiosk_device($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data',
      [context.externalSubject, JSON.stringify({ ...input, tokenDigest: walkInTokenDigest(token) }), context.idempotencyKey, context.requestId, context.correlationId],
      data => verifyWalkInDeviceReceipt(data));
    return { receipt: { device: result.receipt.device, token: result.replayed ? null : token }, replayed: result.replayed };
  }

  async endDevice(context: MembershipLifecycleContext, deviceId: string, value: unknown): Promise<{ receipt: { device: WalkInDevice }; replayed: boolean }> {
    this.assertHuman(context, true);
    if (!UUID.test(deviceId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const input = this.validated(() => validateEndWalkInDeviceInput(value));
    return this.write(context, 'SELECT hon.end_walkin_kiosk_device($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
      [context.externalSubject, deviceId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId], data => verifyWalkInDeviceReceipt(data, { deviceId }));
  }

  /**
   * Marks a walk-in paid at the desk (W4). 0533 K3: a card payment the tablet started is ended at the processor first
   * (cancel says SUCCEEDED when the visitor had already paid, and the database then marks the visit PAID_CARD instead), so
   * switching to the desk can never charge twice. The payment id comes only from this school's visit, read here.
   */
  async deskPaid(context: MembershipLifecycleContext, visitId: string, value: unknown): Promise<{ receipt: { visit: WalkInVisit }; replayed: boolean }> {
    this.assertHuman(context, true);
    if (!UUID.test(visitId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const input = this.validated(() => validateWalkInDeskPaidInput(value));
    const card = await this.read(context, async client => {
      const data = await this.one(client, 'SELECT hon.read_walkin_visit_card_payment($1,$2::uuid) AS data', [context.externalSubject, visitId]) as Record<string, unknown> | null;
      if (!data || Object.keys(data).sort().join(',') !== 'paymentId,providerOpen,state') throw new Error('Unverified walk-in card payment read.');
      if (data.paymentId === null) return null;
      if (typeof data.paymentId !== 'string' || !UUID.test(data.paymentId) || typeof data.state !== 'string' || typeof data.providerOpen !== 'boolean') {
        throw new Error('Unverified walk-in card payment read.');
      }
      return { paymentId: data.paymentId, state: data.state, providerOpen: data.providerOpen };
    });
    if (card?.state === 'OPEN' && card.providerOpen) await this.payOnce.cancel(card.paymentId);
    else if (card?.state === 'PROCESSING') await this.payOnce.confirm(card.paymentId);
    return this.write(context, 'SELECT hon.set_walkin_visit_desk_paid($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
      [context.externalSubject, visitId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId], data => verifyWalkInVisitReceipt(data, { visitId }));
  }

  /** Tablet read: null for any token that is not a live tablet. 0533: with the ways this school can take a card here now. */
  async terminal(value: unknown): Promise<WalkInTerminal | null> {
    const token = this.token(value, ['device']);
    if (!token) return null;
    let terminal: WalkInTerminal;
    try {
      const data = await this.database.runPublicEventCall('SELECT hon.read_walkin_kiosk_terminal($1) AS data', [walkInTokenDigest(token)]);
      if (data === null) return null;
      terminal = verifyWalkInTerminal(data);
    } catch { throw new ServiceUnavailableException({ result: 'UNAVAILABLE' }); }
    return { ...terminal, cardSurfaces: await this.cardSurfaces(token) };
  }

  /**
   * 0533 tablet: show the card payment for the visit this tablet just recorded (named by the key it was submitted with) on
   * `surface`. The payment is opened by the database at the frozen offer price; starting it again returns the same form.
   * Switching surface cancels the earlier one at the processor first (and an expired one is closed first), then opens anew.
   */
  async cardStart(value: unknown): Promise<WalkInCardOutcome> {
    const input = this.cardInput(value, true);
    if (!input) return { result: 'INVALID' };
    const surface = input.surface!;
    const back = this.returnUrl(surface);
    if (!back) return { result: 'UNAVAILABLE' };
    return this.card(async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const opened = cardRow(await this.database.runPublicEventCall(CARD_OPEN, [input.digest, input.key]), true);
        if (opened.result !== 'OPEN') return { result: opened.result };
        if (!this.payOnce.supports(opened.providerCode!, surface)) return { result: 'NOT_AVAILABLE' };
        try {
          const started = await this.payOnce.start(opened.paymentId!, { surface, returnUrl: back });
          return { result: 'READY', surface, clientSecret: started.clientSecret, url: started.url, accountRef: started.accountRef, expiresAt: started.expiresAt };
        } catch (error) {
          const code = codeOf(error);
          if (attempt === 0 && code === 'SCHOOL_PAY_ONCE_START_MISMATCH') {
            if ((await this.payOnce.cancel(opened.paymentId!)).state === 'SUCCEEDED') return this.cardSettled(input);
            continue;
          }
          if (attempt === 0 && code === 'SCHOOL_PAY_ONCE_EXPIRED') { await this.payOnce.confirm(opened.paymentId!); continue; }
          if (code === 'SCHOOL_PAY_ONCE_STATE') return this.cardSettled(input);
          if (code === 'SCHOOL_PAY_ONCE_NOT_AVAILABLE' || code === 'SCHOOL_PAY_ONCE_SURFACE_UNSUPPORTED') return { result: 'NOT_AVAILABLE' };
          throw error;
        }
      }
      return { result: 'UNAVAILABLE' };
    });
  }

  /** 0533 tablet: where the card payment stands, asking the processor first while it is still payable or clearing. */
  async cardStatus(value: unknown): Promise<WalkInCardOutcome> {
    const input = this.cardInput(value, false);
    if (!input) return { result: 'INVALID' };
    return this.card(async () => {
      const first = cardRow(await this.database.runPublicEventCall(CARD_SETTLE, [input.digest, input.key]), false);
      if (first.result !== 'OPEN' && first.result !== 'PROCESSING') return { result: first.result };
      await this.payOnce.confirm(first.paymentId!);
      return this.cardSettled(input);
    });
  }

  /** 0533 tablet: the visitor chose to pay at the desk. The processor's answer decides: CANCELED, or PAID if they already had. */
  async cardCancel(value: unknown): Promise<WalkInCardOutcome> {
    const input = this.cardInput(value, false);
    if (!input) return { result: 'INVALID' };
    return this.card(async () => {
      const first = cardRow(await this.database.runPublicEventCall(CARD_SETTLE, [input.digest, input.key]), false);
      if (first.result !== 'OPEN') return { result: first.result };
      await this.payOnce.cancel(first.paymentId!);
      return this.cardSettled(input);
    });
  }

  private async cardSettled(input: { digest: string; key: string }): Promise<WalkInCardOutcome> {
    return { result: cardRow(await this.database.runPublicEventCall(CARD_SETTLE, [input.digest, input.key]), false).result };
  }

  private async card(run: () => Promise<WalkInCardOutcome>): Promise<WalkInCardOutcome> {
    try { return await run(); } catch (error) {
      if ((error as { code?: string; message?: string })?.code === '42501' && (error as { message?: string }).message === 'WALKIN_KIOSK_CLOSED') return { result: 'CLOSED' };
      return { result: 'UNAVAILABLE' }; // Never propagate PostgreSQL, processor or payment detail to the tablet.
    }
  }

  private cardInput(value: unknown, withSurface: boolean): { digest: string; key: string; surface: WalkInCardSurface | null } | null {
    const token = this.token(value, withSurface ? ['device', 'visit', 'surface'] : ['device', 'visit']);
    const { visit: key, surface } = (value ?? {}) as { visit?: unknown; surface?: unknown };
    if (!token || typeof key !== 'string' || !PUBLIC_KEY.test(key)) return null;
    if (withSurface && !WALKIN_CARD_SURFACES.includes(surface as WalkInCardSurface)) return null;
    return { digest: walkInTokenDigest(token), key, surface: withSurface ? surface as WalkInCardSurface : null };
  }

  /** The tablet's own page for the processor's form, and a plain "you can go back to the tablet" page for the phone. */
  private returnUrl(surface: WalkInCardSurface): string | null {
    try { return `${configuredPublicOrigin(process.env)}${surface === 'EMBEDDED' ? '/kiosk/walk-in' : '/kiosk/walk-in/paid'}`; } catch { return null; }
  }

  private async cardSurfaces(token: string): Promise<WalkInCardSurface[]> {
    try {
      const data = await this.database.runPublicEventCall(CARD_PROVIDER, [walkInTokenDigest(token)]) as { providerCode?: unknown } | null;
      const provider = data?.providerCode;
      if (provider !== 'STRIPE_CONNECT' && provider !== 'SQUARE') return [];
      return WALKIN_CARD_SURFACES.filter(surface => this.payOnce.supports(provider, surface));
    } catch { return []; } // Card payment is an extra: the desk always works.
  }

  async submit(value: unknown, key: unknown): Promise<WalkInVisitOutcome> {
    const token = this.token(value, ['device', 'visit']);
    if (!token || typeof key !== 'string' || !PUBLIC_KEY.test(key)) return { result: 'INVALID' };
    const visit = (value as { visit: unknown }).visit;
    if (!visit || typeof visit !== 'object' || Array.isArray(visit) || JSON.stringify(visit).length > 24576) return { result: 'INVALID' };
    try {
      return verifyWalkInVisitOutcome(await this.database.runPublicEventCall('SELECT hon.submit_walkin_visit($1,$2::jsonb,$3) AS data',
        [walkInTokenDigest(token), JSON.stringify(visit), key]));
    } catch (error) {
      // The tablet stopped being live during this visit (decided again after the last write): nothing was kept.
      if ((error as { code?: string; message?: string })?.code === '42501' && (error as { message?: string }).message === 'WALKIN_KIOSK_CLOSED') return { result: 'CLOSED' };
      return { result: 'UNAVAILABLE' }; // Never propagate PostgreSQL detail or visitor data.
    }
  }

  private token(value: unknown, keys: string[]): string | null {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) return null;
    const token = (value as { device: unknown }).device;
    return typeof token === 'string' && WALKIN_TOKEN.test(token) ? token : null;
  }

  private async one(client: PoolClient, statement: string, values: unknown[]): Promise<unknown> {
    const result = await client.query<{ data: unknown }>(statement, values);
    if (result.rows.length !== 1) throw new Error('Unverified walk-in kiosk read.');
    return result.rows[0]!.data;
  }

  private async read<T>(context: MembershipLifecycleContext, run: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        return run(client);
      });
    } catch (error) { return translate(error); }
  }

  private async write<R>(context: MembershipLifecycleContext, statement: string, values: unknown[], verify: (data: unknown) => R): Promise<{ receipt: R; replayed: boolean }> {
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: Record<string, unknown> }>(statement, values);
        const data = result.rows[0]?.data;
        if (result.rows.length !== 1 || !data || Object.keys(data).sort().join(',') !== 'receipt,replayed' || typeof data.replayed !== 'boolean') {
          throw new Error('Unverified walk-in kiosk receipt.');
        }
        return { receipt: verify(data.receipt), replayed: data.replayed };
      });
    } catch (error) { return translate(error); }
  }

  private validated<T>(run: () => T): T {
    try { return run(); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
  }

  private assertHuman(context: MembershipLifecycleContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'The walk-in kiosk accepts only direct human commands.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 200) throw new ForbiddenException({ code: 'WALKIN_KIOSK_FORBIDDEN' });
    if (!command) {
      if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
      return;
    }
    if (!context.idempotencyKey || context.idempotencyKey !== context.idempotencyKey.trim() || context.idempotencyKey.length > 200) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
  }
}
