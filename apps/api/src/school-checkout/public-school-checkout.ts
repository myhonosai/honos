import { Body, Controller, Get, Header, HttpCode, Injectable, NotFoundException, Param, Post, ServiceUnavailableException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { raw } from 'express';
import { configuredPublicOrigin } from '@hon/auth';
import {
  CHECKOUT_PUBLIC_ID, FAMILY_CHECKOUT_PAY_STATES, validatePublicCheckoutOrderInput, validatePublicCheckoutOrderKey, verifyPublicCheckoutOrder,
  verifyPublicCheckoutOutcome, verifyPublicCheckoutPage,
  type FamilyCheckoutPayState, type PublicCheckoutOrder, type PublicCheckoutOutcome, type PublicCheckoutPage, type PublicCheckoutResult,
  type SchoolPayProviderCode,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { SchoolPayOnceService } from '../school-payments/school-pay-once.service.js';
import { sharedPublicClientLimit, type PublicClientLimit } from '../schedule/public-client-limit.js';
import { parsePublicFormJson } from '../marketing/public-form-transport.js';

const READ = 'SELECT hon.read_public_school_checkout($1) AS data';
const OPEN = 'SELECT hon.open_public_checkout_order($1,$2::jsonb,$3,$4::boolean) AS data';
const LATEST = 'SELECT hon.read_public_checkout_order($1,$2) AS data';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROVIDERS = ['STRIPE_CONNECT', 'SQUARE'] as const;
const PAY_STATES = FAMILY_CHECKOUT_PAY_STATES.filter(s => s !== 'NONE');
// 0627 open refusals, as the page names them.
const OPEN_RESULTS: Record<string, PublicCheckoutResult> = {
  INVALID: 'INVALID', CHANGED: 'CHANGED', UNAVAILABLE: 'OPTION_UNAVAILABLE', FULL: 'FULL', WAIVER_REQUIRED: 'WAIVER_REQUIRED',
  NOT_AVAILABLE: 'NOT_AVAILABLE', RATE_LIMITED: 'RATE_LIMITED',
};
const refusal = (result: PublicCheckoutResult): PublicCheckoutOutcome => ({ result, order: null, payState: 'NONE', url: null, expiresAt: null });
const unavailable = () => new ServiceUnavailableException({ result: 'UNAVAILABLE' }); // Never PostgreSQL, processor or payment detail.

/**
 * Checkout page share links: the family side. No session, cookie or tenant id is read; the link id alone names the page
 * and the database decides whether it may be shown (PUBLISHED page, ACTIVE school and organization, live entitlement).
 * 0620 shows the page. 0627 lets a person without an account sign up from it and pay on the school's own processor page
 * (the shared one-time payment, HOSTED), TEST mode only; HON adds no fee. The browser names only the link, the key it made
 * and its order; who pays what is decided by the database, and the payment id never leaves the API (0529 caller rule).
 */
@Injectable()
export class PublicSchoolCheckoutService {
  constructor(private readonly database: RuntimeDatabaseService, private readonly once: SchoolPayOnceService) {}

  async page(publicId: string): Promise<PublicCheckoutPage | null> {
    if (typeof publicId !== 'string' || !CHECKOUT_PUBLIC_ID.test(publicId)) return null;
    const raw = await this.call(READ, [publicId]) as Record<string, unknown> | null;
    if (raw === null) return null;
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Unverified public checkout page.');
      const { providerCode, ...rest } = raw;
      if (Object.hasOwn(rest, 'canPay') || Object.hasOwn(rest, 'testMode')) throw new Error('Unverified public checkout page.');
      return verifyPublicCheckoutPage({ ...rest, canPay: this.canPay(providerCode), testMode: true }, publicId);
    } catch { throw unavailable(); }
  }

  /** Places the order (an exact repeat under the same key returns it again) and opens its processor page when not free. */
  async order(publicId: string, value: unknown): Promise<PublicCheckoutOutcome> {
    const body = (value ?? {}) as { key?: unknown; order?: unknown };
    if (!CHECKOUT_PUBLIC_ID.test(String(publicId)) || !value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'key') || !Object.hasOwn(value, 'order')) return refusal('INVALID');
    let key: string, input;
    try { key = validatePublicCheckoutOrderKey(body.key); input = validatePublicCheckoutOrderInput(body.order); } catch { return refusal('INVALID'); }
    // Checked before anything is written, so a priced order is refused rather than left without a way to pay.
    const back = this.returnUrl(publicId);
    const provider = await this.provider(publicId);
    const opened = await this.call(OPEN, [publicId, JSON.stringify(input), key, back !== null && provider !== null && this.once.supports(provider, 'HOSTED')]) as { result?: unknown; orderId?: unknown };
    if (!opened || typeof opened !== 'object' || typeof opened.result !== 'string') throw unavailable();
    if (opened.result !== 'OPEN' && opened.result !== 'PAID') {
      const mapped = OPEN_RESULTS[opened.result];
      if (!mapped) throw unavailable();
      return refusal(mapped);
    }
    if (typeof opened.orderId !== 'string' || !UUID.test(opened.orderId)) throw unavailable();
    return this.pay(publicId, key, opened.orderId);
  }

  /** Gets back (or opens) the processor page of an unpaid order. A payment that may have been paid is checked first. */
  async start(publicId: string, value: unknown): Promise<PublicCheckoutOutcome> {
    const key = this.keyOf(publicId, value);
    return key ? this.pay(publicId, key, null) : refusal('INVALID');
  }

  /** The processor's answer for the order's payment, recorded (the database then settles the order). */
  async status(publicId: string, value: unknown): Promise<PublicCheckoutOutcome> {
    const key = this.keyOf(publicId, value);
    if (!key) return refusal('INVALID');
    const first = await this.latest(publicId, key);
    if (!('order' in first)) return refusal(first.result);
    if (!first.paymentId) return this.outcome(first.order, 'NONE');
    let state = first.paymentState!;
    if (state === 'OPEN' || state === 'PROCESSING') state = await this.guard(() => this.once.confirm(first.paymentId!)).then(r => r.state);
    return this.outcome(await this.orderAgain(publicId, key, first.order.orderId), state);
  }

  /** Closes the order's open processor page; the processor decides CANCELED, or SUCCEEDED when it was already paid. */
  async cancel(publicId: string, value: unknown): Promise<PublicCheckoutOutcome> {
    const key = this.keyOf(publicId, value);
    if (!key) return refusal('INVALID');
    const first = await this.latest(publicId, key);
    if (!('order' in first)) return refusal(first.result);
    if (!first.paymentId) return this.outcome(first.order, 'NONE');
    let state = first.paymentState!;
    if (state === 'OPEN') state = await this.guard(() => this.once.cancel(first.paymentId!)).then(r => r.state);
    return this.outcome(await this.orderAgain(publicId, key, first.order.orderId), state);
  }

  private async pay(publicId: string, key: string, expected: string | null): Promise<PublicCheckoutOutcome> {
    const first = await this.latest(publicId, key);
    if (!('order' in first)) return refusal(first.result);
    if (expected !== null && first.order.orderId !== expected) throw unavailable();
    if (!first.paymentId) return this.outcome(first.order, 'NONE');
    let state = first.paymentState!;
    if (state === 'OPEN' || state === 'PROCESSING') state = (await this.guard(() => this.once.confirm(first.paymentId!))).state;
    if (state !== 'OPEN') return this.outcome(await this.orderAgain(publicId, key, first.order.orderId), state);
    // An order stays reachable through its link (to check or cancel it), but a page that no longer opens (taken down, or a
    // suspended school, organization or entitlement) hands out no processor page to pay on.
    if (await this.call(READ, [publicId]) === null) return this.outcome(first.order, 'OPEN');
    const back = this.returnUrl(publicId);
    if (!back || !first.providerCode || !this.once.supports(first.providerCode, 'HOSTED')) return this.outcome(first.order, 'OPEN');
    const page = await this.guard(() => this.once.start(first.paymentId!, { surface: 'HOSTED', returnUrl: back }));
    if (!page.url) throw unavailable();
    return this.outcome(first.order, 'OPEN', { url: page.url, expiresAt: page.expiresAt });
  }

  private outcome(order: PublicCheckoutOrder, payState: FamilyCheckoutPayState, page: { url: string; expiresAt: string } | null = null): PublicCheckoutOutcome {
    try { return verifyPublicCheckoutOutcome({ result: 'ORDER', order, payState, url: page?.url ?? null, expiresAt: page?.expiresAt ?? null }); }
    catch { throw unavailable(); }
  }

  /** Where the processor page returns to: the link's own page (no order, key or payment in the address). */
  private returnUrl(publicId: string): string | null {
    try { const origin = configuredPublicOrigin(process.env); return origin ? `${origin}/checkout/${publicId}` : null; } catch { return null; }
  }
  private originOk(): boolean {
    try { return configuredPublicOrigin(process.env) !== undefined; } catch { return false; }
  }
  private canPay(providerCode: unknown): boolean {
    const provider = PROVIDERS.find(p => p === providerCode);
    if (providerCode !== null && provider === undefined) throw new Error('Unverified provider.');
    return provider !== undefined && this.once.supports(provider, 'HOSTED') && this.originOk();
  }
  private async provider(publicId: string): Promise<SchoolPayProviderCode | null> {
    const raw = await this.call(READ, [publicId]) as { providerCode?: unknown } | null;
    if (raw === null) return null;
    const provider = PROVIDERS.find(p => p === raw?.providerCode);
    return provider ?? null;
  }
  private keyOf(publicId: string, value: unknown): string | null {
    if (!CHECKOUT_PUBLIC_ID.test(String(publicId)) || !value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'key')) return null;
    try { return validatePublicCheckoutOrderKey((value as { key: unknown }).key); } catch { return null; }
  }
  private async latest(publicId: string, key: string): Promise<{ result: PublicCheckoutResult } | {
    order: PublicCheckoutOrder; paymentId: string | null; paymentState: Exclude<FamilyCheckoutPayState, 'NONE'> | null; providerCode: SchoolPayProviderCode | null;
  }> {
    const raw = await this.call(LATEST, [publicId, key]) as { result?: unknown; order?: unknown; paymentId?: unknown; paymentState?: unknown; providerCode?: unknown };
    if (!raw || typeof raw !== 'object') throw unavailable();
    if (raw.result === 'INVALID') return { result: 'NOT_FOUND' };
    if (raw.result === 'RATE_LIMITED') return { result: 'RATE_LIMITED' };
    if (raw.result !== 'FOUND' || Object.keys(raw).length !== 5) throw unavailable();
    let order: PublicCheckoutOrder;
    try { order = verifyPublicCheckoutOrder(raw.order); } catch { throw unavailable(); }
    const providerCode = raw.providerCode === null ? null : PROVIDERS.find(p => p === raw.providerCode);
    if (providerCode === undefined) throw unavailable();
    if (raw.paymentId === null && raw.paymentState === null) return { order, paymentId: null, paymentState: null, providerCode };
    if (typeof raw.paymentId !== 'string' || !UUID.test(raw.paymentId) || !PAY_STATES.includes(raw.paymentState as typeof PAY_STATES[number])) throw unavailable();
    return { order, paymentId: raw.paymentId, paymentState: raw.paymentState as Exclude<FamilyCheckoutPayState, 'NONE'>, providerCode };
  }
  private async orderAgain(publicId: string, key: string, orderId: string): Promise<PublicCheckoutOrder> {
    const again = await this.latest(publicId, key);
    if (!('order' in again) || again.order.orderId !== orderId) throw unavailable();
    return again.order;
  }
  private async guard<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch { throw unavailable(); }
  }
  private async call(statement: string, values: unknown[]): Promise<unknown> {
    try { return await this.database.runPublicEventCall(statement, values); } catch { throw unavailable(); }
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

  @Post(':publicId/orders')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async order(@Param('publicId') publicId: string, @Body() body: unknown) { return { data: await this.checkout.order(publicId, body) }; }

  @Post(':publicId/orders/pay')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async start(@Param('publicId') publicId: string, @Body() body: unknown) { return { data: await this.checkout.start(publicId, body) }; }

  @Post(':publicId/orders/status')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async status(@Param('publicId') publicId: string, @Body() body: unknown) { return { data: await this.checkout.status(publicId, body) }; }

  @Post(':publicId/orders/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async cancel(@Param('publicId') publicId: string, @Body() body: unknown) { return { data: await this.checkout.cancel(publicId, body) }; }
}

const POST_PATH = /^\/v1\/public\/checkout-pages\/[a-f0-9]{48}\/orders(?:\/(pay|status|cancel))?$/;

/**
 * Strict transport for /v1/public/checkout-pages: the GET page read with no query and no body; four POST order steps with
 * a JSON body of at most 8 KiB (the shared public form parser) and no query. The per-client limits are shared with the other public links
 * (public-client-limit.ts: read for the page and status, book for order and pay, cancel for cancel), plus fixed-memory
 * process caps.
 */
export function publicCheckoutTransport(clients: PublicClientLimit = sharedPublicClientLimit()) {
  const parser = raw({ type: () => true, limit: 8192, inflate: false });
  let start = Date.now(), reads = 0, writes = 0;
  const limited = (wait: number, res: Response): boolean => {
    if (!wait) return false;
    res.setHeader('Retry-After', String(wait)); res.status(429).json({ result: 'RATE_LIMITED' });
    return true;
  };
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!/^\/v1\/public\/checkout-pages(?:\/|$)/i.test(req.path)) { next(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.originalUrl.includes('?')) { res.status(400).json({ result: 'INVALID' }); return; }
    if (Date.now() - start >= 60000) { start = Date.now(); reads = 0; writes = 0; }
    if (req.method === 'GET') {
      if (!/^\/v1\/public\/checkout-pages\/[a-f0-9]{48}$/.test(req.path) || req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) !== 0) {
        res.status(400).json({ result: 'INVALID' }); return;
      }
      if (++reads > 6000) { res.setHeader('Retry-After', '60'); res.status(429).json({ result: 'RATE_LIMITED' }); return; }
      if (limited(clients.admit('read', req.headers['x-forwarded-for']), res)) return;
      next(); return;
    }
    const step = req.method === 'POST' ? POST_PATH.exec(req.path) : null;
    if (!step) { res.status(400).json({ result: 'INVALID' }); return; }
    if (++writes > 1200) { res.setHeader('Retry-After', '60'); res.status(429).json({ result: 'RATE_LIMITED' }); return; }
    const action = step[1] === 'cancel' ? 'cancel' : step[1] === 'status' ? 'read' : 'book';
    if (limited(clients.admit(action, req.headers['x-forwarded-for']), res)) return;
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
