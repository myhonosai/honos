import { computePosTotals, type PosCategory, type PosDiscount, type PosItem, type PosMethod, type PosSaleInput, type PosShipTo, type PosShopifyItem, type PosTotals } from '@hon/contracts';

/** Register cart and money helpers (0612; Shopify products 0613; made-to-order items 0614). Pure: the screen and its tests share them. */
export type CartLine =
  | Readonly<{ kind: 'ITEM'; itemId: string; name: string; unitPriceMinor: number; taxable: boolean; quantity: number }>
  | Readonly<{ kind: 'QUICK'; id: string; name: string; unitPriceMinor: number; taxable: false; quantity: number }>
  | Readonly<{ kind: 'SHOPIFY'; variantId: string; name: string; unitPriceMinor: number; taxable: true; quantity: number; madeBy: string | null }>;
export type Customer = Readonly<{ kind: 'WALK_IN'; name: string }> | Readonly<{ kind: 'PERSON'; personId: string; name: string }>;
export type Cart = Readonly<{ lines: readonly CartLine[]; customer: Customer; discount: PosDiscount | null }>;
export const EMPTY_CART: Cart = { lines: [], customer: { kind: 'WALK_IN', name: '' }, discount: null };

const shopifyKey = (variantId: string) => 'shopify:' + variantId;
const lineKey = (l: CartLine) => l.kind === 'ITEM' ? l.itemId : l.kind === 'SHOPIFY' ? shopifyKey(l.variantId) : l.id;
export { lineKey };

/** Add one of an item, or one more of it when it is already in the cart. */
export function addItem(cart: Cart, item: PosItem): Cart {
  const at = cart.lines.findIndex(l => l.kind === 'ITEM' && l.itemId === item.itemId);
  const found = at >= 0 ? cart.lines[at] : undefined;
  if (found) return setQuantity(cart, item.itemId, found.quantity + 1);
  if (cart.lines.length >= 50) return cart;
  return { ...cart, lines: [...cart.lines, { kind: 'ITEM', itemId: item.itemId, name: item.name, unitPriceMinor: item.priceMinor, taxable: item.taxable, quantity: 1 }] };
}
/** Add one of a Shopify product (0613). The database prices it from the store's catalog; it is always taxed at the register rate. */
export function addShopify(cart: Cart, item: PosShopifyItem): Cart {
  const found = cart.lines.find(l => l.kind === 'SHOPIFY' && l.variantId === item.variantId);
  if (found) return setQuantity(cart, shopifyKey(item.variantId), found.quantity + 1);
  if (cart.lines.length >= 50) return cart;
  return { ...cart, lines: [...cart.lines, { kind: 'SHOPIFY', variantId: item.variantId, name: item.name, unitPriceMinor: item.priceMinor, taxable: true, quantity: 1, madeBy: item.madeBy }] };
}
export function addQuick(cart: Cart, id: string, name: string, amountMinor: number): Cart {
  if (cart.lines.length >= 50) return cart;
  return { ...cart, lines: [...cart.lines, { kind: 'QUICK', id, name, unitPriceMinor: amountMinor, taxable: false, quantity: 1 }] };
}
/** Quantity 0 removes the line; at most 999. */
export function setQuantity(cart: Cart, key: string, quantity: number): Cart {
  const q = Math.min(999, Math.max(0, Math.trunc(quantity)));
  return { ...cart, lines: cart.lines.flatMap(l => lineKey(l) !== key ? [l] : q === 0 ? [] : [{ ...l, quantity: q }]) };
}
/** Take catalog changes into the cart: new prices and tax flags; archived items and Shopify products no longer for sale are dropped. */
export function refreshCart(cart: Cart, items: readonly PosItem[], shopify: readonly PosShopifyItem[] = []): Cart {
  const byId = new Map(items.filter(i => i.active).map(i => [i.itemId, i])), byVariant = new Map(shopify.map(v => [v.variantId, v]));
  return { ...cart, lines: cart.lines.flatMap((l): CartLine[] => {
    if (l.kind === 'QUICK') return [l];
    if (l.kind === 'SHOPIFY') { const v = byVariant.get(l.variantId); return v ? [{ ...l, name: v.name, unitPriceMinor: v.priceMinor, madeBy: v.madeBy }] : []; }
    const i = byId.get(l.itemId); return i ? [{ ...l, name: i.name, unitPriceMinor: i.priceMinor, taxable: i.taxable }] : [];
  }) };
}
export function cartTotals(cart: Cart, taxRateBps: number): PosTotals {
  return computePosTotals(cart.lines, cart.discount, taxRateBps);
}
/** The exact sale request the database will price again. */
export function saleInput(schoolId: string, cart: Cart, taxRateBps: number, method: PosMethod, reference: string, note: string, shipTo: PosShipTo | null = null): PosSaleInput {
  const walk = cart.customer.kind === 'WALK_IN' ? cart.customer.name.trim() : '';
  return {
    schoolId, personId: cart.customer.kind === 'PERSON' ? cart.customer.personId : null, walkInName: walk ? walk.slice(0, 120) : null,
    lines: cart.lines.map(l => l.kind === 'ITEM' ? { itemId: l.itemId, quantity: l.quantity } : l.kind === 'SHOPIFY' ? { shopifyVariantId: l.variantId, quantity: l.quantity } : { description: l.name, unitPriceMinor: l.unitPriceMinor, quantity: l.quantity }),
    discount: cart.discount, method, reference: reference.trim() ? reference.trim().slice(0, 120) : null, note: note.trim() ? note.trim().slice(0, 500) : null,
    expectedTotalMinor: cartTotals(cart, taxRateBps).totalMinor,
    ...(hasMadeToOrder(cart) && shipTo ? { shipTo } : {}),
  };
}

