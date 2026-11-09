import {
  BadRequestException, Controller, Headers, HttpCode, Inject, Post, Req, ServiceUnavailableException,
} from '@nestjs/common';
import { raw, type NextFunction, type Request, type Response } from 'express';
import { COMMUNICATION_WORKER_STORE, type CommunicationWorkerStore, type VerifiedProviderReceipt } from './communication-worker-database.js';
import { SendGridEventWebhookVerifier, SendGridWebhookError } from './sendgrid-email-provider.js';

export const COMMUNICATION_WEBHOOK_PREFIX = /^\/v1\/communications\/webhooks(?:\/|$)/i;
export const COMMUNICATION_WEBHOOK_PATHS = new Set(['/v1/communications/webhooks/sendgrid']);
export const SENDGRID_EVENT_VERIFIER = Symbol('SENDGRID_EVENT_VERIFIER');

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
      || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')
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
  ) {}

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
