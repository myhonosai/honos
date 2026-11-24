import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException,
} from '@nestjs/common';
import { configuredPublicOrigin } from '@hon/auth';
import {
  SHOPIFY_EDIT_SCOPES, SHOPIFY_FINANCE_SCOPES, SHOPIFY_ORDER_SCOPES, SHOPIFY_STOREFRONT_BLOCKS, validateShopifyStorefrontPublish, validateShopifyStorefrontSave,
  verifyShopifyStorefront, verifyShopifyStorefrontPublishResult, type ShopifyStorefront, type ShopifyStorefrontLinks, type ShopifyStorefrontPublishResult,
  type ShopifyStorefrontSettings, SHOPIFY_RETURN_PATH, verifyShopifyFinanceSnapshot, verifyShopifyFinanceView, type ShopifyFinanceView, validateShopifyChangeCommandInput, validateShopifyProposeInput, verifyShopifyChangeResult,
  verifyShopifyProductChange, verifyShopifyProductChanges, type ShopifyChangeResult, type ShopifyProductChanges, validateShopifyCompleteInput, validateShopifyConnectInput, validateShopifyDisconnectInput, validateShopifySyncInput,
  verifyShopifyCatalog, verifyShopifyConnectResult, verifyShopifyConnectStart, shopifyNewStoreUrl, verifyShopifyDisconnectResult, verifyShopifyOrders, verifyShopifyOverview,
  verifyShopifySyncResult,
  type ShopifyCatalog, type ShopifyConnectResult, type ShopifyConnectStart, type ShopifyDisconnectResult, type ShopifyOrders, type ShopifyOverview,
  type ShopifySyncResult,
} from '@hon/contracts';
import type { HonRequest } from '../../foundation/hon-identity.service.js';
import { RuntimeDatabaseService, type ShopifyOperation } from '../../foundation/runtime-database.service.js';
import { SHOPIFY_APP, ShopifyProviderError, type ShopifyApp } from './shopify-adapter.js';
import { begunSync, runShopifySync } from './shopify-sync-engine.js';
import { leasedChange, runShopifyChange } from './shopify-change-engine.js';
import { begunStorefrontPublish, runStorefrontPublish } from './shopify-storefront-engine.js';
import { shopifyBackgroundEnabled } from './shopify-worker.js';
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
  SHOPIFY_EDIT_NOT_ALLOWED: 'Your Shopify store has not allowed HON to edit products yet. Press Allow editing and approve it in Shopify.',
  SHOPIFY_CHANGE_STALE: 'This product changed since the edit was prepared. Cancel it and prepare it again.',
  SHOPIFY_CHANGE_OPEN: 'This product already has an edit waiting. Approve or cancel that one first.',
  SHOPIFY_CHANGE_NOT_PENDING: 'This edit is no longer waiting for approval. Reload to see where it stands.',
  SHOPIFY_CHANGE_NOT_LEASED: 'This edit is no longer being sent. Reload to see where it stands.',
  SHOPIFY_CHANGE_ATTEMPTS: 'HON has tried this edit five times. Check the product in Shopify, close the edit as unresolved, then prepare it again if needed.',
  SHOPIFY_TOO_MANY_DRAFTS: 'There are already 20 new products waiting. Approve or cancel some first.',
  SHOPIFY_STOREFRONT_BUSY: 'HON is already publishing this store\'s storefront settings. Wait a moment and try again.',
  SHOPIFY_STOREFRONT_NOT_LEASED: 'This publish is no longer running. Reload to see where it stands.',
  SHOPIFY_STOREFRONT_LIMIT: 'HON has published storefront settings 100 times for this store today. Try again tomorrow.',
};
const STATUS: Record<string, number> = {
  SHOPIFY_INVALID: 400, SHOPIFY_CONNECT_STATE_INVALID: 400, SHOPIFY_CONNECT_STATE_EXPIRED: 400,
  SHOPIFY_FORBIDDEN: 403, SHOPIFY_NOT_FOUND: 404,
  SHOPIFY_SHOP_TAKEN: 409, SHOPIFY_OTHER_STORE_CONNECTED: 409, SHOPIFY_SYNC_RUNNING: 409, SHOPIFY_VERSION_CONFLICT: 409, SHOPIFY_NOT_CONNECTED: 409,
  SHOPIFY_SYNC_NOT_RUNNING: 409, SHOPIFY_RATE_LIMITED: 429,
  SHOPIFY_EDIT_NOT_ALLOWED: 409, SHOPIFY_CHANGE_STALE: 409, SHOPIFY_CHANGE_OPEN: 409, SHOPIFY_CHANGE_NOT_PENDING: 409, SHOPIFY_CHANGE_NOT_LEASED: 409,
  SHOPIFY_CHANGE_ATTEMPTS: 409, SHOPIFY_TOO_MANY_DRAFTS: 409,
  SHOPIFY_STOREFRONT_BUSY: 409, SHOPIFY_STOREFRONT_NOT_LEASED: 409, SHOPIFY_STOREFRONT_LIMIT: 429,
};
const STATES = ['22023', '42501', 'P0002', '40001', '23505', '55P03', '54000', '55000', '55006'];

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
    const out = this.checked(verifyShopifyOverview, raw && typeof raw === 'object' ? { ...(raw as object), connectEnabled: this.app !== null, autoSync: this.app !== null && shopifyBackgroundEnabled(process.env),
      newStoreUrl: shopifyNewStoreUrl(process.env.HON_SHOPIFY_NEW_STORE_URL?.trim()) } : raw);
    if (out.schoolId !== school) throw new ServiceUnavailableException({ code: 'SHOPIFY_UNAVAILABLE' });
    return out;
  }

  /** SH-F1 (commerce.shopify.manage): the latest Shopify Payments snapshot and whether the store allowed finance. */
  async finance(req: HonRequest, schoolId: unknown): Promise<ShopifyFinanceView> {
    const school = this.school(schoolId);
    const out = this.checked(verifyShopifyFinanceView, await this.call('finance', [this.subject(req), school]));
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
    // Allow editing (SH4a), Allow finance (SH-F1) and Allow orders (SH2b) ask for their scopes too; connecting alone stays read-only.
    // The storefront blocks (TB2) need no scope: HON writes only its own app-data metafield.
    const scopes = [...app.scopes, ...(input.allowEditing ? SHOPIFY_EDIT_SCOPES : []), ...(input.allowFinance ? SHOPIFY_FINANCE_SCOPES : []),
      ...(input.allowOrders ? SHOPIFY_ORDER_SCOPES : [])];
    const authorizeUrl = app.fake
      ? `${redirectUri}?${app.fake.approve(input.shopDomain, state, undefined, scopes)}`
      : shopifyAuthorizeUrl({ shop: input.shopDomain, clientId: app.clientId, scopes, redirectUri, state });
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

  /** SH4a: the store's editing permissions and its latest product changes. */
  async changes(req: HonRequest, schoolId: unknown): Promise<ShopifyProductChanges> {
    const school = this.school(schoolId);
    const out = this.checked(verifyShopifyProductChanges, await this.call('changes', [this.subject(req), school]));
    if (out.schoolId !== school) throw new ServiceUnavailableException({ code: 'SHOPIFY_UNAVAILABLE' });
    return out;
  }

  /** Saves a proposed product change for review. Nothing reaches Shopify. */
  async propose(req: HonRequest, body: unknown): Promise<ShopifyChangeResult> {
    const input = this.input(validateShopifyProposeInput, body);
    return this.checked(verifyShopifyChangeResult, await this.call('propose', [this.subject(req), JSON.stringify(input)]));
  }

  async cancelChange(req: HonRequest, body: unknown): Promise<ShopifyChangeResult> {
    const input = this.input(validateShopifyChangeCommandInput, body);
    return this.checked(verifyShopifyChangeResult, await this.call('cancelChange', [this.subject(req), JSON.stringify(input)]));
  }

  /**
   * The person approves this exact change: the database leases it to them, then HON checks the product in Shopify,
   * writes it, reads it back and records the result under that lease. An UNKNOWN change approved again is only checked.
   */
  async approveChange(req: HonRequest, body: unknown): Promise<ShopifyChangeResult> {
    const input = this.input(validateShopifyChangeCommandInput, body), subject = this.subject(req), app = this.requireApp();
    const raw = await this.call('approveChange', [subject, JSON.stringify(input)]) as { change?: unknown } | null;
    const change = this.checked(verifyShopifyProductChange, raw?.change);
    const lease = leasedChange(raw, change);
    if (!lease || change.changeId !== input.changeId) throw new ServiceUnavailableException({ code: 'SHOPIFY_UNAVAILABLE' });
    const bound = { schoolId: input.schoolId, changeId: change.changeId, leaseToken: lease.leaseToken };
    return runShopifyChange(app, this.now, lease, {
      rotate: b => this.call('rotateChange', [subject, JSON.stringify({ ...bound, ...b })]),
      record: async (outcome, failureCode, product) => this.checked(verifyShopifyChangeResult,
        await this.call('recordChange', [subject, JSON.stringify({ ...bound, outcome, failureCode, product })])),
    });
  }

  /**
   * TB2 (commerce.shopify.manage): the school's saved storefront settings, whether they are live, and the theme editor links
   * that add HON's blocks. The owner adds and saves blocks in Shopify's theme editor; HON never edits a theme.
   */
  async storefront(req: HonRequest, schoolId: unknown): Promise<ShopifyStorefront> {
    const school = this.school(schoolId);
    return this.storefrontView(await this.call('storefront', [this.subject(req), school]), school);
  }

  /** Saves the settings in HON only (a new version); nothing reaches Shopify until Publish. */
  async saveStorefront(req: HonRequest, body: unknown): Promise<ShopifyStorefront> {
    const input = this.input(validateShopifyStorefrontSave, body);
    const raw = await this.call('saveStorefront', [this.subject(req), JSON.stringify(input)]) as { settingsVersion?: unknown } | null;
    if (!raw || !Number.isInteger(raw.settingsVersion)) throw new ServiceUnavailableException({ code: 'SHOPIFY_UNAVAILABLE' });
    const out = await this.storefront(req, input.schoolId);
    if (out.settingsVersion === null || out.settingsVersion < (raw.settingsVersion as number)) throw new ServiceUnavailableException({ code: 'SHOPIFY_UNAVAILABLE' });
    return out;
  }

  /**
   * Publishes this exact saved version: the database leases the publish to this person, then HON writes its one settings
   * metafield on its own app installation and records the outcome under that lease. A lost answer is UNKNOWN; publishing
   * again settles it because the write is idempotent.
   */
  async publishStorefront(req: HonRequest, body: unknown): Promise<ShopifyStorefrontPublishResult> {
    const input = this.input(validateShopifyStorefrontPublish, body), subject = this.subject(req), app = this.requireApp();
    const w = begunStorefrontPublish(await this.call('beginStorefront', [subject, JSON.stringify(input)]), v => storefrontSettingsFrom(input.schoolId, v));
    if (!w || w.settingsVersion !== input.settingsVersion) throw new ServiceUnavailableException({ code: 'SHOPIFY_UNAVAILABLE' });
    const bound = { schoolId: input.schoolId, leaseToken: w.leaseToken };
    const done = await runStorefrontPublish(app, this.now, w, {
      rotate: b => this.call('rotateStorefront', [subject, JSON.stringify({ ...bound, ...b })]),
      finish: async (outcome, failureCode) => {
        const raw = await this.call('finishStorefront', [subject, JSON.stringify({ ...bound, outcome, failureCode })]) as { outcome?: unknown } | null;
        if (raw?.outcome !== outcome) throw new ServiceUnavailableException({ code: 'SHOPIFY_UNAVAILABLE' });
        return { outcome, failureCode };
      },
    });
    return this.checked(verifyShopifyStorefrontPublishResult, { ...done, storefront: await this.storefront(req, input.schoolId) });
  }

  private storefrontView(raw: unknown, school: string): ShopifyStorefront {
    const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
    const shop = typeof r?.shopDomain === 'string' ? r.shopDomain : null;
    const out = this.checked(verifyShopifyStorefront, r ? { ...r, links: shop && this.app ? storefrontLinks(shop, this.app.clientId) : null } : raw);
    if (out.schoolId !== school) throw new ServiceUnavailableException({ code: 'SHOPIFY_UNAVAILABLE' });
    return out;
  }

  /** A person's sync (Sync now, and the first sync after connecting), bound to their session at this school. */
  private async runSync(subject: string, schoolId: string): Promise<ShopifySyncResult> {
    const app = this.requireApp();
    const b = begunSync(await this.call('beginSync', [subject, JSON.stringify({ schoolId })]));
    if (!b) throw new ServiceUnavailableException({ code: 'SHOPIFY_UNAVAILABLE' });
    return runShopifySync(app, this.now, b, {
      rotate: body => this.call('rotate', [subject, JSON.stringify({ schoolId, syncId: b.syncId, ...body })]),
      page: body => this.call('page', [subject, JSON.stringify({ schoolId, syncId: b.syncId, ...body })]),
      finance: body => this.call('recordFinance', [subject, JSON.stringify({ schoolId, syncId: b.syncId, finance: verifyShopifyFinanceSnapshot(body.finance) })]),
      finish: async (outcome, failureCode) => {
        const raw = await this.call('finishSync', [subject, JSON.stringify({ schoolId, syncId: b.syncId, outcome, failureCode })]);
        const { syncId, ...rest } = (raw ?? {}) as Record<string, unknown>;
        if (syncId !== b.syncId) throw new ServiceUnavailableException({ code: 'SHOPIFY_UNAVAILABLE' });
        return this.checked(verifyShopifySyncResult, rest);
      },
    });
  }
}

