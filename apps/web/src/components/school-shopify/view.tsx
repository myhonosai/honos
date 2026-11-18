import React, { useState } from 'react';
import type { ShopifyCatalog, ShopifyConnectResult, ShopifyConnection, ShopifyOrder, ShopifyOrders, ShopifyOverview, ShopifyProduct, ShopifyProductChange, ShopifyProductChanges, ShopifySyncResult } from '@hon/contracts';
import { shopifyText, type ShopifyKey } from './copy';
import type { ShopifyErrorKind } from './http';
import styles from './shopify.module.css';
import { money, shopifyAdminUrl } from './format';
export { money, shopifyAdminUrl };
import { Changes, DraftEditor, ProductEditor, changeFailure, changeOpen, type ProposeRequest } from './editor';
import { MerchStudio, type BrandState } from './studio';

type T = (key: ShopifyKey, vars?: Record<string, string>) => string;
export type OverviewState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; read: ShopifyOverview };
/** The Commerce Workspace sections built today. Later sections (Collections, Fulfillment, Theme Builder, …) are added when they work. */
export const SHOPIFY_SECTIONS = ['overview', 'products', 'studio', 'changes', 'orders', 'inventory', 'settings'] as const;
export type ShopifySection = typeof SHOPIFY_SECTIONS[number];
export type ListState<T> = { state: 'LOADING' | 'UNAVAILABLE' } | { state: 'READY'; value: T };
export type ShopifyAction = 'connect' | 'sync' | 'disconnect' | 'allowEditing' | 'propose' | 'approve' | 'cancelChange';
/** `target` is the change a command was about; `change` is the server's verified answer for it. */
export type ShopifyOutcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | ShopifyErrorKind; action: ShopifyAction; sync?: ShopifySyncResult; change?: ShopifyProductChange; target?: string }>;

export type ShopifyViewProps = Readonly<{
  language: string; locale: string; waiting: boolean; concealed: boolean; hasSchool: boolean;
  overview: OverviewState; section: ShopifySection; catalog: ListState<ShopifyCatalog>; orders: ListState<ShopifyOrders>; shop: string; confirming: boolean; outcome: ShopifyOutcome; locked: boolean;
  changes?: ListState<ShopifyProductChanges> | undefined;
  onPropose?: ((change: ProposeRequest) => void) | undefined; onApprove?: ((change: ShopifyProductChange) => void) | undefined;
  onCancelChange?: ((change: ShopifyProductChange) => void) | undefined; onAllowEditing?: (() => void) | undefined;
  onRefresh?: (() => void) | undefined; onShop?: ((value: string) => void) | undefined; onConnect?: (() => void) | undefined;
  onSync?: (() => void) | undefined; onConfirm?: ((open: boolean) => void) | undefined; onDisconnect?: (() => void) | undefined;
  onSection?: ((section: ShopifySection) => void) | undefined;
  /** Merch Studio: the school's name and saved branding, and where Creative Studio lives. */
  schoolName?: string | null | undefined; brand?: BrandState | undefined; creativeHref?: string | undefined;
}>;

const when = (locale: string, iso: string) => { try { return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)); } catch { return iso; } };
const day = (locale: string, iso: string) => { try { return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso)); } catch { return iso; } };
const FAILURES = new Set(['CATALOG_TOO_LARGE', 'ORDERS_TOO_MANY', 'TOKEN_REJECTED', 'REFRESH_EXPIRED', 'CREDENTIAL_UNREADABLE']);
/** What an approval, a cancel or a new edit ended as, from the server's verified change. */
export function changeMessage(t: T, action: ShopifyAction, c: ShopifyProductChange): string {
  if (action === 'propose') return t('done_propose');
  if (action === 'cancelChange') return t(c.status === 'FAILED' ? 'done_closed' : 'done_cancel');
  if (c.status === 'APPLIED') return t('done_applied');
  if (c.status === 'UNKNOWN') return t('done_unknown');
  return changeFailure(t, c) ?? t('fc_other');
}
export function syncMessage(t: T, s: ShopifySyncResult): string {
  if (s.outcome === 'SUCCEEDED') return t('done_sync', { products: String(s.productsSeen), orders: String(s.ordersSeen) });
  return t(s.failureCode && FAILURES.has(s.failureCode) ? `fail_${s.failureCode}` as ShopifyKey : 'fail_other');
}

