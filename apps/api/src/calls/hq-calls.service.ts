import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import {
  HQ_CALL_IDENTITY, validateHqCallListQuery, validateSchoolCallRingingInput, validateSchoolDoNotCallInput, validateSetHqCallingSettingsInput,
  validateStartHqCallInput, validateUpdateHqCallInput, verifyHqCall, verifyHqCallList, verifyHqCallingOverview, verifyHqCallingSettings,
  verifyHqPhoneToken, verifySchoolCallRinging, verifySchoolDoNotCall, verifyStartedHqCall,
  type HqCall, type HqCallList, type HqCallingOverview, type HqCallingSettings, type HqPhoneToken, type SchoolCallRinging, type SchoolDoNotCallInput,
  type StartedHqCall,
} from '@hon/contracts';
import { RuntimeDatabaseService, type HqCallsOperation } from '../foundation/runtime-database.service.js';
import { COMMUNICATION_WORKER_STORE, type CommunicationWorkerStore } from '../communication/delivery/communication-worker-database.js';
import { HQ_VOICE_BINDING_ID, mintPhoneToken, voiceCallsApproved, type TwilioVoiceKeyVault } from './twilio-voice.js';
import { SCHOOL_CALL_CLOCK, SCHOOL_CALL_ENVIRONMENT } from './school-call-webhooks.controller.js';
import { SCHOOL_VOICE_TWILIO_CLIENT, TwilioVoiceError, type SchoolVoiceTwilioClient } from './twilio-voice-rest.js';
import { TWILIO_VOICE_KEY_VAULT, translateSchoolCallError } from './school-calls.service.js';

const tokenLog = new Logger('HqPhoneToken');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCOUNT_SID = /^AC[0-9a-f]{32}$/;
const NOT_ALLOWED = 'HON calls US and Canada numbers only, and never premium, Caribbean or HON\'s own numbers.';

