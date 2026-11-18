import type { ShopifyChangeBase, ShopifyDraftChanges, ShopifyProductChange, ShopifyUpdateChanges } from '@hon/contracts';
import { ShopifyProviderError, type MirrorProduct, type ShopifyApp, type ShopifyProductFields, type ShopifyVariantFields } from './shopify-adapter.js';
import { FAILURE_CODE, SHOPIFY_REFRESH_MARGIN_MS } from './shopify-sync-engine.js';

/** What approving hands the API: the change, the lease, the store and its sealed credential. */
export interface LeasedChange {
  change: ShopifyProductChange; mode: 'APPLY' | 'CHECK'; leaseToken: string; connectionId: string; shopDomain: string;
  credential: { keyId: string; sealed: string; version: number };
}
export type ChangeOutcome = 'APPLIED' | 'FAILED' | 'UNKNOWN';
export interface ChangeSteps<T> {
  rotate(body: { expectedVersion: number; credential: { keyId: string; sealed: string; accessExpiresAt: string; refreshExpiresAt: string } }): Promise<unknown>;
  record(outcome: ChangeOutcome, failureCode: string | null, product: MirrorProduct | null): Promise<T>;
}

/** The approve answer (the change itself is verified by the caller), or null when it is not the shape HON expects. */
export function leasedChange(v: unknown, change: ShopifyProductChange): LeasedChange | null {
  const o = v as Record<string, unknown> | null, k = (o?.credential ?? null) as Record<string, unknown> | null;
  if (!o || !k || (o.mode !== 'APPLY' && o.mode !== 'CHECK') || typeof o.leaseToken !== 'string' || typeof o.connectionId !== 'string'
    || typeof o.shopDomain !== 'string' || typeof k.keyId !== 'string' || typeof k.sealed !== 'string' || !Number.isInteger(k.version)) return null;
  return { change, mode: o.mode, leaseToken: o.leaseToken, connectionId: o.connectionId, shopDomain: o.shopDomain,
    credential: { keyId: k.keyId, sealed: k.sealed, version: k.version as number } };
}

const sameMoney = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? null) === null || (b ?? null) === null ? (a ?? null) === (b ?? null) : Number(a) === Number(b);

/** The live product still has every value the update was proposed against. */
export function matchesBase(p: MirrorProduct, base: ShopifyChangeBase): boolean {
  if (base.title !== undefined && p.title !== base.title) return false;
  if (base.status !== undefined && p.status !== base.status) return false;
  if (base.productType !== undefined && p.productType !== base.productType) return false;
  if (base.vendor !== undefined && p.vendor !== base.vendor) return false;
  for (const w of base.variants ?? []) {
    const v = p.variants.find(x => x.id === w.variantId);
    if (!v) return false;
    if (w.price !== undefined && !sameMoney(v.price, w.price)) return false;
    if (w.compareAtPrice !== undefined && !sameMoney(v.compareAtPrice, w.compareAtPrice)) return false;
    if (w.unitCost !== undefined && !sameMoney(v.unitCost, w.unitCost)) return false;
  }
  return true;
}

/** The product shows every value the change proposed (the same rule the database applies to an APPLIED result). */
export function showsChange(p: MirrorProduct, c: ShopifyProductChange): boolean {
  if (c.kind === 'CREATE_DRAFT') {
    const d = c.changes as ShopifyDraftChanges, v = p.variants[0];
    return !!v && p.handle === c.handle && p.title === d.title && p.status === 'DRAFT' && sameMoney(v.price, d.price)
      && sameMoney(v.compareAtPrice, d.compareAtPrice) && (d.unitCost === null || sameMoney(v.unitCost, d.unitCost)) && (d.sku === null || v.sku === d.sku);
  }
  const u = c.changes as ShopifyUpdateChanges;
  if (p.id !== c.productId) return false;
  if (u.title !== undefined && p.title !== u.title) return false;
  if (u.status !== undefined && p.status !== u.status) return false;
  if (u.productType !== undefined && p.productType !== u.productType) return false;
  if (u.vendor !== undefined && p.vendor !== u.vendor) return false;
  for (const w of u.variants ?? []) {
    const v = p.variants.find(x => x.id === w.variantId);
    if (!v) return false;
    if (w.price !== undefined && !sameMoney(v.price, w.price)) return false;
    if (w.compareAtPrice !== undefined && !sameMoney(v.compareAtPrice, w.compareAtPrice)) return false;
    if (w.unitCost !== undefined && !sameMoney(v.unitCost, w.unitCost)) return false;
  }
  return true;
}

const escapeHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
/** Plain typed text as Shopify description HTML: escaped, blank lines start paragraphs, single line breaks stay. */
export function descriptionHtml(text: string | null): string | null {
  if (!text) return null;
  return text.split(/\n{2,}/).map(p => '<p>' + p.split('\n').map(escapeHtml).join('<br>') + '</p>').join('');
}

class Unknown extends Error { constructor(readonly code: string) { super(code); } }

/**
 * One approved change, under its lease. APPLY: the product is read live and must still match the base the change was
 * proposed against; then the write(s), then a read back that must show the proposed values. CHECK (a lease that ended
 * without a result): Shopify is only read, never written again. Any doubt about whether a write was saved is UNKNOWN,
 * never FAILED, so it is checked again before anything else happens. Tokens stay in memory and never reach an answer.
 */
