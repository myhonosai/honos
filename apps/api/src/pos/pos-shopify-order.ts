import { ShopifyProviderError, type ShopifyApp, type ShopifyPosAddress } from '../commerce/shopify/shopify-adapter.js';
import { FAILURE_CODE } from '../commerce/shopify/shopify-sync-engine.js';
import { POS_STOCK_MAX_ATTEMPTS, posShopifyToken, type BegunPosStock, type PosStockOutcome, type PosStockSteps } from './pos-shopify-stock.js';

/** One Shopify order a sale's made-to-order lines owe the print provider (0614). */
export interface PosOrderTask {
  orderTaskId: string; saleId: string; attempts: number; receiptNumber: string; currency: string; shipTo: ShopifyPosAddress;
  lines: { variantId: string; quantity: number; unitPriceMinor: number }[];
}
export interface BegunPosOrders { connectionId: string; shopDomain: string; credential: BegunPosStock['credential']; orders: PosOrderTask[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max;
const optional = (v: unknown, max: number): v is string | null => v === null || str(v, max);
function address(v: unknown): ShopifyPosAddress | null {
  const a = v as Record<string, unknown> | null;
  if (!a || typeof a !== 'object' || !str(a.name, 120) || !str(a.address1, 120) || !optional(a.address2, 120) || !str(a.city, 80) || !optional(a.province, 40)
    || !optional(a.zip, 20) || typeof a.country !== 'string' || !/^[A-Z]{2}$/.test(a.country)) return null;
  return { name: a.name, address1: a.address1, address2: a.address2, city: a.city, province: a.province, zip: a.zip, country: a.country };
}
/** The begin answer when there is an order to create; null when there is none, the store cannot take orders, or the shape is not HON's. */
export function begunPosOrders(v: unknown): BegunPosOrders | null {
  const o = v as Record<string, unknown> | null, k = (o?.credential ?? null) as Record<string, unknown> | null;
  if (!o || o.state !== 'READY' || !k || !Array.isArray(o.orders) || o.orders.length === 0 || o.orders.length > 5 || typeof o.connectionId !== 'string'
    || typeof o.shopDomain !== 'string' || typeof k.keyId !== 'string' || typeof k.sealed !== 'string' || !Number.isInteger(k.version)) return null;
  const orders: PosOrderTask[] = [];
  for (const t of o.orders as Record<string, unknown>[]) {
    const shipTo = address(t?.shipTo);
    if (!t || !shipTo || typeof t.orderTaskId !== 'string' || !UUID.test(t.orderTaskId) || typeof t.saleId !== 'string' || !UUID.test(t.saleId)
      || !Number.isInteger(t.attempts) || (t.attempts as number) < 1 || !str(t.receiptNumber, 40) || typeof t.currency !== 'string' || !/^[A-Z]{3}$/.test(t.currency)
      || !Array.isArray(t.lines) || t.lines.length < 1 || t.lines.length > 50) return null;
    const lines: PosOrderTask['lines'] = [];
    for (const l of t.lines as Record<string, unknown>[]) {
      if (!l || typeof l.variantId !== 'string' || !/^[1-9][0-9]{0,17}$/.test(l.variantId) || !Number.isInteger(l.quantity) || (l.quantity as number) < 1
        || (l.quantity as number) > 999 || !Number.isInteger(l.unitPriceMinor) || (l.unitPriceMinor as number) < 0 || (l.unitPriceMinor as number) > 10_000_000) return null;
      lines.push({ variantId: l.variantId, quantity: l.quantity as number, unitPriceMinor: l.unitPriceMinor as number });
    }
    orders.push({ orderTaskId: t.orderTaskId, saleId: t.saleId, attempts: t.attempts as number, receiptNumber: t.receiptNumber, currency: t.currency, shipTo, lines });
  }
  return { connectionId: o.connectionId, shopDomain: o.shopDomain, credential: { keyId: k.keyId, sealed: k.sealed, version: k.version as number }, orders };
}

/** POS minor units as the decimal Shopify expects (KRW and JPY have no minor unit, like hon.pos_shopify_minor). */
export function posOrderPrice(minor: number, currency: string): string {
  return currency === 'KRW' || currency === 'JPY' ? String(minor) : `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

export interface PosOrderSteps {
  rotate: PosStockSteps['rotate'];
  finish(orderTaskId: string, outcome: PosStockOutcome, failureCode: string | null, order: { orderId: string; orderName: string } | null): Promise<unknown>;
}

/**
 * Create the waiting orders, one Shopify order each. The order row id is the order's tag, and the adapter looks for
 * that tag before creating, so an order whose answer was lost is found instead of made twice. A refusal or a rejected
 * token is FAILED (a manager sends it again after fixing the cause); anything uncertain waits until
 * POS_STOCK_MAX_ATTEMPTS. Never throws for a Shopify problem: the sale is already recorded.
 */
export async function sendPosOrders(app: ShopifyApp, now: () => number, w: BegunPosOrders, steps: PosOrderSteps): Promise<void> {
  const later = (t: PosOrderTask, outcome: PosStockOutcome): PosStockOutcome => outcome === 'RETRY' && t.attempts >= POS_STOCK_MAX_ATTEMPTS ? 'FAILED' : outcome;
  const all = async (outcome: PosStockOutcome, code: string, from = 0) => { for (const t of w.orders.slice(from)) await steps.finish(t.orderTaskId, later(t, outcome), code, null); };
  const opened = await posShopifyToken(app, now, w, steps.rotate);
  if ('outcome' in opened) return all(opened.outcome, opened.code);
  for (let i = 0; i < w.orders.length; i++) {
    const t = w.orders[i]!;
    try {
      const r = await app.adapter.createPosOrder(w.shopDomain, opened.token, { key: t.orderTaskId, currency: t.currency, shipTo: t.shipTo,
        note: `Paid at the front desk. HON receipt ${t.receiptNumber}.`,
        lines: t.lines.map(l => ({ variantId: l.variantId, quantity: l.quantity, unitPrice: posOrderPrice(l.unitPriceMinor, t.currency) })) });
      if (r.outcome === 'DONE') await steps.finish(t.orderTaskId, 'DONE', null, { orderId: r.orderId, orderName: r.orderName });
      else await steps.finish(t.orderTaskId, 'FAILED', r.reason, null);
    } catch (e) {
      if (!(e instanceof ShopifyProviderError)) { await steps.finish(t.orderTaskId, later(t, 'RETRY'), 'HON_SEND_FAILED', null).catch(() => undefined); throw e; }
      if (e.failure === 'AUTH') return all('FAILED', FAILURE_CODE.AUTH, i);
      await steps.finish(t.orderTaskId, later(t, e.failure === 'REJECTED' ? 'FAILED' : 'RETRY'), FAILURE_CODE[e.failure], null);
    }
  }
}