function Summary({ read, t, locale }: { read: ShopifyOverview; t: T; locale: string }): React.ReactElement | null {
  const s = read.summary, c = read.counts, cur = read.connection?.currency ?? null;
  if (!s || !c) return null;
  const m = (n: number) => money(locale, cur, n);
  return <div className={styles.cards}>
    <div className={styles.card} data-shopify-summary>
      <h2>{t('summaryTitle')}</h2>
      <dl className={styles.stats}>
        <div><dt>{t('sales')}</dt><dd>{m(s.sales)}</dd></div>
        <div><dt>{t('orders')}</dt><dd>{s.orders}</dd></div>
        <div><dt>{t('averageOrder')}</dt><dd>{m(s.averageOrder)}</dd></div>
        <div><dt>{t('itemsSold')}</dt><dd>{s.itemsSold}</dd></div>
        <div><dt>{t('profit')}</dt><dd data-shopify-profit>{s.coveredSales > 0 ? m(s.estimatedGrossProfit) : t('noCost')}</dd></div>
      </dl>
      <p className={styles.meta}>{s.coveredSales > 0 ? t('profitNote', { covered: m(s.coveredSales), total: m(s.lineSales) }) : t('profitNone')}</p>
      {s.topProducts.length > 0 && <><h3>{t('topProducts')}</h3><ol className={styles.list}>{s.topProducts.map((p) =>
        <li key={p.title}><span>{p.title}</span><span className={styles.meta}>{p.quantity} · {m(p.sales)}</span></li>)}</ol></>}
    </div>
    <div className={styles.card} data-shopify-counts>
      <h2>{t('countsTitle')}</h2>
      <dl className={styles.stats}>
        <div><dt>{t('products')}</dt><dd>{c.products}</dd></div>
        <div><dt>{t('variants')}</dt><dd>{c.variants}</dd></div>
        <div><dt>{t('lowStock')}</dt><dd data-low={c.lowStock > 0 ? 'true' : 'false'}>{c.lowStock}</dd></div>
        <div><dt>{t('ordersKept')}</dt><dd>{c.orders}</dd></div>
      </dl>
    </div>
  </div>;
}

// ---- Commerce Workspace (WS1): sections over the verified read-only mirror. Nothing here writes to Shopify. ----

