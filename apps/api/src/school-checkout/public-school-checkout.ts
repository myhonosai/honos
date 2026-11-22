import { Controller, Get, Header, Injectable, NotFoundException, Param, ServiceUnavailableException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { CHECKOUT_PUBLIC_ID, verifyPublicCheckoutPage, type PublicCheckoutPage } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { sharedPublicClientLimit, type PublicClientLimit } from '../schedule/public-client-limit.js';

const READ = 'SELECT hon.read_public_school_checkout($1) AS data';

/**
 * Checkout page share links (0620): the family side. No session, cookie or tenant id is read; the link id alone names the
 * page and the database decides whether it may be shown (PUBLISHED page, ACTIVE school and organization, live entitlement).
 * Read only: nothing is bought, booked, stored or sent here, and HON adds no fee.
 */
@Injectable()
export class PublicSchoolCheckoutService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async page(publicId: string): Promise<PublicCheckoutPage | null> {
    if (typeof publicId !== 'string' || !CHECKOUT_PUBLIC_ID.test(publicId)) return null;
    let data: unknown;
    try { data = await this.database.runPublicEventCall(READ, [publicId]); }
    catch { throw new ServiceUnavailableException({ result: 'UNAVAILABLE' }); } // Never propagate PostgreSQL detail.
    if (data === null) return null;
    try { return verifyPublicCheckoutPage(data, publicId); }
    catch { throw new ServiceUnavailableException({ result: 'UNAVAILABLE' }); }
  }
}

@Controller('public/checkout-pages')
export class PublicSchoolCheckoutController {
  constructor(private readonly checkout: PublicSchoolCheckoutService) {}

  @Get(':publicId')
  @Header('Cache-Control', 'no-store')
  async page(@Param('publicId') publicId: string) {
    const data = await this.checkout.page(publicId);
    if (!data) throw new NotFoundException({ result: 'INVALID' });
    return { data };
  }
}

/**
 * Strict transport for /v1/public/checkout-pages: one GET path, no query string, no body, and the per-client read limit
 * shared with the other public links (public-client-limit.ts) plus a fixed-memory process cap.
 */
export function publicCheckoutTransport(clients: PublicClientLimit = sharedPublicClientLimit()) {
  let start = Date.now(), reads = 0;
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!/^\/v1\/public\/checkout-pages(?:\/|$)/i.test(req.path)) { next(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.method !== 'GET' || req.originalUrl.includes('?') || !/^\/v1\/public\/checkout-pages\/[a-f0-9]{48}$/.test(req.path)
      || req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) !== 0) {
      res.status(400).json({ result: 'INVALID' }); return;
    }
    if (Date.now() - start >= 60000) { start = Date.now(); reads = 0; }
    if (++reads > 6000) { res.setHeader('Retry-After', '60'); res.status(429).json({ result: 'RATE_LIMITED' }); return; }
    const wait = clients.admit('read', req.headers['x-forwarded-for']);
    if (wait) { res.setHeader('Retry-After', String(wait)); res.status(429).json({ result: 'RATE_LIMITED' }); return; }
    next();
  };
}
