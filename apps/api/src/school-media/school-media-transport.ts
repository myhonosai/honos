import { raw, type NextFunction, type Request, type Response } from 'express';
import { SCHOOL_MEDIA_LIMITS, SCHOOL_MEDIA_TYPES } from '@hon/contracts';
import { sharedPublicClientLimit, type PublicClientLimit } from '../schedule/public-client-limit.js';

const UPLOAD_PATH = /^\/v1\/organizations\/[0-9a-f-]{36}\/schools\/[0-9a-f-]{36}\/marketing\/media\/upload$/i;
/** At most this many pictures are being read into memory at once in one API process (25 MB each). */
export const MEDIA_UPLOADS_IN_FLIGHT = 4;

/**
 * 0628 staff upload transport: only POST .../marketing/media/upload, only a JPEG, PNG or GIF body of at most 25 MiB, not
 * compressed, and no more than four uploads in flight per process. Everything else on that path is refused before the body
 * is read. The guard, identity and database checks follow in the controller.
 */
export function schoolMediaUploadTransport() {
  const parser = raw({ type: () => true, limit: SCHOOL_MEDIA_LIMITS.maxBytes, inflate: false });
  let inFlight = 0;
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!/\/marketing\/media\/upload\/?$/i.test(req.path)) { next(); return; }
    res.setHeader('Cache-Control', 'private, no-store');
    const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    const length = Number(req.headers['content-length']);
    if (req.method !== 'POST' || !UPLOAD_PATH.test(req.path) || req.originalUrl.includes('?') || !(SCHOOL_MEDIA_TYPES as readonly string[]).includes(type)
      || req.headers['content-encoding'] !== undefined || req.headers['transfer-encoding'] !== undefined
      || !Number.isSafeInteger(length) || length < 1) {
      res.status(400).json({ code: 'VALIDATION_FAILED' }); return;
    }
    if (length > SCHOOL_MEDIA_LIMITS.maxBytes) { res.status(413).json({ code: 'MEDIA_TOO_LARGE', detail: 'A picture can be at most 25 MB.' }); return; }
    if (inFlight >= MEDIA_UPLOADS_IN_FLIGHT) { res.setHeader('Retry-After', '5'); res.status(503).json({ code: 'MEDIA_BUSY', detail: 'Other pictures are uploading. Try again in a moment.' }); return; }
    inFlight += 1;
    let released = false;
    const release = () => { if (!released) { released = true; inFlight -= 1; } };
    res.on('finish', release); res.on('close', release);
    parser(req, res, (error?: unknown) => {
      if (error) {
        const status = (error as { status?: number }).status === 413 ? 413 : 400;
        res.status(status).json({ code: status === 413 ? 'MEDIA_TOO_LARGE' : 'VALIDATION_FAILED' }); return;
      }
      if (!Buffer.isBuffer(req.body) || req.body.length !== length) { res.status(400).json({ code: 'VALIDATION_FAILED' }); return; }
      next();
    });
  };
}

/**
 * Strict transport for the public picture link /v1/public/media/<token> (the web serves it as /m/<token>): one GET path,
 * no query string, no body, a per-client limit and a fixed-memory process cap. Email image proxies fetch on behalf of many
 * readers, so the per-client window is the larger 'media' one.
 */
export function publicMediaTransport(clients: PublicClientLimit = sharedPublicClientLimit()) {
  let start = Date.now(), reads = 0;
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!/^\/v1\/public\/media(?:\/|$)/i.test(req.path)) { next(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!['GET', 'HEAD'].includes(req.method) || req.originalUrl.includes('?') || !/^\/v1\/public\/media\/[A-Za-z0-9_-]{43}$/.test(req.path)
      || req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) !== 0) {
      res.status(400).json({ result: 'INVALID' }); return;
    }
    if (Date.now() - start >= 60000) { start = Date.now(); reads = 0; }
    if (++reads > 12000) { res.setHeader('Retry-After', '60'); res.status(429).json({ result: 'RATE_LIMITED' }); return; }
    const wait = clients.admit('media', req.headers['x-forwarded-for']);
    if (wait) { res.setHeader('Retry-After', String(wait)); res.status(429).json({ result: 'RATE_LIMITED' }); return; }
    next();
  };
}