const FIN_KEYS = new Set<string>(['PAID', 'PENDING', 'REFUNDED', 'PARTIALLY_REFUNDED', 'AUTHORIZED', 'VOIDED', 'PARTIALLY_PAID', 'EXPIRED']);
const FUL_KEYS = new Set<string>(['FULFILLED', 'UNFULFILLED', 'PARTIALLY_FULFILLED', 'IN_PROGRESS', 'ON_HOLD', 'SCHEDULED', 'RESTOCKED', 'PENDING_FULFILLMENT', 'OPEN']);
/** A Shopify status word in plain language; an unknown word is shown as words, never as an outcome HON invented. */
function statusLabel(t: T, prefix: 'fin' | 'ful', value: string | null): string | null {
  if (!value) return null;
  if ((prefix === 'fin' ? FIN_KEYS : FUL_KEYS).has(value)) return t(`${prefix}_${value}` as ShopifyKey);
  const words = value.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
const FULFILLED = new Set(['FULFILLED', 'RESTOCKED']);
export const orderToFulfill = (o: ShopifyOrder) => !o.cancelledAt && o.financialStatus !== 'REFUNDED' && !(o.fulfillmentStatus && FULFILLED.has(o.fulfillmentStatus));

type Ctx = Readonly<{ t: T; locale: string; domain: string; currency: string | null }>;
const pending = (t: T, state: ListState<unknown>) => state.state === 'LOADING'
  ? <p className={styles.meta} role="status">{t('loadingList')}</p> : <p className={styles.notice} role="alert">{t('listUnavailable')}</p>;

function Filters<K extends string>({ label, value, options, onChange }: { label: string; value: K; options: readonly (readonly [K, string])[]; onChange: (k: K) => void }): React.ReactElement {
  return <div className={styles.tabs} role="group" aria-label={label}>
    {options.map(([k, text]) => <button key={k} type="button" className={styles.tab} aria-pressed={value === k} onClick={() => onChange(k)}>{text}</button>)}
  </div>;
}

function Attention({ ctx, read, catalog, orders, changes, go }: { ctx: Ctx; read: ShopifyOverview; catalog: ListState<ShopifyCatalog>; orders: ListState<ShopifyOrders>; changes: ListState<ShopifyProductChanges>; go: (s: ShopifySection) => void }): React.ReactElement {
  const { t } = ctx;
  const items: { key: string; label: string; n: number; to: ShopifySection }[] = [];
  if (changes.state === 'READY') items.push({ key: 'changes', label: t('att_changes'), n: changes.value.changes.filter(c => c.status === 'PENDING' || c.status === 'UNKNOWN').length, to: 'changes' });
  if (orders.state === 'READY') items.push({ key: 'toFulfill', label: t('att_toFulfill'), n: orders.value.orders.filter(orderToFulfill).length, to: 'orders' });
  if (read.counts) items.push({ key: 'lowStock', label: t('att_lowStock'), n: read.counts.lowStock, to: 'inventory' });
  if (catalog.state === 'READY') {
    const products = catalog.value.products;
    items.push({ key: 'noCost', label: t('att_noCost'), n: products.reduce((a, p) => a + p.variants.filter(v => v.unitCost === null).length, 0), to: 'products' });
    items.push({ key: 'drafts', label: t('att_drafts'), n: products.filter(p => p.status === 'DRAFT').length, to: 'products' });
  }
  const open = items.filter(i => i.n > 0);
  const reconnect = read.connection?.status === 'NEEDS_RECONNECT';
  return <div className={styles.card} data-shopify-attention>
    <h2>{t('attentionTitle')}</h2>
    {reconnect && <p className={styles.warnText}>{t('att_reconnect')}</p>}
    {(orders.state === 'LOADING' || catalog.state === 'LOADING') && <p className={styles.meta} role="status">{t('loadingList')}</p>}
    {(orders.state === 'UNAVAILABLE' || catalog.state === 'UNAVAILABLE') && <p className={styles.notice} role="alert">{t('listUnavailable')}</p>}
    {open.length === 0 && !reconnect && orders.state === 'READY' && catalog.state === 'READY' ? <p className={styles.meta}>{t('att_none')}</p>
      : <ul className={styles.list}>{open.map(i => <li key={i.key} data-attention={i.key}>
        <button type="button" className={styles.linkButton} onClick={() => go(i.to)}>{i.label}</button><strong>{i.n}</strong></li>)}</ul>}
  </div>;
}

function RecentOrders({ ctx, orders, go }: { ctx: Ctx; orders: ListState<ShopifyOrders>; go: (s: ShopifySection) => void }): React.ReactElement {
  const { t, locale } = ctx;
  return <div className={styles.card} data-shopify-recent>
    <div className={styles.cardHead}><h2>{t('recentTitle')}</h2><button type="button" className={styles.linkButton} onClick={() => go('orders')}>{t('viewAll')}</button></div>
    {orders.state !== 'READY' ? pending(t, orders) : orders.value.orders.length === 0 ? <p className={styles.meta}>{t('ordersEmpty')}</p>
      : <ul className={styles.list}>{orders.value.orders.slice(0, 5).map(o => <li key={o.orderId}>
        <span><strong>{o.name}</strong> <span className={styles.meta}>{day(locale, o.placedAt)}</span></span>
        <span>{money(locale, o.currency, o.total)}</span></li>)}</ul>}
  </div>;
}

function Overview({ ctx, read, catalog, orders, changes, go }: { ctx: Ctx; read: ShopifyOverview; catalog: ListState<ShopifyCatalog>; orders: ListState<ShopifyOrders>; changes: ListState<ShopifyProductChanges>; go: (s: ShopifySection) => void }): React.ReactElement {
  return <div className={styles.section} data-section="overview">
    <Summary read={read} t={ctx.t} locale={ctx.locale} />
    <div className={styles.cards}>
      <Attention ctx={ctx} read={read} catalog={catalog} orders={orders} changes={changes} go={go} />
      <RecentOrders ctx={ctx} orders={orders} go={go} />
    </div>
  </div>;
}

type ProductFilter = 'all' | 'ACTIVE' | 'DRAFT' | 'ARCHIVED' | 'UNLISTED';
const range = (ctx: Ctx, values: number[]) => {
  if (values.length === 0) return ctx.t('noCost');
  const lo = Math.min(...values), hi = Math.max(...values), m = (n: number) => money(ctx.locale, ctx.currency, n);
  return lo === hi ? m(lo) : `${m(lo)} – ${m(hi)}`;
};
export function matchesProduct(p: ShopifyProduct, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [p.title, p.productType, p.vendor, ...p.variants.flatMap(v => [v.title, v.sku])].some(x => typeof x === 'string' && x.toLowerCase().includes(q));
}

type Editing = Readonly<{ canEdit: boolean; open: ReadonlySet<string>; locked: boolean; onPropose: (r: ProposeRequest) => void; go: (s: ShopifySection) => void }>;
function Products({ ctx, catalog, edit }: { ctx: Ctx; catalog: ListState<ShopifyCatalog>; edit: Editing }): React.ReactElement {
  const { t, locale } = ctx;
  const [query, setQuery] = useState(''), [status, setStatus] = useState<ProductFilter>('all'), [type, setType] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  if (catalog.state !== 'READY') return <div className={styles.card} data-section="products">{pending(t, catalog)}</div>;
  const hasUnlisted = catalog.value.products.some(p => p.status === 'UNLISTED');
  const all = catalog.value.products;
  const types = [...new Set(all.map(p => p.productType).filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b, locale));
  const shown = all.filter(p => (status === 'all' || p.status === status) && (!type || p.productType === type) && matchesProduct(p, query));
  const m = (n: number | null) => n === null ? t('noCost') : money(locale, ctx.currency, n);
  return <div className={styles.section} data-section="products">
    <div className={styles.card}>
      <div className={styles.toolbar}>
        <label className={styles.field}>{t('search')}<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={t('searchProducts')} maxLength={100} /></label>
        {types.length > 0 && <label className={styles.field}>{t('type')}<select value={type} onChange={e => setType(e.target.value)}>
          <option value="">{t('allTypes')}</option>{types.map(x => <option key={x} value={x}>{x}</option>)}</select></label>}
      </div>
      <Filters label={t('nav_products')} value={status} onChange={setStatus}
        options={[['all', t('f_all')], ['ACTIVE', t('status_ACTIVE')], ['DRAFT', t('status_DRAFT')], ['ARCHIVED', t('status_ARCHIVED')],
          ...(hasUnlisted ? [['UNLISTED', t('status_UNLISTED')] as const] : [])]} />
      <div className={styles.cardHead}><p className={styles.meta} role="status">{t('shownOf', { shown: String(shown.length), total: String(all.length) })}</p>
        {edit.canEdit && editing !== 'new' && <button type="button" className={styles.secondary} disabled={edit.locked} onClick={() => setEditing('new')} data-shopify-new>{t('newProduct')}</button>}</div>
    </div>
    {edit.canEdit && editing === 'new' && <div className={styles.card}><DraftEditor ctx={ctx} locked={edit.locked} onPropose={edit.onPropose} onClose={() => setEditing(null)} /></div>}
    {all.length === 0 ? <p className={styles.meta}>{t('catalogEmpty')}</p> : shown.length === 0 ? <p className={styles.meta}>{t('noMatch')}</p>
      : <ul className={styles.items} data-shopify-catalog>{shown.map(p => {
        const tracked = p.variants.filter(v => v.tracked), stock = tracked.reduce((a, v) => a + (v.inventoryQuantity ?? 0), 0);
        const margins = p.variants.map(v => v.marginPercent).filter((x): x is number => x !== null);
        const low = p.variants.some(v => v.lowStock);
        return <li key={p.productId} className={styles.item} data-product={p.productId}>
          <details open={editing === p.productId || undefined}>
            <summary className={styles.itemHead}>
              {p.imageUrl ? <img className={styles.thumb} src={p.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className={styles.thumb} aria-hidden="true" />}
              <span className={styles.itemMain}><strong>{p.title}</strong>
                <span className={styles.meta}>{[p.productType, t('variantsCount', { n: String(p.variants.length) })].filter(Boolean).join(' · ')}</span></span>
              <span className={styles.itemFacts}>
                <span>{range(ctx, p.variants.map(v => v.price))}</span>
                <span className={styles.meta}>{tracked.length === 0 ? t('notTracked') : t('stockTotal', { n: String(stock) })}</span>
                {margins.length > 0 && <span className={styles.meta}>{t('marginShort', { n: `${Math.min(...margins)}%${Math.min(...margins) === Math.max(...margins) ? '' : `–${Math.max(...margins)}%`}` })}</span>}
              </span>
              <span className={styles.chips}>{p.status !== 'ACTIVE' && <span className={styles.chip} data-state={p.status}>{t(`status_${p.status}`)}</span>}
                {low && <span className={styles.chip} data-state="LOW">{t('low')}</span>}</span>
            </summary>
            <div className={styles.itemBody}>
              <div className={styles.tableWrap}><table className={styles.table}>
                <thead><tr><th>{t('col_variant')}</th><th>{t('col_sku')}</th><th>{t('col_price')}</th><th>{t('col_cost')}</th><th>{t('col_margin')}</th><th>{t('col_stock')}</th></tr></thead>
                <tbody>{p.variants.map(v => <tr key={v.variantId} data-variant={v.variantId} data-low={v.lowStock ? 'true' : 'false'}>
                  <td>{v.title}</td><td>{v.sku ?? ''}</td><td>{m(v.price)}</td><td>{m(v.unitCost)}</td>
                  <td>{v.margin === null ? t('noCost') : `${m(v.margin)}${v.marginPercent === null ? '' : ` (${v.marginPercent}%)`}`}</td>
                  <td>{!v.tracked ? <span className={styles.meta}>{t('notTracked')}</span> : <>{v.inventoryQuantity ?? 0}{v.lowStock && <span className={styles.chip} data-state="LOW">{t('low')}</span>}</>}</td>
                </tr>)}</tbody>
              </table></div>
              {edit.canEdit && editing === p.productId
                ? <ProductEditor ctx={ctx} product={p} locked={edit.locked} onPropose={edit.onPropose} onClose={() => setEditing(null)} />
                : <div className={styles.row}>
                  {edit.canEdit && (edit.open.has(p.productId)
                    ? <button type="button" className={styles.secondary} onClick={() => edit.go('changes')} data-edit-waiting>{t('editWaiting')}</button>
                    : <button type="button" className={styles.primary} disabled={edit.locked} onClick={() => setEditing(p.productId)} data-edit={p.productId}>{t('edit')}</button>)}
                  <a className={styles.secondary} href={shopifyAdminUrl(ctx.domain, 'products', p.productId)} target="_blank" rel="noopener noreferrer">{t('openShopify')}</a>
                </div>}
            </div>
          </details>
        </li>;
      })}</ul>}
  </div>;
}

type OrderFilter = 'all' | 'toFulfill' | 'paid' | 'refunded' | 'cancelled';
const REFUNDED = new Set(['REFUNDED', 'PARTIALLY_REFUNDED']);
export function orderMatches(o: ShopifyOrder, filter: OrderFilter, query: string): boolean {
  const ok = filter === 'all' ? true : filter === 'toFulfill' ? orderToFulfill(o) : filter === 'cancelled' ? !!o.cancelledAt
    : filter === 'paid' ? !o.cancelledAt && o.financialStatus === 'PAID' : !!o.financialStatus && REFUNDED.has(o.financialStatus);
  const q = query.trim().toLowerCase();
  return ok && (!q || o.name.toLowerCase().includes(q) || o.lines.some(l => l.title.toLowerCase().includes(q) || (l.sku ?? '').toLowerCase().includes(q)));
}

function Orders({ ctx, orders }: { ctx: Ctx; orders: ListState<ShopifyOrders> }): React.ReactElement {
  const { t, locale } = ctx;
  const [filter, setFilter] = useState<OrderFilter>('all'), [query, setQuery] = useState('');
  if (orders.state !== 'READY') return <div className={styles.card} data-section="orders">{pending(t, orders)}</div>;
  const all = orders.value.orders, shown = all.filter(o => orderMatches(o, filter, query));
  return <div className={styles.section} data-section="orders">
    <div className={styles.card}>
      <div className={styles.toolbar}><label className={styles.field}>{t('search')}<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={t('searchOrders')} maxLength={100} /></label></div>
      <Filters label={t('nav_orders')} value={filter} onChange={setFilter}
        options={[['all', t('f_all')], ['toFulfill', t('of_toFulfill')], ['paid', t('of_paid')], ['refunded', t('of_refunded')], ['cancelled', t('of_cancelled')]]} />
      <p className={styles.meta} role="status">{t('shownOf', { shown: String(shown.length), total: String(all.length) })} · {t('ordersNote')}</p>
    </div>
    {all.length === 0 ? <p className={styles.meta}>{t('ordersEmpty')}</p> : shown.length === 0 ? <p className={styles.meta}>{t('noMatch')}</p>
      : <ul className={styles.items} data-shopify-orders>{shown.map(o => {
        const m = (n: number) => money(locale, o.currency, n);
        const fin = statusLabel(t, 'fin', o.financialStatus), ful = statusLabel(t, 'ful', o.fulfillmentStatus);
        return <li key={o.orderId} className={styles.item} data-order={o.orderId}>
          <details>
            <summary className={styles.itemHead}>
              <span className={styles.itemMain}><strong>{o.name}</strong><span className={styles.meta}>{when(locale, o.placedAt)}{o.sourceName ? ` · ${o.sourceName}` : ''}</span></span>
              <span className={styles.itemFacts}><span>{m(o.total)}</span><span className={styles.meta}>{t('itemsCount', { n: String(o.lines.reduce((a, l) => a + l.quantity, 0)) })}</span></span>
              <span className={styles.chips}>
                {o.cancelledAt ? <span className={styles.chip} data-state="CANCELLED">{t('cancelled')}</span> : <>
                  {fin && <span className={styles.chip} data-state={o.financialStatus ?? ''}>{fin}</span>}
                  {ful && <span className={styles.chip} data-state={orderToFulfill(o) ? 'TO_FULFILL' : o.fulfillmentStatus ?? ''}>{ful}</span>}</>}
              </span>
            </summary>
            <div className={styles.itemBody}>
              <div className={styles.tableWrap}><table className={styles.table}>
                <thead><tr><th>{t('col_items')}</th><th>{t('col_sku')}</th><th>{t('col_qty')}</th><th>{t('col_price')}</th><th>{t('col_lineTotal')}</th></tr></thead>
                <tbody>{o.lines.map((l, i) => <tr key={i}><td>{l.title}</td><td>{l.sku ?? ''}</td><td>{l.quantity}</td><td>{m(l.unitPrice)}</td><td>{m(l.unitPrice * l.quantity)}</td></tr>)}</tbody>
              </table></div>
              <dl className={styles.summary}>
                <dt>{t('subtotal')}</dt><dd>{m(o.subtotal)}</dd>
                {o.discounts > 0 && <><dt>{t('discounts')}</dt><dd>−{m(o.discounts)}</dd></>}
                <dt>{t('tax')}</dt><dd>{m(o.tax)}</dd>
                <dt>{t('total')}</dt><dd><strong>{m(o.total)}</strong></dd>
              </dl>
              <a className={styles.secondary} href={shopifyAdminUrl(ctx.domain, 'orders', o.orderId)} target="_blank" rel="noopener noreferrer">{t('openShopify')}</a>
            </div>
          </details>
        </li>;
      })}</ul>}
  </div>;
}

type InventoryFilter = 'low' | 'tracked' | 'untracked';
function Inventory({ ctx, catalog }: { ctx: Ctx; catalog: ListState<ShopifyCatalog> }): React.ReactElement {
  const { t, locale } = ctx;
  const [filter, setFilter] = useState<InventoryFilter>('low');
  if (catalog.state !== 'READY') return <div className={styles.card} data-section="inventory">{pending(t, catalog)}</div>;
  const rows = catalog.value.products.flatMap(p => p.variants.map(v => ({ p, v })));
  const tracked = rows.filter(r => r.v.tracked);
  const units = tracked.reduce((a, r) => a + Math.max(0, r.v.inventoryQuantity ?? 0), 0);
  const costed = tracked.filter(r => r.v.unitCost !== null);
  const value = costed.reduce((a, r) => a + Math.max(0, r.v.inventoryQuantity ?? 0) * (r.v.unitCost ?? 0), 0);
  const costedUnits = costed.reduce((a, r) => a + Math.max(0, r.v.inventoryQuantity ?? 0), 0);
  const shown = (filter === 'low' ? tracked.filter(r => r.v.lowStock) : filter === 'tracked' ? tracked : rows.filter(r => !r.v.tracked))
    .slice().sort((a, b) => (a.v.inventoryQuantity ?? 0) - (b.v.inventoryQuantity ?? 0) || a.p.title.localeCompare(b.p.title, locale));
  return <div className={styles.section} data-section="inventory">
    <div className={styles.card}>
      <dl className={styles.stats}>
        <div><dt>{t('unitsInStock')}</dt><dd>{units}</dd></div>
        <div><dt>{t('lowStock')}</dt><dd data-low={tracked.some(r => r.v.lowStock) ? 'true' : 'false'}>{tracked.filter(r => r.v.lowStock).length}</dd></div>
        <div><dt>{t('stockValue')}</dt><dd data-shopify-stock-value>{costedUnits > 0 ? money(locale, ctx.currency, value) : t('noCost')}</dd></div>
      </dl>
      <p className={styles.meta}>{costedUnits > 0 ? t('stockValueNote', { units: String(costedUnits), total: String(units) }) : t('profitNone')}</p>
      <Filters label={t('nav_inventory')} value={filter} onChange={setFilter}
        options={[['low', t('if_low')], ['tracked', t('if_tracked')], ['untracked', t('if_untracked')]]} />
    </div>
    {shown.length === 0 ? <p className={styles.meta}>{filter === 'low' ? t('noLow') : t('noMatch')}</p>
      : <div className={styles.card}><div className={styles.tableWrap}><table className={styles.table} data-shopify-inventory>
        <thead><tr><th>{t('col_product')}</th><th>{t('col_variant')}</th><th>{t('col_sku')}</th><th>{t('col_stock')}</th></tr></thead>
        <tbody>{shown.map(({ p, v }) => <tr key={v.variantId} data-variant={v.variantId} data-low={v.lowStock ? 'true' : 'false'}>
          <td>{p.title}</td><td>{v.title}</td><td>{v.sku ?? ''}</td>
          <td>{!v.tracked ? <span className={styles.meta}>{t('notTracked')}</span> : <>{v.inventoryQuantity ?? 0}{v.lowStock && <span className={styles.chip} data-state="LOW">{t('low')}</span>}</>}</td>
        </tr>)}</tbody>
      </table></div>{filter === 'untracked' && <p className={styles.meta}>{t('untrackedNote')}</p>}</div>}
  </div>;
}

function Connection({ p, t, read, c }: { p: ShopifyViewProps; t: T; read: ShopifyOverview; c: ShopifyConnection }): React.ReactElement {
  const o = p.outcome;
  return <div className={styles.card} data-shopify-connection data-status={c.status}>
    <div className={styles.cardHead}>
      <div><h2>{c.shopName ?? c.shopDomain}</h2><p className={styles.meta}>{c.shopDomain}</p></div>
      <span className={styles.chip} data-state={c.status}>{t(`st_${c.status}`)}</span>
    </div>
    <p className={styles.meta}>{t('since', { time: when(p.locale, c.connectedAt) })} · {c.syncRunning ? t('syncing')
      : c.lastSyncAt ? `${t('lastSync', { time: when(p.locale, c.lastSyncAt) })} (${t(`out_${c.lastSyncOutcome ?? 'SUCCEEDED'}`)})` : t('neverSynced')}</p>
    {c.status === 'CONNECTED' && read.autoSync && <p className={styles.meta} data-shopify-auto-sync>{t('autoSync')}</p>}
    {c.status === 'CONNECTED' && !read.autoSync && read.canManage && <p className={styles.meta}>{t('manualSync')}</p>}
    {c.status === 'NEEDS_RECONNECT' && <p className={styles.warnText}>{t('needsReconnect')}</p>}
    {c.status === 'DISCONNECTED' && <p className={styles.meta}>{t('disconnectedNote')}</p>}
    {read.canManage && c.status === 'CONNECTED' && <div className={styles.row}>
      {p.confirming
        ? <><p className={styles.warnText}>{t('confirmDisconnect')}</p>
          <button type="button" className={styles.primary} disabled={p.locked} onClick={p.onDisconnect}>{t('yesDisconnect')}</button>
          <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onConfirm?.(false)}>{t('cancel')}</button></>
        : <><button type="button" className={styles.primary} disabled={p.locked || c.syncRunning} onClick={p.onSync}>{p.locked && o?.action === 'sync' ? t('syncBusy') : t('sync')}</button>
          <a className={styles.secondary} href={shopifyAdminUrl(c.shopDomain, 'home')} target="_blank" rel="noopener noreferrer">{t('openAdmin')}</a>
          <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onConfirm?.(true)}>{t('disconnect')}</button></>}
    </div>}
  </div>;
}

