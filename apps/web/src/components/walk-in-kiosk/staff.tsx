'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  validateWalkInSettingsInput, WALKIN_DESK_METHODS, WALKIN_LIMITS, WALKIN_OFFER_KINDS,
  type WalkInDeskMethod, type WalkInOfferKind, type WalkInOverview, type WalkInSettings, type WalkInSettingsInput, type WalkInSettingsRead,
  type WalkInText, type WalkInVisit, type WalkInVisitDetail,
} from '@hon/contracts';
import { DEFAULT_HON_INTERFACE_THEME } from '@hon/design-system';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { walkInCopy, walkInPrice, type WalkInKey } from './copy';
import { handOffWalkInTablet } from './handoff';
import { keepWalkInForRetry, signOutThisBrowser, walkInApi, WalkInError, type WalkInApi, type WalkInErrorKind, type WalkInScope } from './http';
import { strokePath } from './signature-pad';
import styles from './walk-in-kiosk.module.css';

export type Read<T> = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; read: T };
export type Outcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | 'SIGN_OUT_FAILED' | WalkInErrorKind }>;
type T = (key: WalkInKey, vars?: Readonly<Record<string, string | number>>) => string;

export type OfferDraft = Readonly<{ key: string; kind: WalkInOfferKind; name: WalkInText; description: WalkInText; price: string }>;
export type SettingsDraft = Readonly<{
  enabled: boolean; waiver: WalkInText; emergencyRequired: boolean; pipelineId: string; pipelineStageId: string; offers: readonly OfferDraft[]; thankYou: WalkInText;
}>;
const blank = (en = ''): WalkInText => ({ en, ko: '', es: '' });
const full = (t: WalkInText): WalkInText => ({ en: t.en, ko: t.ko ?? '', es: t.es ?? '' });
export function settingsDraft(read: WalkInSettingsRead): SettingsDraft {
  const s = read.settings, first = read.pipelines[0];
  if (!s) {
    return { enabled: true, waiver: blank(), emergencyRequired: false, pipelineId: first?.pipelineId ?? '', pipelineStageId: first?.stages[0]?.stageId ?? '',
      offers: [{ key: 'free-trial', kind: 'TRIAL', name: blank('Free trial class'), description: blank(), price: '0' },
        { key: 'day-pass', kind: 'DAY_PASS', name: blank('Day pass'), description: blank(), price: '25.00' }], thankYou: blank() };
  }
  return { enabled: s.enabled, waiver: full(s.waiver), emergencyRequired: s.emergencyRequired, pipelineId: s.pipelineId, pipelineStageId: s.pipelineStageId,
    offers: s.offers.map(o => ({ key: o.key, kind: o.kind, name: full(o.name), description: full(o.description), price: (o.priceMinor / 100).toFixed(2) })),
    thankYou: full(s.thankYou) };
}
/** Dollars as typed ("25", "25.5", "$25.00") to whole cents, or NaN. */
export function priceMinor(value: string): number {
  const v = value.trim().replace(/^\$/, '');
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(v)) return Number.NaN;
  const [whole, cents = ''] = v.split('.');
  return Number(whole) * 100 + Number(cents.padEnd(2, '0'));
}
const tidy = (t: WalkInText, multiline = false): WalkInText => {
  const clean = (v: string | undefined) => (multiline ? (v ?? '').replace(/\r\n/g, '\n') : (v ?? '')).trim();
  return { en: clean(t.en), ...(clean(t.ko) ? { ko: clean(t.ko) } : {}), ...(clean(t.es) ? { es: clean(t.es) } : {}) };
};
/** The save body for the draft; it throws when anything is not acceptable. The server checks it all again. */
export function settingsBody(draft: SettingsDraft, current: WalkInSettings | null): WalkInSettingsInput {
  return validateWalkInSettingsInput({
    expectedVersion: current?.version ?? 0, enabled: draft.enabled, waiver: tidy(draft.waiver, true), emergencyRequired: draft.emergencyRequired,
    pipelineId: draft.pipelineId, pipelineStageId: draft.pipelineStageId, thankYou: tidy(draft.thankYou),
    offers: draft.offers.map(o => ({ key: o.key, kind: o.kind, name: tidy(o.name), description: tidy(o.description), priceMinor: priceMinor(o.price) })),
  });
}
export function nextOfferKey(offers: readonly OfferDraft[]): string {
  for (let n = 1; ; n += 1) if (!offers.some(o => o.key === `offer-${n}`)) return `offer-${n}`;
}

