import { raw, type Request, type Response, type NextFunction } from 'express';

export const PAYMENT_WEBHOOK_PATH = '/v1/payments/webhooks/stripe';

/**
 * Mounted before the JSON parser: the provider signature covers the exact raw bytes, so the body is
 * kept as a Buffer for verification. No cookies, credentials or query strings; JSON only; bounded size.
 */
export function paymentWebhookTransport() {
  const parser = raw({ type: () => true, limit: 262144, inflate: false });
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!/^\/v1\/payments\/webhooks(?:\/|$)/i.test(req.path)) { next(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'POST' || req.path !== PAYMENT_WEBHOOK_PATH || req.originalUrl.includes('?')
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
