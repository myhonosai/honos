'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  schoolBrandingColorOk, schoolBrandingImageUrlOk, validateWalkInVisitInput, walkInText, WALKIN_HEARD_FROM, WALKIN_LANGUAGES,
  type WalkInCardOutcome, type WalkInCardSurface, type WalkInHeardFrom, type WalkInLanguage, type WalkInRelationship, type WalkInStroke, type WalkInTerminal, type WalkInTrialClass,
  type WalkInVisitInput, type WalkInVisitOutcome,
} from '@hon/contracts';
import type { HonInterfaceTheme } from '@hon/design-system';
import { walkInCopy, walkInLanguage, walkInPrice, type WalkInKey } from './copy';
import { WalkInCardForm, WalkInQr, walkInStripeTestKey, walkInTabletSurfaces } from './card';
import { takeWalkInTablet } from './handoff';
import { walkInTabletApi, type WalkInTabletApi } from './http';
import { SignaturePad, signedStrokes } from './signature-pad';
import styles from './walk-in-kiosk.module.css';

export type Who = 'ME' | 'KIDS' | 'BOTH';
export type Step = 'WELCOME' | 'WHO' | 'DETAILS' | 'WAIVER' | 'OFFER' | 'PAY' | 'DONE';
/**
 * 0533 card payment on the tablet after a PAY_AT_DESK visit is recorded. CHOOSE: the ways to pay. STARTING: asking the
 * server. FORM: Stripe's card form in the page. QR: Stripe's page on the visitor's phone. CHECKING: the form said done (or the
 * desk was chosen) and the server is asked. `error` is the last unpaid ending, shown on CHOOSE.
 */
export type PayView = 'CHOOSE' | 'STARTING' | 'FORM' | 'QR' | 'CHECKING';
export type PayError = 'FAILED' | 'EXPIRED' | 'UNAVAILABLE' | 'FORM';
export type Pay = Readonly<{
  view: PayView; surfaces: readonly WalkInCardSurface[]; error: PayError | null; processing: boolean;
  clientSecret: string | null; accountRef: string | null; url: string | null;
}>;
export type Paid = 'CARD' | 'DESK' | 'NOT_DUE';
export const choosePay = (surfaces: readonly WalkInCardSurface[], error: PayError | null = null): Pay =>
  ({ view: 'CHOOSE', surfaces, error, processing: false, clientSecret: null, accountRef: null, url: null });
