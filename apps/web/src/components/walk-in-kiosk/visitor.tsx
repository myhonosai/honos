'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  schoolBrandingColorOk, schoolBrandingImageUrlOk, validateWalkInVisitInput, walkInText, WALKIN_HEARD_FROM, WALKIN_LANGUAGES,
  type WalkInHeardFrom, type WalkInLanguage, type WalkInRelationship, type WalkInStroke, type WalkInTerminal, type WalkInVisitInput, type WalkInVisitOutcome,
} from '@hon/contracts';
import type { HonInterfaceTheme } from '@hon/design-system';
import { walkInCopy, walkInPrice, type WalkInKey } from './copy';
import { takeWalkInTablet } from './handoff';
import { walkInTabletApi, type WalkInTabletApi } from './http';
import { SignaturePad, signedStrokes } from './signature-pad';
import styles from './walk-in-kiosk.module.css';

export type Who = 'ME' | 'KIDS' | 'BOTH';
export type Step = 'WELCOME' | 'WHO' | 'DETAILS' | 'WAIVER' | 'OFFER' | 'DONE';
export type Person = Readonly<{ givenName: string; familyName: string; birthDate: string }>;
export type VisitDraft = Readonly<{
  who: Who; contact: Person & Readonly<{ email: string; mobile: string }>; children: readonly Person[]; relationship: WalkInRelationship;
  emergencyName: string; emergencyPhone: string; heardFrom: WalkInHeardFrom; marketingOptIn: boolean; offerKey: string;
  signerName: string; strokes: readonly WalkInStroke[]; agreed: boolean;
}>;
const emptyPerson: Person = { givenName: '', familyName: '', birthDate: '' };
export const emptyDraft = (): VisitDraft => ({
  who: 'ME', contact: { ...emptyPerson, email: '', mobile: '' }, children: [], relationship: 'PARENT', emergencyName: '', emergencyPhone: '',
  heardFrom: '', marketingOptIn: false, offerKey: '', signerName: '', strokes: [], agreed: false,
});
export const RESET_SECONDS = 20;
export const IDLE_MS = 120_000;
const LANGUAGE_NAMES: Record<WalkInLanguage, string> = { en: 'English', ko: '한국어', es: 'Español' };

/** A phone typed the way people type it, as +E.164. US 10-digit numbers get +1; anything else must already start with +. */
export function normalizeMobile(value: string): string {
  const v = value.trim();
  if (!v) return '';
  const digits = v.replace(/[\s().-]/g, '');
  if (/^\+[1-9][0-9]{6,14}$/.test(digits)) return digits;
  if (/^[2-9][0-9]{9}$/.test(digits)) return `+1${digits}`;
  if (/^1[2-9][0-9]{9}$/.test(digits)) return `+${digits}`;
  return v;
}
/** The device's calendar date; the server checks every birth date against the school's own date again. */
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** The request body for the whole form. Throws when anything is not acceptable; the server checks it all again. */
export function visitBody(d: VisitDraft, terminal: WalkInTerminal, language: WalkInLanguage, today: string): WalkInVisitInput {
  const adultTrains = d.who !== 'KIDS', kids = d.who !== 'ME';
  if (!terminal.offers.some(o => o.key === d.offerKey)) throw new Error('Choose one of this school’s offers.');
  const trim = (p: Person) => ({ givenName: p.givenName.trim(), familyName: p.familyName.trim(), birthDate: p.birthDate });
  return validateWalkInVisitInput({
    settingsVersion: terminal.settingsVersion, language,
    contact: { givenName: d.contact.givenName.trim(), familyName: d.contact.familyName.trim(), email: d.contact.email.trim(), mobile: normalizeMobile(d.contact.mobile),
      birthDate: adultTrains ? d.contact.birthDate : null, isParticipant: adultTrains, adultConfirmed: true },
    children: kids ? d.children.map(trim) : [], relationship: kids ? d.relationship : null,
    emergency: { name: d.emergencyName.trim(), phone: normalizeMobile(d.emergencyPhone) }, heardFrom: d.heardFrom, marketingOptIn: d.marketingOptIn,
    offerKey: d.offerKey, waiver: { accepted: d.agreed, signerName: d.signerName.trim(), strokes: signedStrokes(d.strokes) }, website: '',
  }, today);
}
/** Whether the details step is complete: the whole form with a stand-in waiver and offer must pass. */
export function detailsOk(d: VisitDraft, terminal: WalkInTerminal, language: WalkInLanguage, today: string): boolean {
  try {
    visitBody({ ...d, agreed: true, signerName: 'Signer', strokes: [[[1, 1], [2, 2]]], offerKey: terminal.offers[0]?.key ?? '' }, terminal, language, today);
    return true;
  } catch { return false; }
}
export function waiverOk(d: VisitDraft): boolean {
  return d.agreed && d.signerName.trim().length > 0 && signedStrokes(d.strokes).length > 0;
}
/** The first name the done screen thanks: the adult contact's. */
export const doneName = (o: WalkInVisitOutcome, d: VisitDraft) => o.firstName ?? d.contact.givenName.trim();

