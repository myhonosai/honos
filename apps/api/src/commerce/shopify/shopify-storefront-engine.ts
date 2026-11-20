import type { ShopifyStorefrontSettings } from '@hon/contracts';
import { ShopifyProviderError, type ShopifyApp } from './shopify-adapter.js';
import { FAILURE_CODE, SHOPIFY_REFRESH_MARGIN_MS } from './shopify-sync-engine.js';

/** What begin_shopify_storefront_publish hands the API: the saved settings, the lease, the store and its sealed credential. */
export interface BegunStorefrontPublish {
  leaseToken: string; connectionId: string; shopDomain: string; settingsVersion: number; settings: ShopifyStorefrontSettings;
  credential: { keyId: string; sealed: string; version: number };
}
/** The begin answer, or null when it is not the shape HON expects (the settings are checked again by the caller). */
export function begunStorefrontPublish(v: unknown, settings: (s: unknown) => ShopifyStorefrontSettings): BegunStorefrontPublish | null {
  const o = v as Record<string, unknown> | null, k = (o?.credential ?? null) as Record<string, unknown> | null;
  if (!o || !k || typeof o.leaseToken !== 'string' || typeof o.connectionId !== 'string' || typeof o.shopDomain !== 'string'
    || !Number.isInteger(o.settingsVersion) || typeof k.keyId !== 'string' || typeof k.sealed !== 'string' || !Number.isInteger(k.version)) return null;
  let s: ShopifyStorefrontSettings;
  try { s = settings(o.settings); } catch { return null; }
  return { leaseToken: o.leaseToken, connectionId: o.connectionId, shopDomain: o.shopDomain, settingsVersion: o.settingsVersion as number,
    settings: s, credential: { keyId: k.keyId, sealed: k.sealed, version: k.version as number } };
}

export type StorefrontOutcome = 'PUBLISHED' | 'FAILED' | 'UNKNOWN';
export interface StorefrontSteps<T> {
  rotate(body: { expectedVersion: number; credential: { keyId: string; sealed: string; accessExpiresAt: string; refreshExpiresAt: string } }): Promise<unknown>;
  finish(outcome: StorefrontOutcome, failureCode: string | null): Promise<T>;
}

const refused = (e: ShopifyProviderError) => e.failure === 'REJECTED' || e.failure === 'AUTH' || e.failure === 'RATE_LIMITED';

/**
 * One publish under its lease: set HON's storefront settings metafield to the saved settings. Nothing else in the store is
 * touched. A refused write is FAILED; a write whose answer was lost is UNKNOWN (publishing again settles it, because the
 * write is idempotent). Tokens stay in memory.
 */
export async function runStorefrontPublish<T>(app: ShopifyApp, now: () => number, w: BegunStorefrontPublish, steps: StorefrontSteps<T>): Promise<T> {
  const binding = { connectionId: w.connectionId, shopDomain: w.shopDomain }, shop = w.shopDomain;
  let credential;
  try { credential = app.vault.open(binding, w.credential.keyId, w.credential.sealed); } catch { return steps.finish('FAILED', 'CREDENTIAL_UNREADABLE'); }
  let token = credential.accessToken;
  // Refreshing is a read as far as the store is concerned: any failure means nothing was written.
  try {
    if (Date.parse(credential.accessExpiresAt) - now() < SHOPIFY_REFRESH_MARGIN_MS) {
      if (Date.parse(credential.refreshExpiresAt) <= now()) return await steps.finish('FAILED', 'REFRESH_EXPIRED');
      const fresh = await app.adapter.refresh(shop, credential.refreshToken);
      const pair = { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, accessExpiresAt: fresh.accessExpiresAt, refreshExpiresAt: fresh.refreshExpiresAt };
      await steps.rotate({ expectedVersion: w.credential.version,
        credential: { keyId: app.vault.keyId, sealed: app.vault.seal(binding, pair), accessExpiresAt: pair.accessExpiresAt, refreshExpiresAt: pair.refreshExpiresAt } });
      token = pair.accessToken;
    }
  } catch (e) {
    if (e instanceof ShopifyProviderError) return steps.finish('FAILED', FAILURE_CODE[e.failure]);
    throw e;
  }
  try { await app.adapter.setStorefrontSettings(shop, token, w.settings); }
  catch (e) {
    if (!(e instanceof ShopifyProviderError)) throw e;
    return steps.finish(refused(e) ? 'FAILED' : 'UNKNOWN', FAILURE_CODE[e.failure]);
  }
  return steps.finish('PUBLISHED', null);
}
