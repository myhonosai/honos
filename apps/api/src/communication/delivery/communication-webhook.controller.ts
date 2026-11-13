import {
  BadRequestException, Controller, Header, Headers, HttpCode, HttpException, Inject, Logger, Optional, Post, Req, ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { raw, type NextFunction, type Request, type Response } from 'express';
import { COMMUNICATION_WORKER_STORE, type CommunicationWorkerStore, type VerifiedProviderReceipt } from './communication-worker-database.js';
import { SendGridEventWebhookVerifier, SendGridWebhookError } from './sendgrid-email-provider.js';
import {
  TWILIO_INBOUND_PATH, TWILIO_STATUS_PATH, TWILIO_VOICE_PATH, TWILIO_VOICE_RESULT_PATH, TwilioWebhookError, TwilioWebhookVerifier, twilioPublicOrigin,
} from './twilio-text-provider.js';
import { ZERNIO_LEAD_PATH, ZernioLeadWebhookVerifier, ZernioWebhookError } from './zernio-lead-webhook.js';
import { EMPTY_VOICE_TWIML, REJECT_VOICE_TWIML, voiceForwardTwiml } from './missed-call-text-back.js';

const inboundLog = new Logger('CommunicationInboundText');

export const COMMUNICATION_WEBHOOK_PREFIX = /^\/v1\/communications\/webhooks(?:\/|$)/i;
const JSON_PATHS = new Set(['/v1/communications/webhooks/sendgrid', ZERNIO_LEAD_PATH]);
const FORM_PATHS = new Set([TWILIO_STATUS_PATH, TWILIO_INBOUND_PATH, TWILIO_VOICE_PATH, TWILIO_VOICE_RESULT_PATH]);
export const COMMUNICATION_WEBHOOK_PATHS = new Set([...JSON_PATHS, ...FORM_PATHS]);
export const SENDGRID_EVENT_VERIFIER = Symbol('SENDGRID_EVENT_VERIFIER');
export const TWILIO_WEBHOOK_VERIFIER = Symbol('TWILIO_WEBHOOK_VERIFIER');
export const ZERNIO_LEAD_VERIFIER = Symbol('ZERNIO_LEAD_VERIFIER');
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/**
 * Mounted before the JSON parser: provider signatures cover the exact raw bytes. POST only, no query
 * string, cookies or credentials, JSON only, bounded size, no compression.
 */
export function communicationWebhookTransport() {
  const parser = raw({ type: () => true, limit: 1_048_576, inflate: false });
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!COMMUNICATION_WEBHOOK_PREFIX.test(req.path)) { next(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'POST' || !COMMUNICATION_WEBHOOK_PATHS.has(req.path) || req.originalUrl.includes('?')
      || req.headers.cookie !== undefined || req.headers.authorization !== undefined
      || (JSON_PATHS.has(req.path) && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? ''))
      || (FORM_PATHS.has(req.path) && !/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? ''))
      || (req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity')) {
      res.status(400).json({ received: false }); return;
    }
    parser(req, res, (error) => {
      if (error || !Buffer.isBuffer(req.body) || req.body.length === 0) { res.status(400).json({ received: false }); return; }
      next();
    });
  };
}

export interface WebhookIngestSummary { received: true; recorded: number; replayed: number; ignored: number }

/** Records verified receipts one by one. An UNMATCHED receipt (send result not committed yet) asks the provider to retry. */
export async function ingestReceipts(store: CommunicationWorkerStore, receipts: VerifiedProviderReceipt[], ignored: number): Promise<WebhookIngestSummary> {
  if (!store.isConfigured()) throw new ServiceUnavailableException({ code: 'COMMUNICATION_WEBHOOK_NOT_CONFIGURED' });
  const summary: WebhookIngestSummary = { received: true, recorded: 0, replayed: 0, ignored };
  let unmatched = 0;
  for (const receipt of receipts) {
    let result: Awaited<ReturnType<CommunicationWorkerStore['recordReceipt']>>;
    try { result = await store.recordReceipt(receipt); }
    catch (error) {
      // An out-of-range or invalid single event is dropped; database or connection trouble asks for redelivery.
      if ((error as { code?: string })?.code === '22023') { summary.ignored += 1; continue; }
      throw new ServiceUnavailableException({ code: 'COMMUNICATION_WEBHOOK_RETRY' });
    }
    if (result.outcome === 'RECORDED') summary.recorded += 1;
    else if (result.outcome === 'REPLAYED') summary.replayed += 1;
    else unmatched += 1;
  }
  if (unmatched) throw new ServiceUnavailableException({ code: 'COMMUNICATION_WEBHOOK_RETRY' });
  return summary;
}

