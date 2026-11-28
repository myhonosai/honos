'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HqSchoolPlanChoice, HqSchoolPlanRecord, HqSchoolPlanView } from '@hon/contracts';
import { PlanError, schoolPlanApi, type SchoolPlanApi } from './http';
import { isSchoolPlanKey, schoolPlanText, type SchoolPlanKey } from './copy';
import styles from '../hq-access/hq-access.module.css';
import own from './plan.module.css';

type Load = { state: 'LOADING' } | { state: 'DENIED' } | { state: 'UNAVAILABLE' } | { state: 'READY'; view: HqSchoolPlanView };
type Step = { step: 'VIEW' } | { step: 'PICK' } | { step: 'CONFIRM'; choice: HqSchoolPlanChoice; startDate: string; label: string; price: string; start: string } | { step: 'REMOVE' };
type Pick = { kind: 'OFFER'; offerId: string } | { kind: 'CUSTOM' } | null;
const PRICE = /^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/;

/** Cents from a typed dollar amount ("149", "149.5", "149.50"), or null. Max $100,000. */
export function centsFromDollars(text: string): number | null {
  const t = text.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!PRICE.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return cents <= 10_000_000 ? cents : null;
}
const todayUtc = () => new Date().toISOString().slice(0, 10);
const yearsAhead = (n: number) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() + n); return d.toISOString().slice(0, 10); };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayText = (f: Fmt, day: string) => f.day.format(new Date(`${day}T00:00:00Z`));

export type PlanLoad = Load; export type PlanStep = Step; export type PlanPick = Pick;
export type PlanForm = Readonly<{ name: string; price: string; interval: 'MONTHLY' | 'ANNUAL'; freeUntil: string; startDate: string; note: string }>;
type Text = (key: SchoolPlanKey, vars?: Record<string, string>) => string;
type Fmt = Readonly<{ money: Intl.NumberFormat; day: Intl.DateTimeFormat }>;
function fmt(formattingLocale: string): Fmt {
  return { money: new Intl.NumberFormat(formattingLocale, { style: 'currency', currency: 'USD' }),
    day: new Intl.DateTimeFormat(formattingLocale, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }) };
}
/** "$149.00 / month", "Free until Jan 31, 2027", "Free, no end date". */
export function planPriceText(t: Text, f: Fmt, r: { priceMinor: number | null; billingInterval: string | null; freeUntil?: string | null }): string {
  if (r.priceMinor === 0) return r.freeUntil ? t('freeUntil', { date: f.day.format(new Date(`${r.freeUntil}T00:00:00Z`)) }) : t('freeForever');
  return t(`per${r.billingInterval ?? 'MONTHLY'}` as SchoolPlanKey, { price: f.money.format((r.priceMinor ?? 0) / 100) });
}
/**
 * Turns the picker into the exact choice the server will get, or the reason it cannot be sent. Pure; the server re-checks.
 * The start date (0700) may be one year back to one year ahead (UTC days); a free plan's end date must come after it.
 */
export function reviewChoice(view: HqSchoolPlanView, pick: Pick, form: PlanForm, t: Text, f: Fmt, today = todayUtc(), limit = yearsAhead(3),
  startFrom = yearsAhead(-1), startTo = yearsAhead(1)):
  { ok: true; choice: HqSchoolPlanChoice; startDate: string; label: string; price: string; start: string } | { ok: false; problem: SchoolPlanKey } {
  if (!pick) return { ok: false, problem: 'pickOne' };
  const startDate = form.startDate;
  if (!DAY.test(startDate) || Number.isNaN(Date.parse(`${startDate}T00:00:00Z`)) || startDate < startFrom || startDate > startTo) return { ok: false, problem: 'invalidStart' };
  const start = dayText(f, startDate);
  if (pick.kind === 'OFFER') {
    const o = view.offers.find(x => x.offerId === pick.offerId);
    return o ? { ok: true, choice: { source: 'OFFER', offerId: o.offerId }, startDate, label: o.displayName, price: planPriceText(t, f, o), start } : { ok: false, problem: 'pickOne' };
  }
  const n = form.name.trim(), cents = centsFromDollars(form.price);
  if (n.length < 3 || n.length > 80) return { ok: false, problem: 'invalidName' };
  if (cents === null) return { ok: false, problem: 'invalidPrice' };
  const until = cents === 0 && form.freeUntil ? form.freeUntil : null;
  if (until && (until <= today || until > limit)) return { ok: false, problem: 'invalidDate' };
  if (until && until <= startDate) return { ok: false, problem: 'freeAfterStart' };
  return { ok: true, choice: { source: 'CUSTOM', name: n, billingInterval: form.interval, priceMinor: cents, freeUntil: until }, startDate, label: n,
    price: planPriceText(t, f, { priceMinor: cents, billingInterval: form.interval, freeUntil: until }), start };
}

