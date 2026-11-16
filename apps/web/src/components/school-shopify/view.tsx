import React from 'react';
import type { ShopifyCatalog, ShopifyConnectResult, ShopifyOrders, ShopifyOverview, ShopifySyncResult } from '@hon/contracts';
import { shopifyText, type ShopifyKey } from './copy';
import type { ShopifyErrorKind } from './http';
import styles from './shopify.module.css';

type T = (key: ShopifyKey, vars?: Record<string, string>) => string;
export type OverviewState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; read: ShopifyOverview };
export type ShopifyTab = 'catalog' | 'orders';
export type TabState = { state: 'LOADING' | 'UNAVAILABLE' } | { state: 'CATALOG'; catalog: ShopifyCatalog } | { state: 'ORDERS'; orders: ShopifyOrders };
export type ShopifyAction = 'connect' | 'sync' | 'disconnect';
export type ShopifyOutcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | ShopifyErrorKind; action: ShopifyAction; sync?: ShopifySyncResult }>;

export type ShopifyViewProps = Readonly<{
  language: string; locale: string; waiting: boolean; concealed: boolean; hasSchool: boolean;
  overview: OverviewState; tab: ShopifyTab; list: TabState; shop: string; confirming: boolean; outcome: ShopifyOutcome; locked: boolean;
  onRefresh?: (() => void) | undefined; onShop?: ((value: string) => void) | undefined; onConnect?: (() => void) | undefined;
  onSync?: (() => void) | undefined; onConfirm?: ((open: boolean) => void) | undefined; onDisconnect?: (() => void) | undefined;
  onTab?: ((tab: ShopifyTab) => void) | undefined;
}>;