function Settings({ p, t, read, c }: { p: ShopifyViewProps; t: T; read: ShopifyOverview; c: ShopifyConnection }): React.ReactElement {
  const edit = p.changes?.state === 'READY' ? p.changes.value : null;
  return <div className={styles.section} data-section="settings">
    <Connection p={p} t={t} read={read} c={c} />
    <div className={styles.card} data-shopify-permissions>
      <h2>{t('perm_title')}</h2>
      <ul className={styles.plainList}><li>{t('perm_read')}</li><li>{t('perm_orders')}</li>
        {edit?.editProducts && <li data-perm="products">{t('perm_editProducts')}</li>}{edit?.editCosts && <li data-perm="costs">{t('perm_editCosts')}</li>}</ul>
      <p className={styles.meta}>{t(edit?.editProducts ? 'perm_approval' : 'perm_noWrite')}</p>
      {edit && !(edit.editProducts && edit.editCosts) && read.canManage && c.status === 'CONNECTED' &&
        <div className={styles.row}><button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onAllowEditing}>{p.locked && p.outcome?.action === 'allowEditing' ? t('connecting') : t('allowEditing')}</button></div>}
    </div>
  </div>;
}

function ConnectCard({ p, t, read, c }: { p: ShopifyViewProps; t: T; read: ShopifyOverview; c: ShopifyConnection | null }): React.ReactElement {
  const o = p.outcome;
  return <div className={styles.card} data-shopify-connect>
    <h2>{c ? t('reconnect') : t('connectTitle')}</h2>
    {!read.canManage ? <p className={styles.meta}>{t('managerOnly')}</p>
      : !read.connectEnabled ? <p className={styles.notice} data-shopify-not-enabled>{t('notEnabled')}</p>
      : <form className={styles.form} onSubmit={(e) => { e.preventDefault(); p.onConnect?.(); }}>
        <p className={styles.meta}>{t('connectHelp')}</p>
        <label className={styles.field}>{t('shopLabel')}
          <input value={p.shop} onChange={(e) => p.onShop?.(e.target.value)} disabled={p.locked} autoComplete="off" spellCheck={false}
            inputMode="url" maxLength={200} aria-describedby="shopify-shop-hint" /></label>
        <span id="shopify-shop-hint" className={styles.meta}>{t('shopHint')}</span>
        <div className={styles.row}><button type="submit" className={styles.primary} disabled={p.locked}>{p.locked && o?.action === 'connect' ? t('connecting') : c ? t('reconnect') : t('connect')}</button></div>
      </form>}
  </div>;
}

