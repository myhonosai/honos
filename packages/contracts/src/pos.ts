/** 0488 front-desk Point of Sale. Sales and refunds are records of money the school took or paid back itself; HON moves no money. */
import { accountClosed, accountUuid } from './school-owner-invitations.js';

export const POS_HUMAN_COMMAND = 'school-pos' as const;
export const POS_CATEGORIES = ['TESTING', 'UNIFORMS', 'EQUIPMENT', 'APPAREL', 'EVENTS', 'OTHER'] as const;
export type PosCategory = typeof POS_CATEGORIES[number];
export const POS_METHODS = ['CASH', 'CHECK', 'CARD_TERMINAL', 'OTHER'] as const;
export type PosMethod = typeof POS_METHODS[number];
export const POS_CURRENCIES = ['USD', 'CAD', 'GBP', 'EUR', 'AUD', 'NZD', 'KRW', 'JPY', 'MXN'] as const;
export type PosCurrency = typeof POS_CURRENCIES[number];
export const POS_MAX_LINES = 50;

function fail(response: boolean): never { throw new Error(response ? 'POS_RESPONSE_INVALID' : 'POS_INPUT_INVALID'); }
function closed(v: unknown, keys: readonly string[], response: boolean): Record<string, unknown> { try { return accountClosed(v, keys); } catch { fail(response); } }
function id(v: unknown, response: boolean): string { try { return accountUuid(v).toLowerCase(); } catch { fail(response); } }
function maybeId(v: unknown, response: boolean): string | null { return v === null ? null : id(v, response); }
function int(v: unknown, lo: number, hi: number, response: boolean): number { if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) fail(response); return v as number; }
function bool(v: unknown, response: boolean): boolean { if (typeof v !== 'boolean') fail(response); return v; }
function text(v: unknown, max: number, response: boolean): string {
  // eslint-disable-next-line no-control-regex
  if (typeof v !== 'string' || v.length < 1 || v.length > max || v.trim() !== v || /[\x01-\x1f\x7f]/.test(v)) fail(response);
  return v;
}
function maybeText(v: unknown, max: number, response: boolean): string | null { return v === null ? null : text(v, max, response); }
function oneOf<T extends string>(v: unknown, list: readonly T[], response: boolean): T { if (!(list as readonly unknown[]).includes(v)) fail(response); return v as T; }
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const SKU = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
function date(v: unknown, response: boolean): string { if (typeof v !== 'string' || !DATE.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) fail(response); return v; }
function iso(v: unknown, response: boolean): string { if (typeof v !== 'string' || !ISO.test(v)) fail(response); return v; }
function arr(v: unknown, response: boolean): unknown[] { if (!Array.isArray(v)) fail(response); return v; }

/** Whole-number half-up a/b for non-negative a, positive b (same as hon.pos_div_round). */
export function posDivRound(a: number, b: number): number { return Math.floor((2 * a + b) / (2 * b)); }

export interface PosTotalsLine { unitPriceMinor: number; quantity: number; taxable: boolean }
export interface PosDiscount { kind: 'AMOUNT' | 'PERCENT'; value: number; reason: string }
export interface PosTotals { subtotalMinor: number; discountMinor: number; taxMinor: number; totalMinor: number }
/**
 * The exact arithmetic of hon.record_pos_sale, so the register shows the total the database will accept: discount off the
 * subtotal (a percent rounds half up), the taxable share of the discount taken off the taxable lines, tax on what is
 * left at the school rate (basis points, half up).
 */
export function computePosTotals(lines: readonly PosTotalsLine[], discount: Pick<PosDiscount, 'kind' | 'value'> | null, taxRateBps: number): PosTotals {
  const sub = lines.reduce((s, l) => s + l.unitPriceMinor * l.quantity, 0);
  const taxableSub = lines.reduce((s, l) => s + (l.taxable ? l.unitPriceMinor * l.quantity : 0), 0);
  const disc = !discount ? 0 : Math.min(sub, discount.kind === 'PERCENT' ? posDivRound(sub * discount.value, 100) : discount.value);
  const taxableAfter = taxableSub - (sub === 0 ? 0 : posDivRound(disc * taxableSub, sub));
  const tax = posDivRound(taxableAfter * taxRateBps, 10000);
  return { subtotalMinor: sub, discountMinor: disc, taxMinor: tax, totalMinor: sub - disc + tax };
}

// ---- Inputs (closed; the database checks every field again) ----

