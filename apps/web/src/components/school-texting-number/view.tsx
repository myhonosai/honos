import React from 'react';
import type { AvailableSchoolNumber, SchoolNumberOrder } from '@hon/contracts';
import { numberText, type NumberKey } from './copy';
import { formatMonthly, formatPhone, openOrderOf, searchQuery, type NumberErrorKind, type SearchDraft } from './http';
import styles from '../school-support/support.module.css';

type T = (key: NumberKey, vars?: Record<string, string>) => string;
export type OrdersState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; orders: readonly SchoolNumberOrder[] };
export type SearchState = { state: 'IDLE' | 'SEARCHING' | 'OFF' | 'FAILED' | 'INVALID' } | { state: 'READY'; numbers: readonly AvailableSchoolNumber[]; hasOwnNumber: boolean };
export type NumberAction = 'order' | 'cancel';
export type NumberOutcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | NumberErrorKind; action: NumberAction }>;
export const EMPTY_SEARCH: SearchDraft = { mode: 'AREA', areaCode: '', city: '', region: '' };

export type NumberViewProps = Readonly<{
  language: string; locale: string; waiting: boolean; concealed: boolean; hasSchool: boolean;
  orders: OrdersState; search: SearchState; draft: SearchDraft; picked: AvailableSchoolNumber | null; confirmCancel: boolean;
  outcome: NumberOutcome; locked: boolean; canRetry: boolean;
  onRefresh?: (() => void) | undefined; onDraft?: ((next: SearchDraft) => void) | undefined; onSearch?: (() => void) | undefined;
  onPick?: ((n: AvailableSchoolNumber | null) => void) | undefined; onOrder?: (() => void) | undefined;
  onConfirmCancel?: ((on: boolean) => void) | undefined; onCancel?: (() => void) | undefined; onTryAgain?: (() => void) | undefined;
}>;

const when = (locale: string, iso: string) => { try { return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)); } catch { return iso; } };
const placeOf = (n: { locality: string | null; region: string | null }) => [n.locality, n.region].filter(Boolean).join(', ');
const unsettled = (o: SchoolNumberOrder) => o.status === 'FAILED' && o.outcomeUnknown;

function OpenOrder({ o, t, p }: { o: SchoolNumberOrder; t: T; p: NumberViewProps }): React.ReactElement {
  const state = unsettled(o) ? 'UNSETTLED' : o.status;
  const cancellable = o.status === 'REQUESTED' || o.status === 'APPROVED';
  return <div className={styles.card} data-number-open={o.orderId} data-status={state}>
    <div className={styles.cardHead}><h2>{t('openTitle')}</h2><span className={styles.chip} data-kind="open">{t(`st_${state}` as NumberKey)}</span></div>
    <dl className={styles.summary}>
      <dt>{formatPhone(o.phoneE164)}</dt><dd>{placeOf(o)}</dd>
      <dt>{t('price', { price: formatMonthly(p.locale, o.monthlyPriceMicrounits) })}</dt><dd>{t('requested', { time: when(p.locale, o.createdAt) })}</dd>
    </dl>
    <p className={state === 'UNSETTLED' ? styles.warnText : styles.meta}>{t(`help_${state}` as NumberKey)}</p>
    {cancellable && (p.confirmCancel
      ? <div className={styles.row}><button type="button" className={styles.primary} disabled={p.locked} onClick={p.onCancel}>{p.locked ? t('cancelling') : t('cancelConfirm')}</button>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onConfirmCancel?.(false)}>{t('keep')}</button></div>
      : <div className={styles.row}><button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onConfirmCancel?.(true)}>{t('cancel')}</button></div>)}
  </div>;
}

