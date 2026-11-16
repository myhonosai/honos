import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException,
} from '@nestjs/common';
import { configuredPublicOrigin } from '@hon/auth';
import {
  SHOPIFY_RETURN_PATH, validateShopifyCompleteInput, validateShopifyConnectInput, validateShopifyDisconnectInput, validateShopifySyncInput,
  verifyShopifyCatalog, verifyShopifyConnectResult, verifyShopifyConnectStart, verifyShopifyDisconnectResult, verifyShopifyOrders, verifyShopifyOverview,
  verifyShopifySyncResult,
  type ShopifyCatalog, type ShopifyConnectResult, type ShopifyConnectStart, type ShopifyDisconnectResult, type ShopifyOrders, type ShopifyOverview,
  type ShopifySyncResult,
} from '@hon/contracts';
import type { HonRequest } from '../../foundation/hon-identity.service.js';
import { RuntimeDatabaseService, type ShopifyOperation } from '../../foundation/runtime-database.service.js';
import { SHOPIFY_APP, ShopifyProviderError, type MirrorOrder, type MirrorProduct, type ShopifyApp, type ShopifyFailure } from './shopify-adapter.js';
import { scopesGranted, shopifyAuthorizeUrl, verifyShopifyCallback } from './shopify-oauth.js';

const DETAIL: Record<string, string> = {
  SHOPIFY_SHOP_TAKEN: 'That Shopify store is already connected to another school.',
  SHOPIFY_OTHER_STORE_CONNECTED: 'This school already has a different Shopify store. Disconnect it first.',
  SHOPIFY_RATE_LIMITED: 'Too many connection attempts in the last hour. Try again later.',
  SHOPIFY_CONNECT_STATE_INVALID: 'This Shopify approval does not match a connection you started. Start again from the Shopify page.',
  SHOPIFY_CONNECT_STATE_EXPIRED: 'The Shopify approval took too long. Start again from the Shopify page.',
  SHOPIFY_NOT_CONNECTED: 'No Shopify store is connected right now.',
  SHOPIFY_SYNC_RUNNING: 'A sync is already running. Wait for it to finish.',
  SHOPIFY_VERSION_CONFLICT: 'Someone else changed this. Reload and try again.',
  SHOPIFY_CONNECT_OFF: 'Connecting Shopify is not turned on for HON yet.',
  SHOPIFY_CONNECT_REJECTED: 'Shopify did not accept this approval. Start again from the Shopify page.',
  SHOPIFY_SCOPES_MISSING: 'Shopify did not grant everything HON needs. Start again and approve every requested permission.',
};
const STATUS: Record<string, number> = {
  SHOPIFY_INVALID: 400, SHOPIFY_CONNECT_STATE_INVALID: 400, SHOPIFY_CONNECT_STATE_EXPIRED: 400,
  SHOPIFY_FORBIDDEN: 403, SHOPIFY_NOT_FOUND: 404,
  SHOPIFY_SHOP_TAKEN: 409, SHOPIFY_OTHER_STORE_CONNECTED: 409, SHOPIFY_SYNC_RUNNING: 409, SHOPIFY_VERSION_CONFLICT: 409, SHOPIFY_NOT_CONNECTED: 409,
  SHOPIFY_SYNC_NOT_RUNNING: 409, SHOPIFY_RATE_LIMITED: 429,
};
const STATES = ['22023', '42501', 'P0002', '40001', '23505', '55P03', '54000'];

function refuse(code: string, status: number): never {
  const body: Record<string, string> = { code };
  if (DETAIL[code]) body.detail = DETAIL[code];
  if (status === 400) throw new BadRequestException(body);
  if (status === 403) throw new ForbiddenException(body);
  if (status === 404) throw new NotFoundException(body);
  if (status === 409) throw new ConflictException(body);
  if (status === 503) throw new ServiceUnavailableException(body);
  throw new HttpException(body, status);
}

/** Database refusals become the same small set of HTTP answers; anything else is UNAVAILABLE (never a SQL message). */
export function translateShopifyError(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const status = STATUS[message];
  if (status && STATES.includes(sqlState)) refuse(message, status);
  if (sqlState === '42501') refuse('SHOPIFY_FORBIDDEN', 403);
  if (['22023', '22P02', '22008', '22007'].includes(sqlState)) refuse('SHOPIFY_INVALID', 400);
  throw new ServiceUnavailableException({ code: 'SHOPIFY_UNAVAILABLE' });
}

