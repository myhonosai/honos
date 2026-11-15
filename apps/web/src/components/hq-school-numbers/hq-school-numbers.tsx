'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SCHOOL_NUMBER_ORDER_STATUSES, type HqSchoolNumberOrder, type SchoolNumberOrderStatus } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { formatMonthly, formatPhone } from '../school-texting-number/http';
import { hqNumberText, type HqNumberKey } from './copy';
import { HQ_NOTE_MAX, HqNumberError, hqNumberApi, noteOk, type HqNumberApi, type HqNumberErrorKind } from './http';
import styles from '../hq-access/hq-access.module.css';

export type HqNumbersState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; orders: readonly HqSchoolNumberOrder[] };
export type HqNumberForm = null | Readonly<{ orderId: string; kind: 'APPROVE' | 'REJECT' | 'SETTLE'; finding: 'BOUGHT' | 'NOT_BOUGHT' | null; note: string }>;
export type HqNumberOutcome = null | Readonly<{ kind: 'DONE' | HqNumberErrorKind; what: 'APPROVE' | 'REJECT' | 'BOUGHT' | 'NOT_BOUGHT' }>;
type T = (key: HqNumberKey, vars?: Record<string, string>) => string;
const unsettled = (o: HqSchoolNumberOrder) => o.status === 'FAILED' && o.outcomeUnknown;

/** Whether the open form is what the server accepts, so Record only enables when it is. */
export function formReady(f: NonNullable<HqNumberForm>): boolean {
  if (f.kind === 'APPROVE') return f.note === '' || noteOk(f.note);
  if (f.kind === 'REJECT') return noteOk(f.note);
  return f.finding !== null && noteOk(f.note);
}

/**
 * HQ school number orders. A session end hides the list, retires the read and drops any open form. Every command is
 * followed by a fresh read; a failed or unknown command never retries by itself.
 */
export function HqSchoolNumbersPage({ api = hqNumberApi }: { api?: HqNumberApi }): React.ReactElement {
  const { preferences, formattingLocale } = useLocale();
  const [state, setState] = useState<HqNumbersState>({ state: 'LOADING' });
  const [filter, setFilter] = useState<SchoolNumberOrderStatus | null>(null);
  const [concealed, setConcealed] = useState(false);
  const [form, setForm] = useState<HqNumberForm>(null);
  const [outcome, setOutcome] = useState<HqNumberOutcome>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0), privacy = useRef(0), mounted = useRef(false), sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; privacy.current++; }; }, []);

  useEffect(() => {
    const conceal = () => { generation.current++; privacy.current++; setConcealed(true); setForm(null); setOutcome(null); setState({ state: 'LOADING' }); };
    window.addEventListener('pagehide', conceal); window.addEventListener(HON_SESSION_INVALIDATED_EVENT, conceal);
    return () => { window.removeEventListener('pagehide', conceal); window.removeEventListener(HON_SESSION_INVALIDATED_EVENT, conceal); };
  }, []);

  useEffect(() => {
    if (concealed) return;
    const current = ++generation.current, owned = () => mounted.current && current === generation.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]);
    setState({ state: 'LOADING' });
    api.list(filter, signal, owned).then((orders) => { if (owned()) setState({ state: 'READY', orders }); }, (error) => {
      if (!owned() || abort.signal.aborted) return;
      setState({ state: error instanceof HqNumberError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' });
    });
    return () => { abort.abort(); };
  }, [api, filter, refresh, concealed]);

  const submit = useCallback(async () => {
    if (!form || sending.current || state.state !== 'READY' || !formReady(form)) return;
    const order = state.orders.find((o) => o.orderId === form.orderId);
    if (!order) return;
    sending.current = true; setBusy(true);
    const shown = privacy.current, owned = () => mounted.current && shown === privacy.current, signal = AbortSignal.timeout(30000);
    const what = form.kind === 'SETTLE' ? form.finding! : form.kind;
    let next: HqNumberOutcome;
    try {
      if (form.kind === 'SETTLE') await api.settle(order.orderId, form.finding!, form.note, order.version, signal, owned);
      else await api.decide(order.orderId, form.kind, form.note, order.version, signal, owned);
      next = { kind: 'DONE', what };
    } catch (error) {
      next = { kind: error instanceof HqNumberError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN', what };
    } finally { sending.current = false; setBusy(false); }
    if (!owned()) return;
    setOutcome(next);
    if (next.kind === 'DONE' || next.kind === 'CONFLICT' || next.kind === 'GONE' || next.kind === 'UNKNOWN') setForm(null);
    setRefresh((n) => n + 1);
  }, [api, form, state]);

  return <HqSchoolNumbersView language={preferences.language} formattingLocale={formattingLocale} concealed={concealed} state={state} filter={filter}
    form={form} outcome={outcome} busy={busy}
    onRefresh={() => { setOutcome(null); setRefresh((n) => n + 1); }} onReveal={() => setConcealed(false)}
    onFilter={(f) => { if (!busy) { setFilter(f); setForm(null); setOutcome(null); } }}
    onForm={(f) => { if (!busy) { setForm(f); setOutcome(null); } }} onSubmit={() => { void submit(); }}/>;
}

