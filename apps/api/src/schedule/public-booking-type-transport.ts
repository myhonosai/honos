import { raw, type Request, type Response, type NextFunction } from 'express';
import { parsePublicFormJson } from '../marketing/public-form-transport.js';

/**
 * School booking types (0286): strict transport for /v1/public/booking-types. Only the three canonical paths, no query string, JSON bodies of at
 * most 8 KiB with no duplicate keys. A fixed-memory process cap backs the per-type and per-contact limits kept in SQL.
 */
export function publicBookingTypeTransport() {
  const parser = raw({ type: () => true, limit: 8192, inflate: false });
  let start = Date.now(), attempts = 0;
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!/^\/v1\/public\/booking-types(?:\/|$)/i.test(req.path)) { next(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.originalUrl.includes('?')) { res.status(400).json({ result: 'INVALID' }); return; }
    if (req.method === 'GET') {
      if (!/^\/v1\/public\/booking-types\/[a-f0-9]{48}$/.test(req.path) || req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) !== 0) {
        res.status(400).json({ result: 'INVALID' }); return;
      }
      next(); return;
    }
    if (req.method !== 'POST' || !/^\/v1\/public\/booking-types\/[a-f0-9]{48}\/(?:bookings|cancellations)$/.test(req.path)) { res.status(400).json({ result: 'INVALID' }); return; }
    if (Date.now() - start >= 60000) { start = Date.now(); attempts = 0; }
    if (++attempts > 600) { res.setHeader('Retry-After', '60'); res.status(429).json({ result: 'RATE_LIMITED' }); return; }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')
      || (req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity')) { res.status(400).json({ result: 'INVALID' }); return; }
    parser(req, res, error => {
      if (error) { res.status(400).json({ result: 'INVALID' }); return; }
      try { req.body = parsePublicFormJson(req.body as Buffer); }
      catch { res.status(400).json({ result: 'INVALID' }); return; }
      next();
    });
  };
}