export type PlanCardViewProps = Readonly<{
  language: string; formattingLocale: string; load: Load; step: Step; pick: Pick; form: PlanForm; problem: string | null; done: string | null; busy: boolean;
  onRetry: () => void; onStart: () => void; onStartRemove: () => void; onPick: (pick: Pick) => void; onForm: (patch: Partial<PlanForm>) => void;
  onReview: () => void; onSave: () => void; onRemove: () => void; onBack: () => void; onCancel: () => void;
}>;

/** Presentation only: every fact comes from the verified server answer. */
export function PlanCardView(p: PlanCardViewProps): React.ReactElement {
  const t: Text = (key, vars) => schoolPlanText(p.language, key, vars);
  const f = fmt(p.formattingLocale);
  const price = (r: Parameters<typeof planPriceText>[2]) => planPriceText(t, f, r);
  const head = <div className={styles.cardHead}><h2 id="hq-sd-plan">{t('title')}</h2></div>;
  const { load, step, pick, form, problem, done, busy } = p;
  if (load.state !== 'READY') return <article id="plan" className={styles.card} aria-labelledby="hq-sd-plan" data-hq-school-plan={load.state.toLowerCase()}>{head}
    <p className={styles.notice} role="status">{t(load.state === 'LOADING' ? 'loading' : load.state === 'DENIED' ? 'denied' : 'unavailable')}</p>
    {load.state === 'UNAVAILABLE' && <div className={styles.actions}><button type="button" className={styles.secondary} onClick={p.onRetry}>{t('retry')}</button></div>}
  </article>;
  const v = load.view, cur = v.current, school = v.schoolName;
  const record = (r: HqSchoolPlanRecord) => {
    const when = f.day.format(new Date(r.recordedAt)), who = r.recordedBy.displayName;
    return r.action === 'REMOVE' ? t('historyRemove', { date: when, who })
      : t('historyAssign', { date: when, plan: r.planName ?? '', price: price(r), start: r.startDate ? dayText(f, r.startDate) : '', who });
  };
  return <article id="plan" className={styles.card} aria-labelledby="hq-sd-plan" data-hq-school-plan="ready">{head}
    <p className={styles.meta}>{t('chargingOff')}</p>
    {!v.viewer.canManage && <p className={styles.meta}>{t('readOnly')}</p>}
    {step.step === 'VIEW' && <>
      <div><p className={styles.meta}>{t('current')}</p>
        {cur ? <><p className={own.big} data-plan-current="">{cur.planName} · {price(cur)}</p>
          {cur.startDate && <p className={styles.meta} data-plan-start="">{t('starts', { date: dayText(f, cur.startDate) })}</p>}
          <p className={styles.meta}><span className={styles.status} data-tone="ready">{t(cur.source === 'OFFER' ? 'sourceOFFER' : 'sourceCUSTOM')}</span>
            {cur.founder && <> <span className={styles.status} data-tone="waiting">{t('founder')}</span></>}</p></>
          : <p className={own.big} data-plan-current="none">{t('none')}</p>}
        <p className={styles.meta}>{t('onNow')}: {t(`onNow${v.onNow}` as SchoolPlanKey)}</p></div>
      {done && <p className={styles.outcome} data-tone="ok" role="status">{done}</p>}
      {problem && <p className={styles.outcome} data-tone="blocked" role="alert">{problem}</p>}
      {v.viewer.canManage && <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={p.onStart}>{t(cur ? 'change' : 'assign')}</button>
        {cur && <button type="button" className={styles.secondary} onClick={p.onStartRemove}>{t('remove')}</button>}
      </div>}
    </>}
    {step.step === 'PICK' && <form className={styles.form} onSubmit={(e) => { e.preventDefault(); p.onReview(); }} aria-label={t('pickTitle', { school })}>
      <h3>{t('pickTitle', { school })}</h3>
      <fieldset className={own.tiles}><legend>{t('pickOffers')}</legend>
        {v.offers.length === 0 && <p className={styles.meta} data-plan-no-offers="">{t('noOffers')} <a href="/hq/pricing-offers">{t('openOffers')}</a></p>}
        {v.offers.map(o => <label key={o.offerId} className={own.tile}>
          <input type="radio" name="plan" checked={pick?.kind === 'OFFER' && pick.offerId === o.offerId} onChange={() => p.onPick({ kind: 'OFFER', offerId: o.offerId })}/>
          <span className={own.tileName}>{o.displayName}</span><span className={own.tilePrice}>{price(o)}</span>
          {o.founder && <span className={own.tileNote}>{t('founder')}</span>}</label>)}
        <label className={own.tile}><input type="radio" name="plan" checked={pick?.kind === 'CUSTOM'} onChange={() => p.onPick({ kind: 'CUSTOM' })}/>
          <span className={own.tileName}>{t('customTile')}</span><span className={own.tileNote}>{t('customHelp')}</span></label>
      </fieldset>
      {pick?.kind === 'CUSTOM' && <div className={styles.pair}>
        <div><label htmlFor="plan-name">{t('name')}</label><input id="plan-name" value={form.name} maxLength={80} onChange={e => p.onForm({ name: e.target.value })}/></div>
        <div><label htmlFor="plan-price">{t('price')}</label><input id="plan-price" inputMode="decimal" value={form.price} placeholder="149" onChange={e => p.onForm({ price: e.target.value })}/></div>
        <div><label htmlFor="plan-interval">{t('interval')}</label><select id="plan-interval" value={form.interval} onChange={e => p.onForm({ interval: e.target.value === 'ANNUAL' ? 'ANNUAL' : 'MONTHLY' })}>
          <option value="MONTHLY">{t('MONTHLY')}</option><option value="ANNUAL">{t('ANNUAL')}</option></select></div>
        {centsFromDollars(form.price) === 0 && <div><label htmlFor="plan-free-until">{t('freeUntilLabel')}</label>
          <input id="plan-free-until" type="date" value={form.freeUntil} min={todayUtc()} onChange={e => p.onForm({ freeUntil: e.target.value })}/>
          <span className={styles.meta}>{t('freeUntilHelp')}</span></div>}
      </div>}
      <div className={styles.fields}><label htmlFor="plan-start">{t('startLabel')}</label>
        <input id="plan-start" type="date" required value={form.startDate} min={yearsAhead(-1)} max={yearsAhead(1)} onChange={e => p.onForm({ startDate: e.target.value })}/>
        <span className={styles.meta}>{t('startHelp')}</span></div>
      <div className={styles.fields}><label htmlFor="plan-note">{t('note')}</label><input id="plan-note" value={form.note} maxLength={300} onChange={e => p.onForm({ note: e.target.value })}/></div>
      {problem && <p className={styles.outcome} data-tone="blocked" role="alert">{problem}</p>}
      <div className={styles.actions}><button type="submit" className={styles.primary}>{t('review')}</button>
        <button type="button" className={styles.secondary} onClick={p.onCancel}>{t('cancel')}</button></div>
    </form>}
    {step.step === 'CONFIRM' && <div className={styles.outcome} data-tone="waiting" role="group" aria-label={t('confirmTitle')}>
      <p><strong>{t('confirmTitle')}</strong></p><p data-plan-confirm="">{t('confirmAssign', { school, plan: step.label, price: step.price, start: step.start })}</p>
      <p>{t('chargingOff')}</p>
      {problem && <p role="alert">{problem}</p>}
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={busy} onClick={p.onSave}>{busy ? t('saving') : t('save')}</button>
        <button type="button" className={styles.secondary} disabled={busy} onClick={p.onBack}>{t('back')}</button></div>
    </div>}
    {step.step === 'REMOVE' && <div className={styles.outcome} data-tone="blocked" role="group" aria-label={t('remove')}>
      <p data-plan-confirm="">{t('confirmRemove', { school })}</p>
      <div className={styles.fields}><label htmlFor="plan-remove-note">{t('note')}</label><input id="plan-remove-note" value={form.note} maxLength={300} onChange={e => p.onForm({ note: e.target.value })}/></div>
      {problem && <p role="alert">{problem}</p>}
      <div className={styles.actions}>
        <button type="button" className={styles.danger} disabled={busy} onClick={p.onRemove}>{busy ? t('removing') : t('remove')}</button>
        <button type="button" className={styles.secondary} disabled={busy} onClick={p.onCancel}>{t('cancel')}</button></div>
    </div>}
    {v.history.length > 0 && <details className={own.history}><summary>{t('history', { n: String(v.history.length) })}</summary>
      <ul>{v.history.map(r => <li key={r.revision}>{record(r)}</li>)}</ul></details>}
  </article>;
}