export const PAY_POLL_MS = 4000;
export const PAY_IDLE_MS = 600_000;
/** What a card answer means for the tablet. Only PAID is paid; every other answer keeps the desk as the way to pay. */
export function payNext(pay: Pay, o: WalkInCardOutcome, asked: 'start' | 'status' | 'cancel', surface?: WalkInCardSurface):
  { pay: Pay } | { done: Paid } | { closed: true } {
  if (o.result === 'PAID') return { done: 'CARD' };
  if (o.result === 'NOT_DUE') return { done: 'NOT_DUE' };
  if (o.result === 'CLOSED') return { closed: true };
  if (asked === 'cancel') return o.result === 'PROCESSING' ? { pay: { ...pay, view: 'CHECKING', processing: true } } : { done: 'DESK' };
  if (o.result === 'READY') {
    if (asked !== 'start' || o.surface !== surface) return { pay: choosePay(pay.surfaces, 'UNAVAILABLE') };
    return { pay: { ...pay, view: surface === 'EMBEDDED' ? 'FORM' : 'QR', error: null, processing: false, clientSecret: o.clientSecret ?? null,
      accountRef: o.accountRef ?? null, url: o.url ?? null } };
  }
  if (o.result === 'NOT_AVAILABLE') {
    const left = asked === 'start' && surface ? pay.surfaces.filter(x => x !== surface) : [];
    return left.length ? { pay: choosePay(left, 'UNAVAILABLE') } : { done: 'DESK' };
  }
  if (o.result === 'NOT_FOUND') return { done: 'DESK' };
  if (o.result === 'OPEN' || o.result === 'PROCESSING') return { pay: { ...pay, processing: o.result === 'PROCESSING' } };
  if (o.result === 'FAILED' || o.result === 'EXPIRED' || o.result === 'CANCELED' || o.result === 'NONE') {
    return { pay: choosePay(pay.surfaces, o.result === 'EXPIRED' ? 'EXPIRED' : o.result === 'FAILED' ? 'FAILED' : null) };
  }
  // INVALID, RATE_LIMITED, UNAVAILABLE: a status check keeps waiting; a start goes back to the choices.
  return asked === 'status' ? { pay } : { pay: choosePay(pay.surfaces, 'UNAVAILABLE') };
}
export type Person = Readonly<{ givenName: string; familyName: string; birthDate: string }>;
export type VisitDraft = Readonly<{
  who: Who; contact: Person & Readonly<{ email: string; mobile: string }>; children: readonly Person[]; relationship: WalkInRelationship;
  emergencyName: string; emergencyPhone: string; heardFrom: WalkInHeardFrom; marketingOptIn: boolean; offerKey: string;
  signerName: string; strokes: readonly WalkInStroke[]; agreed: boolean;
  /** 0537: the class picked for a trial offer that lists classes ('' until one is picked). */
  trialSessionId: string;
}>;
const emptyPerson: Person = { givenName: '', familyName: '', birthDate: '' };
export const emptyDraft = (): VisitDraft => ({
  who: 'ME', contact: { ...emptyPerson, email: '', mobile: '' }, children: [], relationship: 'PARENT', emergencyName: '', emergencyPhone: '',
  heardFrom: '', marketingOptIn: false, offerKey: '', signerName: '', strokes: [], agreed: false, trialSessionId: '',
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

/** 0537: how many people on this visit need a seat in a trial class. */
export const visitSeats = (d: VisitDraft): number => (d.who !== 'KIDS' ? 1 : 0) + (d.who !== 'ME' ? d.children.length : 0);
/** 0537: a trial class the visitor can pick (enough open spots for everyone on the visit). */
export const classOpen = (c: WalkInTrialClass, d: VisitDraft): boolean => c.spotsOpen >= visitSeats(d);
/** 0537: an offer can be chosen unless it lists classes and none of them has room. */
export const offerOpen = (o: WalkInTerminal['offers'][number], d: VisitDraft): boolean => o.classes === null || o.classes.some(c => classOpen(c, d));
/** A class time as the tablet shows it (the tablet sits at the school, so its own clock zone is the school's). */
export const classWhen = (language: WalkInLanguage, iso: string): string =>
  new Date(iso).toLocaleString(language, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * The request body for the whole form. Throws when anything is not acceptable; the server checks it all again.
 * `standIn` (the details check) skips the offer and class, which are picked later.
 */
export function visitBody(d: VisitDraft, terminal: WalkInTerminal, language: WalkInLanguage, today: string, standIn = false): WalkInVisitInput {
  const adultTrains = d.who !== 'KIDS', kids = d.who !== 'ME';
  const offer = standIn ? terminal.offers[0] : terminal.offers.find(o => o.key === d.offerKey);
  if (!offer) throw new Error('Choose one of this school’s offers.');
  const picked = !standIn && offer.classes !== null ? offer.classes.find(c => c.sessionId === d.trialSessionId) : undefined;
  if (!standIn && offer.classes !== null && (!picked || !classOpen(picked, d))) throw new Error('Choose one of the trial classes.');
  const trim = (p: Person) => ({ givenName: p.givenName.trim(), familyName: p.familyName.trim(), birthDate: p.birthDate });
  return validateWalkInVisitInput({
    settingsVersion: terminal.settingsVersion, language,
    contact: { givenName: d.contact.givenName.trim(), familyName: d.contact.familyName.trim(), email: d.contact.email.trim(), mobile: normalizeMobile(d.contact.mobile),
      birthDate: adultTrains ? d.contact.birthDate : null, isParticipant: adultTrains, adultConfirmed: true },
    children: kids ? d.children.map(trim) : [], relationship: kids ? d.relationship : null,
    emergency: { name: d.emergencyName.trim(), phone: normalizeMobile(d.emergencyPhone) }, heardFrom: d.heardFrom, marketingOptIn: d.marketingOptIn,
    offerKey: offer.key, waiver: { accepted: d.agreed, signerName: d.signerName.trim(), strokes: signedStrokes(d.strokes) }, website: '',
    ...(picked ? { trialSessionId: picked.sessionId } : {}),
  }, today);
}
/** Whether the details step is complete: the whole form with a stand-in waiver and offer must pass. */
export function detailsOk(d: VisitDraft, terminal: WalkInTerminal, language: WalkInLanguage, today: string): boolean {
  try {
    visitBody({ ...d, agreed: true, signerName: 'Signer', strokes: [[[1, 1], [2, 2]]] }, terminal, language, today, true);
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
  sending: boolean; outcome: WalkInVisitOutcome | null; countdown: number; pay?: Pay | null; paid?: Paid | null; testKey?: string | null;
  onLanguage?: (language: WalkInLanguage) => void; onStep?: (step: Step) => void; onDraft?: (draft: VisitDraft) => void;
  onTried?: () => void; onSend?: () => void; onReset?: () => void;
  onPay?: (surface: WalkInCardSurface) => void; onDesk?: () => void; onOther?: () => void; onFormDone?: () => void; onFormError?: () => void;
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
    const chosen = r.offers.find(o => o.key === d.offerKey);
    const ready = !!chosen && offerOpen(chosen, d) && (chosen.classes === null || chosen.classes.some(c => c.sessionId === d.trialSessionId && classOpen(c, d)));
    return shell(<>{head}<section className={styles.step}><h1>{t('vOfferTitle')}</h1>
      <div className={styles.offers} role="radiogroup" aria-label={t('vOfferTitle')}>{r.offers.map(o => {
        const name = walkInText(o.name, p.language).text, about = walkInText(o.description, p.language).text, open = offerOpen(o, d);
        return <button type="button" role="radio" key={o.key} aria-checked={d.offerKey === o.key} className={styles.offer} disabled={p.sending || !open}
          onClick={() => set({ offerKey: o.key, trialSessionId: o.key === d.offerKey ? d.trialSessionId : '' })}>
          <strong>{name}</strong><span className={styles.price}>{o.priceMinor ? walkInPrice(p.language, o.priceMinor) : t('vFree')}</span>{about ? <small>{about}</small> : null}
          {open ? null : <small>{t('vNoClasses')}</small>}</button>;
      })}</div>
      {chosen?.classes ? <section aria-labelledby="walkin-classes"><h2 id="walkin-classes">{t('vClassTitle')}</h2>
        <div className={styles.classes} role="radiogroup" aria-labelledby="walkin-classes" data-testid="walkin-classes">{chosen.classes.map(c => {
          const open = classOpen(c, d);
          return <button type="button" role="radio" key={c.sessionId} className={styles.offer} aria-checked={d.trialSessionId === c.sessionId} disabled={p.sending || !open}
            onClick={() => set({ trialSessionId: c.sessionId })}><strong>{c.name}</strong><span>{classWhen(p.language, c.startsAt)}</span>
            <small>{open ? t('vClassSpots') : t('vClassFull')}</small></button>;
        })}</div></section> : null}
      {failed ? <p role="alert" className={styles.alert}>{t(`v${failed}` as WalkInKey)}</p> : null}
      {failed === 'STALE' || failed === 'CLOSED' || failed === 'RATE_LIMITED' ? <div className={styles.nav}><span/>
        <button type="button" className={styles.primary} onClick={() => p.onReset?.()}>{t('vStartOver')}</button></div>
        : nav(p.sending ? null : 'WAIVER', <button type="button" className={styles.primary} disabled={!ready || p.sending} onClick={() => p.onSend?.()}>
          {p.sending ? t('vSending') : failed ? t('vRetry') : t('vSend')}</button>)}</section></>, accent);
  }

  const o = p.outcome;
  const price = walkInPrice(p.language, o?.priceMinor ?? 0);
  if (p.step === 'PAY' && p.pay) {
    const pay = p.pay, busy = pay.view === 'STARTING' || pay.view === 'CHECKING';
    const other = <div className={styles.nav}><button type="button" className={styles.ghost} onClick={() => p.onOther?.()}>{t('vPayOther')}</button>
      <button type="button" className={styles.ghost} onClick={() => p.onDesk?.()}>{t('vPayDesk')}</button></div>;
    return shell(<>{head}<section className={styles.step} data-testid="walkin-pay">
      <h1>{t('vPayTitle', { price })}</h1><p className={styles.hint}>{t('vPayTest')}</p>
      {pay.view === 'CHOOSE' ? <>
        {pay.error ? <p role="alert" className={styles.alert}>{t(`vPay${pay.error}` as WalkInKey)}</p> : null}
        <div className={styles.choices}>
          {pay.surfaces.includes('EMBEDDED') ? <button type="button" className={styles.choice} onClick={() => p.onPay?.('EMBEDDED')}>{t('vPayHere')}</button> : null}
          {pay.surfaces.includes('HOSTED') ? <button type="button" className={styles.choice} onClick={() => p.onPay?.('HOSTED')}>{t('vPayPhone')}</button> : null}
          <button type="button" className={styles.choice} onClick={() => p.onDesk?.()}>{t('vPayDesk')}</button>
        </div></> : null}
      {busy ? <p role="status" className={styles.lead}>{t(pay.view === 'STARTING' ? 'vPayStarting' : pay.processing ? 'vPayProcessing' : 'vPayChecking')}</p> : null}
      {pay.view === 'FORM' && pay.clientSecret && p.testKey ? <>
        <WalkInCardForm testKey={p.testKey} clientSecret={pay.clientSecret} accountRef={pay.accountRef} onComplete={() => p.onFormDone?.()} onError={() => p.onFormError?.()}/>
        {other}</> : null}
      {pay.view === 'QR' && pay.url ? <>
        <div className={styles.qrBox}><WalkInQr url={pay.url} label={t('vPayPhone')}/><p className={styles.lead} role="status">{pay.processing ? t('vPayProcessing') : t('vPayScan')}</p></div>
        {other}</> : null}
    </section></>, accent);
  }
  const desk = o?.paymentState === 'PAY_AT_DESK' && p.paid !== 'CARD' && p.paid !== 'NOT_DUE';
  return shell(<section className={styles.center} role="status" data-testid="walkin-done">
    <h1>{t('vDone', { name: o ? doneName(o, d) : '' })}</h1>
    <p className={styles.lead}>{p.paid === 'CARD' ? t('vDonePaid', { price }) : desk ? t('vDoneDesk', { price }) : t('vDoneFree')}</p>
    {o?.trialClass ? <p className={styles.lead} data-testid="walkin-done-class">{t('vDoneClass', { name: o.trialClass.name, when: classWhen(p.language, o.trialClass.startsAt) })}</p> : null}
    {o?.thankYou ? <p className={styles.thanks}>{o.thankYou}</p> : null}
    <button type="button" className={styles.primary} onClick={() => p.onReset?.()}>{t('vFinish')}</button>
    <p className={styles.hint}>{t('vResetting', { n: p.countdown })}</p></section>, accent);
}

/** The phone's page after Stripe's page. Static: it never says whether a payment went through, the tablet does. */
export function WalkInPaidView({ language }: { language: string }): React.ReactElement {
  return <main className={`${styles.kiosk} ${styles.modern}`} lang={walkInLanguage(language)} data-testid="walkin-paid">
    <section className={styles.center} role="status"><h1>{walkInCopy(language, 'vPaidTitle')}</h1><p className={styles.lead}>{walkInCopy(language, 'vPaidBody')}</p></section></main>;
}

/** The tablet page: takes the in-memory hand-off once, then shows only the visitor flow. Nothing typed outlives a visit. */
export function WalkInVisitorPage({ api = walkInTabletApi, now = () => new Date(), testKey = walkInStripeTestKey() }: {
  api?: WalkInTabletApi; now?: () => Date; testKey?: string | null;
}): React.ReactElement {
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
  const [pay, setPay] = useState<Pay | null>(null);
  const [paid, setPaid] = useState<Paid | null>(null);
  const visitKey = useRef<string | null>(null); // the key the recorded visit was sent with: the only name the card calls use
  const acting = useRef(false); // a start or cancel the visitor pressed is in flight
  const generation = useRef(0); // only the latest card call's answer counts
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
    // A card payment left open is ended (best effort); the desk path ends it too, and a payment made meanwhile still counts.
    if (token && visitKey.current && step === 'PAY') void api.card('cancel', token, visitKey.current, new AbortController().signal);
    setDraft(emptyDraft()); setStep('WELCOME'); setTried(false); setOutcome(null); setSending(false); setCountdown(RESET_SECONDS);
    setLanguage(defaultLanguage.current); key.current = null; visitKey.current = null; setPay(null); setPaid(null); acting.current = false; generation.current += 1;
    void load();
  }, [api, load, step, token]);

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
  // Paying gets longer (typing a card happens inside the processor's frame, which this page cannot see).
  useEffect(() => {
    if (step === 'WELCOME' || step === 'DONE' || sending) return;
    const timer = setTimeout(reset, step === 'PAY' ? PAY_IDLE_MS : IDLE_MS);
    return () => clearTimeout(timer);
  }, [step, draft, sending, reset, pay?.view]);

  /** One card call at a time; its answer moves the payment on (only the server's PAID is paid). */
  const ask = useCallback(async (action: 'start' | 'status' | 'cancel', from: Pay, surface?: WalkInCardSurface) => {
    if (!token || !visitKey.current || acting.current) return;
    const mine = ++generation.current;
    if (action !== 'status') acting.current = true;
    if (action !== 'status') setPay(action === 'start' ? { ...from, view: 'STARTING', error: null } : { ...from, view: 'CHECKING', processing: false });
    const answer = await api.card(action, token, visitKey.current, new AbortController().signal, surface);
    if (action !== 'status') acting.current = false;
    if (mine !== generation.current || !visitKey.current) return; // a later call, or a reset, came first
    const next = payNext(from, answer, action, surface);
    if ('closed' in next) { setRead('CLOSED'); return; }
    if ('done' in next) { setPaid(next.done); setCountdown(RESET_SECONDS); setStep('DONE'); return; }
    setPay({ ...next.pay }); // a fresh object, so a status answer that changes nothing still schedules the next check
  }, [api, token]);
  // The phone QR and a finished form are checked every few seconds until the server says how it ended.
  useEffect(() => {
    if (step !== 'PAY' || !pay || (pay.view !== 'QR' && pay.view !== 'CHECKING')) return;
    const timer = setTimeout(() => { void ask('status', pay); }, PAY_POLL_MS);
    return () => clearTimeout(timer);
  }, [step, pay, ask]);

  const send = useCallback(async () => {
    if (!token || typeof read !== 'object' || sending) return;
    let body: WalkInVisitInput;
    try { body = visitBody(draft, read, language, localToday(now())); } catch { setOutcome({ result: 'INVALID' }); return; }
    key.current ??= globalThis.crypto.randomUUID();
    setSending(true);
    const answer = await api.submit(token, body, key.current, new AbortController().signal);
    setSending(false);
    setOutcome(answer);
    if (answer.result === 'RECORDED') {
      const surfaces = walkInTabletSurfaces(read.cardSurfaces, testKey);
      if (answer.paymentState === 'PAY_AT_DESK' && surfaces.length) { visitKey.current = key.current; setPay(choosePay(surfaces)); setStep('PAY'); return; }
      setCountdown(RESET_SECONDS); setStep('DONE'); return;
    }
    if (answer.result === 'CLOSED') setRead('CLOSED');
    // 0537: the class filled up (or started) meanwhile: fresh classes, pick again.
    if (answer.result === 'CLASS_FULL') { setDraft(x => ({ ...x, trialSessionId: '' })); void load(); }
    if (answer.result !== 'UNAVAILABLE') key.current = null; // Only an unknown outcome is retried with the same key.
  }, [api, draft, language, load, now, read, sending, testKey, token]);

  return <WalkInVisitorView read={read} mode={handoff?.mode ?? 'big-button'} language={language} step={step} draft={draft} today={localToday(now())} tried={tried}
    sending={sending} outcome={outcome} countdown={countdown} pay={pay} paid={paid} testKey={testKey}
    onPay={surface => { if (pay) void ask('start', pay, surface); }} onDesk={() => { if (pay) void ask('cancel', pay); }}
    // #494 P3: each of these makes an earlier card answer stale, so an in-flight status answer can never bring the old view back.
    onOther={() => { if (pay) { generation.current += 1; setPay(choosePay(pay.surfaces)); } }}
    onFormDone={() => { if (pay) { generation.current += 1; setPay({ ...pay, view: 'CHECKING' }); } }}
    onFormError={() => { if (pay) { generation.current += 1; setPay(choosePay(pay.surfaces.filter(x => x !== 'EMBEDDED'), 'FORM')); } }}
    onLanguage={l => { key.current = null; setLanguage(l); }} onStep={s => { setTried(false); if (s !== 'OFFER') setOutcome(null); setStep(s); }} onDraft={d => { key.current = null; setDraft(d); }} onTried={() => setTried(true)}
    onSend={() => { void send(); }} onReset={reset}/>;
}
