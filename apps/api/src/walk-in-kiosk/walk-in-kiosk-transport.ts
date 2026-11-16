import { raw, type Request, type Response, type NextFunction } from 'express';
import { configuredPublicOrigin } from '@hon/auth';
import { parsePublicFormJson } from '../marketing/public-form-transport.js';

/**
 * Walk-in kiosk (0396): strict transport for the tablet calls under /v1/walk-in-kiosk. Only the two fixed POST paths, no query
 * string, same-origin JSON of at most 32 KiB without duplicate keys, and no cookie, Authorization, Referer or X-HON-* header:
 * the tablet's only authority is the device token in the body. A fixed-memory process cap backs the per-device and per-contact limits kept in SQL
 * (a school's tablets share one address, so no per-address limit applies here).
 */
export function walkInKioskTransport() {
  const parser = raw({ type: () => true, limit: 32768, inflate: false });
  let start = Date.now(), attempts = 0;
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!/^\/v1\/walk-in-kiosk(?:\/|$)/i.test(req.path)) { next(); return; }
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    let origin: string | undefined;
    try { origin = configuredPublicOrigin(process.env); } catch { /* fail closed */ }
    if (req.method !== 'POST' || !['/v1/walk-in-kiosk/terminal', '/v1/walk-in-kiosk/visits'].includes(req.path) || req.originalUrl.includes('?')
      || req.headers.cookie !== undefined || req.headers.authorization !== undefined || req.headers.referer !== undefined
      || Object.keys(req.headers).some(key => key.startsWith('x-hon'))
      || !origin || (req.headers.origin !== undefined && req.headers.origin !== origin)
      || (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin')
      || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')
      || (req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity')) {
      res.status(400).json({ result: 'INVALID' }); return;
    }
    if (Date.now() - start >= 60000) { start = Date.now(); attempts = 0; }
    if (++attempts > 600) { res.setHeader('Retry-After', '60'); res.status(429).json({ result: 'RATE_LIMITED' }); return; }
    parser(req, res, error => {
      if (error) { res.status(400).json({ result: 'INVALID' }); return; }
      try { req.body = parsePublicFormJson(req.body as Buffer); } catch { res.status(400).json({ result: 'INVALID' }); return; }
      next();
    });
  };
}