function parse<T>(fn: () => T): T {
  try { return fn(); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
}
function unavailable(): never { throw new ServiceUnavailableException({ code: 'CALLING_UNAVAILABLE' }); }

/**
 * CL5 (0580) HQ calling on the HQ texting number. Every read and command re-proves the HQ person (any HQ messaging purpose;
 * settings: HQ owner) inside one fixed definer function; nothing here decides permission. Starting a call only records it:
 * the browser phone connects it through the signed HQ webhook, which dials the stored number. HQ calls are not recorded.
 */
@Injectable()
export class HqCallsService {
  constructor(
    private readonly database: RuntimeDatabaseService,
    @Optional() @Inject(COMMUNICATION_WORKER_STORE) private readonly worker?: Pick<CommunicationWorkerStore, 'isConfigured' | 'readHqVoiceApp'>,
    @Optional() @Inject(TWILIO_VOICE_KEY_VAULT) private readonly vault?: TwilioVoiceKeyVault | null,
    @Optional() @Inject(SCHOOL_CALL_ENVIRONMENT) private readonly environment: () => NodeJS.ProcessEnv = () => process.env,
    @Optional() @Inject(SCHOOL_CALL_CLOCK) private readonly now: () => number = Date.now,
    @Optional() @Inject(SCHOOL_VOICE_TWILIO_CLIENT) private readonly twilio?: SchoolVoiceTwilioClient,
  ) {}

  overview(subject: string): Promise<HqCallingOverview> {
    return this.call('overview', [subject], verifyHqCallingOverview);
  }

  async list(subject: string, query: unknown): Promise<HqCallList> {
    const input = parse(() => validateHqCallListQuery(query));
    const list = await this.call('list', [subject, JSON.stringify(input)], verifyHqCallList);
    if (input.contactUserId && list.calls.some(c => c.contactUserId !== input.contactUserId)) unavailable();
    if (input.filter === 'OUTGOING' && list.calls.some(c => c.direction !== 'OUT')) unavailable();
    if (input.filter === 'VOICEMAIL' && list.calls.some(c => !c.voicemail)) unavailable();
    return list;
  }

  async setSettings(subject: string, body: unknown): Promise<HqCallingSettings> {
    const input = parse(() => validateSetHqCallingSettingsInput(body));
    const saved = await this.call('settings', [subject, JSON.stringify(input)], data => verifyHqCallingSettings(data));
    if (saved.callingOn !== input.callingOn || saved.voicemailGreeting !== input.voicemailGreeting || saved.version !== input.expectedVersion + 1) unavailable();
    return saved;
  }

  async setRinging(subject: string, body: unknown): Promise<SchoolCallRinging> {
    const input = parse(() => validateSchoolCallRingingInput(body));
    const saved = await this.call('ringing', [subject, JSON.stringify(input)], verifySchoolCallRinging);
    if (saved.ringMe !== input.ringMe) unavailable();
    return saved;
  }

  async start(subject: string, body: unknown, key: string): Promise<StartedHqCall> {
    if (!UUID.test(key)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    let input;
    try { input = validateStartHqCallInput(body); } catch {
      const row = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
      if (row && Object.keys(row).every(k => k === 'toE164' || k === 'contactUserId') && /^\+1\d{10}$/.test(String(row.toE164))) {
        throw new UnprocessableEntityException({ code: 'CALL_NUMBER_NOT_ALLOWED', detail: NOT_ALLOWED });
      }
      throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    }
    const valid = input;
    return this.call('start', [subject, JSON.stringify(valid), key], data => verifyStartedHqCall(data, valid));
  }

  async update(subject: string, callId: string, body: unknown): Promise<HqCall> {
    if (!body || typeof body !== 'object' || Array.isArray(body) || 'callId' in body) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const input = parse(() => validateUpdateHqCallInput({ ...body, callId }));
    const saved = await this.call('update', [subject, JSON.stringify(input)], verifyHqCall);
    if (saved.callId !== input.callId || saved.version !== input.expectedVersion + 1) unavailable();
    return saved;
  }

  async setDoNotCall(subject: string, body: unknown): Promise<SchoolDoNotCallInput> {
    const input = parse(() => validateSchoolDoNotCallInput(body));
    return this.call('doNotCall', [subject, JSON.stringify(input)], data => verifySchoolDoNotCall(data, input));
  }

  /** A voicemail, fetched from HON's parent account only after the database authorized and audited this open. */
  async recording(subject: string, callId: string): Promise<{ audio: Buffer; contentType: 'audio/mpeg' }> {
    if (!UUID.test(callId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const opened = await this.call('recording', [subject, callId], data => {
      const row = data as Record<string, unknown> | null;
      if (!row || typeof row !== 'object' || Object.keys(row).sort().join(',') !== 'accountSid,recordingSid,seconds' || row.accountSid !== null
        || typeof row.recordingSid !== 'string' || !/^RE[0-9a-f]{32}$/.test(row.recordingSid)) throw new Error('Unverified recording.');
      return row as { recordingSid: string };
    });
    if (!voiceCallsApproved(this.environment()) || !this.twilio || this.twilio.readiness() !== 'READY') unavailable();
    try { return await this.twilio.fetchRecording(null, opened.recordingSid); }
    catch (error) {
      if (error instanceof TwilioVoiceError && error.outcome === 'GONE') {
        throw new NotFoundException({ code: 'CALL_RECORDING_NOT_FOUND', detail: 'That voicemail is not available. Voicemail is kept 90 days.' });
      }
      return unavailable();
    }
  }

  /**
   * The HQ browser phone token. The database proves the HQ person and says whether the HQ voice app is ready and whether
   * this person rings (audited). Only then, and only with paid calling approved, the parent-account HQ key is opened.
   */
  async phoneToken(subject: string): Promise<HqPhoneToken> {
    const decision = await this.call('phoneToken', [subject], data => {
      const row = data as Record<string, unknown> | null;
      if (!row || typeof row !== 'object' || Object.keys(row).sort().join(',') !== 'callingOn,identity,incoming,ready'
        || typeof row.identity !== 'string' || !HQ_CALL_IDENTITY.test(row.identity) || typeof row.ready !== 'boolean'
        || typeof row.callingOn !== 'boolean' || typeof row.incoming !== 'boolean' || (row.incoming && !row.ready)) throw new Error('Unverified phone token decision.');
      return row as { identity: string; ready: boolean; callingOn: boolean; incoming: boolean };
    });
    const none = (reason: HqPhoneToken['reason']) => verifyHqPhoneToken({ ready: false, reason, identity: null, token: null, expiresAt: null, incoming: false });
    if (!decision.callingOn) return none('CALLING_OFF');
    if (!decision.ready) return none('PHONE_NOT_SET_UP');
    const env = this.environment();
    if (!voiceCallsApproved(env)) return none('VOICE_NOT_APPROVED');
    const parent = env.TWILIO_ACCOUNT_SID ?? '';
    if (!ACCOUNT_SID.test(parent) || !this.worker?.isConfigured() || !this.worker.readHqVoiceApp || !this.vault) unavailable();
    let key;
    try { key = await this.worker.readHqVoiceApp(); } catch { return unavailable(); }
    if (!key) return none('PHONE_NOT_SET_UP');
    let secret: string;
    try { secret = this.vault.open({ schoolId: HQ_VOICE_BINDING_ID, accountSid: parent, apiKeySid: key.apiKeySid }, key.vaultKeyId, key.sealedApiSecret); }
    catch { tokenLog.error('The HQ voice key did not open.'); return unavailable(); }
    const minted = mintPhoneToken({ accountSid: parent, apiKeySid: key.apiKeySid, apiKeySecret: secret, twimlAppSid: key.twimlAppSid,
      identity: decision.identity, incoming: decision.incoming, nowSeconds: Math.floor(this.now() / 1000) });
    return verifyHqPhoneToken({ ready: true, reason: 'READY', identity: decision.identity, token: minted.token, expiresAt: minted.expiresAt, incoming: decision.incoming });
  }

  private async call<T>(operation: HqCallsOperation, params: (string | null)[], verify: (data: unknown) => T): Promise<T> {
    if (typeof params[0] !== 'string' || !params[0] || params[0].length > 200) throw new ForbiddenException({ code: 'CALLING_FORBIDDEN' });
    let data: unknown;
    try { data = await this.database.callHqCalls(operation, params); }
    catch (error) {
      // The HQ actor check refuses with SAAS_FORBIDDEN; any other database refusal reads like the school calling ones.
      if ((error as { message?: string })?.message === 'SAAS_FORBIDDEN') throw new ForbiddenException({ code: 'CALLING_FORBIDDEN' });
      return translateSchoolCallError(error);
    }
    try { return verify(data); } catch { return unavailable(); }
  }
}