const when = (locale: string, iso: string) => { try { return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)); } catch { return iso; } };
const day = (locale: string, iso: string) => { try { return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso)); } catch { return iso; } };
export function money(locale: string, currency: string | null, amount: number): string {
  try { return new Intl.NumberFormat(locale, currency ? { style: 'currency', currency } : { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount); }
  catch { return amount.toFixed(2); }
}
const FAILURES = new Set(['CATALOG_TOO_LARGE', 'ORDERS_TOO_MANY', 'TOKEN_REJECTED', 'REFRESH_EXPIRED', 'CREDENTIAL_UNREADABLE']);
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

function CatalogTable({ catalog, t, locale }: { catalog: ShopifyCatalog; t: T; locale: string }): React.ReactElement {
  if (catalog.products.length === 0) return <p className={styles.meta}>{t('catalogEmpty')}</p>;
  const m = (n: number | null) => n === null ? t('noCost') : money(locale, catalog.currency, n);
  return <div className={styles.tableWrap}><table className={styles.table} data-shopify-catalog>
    <thead><tr><th>{t('col_product')}</th><th>{t('col_variant')}</th><th>{t('col_sku')}</th><th>{t('col_price')}</th><th>{t('col_cost')}</th><th>{t('col_margin')}</th><th>{t('col_stock')}</th></tr></thead>
    <tbody>{catalog.products.flatMap((p) => p.variants.map((v, i) => <tr key={v.variantId} data-variant={v.variantId} data-low={v.lowStock ? 'true' : 'false'}>
      <td>{i === 0 ? <><strong>{p.title}</strong>{p.status !== 'ACTIVE' && <span className={styles.chip}>{t(`status_${p.status}`)}</span>}</> : ''}</td>
      <td>{v.title}</td><td>{v.sku ?? ''}</td><td>{m(v.price)}</td><td>{m(v.unitCost)}</td>
      <td>{v.margin === null ? t('noCost') : `${m(v.margin)}${v.marginPercent === null ? '' : ` (${v.marginPercent}%)`}`}</td>
      <td>{!v.tracked ? <span className={styles.meta}>{t('notTracked')}</span> : <>{v.inventoryQuantity ?? 0}{v.lowStock && <span className={styles.chip} data-state="LOW">{t('low')}</span>}</>}</td>
    </tr>))}</tbody>
  </table></div>;
}

function OrdersTable({ orders, t, locale }: { orders: ShopifyOrders; t: T; locale: string }): React.ReactElement {
  if (orders.orders.length === 0) return <p className={styles.meta}>{t('ordersEmpty')}</p>;
  return <div className={styles.tableWrap}><table className={styles.table} data-shopify-orders>
    <thead><tr><th>{t('col_order')}</th><th>{t('col_date')}</th><th>{t('col_items')}</th><th>{t('col_total')}</th><th>{t('col_status')}</th></tr></thead>
    <tbody>{orders.orders.map((o) => <tr key={o.orderId} data-order={o.orderId}>
      <td><strong>{o.name}</strong></td><td>{day(locale, o.placedAt)}</td>
      <td>{o.lines.map((l) => `${l.quantity} × ${l.title}`).join(', ')}</td>
      <td>{money(locale, o.currency, o.total)}</td>
      <td>{o.cancelledAt ? <span className={styles.chip} data-state="CANCELLED">{t('cancelled')}</span> : [o.financialStatus, o.fulfillmentStatus].filter(Boolean).join(' · ')}</td>
    </tr>)}</tbody>
  </table></div>;
}

/** Pure view of the server's verified answers. */
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
  if (o && o.kind === 'DONE') message = o.action === 'disconnect' ? t('done_disconnect') : o.sync ? syncMessage(t, o.sync) : '';
  else if (o && o.kind !== 'SENDING') message = t(`e_${o.kind}` as ShopifyKey);
  const good = o?.kind === 'DONE' && (o.action === 'disconnect' || o.sync?.outcome === 'SUCCEEDED');
  return <section className={styles.page}>
    {head}
    {message && <div className={`${styles.notice} ${good ? '' : styles.warn}`} role={good ? 'status' : 'alert'} data-shopify-outcome={o?.kind}><p>{message}</p></div>}
    {c && <div className={styles.card} data-shopify-connection data-status={c.status}>
      <div className={styles.cardHead}>
        <div><h2>{c.shopName ?? c.shopDomain}</h2><p className={styles.meta}>{c.shopDomain}</p></div>
        <span className={styles.chip} data-state={c.status}>{t(`st_${c.status}`)}</span>
      </div>
      <p className={styles.meta}>{t('since', { time: when(p.locale, c.connectedAt) })} · {c.syncRunning ? t('syncing')
        : c.lastSyncAt ? `${t('lastSync', { time: when(p.locale, c.lastSyncAt) })} (${t(`out_${c.lastSyncOutcome ?? 'SUCCEEDED'}`)})` : t('neverSynced')}</p>
      {c.status === 'NEEDS_RECONNECT' && <p className={styles.warnText}>{t('needsReconnect')}</p>}
      {c.status === 'DISCONNECTED' && <p className={styles.meta}>{t('disconnectedNote')}</p>}
      {read.canManage && c.status === 'CONNECTED' && <div className={styles.row}>
        {p.confirming
          ? <><p className={styles.warnText}>{t('confirmDisconnect')}</p>
            <button type="button" className={styles.primary} disabled={p.locked} onClick={p.onDisconnect}>{t('yesDisconnect')}</button>
            <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onConfirm?.(false)}>{t('cancel')}</button></>
          : <><button type="button" className={styles.primary} disabled={p.locked || c.syncRunning} onClick={p.onSync}>{p.locked && o?.action === 'sync' ? t('syncBusy') : t('sync')}</button>
            <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onConfirm?.(true)}>{t('disconnect')}</button></>}
      </div>}
    </div>}
    {connectable && <div className={styles.card} data-shopify-connect>
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
    </div>}
    <Summary read={read} t={t} locale={p.locale} />
    {c && <div className={styles.card}>
      <div className={styles.tabs} role="group">
        {(['catalog', 'orders'] as const).map((tab) => <button key={tab} type="button" className={styles.tab} aria-pressed={p.tab === tab} onClick={() => p.onTab?.(tab)}>{t(`tab_${tab}`)}</button>)}
      </div>
      {p.list.state === 'LOADING' ? <p className={styles.meta} role="status">{t('loadingList')}</p>
        : p.list.state === 'UNAVAILABLE' ? <p className={styles.notice} role="alert">{t('listUnavailable')}</p>
        : p.list.state === 'CATALOG' ? <CatalogTable catalog={p.list.catalog} t={t} locale={p.locale} />
        : p.list.state === 'ORDERS' ? <OrdersTable orders={p.list.orders} t={t} locale={p.locale} /> : null}
    </div>}
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