export type HqSchoolNumbersViewProps = Readonly<{
  language: string; formattingLocale: string; concealed: boolean; state: HqNumbersState; filter: SchoolNumberOrderStatus | null;
  form: HqNumberForm; outcome: HqNumberOutcome; busy: boolean;
  onRefresh: () => void; onReveal: () => void; onFilter: (f: SchoolNumberOrderStatus | null) => void; onForm: (f: HqNumberForm) => void; onSubmit: () => void;
}>;

function OrderForm({ o, f, t, p }: { o: HqSchoolNumberOrder; f: NonNullable<HqNumberForm>; t: T; p: HqSchoolNumbersViewProps }): React.ReactElement {
  const phone = formatPhone(o.phoneE164), set = (patch: Partial<NonNullable<HqNumberForm>>) => p.onForm({ ...f, ...patch });
  const noteLabel = f.kind === 'APPROVE' ? t('noteOptional') : f.kind === 'REJECT' ? t('noteRequired') : t('settleNote');
  return <form className={styles.form} data-hq-number-form={f.kind} onSubmit={(e) => { e.preventDefault(); if (formReady(f)) p.onSubmit(); }}>
    <h3>{t(f.kind === 'APPROVE' ? 'approveTitle' : f.kind === 'REJECT' ? 'rejectTitle' : 'settleTitle')}</h3>
    <p className={styles.meta}>{f.kind === 'APPROVE' ? t('approveHelp', { phone }) : f.kind === 'REJECT' ? t('rejectHelp') : t('settleHelp', { phone, account: t('settleAccountUnknown') })}</p>
    {f.kind === 'SETTLE' && <fieldset className={styles.fields} disabled={p.busy}><legend>{t('found')}</legend>
      {(['BOUGHT', 'NOT_BOUGHT'] as const).map((k) => <label key={k}><input type="radio" name={`finding-${o.orderId}`} checked={f.finding === k} onChange={() => set({ finding: k })}/>{' '}
        {t(k === 'BOUGHT' ? 'foundBought' : 'foundNotBought', { phone })}<span className={styles.meta}> {t(k === 'BOUGHT' ? 'foundBoughtHelp' : 'foundNotBoughtHelp')}</span></label>)}
    </fieldset>}
    <label>{noteLabel}<textarea rows={3} maxLength={HQ_NOTE_MAX} value={f.note} disabled={p.busy} onChange={(e) => set({ note: e.target.value })}/></label>
    <p className={styles.meta}>{t('noteHelp')}</p>
    <div className={styles.actions}>
      <button type="submit" className={f.kind === 'REJECT' ? styles.danger : styles.primary} disabled={p.busy || !formReady(f)}>{p.busy ? t('working') : t('confirm')}</button>
      <button type="button" className={styles.secondary} disabled={p.busy} onClick={() => p.onForm(null)}>{t('cancel')}</button></div>
  </form>;
}