export interface PosSettingsInput { schoolId: string; expectedVersion: number | null; currency: PosCurrency; taxRateBps: number }
export function validatePosSettingsInput(v: unknown): PosSettingsInput {
  const o = closed(v, ['schoolId', 'expectedVersion', 'currency', 'taxRateBps'], false);
  return Object.freeze({ schoolId: id(o.schoolId, false), expectedVersion: o.expectedVersion === null ? null : int(o.expectedVersion, 1, 999_999_999, false),
    currency: oneOf(o.currency, POS_CURRENCIES, false), taxRateBps: int(o.taxRateBps, 0, 2500, false) });
}

export interface PosItemInput {
  schoolId: string; itemId: string | null; expectedVersion: number | null; name: string; sku: string | null; category: PosCategory; priceMinor: number;
  taxable: boolean; trackStock: boolean; lowStockAt: number | null; startingStock: number; active: boolean;
}
export function validatePosItemInput(v: unknown): PosItemInput {
  const o = closed(v, ['schoolId', 'itemId', 'expectedVersion', 'name', 'sku', 'category', 'priceMinor', 'taxable', 'trackStock', 'lowStockAt', 'startingStock', 'active'], false);
  const itemId = maybeId(o.itemId, false), expectedVersion = o.expectedVersion === null ? null : int(o.expectedVersion, 1, 999_999_999, false);
  if ((itemId === null) !== (expectedVersion === null)) fail(false);
  if (o.sku !== null && (typeof o.sku !== 'string' || !SKU.test(o.sku))) fail(false);
  const trackStock = bool(o.trackStock, false), lowStockAt = o.lowStockAt === null ? null : int(o.lowStockAt, 0, 1_000_000, false);
  const startingStock = int(o.startingStock, 0, 1_000_000, false);
  if (!trackStock && (lowStockAt !== null || startingStock !== 0)) fail(false);
  if (itemId !== null && startingStock !== 0) fail(false);
  return Object.freeze({ schoolId: id(o.schoolId, false), itemId, expectedVersion, name: text(o.name, 80, false), sku: o.sku as string | null,
    category: oneOf(o.category, POS_CATEGORIES, false), priceMinor: int(o.priceMinor, 0, 10_000_000, false), taxable: bool(o.taxable, false),
    trackStock, lowStockAt, startingStock, active: bool(o.active, false) });
}

export interface PosStockInput { schoolId: string; itemId: string; expectedVersion: number; change: number; reason: string }
export function validatePosStockInput(v: unknown): PosStockInput {
  const o = closed(v, ['schoolId', 'itemId', 'expectedVersion', 'change', 'reason'], false);
  const change = int(o.change, -1_000_000, 1_000_000, false); if (change === 0) fail(false);
  return Object.freeze({ schoolId: id(o.schoolId, false), itemId: id(o.itemId, false), expectedVersion: int(o.expectedVersion, 1, 999_999_999, false),
    change, reason: text(o.reason, 200, false) });
}

export type PosSaleLineInput = { itemId: string; quantity: number } | { description: string; unitPriceMinor: number; quantity: number };
export interface PosSaleInput {
  schoolId: string; personId: string | null; walkInName: string | null; lines: PosSaleLineInput[]; discount: PosDiscount | null;
  method: PosMethod; reference: string | null; note: string | null; expectedTotalMinor: number;
}
export function validatePosSaleInput(v: unknown): PosSaleInput {
  const o = closed(v, ['schoolId', 'personId', 'walkInName', 'lines', 'discount', 'method', 'reference', 'note', 'expectedTotalMinor'], false);
  const personId = maybeId(o.personId, false), walkInName = maybeText(o.walkInName, 120, false);
  if (personId && walkInName) fail(false);
  const raw = arr(o.lines, false); if (raw.length < 1 || raw.length > POS_MAX_LINES) fail(false);
  const lines = raw.map((l): PosSaleLineInput => {
    if (l && typeof l === 'object' && 'itemId' in l) { const x = closed(l, ['itemId', 'quantity'], false); return { itemId: id(x.itemId, false), quantity: int(x.quantity, 1, 999, false) }; }
    const x = closed(l, ['description', 'unitPriceMinor', 'quantity'], false);
    return { description: text(x.description, 80, false), unitPriceMinor: int(x.unitPriceMinor, 1, 10_000_000, false), quantity: int(x.quantity, 1, 999, false) };
  });
  let discount: PosDiscount | null = null;
  if (o.discount !== null) {
    const d = closed(o.discount, ['kind', 'value', 'reason'], false); const kind = oneOf(d.kind, ['AMOUNT', 'PERCENT'] as const, false);
    discount = { kind, value: int(d.value, 1, kind === 'PERCENT' ? 100 : 100_000_000, false), reason: text(d.reason, 200, false) };
  }
  return Object.freeze({ schoolId: id(o.schoolId, false), personId, walkInName, lines, discount, method: oneOf(o.method, POS_METHODS, false),
    reference: maybeText(o.reference, 120, false), note: maybeText(o.note, 500, false), expectedTotalMinor: int(o.expectedTotalMinor, 0, 200_000_000, false) });
}