/** What a refused or unconfirmed command means for the person, and whether the same key must be kept for a retry. */
export function planProblem(error: unknown): { key: SchoolPlanKey; keepKey: boolean; reload: boolean } {
  const e = error instanceof PlanError ? error : new PlanError('UNKNOWN');
  // A reused key means the earlier press may have saved: show the latest plan with a fresh key.
  if (e.kind === 'CHANGED' || e.kind === 'KEY_REUSED') return { key: 'CHANGED', keepKey: false, reload: true };
  if (e.kind === 'REFUSED' && e.code && isSchoolPlanKey(`REFUSED_${e.code}`)) return { key: `REFUSED_${e.code}` as SchoolPlanKey, keepKey: false, reload: false };
  if (e.kind === 'DENIED') return { key: 'DENIED', keepKey: false, reload: false };
  return { key: 'UNKNOWN', keepKey: true, reload: false }; // same key: pressing again replays instead of saving twice
}

/**
 * HQ school plan (0676), shown on the school's HQ page. Shows the plan HQ gave this school and what it is on today; an HQ
 * owner can assign a published offer or a custom price, change it, or remove it, always through a confirm step. Records
 * only: charging stays off. The server decides authority, availability and every rule on each command.
 */
/** Which tile the picker starts on: the current plan when it is still offered, custom when nothing is published, else none. */
export function startingPick(view: HqSchoolPlanView): Pick {
  const cur = view.current;
  if (cur?.source === 'CUSTOM') return { kind: 'CUSTOM' };
  if (cur?.source === 'OFFER' && cur.offerId && view.offers.some(o => o.offerId === cur.offerId)) return { kind: 'OFFER', offerId: cur.offerId };
  return view.offers.length ? null : { kind: 'CUSTOM' };
}
/** Open the picker by itself (create-school step 2) only for a viewer the server says may manage, and only once. */
export const opensPickerNow = (startPicking: boolean, alreadyOpened: boolean, load: Load): boolean =>
  startPicking && !alreadyOpened && load.state === 'READY' && load.view.viewer.canManage;