/** The settings as the database handed them to the publish (checked with the same rules as a save). */
function storefrontSettingsFrom(schoolId: string, v: unknown): ShopifyStorefrontSettings {
  return validateShopifyStorefrontSave({ schoolId, expectedVersion: null, settings: v }).settings;
}

/**
 * Shopify theme editor deep links for HON's theme app extension (api_key = the app's client id, handle = the block file).
 * Each opens the store's live theme in the editor with the block added or the embed switched on, unsaved, for the owner to
 * preview and save. Shopify docs: theme-app-extensions/configuration, "Deep linking".
 */
export function storefrontLinks(shop: string, clientId: string): ShopifyStorefrontLinks {
  const base = `https://${shop}/admin/themes/current/editor?`, id = (h: string) => encodeURIComponent(clientId) + '/' + h;
  return {
    colors: `${base}context=apps&template=index&activateAppId=${id(SHOPIFY_STOREFRONT_BLOCKS.colors)}`,
    sizeGuide: `${base}template=product&addAppBlockId=${id(SHOPIFY_STOREFRONT_BLOCKS.sizeGuide)}&target=mainSection`,
    pickupNote: `${base}template=cart&addAppBlockId=${id(SHOPIFY_STOREFRONT_BLOCKS.pickupNote)}&target=newAppsSection`,
    pickupBanner: `${base}context=apps&template=cart&activateAppId=${id(SHOPIFY_STOREFRONT_BLOCKS.pickupBanner)}`,
  };
}
