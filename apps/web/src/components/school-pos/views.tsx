import React, { useEffect, useMemo, useState } from 'react';
import { POS_CATEGORIES, POS_METHODS, type PosCategory, type PosItem, type PosItemInput, type PosMethod, type PosRead, type PosSale, type PosShipTo, type PosShopify } from '@hon/contracts';
import type { PersonSummary } from '../people/http';
import type { PosCommand, PosErrorKind } from './http';
import {
  CATEGORY_LABEL, METHOD_LABEL, addItem, addQuick, addShopify, bpsToPercent, cartTotals, changeDue, customerQuery, emptyShip, hasMadeToOrder, shipToInput, formatMoney, lineKey, minorToInput, parseMoney, percentToBps, setQuantity,
  type Cart,
} from './model';
import type { SalesState } from './school-pos';
import styles from './pos.module.css';

export type Outcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | PosErrorKind; op: PosCommand['op']; detail?: string | null }>;
const DONE: Record<PosCommand['op'], string> = { sale: 'Paid.', refund: 'Refund recorded.', item: 'Item saved.', stock: 'Stock updated.', settings: 'Sales tax saved.' };
function outcomeText(o: NonNullable<Outcome>): string {
  if (o.kind === 'SENDING') return 'Saving… keep this page open.';
  if (o.kind === 'DONE') return DONE[o.op];
  if (o.detail) return o.detail + ' Nothing was saved.';
  return {
    SESSION: 'Your session ended. Sign in again. Nothing was saved.', DENIED: 'Your access does not allow this. Nothing was saved.',
    MISSING: 'That is no longer at this school. Nothing was saved.', CHANGED: 'Something changed since this page loaded. Nothing was saved. Check and try again.',
    INVALID: 'This was not accepted. Check the details. Nothing was saved.', BUSY: 'Still saving the first try. Try again in a moment.',
    UNKNOWN: 'We could not confirm this was saved. Try again sends the exact same request, so it never happens twice.',
  }[o.kind];
}
function OutcomeLine({ outcome, canRetry, onTryAgain }: { outcome: Outcome; canRetry: boolean; onTryAgain: () => void }) {
  if (!outcome) return null;
  const tone = outcome.kind === 'DONE' ? 'ok' : outcome.kind === 'SENDING' ? 'info' : 'warn';
  return <p className={styles.outcome} data-tone={tone} role={tone === 'warn' ? 'alert' : 'status'}>{outcomeText(outcome)}
    {canRetry ? <> <button type="button" className={styles.secondary} onClick={onTryAgain}>Try again</button></> : null}</p>;
}
const money = (read: PosRead, minor: number) => formatMoney(minor, read.settings.currency);
const when = (iso: string) => new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

// ---------------- Shopify at the register (0613) ----------------
export type StockSend = 'IDLE' | 'SENDING' | 'DONE' | 'LEFT' | 'DENIED' | 'FAILED';
const SHOPIFY_NOTE: Partial<Record<PosShopify['state'], string>> = {
  NEEDS_EDITING: 'Your Shopify store is connected for reading only, so its products are not sold here. Allow product editing on the Shopify page to sell them at the front desk.',
  CURRENCY_MISMATCH: 'Your Shopify store uses a different currency than this register, so its products are not sold here.',
};
const SEND_TEXT: Record<Exclude<StockSend, 'IDLE'>, string> = {
  SENDING: 'Sending to Shopify…', DONE: 'Shopify is up to date.', LEFT: 'Some changes still did not go through. Check the product in Shopify, then send again.',
  DENIED: 'Only a manager can send these again.', FAILED: 'Shopify could not be reached. Try again in a moment.',
};
/** Sales are never held up by Shopify. This line says when Shopify's count is behind, and lets a manager send the changes again. */
export function ShopifyStockLine({ read, send, onResend }: { read: PosRead; send: StockSend; onResend: () => void }): React.ReactElement | null {
  const stock = read.shopify.unsent, orders = read.shopify.madeToOrder.unsent;
  const s = stock.waiting + stock.failed, o = orders.waiting + orders.failed, n = s + o, failed = stock.failed + orders.failed;
  if (n === 0) return send === 'DONE' ? <p className={styles.outcome} data-tone="ok" role="status">{SEND_TEXT.DONE}</p> : null;
  const stockText = `${s} stock ${s === 1 ? 'change' : 'changes'}`, orderText = `${o} made-to-order ${o === 1 ? 'order' : 'orders'}`;
  return <p className={styles.alert} role="status">
    <strong>{o > 0 ? 'Shopify is behind.' : 'Shopify stock is behind.'}</strong> {o === 0 ? stockText : s === 0 ? orderText : `${stockText} and ${orderText}`} {n === 1 ? 'has' : 'have'} not reached Shopify yet. The sales are saved here.
    {' '}{send !== 'IDLE' && send !== 'DONE' ? SEND_TEXT[send] + ' ' : ''}
    {read.canManage ? <button type="button" className={styles.secondary} disabled={send === 'SENDING'} onClick={onResend}>{send === 'SENDING' ? 'Sending…' : 'Send again'}</button>
      : failed > 0 ? 'Ask a manager to send them again.' : 'They are sent again with the next sale.'}
  </p>;
}
/** What happened to Shopify's count for one sale, shown under its receipt (not part of the printed receipt). */
export function SaleShopifyNote({ sale }: { sale: PosSale }): React.ReactElement | null {
  const { waiting, done, failed } = sale.shopifyStock;
  if (waiting + done + failed === 0) return null;
  return <p className={styles.meta} data-print="hide">{failed > 0 ? 'Shopify stock was not updated for this sale. A manager can send it again from the Register.'
    : waiting > 0 ? 'Shopify stock for this sale is still being sent.' : 'Shopify stock is updated for this sale.'}</p>;
}
/** 0614: what happened to the Shopify order for a sale's made-to-order items (not part of the printed receipt). */
export function SaleOrderNote({ sale }: { sale: PosSale }): React.ReactElement | null {
  const o = sale.shopifyOrder;
  if (!o) return null;
  const where = o.shipTo === 'SCHOOL' ? 'It ships to the school for pickup.' : 'It ships to the customer.';
  return <p className={styles.meta} data-print="hide">{o.status === 'DONE' ? `Shopify order ${o.name ?? ''} was created for the made-to-order items. ${where} If you refund this sale, cancel that order in Shopify too.`
    : o.status === 'WAITING' ? `The Shopify order for the made-to-order items is still being sent. ${where}`
      : o.failureCode === 'SALE_REFUNDED' ? 'No Shopify order was created for the made-to-order items, because this sale was refunded before the order was sent. Nothing is being made.'
      : 'The Shopify order for the made-to-order items was not created, so nothing is being made yet. A manager can send it again from the Register.'}</p>;
}
const MADE_NOTE = 'Some products in your Shopify store are made to order by a print provider. To sell them at the front desk, turn on Allow orders on the Shopify page.';

