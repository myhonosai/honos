import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import {
  validateEndWalkInDeviceInput, validateStartWalkInDeviceInput, validateWalkInDeskPaidInput, validateWalkInSettingsInput, verifyWalkInDeviceReceipt,
  verifyWalkInOverview, verifyWalkInSettingsRead, verifyWalkInSettingsReceipt, verifyWalkInTerminal, verifyWalkInVisitDetail, verifyWalkInVisitOutcome,
  verifyWalkInVisitReceipt, WALKIN_TOKEN,
  type StartedWalkInDevice, type WalkInDevice, type WalkInOverview, type WalkInSettings, type WalkInSettingsRead, type WalkInTerminal, type WalkInVisit,
  type WalkInVisitDetail, type WalkInVisitOutcome,
} from '@hon/contracts';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{16,100}$/;
const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const WRITE_LIMITS = "SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";

// Exact 0396 error codes; every unknown database failure is unavailable, never success.
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
 * Walk-in kiosk (0396). Staff calls run one protected definer function that re-proves the direct human subject and live
 * walkin_kiosk.manage or walkin_kiosk.run; tablet calls run the two fixed public functions as the restricted runtime with only
 * the SHA-256 digest of the device token. No message, charge or AI.
 */
@Injectable()
export class WalkInKioskService {
  constructor(private readonly database: RuntimeDatabaseService) {}

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

  async deskPaid(context: MembershipLifecycleContext, visitId: string, value: unknown): Promise<{ receipt: { visit: WalkInVisit }; replayed: boolean }> {
    this.assertHuman(context, true);
    if (!UUID.test(visitId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const input = this.validated(() => validateWalkInDeskPaidInput(value));
    return this.write(context, 'SELECT hon.set_walkin_visit_desk_paid($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
      [context.externalSubject, visitId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId], data => verifyWalkInVisitReceipt(data, { visitId }));
  }

  /** Tablet read: null for any token that is not a live tablet. */
  async terminal(value: unknown): Promise<WalkInTerminal | null> {
    const token = this.token(value, ['device']);
    if (!token) return null;
    try {
      const data = await this.database.runPublicEventCall('SELECT hon.read_walkin_kiosk_terminal($1) AS data', [walkInTokenDigest(token)]);
      return data === null ? null : verifyWalkInTerminal(data);
    } catch { throw new ServiceUnavailableException({ result: 'UNAVAILABLE' }); }
  }

  async submit(value: unknown, key: unknown): Promise<WalkInVisitOutcome> {
    const token = this.token(value, ['device', 'visit']);
    if (!token || typeof key !== 'string' || !PUBLIC_KEY.test(key)) return { result: 'INVALID' };
    const visit = (value as { visit: unknown }).visit;
    if (!visit || typeof visit !== 'object' || Array.isArray(visit) || JSON.stringify(visit).length > 24576) return { result: 'INVALID' };
    try {
      return verifyWalkInVisitOutcome(await this.database.runPublicEventCall('SELECT hon.submit_walkin_visit($1,$2::jsonb,$3) AS data',
        [walkInTokenDigest(token), JSON.stringify(visit), key]));
    } catch { return { result: 'UNAVAILABLE' }; } // Never propagate PostgreSQL detail or visitor data.
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
