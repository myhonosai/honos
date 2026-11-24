import type { Request, Response, NextFunction } from 'express';

/** WB2 (0361): strict transport for /v1/public/sites. Only GET of one canonical lower-case address, no query string, no body. */
export function publicSiteTransport() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!/^\/v1\/public\/sites(?:\/|$)/i.test(req.path)) { next(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.originalUrl.includes('?') || req.method !== 'GET' || !/^\/v1\/public\/sites\/[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/.test(req.path)
      || req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) !== 0) {
      res.status(400).json({ result: 'invalid' }); return;
    }
    next();
  };
}
