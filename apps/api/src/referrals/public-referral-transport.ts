import { raw, type Request, type Response, type NextFunction } from 'express';
import { parsePublicFormJson } from '../marketing/public-form-transport.js';
import { sharedPublicClientLimit, type PublicClientLimit } from '../schedule/public-client-limit.js';

/**
 * 0604 strict transport for /v1/public/referrals: GET of one canonical code path, POST of its submissions with a JSON body
 * of at most 8 KiB and no duplicate keys, no query string. A fixed-memory process cap and the per-client limiter sit in front
 * of the per-code, per-form and per-contact limits kept in SQL.
 */
export function publicReferralTransport(clients: PublicClientLimit = sharedPublicClientLimit()) {
  const parser = raw({ type: () => true, limit: 8192, inflate: false });
  let start = Date.now(), attempts = 0;
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!/^\/v1\/public\/referrals(?:\/|$)/i.test(req.path)) { next(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.originalUrl.includes('?')) { res.status(400).json({ result: 'invalid' }); return; }
    if (req.method === 'GET') {
      if (!/^\/v1\/public\/referrals\/[0-9a-f]{16}$/.test(req.path) || req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) !== 0) {
        res.status(400).json({ result: 'invalid' }); return;
      }
      if (limited(clients.admit('read', req.headers['x-forwarded-for']), res)) return;
      next(); return;
    }
    if (req.method !== 'POST' || !/^\/v1\/public\/referrals\/[0-9a-f]{16}\/submissions$/.test(req.path)) { res.status(400).json({ result: 'invalid' }); return; }
    if (Date.now() - start >= 60000) { start = Date.now(); attempts = 0; }
    if (++attempts > 300) { res.setHeader('Retry-After', '60'); res.status(429).json({ result: 'rate-limited' }); return; }
    if (limited(clients.admit('book', req.headers['x-forwarded-for']), res)) return;
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')
      || (req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity')) { res.status(400).json({ result: 'invalid' }); return; }
    parser(req, res, error => {
      if (error) { res.status(400).json({ result: 'invalid' }); return; }
      try { req.body = parsePublicFormJson(req.body as Buffer); }
      catch { res.status(400).json({ result: 'invalid' }); return; }
      next();
    });
  };
}
function limited(wait: number, res: Response): boolean {
  if (!wait) return false;
  res.setHeader('Retry-After', String(wait)); res.status(429).json({ result: 'rate-limited' });
  return true;
}
