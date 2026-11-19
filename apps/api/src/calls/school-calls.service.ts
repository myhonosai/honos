import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, Logger, NotFoundException, Optional,
  ServiceUnavailableException, UnprocessableEntityException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  validateSchoolCallListQuery, validateSchoolCallRingingInput, validateSchoolDoNotCallInput, validateSetSchoolCallingSettingsInput,
  validateStartSchoolCallInput, validateUpdateSchoolCallInput, verifySchoolCall, verifySchoolCallingOverview, verifySchoolCallingSettings,
  verifySchoolCallList, verifySchoolCallRinging, verifySchoolDoNotCall, verifyStartedSchoolCall,
  type SchoolCall, type SchoolCallingOverview, type SchoolCallingSettings, type SchoolCallList, type SchoolCallRinging, type SchoolDoNotCallInput,
  type StartedSchoolCall, type SchoolPhoneToken, verifySchoolPhoneToken,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { COMMUNICATION_WORKER_STORE, type CommunicationWorkerStore } from '../communication/delivery/communication-worker-database.js';
import { mintPhoneToken, voiceCallsApproved, type TwilioVoiceKeyVault } from './twilio-voice.js';
import { SCHOOL_CALL_CLOCK, SCHOOL_CALL_ENVIRONMENT } from './school-call-webhooks.controller.js';

export const TWILIO_VOICE_KEY_VAULT = Symbol('TWILIO_VOICE_KEY_VAULT');
const tokenLog = new Logger('SchoolPhoneToken');
const IDENTITY = /^u[0-9a-f]{32}$/;

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const WRITE_LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";

/** Refusals a person can act on, in plain words. */
const DETAIL: Record<string, [string, (body: object) => HttpException]> = {
  CALLING_OFF: ['55000', body => new UnprocessableEntityException(body)],
  CALL_NUMBER_NOT_READY: ['55000', body => new UnprocessableEntityException(body)],
  CALL_NUMBER_NOT_ALLOWED: ['22023', body => new UnprocessableEntityException(body)],
  CALL_DO_NOT_CALL: ['22023', body => new UnprocessableEntityException(body)],
  CALL_PERSON_PHONE_MISMATCH: ['22023', body => new UnprocessableEntityException(body)],
  RECORDING_CONSENT_REQUIRED: ['22023', body => new UnprocessableEntityException(body)],
  CALL_RATE_LIMITED: ['54000', body => new HttpException(body, 429)],
  CALL_PERSON_NOT_FOUND: ['P0002', body => new NotFoundException(body)],
  CALL_NOT_FOUND: ['P0002', body => new NotFoundException(body)],
  CALLING_VERSION_CONFLICT: ['40001', body => new ConflictException(body)],
  CALL_VERSION_CONFLICT: ['40001', body => new ConflictException(body)],
  IDEMPOTENCY_KEY_REUSED: ['23505', body => new ConflictException(body)],
};
const WORDS: Record<string, string> = {
  CALLING_OFF: 'Calling is switched off for this school. The owner can switch it on under Calls, Settings.',
  CALL_NUMBER_NOT_READY: 'This school has no active number to call from yet.',
  CALL_NUMBER_NOT_ALLOWED: 'HON calls US and Canada numbers only, and never premium, Caribbean or the school\'s own numbers.',
  CALL_DO_NOT_CALL: 'This number is marked Do not call.',
  CALL_PERSON_PHONE_MISMATCH: 'That contact\'s phone is a different number.',
  RECORDING_CONSENT_REQUIRED: 'Accept the recording statement before switching recording on.',
  CALL_RATE_LIMITED: 'You have started 60 calls in the last hour. Try again a little later.',
  CALL_PERSON_NOT_FOUND: 'That contact is not available.',
  CALL_NOT_FOUND: 'That call is not available.',
  CALLING_VERSION_CONFLICT: 'Someone else changed the calling settings. Reload and try again.',
  CALL_VERSION_CONFLICT: 'The call changed. Reload it and try again.',
  IDEMPOTENCY_KEY_REUSED: 'The idempotency key was already used for a different call.',
};