const FAILURE_CODE: Record<ShopifyFailure, string> = {
  AUTH: 'TOKEN_REJECTED', RATE_LIMITED: 'SHOPIFY_RATE_LIMITED', UNAVAILABLE: 'SHOPIFY_UNAVAILABLE', INVALID_RESPONSE: 'SHOPIFY_INVALID_RESPONSE',
};
/** Orders HON mirrors per sync (the summary covers 30 days; 60 keeps late edits). */
export const SHOPIFY_ORDER_DAYS = 60;
/** A token with less than this left is refreshed before the sync starts. */
export const SHOPIFY_REFRESH_MARGIN_MS = 5 * 60_000;
const PAGE = 50;

interface Begun { syncId: string; connectionId: string; shopDomain: string; credential: { keyId: string; sealed: string; version: number } }
function begun(v: unknown): Begun {
  const o = v as Record<string, unknown> | null, k = (o?.credential ?? null) as Record<string, unknown> | null;
  if (!o || !k || typeof o.syncId !== 'string' || typeof o.connectionId !== 'string' || typeof o.shopDomain !== 'string'
    || typeof k.keyId !== 'string' || typeof k.sealed !== 'string' || !Number.isInteger(k.version)) throw new ServiceUnavailableException({ code: 'SHOPIFY_UNAVAILABLE' });
  return { syncId: o.syncId, connectionId: o.connectionId, shopDomain: o.shopDomain, credential: { keyId: k.keyId, sealed: k.sealed, version: k.version as number } };
}
function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += PAGE) out.push(items.slice(i, i + PAGE));
  return out;
}

/**
 * 0405 Shopify connection (SH1). The subject comes only from the signed HON session; the database decides the school,
 * the organization and the permission (commerce.shopify.read / .manage). Tokens are opened only here, in memory, and
 * never returned, logged or put in an error. Nothing here writes to Shopify.
 */
@Injectable()
export class ShopifyService {
  constructor(private readonly database: RuntimeDatabaseService, @Optional() @Inject(SHOPIFY_APP) private readonly app: ShopifyApp | null = null,
    /** Test hook: the clock. */
    @Optional() @Inject('SHOPIFY_CLOCK') private readonly now: () => number = Date.now) {}