/** Pure view of the server's verified answers: the Commerce Workspace once a store is linked, the connect card before. */
export function ShopifyView(p: ShopifyViewProps): React.ReactElement {
  const t: T = (key, vars) => shopifyText(p.language, key, vars);
  const head = <div className={styles.head}><div><h1>{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
    {p.overview.state === 'READY' && <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onRefresh}>{t('refresh')}</button>}</div>;
  if (p.waiting) return <section className={styles.page}>{head}<p className={styles.meta} role="status">{t('waiting')}</p></section>;
  if (p.concealed) return <section className={styles.page}>{head}<p className={styles.notice}>{t('concealed')}</p></section>;
  if (!p.hasSchool) return <section className={styles.page}>{head}<p className={styles.notice}>{t('noSchool')}</p></section>;
  if (p.overview.state !== 'READY') return <section className={styles.page}>{head}
    {p.overview.state === 'LOADING' ? <p className={styles.meta} role="status">{t('loading')}</p>
      : <div className={styles.notice} role="alert"><p>{t(p.overview.state === 'DENIED' ? 'denied' : 'unavailable')}</p>
        {p.overview.state === 'UNAVAILABLE' && <button type="button" className={styles.secondary} onClick={p.onRefresh}>{t('refresh')}</button>}</div>}
  </section>;
  const read = p.overview.read, c = read.connection, o = p.outcome;
  const connectable = !c || c.status !== 'CONNECTED';
  let message = '';
  if (o && o.kind === 'DONE') message = o.action === 'disconnect' ? t('done_disconnect') : o.sync ? syncMessage(t, o.sync) : o.change ? changeMessage(t, o.action, o.change) : '';
  else if (o && o.kind !== 'SENDING') message = t(o.action === 'approve' && o.kind === 'UNKNOWN' ? 'done_unknown' : `e_${o.kind}` as ShopifyKey);
  const good = o?.kind === 'DONE' && (o.action === 'disconnect' || o.sync?.outcome === 'SUCCEEDED' || o.action === 'propose' || o.action === 'cancelChange' || o.change?.status === 'APPLIED');
  const notice = message && <div className={`${styles.notice} ${good ? '' : styles.warn}`} role={good ? 'status' : 'alert'} data-shopify-outcome={o?.kind}><p>{message}</p></div>;
  if (!c) return <section className={styles.page}>{head}{notice}<ConnectCard p={p} t={t} read={read} c={null} /></section>;
  const ctx: Ctx = { t, locale: p.locale, domain: c.shopDomain, currency: c.currency };
  const go = (s: ShopifySection) => p.onSection?.(s);
  const section = p.section;
  const changes: ListState<ShopifyProductChanges> = p.changes ?? { state: 'LOADING' };
  const editing: Editing = { canEdit: read.canManage && c.status === 'CONNECTED' && !!p.onPropose, locked: p.locked, go, onPropose: (r) => p.onPropose?.(r),
    open: new Set(changes.state === 'READY' ? changes.value.changes.filter(x => x.kind === 'UPDATE' && changeOpen(x) && x.productId).map(x => x.productId!) : []) };
  return <section className={styles.page} data-shopify-workspace>
    {head}
    <div className={styles.storeBar}>
      <span><strong>{c.shopName ?? c.shopDomain}</strong> <span className={styles.meta}>{c.shopDomain}</span></span>
      <span className={styles.chip} data-state={c.status}>{t(`st_${c.status}`)}</span>
      {read.canManage && c.status === 'CONNECTED' && section !== 'settings' &&
        <button type="button" className={styles.secondary} disabled={p.locked || c.syncRunning} onClick={p.onSync}>{p.locked && o?.action === 'sync' ? t('syncBusy') : t('sync')}</button>}
    </div>
    <nav className={styles.sections} aria-label={t('navLabel')}>
      {SHOPIFY_SECTIONS.map(s => <button key={s} type="button" className={styles.sectionTab} aria-current={section === s ? 'page' : undefined}
        onClick={() => go(s)} data-nav={s}>{t(`nav_${s}`)}</button>)}
    </nav>
    {notice}
    {connectable && section !== 'settings' && c.status === 'NEEDS_RECONNECT' && <p className={`${styles.notice} ${styles.warn}`}>{t('needsReconnect')}</p>}
    {section === 'overview' ? <Overview ctx={ctx} read={read} catalog={p.catalog} orders={p.orders} changes={changes} go={go} />
      : section === 'products' ? <Products ctx={ctx} catalog={p.catalog} edit={editing} />
      : section === 'studio' ? <MerchStudio ctx={ctx} language={p.language} school={p.schoolName ?? c.shopName ?? null} brand={p.brand ?? { state: 'NONE' }}
        canEdit={editing.canEdit} locked={p.locked} onPropose={editing.onPropose} creativeHref={p.creativeHref ?? '/staff/creative-studio'} />
      : section === 'changes' ? <Changes ctx={ctx} changes={changes} catalog={p.catalog.state === 'READY' ? p.catalog.value : null} canManage={read.canManage}
        connected={c.status === 'CONNECTED'} locked={p.locked} busy={p.locked && o?.action === 'approve' ? o.target ?? null : null} pending={pending}
        when={(iso) => when(p.locale, iso)} onApprove={p.onApprove} onCancel={p.onCancelChange} onAllowEditing={p.onAllowEditing} />
      : section === 'orders' ? <Orders ctx={ctx} orders={p.orders} />
      : section === 'inventory' ? <Inventory ctx={ctx} catalog={p.catalog} />
      : <><Settings p={p} t={t} read={read} c={c} />{connectable && <ConnectCard p={p} t={t} read={read} c={c} />}</>}
  </section>;
}