export function translateSchoolCallError(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '', message = (error as { message?: string })?.message ?? '';
  const known = DETAIL[message];
  if (known && known[0] === sqlState) throw known[1]({ code: message, detail: WORDS[message] });
  if (sqlState === '42501') throw new ForbiddenException({ code: 'CALLING_FORBIDDEN' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'CALL_CONFLICT' });
  if (['22023', '22P02', '23514'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'CALLING_UNAVAILABLE', detail: 'No verified calling result is available. Nothing was dialled.' });
}
function subjectOk(subject: unknown): subject is string {
  return typeof subject === 'string' && subject.length > 0 && subject.length <= 200 && subject.trim() === subject;
}
function keyOk(key: unknown): key is string {
  return typeof key === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(key);
}
function parse<T>(fn: () => T): T {
  try { return fn(); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
}

/**
 * 0556 calling for school staff: the Calls page header and settings, Ring me, starting an outgoing call, the call log
 * and the after-call card. Every call re-proves the direct human, communication.call.use (or .manage for settings) at
 * the session school and paid access inside a protected definer function; route ids are never authority. Starting a
 * call only records it: the browser phone connects it through the signed Twilio webhook, which dials the stored number.
 */
@Injectable()
export class SchoolCallsService {
  constructor(
    private readonly database: RuntimeDatabaseService,
    @Optional() @Inject(COMMUNICATION_WORKER_STORE) private readonly worker?: Pick<CommunicationWorkerStore, 'isConfigured' | 'readSchoolVoiceApp'>,
    @Optional() @Inject(TWILIO_VOICE_KEY_VAULT) private readonly vault?: TwilioVoiceKeyVault | null,
    @Optional() @Inject(SCHOOL_CALL_ENVIRONMENT) private readonly environment: () => NodeJS.ProcessEnv = () => process.env,
    @Optional() @Inject(SCHOOL_CALL_CLOCK) private readonly now: () => number = Date.now,
  ) {}

  /**
   * The browser phone's token. The runtime proves call.use at the session school and says whether the school's voice
   * app is ready and whether this staff member rings (audited either way). Only then, and only with paid calling
   * approved, the worker reads the school's sealed API key and the API signs a one-hour token for this identity.
   */
  async phoneToken(context: MembershipLifecycleContext): Promise<SchoolPhoneToken> {
    this.assertStaff(context, false);
    const decision = await this.write(context, 'SELECT hon.authorize_school_phone_token($1) AS data', [context.externalSubject], data => {
      const row = data as Record<string, unknown> | null;
      if (!row || typeof row !== 'object' || Object.keys(row).sort().join(',') !== 'callingOn,identity,incoming,ready,schoolId'
        || row.schoolId !== context.schoolId || typeof row.identity !== 'string' || !IDENTITY.test(row.identity)
        || typeof row.ready !== 'boolean' || typeof row.callingOn !== 'boolean' || typeof row.incoming !== 'boolean' || (row.incoming && !row.ready)) {
        throw new Error('Unverified phone token decision.');
      }
      return row as { schoolId: string; identity: string; ready: boolean; callingOn: boolean; incoming: boolean };
    });
    const none = (reason: SchoolPhoneToken['reason']) => verifySchoolPhoneToken({ ready: false, reason, identity: null, token: null, expiresAt: null, incoming: false });
    if (!decision.callingOn) return none('CALLING_OFF');
    if (!decision.ready) return none('PHONE_NOT_SET_UP');
    if (!voiceCallsApproved(this.environment())) return none('VOICE_NOT_APPROVED');
    if (!this.worker?.isConfigured() || !this.worker.readSchoolVoiceApp || !this.vault) throw new ServiceUnavailableException({ code: 'CALLING_UNAVAILABLE' });
    let key;
    try { key = await this.worker.readSchoolVoiceApp(context.schoolId); }
    catch { throw new ServiceUnavailableException({ code: 'CALLING_UNAVAILABLE' }); }
    if (!key) return none('PHONE_NOT_SET_UP');
    let secret: string;
    try { secret = this.vault.open({ schoolId: context.schoolId, accountSid: key.accountSid, apiKeySid: key.apiKeySid }, key.vaultKeyId, key.sealedApiSecret); }
    catch { tokenLog.error('A school voice key did not open.'); throw new ServiceUnavailableException({ code: 'CALLING_UNAVAILABLE' }); }
    const minted = mintPhoneToken({ accountSid: key.accountSid, apiKeySid: key.apiKeySid, apiKeySecret: secret, twimlAppSid: key.twimlAppSid,
      identity: decision.identity, incoming: decision.incoming, nowSeconds: Math.floor(this.now() / 1000) });
    return verifySchoolPhoneToken({ ready: true, reason: 'READY', identity: decision.identity, token: minted.token, expiresAt: minted.expiresAt, incoming: decision.incoming });
  }

  async overview(context: MembershipLifecycleContext): Promise<SchoolCallingOverview> {
    this.assertStaff(context, false);
    return this.read(context, 'SELECT hon.read_school_calling($1) AS data', [context.externalSubject], verifySchoolCallingOverview);
  }

  async list(context: MembershipLifecycleContext, query: unknown): Promise<SchoolCallList> {
    this.assertStaff(context, false);
    const input = parse(() => validateSchoolCallListQuery(query));
    const list = await this.read(context, 'SELECT hon.read_school_calls($1,$2::jsonb) AS data', [context.externalSubject, JSON.stringify(input)], verifySchoolCallList);
    if (input.personId && list.calls.some(call => call.personId !== input.personId)) throw new ServiceUnavailableException({ code: 'CALLING_UNAVAILABLE' });
    if (input.filter === 'OUTGOING' && list.calls.some(call => call.direction !== 'OUT')) throw new ServiceUnavailableException({ code: 'CALLING_UNAVAILABLE' });
    if (input.filter === 'VOICEMAIL' && list.calls.some(call => !call.voicemail)) throw new ServiceUnavailableException({ code: 'CALLING_UNAVAILABLE' });
    return list;
  }

  async setSettings(context: MembershipLifecycleContext, body: unknown): Promise<SchoolCallingSettings> {
    this.assertStaff(context, false);
    const input = parse(() => validateSetSchoolCallingSettingsInput(body));
    const settings = await this.write(context, 'SELECT hon.set_school_calling_settings($1,$2::jsonb,$3::uuid,$4::uuid) AS data',
      [context.externalSubject, JSON.stringify(input), context.requestId, context.correlationId], data => verifySchoolCallingSettings(data));
    if (settings.callingOn !== input.callingOn || settings.recordingOn !== input.recordingOn || settings.voicemailGreeting !== input.voicemailGreeting
      || settings.version !== input.expectedVersion + 1) throw new ServiceUnavailableException({ code: 'CALLING_UNAVAILABLE' });
    return settings;
  }

  async setRinging(context: MembershipLifecycleContext, body: unknown): Promise<SchoolCallRinging> {
    this.assertStaff(context, false);
    const input = parse(() => validateSchoolCallRingingInput(body));
    const ringing = await this.write(context, 'SELECT hon.set_my_school_call_ringing($1,$2::jsonb) AS data', [context.externalSubject, JSON.stringify(input)], verifySchoolCallRinging);
    if (ringing.ringMe !== input.ringMe) throw new ServiceUnavailableException({ code: 'CALLING_UNAVAILABLE' });
    return ringing;
  }

  async start(context: MembershipLifecycleContext, body: unknown): Promise<StartedSchoolCall> {
    this.assertStaff(context, true);
    const input = body && typeof body === 'object' && !Array.isArray(body) && typeof (body as Record<string, unknown>).toE164 === 'string'
      ? body : null;
    let valid;
    try { valid = validateStartSchoolCallInput(input); } catch {
      // A US/Canada-shaped number that the dialing rule refuses gets the plain reason; anything else is malformed.
      const row = input as Record<string, unknown> | null;
      if (row && Object.keys(row).every(key => key === 'toE164' || key === 'personId') && /^\+1\d{10}$/.test(String(row.toE164))) {
        throw new UnprocessableEntityException({ code: 'CALL_NUMBER_NOT_ALLOWED', detail: WORDS.CALL_NUMBER_NOT_ALLOWED });
      }
      throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    }
    return this.write(context, 'SELECT hon.start_school_call($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data',
      [context.externalSubject, JSON.stringify(valid), context.idempotencyKey, context.requestId, context.correlationId], data => verifyStartedSchoolCall(data, valid));
  }

  async update(context: MembershipLifecycleContext, callId: string, body: unknown): Promise<SchoolCall> {
    this.assertStaff(context, false);
    if (!body || typeof body !== 'object' || Array.isArray(body) || 'callId' in body) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const input = parse(() => validateUpdateSchoolCallInput({ ...body, callId }));
    const call = await this.write(context, 'SELECT hon.update_school_call($1,$2::jsonb,$3::uuid,$4::uuid) AS data',
      [context.externalSubject, JSON.stringify(input), context.requestId, context.correlationId], verifySchoolCall);
    if (call.callId !== input.callId || call.version !== input.expectedVersion + 1) throw new ServiceUnavailableException({ code: 'CALLING_UNAVAILABLE' });
    return call;
  }

  async setDoNotCall(context: MembershipLifecycleContext, body: unknown): Promise<SchoolDoNotCallInput> {
    this.assertStaff(context, false);
    const input = parse(() => validateSchoolDoNotCallInput(body));
    return this.write(context, 'SELECT hon.set_school_do_not_call($1,$2::jsonb) AS data', [context.externalSubject, JSON.stringify(input)],
      data => verifySchoolDoNotCall(data, input));
  }

  private async read<T>(context: MembershipLifecycleContext, statement: string, values: unknown[], verify: (data: unknown) => T): Promise<T> {
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        return verify(await this.one(client, statement, values));
      });
    } catch (error) { return translateSchoolCallError(error); }
  }

  private async write<T>(context: MembershipLifecycleContext, statement: string, values: unknown[], verify: (data: unknown) => T): Promise<T> {
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        return verify(await this.one(client, statement, values));
      });
    } catch (error) { return translateSchoolCallError(error); }
  }

  private assertStaff(context: MembershipLifecycleContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Calling accepts only direct human commands.' });
    }
    if (!subjectOk(context.externalSubject)) throw new ForbiddenException({ code: 'CALLING_FORBIDDEN' });
    if (!command) {
      if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
      return;
    }
    if (!keyOk(context.idempotencyKey)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
  }

  private async one(client: PoolClient, statement: string, values: unknown[]): Promise<unknown> {
    const result = await client.query<{ data: unknown }>(statement, values);
    if (result.rows.length !== 1) throw new Error('Unverified calling result.');
    return result.rows[0]!.data;
  }
}
