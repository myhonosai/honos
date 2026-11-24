import { createHmac, timingSafeEqual } from 'node:crypto';
import { raw, type NextFunction, type Request, type Response } from 'express';
import { SHOP_DOMAIN } from './shopify-oauth.js';

/** Where the HON Shopify app's webhook subscriptions (shopify.app.toml) deliver. */
export const SHOPIFY_WEBHOOK_PATH = '/v1/commerce/webhooks/shopify';
/** The topics HON acts on. Anything else is answered 200 and ignored, so Shopify does not retry it. */
export const SHOPIFY_WEBHOOK_TOPICS = [
  'products/create', 'products/update', 'products/delete', 'inventory_levels/update',
  'orders/create', 'orders/updated', 'orders/cancelled', 'orders/delete',
  'app/uninstalled', 'shop/redact', 'customers/redact', 'customers/data_request',
] as const;
export type ShopifyWebhookTopic = typeof SHOPIFY_WEBHOOK_TOPICS[number];
/** Shopify's payloads for one product with many variants can be large; the signature covers all of it. */
export const SHOPIFY_WEBHOOK_MAX_BYTES = 4 * 1024 * 1024;

const WEBHOOK_ID = /^[A-Za-z0-9-]{1,64}$/;
const BASE64_SHA256 = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Mounted before the JSON parser: Shopify's signature covers the exact raw bytes, so the body is kept as a Buffer.
 * POST to the one path only; no query string, cookies or credentials; JSON; bounded; no compression.
 */
export function shopifyWebhookTransport() {
  const parser = raw({ type: () => true, limit: SHOPIFY_WEBHOOK_MAX_BYTES, inflate: false });
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!/^\/v1\/commerce\/webhooks(?:\/|$)/i.test(req.path)) { next(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'POST' || req.path !== SHOPIFY_WEBHOOK_PATH || req.originalUrl.includes('?')
      || req.headers.cookie !== undefined || req.headers.authorization !== undefined
      || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')
      || (req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity')) {
      res.status(400).json({ received: false }); return;
    }
    parser(req, res, error => {
      if (error || !Buffer.isBuffer(req.body) || req.body.length === 0) { res.status(400).json({ received: false }); return; }
      next();
    });
  };
}

/** The base64 signature Shopify puts on a delivery (also used by the fake and tests). */
export function signShopifyWebhook(body: Buffer | string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

export interface VerifiedShopifyWebhook { webhookId: string; topic: ShopifyWebhookTopic; shopDomain: string; triggeredAt: string | null }
export type ShopifyWebhookCheck = { kind: 'VERIFIED'; webhook: VerifiedShopifyWebhook } | { kind: 'UNKNOWN_TOPIC' } | { kind: 'REFUSED' };

const header = (h: Record<string, string | string[] | undefined>, name: string): string | undefined => {
  const v = h[name]; return typeof v === 'string' ? v : undefined;
};

/**
 * The signature first (HMAC-SHA256 of the raw body with the app's client secret, compared in constant time); only then
 * the delivery id, shop domain and topic headers. The payload itself is never read: HON re-reads Shopify for changes.
 */
export function verifyShopifyWebhook(body: Buffer, headers: Record<string, string | string[] | undefined>, secret: string): ShopifyWebhookCheck {
  if (!Buffer.isBuffer(body) || body.length === 0 || body.length > SHOPIFY_WEBHOOK_MAX_BYTES || !secret) return { kind: 'REFUSED' };
  const given = header(headers, 'x-shopify-hmac-sha256');
  if (!given || !BASE64_SHA256.test(given)) return { kind: 'REFUSED' };
  const expected = createHmac('sha256', secret).update(body).digest();
  const actual = Buffer.from(given, 'base64');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { kind: 'REFUSED' };
  const webhookId = header(headers, 'x-shopify-webhook-id'), shopDomain = header(headers, 'x-shopify-shop-domain'), topic = header(headers, 'x-shopify-topic');
  if (!webhookId || !WEBHOOK_ID.test(webhookId) || !shopDomain || !SHOP_DOMAIN.test(shopDomain) || !topic) return { kind: 'REFUSED' };
  if (!(SHOPIFY_WEBHOOK_TOPICS as readonly string[]).includes(topic)) return { kind: 'UNKNOWN_TOPIC' };
  const at = header(headers, 'x-shopify-triggered-at');
  const ms = at && at.length <= 64 ? Date.parse(at) : NaN;
  return { kind: 'VERIFIED', webhook: { webhookId, topic: topic as ShopifyWebhookTopic, shopDomain, triggeredAt: Number.isFinite(ms) ? new Date(ms).toISOString() : null } };
}