export type VisitorRead = 'NOT_STARTED' | 'LOADING' | 'CLOSED' | 'UNAVAILABLE' | WalkInTerminal;
export type VisitorViewProps = Readonly<{
  read: VisitorRead; mode: HonInterfaceTheme; language: WalkInLanguage; step: Step; draft: VisitDraft; today: string; tried: boolean;
  sending: boolean; outcome: WalkInVisitOutcome | null; countdown: number;
  onLanguage?: (language: WalkInLanguage) => void; onStep?: (step: Step) => void; onDraft?: (draft: VisitDraft) => void;
  onTried?: () => void; onSend?: () => void; onReset?: () => void;
}>;
export const themeClass = (mode: HonInterfaceTheme) => mode === 'big-button' ? styles.bigButton : mode === 'classic' ? styles.classic : styles.modern;

function PersonFields({ t, prefix, person, onChange, tried, birthRequired }: {
  t: (k: WalkInKey, v?: Record<string, string | number>) => string; prefix: string; person: Person; onChange: (p: Person) => void; tried: boolean; birthRequired: boolean;
}): React.ReactElement {
  const bad = (v: string) => tried && !v.trim() ? 'true' : undefined;
  return <div className={styles.fields}>
    <label>{t('vFirst')}<input name={`${prefix}-first`} autoComplete="off" maxLength={60} value={person.givenName} aria-invalid={bad(person.givenName)} onChange={e => onChange({ ...person, givenName: e.target.value })}/></label>
    <label>{t('vLast')}<input name={`${prefix}-last`} autoComplete="off" maxLength={60} value={person.familyName} aria-invalid={bad(person.familyName)} onChange={e => onChange({ ...person, familyName: e.target.value })}/></label>
    {birthRequired ? <label>{t('vBirth')}<input type="date" name={`${prefix}-birth`} value={person.birthDate} aria-invalid={bad(person.birthDate)} onChange={e => onChange({ ...person, birthDate: e.target.value })}/></label> : null}
  </div>;
}

