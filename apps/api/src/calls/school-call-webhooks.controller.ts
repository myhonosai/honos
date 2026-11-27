import { BadRequestException, Controller, Header, Headers, HttpCode, Inject, Logger, Optional, Post, Req, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import { COMMUNICATION_WORKER_STORE, type CommunicationWorkerStore, type SchoolCallProviderStatus } from '../communication/delivery/communication-worker-database.js';
import { TWILIO_WEBHOOK_VERIFIER, requireTwilioNumberInSubaccount, resolveTwilioSubaccount, twilioError } from '../communication/delivery/communication-webhook.controller.js';
import { TwilioWebhookVerifier, twilioPublicOrigin } from '../communication/delivery/twilio-text-provider.js';
import { TWILIO_SUBACCOUNT_DIRECTORY, type TwilioSubaccountCredential, type TwilioSubaccountDirectory } from '../communication/delivery/twilio-subaccounts.js';
import {
  HANGUP_TWIML, TWILIO_CALL_ANSWERED_PATH, TWILIO_CLIENT_DIAL_RESULT_PATH, TWILIO_CLIENT_VOICE_PATH, TWILIO_INCOMING_DIAL_RESULT_PATH,
  TWILIO_RECORDING_NOTICE_PATHS, TWILIO_RECORDING_STATUS_PATH, TWILIO_VOICEMAIL_DONE_PATH, TWILIO_VOICEMAIL_STATUS_PATH, dialCallStatus,
  outgoingDialTwiml, recordingNoticeTwiml, refusedCallTwiml, twilioSeconds, voiceCallsApproved, voicemailTwiml, type CallLanguage,
} from './twilio-voice.js';

const log = new Logger('SchoolCallWebhooks');
/** Test seams: the environment and the clock (absent in the app, so the process environment and Date.now apply). */
export const SCHOOL_CALL_ENVIRONMENT = Symbol('SCHOOL_CALL_ENVIRONMENT');
export const SCHOOL_CALL_CLOCK = Symbol('SCHOOL_CALL_CLOCK');
const CALL_SID = /^CA[0-9a-f]{32}$/;
const RECORDING_SID = /^RE[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLIENT = /^client:(u[0-9a-f]{32})$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const MISSED_TEXT_BACK: Readonly<Record<string, string>> = { NO_ANSWER: 'no-answer', BUSY: 'busy', FAILED: 'failed', CANCELED: 'canceled' };

/**
 * CL3b: Twilio's calls into HON for browser calling. No HON identity: each request must carry a valid signature over
 * its own fixed path, from HON's parent account or a known school subaccount, and the database checks that the call
 * belongs to that account. The number dialled always comes from the stored call row, never from the request.
 */
@Controller('communications/webhooks/twilio')
export class SchoolCallWebhooksController {
  constructor(
    @Inject(COMMUNICATION_WORKER_STORE) private readonly store: CommunicationWorkerStore,
    @Inject(TWILIO_WEBHOOK_VERIFIER) private readonly twilio: TwilioWebhookVerifier,
    @Optional() @Inject(TWILIO_SUBACCOUNT_DIRECTORY) private readonly subaccounts?: TwilioSubaccountDirectory,
    @Optional() @Inject(SCHOOL_CALL_ENVIRONMENT) private readonly environment: () => NodeJS.ProcessEnv = () => process.env,
    @Optional() @Inject(SCHOOL_CALL_CLOCK) private readonly now: () => number = Date.now,
  ) {}

  /** The TwiML App Voice URL: a staff browser placing the call it just started (HonCallId). */
  @Post('client-voice') @HttpCode(200) @Header('content-type', 'text/xml; charset=utf-8')
  async clientVoice(@Req() req: Request, @Headers('x-twilio-signature') signature: string | undefined): Promise<string> {
    const { params, accountSid } = await this.verify(req, TWILIO_CLIENT_VOICE_PATH, signature);
    const callSid = params.get('CallSid') ?? '', callId = (params.get('HonCallId') ?? '').toLowerCase();
    const identity = CLIENT.exec(params.get('From') ?? '')?.[1];
    if (!CALL_SID.test(callSid) || !UUID.test(callId) || !identity) throw new BadRequestException({ code: 'INVALID_WEBHOOK' });
    if (!voiceCallsApproved(this.environment())) return refusedCallTwiml(null);
    const base = this.base();
    const decision = await this.retry(() => this.need('connectSchoolClientCall')(callId, identity, accountSid, callSid));
    if ((decision.outcome !== 'CONNECT' && decision.outcome !== 'REPLAYED') || !decision.toE164 || !decision.callerIdE164) return refusedCallTwiml(decision.language);
    return outgoingDialTwiml({ toE164: decision.toE164, callerIdE164: decision.callerIdE164, recorded: decision.recorded, language: decision.language, publicBase: base });
  }

  /** The outgoing call ended: how it went and how long it lasted. */
  @Post('client-dial-result') @HttpCode(200) @Header('content-type', 'text/xml; charset=utf-8')
  async clientDialResult(@Req() req: Request, @Headers('x-twilio-signature') signature: string | undefined): Promise<string> {
    const { params, accountSid } = await this.verify(req, TWILIO_CLIENT_DIAL_RESULT_PATH, signature);
    const callSid = params.get('CallSid') ?? '';
    if (!CALL_SID.test(callSid)) throw new BadRequestException({ code: 'INVALID_WEBHOOK' });
    const status = dialCallStatus(params.get('DialCallStatus'));
    if (status) await this.status(accountSid, callSid, status, null, twilioSeconds(params.get('DialCallDuration')));
    return HANGUP_TWIML;
  }

  /** One leg of a call was answered: the callee (outgoing), or a staff browser or the forwarding phone (incoming). */
  @Post('call-answered') @HttpCode(200) @Header('content-type', 'text/xml; charset=utf-8')
  async callAnswered(@Req() req: Request, @Headers('x-twilio-signature') signature: string | undefined): Promise<string> {
    const { params, accountSid } = await this.verify(req, TWILIO_CALL_ANSWERED_PATH, signature);
    const parent = params.get('ParentCallSid') ?? '';
    if (!CALL_SID.test(parent)) throw new BadRequestException({ code: 'INVALID_WEBHOOK' });
    if (params.get('CallStatus') !== 'in-progress') return EMPTY_TWIML;
    await this.status(accountSid, parent, 'IN_PROGRESS', CLIENT.exec(params.get('To') ?? '')?.[1] ?? null, null);
    return EMPTY_TWIML;
  }

  /**
   * An incoming call's ring ended. Answered: completed. Otherwise the call is missed (and the 0249 missed-call text
   * goes out when the school has it on), and the caller is offered voicemail.
   */
  @Post('incoming-dial-result') @HttpCode(200) @Header('content-type', 'text/xml; charset=utf-8')
  async incomingDialResult(@Req() req: Request, @Headers('x-twilio-signature') signature: string | undefined): Promise<string> {
    const { params, accountSid, subaccount } = await this.verify(req, TWILIO_INCOMING_DIAL_RESULT_PATH, signature);
    const callSid = params.get('CallSid') ?? '', to = params.get('To') ?? '', fromRaw = params.get('From') ?? '';
    if (!CALL_SID.test(callSid) || !E164.test(to)) throw new BadRequestException({ code: 'INVALID_WEBHOOK' });
    await requireTwilioNumberInSubaccount(this.subaccounts, subaccount, to);
    const from = E164.test(fromRaw) ? fromRaw : null;
    const status = dialCallStatus(params.get('DialCallStatus'));
    if (status === 'COMPLETED') {
      await this.status(accountSid, callSid, 'COMPLETED', null, twilioSeconds(params.get('DialCallDuration')));
      return HANGUP_TWIML;
    }
    const base = this.base();
    await this.status(accountSid, callSid, 'MISSED', null, null);
    if (from && status && this.store.recordMissedCall) {
      // The text-back is a courtesy: trouble recording it never stops the caller reaching voicemail.
      try {
        await this.store.recordMissedCall({ to, from, callSid, dialStatus: MISSED_TEXT_BACK[status] ?? 'no-answer', receivedAt: new Date(this.now()).toISOString() });
      } catch { log.warn('Missed-call text-back was not recorded for an unanswered school call.'); }
    }
    if (!voiceCallsApproved(this.environment())) return HANGUP_TWIML;
    // The same routing call replays the stored call and returns the school's current greeting and language.
    const route = await this.retry(() => this.need('routeSchoolIncomingCall')(to, from, callSid));
    if (route.outcome !== 'REPLAYED') return HANGUP_TWIML;
    return voicemailTwiml({ voicemailGreeting: route.voicemailGreeting, language: route.language, schoolName: route.schoolName, publicBase: base });
  }

  /** A recorded call's recording is ready. */
  @Post('recording-status') @HttpCode(200) @Header('content-type', 'text/xml; charset=utf-8')
  async recordingStatus(@Req() req: Request, @Headers('x-twilio-signature') signature: string | undefined): Promise<string> {
    return this.recording(req, signature, TWILIO_RECORDING_STATUS_PATH, false);
  }

  /** A voicemail is ready. */
  @Post('voicemail-status') @HttpCode(200) @Header('content-type', 'text/xml; charset=utf-8')
  async voicemailStatus(@Req() req: Request, @Headers('x-twilio-signature') signature: string | undefined): Promise<string> {
    return this.recording(req, signature, TWILIO_VOICEMAIL_STATUS_PATH, true);
  }

  /** The caller finished leaving a voicemail. */
  @Post('voicemail-done') @HttpCode(200) @Header('content-type', 'text/xml; charset=utf-8')
  async voicemailDone(@Req() req: Request, @Headers('x-twilio-signature') signature: string | undefined): Promise<string> {
    await this.verify(req, TWILIO_VOICEMAIL_DONE_PATH, signature);
    return HANGUP_TWIML;
  }

  @Post('recording-notice-en') @HttpCode(200) @Header('content-type', 'text/xml; charset=utf-8')
  async noticeEn(@Req() req: Request, @Headers('x-twilio-signature') signature: string | undefined): Promise<string> { return this.notice(req, signature, 'en'); }
  @Post('recording-notice-es') @HttpCode(200) @Header('content-type', 'text/xml; charset=utf-8')
  async noticeEs(@Req() req: Request, @Headers('x-twilio-signature') signature: string | undefined): Promise<string> { return this.notice(req, signature, 'es'); }
  @Post('recording-notice-ko') @HttpCode(200) @Header('content-type', 'text/xml; charset=utf-8')
  async noticeKo(@Req() req: Request, @Headers('x-twilio-signature') signature: string | undefined): Promise<string> { return this.notice(req, signature, 'ko'); }

  private async notice(req: Request, signature: string | undefined, lang: CallLanguage): Promise<string> {
    await this.verify(req, TWILIO_RECORDING_NOTICE_PATHS[lang], signature);
    return recordingNoticeTwiml(lang);
  }

  private async recording(req: Request, signature: string | undefined, path: string, voicemail: boolean): Promise<string> {
    const { params, accountSid } = await this.verify(req, path, signature);
    const callSid = params.get('CallSid') ?? '', recordingSid = params.get('RecordingSid') ?? '';
    if (!CALL_SID.test(callSid) || !RECORDING_SID.test(recordingSid)) throw new BadRequestException({ code: 'INVALID_WEBHOOK' });
    if (params.get('RecordingStatus') !== 'completed') return EMPTY_TWIML;
    const seconds = twilioSeconds(params.get('RecordingDuration'));
    if (seconds === null) throw new BadRequestException({ code: 'INVALID_WEBHOOK' });
    await this.retry(() => this.need('recordSchoolCallRecording')(accountSid, callSid, recordingSid, seconds, voicemail));
    return EMPTY_TWIML;
  }

  private async status(accountSid: string | null, callSid: string, status: SchoolCallProviderStatus, identity: string | null, seconds: number | null): Promise<void> {
    await this.retry(() => this.need('recordSchoolCallStatus')(accountSid, callSid, status, identity, seconds, new Date(this.now()).toISOString()));
  }

  private async verify(req: Request, path: string, signature: string | undefined):
    Promise<{ params: URLSearchParams; accountSid: string | null; subaccount: TwilioSubaccountCredential | undefined }> {
    if (!Buffer.isBuffer(req.body)) throw new BadRequestException({ code: 'INVALID_WEBHOOK' });
    const subaccount = await resolveTwilioSubaccount(this.twilio, this.subaccounts, req.body);
    let params;
    try { params = this.twilio.signedForm(req.body, path, signature, subaccount); }
    catch (error) { throw twilioError(error); }
    return { params, accountSid: subaccount?.accountSid ?? null, subaccount };
  }

  private base(): string {
    const base = twilioPublicOrigin(this.environment());
    if (!base) throw new ServiceUnavailableException({ code: 'COMMUNICATION_WEBHOOK_NOT_CONFIGURED' });
    return base;
  }

  private need<K extends 'connectSchoolClientCall' | 'routeSchoolIncomingCall' | 'recordSchoolCallStatus' | 'recordSchoolCallRecording'>(name: K):
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