export function HqSchoolPlanCard({ schoolId, language, formattingLocale, api = schoolPlanApi, startPicking = false }:
  { schoolId: string; language: string; formattingLocale: string; api?: SchoolPlanApi; startPicking?: boolean }): React.ReactElement {
  const t = useCallback<Text>((key, vars) => schoolPlanText(language, key, vars), [language]);
  const f = useMemo(() => fmt(formattingLocale), [formattingLocale]);
  const [load, setLoad] = useState<Load>({ state: 'LOADING' });
  const [reload, setReload] = useState(0);
  const [step, setStep] = useState<Step>({ step: 'VIEW' });
  const [pick, setPick] = useState<Pick>(null);
  const [form, setForm] = useState<PlanForm>({ name: '', price: '', interval: 'MONTHLY', freeUntil: '', startDate: todayUtc(), note: '' });
  const [problem, setProblem] = useState<string | null>(null); const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef<string | null>(null), mounted = useRef(true), generation = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => {
    const current = ++generation.current, owned = () => mounted.current && current === generation.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.read(schoolId, signal, owned).then((view) => { if (owned()) setLoad({ state: 'READY', view }); },
      (error) => { if (owned() && !abort.signal.aborted) setLoad({ state: error instanceof PlanError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, schoolId, reload]);

  const view = load.state === 'READY' ? load.view : null;
  const fresh = () => { setProblem(null); setDone(null); key.current = null; };
  const onStart = () => {
    if (!view) return; fresh(); const cur = view.current;
    setPick(startingPick(view));
    if (cur?.source === 'CUSTOM') setForm({ name: cur.planName ?? '', price: String((cur.priceMinor ?? 0) / 100),
      interval: cur.billingInterval === 'ANNUAL' ? 'ANNUAL' : 'MONTHLY', freeUntil: cur.freeUntil ?? '', startDate: todayUtc(), note: '' });
    else setForm(x => ({ ...x, startDate: todayUtc(), note: '' }));
    setStep({ step: 'PICK' });
  };
  const opened = useRef(false);
  useEffect(() => { if (opensPickerNow(startPicking, opened.current, load)) { opened.current = true; onStart(); } });
  const onReview = () => {
    if (!view) return; setProblem(null);
    const r = reviewChoice(view, pick, form, t, f);
    if (!r.ok) { setProblem(t(r.problem)); return; }
    key.current = null; setStep({ step: 'CONFIRM', choice: r.choice, startDate: r.startDate, label: r.label, price: r.price, start: r.start });
  };
  const submit = async (work: (k: string, signal: AbortSignal, owned: () => boolean) => Promise<unknown>, okText: string) => {
    if (busy) return;
    key.current ??= crypto.randomUUID();
    const current = generation.current, owned = () => mounted.current && current === generation.current;
    setBusy(true); setProblem(null);
    try {
      await work(key.current, AbortSignal.timeout(15000), owned); if (!owned()) return;
      key.current = null; setDone(okText); setStep({ step: 'VIEW' }); setReload(n => n + 1);
    } catch (error) {
      if (!owned()) return;
      const why = planProblem(error); setProblem(t(why.key));
      if (!why.keepKey) key.current = null;
      if (why.reload) { setStep({ step: 'VIEW' }); setReload(n => n + 1); }
    } finally { if (mounted.current) setBusy(false); }
  };
  const note = () => form.note.trim() || null;
  return <PlanCardView language={language} formattingLocale={formattingLocale} load={load} step={step} pick={pick} form={form} problem={problem} done={done} busy={busy}
    onRetry={() => setReload(n => n + 1)} onStart={onStart} onStartRemove={() => { fresh(); setForm(x => ({ ...x, note: '' })); setStep({ step: 'REMOVE' }); }}
    onPick={setPick} onForm={(patch) => setForm(x => ({ ...x, ...patch }))} onReview={onReview}
    onSave={() => { if (view && step.step === 'CONFIRM') void submit((k, s, o) => api.assign(schoolId, { expectedRevision: view.revision, plan: step.choice, startDate: step.startDate, note: note() }, k, s, o), t('saved')); }}
    onRemove={() => { if (view) void submit((k, s, o) => api.remove(schoolId, { expectedRevision: view.revision, note: note() }, k, s, o), t('removed')); }}
    onBack={() => { setProblem(null); key.current = null; setStep({ step: 'PICK' }); }}
    onCancel={() => { setProblem(null); key.current = null; setStep({ step: 'VIEW' }); }}/>;
}
