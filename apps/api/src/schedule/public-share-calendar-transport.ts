import type { Request, Response, NextFunction } from 'express';
import { sharedPublicClientLimit, type PublicClientLimit } from './public-client-limit.js';

/**
 * 0583 shared calendars: strict transport for /v1/public/calendars. GET of one canonical path only, no query string and no body,
 * behind the per-client read limit shared with the other public links. Nothing here writes.
 */
export function publicShareCalendarTransport(clients: PublicClientLimit = sharedPublicClientLimit()) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!/^\/v1\/public\/calendars(?:\/|$)/i.test(req.path)) { next(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.method !== 'GET' || req.originalUrl.includes('?') || !/^\/v1\/public\/calendars\/[a-f0-9]{48}$/.test(req.path)
      || req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) !== 0) {
      res.status(400).json({ result: 'INVALID' }); return;
    }
    const wait = clients.admit('read', req.headers['x-forwarded-for']);
    if (wait) { res.setHeader('Retry-After', String(wait)); res.status(429).json({ result: 'RATE_LIMITED' }); return; }
    next();
  };
}
