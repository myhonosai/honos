import { Controller, Header, HttpCode, HttpException, Inject, Optional, Post, Req, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { SHOPIFY_APP, type ShopifyApp } from './shopify-adapter.js';
import { verifyShopifyWebhook } from './shopify-webhook.js';
import { SHOPIFY_WORKER_STORE, type ShopifyWebhookOutcome, type ShopifyWorkerStore } from './shopify-worker.js';

export interface ShopifyWebhookAnswer { received: true; outcome: ShopifyWebhookOutcome; replayed: boolean }

/**
 * SH1b (0425): Shopify's webhooks for the one HON Shopify app. No session and no school in the request: the signature
 * proves it came from Shopify, and the database finds the school from the shop domain. Answered 200 once recorded (or
 * deliberately ignored); 401 for a bad signature; 503 when HON cannot record it, so Shopify delivers it again.
 */
@Controller()
export class ShopifyWebhookController {
  constructor(@Inject(SHOPIFY_WORKER_STORE) private readonly store: ShopifyWorkerStore,
    @Optional() @Inject(SHOPIFY_APP) private readonly app: ShopifyApp | null = null) {}

  @Post('commerce/webhooks/shopify') @HttpCode(200) @Header('Cache-Control', 'no-store')
  async receive(@Req() req: Request): Promise<ShopifyWebhookAnswer> {
    if (!this.app) throw new ServiceUnavailableException({ code: 'SHOPIFY_WEBHOOK_NOT_CONFIGURED' });
    const check = verifyShopifyWebhook(req.body as Buffer, req.headers, this.app.clientSecret);
    if (check.kind === 'REFUSED') throw new UnauthorizedException({ received: false });
    if (check.kind === 'UNKNOWN_TOPIC') return { received: true, outcome: 'IGNORED', replayed: false };
    if (!this.store.isConfigured()) throw new ServiceUnavailableException({ code: 'SHOPIFY_WEBHOOK_NOT_CONFIGURED' });
    try {
      const r = await this.store.recordWebhook(check.webhook);
      return { received: true, outcome: r.outcome, replayed: r.replayed };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      // A delivery the database refuses as malformed is not delivered again; anything else is.
      if ((error as { code?: string })?.code === '22023') return { received: true, outcome: 'IGNORED', replayed: false };
      throw new ServiceUnavailableException({ code: 'SHOPIFY_WEBHOOK_RETRY' });
    }
  }
}