/** The visitor screen. No menu, no search, no names of other people: only this visitor's own form. */
export function WalkInVisitorView(p: VisitorViewProps): React.ReactElement {
  const t = (key: WalkInKey, vars?: Record<string, string | number>) => walkInCopy(p.language, key, vars);
  const shell = (body: React.ReactNode, accent = '#1d4ed8') => <main className={`${styles.kiosk} ${themeClass(p.mode)}`} style={{ ['--walkin-accent' as string]: accent }}
    lang={p.language} data-testid="walkin-visitor">{body}</main>;
  const r = p.read;
  if (r === 'NOT_STARTED') return shell(<section className={styles.center}><p role="status">{t('vNotStarted')}</p><a className={styles.ghost} href="/auth/login">{t('vSignIn')}</a></section>);
  if (r === 'LOADING') return shell(<section className={styles.center}><p role="status">{walkInCopy(p.language, 'loading')}</p></section>);
  if (r === 'CLOSED' || r === 'UNAVAILABLE') return shell(<section className={styles.center}><p role="alert">{t(r === 'CLOSED' ? 'vClosed' : 'vUnavailable')}</p></section>);
  const accent = r.branding.accentColor !== null && schoolBrandingColorOk(r.branding.accentColor) ? r.branding.accentColor : '#1d4ed8';
  const logo = r.branding.logoUrl !== null && schoolBrandingImageUrlOk(r.branding.logoUrl) ? r.branding.logoUrl : null;
  const d = p.draft, set = (patch: Partial<VisitDraft>) => p.onDraft?.({ ...d, ...patch });
  const go = (step: Step) => p.onStep?.(step);
  const head = <header className={styles.brand}>{logo ? <img src={logo} alt="" referrerPolicy="no-referrer"/> : null}<span>{r.schoolName}</span></header>;
  const nav = (back: Step | null, next: React.ReactNode) => <div className={styles.nav}>
    {back ? <button type="button" className={styles.ghost} onClick={() => go(back)}>{t('vBack')}</button> : <span/>}{next}</div>;

  if (p.step === 'WELCOME') return shell(<>{head}<section className={styles.center}>
    <h1>{t('vWelcome')}</h1><p className={styles.lead}>{t('vWelcomeHelp')}</p>
    <div className={styles.languages} role="group" aria-label={t('vLanguage')}>
      {WALKIN_LANGUAGES.map(l => <button type="button" key={l} lang={l} aria-pressed={p.language === l} onClick={() => p.onLanguage?.(l)}>{LANGUAGE_NAMES[l]}</button>)}</div>
    <button type="button" className={styles.primary} onClick={() => go('WHO')}>{t('vBegin')}</button></section></>, accent);

  if (p.step === 'WHO') return shell(<>{head}<section className={styles.step}><h1>{t('vWhoTitle')}</h1>
    <div className={styles.choices}>{(['ME', 'KIDS', 'BOTH'] as const).map(w => <button type="button" key={w} className={styles.choice} aria-pressed={d.who === w}
      onClick={() => { set({ who: w, children: w === 'ME' ? [] : d.children.length ? d.children : [{ ...emptyPerson, familyName: d.contact.familyName }] }); go('DETAILS'); }}>
      {t(w === 'ME' ? 'vWhoMe' : w === 'KIDS' ? 'vWhoKids' : 'vWhoBoth')}</button>)}</div>
    {nav('WELCOME', <span/>)}</section></>, accent);

  if (p.step === 'DETAILS') {
    const ok = detailsOk(d, r, p.language, p.today);
    const kids = d.who !== 'ME';
    return shell(<>{head}<form className={styles.step} onSubmit={e => { e.preventDefault(); if (ok) go('WAIVER'); else p.onTried?.(); }} noValidate>
      <h1>{t('vDetailsTitle')}</h1>
      <fieldset><legend>{t('vYou')}</legend>
        <PersonFields t={t} prefix="contact" person={d.contact} tried={p.tried} birthRequired={d.who !== 'KIDS'} onChange={x => set({ contact: { ...d.contact, ...x } })}/>
        <div className={styles.fields}>
          <label>{t('vMobile')}<input type="tel" inputMode="tel" name="mobile" autoComplete="off" maxLength={20} value={d.contact.mobile} onChange={e => set({ contact: { ...d.contact, mobile: e.target.value } })}/></label>
          <label>{t('vEmail')}<input type="email" inputMode="email" name="email" autoComplete="off" maxLength={254} value={d.contact.email} onChange={e => set({ contact: { ...d.contact, email: e.target.value } })}/></label>
        </div><p className={styles.hint}>{t('vOneOf')}</p>
        {kids ? <div className={styles.inline} role="radiogroup" aria-label={t('vRelationship')}><span>{t('vRelationship')}</span>
          {(['PARENT', 'LEGAL_GUARDIAN'] as const).map(rel => <button type="button" role="radio" key={rel} aria-checked={d.relationship === rel} onClick={() => set({ relationship: rel })}>
            {t(rel === 'PARENT' ? 'vParent' : 'vGuardian')}</button>)}</div> : null}
      </fieldset>
      {kids ? d.children.map((c, i) => <fieldset key={i}><legend>{t('vChild', { n: i + 1 })}</legend>
        <PersonFields t={t} prefix={`child-${i}`} person={c} tried={p.tried} birthRequired onChange={x => set({ children: d.children.map((y, j) => j === i ? x : y) })}/>
        {d.children.length > 1 ? <button type="button" className={styles.ghost} onClick={() => set({ children: d.children.filter((_, j) => j !== i) })}>{t('vRemoveChild')}</button> : null}
      </fieldset>) : null}
      {kids && d.children.length < 3 ? <button type="button" className={styles.ghost} onClick={() => set({ children: [...d.children, { ...emptyPerson, familyName: d.contact.familyName }] })}>{t('vAddChild')}</button> : null}
      <fieldset><legend>{t('vEmergencyTitle')} {r.emergencyRequired ? '' : t('vOptional')}</legend><div className={styles.fields}>
        <label>{t('vEmergencyName')}<input name="emergency-name" autoComplete="off" maxLength={120} value={d.emergencyName} onChange={e => set({ emergencyName: e.target.value })}/></label>
        <label>{t('vEmergencyPhone')}<input type="tel" inputMode="tel" name="emergency-phone" autoComplete="off" maxLength={20} value={d.emergencyPhone} onChange={e => set({ emergencyPhone: e.target.value })}/></label>
      </div></fieldset>
      <label className={styles.select}>{t('vHeard')}<select value={d.heardFrom} onChange={e => set({ heardFrom: e.target.value as WalkInHeardFrom })}>
        {WALKIN_HEARD_FROM.map(h => <option key={h} value={h}>{h ? t(`h${h}` as WalkInKey) : t('vHeardNone')}</option>)}</select></label>
      <label className={styles.check}><input type="checkbox" checked={d.marketingOptIn} onChange={e => set({ marketingOptIn: e.target.checked })}/>
        <span>{t('vNews')}<small>{t('vNewsHelp')}</small></span></label>
      {p.tried && !ok ? <p role="alert" className={styles.alert}>{t('vFix')}</p> : null}
      {nav('WHO', <button type="submit" className={styles.primary}>{t('vNext')}</button>)}</form></>, accent);
  }

  if (p.step === 'WAIVER') {
    const shown = walkInText(r.waiver, p.language);
    const agree = d.who === 'ME' ? 'vAgree' : d.who === 'KIDS' ? 'vAgreeKids' : 'vAgreeFor';
    return shell(<>{head}<form className={styles.step} onSubmit={e => { e.preventDefault(); if (waiverOk(d)) go('OFFER'); else p.onTried?.(); }} noValidate>
      <h1>{t('vWaiverTitle')}</h1>
      {shown.fallback ? <p className={styles.hint}>{t('vWaiverFallback')}</p> : null}
      <div className={styles.waiver} tabIndex={0} lang={shown.fallback ? 'en' : p.language} data-testid="walkin-waiver">{shown.text}</div>
      <label>{t('vSignerName')}<input name="signer" autoComplete="off" maxLength={120} value={d.signerName} aria-invalid={p.tried && !d.signerName.trim() ? 'true' : undefined}
        onChange={e => set({ signerName: e.target.value })}/></label>
      <SignaturePad strokes={d.strokes} onChange={strokes => set({ strokes })} label={t('vSignHere')} clearLabel={t('vClear')}/>
      <label className={styles.check}><input type="checkbox" checked={d.agreed} onChange={e => set({ agreed: e.target.checked })}/><span>{t(agree)}</span></label>
      {p.tried && !waiverOk(d) ? <p role="alert" className={styles.alert}>{t('vFix')}</p> : null}
      {nav('DETAILS', <button type="submit" className={styles.primary}>{t('vNext')}</button>)}</form></>, accent);
  }

  if (p.step === 'OFFER') {
    const failed = p.outcome && p.outcome.result !== 'RECORDED' ? p.outcome.result : null;
    return shell(<>{head}<section className={styles.step}><h1>{t('vOfferTitle')}</h1>
      <div className={styles.offers} role="radiogroup" aria-label={t('vOfferTitle')}>{r.offers.map(o => {
        const name = walkInText(o.name, p.language).text, about = walkInText(o.description, p.language).text;
        return <button type="button" role="radio" key={o.key} aria-checked={d.offerKey === o.key} className={styles.offer} disabled={p.sending} onClick={() => set({ offerKey: o.key })}>
          <strong>{name}</strong><span className={styles.price}>{o.priceMinor ? walkInPrice(p.language, o.priceMinor) : t('vFree')}</span>{about ? <small>{about}</small> : null}</button>;
      })}</div>
      {failed ? <p role="alert" className={styles.alert}>{t(`v${failed}` as WalkInKey)}</p> : null}
      {failed === 'STALE' || failed === 'CLOSED' || failed === 'RATE_LIMITED' ? <div className={styles.nav}><span/>
        <button type="button" className={styles.primary} onClick={() => p.onReset?.()}>{t('vStartOver')}</button></div>
        : nav(p.sending ? null : 'WAIVER', <button type="button" className={styles.primary} disabled={!d.offerKey || p.sending} onClick={() => p.onSend?.()}>
          {p.sending ? t('vSending') : failed ? t('vRetry') : t('vSend')}</button>)}</section></>, accent);
  }

  const o = p.outcome;
  const desk = o?.paymentState === 'PAY_AT_DESK';
  return shell(<section className={styles.center} role="status" data-testid="walkin-done">
    <h1>{t('vDone', { name: o ? doneName(o, d) : '' })}</h1>
    <p className={styles.lead}>{desk ? t('vDoneDesk', { price: walkInPrice(p.language, o?.priceMinor ?? 0) }) : t('vDoneFree')}</p>
    {o?.thankYou ? <p className={styles.thanks}>{o.thankYou}</p> : null}
    <button type="button" className={styles.primary} onClick={() => p.onReset?.()}>{t('vFinish')}</button>
    <p className={styles.hint}>{t('vResetting', { n: p.countdown })}</p></section>, accent);
}