// ---------------- Register ----------------
export function PosRegister({ read, cart, receipt, outcome, locked, canRetry, found, stockSend = 'IDLE', onCart, onSearchPeople, onClearFound, onNewSale, onPay, onTryAgain, onResendStock = () => undefined }: {
  read: PosRead; cart: Cart; receipt: PosSale | null; outcome: Outcome; locked: boolean; canRetry: boolean; found: readonly PersonSummary[] | null;
  onCart: (c: Cart) => void; onSearchPeople: (q: string) => void; onClearFound: () => void; onNewSale: () => void;
  onPay: (method: PosMethod, reference: string, note: string, shipTo: PosShipTo | null) => void; onTryAgain: () => void; stockSend?: StockSend; onResendStock?: () => void;
}): React.ReactElement {
  const [search, setSearch] = useState(''), [category, setCategory] = useState<PosCategory | 'ALL' | 'SHOPIFY'>('ALL');
  const [quick, setQuick] = useState<{ name: string; amount: string } | null>(null);
  const [discount, setDiscount] = useState<{ kind: 'AMOUNT' | 'PERCENT'; value: string; reason: string } | null>(null);
  const [method, setMethod] = useState<PosMethod>('CASH'), [reference, setReference] = useState(''), [note, setNote] = useState(''), [cash, setCash] = useState('');
  const [who, setWho] = useState('');
  // The customer box searches as the cashier types: a short pause after the last letter, from the second letter on.
  const typed = customerQuery(who), picking = cart.customer.kind !== 'PERSON';
  useEffect(() => {
    if (!picking || typed === null) return;
    const t = setTimeout(() => onSearchPeople(typed), 250);
    return () => clearTimeout(t);
  }, [typed, picking, onSearchPeople]);
  const made = read.shopify.madeToOrder, [ship, setShip] = useState(() => emptyShip(made.pickup ? 'SCHOOL' : 'CUSTOMER'));
  // A typed address belongs to one sale: it goes when the receipt shows, and school pickup stays chosen only while the school can receive.
  useEffect(() => { if (receipt) setShip(emptyShip(made.pickup ? 'SCHOOL' : 'CUSTOMER')); }, [receipt, made.pickup]);
  useEffect(() => { if (!made.pickup) setShip(x => x.kind === 'SCHOOL' ? { ...x, kind: 'CUSTOMER' } : x); }, [made.pickup]);
  const cur = read.settings.currency;
  const items = useMemo(() => read.items.filter(i => i.active && (category === 'ALL' || i.category === category)
    && (!search.trim() || (i.name + ' ' + (i.sku ?? '')).toLowerCase().includes(search.trim().toLowerCase()))), [read.items, category, search]);
  const store = read.shopify;
  const shopItems = useMemo(() => category !== 'ALL' && category !== 'SHOPIFY' ? [] : store.items.filter(v => !search.trim()
    || (v.name + ' ' + (v.sku ?? '')).toLowerCase().includes(search.trim().toLowerCase())), [store.items, category, search]);
  const shopInCart = (variantId: string) => cart.lines.reduce((n, l) => n + (l.kind === 'SHOPIFY' && l.variantId === variantId ? l.quantity : 0), 0);
  const used = POS_CATEGORIES.filter(c => read.items.some(i => i.active && i.category === c));
  const totals = cartTotals(cart, read.settings.taxRateBps);
  const inCart = (id: string) => cart.lines.reduce((n, l) => n + (l.kind === 'ITEM' && l.itemId === id ? l.quantity : 0), 0);

  if (receipt) return <div className={styles.registerDone}>
    <OutcomeLine outcome={outcome} canRetry={false} onTryAgain={onTryAgain}/>
    <Receipt read={read} sale={receipt}/>
    <SaleShopifyNote sale={receipt}/>
    <SaleOrderNote sale={receipt}/>
    <div className={styles.actions}><button type="button" className={styles.primary} onClick={onNewSale}>New sale</button>
      <button type="button" className={styles.secondary} onClick={() => window.print()}>Print receipt</button></div>
  </div>;

  const applyDiscount = () => {
    if (!discount) return;
    const value = discount.kind === 'PERCENT' ? Number(discount.value) : parseMoney(discount.value, cur);
    if (!value || !Number.isInteger(value) || value < 1 || (discount.kind === 'PERCENT' && value > 100) || !discount.reason.trim()) return;
    onCart({ ...cart, discount: { kind: discount.kind, value, reason: discount.reason.trim().slice(0, 200) } }); setDiscount(null);
  };
  const received = method === 'CASH' ? parseMoney(cash, cur) : null, change = changeDue(totals.totalMinor, received);
  const needsShip = hasMadeToOrder(cart), shipTo = needsShip ? shipToInput(ship) : null;
  const canPay = !locked && cart.lines.length > 0 && totals.discountMinor <= totals.subtotalMinor && (!needsShip || shipTo !== null);
  const shipField = (key: 'name' | 'address1' | 'address2' | 'city' | 'province' | 'zip' | 'country', label: string, max: number) =>
    <input className={styles.input} aria-label={label} placeholder={label} maxLength={max} autoComplete="off" disabled={locked} value={ship[key]} onChange={e => setShip({ ...ship, [key]: e.target.value })}/>;

  return <div className={styles.register}>
    <section className={styles.catalog} aria-label="Products">
      <ShopifyStockLine read={read} send={stockSend} onResend={onResendStock}/>
      <div className={styles.row}>
        <input className={styles.input} type="search" placeholder="Search products or SKU" aria-label="Search products" value={search} onChange={e => setSearch(e.target.value)}/>
        <button type="button" className={styles.secondary} disabled={locked} onClick={() => setQuick({ name: '', amount: '' })}>Quick amount</button>
      </div>
      {quick ? <div className={styles.inline}>
        <input className={styles.input} aria-label="What is it for" placeholder="What is it for" maxLength={80} value={quick.name} onChange={e => setQuick({ ...quick, name: e.target.value })}/>
        <input className={styles.input} aria-label="Amount" inputMode="decimal" placeholder="Amount" value={quick.amount} onChange={e => setQuick({ ...quick, amount: e.target.value })}/>
        <button type="button" className={styles.primary} disabled={!quick.name.trim() || !parseMoney(quick.amount, cur)}
          onClick={() => { const a = parseMoney(quick.amount, cur); if (a) { onCart(addQuick(cart, globalThis.crypto.randomUUID(), quick.name.trim().slice(0, 80), a)); setQuick(null); } }}>Add</button>
        <button type="button" className={styles.link} onClick={() => setQuick(null)}>Cancel</button>
      </div> : null}
      <div className={styles.chips} role="group" aria-label="Category">
        {(['ALL', ...used, ...(store.items.length ? ['SHOPIFY' as const] : [])] as const).map(c => <button key={c} type="button" className={styles.chip} aria-pressed={category === c} onClick={() => setCategory(c)}>{c === 'ALL' ? 'All' : CATEGORY_LABEL[c]}</button>)}
      </div>
      {read.items.length === 0 && store.items.length === 0 ? <p className={styles.notice}>No products yet. {read.canManage ? 'Add them in Inventory.' : 'Ask a manager to add them in Inventory.'}</p> : null}
      <ul className={styles.tiles}>
        {items.map(i => {
          const left = i.trackStock ? (i.stock ?? 0) - inCart(i.itemId) : null;
          return <li key={i.itemId}><button type="button" className={styles.tile} data-category={i.category} disabled={locked || (left !== null && left <= 0)} onClick={() => onCart(addItem(cart, i))}>
            <strong>{i.name}</strong><span className={styles.price}>{money(read, i.priceMinor)}</span>
            <small>{i.sku ?? CATEGORY_LABEL[i.category]}{left !== null ? (left <= 0 ? ' · Out of stock' : ` · ${left} left`) : ''}</small>
          </button></li>;
        })}
      </ul>
      {SHOPIFY_NOTE[store.state] ? <p className={styles.meta}>{SHOPIFY_NOTE[store.state]}</p> : null}
      {made.state === 'NEEDS_PERMISSION' ? <p className={styles.meta}>{MADE_NOTE}</p> : null}
      {shopItems.length ? <>
        <h3 className={styles.label}>From your Shopify store{store.shopName ? `: ${store.shopName}` : ''}</h3>
        <ul className={styles.tiles} aria-label="Shopify products">
          {shopItems.map(v => {
            const left = v.tracked ? (v.stock ?? 0) - shopInCart(v.variantId) : null;
            return <li key={v.variantId}><button type="button" className={styles.tile} data-category="SHOPIFY" disabled={locked} onClick={() => onCart(addShopify(cart, v))}>
              <strong>{v.name}</strong><span className={styles.price}>{money(read, v.priceMinor)}</span>
              <small>{v.sku ?? CATEGORY_LABEL.SHOPIFY}{v.madeBy ? ` · Made to order by ${v.madeBy}` : ''}{left !== null ? (left <= 0 ? ' · Shopify shows none left' : ` · ${left} in Shopify`) : ''}</small>
            </button></li>;
          })}
        </ul>
      </> : null}
    </section>

    <section className={styles.sale} aria-label="Sale">
      <h2>Sale</h2>
      <div className={styles.field}>
        <span className={styles.label}>Customer</span>
        {cart.customer.kind === 'PERSON' ? <p className={styles.picked}>{cart.customer.name} <button type="button" className={styles.link} disabled={locked}
          onClick={() => onCart({ ...cart, customer: { kind: 'WALK_IN', name: '' } })}>Change</button></p> : <>
          <div className={styles.row}>
            <input className={styles.input} aria-label="Find a contact" placeholder="Type a name, or leave empty for walk-in" autoComplete="off" value={who}
              onChange={e => { setWho(e.target.value); if (customerQuery(e.target.value) === null) onClearFound(); }} onKeyDown={e => { if (e.key === 'Enter' && who.trim()) onSearchPeople(who); }}/>
            <button type="button" className={styles.secondary} disabled={!who.trim()} onClick={() => onSearchPeople(who)}>Find</button>
          </div>
          {found ? found.length === 0 ? <p className={styles.meta}>No contact found. <button type="button" className={styles.link}
              onClick={() => { onCart({ ...cart, customer: { kind: 'WALK_IN', name: who.trim().slice(0, 120) } }); onClearFound(); }}>Sell as walk-in “{who.trim().slice(0, 40)}”</button></p>
            : <ul className={styles.people}>{found.map(p => <li key={p.personId}><button type="button" className={styles.person}
                onClick={() => { onCart({ ...cart, customer: { kind: 'PERSON', personId: p.personId, name: `${p.givenName} ${p.familyName}`.trim() } }); setWho(''); onClearFound(); }}>
                {p.givenName} {p.familyName}<small>{p.email ?? p.phoneE164 ?? ''}</small></button></li>)}</ul> : null}
          <p className={styles.meta}>{cart.customer.name ? `Walk-in: ${cart.customer.name}` : 'Walk-in'}</p>
        </>}
      </div>

      {cart.lines.length === 0 ? <p className={styles.empty}>Tap a product or add a quick amount.</p> : <ul className={styles.lines}>
        {cart.lines.map(l => <li key={lineKey(l)} className={styles.line}>
          <span className={styles.lineName}>{l.name}<small>{money(read, l.unitPriceMinor)} each{l.kind === 'SHOPIFY' && l.madeBy ? ' · Made to order' : ''}</small></span>
          <span className={styles.qty}>
            <button type="button" aria-label={`One less ${l.name}`} disabled={locked} onClick={() => onCart(setQuantity(cart, lineKey(l), l.quantity - 1))}>−</button>
            <span aria-label="Quantity">{l.quantity}</span>
            <button type="button" aria-label={`One more ${l.name}`} disabled={locked || (l.kind === 'ITEM' && (() => { const i = read.items.find(x => x.itemId === l.itemId); return !!i && i.trackStock && (i.stock ?? 0) <= l.quantity; })())}
              onClick={() => onCart(setQuantity(cart, lineKey(l), l.quantity + 1))}>+</button>
          </span>
          <span className={styles.amount}>{money(read, l.unitPriceMinor * l.quantity)}</span>
        </li>)}
      </ul>}

      {cart.discount ? <p className={styles.meta}>Discount: {cart.discount.kind === 'PERCENT' ? `${cart.discount.value}%` : money(read, cart.discount.value)} ({cart.discount.reason})
        {' '}<button type="button" className={styles.link} disabled={locked} onClick={() => onCart({ ...cart, discount: null })}>Remove</button></p>
        : discount ? <div className={styles.inline}>
          <select className={styles.input} aria-label="Discount type" value={discount.kind} onChange={e => setDiscount({ ...discount, kind: e.target.value as 'AMOUNT' | 'PERCENT' })}>
            <option value="AMOUNT">Amount</option><option value="PERCENT">Percent</option></select>
          <input className={styles.input} aria-label="Discount" inputMode="decimal" placeholder={discount.kind === 'PERCENT' ? '%' : 'Amount'} value={discount.value} onChange={e => setDiscount({ ...discount, value: e.target.value })}/>
          <input className={styles.input} aria-label="Reason for the discount" placeholder="Reason (required)" maxLength={200} value={discount.reason} onChange={e => setDiscount({ ...discount, reason: e.target.value })}/>
          <button type="button" className={styles.primary} onClick={applyDiscount}>Apply</button><button type="button" className={styles.link} onClick={() => setDiscount(null)}>Cancel</button>
        </div> : <button type="button" className={styles.link} disabled={locked || cart.lines.length === 0} onClick={() => setDiscount({ kind: 'AMOUNT', value: '', reason: '' })}>Add a discount</button>}

      {needsShip ? <div className={styles.field}>
        <span className={styles.label}>Made-to-order items ship to</span>
        <div className={styles.chips} role="radiogroup" aria-label="Made-to-order items ship to">
          <button type="button" role="radio" aria-checked={ship.kind === 'SCHOOL'} className={styles.chip} disabled={locked || !made.pickup} onClick={() => setShip({ ...ship, kind: 'SCHOOL' })}>The school (pickup)</button>
          <button type="button" role="radio" aria-checked={ship.kind === 'CUSTOMER'} className={styles.chip} disabled={locked} onClick={() => setShip({ ...ship, kind: 'CUSTOMER' })}>The customer's address</button>
        </div>
        {!made.pickup ? <p className={styles.meta}>School pickup needs the school's full address. {read.canManage ? 'Add it in Settings.' : 'Ask a manager to add it in Settings.'}</p> : null}
        {ship.kind === 'CUSTOMER' ? <>
          {shipField('name', 'Name on the package', 120)}
          {shipField('address1', 'Street address', 120)}
          {shipField('address2', 'Apartment, suite (optional)', 120)}
          <div className={styles.row}>{shipField('city', 'City', 80)}{shipField('province', 'State or province', 40)}</div>
          <div className={styles.row}>{shipField('zip', 'ZIP or postal code', 20)}{shipField('country', 'Country (2 letters, like US)', 2)}</div>
          {shipTo === null ? <p className={styles.meta}>Fill in the name, street, city and country to take payment.</p> : null}
        </> : <p className={styles.meta}>The print provider ships to the school. Tell the customer you will let them know when it arrives.</p>}
        <p className={styles.meta}>Paying here creates a paid order in your Shopify store so the provider makes the item. Shipping is not added to this sale.</p>
      </div> : null}

      <dl className={styles.totals}>
        <div><dt>Subtotal</dt><dd>{money(read, totals.subtotalMinor)}</dd></div>
        {totals.discountMinor > 0 ? <div><dt>Discount</dt><dd>−{money(read, totals.discountMinor)}</dd></div> : null}
        <div><dt>Sales tax ({bpsToPercent(read.settings.taxRateBps)}%)</dt><dd>{money(read, totals.taxMinor)}</dd></div>
        <div className={styles.total}><dt>Total</dt><dd>{money(read, totals.totalMinor)}</dd></div>
      </dl>

      <div className={styles.field}>
        <span className={styles.label}>Paid with</span>
        <div className={styles.chips} role="radiogroup" aria-label="Paid with">
          {POS_METHODS.map(m => <button key={m} type="button" role="radio" aria-checked={method === m} className={styles.chip} disabled={locked} onClick={() => setMethod(m)}>{METHOD_LABEL[m]}</button>)}
        </div>
        {method === 'CASH' ? <div className={styles.row}><input className={styles.input} inputMode="decimal" aria-label="Cash received" placeholder="Cash received (optional)" value={cash} onChange={e => setCash(e.target.value)}/>
          {change !== null ? <span className={styles.change}>Change: {money(read, change)}</span> : null}</div>
          : <input className={styles.input} aria-label={method === 'CHECK' ? 'Check number' : 'Reference'} placeholder={method === 'CHECK' ? 'Check number (optional)' : method === 'CARD_TERMINAL' ? 'Last 4 digits or approval code (optional)' : 'Reference (optional)'}
            maxLength={120} value={reference} onChange={e => setReference(e.target.value)}/>}
        {method === 'CARD_TERMINAL' ? <p className={styles.meta}>Run the card on your own machine first. HON records the sale; it does not charge the card.</p> : null}
        <input className={styles.input} aria-label="Note" placeholder="Note (optional)" maxLength={500} value={note} onChange={e => setNote(e.target.value)}/>
      </div>
      <OutcomeLine outcome={outcome} canRetry={canRetry} onTryAgain={onTryAgain}/>
      <button type="button" className={styles.pay} disabled={!canPay} onClick={() => onPay(method, method === 'CASH' ? '' : reference, note, shipTo)}>
        {locked ? 'Saving…' : `Take ${money(read, totals.totalMinor)}`}</button>
      <p className={styles.meta}>Today: {money(read, read.todaySales.totalMinor)} from {read.todaySales.count} {read.todaySales.count === 1 ? 'sale' : 'sales'}.</p>
    </section>
  </div>;
}

// ---------------- Receipt ----------------
export function Receipt({ read, sale }: { read: PosRead; sale: PosSale }): React.ReactElement {
  return <article className={styles.receipt} aria-label={`Receipt ${sale.receiptNumber}`}>
    <header><strong>{sale.schoolName}</strong><span>Receipt {sale.receiptNumber}</span><span>{when(sale.soldAt)}</span></header>
    <dl className={styles.facts}>
      <div><dt>Customer</dt><dd>{sale.customer.name ?? 'Walk-in'}</dd></div>
      <div><dt>Staff</dt><dd>{sale.soldBy ?? '—'}</dd></div>
      <div><dt>Payment</dt><dd>{METHOD_LABEL[sale.method]}{sale.reference ? ` · ${sale.reference}` : ''}</dd></div>
    </dl>
    <ul className={styles.receiptLines}>{sale.lines.map(l => <li key={l.lineId}><span>{l.quantity} × {l.name}</span><span>{money(read, l.lineTotalMinor)}</span></li>)}</ul>
    <dl className={styles.totals}>
      <div><dt>Subtotal</dt><dd>{money(read, sale.subtotalMinor)}</dd></div>
      {sale.discount ? <div><dt>Discount ({sale.discount.reason})</dt><dd>−{money(read, sale.discount.amountMinor)}</dd></div> : null}
      <div><dt>Tax ({bpsToPercent(sale.taxRateBps)}%)</dt><dd>{money(read, sale.taxMinor)}</dd></div>
      <div className={styles.total}><dt>Total</dt><dd>{money(read, sale.totalMinor)}</dd></div>
      {sale.refunds.map(r => <div key={r.refundId}><dt>Refunded {when(r.refundedAt)} ({METHOD_LABEL[r.method]}): {r.reason}</dt><dd>−{money(read, r.amountMinor)}</dd></div>)}
    </dl>
    {sale.note ? <p className={styles.meta}>Note: {sale.note}</p> : null}
  </article>;
}

// ---------------- History ----------------
export function PosHistory({ read, range, sales, selected, outcome, locked, canRetry, onRange, onOpen, onClose, onRun, onTryAgain }: {
  read: PosRead; range: { from: string; to: string } | null; sales: SalesState; selected: PosSale | null; outcome: Outcome; locked: boolean; canRetry: boolean;
  onRange: (r: { from: string; to: string }) => void; onOpen: (id: string) => void; onClose: () => void; onRun: (c: PosCommand) => void; onTryAgain: () => void;
}): React.ReactElement {
  const [refund, setRefund] = useState<{ amount: string; method: PosMethod; reason: string; restock: Record<string, number> } | null>(null);
  const r = range ?? { from: read.today, to: read.today };
  const report = sales.state === 'READY' ? sales.sales.report : null;
  const left = selected ? selected.totalMinor - selected.refundedMinor : 0;
  const startRefund = (s: PosSale) => setRefund({ amount: minorToInput(s.totalMinor - s.refundedMinor, read.settings.currency), method: s.method, reason: '',
    restock: Object.fromEntries(s.lines.filter(l => l.stockTracked && l.restockedQuantity < l.quantity).map(l => [l.lineId, l.quantity - l.restockedQuantity])) });
  const submitRefund = () => {
    if (!selected || !refund) return;
    const amount = parseMoney(refund.amount, read.settings.currency);
    if (!amount || amount > left || !refund.reason.trim()) return;
    onRun({ op: 'refund', input: { schoolId: read.schoolId, saleId: selected.saleId, amountMinor: amount, method: refund.method, reason: refund.reason.trim().slice(0, 500),
      restock: Object.entries(refund.restock).filter(([, q]) => q > 0).map(([lineId, quantity]) => ({ lineId, quantity })) } });
    setRefund(null);
  };
  return <div className={styles.history}>
    <section className={styles.list} aria-label="Sales">
      <div className={styles.row}>
        <label className={styles.label}>From <input className={styles.input} type="date" value={r.from} max={read.today} onChange={e => e.target.value && onRange({ from: e.target.value, to: e.target.value > r.to ? e.target.value : r.to })}/></label>
        <label className={styles.label}>To <input className={styles.input} type="date" value={r.to} max={read.today} onChange={e => e.target.value && onRange({ from: e.target.value < r.from ? e.target.value : r.from, to: e.target.value })}/></label>
        <button type="button" className={styles.link} onClick={() => onRange({ from: read.today, to: read.today })}>Today</button>
      </div>
      {report ? <dl className={styles.report}>
        <div><dt>Sales</dt><dd>{report.salesCount}</dd></div>
        <div><dt>Collected</dt><dd>{money(read, report.collectedMinor)}</dd></div>
        <div><dt>Refunded</dt><dd>{money(read, report.refundedMinor)}</dd></div>
        <div><dt>Net</dt><dd>{money(read, report.netMinor)}</dd></div>
        <div><dt>Discounts</dt><dd>{money(read, report.discountMinor)}</dd></div>
        <div><dt>Sales tax</dt><dd>{money(read, report.taxMinor)}</dd></div>
        {report.byMethod.map(m => <div key={m.method}><dt>{METHOD_LABEL[m.method]}</dt><dd>{money(read, m.collectedMinor - m.refundedMinor)}</dd></div>)}
      </dl> : null}
      {report && report.topItems.length ? <p className={styles.meta}>Top items: {report.topItems.slice(0, 5).map(t => `${t.name} (${t.quantity})`).join(', ')}</p> : null}
      {sales.state === 'LOADING' || sales.state === 'IDLE' ? <p className={styles.meta}>Loading sales…</p>
        : sales.state === 'DENIED' ? <p className={styles.notice}>Your access does not include sales history.</p>
        : sales.state === 'UNAVAILABLE' ? <p className={styles.notice}>Sales could not be loaded.</p>
        : sales.state !== 'READY' || sales.sales.sales.length === 0 ? <p className={styles.empty}>No sales on these days.</p>
        : <ul className={styles.salesList}>{sales.sales.sales.map(s => <li key={s.saleId}><button type="button" className={styles.saleRow} aria-current={selected?.saleId === s.saleId}
            onClick={() => { setRefund(null); onOpen(s.saleId); }}>
            <span><strong>{s.customer.name ?? 'Walk-in'}</strong><small>{when(s.soldAt)} · {METHOD_LABEL[s.method]} · {s.firstItem}{s.itemCount > 1 ? ` +${s.itemCount - 1}` : ''}</small></span>
            <span className={styles.amount}>{money(read, s.totalMinor)}{s.status !== 'PAID' ? <small>{s.status === 'REFUNDED' ? 'Refunded' : 'Partly refunded'}</small> : null}</span>
          </button></li>)}</ul>}
    </section>
    <section className={styles.detail} aria-label="Receipt">
      <OutcomeLine outcome={outcome} canRetry={canRetry} onTryAgain={onTryAgain}/>
      {!selected ? <p className={styles.empty}>Pick a sale to see its receipt.</p> : <>
        <Receipt read={read} sale={selected}/>
        <SaleShopifyNote sale={selected}/>
        <SaleOrderNote sale={selected}/>
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={() => window.print()}>Print</button>
          {read.canManage && left > 0 && !refund ? <button type="button" className={styles.secondary} disabled={locked} onClick={() => startRefund(selected)}>Refund</button> : null}
          <button type="button" className={styles.link} onClick={() => { setRefund(null); onClose(); }}>Close</button>
        </div>
        {refund ? <div className={styles.form}>
          <h3>Refund (you pay it back yourself; HON moves no money)</h3>
          <label className={styles.label}>Amount (up to {money(read, left)})<input className={styles.input} inputMode="decimal" value={refund.amount} onChange={e => setRefund({ ...refund, amount: e.target.value })}/></label>
          <label className={styles.label}>Paid back with<select className={styles.input} value={refund.method} onChange={e => setRefund({ ...refund, method: e.target.value as PosMethod })}>
            {POS_METHODS.map(m => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}</select></label>
          <label className={styles.label}>Reason (required)<input className={styles.input} maxLength={500} value={refund.reason} onChange={e => setRefund({ ...refund, reason: e.target.value })}/></label>
          {selected.lines.filter(l => l.stockTracked && l.restockedQuantity < l.quantity).map(l => <label key={l.lineId} className={styles.check}>
            Put back on the shelf{l.category === 'SHOPIFY' ? ' (Shopify count goes back up)' : ''}: {l.name}
            <input className={styles.small} type="number" min={0} max={l.quantity - l.restockedQuantity} value={refund.restock[l.lineId] ?? 0}
              onChange={e => setRefund({ ...refund, restock: { ...refund.restock, [l.lineId]: Math.max(0, Math.min(l.quantity - l.restockedQuantity, Math.trunc(Number(e.target.value) || 0))) } })}/>
          </label>)}
          <div className={styles.actions}>
            <button type="button" className={styles.primary} disabled={locked || !refund.reason.trim() || !parseMoney(refund.amount, read.settings.currency) || (parseMoney(refund.amount, read.settings.currency) ?? 0) > left} onClick={submitRefund}>Record refund</button>
            <button type="button" className={styles.link} onClick={() => setRefund(null)}>Cancel</button>
          </div>
        </div> : null}
      </>}
    </section>
  </div>;
}

// ---------------- Inventory ----------------
type ItemDraft = { itemId: string | null; version: number | null; name: string; sku: string; category: PosCategory; price: string; taxable: boolean; trackStock: boolean; stock: string; lowStockAt: string; active: boolean };
const blank: ItemDraft = { itemId: null, version: null, name: '', sku: '', category: 'UNIFORMS', price: '', taxable: true, trackStock: true, stock: '0', lowStockAt: '', active: true };
export function itemInput(schoolId: string, d: ItemDraft, currency: string): PosItemInput | null {
  const price = parseMoney(d.price, currency), stock = d.trackStock && d.itemId === null ? Number(d.stock || '0') : 0;
  const low = d.trackStock && d.lowStockAt.trim() ? Number(d.lowStockAt) : null;
  if (!d.name.trim() || price === null || !Number.isInteger(stock) || stock < 0 || (low !== null && (!Number.isInteger(low) || low < 0))) return null;
  if (d.sku.trim() && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(d.sku.trim())) return null;
  return { schoolId, itemId: d.itemId, expectedVersion: d.version, name: d.name.trim().slice(0, 80), sku: d.sku.trim() || null, category: d.category, priceMinor: price,
    taxable: d.taxable, trackStock: d.trackStock, lowStockAt: low, startingStock: stock, active: d.active };
}
export function PosInventory({ read, outcome, locked, canRetry, onRun, onTryAgain }: {
  read: PosRead; outcome: Outcome; locked: boolean; canRetry: boolean; onRun: (c: PosCommand) => void; onTryAgain: () => void;
}): React.ReactElement {
  const [draft, setDraft] = useState<ItemDraft | null>(null);
  const [tax, setTax] = useState<string | null>(null);
  const cur = read.settings.currency;
  const low = read.items.filter(i => i.active && i.lowStock);
  const edit = (i: PosItem) => setDraft({ itemId: i.itemId, version: i.version, name: i.name, sku: i.sku ?? '', category: i.category, price: minorToInput(i.priceMinor, cur),
    taxable: i.taxable, trackStock: i.trackStock, stock: String(i.stock ?? 0), lowStockAt: i.lowStockAt === null ? '' : String(i.lowStockAt), active: i.active });
  const input = draft ? itemInput(read.schoolId, draft, cur) : null;
  const bps = tax === null ? null : percentToBps(tax);
  return <div className={styles.inventory}>
    <OutcomeLine outcome={outcome} canRetry={canRetry} onTryAgain={onTryAgain}/>
    {low.length ? <p className={styles.alert} role="status"><strong>Low stock:</strong> {low.map(i => `${i.name} (${i.stock})`).join(', ')}. Reorder soon.</p> : null}
    {read.canManage ? <div className={styles.row}>
      <label className={styles.label}>Sales tax %<input className={styles.small} inputMode="decimal" value={tax ?? bpsToPercent(read.settings.taxRateBps)} onChange={e => setTax(e.target.value)}/></label>
      {tax !== null ? <><button type="button" className={styles.primary} disabled={locked || bps === null}
        onClick={() => { if (bps !== null) { onRun({ op: 'settings', input: { schoolId: read.schoolId, expectedVersion: read.settings.version, currency: cur, taxRateBps: bps } }); setTax(null); } }}>Save tax</button>
        <button type="button" className={styles.link} onClick={() => setTax(null)}>Cancel</button></> : <span className={styles.meta}>Charged on items marked taxable.</span>}
    </div> : <p className={styles.meta}>Sales tax {bpsToPercent(read.settings.taxRateBps)}%. Only managers can change products and stock.</p>}
    <section className={styles.card}>
      <div className={styles.row}><h2>Products</h2>{read.canManage && !draft ? <button type="button" className={styles.primary} disabled={locked} onClick={() => setDraft(blank)}>Add product</button> : null}</div>
      {draft ? <div className={styles.form}>
        <h3>{draft.itemId ? 'Edit product' : 'Add product'}</h3>
        <div className={styles.grid}>
          <label className={styles.label}>Name<input className={styles.input} maxLength={80} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })}/></label>
          <label className={styles.label}>Price<input className={styles.input} inputMode="decimal" value={draft.price} onChange={e => setDraft({ ...draft, price: e.target.value })}/></label>
          <label className={styles.label}>Category<select className={styles.input} value={draft.category} onChange={e => setDraft({ ...draft, category: e.target.value as PosCategory })}>
            {POS_CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</select></label>
          <label className={styles.label}>SKU (optional)<input className={styles.input} maxLength={40} value={draft.sku} onChange={e => setDraft({ ...draft, sku: e.target.value })}/></label>
        </div>
        <label className={styles.check}><input type="checkbox" checked={draft.taxable} onChange={e => setDraft({ ...draft, taxable: e.target.checked })}/> Charge sales tax</label>
        <label className={styles.check}><input type="checkbox" checked={draft.trackStock} onChange={e => setDraft({ ...draft, trackStock: e.target.checked, lowStockAt: e.target.checked ? draft.lowStockAt : '' })}/> Count stock</label>
        {draft.trackStock ? <div className={styles.grid}>
          {draft.itemId === null ? <label className={styles.label}>Starting stock<input className={styles.input} inputMode="numeric" value={draft.stock} onChange={e => setDraft({ ...draft, stock: e.target.value })}/></label> : null}
          <label className={styles.label}>Low stock alert at<input className={styles.input} inputMode="numeric" value={draft.lowStockAt} onChange={e => setDraft({ ...draft, lowStockAt: e.target.value })}/></label>
        </div> : null}
        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={locked || !input} onClick={() => { if (input) { onRun({ op: 'item', input }); setDraft(null); } }}>Save</button>
          {draft.itemId ? <button type="button" className={styles.secondary} disabled={locked} onClick={() => { const x = itemInput(read.schoolId, { ...draft, active: !draft.active }, cur); if (x) { onRun({ op: 'item', input: x }); setDraft(null); } }}>
            {draft.active ? 'Remove from register' : 'Put back on register'}</button> : null}
          <button type="button" className={styles.link} onClick={() => setDraft(null)}>Cancel</button>
        </div>
      </div> : null}
      {read.items.length === 0 ? <p className={styles.empty}>No products yet.</p> : <ul className={styles.stockList}>
        {read.items.map(i => <li key={i.itemId} className={styles.stockRow} data-inactive={!i.active || undefined}>
          <span><strong>{i.name}</strong>{i.lowStock ? <span className={styles.low}>Low</span> : null}{!i.active ? <span className={styles.low}>Removed</span> : null}
            <small>{[i.sku, CATEGORY_LABEL[i.category], money(read, i.priceMinor), i.taxable ? 'taxed' : null].filter(Boolean).join(' · ')}</small></span>
          {i.trackStock ? <span className={styles.qty}>
            {read.canManage ? <button type="button" aria-label={`One less ${i.name} in stock`} disabled={locked || (i.stock ?? 0) <= 0}
              onClick={() => onRun({ op: 'stock', input: { schoolId: read.schoolId, itemId: i.itemId, expectedVersion: i.version, change: -1, reason: 'Counted at the desk' } })}>−</button> : null}
            <span aria-label="In stock">{i.stock}</span>
            {read.canManage ? <button type="button" aria-label={`One more ${i.name} in stock`} disabled={locked}
              onClick={() => onRun({ op: 'stock', input: { schoolId: read.schoolId, itemId: i.itemId, expectedVersion: i.version, change: 1, reason: 'Counted at the desk' } })}>+</button> : null}
          </span> : <span className={styles.meta}>No stock count</span>}
          {read.canManage ? <button type="button" className={styles.link} disabled={locked || !!draft} onClick={() => edit(i)}>Edit</button> : null}
        </li>)}
      </ul>}
    </section>
  </div>;
}