export interface PosRefundInput { schoolId: string; saleId: string; amountMinor: number; method: PosMethod; reason: string; restock: { lineId: string; quantity: number }[] }
export function validatePosRefundInput(v: unknown): PosRefundInput {
  const o = closed(v, ['schoolId', 'saleId', 'amountMinor', 'method', 'reason', 'restock'], false);
  const restock = arr(o.restock, false).map(r => { const x = closed(r, ['lineId', 'quantity'], false); return { lineId: id(x.lineId, false), quantity: int(x.quantity, 1, 999, false) }; });
  if (restock.length > POS_MAX_LINES || new Set(restock.map(r => r.lineId)).size !== restock.length) fail(false);
  return Object.freeze({ schoolId: id(o.schoolId, false), saleId: id(o.saleId, false), amountMinor: int(o.amountMinor, 1, 200_000_000, false),
    method: oneOf(o.method, POS_METHODS, false), reason: text(o.reason, 500, false), restock });
}

export function validatePosDateRange(from: unknown, to: unknown): { from: string; to: string } {
  const f = date(from, false), t = date(to, false);
  const days = (Date.parse(t + 'T00:00:00Z') - Date.parse(f + 'T00:00:00Z')) / 86_400_000;
  if (days < 0 || days > 366) fail(false);
  return { from: f, to: t };
}

// ---- Responses ----

export interface PosItem {
  itemId: string; name: string; sku: string | null; category: PosCategory; priceMinor: number; taxable: boolean; trackStock: boolean;
  stock: number | null; lowStockAt: number | null; lowStock: boolean; active: boolean; version: number;
}
function item(v: unknown): PosItem {
  const o = closed(v, ['itemId', 'name', 'sku', 'category', 'priceMinor', 'taxable', 'trackStock', 'stock', 'lowStockAt', 'lowStock', 'active', 'version'], true);
  const trackStock = bool(o.trackStock, true);
  if (o.sku !== null && (typeof o.sku !== 'string' || !SKU.test(o.sku))) fail(true);
  if (trackStock === (o.stock === null)) fail(true);
  return Object.freeze({ itemId: id(o.itemId, true), name: text(o.name, 80, true), sku: o.sku as string | null, category: oneOf(o.category, POS_CATEGORIES, true),
    priceMinor: int(o.priceMinor, 0, 10_000_000, true), taxable: bool(o.taxable, true), trackStock, stock: o.stock === null ? null : int(o.stock, 0, 1_000_000, true),
    lowStockAt: o.lowStockAt === null ? null : int(o.lowStockAt, 0, 1_000_000, true), lowStock: bool(o.lowStock, true), active: bool(o.active, true),
    version: int(o.version, 1, 999_999_999, true) });
}
export interface PosSettings { currency: PosCurrency; taxRateBps: number; version: number | null }
function settings(v: unknown): PosSettings {
  const o = closed(v, ['currency', 'taxRateBps', 'version'], true);
  return Object.freeze({ currency: oneOf(o.currency, POS_CURRENCIES, true), taxRateBps: int(o.taxRateBps, 0, 2500, true),
    version: o.version === null ? null : int(o.version, 1, 999_999_999, true) });
}
export interface PosRead {
  schoolId: string; timezone: string; today: string; canManage: boolean; settings: PosSettings; items: PosItem[];
  todaySales: { count: number; totalMinor: number };
}
export function validatePosRead(v: unknown): PosRead {
  const o = closed(v, ['schoolId', 'timezone', 'today', 'canManage', 'settings', 'items', 'todaySales'], true);
  const t = closed(o.todaySales, ['count', 'totalMinor'], true);
  return Object.freeze({ schoolId: id(o.schoolId, true), timezone: text(o.timezone, 64, true), today: date(o.today, true), canManage: bool(o.canManage, true),
    settings: settings(o.settings), items: arr(o.items, true).map(item),
    todaySales: { count: int(t.count, 0, 1_000_000_000, true), totalMinor: int(t.totalMinor, 0, Number.MAX_SAFE_INTEGER, true) } });
}