export async function runShopifyChange<T>(app: ShopifyApp, now: () => number, l: LeasedChange, steps: ChangeSteps<T>): Promise<T> {
  const binding = { connectionId: l.connectionId, shopDomain: l.shopDomain }, c = l.change, shop = l.shopDomain;
  let credential;
  try { credential = app.vault.open(binding, l.credential.keyId, l.credential.sealed); } catch { return steps.record('FAILED', 'CREDENTIAL_UNREADABLE', null); }
  let token = credential.accessToken;
  // Before any write: a provider failure means nothing was written.
  try {
    if (Date.parse(credential.accessExpiresAt) - now() < SHOPIFY_REFRESH_MARGIN_MS) {
      if (Date.parse(credential.refreshExpiresAt) <= now()) return await steps.record(l.mode === 'CHECK' ? 'UNKNOWN' : 'FAILED', 'REFRESH_EXPIRED', null);
      const fresh = await app.adapter.refresh(shop, credential.refreshToken);
      const pair = { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, accessExpiresAt: fresh.accessExpiresAt, refreshExpiresAt: fresh.refreshExpiresAt };
      await steps.rotate({ expectedVersion: l.credential.version,
        credential: { keyId: app.vault.keyId, sealed: app.vault.seal(binding, pair), accessExpiresAt: pair.accessExpiresAt, refreshExpiresAt: pair.refreshExpiresAt } });
      token = pair.accessToken;
    }
  } catch (e) {
    if (e instanceof ShopifyProviderError) return steps.record(l.mode === 'CHECK' ? 'UNKNOWN' : 'FAILED', FAILURE_CODE[e.failure], null);
    throw e;
  }
  const find = () => (c.kind === 'CREATE_DRAFT' ? app.adapter.productByHandle(shop, token, c.handle!) : app.adapter.product(shop, token, c.productId!));

  if (l.mode === 'CHECK') {
    let found: MirrorProduct | null;
    try { found = await find(); } catch (e) {
      if (e instanceof ShopifyProviderError) return steps.record('UNKNOWN', FAILURE_CODE[e.failure], null);
      throw e;
    }
    if (found && showsChange(found, c)) return steps.record('APPLIED', null, found);
    return steps.record('FAILED', 'NOT_APPLIED', found);
  }

  // APPLY: read live first.
  let live: MirrorProduct | null;
  try { live = await find(); } catch (e) {
    if (e instanceof ShopifyProviderError) return steps.record('FAILED', FAILURE_CODE[e.failure], null);
    throw e;
  }
  if (c.kind === 'UPDATE') {
    if (!live) return steps.record('FAILED', 'PRODUCT_NOT_FOUND', null);
    if (!matchesBase(live, c.base)) return steps.record('FAILED', 'CHANGED_IN_SHOPIFY', live);
  } else if (live) {
    // A product already holds this change's handle: it is this change, saved by an earlier attempt.
    return steps.record(showsChange(live, c) ? 'APPLIED' : 'FAILED', showsChange(live, c) ? null : 'HANDLE_TAKEN', live);
  }

  let written = 0;
  let productId = c.productId;
  try {
    if (c.kind === 'CREATE_DRAFT') {
      const d = c.changes as ShopifyDraftChanges;
      const made = await app.adapter.createDraft(shop, token, { title: d.title, descriptionHtml: descriptionHtml(d.description), productType: d.productType,
        vendor: d.vendor, handle: c.handle!, price: d.price, compareAtPrice: d.compareAtPrice, unitCost: d.unitCost, sku: d.sku });
      written++; productId = made.productId;
      await app.adapter.updateVariants(shop, token, made.productId, [{ variantId: made.variantId, price: d.price, compareAtPrice: d.compareAtPrice,
        ...(d.unitCost !== null ? { unitCost: d.unitCost } : {}) }], d.sku);
      written++;
    } else {
      const u = c.changes as ShopifyUpdateChanges;
      const fields: ShopifyProductFields = {};
      if (u.title !== undefined) fields.title = u.title;
      if (u.status !== undefined) fields.status = u.status;
      if (u.productType !== undefined) fields.productType = u.productType;
      if (u.vendor !== undefined) fields.vendor = u.vendor;
      if (Object.keys(fields).length) { await app.adapter.updateProduct(shop, token, c.productId!, fields); written++; }
      if (u.variants?.length) {
        await app.adapter.updateVariants(shop, token, c.productId!, u.variants.map((v): ShopifyVariantFields => ({ ...v })));
        written++;
      }
    }
  } catch (e) {
    if (!(e instanceof ShopifyProviderError)) throw e;
    // Shopify refused (user errors), was rate limited or refused the token: that write saved nothing.
    const refused = e.failure === 'REJECTED' || e.failure === 'RATE_LIMITED' || e.failure === 'AUTH';
    if (refused && written === 0) return steps.record('FAILED', FAILURE_CODE[e.failure], null);
    if (refused) {
      // The first write was saved and the second refused: record what Shopify now has.
      const now2 = await (productId ? app.adapter.product(shop, token, productId) : Promise.resolve(null)).catch(() => null);
      return now2 ? steps.record('FAILED', 'PARTLY_APPLIED', now2) : steps.record('UNKNOWN', 'PARTLY_APPLIED', null);
    }
    return steps.record('UNKNOWN', FAILURE_CODE[e.failure], null);
  }
  try {
    const after = productId ? await app.adapter.product(shop, token, productId) : null;
    if (after && showsChange(after, c)) return await steps.record('APPLIED', null, after);
    throw new Unknown('READ_BACK_MISMATCH');
  } catch (e) {
    if (e instanceof Unknown) return steps.record('UNKNOWN', e.code, null);
    if (e instanceof ShopifyProviderError) return steps.record('UNKNOWN', 'READ_BACK_' + FAILURE_CODE[e.failure].replace(/^SHOPIFY_/, ''), null);
    throw e;
  }
}