/** The lead in the CRM journey for this school; the journey reads it again with its own authorization. */
export const leadHref = (scope: WalkInScope | null, leadId: string) =>
  scope ? `/staff/crm/journey?${new URLSearchParams({ organizationId: scope.organizationId, schoolId: scope.schoolId, leadId })}` : '/staff/crm/journey';
const when = (language: string, iso: string) => new Date(iso).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' });
const tagFor = (v: WalkInVisit) => v.paymentState === 'PAY_AT_DESK' ? `${styles.tag} ${styles.tagDue}` : v.paymentState === 'PAID_AT_DESK' ? `${styles.tag} ${styles.tagPaid}` : styles.tag;

function TextFields({ t, label, value, onChange, multiline, max }: { t: T; label: string; value: WalkInText; onChange: (v: WalkInText) => void; multiline?: boolean; max: number }): React.ReactElement {
  const Field = multiline ? 'textarea' : 'input';
  return <fieldset className={styles.form}><legend>{label}</legend>
    {(['en', 'ko', 'es'] as const).map(l => <label key={l} lang={l}>{t(l === 'en' ? 'sEn' : l === 'ko' ? 'sKo' : 'sEs')}
      <Field maxLength={max} value={value[l] ?? ''} onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange({ ...value, [l]: e.target.value })}/></label>)}
  </fieldset>;
}

export type WalkInStaffViewProps = Readonly<{
  language: string; waiting: boolean; hasSchool: boolean; overview: Read<WalkInOverview>; settings: Read<WalkInSettingsRead> | null; draft: SettingsDraft | null;
  detail: Read<WalkInVisitDetail> | null; outcome: Outcome; busy: boolean; label: string; hours: number; scope?: WalkInScope | null;
  onLabel?: (v: string) => void; onHours?: (v: number) => void; onStart?: () => void; onEnd?: (deviceId: string, version: number) => void;
  onPaid?: (visitId: string, version: number, method: WalkInDeskMethod) => void; onOpen?: (visitId: string | null) => void; onDraft?: (d: SettingsDraft) => void;
  onSave?: () => void; onRefresh?: () => void;
}>;

