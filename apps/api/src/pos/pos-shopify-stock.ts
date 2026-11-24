import { ShopifyProviderError, type ShopifyApp } from '../commerce/shopify/shopify-adapter.js';
import { FAILURE_CODE, SHOPIFY_REFRESH_MARGIN_MS } from '../commerce/shopify/shopify-sync-engine.js';

/** One stock change a POS sale or refund owes Shopify (0613). `change` is minus for a sale, plus for units put back. */
export interface PosStockTask { taskId: string; variantId: string; change: number; saleId: string; attempts: number }
/** What begin_pos_shopify_stock hands the API: the store, its sealed credential and the waiting changes. */
export interface BegunPosStock { connectionId: string; shopDomain: string; credential: { keyId: string; sealed: string; version: number }; tasks: PosStockTask[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The begin answer when there is something to send; null when there is nothing, the store is not sellable, or the shape is not HON's. */
export function begunPosStock(v: unknown): BegunPosStock | null {
  const o = v as Record<string, unknown> | null, k = (o?.credential ?? null) as Record<string, unknown> | null;
  if (!o || o.state !== 'READY' || !k || !Array.isArray(o.tasks) || o.tasks.length === 0 || o.tasks.length > 20 || typeof o.connectionId !== 'string'
    || typeof o.shopDomain !== 'string' || typeof k.keyId !== 'string' || typeof k.sealed !== 'string' || !Number.isInteger(k.version)) return null;
  const tasks: PosStockTask[] = [];
  for (const t of o.tasks as Record<string, unknown>[]) {
    if (!t || typeof t.taskId !== 'string' || !UUID.test(t.taskId) || typeof t.saleId !== 'string' || !UUID.test(t.saleId) || typeof t.variantId !== 'string'
      || !/^[1-9][0-9]{0,17}$/.test(t.variantId) || !Number.isInteger(t.change) || t.change === 0 || Math.abs(t.change as number) > 999
      || !Number.isInteger(t.attempts) || (t.attempts as number) < 1) return null;
    tasks.push({ taskId: t.taskId, variantId: t.variantId, change: t.change as number, saleId: t.saleId, attempts: t.attempts as number });
  }
  return { connectionId: o.connectionId, shopDomain: o.shopDomain, credential: { keyId: k.keyId, sealed: k.sealed, version: k.version as number }, tasks };
}

export type PosStockOutcome = 'DONE' | 'FAILED' | 'RETRY';
export interface PosStockSteps {
  rotate(body: { expectedVersion: number; credential: { keyId: string; sealed: string; accessExpiresAt: string; refreshExpiresAt: string } }): Promise<unknown>;
  finish(taskId: string, outcome: PosStockOutcome, failureCode: string | null): Promise<unknown>;
}
/** A change that could not be sent is tried again on later sales this many times, then waits for a manager as FAILED. */
export const POS_STOCK_MAX_ATTEMPTS = 5;

/**
 * The store's access token for a POS follow-up (stock change or order), refreshed and rotated when it is about to
 * expire. Tokens stay in memory. Answers how every waiting item must be settled when no token can be had.
 */
export async function posShopifyToken(app: ShopifyApp, now: () => number, w: Pick<BegunPosStock, 'connectionId' | 'shopDomain' | 'credential'>,
  rotate: PosStockSteps['rotate']): Promise<{ token: string } | { outcome: PosStockOutcome; code: string }> {
  const binding = { connectionId: w.connectionId, shopDomain: w.shopDomain };
  let credential;
  try { credential = app.vault.open(binding, w.credential.keyId, w.credential.sealed); } catch { return { outcome: 'FAILED', code: 'CREDENTIAL_UNREADABLE' }; }
  try {
    if (Date.parse(credential.accessExpiresAt) - now() >= SHOPIFY_REFRESH_MARGIN_MS) return { token: credential.accessToken };
    if (Date.parse(credential.refreshExpiresAt) <= now()) return { outcome: 'FAILED', code: 'REFRESH_EXPIRED' };
    const fresh = await app.adapter.refresh(w.shopDomain, credential.refreshToken);
    const pair = { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, accessExpiresAt: fresh.accessExpiresAt, refreshExpiresAt: fresh.refreshExpiresAt };
    await rotate({ expectedVersion: w.credential.version,
      credential: { keyId: app.vault.keyId, sealed: app.vault.seal(binding, pair), accessExpiresAt: pair.accessExpiresAt, refreshExpiresAt: pair.refreshExpiresAt } });
    return { token: pair.accessToken };
  } catch (e) {
    if (e instanceof ShopifyProviderError) return { outcome: e.failure === 'AUTH' || e.failure === 'REJECTED' ? 'FAILED' : 'RETRY', code: FAILURE_CODE[e.failure] };
    throw e;
  }
}

/**
 * Send the waiting changes, one Shopify call each, with the task id as Shopify's idempotency key: a change whose
 * answer was lost is simply sent again and Shopify applies it once. A change Shopify refuses, or a store that no longer
 * accepts HON's token, is FAILED (a manager sends it again after fixing the cause). Anything uncertain stays waiting
 * until POS_STOCK_MAX_ATTEMPTS. Tokens stay in memory. Never throws for a Shopify problem: the sale is already
 * recorded and must not look failed.
 */
export async function sendPosStock(app: ShopifyApp, now: () => number, w: BegunPosStock, steps: PosStockSteps): Promise<void> {
  const shop = w.shopDomain;
  const all = async (outcome: PosStockOutcome, code: string, from = 0) => { for (const t of w.tasks.slice(from)) await steps.finish(t.taskId, later(t, outcome), code); };
  const later = (t: PosStockTask, outcome: PosStockOutcome): PosStockOutcome => outcome === 'RETRY' && t.attempts >= POS_STOCK_MAX_ATTEMPTS ? 'FAILED' : outcome;
  const settle = (e: ShopifyProviderError): PosStockOutcome => e.failure === 'AUTH' || e.failure === 'REJECTED' ? 'FAILED' : 'RETRY';
  const opened = await posShopifyToken(app, now, w, steps.rotate);
  if ('outcome' in opened) return all(opened.outcome, opened.code);
  const token = opened.token;
  for (let i = 0; i < w.tasks.length; i++) {
    const t = w.tasks[i]!;
    try {
      const r = await app.adapter.adjustInventory(shop, token, { variantId: t.variantId, delta: t.change, idempotencyKey: t.taskId, reference: `honos://pos/sale/${t.saleId}` });
      await steps.finish(t.taskId, r.outcome === 'DONE' ? 'DONE' : 'FAILED', r.outcome === 'DONE' ? null : r.reason);
    } catch (e) {
      // Anything that is not Shopify's answer (a HON-side fault mid-send) must not leave the change waiting forever.
      if (!(e instanceof ShopifyProviderError)) { await steps.finish(t.taskId, later(t, 'RETRY'), 'HON_SEND_FAILED').catch(() => undefined); throw e; }
      // A store that refuses the token refuses every change: settle the rest the same way without calling again.
      if (e.failure === 'AUTH') return all('FAILED', FAILURE_CODE.AUTH, i);
      await steps.finish(t.taskId, later(t, settle(e)), FAILURE_CODE[e.failure]);
    }
  }
}
