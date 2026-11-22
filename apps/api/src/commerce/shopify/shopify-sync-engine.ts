import type { ShopifyFinanceSnapshot } from '@hon/contracts';
import { ShopifyProviderError, type MirrorOrder, type MirrorProduct, type ShopifyApp, type ShopifyFailure } from './shopify-adapter.js';

export const FAILURE_CODE: Record<ShopifyFailure, string> = {
  AUTH: 'TOKEN_REJECTED', RATE_LIMITED: 'SHOPIFY_RATE_LIMITED', UNAVAILABLE: 'SHOPIFY_UNAVAILABLE', INVALID_RESPONSE: 'SHOPIFY_INVALID_RESPONSE',
  REJECTED: 'SHOPIFY_REJECTED',
};
/** Orders HON mirrors per sync (the summary covers 30 days; 60 keeps late edits). */
export const SHOPIFY_ORDER_DAYS = 60;
/** A token with less than this left is refreshed before the sync starts. */
export const SHOPIFY_REFRESH_MARGIN_MS = 5 * 60_000;
const PAGE = 50;

/** What a sync's start hands the API: the run, the store and its sealed credential. */
export interface BegunSync { syncId: string; connectionId: string; shopDomain: string; credential: { keyId: string; sealed: string; version: number } }
export type SyncOutcome = 'SUCCEEDED' | 'FAILED' | 'NEEDS_RECONNECT';

/** The three database writes of a run, already bound to who runs it (a person's session, or the worker's lease). */
export interface SyncSteps<T> {
  rotate(body: { expectedVersion: number; credential: { keyId: string; sealed: string; accessExpiresAt: string; refreshExpiresAt: string } }): Promise<unknown>;
  page(body: { kind: 'PRODUCTS'; products: MirrorProduct[] } | { kind: 'ORDERS'; orders: MirrorOrder[] }): Promise<unknown>;
  finish(outcome: SyncOutcome, failureCode: string | null): Promise<T>;
  /** SH-F1: the Shopify Payments snapshot. Optional; a run without it never reads finance. */
  finance?(body: { finance: ShopifyFinanceSnapshot }): Promise<unknown>;
}

/** The begin answer, or null when it is not the shape HON expects. */
export function begunSync(v: unknown): BegunSync | null {
  const o = v as Record<string, unknown> | null, k = (o?.credential ?? null) as Record<string, unknown> | null;
  if (!o || !k || typeof o.syncId !== 'string' || typeof o.connectionId !== 'string' || typeof o.shopDomain !== 'string'
    || typeof k.keyId !== 'string' || typeof k.sealed !== 'string' || !Number.isInteger(k.version)) return null;
  return { syncId: o.syncId, connectionId: o.connectionId, shopDomain: o.shopDomain, credential: { keyId: k.keyId, sealed: k.sealed, version: k.version as number } };
}

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += PAGE) out.push(items.slice(i, i + PAGE));
  return out;
}

/**
 * SH-F1: reads Shopify Payments and records it. Finance never fails a sync: a store that did not grant the scope (Shopify
 * answers ACCESS_DENIED), a rate limit, an outage or a HON refusal leaves the last snapshot as it was. Only a refused
 * token still ends the run as NEEDS_RECONNECT, as any other read would.
 */
async function syncFinance(app: ShopifyApp, shop: string, token: string, record: (body: { finance: ShopifyFinanceSnapshot }) => Promise<unknown>): Promise<void> {
  let finance: ShopifyFinanceSnapshot;
  try { finance = await app.adapter.finance(shop, token); }
  catch (e) {
    if (e instanceof ShopifyProviderError && e.failure === 'AUTH') throw e;
    // Finance stays as it was, but the reason is kept: one word, never the shop or Shopify's text.
    console.warn(`shopify_finance_skipped stage=read reason=${e instanceof ShopifyProviderError ? e.failure : 'OTHER'}`);
    return;
  }
  await record({ finance }).catch(() => { console.warn('shopify_finance_skipped stage=record'); });
}

/**
 * One sync, the same for Sync now and for the background worker: the sealed pair is opened, refreshed when it is
 * about to expire (rotated in the database under its version), then the catalog and the last 60 days of orders are
 * written in pages of 50, then (SH-F1, when the run records finance) the Shopify Payments snapshot. Shopify refusing
 * the token ends the connection as NEEDS_RECONNECT, which destroys the stored
 * pair. Tokens live only in memory here and never reach an error, a log or an answer. Nothing is written to Shopify.
 */
export async function runShopifySync<T>(app: ShopifyApp, now: () => number, b: BegunSync, steps: SyncSteps<T>): Promise<T> {
  const binding = { connectionId: b.connectionId, shopDomain: b.shopDomain };
  try {
    let credential;
    try { credential = app.vault.open(binding, b.credential.keyId, b.credential.sealed); } catch { return await steps.finish('NEEDS_RECONNECT', 'CREDENTIAL_UNREADABLE'); }
    let token = credential.accessToken;
    if (Date.parse(credential.accessExpiresAt) - now() < SHOPIFY_REFRESH_MARGIN_MS) {
      if (Date.parse(credential.refreshExpiresAt) <= now()) return await steps.finish('NEEDS_RECONNECT', 'REFRESH_EXPIRED');
      const fresh = await app.adapter.refresh(b.shopDomain, credential.refreshToken);
      const pair = { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, accessExpiresAt: fresh.accessExpiresAt, refreshExpiresAt: fresh.refreshExpiresAt };
      await steps.rotate({ expectedVersion: b.credential.version,
        credential: { keyId: app.vault.keyId, sealed: app.vault.seal(binding, pair), accessExpiresAt: pair.accessExpiresAt, refreshExpiresAt: pair.refreshExpiresAt } });
      token = pair.accessToken;
    }
    const catalog = await app.adapter.catalog(b.shopDomain, token);
    for (const products of chunks<MirrorProduct>(catalog.products)) await steps.page({ kind: 'PRODUCTS', products });
    const since = new Date(now() - SHOPIFY_ORDER_DAYS * 86_400_000).toISOString();
    const orders = await app.adapter.orders(b.shopDomain, token, since);
    for (const page of chunks<MirrorOrder>(orders.orders)) await steps.page({ kind: 'ORDERS', orders: page });
    if (steps.finance) await syncFinance(app, b.shopDomain, token, steps.finance);
    if (!catalog.complete) return await steps.finish('FAILED', 'CATALOG_TOO_LARGE');
    if (!orders.complete) return await steps.finish('FAILED', 'ORDERS_TOO_MANY');
    return await steps.finish('SUCCEEDED', null);
  } catch (e) {
    if (e instanceof ShopifyProviderError) return steps.finish(e.failure === 'AUTH' ? 'NEEDS_RECONNECT' : 'FAILED', FAILURE_CODE[e.failure]);
    // A HON-side refusal mid-run: close the run as FAILED when still allowed (else it is abandoned after 15 minutes).
    await steps.finish('FAILED', 'HON_REFUSED').catch(() => undefined);
    throw e;
  }
}