/** 0614: a print provider makes and ships these, so the sale must say where they go. */
export const hasMadeToOrder = (cart: Cart) => cart.lines.some(l => l.kind === 'SHOPIFY' && l.madeBy !== null);
/** Where made-to-order items ship, as staff type it. */
export type ShipDraft = Readonly<{ kind: 'SCHOOL' | 'CUSTOMER'; name: string; address1: string; address2: string; city: string; province: string; zip: string; country: string }>;
export const emptyShip = (kind: ShipDraft['kind']): ShipDraft => ({ kind, name: '', address1: '', address2: '', city: '', province: '', zip: '', country: 'US' });
/** The address the sale sends, or null while it is not complete. */
export function shipToInput(d: ShipDraft): PosShipTo | null {
  if (d.kind === 'SCHOOL') return { kind: 'SCHOOL' };
  const t = (v: string, max: number) => v.trim().replace(/\s+/g, ' ').slice(0, max), country = d.country.trim().toUpperCase();
  const name = t(d.name, 120), address1 = t(d.address1, 120), city = t(d.city, 80);
  if (!name || !address1 || !city || !/^[A-Z]{2}$/.test(country)) return null;
  return { kind: 'CUSTOMER', name, address1, address2: t(d.address2, 120) || null, city, province: t(d.province, 40) || null, zip: t(d.zip, 20) || null, country };
}

/** Fraction digits of a currency (USD 2, JPY/KRW 0). */
export function fractionDigits(currency: string): number {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2; } catch { return 2; }
}
export function formatMoney(minor: number, currency: string, locale = 'en-US'): string {
  const d = fractionDigits(currency);
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: d, maximumFractionDigits: d }).format(minor / 10 ** d); }
  catch { return (minor / 10 ** d).toFixed(d) + ' ' + currency; }
}
/** "12.50" -> 1250 for USD; null for anything that is not a plain non-negative amount with at most the currency's decimals. */
export function parseMoney(text: string, currency: string): number | null {
  const d = fractionDigits(currency), t = text.trim().replace(/^\$/, '').replace(/,/g, '');
  const re = d === 0 ? /^\d{1,9}$/ : new RegExp(`^\\d{1,9}(?:\\.\\d{1,${d}})?$`);
  if (!re.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  return Number(whole) * 10 ** d + Number((frac + '0'.repeat(d)).slice(0, d) || '0');
}
export function minorToInput(minor: number, currency: string): string { const d = fractionDigits(currency); return (minor / 10 ** d).toFixed(d); }
/** Basis points as a percent with up to two decimals: 825 -> "8.25". */
export const bpsToPercent = (bps: number) => String(Number((bps / 100).toFixed(2)));
export function percentToBps(text: string): number | null {
  const t = text.trim().replace(/%$/, '');
  if (!/^\d{1,2}(?:\.\d{1,2})?$/.test(t)) return null;
  const bps = Math.round(Number(t) * 100); return bps <= 2500 ? bps : null;
}
/** Change to hand back for cash, or null when not enough was given. */
export function changeDue(totalMinor: number, receivedMinor: number | null): number | null {
  return receivedMinor === null || receivedMinor < totalMinor ? null : receivedMinor - totalMinor;
}

export const CATEGORY_LABEL: Record<PosCategory | 'QUICK' | 'SHOPIFY', string> = {
  TESTING: 'Testing & ranks', UNIFORMS: 'Uniforms', EQUIPMENT: 'Equipment', APPAREL: 'Apparel', EVENTS: 'Events', OTHER: 'Other', QUICK: 'Quick amount', SHOPIFY: 'Online store',
};
export const METHOD_LABEL: Record<PosMethod, string> = { CASH: 'Cash', CHECK: 'Check', CARD_TERMINAL: 'Card (our terminal)', OTHER: 'Other' };

/** Search as you type in the customer box: what to look up for the letters typed so far, or null while there are too few. */
export function customerQuery(typed: string): string | null {
  const q = typed.trim().slice(0, 80);
  return q.length >= 2 ? q : null;
}