export type ReturnState = { state: 'WORKING' | 'MISSING' } | { state: 'FAILED'; kind: ShopifyErrorKind } | { state: 'DONE'; result: ShopifyConnectResult };

export function ShopifyReturnView({ language, state, waiting, concealed = false, hasSchool = true }: { language: string; state: ReturnState; waiting: boolean; concealed?: boolean; hasSchool?: boolean }): React.ReactElement {
  const t: T = (key, vars) => shopifyText(language, key, vars);
  let body: React.ReactNode;
  if (state.state === 'MISSING') body = <p className={styles.notice} role="alert">{t('returnMissing')}</p>;
  else if (waiting || state.state === 'WORKING') body = <p className={styles.meta} role="status">{t('returnWorking')}</p>;
  else if (concealed) body = <p className={styles.notice}>{t('concealed')}</p>;
  else if (!hasSchool) body = <p className={styles.notice}>{t('noSchool')}</p>;
  else if (state.state === 'FAILED') body = <p className={`${styles.notice} ${styles.warn}`} role="alert" data-shopify-outcome={state.kind}>{t(`e_${state.kind}` as ShopifyKey)}</p>;
  else if (state.state === 'DONE') {
    const s = state.result.firstSync;
    body = <div className={styles.notice} role="status" data-shopify-outcome="DONE"><p>{!s ? t('done_connect_nosync')
      : s.outcome === 'SUCCEEDED' ? t('done_connect', { products: String(s.productsSeen), orders: String(s.ordersSeen) }) : syncMessage(t, s)}</p></div>;
  }
  return <section className={styles.page}><div className={styles.head}><div><h1>{t('returnTitle')}</h1></div></div>{body}
    <div className={styles.row}><a className={styles.secondary} href="/staff/billing/shopify">{t('back')}</a></div></section>;
}