/** Provider receipts. No HON identity: authenticity is the provider signature over the raw body. */
@Controller('communications/webhooks')
export class CommunicationWebhookController {
  constructor(
    @Inject(COMMUNICATION_WORKER_STORE) private readonly store: CommunicationWorkerStore,
    @Inject(SENDGRID_EVENT_VERIFIER) private readonly sendgrid: SendGridEventWebhookVerifier,
    @Inject(TWILIO_WEBHOOK_VERIFIER) private readonly twilio: TwilioWebhookVerifier,
    @Optional() @Inject(ZERNIO_LEAD_VERIFIER) private readonly zernio: ZernioLeadWebhookVerifier = new ZernioLeadWebhookVerifier(() => ({})),
  ) {}

  /**
   * 0250 Zernio `lead.received`: a signed Meta Lead Gen lead becomes a CRM lead only through an HQ-mapped form.
   * An unmapped form answers 422 (Zernio does not retry; the event waits in its dead-letter queue for redelivery
   * once HQ maps the form). A rate limit answers 429 and database trouble 503, which Zernio retries.
   */
  @Post('zernio') @HttpCode(200)
  async zernioLead(@Req() req: Request, @Headers('x-zernio-signature') signature: string | undefined): Promise<{ received: true }> {
    if (!Buffer.isBuffer(req.body)) throw new BadRequestException({ code: 'INVALID_WEBHOOK' });
    let lead;
    try { lead = this.zernio.verify(req.body, signature); }
    catch (error) {
      if (error instanceof ZernioWebhookError && error.reason === 'NOT_CONFIGURED') throw new ServiceUnavailableException({ code: 'COMMUNICATION_WEBHOOK_NOT_CONFIGURED' });
      throw new BadRequestException({ code: 'INVALID_WEBHOOK' });
    }
    if (!lead) return { received: true };
    if (!this.store.isConfigured() || !this.store.recordZernioLead) throw new ServiceUnavailableException({ code: 'COMMUNICATION_WEBHOOK_NOT_CONFIGURED' });
    let result;
    try { result = await this.store.recordZernioLead(lead); }
    catch (error) {
      if ((error as { code?: string })?.code === '22023') throw new UnprocessableEntityException({ code: 'ZERNIO_LEAD_INVALID' });
      throw new ServiceUnavailableException({ code: 'COMMUNICATION_WEBHOOK_RETRY' });
    }
    if (result.outcome === 'UNROUTED') throw new UnprocessableEntityException({ code: 'ZERNIO_FORM_NOT_MAPPED' });
    if (result.outcome === 'RATE_LIMITED') throw new HttpException({ code: 'ZERNIO_LEAD_RATE_LIMITED' }, 429);
    return { received: true };
  }

  @Post('twilio/status') @HttpCode(200)
  async twilioStatus(@Req() req: Request, @Headers('x-twilio-signature') signature: string | undefined): Promise<WebhookIngestSummary> {
    if (!Buffer.isBuffer(req.body)) throw new BadRequestException({ code: 'INVALID_WEBHOOK' });
    let receipt;
    try { receipt = this.twilio.status(req.body, signature); }
    catch (error) { throw twilioError(error); }
    return ingestReceipts(this.store, receipt ? [receipt] : [], receipt ? 0 : 1);
  }

  /** Inbound texts: only STOP/START/HELP keywords are recorded; the reply is empty (Twilio Advanced Opt-Out answers). */
  @Post('twilio/inbound') @HttpCode(200) @Header('content-type', 'text/xml; charset=utf-8')
  async twilioInbound(@Req() req: Request, @Headers('x-twilio-signature') signature: string | undefined): Promise<string> {
    if (!Buffer.isBuffer(req.body)) throw new BadRequestException({ code: 'INVALID_WEBHOOK' });
    let keyword;
    try { keyword = this.twilio.inbound(req.body, signature); }
    catch (error) { throw twilioError(error); }
    if (!keyword) return EMPTY_TWIML;
    if (!this.store.isConfigured() || !this.store.recordInboundKeyword) throw new ServiceUnavailableException({ code: 'COMMUNICATION_WEBHOOK_NOT_CONFIGURED' });
    try { await this.store.recordInboundKeyword(keyword); }
    catch {
      // Twilio does not retry inbound webhooks: log the message id (never the phone numbers) so an operator can
      // reconcile a lost STOP from the Twilio message log.
      inboundLog.warn(`Inbound ${keyword.keyword} not recorded; reconcile Twilio message ${keyword.providerMessageId}.`);
      throw new ServiceUnavailableException({ code: 'COMMUNICATION_WEBHOOK_RETRY' });
    }
    return EMPTY_TWIML;
  }