  private school(v: unknown): string {
    if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) refuse('SHOPIFY_INVALID', 400);
    return v.toLowerCase();
  }
  private subject(req: HonRequest): string {
    const s = req.honIdentity?.externalSubject;
    if (!s) throw new ForbiddenException({ code: 'SHOPIFY_FORBIDDEN' });
    return s;
  }
  private async call(op: ShopifyOperation, params: (string | null)[]): Promise<unknown> {
    try { return await this.database.callShopify(op, params); } catch (e) { return translateShopifyError(e); }
  }
  private checked<T>(verify: (v: unknown) => T, raw: unknown): T {
    try { return verify(raw); } catch { throw new ServiceUnavailableException({ code: 'SHOPIFY_UNAVAILABLE' }); }
  }
  private input<T>(validate: (v: unknown) => T, body: unknown): T {
    try { return validate(body); } catch { return refuse('SHOPIFY_INVALID', 400); }
  }
  private requireApp(): ShopifyApp { if (!this.app) refuse('SHOPIFY_CONNECT_OFF', 503); return this.app; }
  private origin(): string {
    try { const o = configuredPublicOrigin(process.env); if (o) return o; } catch { /* below */ }
    throw new ServiceUnavailableException({ code: 'HUMAN_UI_ORIGIN_NOT_CONFIGURED' });
  }

  async overview(req: HonRequest, schoolId: unknown): Promise<ShopifyOverview> {
    const school = this.school(schoolId);
    const raw = await this.call('read', [this.subject(req), school]);
    const out = this.checked(verifyShopifyOverview, raw && typeof raw === 'object' ? { ...(raw as object), connectEnabled: this.app !== null } : raw);
    if (out.schoolId !== school) throw new ServiceUnavailableException({ code: 'SHOPIFY_UNAVAILABLE' });
    return out;
  }

  async catalog(req: HonRequest, schoolId: unknown): Promise<ShopifyCatalog> {
    const school = this.school(schoolId);
    const out = this.checked(verifyShopifyCatalog, await this.call('catalog', [this.subject(req), school]));
    if (out.schoolId !== school) throw new ServiceUnavailableException({ code: 'SHOPIFY_UNAVAILABLE' });
    return out;
  }

  async orders(req: HonRequest, schoolId: unknown): Promise<ShopifyOrders> {
    const school = this.school(schoolId);
    const out = this.checked(verifyShopifyOrders, await this.call('orders', [this.subject(req), school]));
    if (out.schoolId !== school) throw new ServiceUnavailableException({ code: 'SHOPIFY_UNAVAILABLE' });
    return out;
  }

  /** Starts a connection: a single-use state (only its hash is stored) and the URL of Shopify's approval screen. */
  async start(req: HonRequest, body: unknown): Promise<ShopifyConnectStart> {
    const input = this.input(validateShopifyConnectInput, body), subject = this.subject(req);
    const app = this.requireApp(), origin = this.origin();
    const state = randomBytes(32).toString('base64url');
    const raw = await this.call('start', [subject, JSON.stringify({ schoolId: input.schoolId, shopDomain: input.shopDomain }), createHash('sha256').update(state).digest('hex')]);
    const r = raw as { shopDomain?: unknown; expiresAt?: unknown } | null;
    if (!r || r.shopDomain !== input.shopDomain) throw new ServiceUnavailableException({ code: 'SHOPIFY_UNAVAILABLE' });
    const redirectUri = origin + SHOPIFY_RETURN_PATH;
    const authorizeUrl = app.fake
      ? `${redirectUri}?${app.fake.approve(input.shopDomain, state)}`
      : shopifyAuthorizeUrl({ shop: input.shopDomain, clientId: app.clientId, scopes: app.scopes, redirectUri, state });
    return this.checked(verifyShopifyConnectStart, { authorizeUrl, shopDomain: input.shopDomain, expiresAt: r.expiresAt });
  }

  /**
   * Finishes a connection from the query Shopify put on the return page: signature first, then the single-use state,
   * then the one-time code. The token pair is sealed to this connection and shop before the database sees it.
   */
  async complete(req: HonRequest, body: unknown): Promise<ShopifyConnectResult> {
    const input = this.input(validateShopifyCompleteInput, body), subject = this.subject(req), app = this.requireApp();
    const callback = verifyShopifyCallback(input.query, app.clientSecret, this.now());
    if (!callback) refuse('SHOPIFY_CONNECT_STATE_INVALID', 400);
    const claimed = await this.call('claim', [subject, JSON.stringify({ schoolId: input.schoolId, shopDomain: callback.shop,
      stateHash: createHash('sha256').update(callback.state).digest('hex') })]) as { intentId?: unknown; connectionId?: unknown; shopDomain?: unknown } | null;
    if (!claimed || typeof claimed.intentId !== 'string' || typeof claimed.connectionId !== 'string' || claimed.shopDomain !== callback.shop) {
      throw new ServiceUnavailableException({ code: 'SHOPIFY_UNAVAILABLE' });
    }
    let tokens, info;
    try {
      tokens = await app.adapter.exchangeCode(callback.shop, callback.code);
      if (!scopesGranted(app.scopes, tokens.scope)) refuse('SHOPIFY_SCOPES_MISSING', 400);
      info = await app.adapter.shopInfo(callback.shop, tokens.accessToken);
    } catch (e) {
      if (e instanceof ShopifyProviderError) {
        if (e.failure === 'AUTH') refuse('SHOPIFY_CONNECT_REJECTED', 400);
        throw new ServiceUnavailableException({ code: 'SHOPIFY_UNAVAILABLE' });
      }
      throw e;
    }
    const credential = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, accessExpiresAt: tokens.accessExpiresAt, refreshExpiresAt: tokens.refreshExpiresAt };
    const sealed = app.vault.seal({ connectionId: claimed.connectionId, shopDomain: callback.shop }, credential);
    const recorded = await this.call('record', [subject, JSON.stringify({ schoolId: input.schoolId, intentId: claimed.intentId, shopName: info.name,
      currency: info.currency, scopes: tokens.scope, credential: { keyId: app.vault.keyId, sealed, accessExpiresAt: tokens.accessExpiresAt,
        refreshExpiresAt: tokens.refreshExpiresAt } })]) as { connection?: unknown } | null;
    // The first sync runs right away; a connection that recorded but could not sync is still connected.
    let firstSync: ShopifySyncResult | null = null;
    try { firstSync = await this.runSync(subject, input.schoolId); } catch { firstSync = null; }
    return this.checked(verifyShopifyConnectResult, { connection: firstSync ? firstSync.connection : recorded?.connection, firstSync });
  }

  async sync(req: HonRequest, body: unknown): Promise<ShopifySyncResult> {
    const input = this.input(validateShopifySyncInput, body);
    return this.runSync(this.subject(req), input.schoolId);
  }

  async disconnect(req: HonRequest, body: unknown): Promise<ShopifyDisconnectResult> {
    const input = this.input(validateShopifyDisconnectInput, body);
    return this.checked(verifyShopifyDisconnectResult, await this.call('disconnect', [this.subject(req), JSON.stringify(input)]));
  }

  /**
   * One sync: the sealed pair is opened, refreshed when it is about to expire (rotated in the database under its
   * version), then the catalog and the last 60 days of orders are written in pages of 50. Shopify refusing the token
   * ends the connection as NEEDS_RECONNECT, which destroys the stored pair.
   */
  private async runSync(subject: string, schoolId: string): Promise<ShopifySyncResult> {
    const app = this.requireApp();
    const b = begun(await this.call('beginSync', [subject, JSON.stringify({ schoolId })]));
    const finish = async (outcome: 'SUCCEEDED' | 'FAILED' | 'NEEDS_RECONNECT', failureCode: string | null): Promise<ShopifySyncResult> => {
      const raw = await this.call('finishSync', [subject, JSON.stringify({ schoolId, syncId: b.syncId, outcome, failureCode })]);
      const { syncId, ...rest } = (raw ?? {}) as Record<string, unknown>;
      if (syncId !== b.syncId) throw new ServiceUnavailableException({ code: 'SHOPIFY_UNAVAILABLE' });
      return this.checked(verifyShopifySyncResult, rest);
    };
    const binding = { connectionId: b.connectionId, shopDomain: b.shopDomain };
    try {
      let credential;
      try { credential = app.vault.open(binding, b.credential.keyId, b.credential.sealed); } catch { return await finish('NEEDS_RECONNECT', 'CREDENTIAL_UNREADABLE'); }
      let token = credential.accessToken;
      if (Date.parse(credential.accessExpiresAt) - this.now() < SHOPIFY_REFRESH_MARGIN_MS) {
        if (Date.parse(credential.refreshExpiresAt) <= this.now()) return await finish('NEEDS_RECONNECT', 'REFRESH_EXPIRED');
        const fresh = await app.adapter.refresh(b.shopDomain, credential.refreshToken);
        const pair = { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, accessExpiresAt: fresh.accessExpiresAt, refreshExpiresAt: fresh.refreshExpiresAt };
        await this.call('rotate', [subject, JSON.stringify({ schoolId, syncId: b.syncId, expectedVersion: b.credential.version,
          credential: { keyId: app.vault.keyId, sealed: app.vault.seal(binding, pair), accessExpiresAt: pair.accessExpiresAt, refreshExpiresAt: pair.refreshExpiresAt } })]);
        token = pair.accessToken;
      }
      const catalog = await app.adapter.catalog(b.shopDomain, token);
      for (const products of chunks<MirrorProduct>(catalog.products)) {
        await this.call('page', [subject, JSON.stringify({ schoolId, syncId: b.syncId, kind: 'PRODUCTS', products })]);
      }
      const since = new Date(this.now() - SHOPIFY_ORDER_DAYS * 86_400_000).toISOString();
      const orders = await app.adapter.orders(b.shopDomain, token, since);
      for (const page of chunks<MirrorOrder>(orders.orders)) {
        await this.call('page', [subject, JSON.stringify({ schoolId, syncId: b.syncId, kind: 'ORDERS', orders: page })]);
      }
      if (!catalog.complete) return await finish('FAILED', 'CATALOG_TOO_LARGE');
      if (!orders.complete) return await finish('FAILED', 'ORDERS_TOO_MANY');
      return await finish('SUCCEEDED', null);
    } catch (e) {
      if (e instanceof ShopifyProviderError) return finish(e.failure === 'AUTH' ? 'NEEDS_RECONNECT' : 'FAILED', FAILURE_CODE[e.failure]);
      // A HON-side refusal mid-run: close the run as FAILED when still allowed (else it is abandoned after 15 minutes).
      await finish('FAILED', 'HON_REFUSED').catch(() => undefined);
      throw e;
    }
  }
}
