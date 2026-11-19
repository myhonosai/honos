import { BadRequestException, Controller, Header, Headers, HttpCode, Inject, Optional, Post, Req, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import { COMMUNICATION_WORKER_STORE, type CommunicationWorkerStore, type SchoolCallProviderStatus } from '../communication/delivery/communication-worker-database.js';
import { TWILIO_WEBHOOK_VERIFIER, twilioError } from '../communication/delivery/communication-webhook.controller.js';
import { TwilioWebhookVerifier, twilioPublicOrigin } from '../communication/delivery/twilio-text-provider.js';
import {
  HANGUP_TWIML, HQ_CALL_PATHS, REJECT_CALL_TWIML, dialCallStatus, incomingRingTwiml, outgoingDialTwiml, refusedCallTwiml, twilioSeconds,
  voiceCallsApproved, voicemailTwiml,
} from './twilio-voice.js';
import { SCHOOL_CALL_CLOCK, SCHOOL_CALL_ENVIRONMENT } from './school-call-webhooks.controller.js';

const CALL_SID = /^CA[0-9a-f]{32}$/;
const RECORDING_SID = /^RE[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLIENT = /^client:(h[0-9a-f]{32})$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const HQ_NAME = 'HON HQ';
const LEG_PATHS = { dialResult: HQ_CALL_PATHS.clientDialResult, answered: HQ_CALL_PATHS.callAnswered };
const RING_PATHS = { dialResult: HQ_CALL_PATHS.incomingDialResult, answered: HQ_CALL_PATHS.callAnswered };
const VOICEMAIL_PATHS = { done: HQ_CALL_PATHS.voicemailDone, status: HQ_CALL_PATHS.voicemailStatus };

/**
 * CL5 (0580): Twilio's calls into HON for HQ calling on the HQ number. Every request must be signed by HON's parent
 * account over its own fixed HQ path (a school subaccount is refused), and the database decides everything else: the
 * number dialled comes from the stored HQ call, an incoming call rings only Ring me HQ people, and HQ calls are never
 * recorded (voicemail only). Nothing is dialled unless HON_VOICE_CALLS_APPROVED is exactly 'true'.
 */
@Controller('communications/webhooks/twilio/hq')
export class HqCallWebhooksController {
  constructor(
    @Inject(COMMUNICATION_WORKER_STORE) private readonly store: CommunicationWorkerStore,
    @Inject(TWILIO_WEBHOOK_VERIFIER) private readonly twilio: TwilioWebhookVerifier,
    @Optional() @Inject(SCHOOL_CALL_ENVIRONMENT) private readonly environment: () => NodeJS.ProcessEnv = () => process.env,
    @Optional() @Inject(SCHOOL_CALL_CLOCK) private readonly now: () => number = Date.now,
  ) {}

  /** The HQ TwiML App Voice URL: an HQ browser placing the call it just started (HonCallId). */
  @Post('client-voice') @HttpCode(200) @Header('content-type', 'text/xml; charset=utf-8')
  async clientVoice(@Req() req: Request, @Headers('x-twilio-signature') signature: string | undefined): Promise<string> {
    const params = this.verify(req, HQ_CALL_PATHS.clientVoice, signature);
    const callSid = params.get('CallSid') ?? '', callId = (params.get('HonCallId') ?? '').toLowerCase();
    const identity = CLIENT.exec(params.get('From') ?? '')?.[1];
    if (!CALL_SID.test(callSid) || !UUID.test(callId) || !identity) throw new BadRequestException({ code: 'INVALID_WEBHOOK' });
    if (!voiceCallsApproved(this.environment())) return refusedCallTwiml(null);
    const base = this.base();
    const decision = await this.retry(() => this.need('connectHqClientCall')(callId, identity, callSid));
    if ((decision.outcome !== 'CONNECT' && decision.outcome !== 'REPLAYED') || !decision.toE164 || !decision.callerIdE164) return refusedCallTwiml(null);
    return outgoingDialTwiml({ toE164: decision.toE164, callerIdE164: decision.callerIdE164, recorded: false, language: 'en', publicBase: base, paths: LEG_PATHS });
  }

  @Post('client-dial-result') @HttpCode(200) @Header('content-type', 'text/xml; charset=utf-8')
  async clientDialResult(@Req() req: Request, @Headers('x-twilio-signature') signature: string | undefined): Promise<string> {
    const params = this.verify(req, HQ_CALL_PATHS.clientDialResult, signature);
    const callSid = params.get('CallSid') ?? '';
    if (!CALL_SID.test(callSid)) throw new BadRequestException({ code: 'INVALID_WEBHOOK' });
    const status = dialCallStatus(params.get('DialCallStatus'));
    if (status) await this.status(callSid, status, null, twilioSeconds(params.get('DialCallDuration')));
    return HANGUP_TWIML;
  }

  @Post('call-answered') @HttpCode(200) @Header('content-type', 'text/xml; charset=utf-8')
  async callAnswered(@Req() req: Request, @Headers('x-twilio-signature') signature: string | undefined): Promise<string> {
    const params = this.verify(req, HQ_CALL_PATHS.callAnswered, signature);
    const parent = params.get('ParentCallSid') ?? '';
    if (!CALL_SID.test(parent)) throw new BadRequestException({ code: 'INVALID_WEBHOOK' });
    if (params.get('CallStatus') !== 'in-progress') return EMPTY_TWIML;
    await this.status(parent, 'IN_PROGRESS', CLIENT.exec(params.get('To') ?? '')?.[1] ?? null, null);
    return EMPTY_TWIML;
  }

  /**
   * The HQ number's Voice URL. With HQ calling on and the voice switch approved: ring the Ring me HQ browsers (straight
   * to voicemail when nobody rings). Otherwise the call is rejected and nothing is recorded.
   */
  @Post('voice') @HttpCode(200) @Header('content-type', 'text/xml; charset=utf-8')
  async voice(@Req() req: Request, @Headers('x-twilio-signature') signature: string | undefined): Promise<string> {
    const params = this.verify(req, HQ_CALL_PATHS.voice, signature);
    const callSid = params.get('CallSid') ?? '', to = params.get('To') ?? '', fromRaw = params.get('From') ?? '';
    if (!CALL_SID.test(callSid) || !E164.test(to)) throw new BadRequestException({ code: 'INVALID_WEBHOOK' });
    if (!voiceCallsApproved(this.environment())) return REJECT_CALL_TWIML;
    const base = this.base();
    const route = await this.retry(() => this.need('routeHqIncomingCall')(to, E164.test(fromRaw) ? fromRaw : null, callSid));
    if (route.outcome !== 'RING' && route.outcome !== 'REPLAYED') return REJECT_CALL_TWIML;
    return incomingRingTwiml({ identities: route.identities, forwardPhoneE164: null, recorded: false, voicemailGreeting: route.voicemailGreeting,
      language: 'en', schoolName: HQ_NAME, publicBase: base, paths: RING_PATHS, voicemailPaths: VOICEMAIL_PATHS });
  }

  /** The ring ended: answered is completed; otherwise missed and the caller is offered voicemail. */
  @Post('incoming-dial-result') @HttpCode(200) @Header('content-type', 'text/xml; charset=utf-8')
  async incomingDialResult(@Req() req: Request, @Headers('x-twilio-signature') signature: string | undefined): Promise<string> {
    const params = this.verify(req, HQ_CALL_PATHS.incomingDialResult, signature);
    const callSid = params.get('CallSid') ?? '', to = params.get('To') ?? '', fromRaw = params.get('From') ?? '';
    if (!CALL_SID.test(callSid) || !E164.test(to)) throw new BadRequestException({ code: 'INVALID_WEBHOOK' });
    const status = dialCallStatus(params.get('DialCallStatus'));
    if (status === 'COMPLETED') {
      await this.status(callSid, 'COMPLETED', null, twilioSeconds(params.get('DialCallDuration')));
      return HANGUP_TWIML;
    }
    await this.status(callSid, 'MISSED', null, null);
    if (!voiceCallsApproved(this.environment())) return HANGUP_TWIML;
    const base = this.base();
    const route = await this.retry(() => this.need('routeHqIncomingCall')(to, E164.test(fromRaw) ? fromRaw : null, callSid));
    if (route.outcome !== 'REPLAYED') return HANGUP_TWIML;
    return voicemailTwiml({ voicemailGreeting: route.voicemailGreeting, language: 'en', schoolName: HQ_NAME, publicBase: base, paths: VOICEMAIL_PATHS });
  }

  @Post('voicemail-status') @HttpCode(200) @Header('content-type', 'text/xml; charset=utf-8')
  async voicemailStatus(@Req() req: Request, @Headers('x-twilio-signature') signature: string | undefined): Promise<string> {
    const params = this.verify(req, HQ_CALL_PATHS.voicemailStatus, signature);
    const callSid = params.get('CallSid') ?? '', recordingSid = params.get('RecordingSid') ?? '';
    if (!CALL_SID.test(callSid) || !RECORDING_SID.test(recordingSid)) throw new BadRequestException({ code: 'INVALID_WEBHOOK' });
    if (params.get('RecordingStatus') !== 'completed') return EMPTY_TWIML;
    const seconds = twilioSeconds(params.get('RecordingDuration'));
    if (seconds === null) throw new BadRequestException({ code: 'INVALID_WEBHOOK' });
    await this.retry(() => this.need('recordHqCallVoicemail')(callSid, recordingSid, seconds));
    return EMPTY_TWIML;
  }

  @Post('voicemail-done') @HttpCode(200) @Header('content-type', 'text/xml; charset=utf-8')
  async voicemailDone(@Req() req: Request, @Headers('x-twilio-signature') signature: string | undefined): Promise<string> {
    this.verify(req, HQ_CALL_PATHS.voicemailDone, signature);
    return HANGUP_TWIML;
  }

  private async status(callSid: string, status: SchoolCallProviderStatus, identity: string | null, seconds: number | null): Promise<void> {
    await this.retry(() => this.need('recordHqCallStatus')(callSid, status, identity, seconds, new Date(this.now()).toISOString()));
  }

  /** Signed by HON's parent account only: with no subaccount the verifier requires AccountSid to be the parent. */
  private verify(req: Request, path: string, signature: string | undefined): URLSearchParams {
    if (!Buffer.isBuffer(req.body)) throw new BadRequestException({ code: 'INVALID_WEBHOOK' });
    const sid = this.twilio.accountSidOf(req.body);
    if (!sid || !this.twilio.isParentAccount(sid)) throw new BadRequestException({ code: 'INVALID_WEBHOOK' });
    try { return this.twilio.signedForm(req.body, path, signature); }
    catch (error) { throw twilioError(error); }
  }

  private base(): string {
    const base = twilioPublicOrigin(this.environment());
    if (!base) throw new ServiceUnavailableException({ code: 'COMMUNICATION_WEBHOOK_NOT_CONFIGURED' });
    return base;
  }

  private need<K extends 'connectHqClientCall' | 'routeHqIncomingCall' | 'recordHqCallStatus' | 'recordHqCallVoicemail'>(name: K):
    NonNullable<CommunicationWorkerStore[K]> {
    const fn = this.store[name];
    if (!this.store.isConfigured() || !fn) throw new ServiceUnavailableException({ code: 'COMMUNICATION_WEBHOOK_NOT_CONFIGURED' });
    return (fn as (...args: never[]) => unknown).bind(this.store) as NonNullable<CommunicationWorkerStore[K]>;
  }

  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); }
    catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException({ code: 'COMMUNICATION_WEBHOOK_RETRY' });
    }
  }
}
