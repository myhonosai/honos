import { raw, type Request, type Response, type NextFunction } from 'express';
import { parsePublicFormJson } from '../marketing/public-form-transport.js';
import { sharedPublicClientLimit, type PublicClientLimit } from '../schedule/public-client-limit.js';

/**
 * 0499 signing links: strict transport for /v1/public/membership-agreement-links. Only the two canonical paths (read the link,
 * sign it), no query string, JSON bodies of at most 8 KiB with no duplicate keys, never cached or indexed. The shared
 * per-client limiter and a fixed process cap sit in front; the 256-bit token is the only key and signs once.
 */
const READ = /^\/v1\/public\/membership-agreement-links\/[A-Za-z0-9_-]{43}$/;
const SIGN = /^\/v1\/public\/membership-agreement-links\/[A-Za-z0-9_-]{43}\/sign$/;
export function publicAgreementLinkTransport(clients: PublicClientLimit = sharedPublicClientLimit()) {
  const parser = raw({ type: () => true, limit: 8192, inflate: false });
  let start = Date.now(), attempts = 0;
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!/^\/v1\/public\/membership-agreement-links(?:\/|$)/i.test(req.path)) { next(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex');
    if (req.originalUrl.includes('?')) { res.status(400).json({ result: 'INVALID' }); return; }
    if (req.method === 'GET') {
      if (!READ.test(req.path) || req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) !== 0) {
        res.status(400).json({ result: 'INVALID' }); return;
      }
      if (limited(clients.admit('read', req.headers['x-forwarded-for']), res)) return;
      next(); return;
    }
    if (req.method !== 'POST' || !SIGN.test(req.path)) { res.status(400).json({ result: 'INVALID' }); return; }
    if (Date.now() - start >= 60000) { start = Date.now(); attempts = 0; }
    if (++attempts > 600) { res.setHeader('Retry-After', '60'); res.status(429).json({ result: 'RATE_LIMITED' }); return; }
    if (limited(clients.admit('book', req.headers['x-forwarded-for']), res)) return;
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
function limited(wait: number, res: Response): boolean {
  if (!wait) return false;
  res.setHeader('Retry-After', String(wait)); res.status(429).json({ result: 'RATE_LIMITED' });
  return true;
}