export type PosSaleStatus = 'PAID' | 'PARTLY_REFUNDED' | 'REFUNDED';
export interface PosSaleSummary {
  saleId: string; receiptNumber: string; soldAt: string; localDate: string; customer: { personId: string | null; name: string | null };
  firstItem: string; itemCount: number; currency: string; totalMinor: number; refundedMinor: number; method: PosMethod; status: PosSaleStatus;
}
const SUMMARY_KEYS = ['saleId', 'receiptNumber', 'soldAt', 'localDate', 'customer', 'firstItem', 'itemCount', 'currency', 'totalMinor', 'refundedMinor', 'method', 'status'] as const;
function summaryFrom(o: Record<string, unknown>): PosSaleSummary {
  const c = closed(o.customer, ['personId', 'name'], true);
  if (typeof o.receiptNumber !== 'string' || !/^POS-\d{8}-\d{4,9}$/.test(o.receiptNumber)) fail(true);
  if (typeof o.currency !== 'string' || !/^[A-Z]{3}$/.test(o.currency)) fail(true);
  return { saleId: id(o.saleId, true), receiptNumber: o.receiptNumber, soldAt: iso(o.soldAt, true), localDate: date(o.localDate, true),
    customer: { personId: maybeId(c.personId, true), name: c.name === null ? null : text(c.name, 120, true) }, firstItem: text(o.firstItem, 80, true),
    itemCount: int(o.itemCount, 1, 50_000, true), currency: o.currency, totalMinor: int(o.totalMinor, 0, 200_000_000, true),
    refundedMinor: int(o.refundedMinor, 0, 200_000_000, true), method: oneOf(o.method, POS_METHODS, true),
    status: oneOf(o.status, ['PAID', 'PARTLY_REFUNDED', 'REFUNDED'] as const, true) };
}
export interface PosSaleLine {
  lineId: string; itemId: string | null; name: string; sku: string | null; category: PosCategory | 'QUICK'; unitPriceMinor: number; quantity: number;
  lineTotalMinor: number; taxable: boolean; stockTracked: boolean; restockedQuantity: number;
}
export interface PosRefund { refundId: string; refundedAt: string; amountMinor: number; method: PosMethod; reason: string; restocked: { lineId: string; quantity: number }[]; refundedBy: string | null }
export interface PosSale extends PosSaleSummary {
  schoolName: string; soldBy: string | null; lines: PosSaleLine[]; subtotalMinor: number;
  discount: { kind: 'AMOUNT' | 'PERCENT'; value: number; reason: string; amountMinor: number } | null;
  taxRateBps: number; taxMinor: number; reference: string | null; note: string | null; refunds: PosRefund[];
}
export function validatePosSale(v: unknown): PosSale {
  const o = closed(v, [...SUMMARY_KEYS, 'schoolName', 'soldBy', 'lines', 'subtotalMinor', 'discount', 'taxRateBps', 'taxMinor', 'reference', 'note', 'refunds'], true);
  const lines = arr(o.lines, true).map((l): PosSaleLine => {
    const x = closed(l, ['lineId', 'itemId', 'name', 'sku', 'category', 'unitPriceMinor', 'quantity', 'lineTotalMinor', 'taxable', 'stockTracked', 'restockedQuantity'], true);
    return { lineId: id(x.lineId, true), itemId: maybeId(x.itemId, true), name: text(x.name, 80, true), sku: x.sku === null ? null : text(x.sku, 40, true),
      category: oneOf(x.category, [...POS_CATEGORIES, 'QUICK'] as const, true), unitPriceMinor: int(x.unitPriceMinor, 0, 10_000_000, true),
      quantity: int(x.quantity, 1, 999, true), lineTotalMinor: int(x.lineTotalMinor, 0, 2_147_483_647, true), taxable: bool(x.taxable, true),
      stockTracked: bool(x.stockTracked, true), restockedQuantity: int(x.restockedQuantity, 0, 999, true) };
  });
  if (lines.length < 1) fail(true);
  let discount: PosSale['discount'] = null;
  if (o.discount !== null) { const d = closed(o.discount, ['kind', 'value', 'reason', 'amountMinor'], true);
    discount = { kind: oneOf(d.kind, ['AMOUNT', 'PERCENT'] as const, true), value: int(d.value, 1, 100_000_000, true), reason: text(d.reason, 200, true), amountMinor: int(d.amountMinor, 1, 100_000_000, true) }; }
  const refunds = arr(o.refunds, true).map((r): PosRefund => {
    const x = closed(r, ['refundId', 'refundedAt', 'amountMinor', 'method', 'reason', 'restocked', 'refundedBy'], true);
    return { refundId: id(x.refundId, true), refundedAt: iso(x.refundedAt, true), amountMinor: int(x.amountMinor, 1, 200_000_000, true), method: oneOf(x.method, POS_METHODS, true),
      reason: text(x.reason, 500, true), restocked: arr(x.restocked, true).map(s => { const y = closed(s, ['lineId', 'quantity'], true); return { lineId: id(y.lineId, true), quantity: int(y.quantity, 1, 999, true) }; }),
      refundedBy: x.refundedBy === null ? null : text(x.refundedBy, 120, true) };
  });
  return Object.freeze({ ...summaryFrom(o), schoolName: text(o.schoolName, 200, true), soldBy: o.soldBy === null ? null : text(o.soldBy, 120, true), lines,
    subtotalMinor: int(o.subtotalMinor, 0, 100_000_000, true), discount, taxRateBps: int(o.taxRateBps, 0, 2500, true), taxMinor: int(o.taxMinor, 0, 100_000_000, true),
    reference: maybeText(o.reference, 120, true), note: maybeText(o.note, 500, true), refunds });
}