/** Presentation only. Every fact comes from the verified server answer. */
export function HqSchoolNumbersView(p: HqSchoolNumbersViewProps): React.ReactElement {
  const t: T = (key, vars) => hqNumberText(p.language, key, vars);
  const time = (iso: string) => { try { return `${new Intl.DateTimeFormat(p.formattingLocale, { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))} UTC`; } catch { return iso; } };
  const head = <header className={styles.head}>
    <div><p className={styles.meta}><a href="/hq/communications">{t('back')}</a></p><h1>{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
    {!p.concealed && <button type="button" className={styles.secondary} disabled={p.state.state === 'LOADING' || p.busy} onClick={p.onRefresh}>{t('refresh')}</button>}
  </header>;
  if (p.concealed) return <section className={styles.access} data-hq-numbers="concealed">{head}
    <div className={styles.notice} role="status"><p>{t('concealed')}</p><button type="button" className={styles.secondary} onClick={p.onReveal}>{t('reveal')}</button></div></section>;
  const banner = <p className={styles.notice} role="note" data-hq-numbers-off="">{t('buyingOff')}</p>;
  const filters = <div className={styles.filters} role="group" aria-label={t('filter')}>
    {([null, ...SCHOOL_NUMBER_ORDER_STATUSES] as const).map((s) => <button key={s ?? 'ALL'} type="button" aria-pressed={p.filter === s} disabled={p.busy || p.state.state === 'LOADING'}
      onClick={() => p.onFilter(s)}>{s ? t(`st_${s}` as HqNumberKey) : t('all')}</button>)}</div>;
  if (p.state.state !== 'READY') return <section className={styles.access} data-hq-numbers={p.state.state.toLowerCase()} aria-busy={p.state.state === 'LOADING'}>{head}{banner}{filters}
    <p className={styles.notice} role="status">{t(p.state.state === 'LOADING' ? 'loading' : p.state.state === 'DENIED' ? 'denied' : 'unavailable')}</p></section>;
  const o = p.outcome, rows = [...p.state.orders].reverse();
  return <section className={styles.access} data-hq-numbers="ready">{head}{banner}{filters}
    {o && <div className={styles.outcome} data-tone={o.kind === 'DONE' ? 'ok' : o.kind === 'UNKNOWN' ? 'waiting' : 'blocked'} role={o.kind === 'DONE' ? 'status' : 'alert'} data-hq-number-outcome={o.kind}>
      <p>{o.kind === 'DONE' ? t(`done_${o.what}` as HqNumberKey) : t(`e_${o.kind}` as HqNumberKey)}</p></div>}
    {rows.length === 0 ? <p className={styles.meta}>{t('none')}</p> : <ol className={styles.list}>{rows.map((r) => {
      const open = p.form?.orderId === r.orderId ? p.form : null, needsSettle = unsettled(r);
      return <li key={r.orderId} className={styles.card} data-hq-number={r.orderId} data-status={needsSettle ? 'UNSETTLED' : r.status}>
        <div className={styles.cardHead}><h2>{r.schoolName}</h2>
          <span className={styles.status} data-tone={needsSettle ? 'blocked' : r.status === 'REQUESTED' ? 'waiting' : r.status === 'PURCHASED' ? 'ready' : undefined}>
            {needsSettle ? t('unsettled') : t(`st_${r.status}` as HqNumberKey)}</span></div>
        <dl className={styles.facts}>
          <div><dt>{formatPhone(r.phoneE164)}</dt><dd>{[r.locality, r.region].filter(Boolean).join(', ')}</dd></div>
          <div><dt>{t('price', { price: formatMonthly(p.formattingLocale, r.monthlyPriceMicrounits) })}</dt><dd>{t('requested', { time: time(r.createdAt) })}</dd></div>
          {r.decidedAt && <div><dt>{t('decided', { time: time(r.decidedAt) })}</dt><dd>{r.decisionNote ? t('note', { note: r.decisionNote }) : ''}</dd></div>}
          {r.failureCode && <div><dt>{t('failure', { code: r.failureCode })}</dt><dd/></div>}
        </dl>
        {open ? <OrderForm o={r} f={open} t={t} p={p}/> : <div className={styles.actions}>
          {r.status === 'REQUESTED' && <><button type="button" className={styles.primary} disabled={p.busy} onClick={() => p.onForm({ orderId: r.orderId, kind: 'APPROVE', finding: null, note: '' })}>{t('approve')}</button>
            <button type="button" className={styles.secondary} disabled={p.busy} onClick={() => p.onForm({ orderId: r.orderId, kind: 'REJECT', finding: null, note: '' })}>{t('reject')}</button></>}
          {needsSettle && <button type="button" className={styles.primary} disabled={p.busy} onClick={() => p.onForm({ orderId: r.orderId, kind: 'SETTLE', finding: null, note: '' })}>{t('settle')}</button>}
        </div>}
      </li>;
    })}</ol>}
    {p.state.orders.length >= 200 && <p className={styles.meta}>{t('capped')}</p>}
  </section>;
}