/** The staff page: start a tablet, see walk-ins, mark paid at the desk, read a signed waiver, and (owner) set up the kiosk. */
export function WalkInStaffView(p: WalkInStaffViewProps): React.ReactElement {
  const t: T = (key, vars) => walkInCopy(p.language, key, vars);
  const head = <header><h1>{t('pageTitle')}</h1><p className={styles.meta}>{t('pageIntro')}</p></header>;
  if (p.waiting) return <main className={styles.page}>{head}<p role="status">{t('waiting')}</p></main>;
  if (!p.hasSchool) return <main className={styles.page}>{head}<p role="status">{t('noSchool')}</p></main>;
  if (p.overview.state !== 'READY') {
    return <main className={styles.page}>{head}<p role={p.overview.state === 'LOADING' ? 'status' : 'alert'}>{t(p.overview.state === 'LOADING' ? 'loading' : p.overview.state === 'DENIED' ? 'denied' : 'unavailable')}</p></main>;
  }
  const o = p.overview.read;
  const outcome = p.outcome && p.outcome.kind !== 'SENDING' ? <p className={styles.notice} role={p.outcome.kind === 'DONE' ? 'status' : 'alert'} data-testid="walkin-outcome">
    {p.outcome.kind === 'DONE' ? t('saved') : p.outcome.kind === 'SIGN_OUT_FAILED' ? t('signOutFailed') : t(`o${p.outcome.kind}` as WalkInKey)}</p> : null;
  const ready = o.configured && o.enabled;
  const start = <section className={styles.card} aria-labelledby="walkin-start"><h2 id="walkin-start">{t('startTitle')}</h2>
    {!o.configured ? <p className={styles.meta}>{t('notSetUp')} {t(o.canManage ? 'notSetUpOwner' : 'notSetUpStaff')}</p> : !o.enabled ? <p className={styles.meta}>{t('isOff')}</p> : null}
    <p className={styles.meta}>{t('startHelp')}</p>
    <div className={styles.form}>
      <label>{t('label')}<input value={p.label} maxLength={WALKIN_LIMITS.label} onChange={e => p.onLabel?.(e.target.value)}/></label>
      <label>{t('hours')}<select value={p.hours} onChange={e => p.onHours?.(Number(e.target.value))}>{[4, 8, 12].map(h => <option key={h} value={h}>{t('hoursN', { n: h })}</option>)}</select></label>
    </div>
    <div className={styles.row}><button type="button" className={styles.buttonPrimary} disabled={!ready || p.busy || !p.label.trim()} onClick={() => p.onStart?.()}>{p.busy ? t('starting') : t('start')}</button></div>
  </section>;
  const tablets = <section className={styles.card} aria-labelledby="walkin-tablets"><h2 id="walkin-tablets">{t('tabletsTitle')}</h2>
    {o.devices.length === 0 ? <p className={styles.meta}>{t('noTablets')}</p> : <ul className={styles.list}>{o.devices.map(d => <li key={d.deviceId}>
      <div className={styles.row}><strong>{d.label}</strong><span className={styles.tag}>{d.live ? t('live', { at: when(p.language, d.endsAt) }) : t('ended')}</span></div>
      {d.startedBy ? <p className={styles.meta}>{t('startedBy', { name: d.startedBy })}</p> : null}
      {d.live ? <div className={styles.row}><button type="button" className={styles.button} disabled={p.busy} onClick={() => p.onEnd?.(d.deviceId, d.version)}>{t('endTablet')}</button></div> : null}
    </li>)}</ul>}</section>;
  const visits = <section className={styles.card} aria-labelledby="walkin-visits"><div className={styles.row}><h2 id="walkin-visits">{t('visitsTitle')}</h2>
    <button type="button" className={styles.button} onClick={() => p.onRefresh?.()}>{t('refresh')}</button></div>
    {o.visits.length === 0 ? <p className={styles.meta}>{t('noVisits')}</p> : <ul className={styles.list} data-testid="walkin-visits">{o.visits.map(v => <li key={v.visitId}>
      <div className={styles.row}><strong>{v.participants.map(x => `${x.givenName} ${x.familyName}`).join(', ') || `${v.contact.givenName} ${v.contact.familyName}`}</strong>
        <span className={tagFor(v)}>{t(`p${v.paymentState}` as WalkInKey)}</span></div>
      <p className={styles.meta}>{t(`k${v.offer.kind}` as WalkInKey)}: {v.offer.name} · {v.offer.priceMinor ? walkInPrice(p.language, v.offer.priceMinor) : t('pFREE')}
        {v.waiverSignedAt ? ` · ${t('waiverSigned', { at: when(p.language, v.waiverSignedAt) })}` : ''}</p>
      <p className={styles.meta}>{[v.contact.mobile, v.contact.email].filter(Boolean).join(' · ')}{v.marketingOptIn ? ` · ${t('optIn')}` : ''}</p>
      <div className={styles.row}>
        <a className={styles.button} href={leadHref(p.scope ?? null, v.leadId)}>{t('openLead')}</a>
        <button type="button" className={styles.button} onClick={() => p.onOpen?.(v.visitId)}>{t('viewWaiver')}</button>
        {v.paymentState === 'PAY_AT_DESK' ? WALKIN_DESK_METHODS.map(m => <button type="button" key={m} className={styles.button} disabled={p.busy}
          onClick={() => p.onPaid?.(v.visitId, v.version, m)}>{t('markPaid')}: {t(`m${m}` as WalkInKey)}</button>) : null}
      </div>
    </li>)}</ul>}</section>;
  const detail = p.detail ? <section className={styles.card} aria-labelledby="walkin-detail" data-testid="walkin-detail"><h2 id="walkin-detail">{t('viewWaiver')}</h2>
    {p.detail.state !== 'READY' ? <p role="status">{t(p.detail.state === 'LOADING' ? 'loading' : p.detail.state === 'DENIED' ? 'denied' : 'unavailable')}</p> : <>
      <p className={styles.meta}>{t('waiverVersion', { n: p.detail.read.waiver.version, language: p.detail.read.waiver.language.toUpperCase() })} · {when(p.language, p.detail.read.waiver.signedAt)}</p>
      <div className={styles.signed}>{p.detail.read.waiver.text}</div>
      <p>{t('signedBy', { name: p.detail.read.waiver.signerName, relationship: t(`r${p.detail.read.waiver.relationship}` as WalkInKey) })}</p>
      <svg className={styles.signature} viewBox="0 0 1000 1000" preserveAspectRatio="none" role="img" aria-label={p.detail.read.waiver.signerName}>
        <path d={strokePath(p.detail.read.waiver.strokes)} fill="none" stroke="currentColor" strokeWidth={4} vectorEffect="non-scaling-stroke"/></svg>
      <ul className={styles.list}>{p.detail.read.visit.participants.map((x, i) => <li key={i}>{x.givenName} {x.familyName} · {x.birthDate} · {t(x.isMinor ? 'childTag' : 'adultTag')}</li>)}</ul>
      {p.detail.read.visit.emergencyName ? <p className={styles.meta}>{t('emergency', { name: p.detail.read.visit.emergencyName, phone: p.detail.read.visit.emergencyPhone })}</p> : null}
    </>}
    <div className={`${styles.row} ${styles.noPrint}`}><button type="button" className={styles.button} onClick={() => globalThis.print?.()}>{t('print')}</button>
      <button type="button" className={styles.button} onClick={() => p.onOpen?.(null)}>{t('closeWaiver')}</button></div></section> : null;
  const settings = !o.canManage ? null : <section className={styles.card} aria-labelledby="walkin-settings"><h2 id="walkin-settings">{t('settingsTitle')}</h2>
    {!p.settings || p.settings.state !== 'READY' || !p.draft ? <p role="status">{t(!p.settings || p.settings.state === 'LOADING' ? 'loading' : p.settings.state === 'DENIED' ? 'settingsOwnerOnly' : 'unavailable')}</p> : (() => {
      const d = p.draft, set = (patch: Partial<SettingsDraft>) => p.onDraft?.({ ...d, ...patch }), pipes = p.settings.read.pipelines;
      const stages = pipes.find(x => x.pipelineId === d.pipelineId)?.stages ?? [];
      const offer = (i: number, patch: Partial<OfferDraft>) => set({ offers: d.offers.map((x, j) => j === i ? { ...x, ...patch } : x) });
      return <form className={styles.form} onSubmit={e => { e.preventDefault(); p.onSave?.(); }} data-testid="walkin-settings">
        <label className={styles.checkRow}><input type="checkbox" checked={d.enabled} onChange={e => set({ enabled: e.target.checked })}/>{t('sEnabled')}</label>
        <TextFields t={t} label={t('sWaiver')} value={d.waiver} multiline max={WALKIN_LIMITS.waiver} onChange={waiver => set({ waiver })}/>
        <p className={styles.meta}>{t('sWaiverHelp')} {t('sWaiverChange')}</p>
        <label className={styles.checkRow}><input type="checkbox" checked={d.emergencyRequired} onChange={e => set({ emergencyRequired: e.target.checked })}/>{t('sEmergency')}</label>
        <div className={styles.row}>
          <label>{t('sPipeline')}<select value={d.pipelineId} onChange={e => set({ pipelineId: e.target.value, pipelineStageId: pipes.find(x => x.pipelineId === e.target.value)?.stages[0]?.stageId ?? '' })}>
            {pipes.map(x => <option key={x.pipelineId} value={x.pipelineId}>{x.name}</option>)}</select></label>
          <label>{t('sStage')}<select value={d.pipelineStageId} onChange={e => set({ pipelineStageId: e.target.value })}>{stages.map(x => <option key={x.stageId} value={x.stageId}>{x.name}</option>)}</select></label>
        </div>
        <fieldset className={styles.form}><legend>{t('sOffers')}</legend>{d.offers.map((x, i) => <div key={x.key} className={styles.offerEdit}>
          <label>{t('sOfferName')}<input value={x.name.en} maxLength={WALKIN_LIMITS.offerName} onChange={e => offer(i, { name: { ...x.name, en: e.target.value } })}/></label>
          <label lang="ko">{t('sKo')}<input value={x.name.ko ?? ''} maxLength={WALKIN_LIMITS.offerName} onChange={e => offer(i, { name: { ...x.name, ko: e.target.value } })}/></label>
          <label lang="es">{t('sEs')}<input value={x.name.es ?? ''} maxLength={WALKIN_LIMITS.offerName} onChange={e => offer(i, { name: { ...x.name, es: e.target.value } })}/></label>
          <label>{t('sOfferKind')}<select value={x.kind} onChange={e => offer(i, { kind: e.target.value as WalkInOfferKind })}>{WALKIN_OFFER_KINDS.map(k => <option key={k} value={k}>{t(`k${k}` as WalkInKey)}</option>)}</select></label>
          <label>{t('sPrice')}<input inputMode="decimal" value={x.price} onChange={e => offer(i, { price: e.target.value })}/></label>
          <label>{t('sOfferDescription')}<input value={x.description.en} maxLength={WALKIN_LIMITS.offerDescription} onChange={e => offer(i, { description: { ...x.description, en: e.target.value } })}/></label>
          {d.offers.length > 1 ? <button type="button" className={styles.button} onClick={() => set({ offers: d.offers.filter((_, j) => j !== i) })}>{t('sRemove')}</button> : null}
        </div>)}
        {d.offers.length < WALKIN_LIMITS.offers ? <button type="button" className={styles.button} onClick={() => set({ offers: [...d.offers, { key: nextOfferKey(d.offers), kind: 'TRIAL', name: blank(), description: blank(), price: '0' }] })}>{t('sAddOffer')}</button> : null}
        </fieldset>
        <TextFields t={t} label={t('sThankYou')} value={d.thankYou} max={WALKIN_LIMITS.thankYou} onChange={thankYou => set({ thankYou })}/>
        <div className={styles.row}><button type="submit" className={styles.buttonPrimary} disabled={p.busy}>{p.busy ? t('saving') : t('save')}</button></div>
        <p className={styles.meta}>{t('olderTools')}: <a href="/staff/classpass">{t('classPassLink')}</a> · <a href="/staff/kiosk">{t('handoffLink')}</a></p>
      </form>;
    })()}</section>;
  return <main className={styles.page} data-testid="walkin-staff">{head}{outcome}
    <div className={styles.cards}>{start}{tablets}</div>{detail}{visits}{settings}</main>;
}