/** The tablet page: takes the in-memory hand-off once, then shows only the visitor flow. Nothing typed outlives a visit. */
export function WalkInVisitorPage({ api = walkInTabletApi, now = () => new Date() }: { api?: WalkInTabletApi; now?: () => Date }): React.ReactElement {
  const [handoff] = useState(() => takeWalkInTablet());
  const [read, setRead] = useState<VisitorRead>(handoff ? 'LOADING' : 'NOT_STARTED');
  const [language, setLanguage] = useState<WalkInLanguage>(() => {
    const base = handoff?.language.toLowerCase().split('-')[0];
    return base === 'ko' || base === 'es' ? base : 'en';
  });
  const [step, setStep] = useState<Step>('WELCOME');
  const [draft, setDraft] = useState<VisitDraft>(emptyDraft);
  const [tried, setTried] = useState(false);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<WalkInVisitOutcome | null>(null);
  const [countdown, setCountdown] = useState(RESET_SECONDS);
  const key = useRef<string | null>(null);
  const token = handoff?.token ?? null;
  const defaultLanguage = useRef(language);

  const load = useCallback(async () => {
    if (!token) return;
    const controller = new AbortController();
    const answer = await api.terminal(token, controller.signal);
    setRead(answer);
  }, [api, token]);
  useEffect(() => { void load(); }, [load]);

  const reset = useCallback(() => {
    setDraft(emptyDraft()); setStep('WELCOME'); setTried(false); setOutcome(null); setSending(false); setCountdown(RESET_SECONDS);
    setLanguage(defaultLanguage.current); key.current = null;
    void load();
  }, [load]);

  // The tablet closes itself at its end time.
  useEffect(() => {
    if (typeof read !== 'object') return;
    const left = Date.parse(read.endsAt) - now().getTime();
    const timer = setTimeout(() => setRead('CLOSED'), Math.max(0, Math.min(left, 2_147_000_000)));
    return () => clearTimeout(timer);
  }, [read, now]);
  // Done clears itself after 20 seconds.
  useEffect(() => {
    if (step !== 'DONE') return;
    if (countdown <= 0) { reset(); return; }
    const timer = setTimeout(() => setCountdown(n => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [step, countdown, reset]);
  // A form left alone for two minutes is cleared, so the next visitor never sees it.
  useEffect(() => {
    if (step === 'WELCOME' || step === 'DONE' || sending) return;
    const timer = setTimeout(reset, IDLE_MS);
    return () => clearTimeout(timer);
  }, [step, draft, sending, reset]);

  const send = useCallback(async () => {
    if (!token || typeof read !== 'object' || sending) return;
    let body: WalkInVisitInput;
    try { body = visitBody(draft, read, language, localToday(now())); } catch { setOutcome({ result: 'INVALID' }); return; }
    key.current ??= globalThis.crypto.randomUUID();
    setSending(true);
    const answer = await api.submit(token, body, key.current, new AbortController().signal);
    setSending(false);
    setOutcome(answer);
    if (answer.result === 'RECORDED') { setCountdown(RESET_SECONDS); setStep('DONE'); return; }
    if (answer.result === 'CLOSED') setRead('CLOSED');
    if (answer.result !== 'UNAVAILABLE') key.current = null; // Only an unknown outcome is retried with the same key.
  }, [api, draft, language, now, read, sending, token]);

  return <WalkInVisitorView read={read} mode={handoff?.mode ?? 'big-button'} language={language} step={step} draft={draft} today={localToday(now())} tried={tried}
    sending={sending} outcome={outcome} countdown={countdown}
    onLanguage={l => { key.current = null; setLanguage(l); }} onStep={s => { setTried(false); if (s !== 'OFFER') setOutcome(null); setStep(s); }} onDraft={d => { key.current = null; setDraft(d); }} onTried={() => setTried(true)}
    onSend={() => { void send(); }} onReset={reset}/>;
}