export interface PosReport {
  salesCount: number; grossMinor: number; discountMinor: number; taxMinor: number; collectedMinor: number; refundsCount: number; refundedMinor: number; netMinor: number;
  byMethod: { method: PosMethod; collectedMinor: number; refundedMinor: number }[]; topItems: { name: string; quantity: number; salesMinor: number }[];
}
export interface PosSales { from: string; to: string; sales: PosSaleSummary[]; report: PosReport | null }
const money = (v: unknown) => { if (!Number.isSafeInteger(v)) fail(true); return v as number; };
export function validatePosSales(v: unknown): PosSales {
  const o = closed(v, ['from', 'to', 'sales', 'report'], true);
  let report: PosReport | null = null;
  if (o.report !== null) {
    const r = closed(o.report, ['salesCount', 'grossMinor', 'discountMinor', 'taxMinor', 'collectedMinor', 'refundsCount', 'refundedMinor', 'netMinor', 'byMethod', 'topItems'], true);
    report = { salesCount: int(r.salesCount, 0, 1_000_000_000, true), grossMinor: money(r.grossMinor), discountMinor: money(r.discountMinor), taxMinor: money(r.taxMinor),
      collectedMinor: money(r.collectedMinor), refundsCount: int(r.refundsCount, 0, 1_000_000_000, true), refundedMinor: money(r.refundedMinor), netMinor: money(r.netMinor),
      byMethod: arr(r.byMethod, true).map(m => { const x = closed(m, ['method', 'collectedMinor', 'refundedMinor'], true); return { method: oneOf(x.method, POS_METHODS, true), collectedMinor: money(x.collectedMinor), refundedMinor: money(x.refundedMinor) }; }),
      topItems: arr(r.topItems, true).map(m => { const x = closed(m, ['name', 'quantity', 'salesMinor'], true); return { name: text(x.name, 80, true), quantity: int(x.quantity, 1, 1_000_000_000, true), salesMinor: money(x.salesMinor) }; }) };
  }
  return Object.freeze({ from: date(o.from, true), to: date(o.to, true), sales: arr(o.sales, true).map(s => Object.freeze(summaryFrom(closed(s, SUMMARY_KEYS, true)))), report });
}

export interface PosItemResult { item: PosItem; replayed: boolean }
export function validatePosItemResult(v: unknown): PosItemResult { const o = closed(v, ['item', 'replayed'], true); return Object.freeze({ item: item(o.item), replayed: bool(o.replayed, true) }); }
export interface PosSettingsResult { settings: PosSettings; replayed: boolean }
export function validatePosSettingsResult(v: unknown): PosSettingsResult { const o = closed(v, ['settings', 'replayed'], true); return Object.freeze({ settings: settings(o.settings), replayed: bool(o.replayed, true) }); }
export interface PosSaleResult { sale: PosSale; replayed: boolean }
export function validatePosSaleResult(v: unknown): PosSaleResult { const o = closed(v, ['sale', 'replayed'], true); return Object.freeze({ sale: validatePosSale(o.sale), replayed: bool(o.replayed, true) }); }