function Search({ t, p }: { t: T; p: NumberViewProps }): React.ReactElement {
  const d = p.draft, set = (patch: Partial<SearchDraft>) => p.onDraft?.({ ...d, ...patch }), ready = searchQuery(d) !== null, s = p.search;
  const busy = p.locked || s.state === 'SEARCHING';
  if (p.picked) {
    const n = p.picked, phone = formatPhone(n.phoneE164);
    return <div className={styles.card} data-number-confirm={n.phoneE164}>
      <h2>{t('confirmTitle')}</h2>
      <dl className={styles.summary}><dt>{phone}</dt><dd>{placeOf(n)}</dd></dl>
      <p><strong>{t('confirmPrice', { price: formatMonthly(p.locale, n.monthlyPriceMicrounits) })}</strong></p>
      <p className={styles.meta}>{t('confirmCharge')}</p>
      <div className={styles.row}><button type="button" className={styles.primary} disabled={p.locked} onClick={p.onOrder}>{p.locked ? t('ordering') : t('order', { phone })}</button>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onPick?.(null)}>{t('back')}</button></div>
    </div>;
  }
  return <div className={styles.card} data-number-search>
    <h2>{t('searchTitle')}</h2>
    {s.state === 'OFF' ? <p className={styles.notice} data-number-off>{t('off')}</p> : <>
      <div className={styles.tabs} role="group" aria-label={t('searchTitle')}>
        <button type="button" className={styles.tab} aria-pressed={d.mode === 'AREA'} disabled={busy} onClick={() => set({ mode: 'AREA' })}>{t('byArea')}</button>
        <button type="button" className={styles.tab} aria-pressed={d.mode === 'CITY'} disabled={busy} onClick={() => set({ mode: 'CITY' })}>{t('byCity')}</button>
      </div>
      <form className={styles.form} onSubmit={(e) => { e.preventDefault(); if (ready) p.onSearch?.(); }}>
        {d.mode === 'AREA'
          ? <label className={styles.field}>{t('areaCode')}<input inputMode="numeric" maxLength={3} value={d.areaCode} disabled={busy} onChange={(e) => set({ areaCode: e.target.value.replace(/\D/g, '') })} />
            <span className={styles.meta}>{t('areaHelp')}</span></label>
          : <div className={styles.grid}>
            <label className={styles.field}>{t('city')}<input maxLength={60} value={d.city} disabled={busy} onChange={(e) => set({ city: e.target.value })} /></label>
            <label className={styles.field}>{t('region')}<input maxLength={2} value={d.region} disabled={busy} onChange={(e) => set({ region: e.target.value.toUpperCase() })} />
              <span className={styles.meta}>{t('regionHelp')}</span></label></div>}
        <div className={styles.row}><button type="submit" className={styles.primary} disabled={busy || !ready}>{s.state === 'SEARCHING' ? t('searching') : t('search')}</button></div>
      </form>
      {s.state === 'FAILED' && <p className={styles.warnText} role="alert">{t('searchFailed')}</p>}
      {s.state === 'INVALID' && <p className={styles.warnText} role="alert">{t('searchInvalid')}</p>}
      {s.state === 'READY' && (s.hasOwnNumber ? <p className={styles.notice}>{t('ownOther')}</p>
        : s.numbers.length === 0 ? <p className={styles.meta} role="status">{t('noResults')}</p>
          : <div data-number-results><h3>{t('results')}</h3><ol className={styles.steps}>{s.numbers.map((n) => <li key={n.phoneE164} className={styles.step}>
            <div className={styles.stepMain}><strong>{formatPhone(n.phoneE164)}</strong><span className={styles.meta}>{placeOf(n)} · {t('price', { price: formatMonthly(p.locale, n.monthlyPriceMicrounits) })}</span></div>
            <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onPick?.(n)}>{t('pick', { phone: formatPhone(n.phoneE164) })}</button></li>)}</ol></div>)}
    </>}
  </div>;
}

/** Pure view: everything shown is the server's verified answer, or this person's own unsent search. */
export function NumberView(p: NumberViewProps): React.ReactElement {
  const t: T = (key, vars) => numberText(p.language, key, vars);
  const head = <div className={styles.head}><div><h1>{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
    {p.orders.state === 'READY' && <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onRefresh}>{t('refresh')}</button>}</div>;
  if (p.waiting) return <section className={styles.page}>{head}<p className={styles.meta} role="status">{t('waiting')}</p></section>;
  if (p.concealed) return <section className={styles.page}>{head}<p className={styles.notice}>{t('concealed')}</p></section>;
  if (!p.hasSchool) return <section className={styles.page}>{head}<p className={styles.notice}>{t('noSchool')}</p></section>;
  if (p.orders.state !== 'READY') return <section className={styles.page}>{head}
    {p.orders.state === 'LOADING' ? <p className={styles.meta} role="status">{t('loading')}</p>
      : <div className={styles.notice} role="alert"><p>{t(p.orders.state === 'DENIED' ? 'denied' : 'unavailable')}</p>
        {p.orders.state === 'UNAVAILABLE' && <button type="button" className={styles.secondary} onClick={p.onRefresh}>{t('refresh')}</button>}</div>}
  </section>;
  const orders = p.orders.orders, open = openOrderOf(orders), bought = [...orders].reverse().find((o) => o.status === 'PURCHASED') ?? null;
  const history = orders.filter((o) => o !== open && o !== bought).reverse(), o = p.outcome;
  return <section className={styles.page}>
    {head}
    {o && o.kind !== 'SENDING' && <div className={`${styles.notice} ${o.kind === 'DONE' ? '' : styles.warn}`} role={o.kind === 'DONE' ? 'status' : 'alert'} data-number-outcome={o.kind}>
      <p>{o.kind === 'DONE' ? t(o.action === 'order' ? 'done_order' : 'done_cancel') : t(`e_${o.kind}` as NumberKey)}</p>
      {p.canRetry && <button type="button" className={styles.primary} onClick={p.onTryAgain}>{t('tryAgain')}</button>}</div>}
    {bought ? <div className={styles.card} data-number-own={bought.phoneE164}><h2>{t('ownTitle')}</h2>
      <p>{t('ownBody', { phone: formatPhone(bought.phoneE164) })}</p><p className={styles.meta}>{t('ownPending')}</p></div>
      : open ? <OpenOrder o={open} t={t} p={p} /> : <Search t={t} p={p} />}
    {history.length > 0 && <div className={styles.card} data-number-history><h2>{t('historyTitle')}</h2><ol className={styles.list}>{history.map((h) => <li key={h.orderId} data-status={h.status}>
      <strong>{formatPhone(h.phoneE164)} · {t(`st_${h.status}` as NumberKey)}</strong>
      <span className={styles.meta}>{t('requested', { time: when(p.locale, h.createdAt) })}</span>
      {h.decisionNote && h.status === 'REJECTED' && <span>{t('reason', { note: h.decisionNote })}</span>}
      {h.status === 'FAILED' && h.failureCode && <span className={styles.meta}>{t('failed_code', { code: h.failureCode })}</span>}</li>)}</ol></div>}
  </section>;
}