  /**
   * 0249 incoming call to a school number: forward to the school's own phone, or, with no forwarding phone,
   * record the call as missed and hang up. A number that is not an ACTIVE school sender is rejected.
   */
  @Post('twilio/voice') @HttpCode(200) @Header('content-type', 'text/xml; charset=utf-8')
  async twilioVoice(@Req() req: Request, @Headers('x-twilio-signature') signature: string | undefined): Promise<string> {
    if (!Buffer.isBuffer(req.body)) throw new BadRequestException({ code: 'INVALID_WEBHOOK' });
    let call;
    try { call = this.twilio.voice(req.body, signature); }
    catch (error) { throw twilioError(error); }
    const origin = twilioPublicOrigin(process.env);
    if (!this.store.isConfigured() || !this.store.readMissedCallRoute || !this.store.recordMissedCall || !origin) {
      throw new ServiceUnavailableException({ code: 'COMMUNICATION_WEBHOOK_NOT_CONFIGURED' });
    }
    try {
      const route = await this.store.readMissedCallRoute(call.to);
      if (!route.routed) return REJECT_VOICE_TWIML;
      if (route.forwardPhoneE164) return voiceForwardTwiml(route.forwardPhoneE164, origin);
      if (call.from) {
        await this.store.recordMissedCall({ to: call.to, from: call.from, callSid: call.callSid, dialStatus: 'no-forward', receivedAt: new Date().toISOString() });
      }
      return EMPTY_VOICE_TWIML;
    } catch {
      throw new ServiceUnavailableException({ code: 'COMMUNICATION_WEBHOOK_RETRY' });
    }
  }

  /** 0249 forwarded-leg outcome: an unanswered, busy, failed or canceled call is recorded as missed. */
  @Post('twilio/voice-result') @HttpCode(200) @Header('content-type', 'text/xml; charset=utf-8')
  async twilioVoiceResult(@Req() req: Request, @Headers('x-twilio-signature') signature: string | undefined): Promise<string> {
    if (!Buffer.isBuffer(req.body)) throw new BadRequestException({ code: 'INVALID_WEBHOOK' });
    let missed;
    try { missed = this.twilio.voiceResult(req.body, signature); }
    catch (error) { throw twilioError(error); }
    if (!missed) return EMPTY_VOICE_TWIML;
    if (!this.store.isConfigured() || !this.store.recordMissedCall) throw new ServiceUnavailableException({ code: 'COMMUNICATION_WEBHOOK_NOT_CONFIGURED' });
    try { await this.store.recordMissedCall(missed); }
    catch { throw new ServiceUnavailableException({ code: 'COMMUNICATION_WEBHOOK_RETRY' }); }
    return EMPTY_VOICE_TWIML;
  }

  @Post('sendgrid') @HttpCode(200)
  async sendgridEvents(
    @Req() req: Request,
    @Headers('x-twilio-email-event-webhook-signature') signature: string | undefined,
    @Headers('x-twilio-email-event-webhook-timestamp') timestamp: string | undefined,
  ): Promise<WebhookIngestSummary> {
    if (!Buffer.isBuffer(req.body)) throw new BadRequestException({ code: 'INVALID_WEBHOOK' });
    let receipts: VerifiedProviderReceipt[];
    let total = 0;
    try {
      receipts = this.sendgrid.verify(req.body, signature, timestamp);
      total = (JSON.parse(req.body.toString('utf8')) as unknown[]).length;
    } catch (error) {
      if (error instanceof SendGridWebhookError && error.reason === 'NOT_CONFIGURED') throw new ServiceUnavailableException({ code: 'COMMUNICATION_WEBHOOK_NOT_CONFIGURED' });
      throw new BadRequestException({ code: 'INVALID_WEBHOOK' });
    }
    return ingestReceipts(this.store, receipts, total - receipts.length);
  }
}

function twilioError(error: unknown): Error {
  if (error instanceof TwilioWebhookError && error.reason === 'NOT_CONFIGURED') return new ServiceUnavailableException({ code: 'COMMUNICATION_WEBHOOK_NOT_CONFIGURED' });
  return new BadRequestException({ code: 'INVALID_WEBHOOK' });
}
