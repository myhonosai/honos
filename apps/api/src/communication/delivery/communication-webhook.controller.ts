import {
  BadRequestException, Controller, Header, Headers, HttpCode, Inject, Logger, Post, Req, ServiceUnavailableException,
} from '@nestjs/common';
import { raw, type NextFunction, type Request, type Response } from 'express';
import { COMMUNICATION_WORKER_STORE, type CommunicationWorkerStore, type VerifiedProviderReceipt } from './communication-worker-database.js';
import { SendGridEventWebhookVerifier, SendGridWebhookError } from './sendgrid-email-provider.js';
import { TWILIO_INBOUND_PATH, TWILIO_STATUS_PATH, TwilioWebhookError, TwilioWebhookVerifier } from './twilio-text-provider.js';

const inboundLog = new Logger('CommunicationInboundText');

export const COMMUNICATION_WEBHOOK_PREFIX = /^\/v1\/communications\/webhooks(?:\/|$)/i;
const JSON_PATHS = new Set(['/v1/communications/webhooks/sendgrid']);
const FORM_PATHS = new Set([TWILIO_STATUS_PATH, TWILIO_INBOUND_PATH]);
export const COMMUNICATION_WEBHOOK_PATHS = new Set([...JSON_PATHS, ...FORM_PATHS]);
export const SENDGRID_EVENT_VERIFIER = Symbol('SENDGRID_EVENT_VERIFIER');
export const TWILIO_WEBHOOK_VERIFIER = Symbol('TWILIO_WEBHOOK_VERIFIER');
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
  ) {}

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