const readState = (error: unknown): { state: 'DENIED' | 'UNAVAILABLE' } => ({ state: error instanceof WalkInError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' });

/** Controller. Every permission is decided by the API for the verified school; this page only asks. */
export function WalkInKioskPage({ api = walkInApi, signOut = signOutThisBrowser }: { api?: WalkInApi; signOut?: () => Promise<boolean> }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const router = useRouter();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const scope: WalkInScope | null = selection ? { organizationId: selection.organizationId, schoolId: selection.schoolId } : null;
  const scopeKey = scope ? `${scope.organizationId}:${scope.schoolId}` : null;
  const [overview, setOverview] = useState<Read<WalkInOverview>>({ state: 'LOADING' });
  const [settings, setSettings] = useState<Read<WalkInSettingsRead> | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [detail, setDetail] = useState<Read<WalkInVisitDetail> | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [label, setLabel] = useState('Front desk');
  const [hours, setHours] = useState(8);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0), mounted = useRef(false), busy = useRef(false);
  const kept = useRef<{ action: string; key: string } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => {
    const reset = () => { generation.current++; kept.current = null; setOverview({ state: 'LOADING' }); setSettings(null); setDraft(null); setDetail(null); setOutcome(null); };
    globalThis.addEventListener?.(HON_SESSION_INVALIDATED_EVENT, reset); globalThis.addEventListener?.(HON_SCHOOL_CONTEXT_CHANGED_EVENT, reset);
    return () => { globalThis.removeEventListener?.(HON_SESSION_INVALIDATED_EVENT, reset); globalThis.removeEventListener?.(HON_SCHOOL_CONTEXT_CHANGED_EVENT, reset); };
  }, []);

  useEffect(() => {
    if (!scope) return;
    const current = ++generation.current, abort = new AbortController();
    const owned = () => mounted.current && current === generation.current;
    api.overview(scope, abort.signal, owned).then(read => {
      if (!owned()) return;
      setOverview({ state: 'READY', read });
      if (read.canManage) {
        api.settings(scope, abort.signal, owned).then(s => { if (owned()) { setSettings({ state: 'READY', read: s }); setDraft(d => d ?? settingsDraft(s)); } },
          error => { if (owned() && !abort.signal.aborted) setSettings(readState(error)); });
      }
    }, error => { if (owned() && !abort.signal.aborted) setOverview(readState(error)); });
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, scopeKey, refresh]);

  /** One command at a time; an unknown result keeps its key so the identical request is sent again. */
  const run = useCallback(async <R,>(action: string, send: (key: string, signal: AbortSignal, owned: () => boolean) => Promise<R>): Promise<R | null> => {
    if (busy.current || !scope) return null;
    busy.current = true; setOutcome({ kind: 'SENDING' });
    const key = kept.current?.action === action ? kept.current.key : globalThis.crypto.randomUUID();
    kept.current = { action, key };
    const owned = () => mounted.current;
    try {
      const result = await send(key, new AbortController().signal, owned);
      kept.current = null; if (mounted.current) setOutcome({ kind: 'DONE' });
      return result;
    } catch (error) {
      if (!keepWalkInForRetry(error)) kept.current = null;
      if (mounted.current) setOutcome({ kind: error instanceof WalkInError ? error.kind : 'UNKNOWN' });
      return null;
    } finally { busy.current = false; }
  }, [scope]);

  const onStart = async () => {
    if (!scope) return;
    const started = await run(`start:${label}:${hours}`, (key, signal, owned) => api.start(scope, { label: label.trim(), hours }, key, signal, owned));
    if (!started) return;
    if (!started.token) { setOutcome({ kind: 'UNKNOWN' }); setRefresh(n => n + 1); return; }
    // Sign this browser out first, so the visitor screen can never lead back into staff pages.
    if (!(await signOut())) { setOutcome({ kind: 'SIGN_OUT_FAILED' }); setRefresh(n => n + 1); return; }
    handOffWalkInTablet({ token: started.token, mode: shell.mode ?? DEFAULT_HON_INTERFACE_THEME, language: preferences.language });
    router.push('/kiosk/walk-in');
  };
  const reload = () => setRefresh(n => n + 1);
  return <WalkInStaffView language={preferences.language} waiting={shell.phase !== 'READY' && shell.phase !== 'IDLE'} hasSchool={!!scope} overview={overview} settings={settings}
    draft={draft} detail={detail} outcome={outcome} busy={outcome?.kind === 'SENDING'} label={label} hours={hours} scope={scope}
    onLabel={setLabel} onHours={setHours} onStart={() => { void onStart(); }} onRefresh={reload} onDraft={setDraft}
    onEnd={(deviceId, version) => { if (scope) void run(`end:${deviceId}:${version}`, (k, s, o) => api.end(scope, deviceId, version, k, s, o)).then(r => { if (r) reload(); }); }}
    onPaid={(visitId, version, method) => { if (scope) void run(`paid:${visitId}:${version}:${method}`, (k, s, o) => api.deskPaid(scope, visitId, { expectedVersion: version, method }, k, s, o)).then(r => { if (r) reload(); }); }}
    onOpen={visitId => {
      if (!visitId || !scope) { setDetail(null); return; }
      setDetail({ state: 'LOADING' });
      api.visit(scope, visitId, new AbortController().signal, () => mounted.current).then(read => { if (mounted.current) setDetail({ state: 'READY', read }); },
        error => { if (mounted.current) setDetail(readState(error)); });
    }}
    onSave={() => {
      if (!scope || !draft || settings?.state !== 'READY') return;
      let body: WalkInSettingsInput;
      try { body = settingsBody(draft, settings.read.settings); } catch { setOutcome({ kind: 'INVALID' }); return; }
      void run(`settings:${JSON.stringify(body)}`, (k, s, o) => api.saveSettings(scope, body, k, s, o)).then(r => {
        if (r) { setSettings({ state: 'READY', read: { ...settings.read, settings: r.settings } }); setDraft(settingsDraft({ ...settings.read, settings: r.settings })); reload(); }
      });
    }}/>;
}
