'use client';
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ATTENDANCE_CARD_CODE_TYPES, ATTENDANCE_CARD_DESIGNS, ATTENDANCE_CARD_MAX_PER_PRINT, groupAttendanceCardCode, type AttendanceCardDesign, type AttendanceCardCodeType,
  type AttendanceCardIssueResult, type AttendanceCardSettings, type AttendanceCardStudent, type AttendanceCardsRead,
} from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { initialsOf } from '../people/photo';
import { photoApi, type PhotoApi } from '../people/photo-http';
import { code128Svg, qrSvg } from './codes';
import { cardsText, type CardsKey } from './copy';
import { CardsError, cardsApi, keepForRetry, type CardsApi, type CardsErrorKind } from './http';
import styles from './cards.module.css';

export type Look = Readonly<{ codeType: AttendanceCardCodeType; showPhoto: boolean; showLogo: boolean; design: AttendanceCardDesign; photoApprovalRequired: boolean }>;
export type PrintedCard = Readonly<{ studentProfileId: string; name: string; initials: string; code: string; photo: string | null }>;

/** One printed card (CR80 size). The code is drawn here from its digits; nothing is fetched by the face itself. */
export function CardFace({ language, settings, look, card }: { language: string; settings: AttendanceCardSettings; look: Look; card: PrintedCard }): React.ReactElement {
  const t = (key: CardsKey, vars?: Record<string, string>) => cardsText(language, key, vars);
  const logo = look.showLogo && settings.logoUrl ? settings.logoUrl : null;
  const accent = settings.accentColor ?? '#0f5d8c';
  let code: React.ReactElement;
  if (look.codeType === 'QR') {
    const q = qrSvg(card.code);
    code = <svg viewBox={`0 0 ${q.size} ${q.size}`} width="20mm" height="20mm" role="img" aria-label={t('codeLabel')} shapeRendering="crispEdges"><rect width={q.size} height={q.size} fill="#fff"/><path d={q.path} fill="#000"/></svg>;
  } else {
    const b = code128Svg(card.code, 30);
    code = <svg viewBox={`0 0 ${b.width} ${b.height}`} width="52mm" height="11mm" preserveAspectRatio="none" role="img" aria-label={t('codeLabel')} shapeRendering="crispEdges"><rect width={b.width} height={b.height} fill="#fff"/><path d={b.path} fill="#000"/></svg>;
  }
  return <div className={styles.face} data-design={look.design} data-photo={String(look.showPhoto)} data-testid="card-face" data-code-type={look.codeType}
    style={{ '--card-accent': accent } as React.CSSProperties}>
    <div className={styles.faceHead}>{logo ? <img src={logo} alt={t('logoAlt', { school: settings.schoolName })} referrerPolicy="no-referrer"/> : null}<span>{settings.schoolName}</span></div>
    {look.showPhoto ? <div className={styles.facePhoto}>{card.photo ? <img src={card.photo} alt={t('photoAlt', { name: card.name })}/> : <span aria-hidden="true">{card.initials}</span>}</div> : null}
    <p className={styles.faceName}>{card.name}</p>
    <div className={styles.faceCode}>{code}<small>{groupAttendanceCardCode(card.code)}</small></div>
  </div>;
}

export type CardsReadState = Readonly<{ state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' | 'NO_SCHOOL' }> | Readonly<{ state: 'READY'; read: AttendanceCardsRead }>;
export type CardsOutcome = null | Readonly<{ kind: 'SENDING' | 'LOOK_SAVED' | 'CANCELED' | 'CONSENT_SAVED' | 'REPLAYED' | Exclude<CardsErrorKind, 'SESSION'> }>;
const OUTCOME: Record<NonNullable<CardsOutcome>['kind'], CardsKey> = { SENDING: 'sending', LOOK_SAVED: 'lookSaved', CANCELED: 'canceled', CONSENT_SAVED: 'consentSaved', REPLAYED: 'replayed',
  DENIED: 'outDenied', MISSING: 'outMissing', CONFLICT: 'outConflict', INVALID: 'outInvalid', BUSY: 'outBusy', UNKNOWN: 'outUnknown' };
const tone = (k: NonNullable<CardsOutcome>['kind']) => k === 'LOOK_SAVED' || k === 'CANCELED' || k === 'CONSENT_SAVED' ? 'ok' : k === 'SENDING' || k === 'UNKNOWN' || k === 'BUSY' || k === 'REPLAYED' ? 'waiting' : 'blocked';
const nameOf = (s: Pick<AttendanceCardStudent, 'givenName' | 'familyName'>) => `${s.givenName} ${s.familyName}`;

export type CardsViewProps = Readonly<{
  language: string; read: CardsReadState; look: Look; selected: ReadonlySet<string>; confirmCancel: string | null; outcome: CardsOutcome;
  locked: boolean; canRetry: boolean; sheet: readonly PrintedCard[] | null;
  onLook?: ((look: Look) => void) | undefined; onSaveLook?: (() => void) | undefined; onToggle?: ((id: string) => void) | undefined;
  onSelectAll?: (() => void) | undefined; onClear?: (() => void) | undefined; onPrintNew?: (() => void) | undefined;
  onAskCancel?: ((id: string) => void) | undefined; onCancel?: (() => void) | undefined; onKeep?: (() => void) | undefined;
  onConsent?: ((studentProfileId: string, given: boolean) => void) | undefined;
  onReload?: (() => void) | undefined; onTryAgain?: (() => void) | undefined; onStop?: (() => void) | undefined; onPrint?: (() => void) | undefined; onDone?: (() => void) | undefined;
}>;

/** Pure view of the card maker: look, students, and the print sheet. */
export function CardsView(p: CardsViewProps): React.ReactElement {
  const t = (key: CardsKey, vars?: Record<string, string | number>) => cardsText(p.language, key, vars);
  const base = useId();
  const r = p.read.state === 'READY' ? p.read.read : null;
  const o = p.outcome;
  // Cards print in the saved look only, so a sheet never shows a look the school did not choose.
  const saved = r ? lookOf(r.settings) : null;
  const consentNeeded = r?.settings.photoConsent.required === true;
  const unsaved = saved !== null && (Object.keys(saved) as (keyof Look)[]).some(k => saved[k] !== p.look[k]);
  return <section className={styles.page} aria-labelledby={`${base}-title`} data-testid="attendance-cards">
    <header><h1 id={`${base}-title`}>{t('cardsTitle')}</h1><p className={styles.intro}>{t('cardsIntro')}</p></header>
    {p.read.state === 'LOADING' ? <p className={styles.meta} role="status">{t('loading')}</p> : null}
    {p.read.state === 'NO_SCHOOL' ? <p className={styles.meta} role="status">{t('noSchool')}</p> : null}
    {p.read.state === 'DENIED' ? <p className={styles.meta} role="status">{t('denied')}</p> : null}
    {p.read.state === 'UNAVAILABLE' ? <div className={styles.meta} role="status"><p>{t('unavailable')}</p>
      {p.onReload ? <button type="button" className={styles.secondary} onClick={p.onReload}>{t('reload')}</button> : null}</div> : null}
    {o ? <div className={styles.outcome} role="status" data-testid="cards-outcome" data-kind={o.kind} data-tone={tone(o.kind)}>
      <p>{t(OUTCOME[o.kind])}</p>
      {p.canRetry ? <div className={styles.actions}>
        {p.onTryAgain ? <button type="button" className={styles.primary} onClick={p.onTryAgain}>{t('tryAgain')}</button> : null}
        {p.onStop ? <button type="button" className={styles.secondary} onClick={p.onStop}>{t('stop')}</button> : null}
      </div> : null}
    </div> : null}
    {r && p.sheet ? <div className={styles.panel} data-testid="print-sheet">
      <h2>{t('sheetTitle')}</h2><p className={styles.meta}>{t('sheetNote')}</p>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={p.onPrint}>{t('print')}</button>
        <button type="button" className={styles.secondary} onClick={p.onDone}>{t('done')}</button>
      </div>
      <div className={styles.sheet}>{p.sheet.map(c => <CardFace key={c.studentProfileId} language={p.language} settings={r.settings} look={lookOf(r.settings)} card={c}/>)}</div>
    </div> : null}
    {r && !p.sheet ? <>
      <div className={styles.panel}>
        <h2>{t('lookTitle')}</h2>
        {r.settings.version === 0 ? <p className={styles.meta}>{t('defaults')}</p> : null}
        {consentNeeded ? <p className={styles.meta} data-testid="consent-needed">{t('consentNeeded')}</p> : null}
        <div className={styles.form}>
          <fieldset><legend>{t('codeType')}</legend>
            {ATTENDANCE_CARD_CODE_TYPES.map(c => <label key={c} className={styles.choice}>
              <input type="radio" name={`${base}-code`} value={c} checked={p.look.codeType === c} disabled={p.locked} onChange={() => p.onLook?.({ ...p.look, codeType: c })} data-testid={`code-${c}`}/>{t(c)}</label>)}
          </fieldset>
          <p className={styles.meta}>{t('codeHelp')}</p>
          <label className={styles.choice}><input type="checkbox" checked={p.look.showPhoto} disabled={p.locked} onChange={e => p.onLook?.({ ...p.look, showPhoto: e.currentTarget.checked })}/>{t('showPhoto')}</label>
          <label className={styles.choice}><input type="checkbox" checked={p.look.photoApprovalRequired} disabled={p.locked} onChange={e => p.onLook?.({ ...p.look, photoApprovalRequired: e.currentTarget.checked })} data-testid="photo-approval"/>{t('photoApproval')}</label>
          <label className={styles.choice}><input type="checkbox" checked={p.look.showLogo} disabled={p.locked} onChange={e => p.onLook?.({ ...p.look, showLogo: e.currentTarget.checked })}/>{t('showLogo')}</label>
          {p.look.showLogo && !r.settings.logoUrl ? <p className={styles.meta}>{t('noLogo')}</p> : null}
          <div className={styles.field}><label htmlFor={`${base}-design`}>{t('design')}</label>
            <select id={`${base}-design`} value={p.look.design} disabled={p.locked} onChange={e => p.onLook?.({ ...p.look, design: e.currentTarget.value as AttendanceCardDesign })}>
              {ATTENDANCE_CARD_DESIGNS.map(d => <option key={d} value={d}>{t(d)}</option>)}
            </select></div>
          <div className={styles.actions}><button type="button" className={styles.primary} disabled={p.locked} onClick={p.onSaveLook} data-testid="save-look">{t('saveLook')}</button></div>
        </div>
      </div>
      <div className={styles.panel}>
        <h2>{t('studentsTitle')}</h2>
        <p className={styles.meta}>{t('selected', { n: p.selected.size, max: ATTENDANCE_CARD_MAX_PER_PRINT })}</p>
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onSelectAll}>{t('selectAll')}</button>
          <button type="button" className={styles.secondary} disabled={p.locked || p.selected.size === 0} onClick={p.onClear}>{t('clear')}</button>
          <button type="button" className={styles.primary} disabled={p.locked || p.selected.size === 0 || unsaved} onClick={p.onPrintNew} data-testid="print-new">{t('printNew')}</button>
        </div>
        {unsaved ? <p className={styles.meta} data-testid="save-first">{t('saveFirst')}</p> : null}
        <p className={styles.meta}>{t('replaceNote')}</p>
        <div className={styles.tableWrap}><table className={styles.table}>
          <thead><tr><th scope="col"><span className={styles.meta}>✓</span></th><th scope="col">{t('colName')}</th><th scope="col">{t('colPhoto')}</th><th scope="col">{t('colCard')}</th>{consentNeeded ? <th scope="col">{t('colConsent')}</th> : null}<th scope="col"></th></tr></thead>
          <tbody>{r.students.map(s => <tr key={s.studentProfileId} data-testid="card-student">
            <td><input type="checkbox" aria-label={nameOf(s)} checked={p.selected.has(s.studentProfileId)} disabled={p.locked || (!p.selected.has(s.studentProfileId) && p.selected.size >= ATTENDANCE_CARD_MAX_PER_PRINT)}
              onChange={() => p.onToggle?.(s.studentProfileId)}/></td>
            <td>{nameOf(s)}</td><td>{t(s.hasPhoto ? 'hasPhoto' : 'noPhoto')}</td>
            <td>{s.card ? t('activeCard', { last4: s.card.last4 }) : t('noCard')}</td>
            {consentNeeded ? <td data-testid="consent-cell">{s.photoConsent === 'GIVEN'
              ? <>{t('consentGiven')} <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onConsent?.(s.studentProfileId, false)}>{t('consentWithdraw')}</button></>
              : <>{t('consentMissing')} <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onConsent?.(s.studentProfileId, true)}>{t('consentRecord')}</button></>}</td> : null}
            <td>{s.card ? p.confirmCancel === s.card.cardId ? <div className={styles.form}><p>{t('cancelAsk', { last4: s.card.last4, name: nameOf(s) })}</p>
              <div className={styles.actions}><button type="button" className={styles.primary} disabled={p.locked} onClick={p.onCancel}>{t('cancelYes')}</button>
                <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onKeep}>{t('keep')}</button></div></div>
              : <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onAskCancel?.(s.card!.cardId)}>{t('cancelCard')}</button> : null}</td>
          </tr>)}</tbody>
        </table></div>
      </div>
    </> : null}
  </section>;
}

type Request = { op: 'look'; look: Look; expectedVersion: number } | { op: 'print'; ids: readonly string[] } | { op: 'cancel'; cardId: string; expectedVersion: number }
  | { op: 'consent'; studentProfileId: string; given: boolean; expectedVersion: number };
type Pending = Readonly<{ key: string; schoolId: string } & Request>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';
const lookOf = (s: AttendanceCardSettings): Look => ({ codeType: s.codeType, showPhoto: s.showPhoto, showLogo: s.showLogo, design: s.design, photoApprovalRequired: s.photoApprovalRequired });

/**
 * The card maker for the school the shell verified. Codes live only in this tab's memory until printed: a school change,
 * a session end or leaving the page drops them. An unknown outcome keeps the exact request (same key) for Try again.
 */
export function AttendanceCards({ api = cardsApi, photos = photoApi }: { api?: CardsApi; photos?: PhotoApi }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const schoolId = shell.phase === 'READY' ? shell.selection?.schoolId ?? null : null;
  const [read, setRead] = useState<CardsReadState>({ state: 'LOADING' });
  const [refresh, setRefresh] = useState(0);
  const [look, setLook] = useState<Look | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<CardsOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const [sheet, setSheet] = useState<readonly PrintedCard[] | null>(null);
  const generation = useRef(0), mounted = useRef(false), pending = useRef<Pending | null>(null), sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; pending.current = null; }; }, []);

  const drop = useCallback(() => { generation.current++; pending.current = null; setSheet(null); setSelected(new Set()); setOutcome(null); setLock(sending.current ? 'SENDING' : 'NONE'); }, []);
  useEffect(() => {
    const events = [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT, 'pagehide'];
    for (const e of events) window.addEventListener(e, drop);
    return () => { for (const e of events) window.removeEventListener(e, drop); };
  }, [drop]);

  useEffect(() => {
    if (!schoolId) { setRead({ state: shell.phase === 'READY' ? 'NO_SCHOOL' : 'LOADING' }); return; }
    const current = ++generation.current, owned = () => mounted.current && current === generation.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    setRead(prior => prior.state === 'READY' ? prior : { state: 'LOADING' });
    api.read(schoolId, signal, owned).then(r => { if (!owned()) return; setRead({ state: 'READY', read: r }); setLook(lookOf(r.settings)); }, error => {
      if (!owned() || abort.signal.aborted) return;
      setRead({ state: error instanceof CardsError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' });
    });
    return () => { abort.abort(); };
  }, [api, schoolId, refresh, shell.phase]);

  const ready = read.state === 'READY' ? read.read : null;
  const showSheet = useCallback(async (result: AttendanceCardIssueResult, data: AttendanceCardsRead, school: string, owned: () => boolean) => {
    const byId = new Map(data.students.map(s => [s.studentProfileId, s]));
    const cards = await Promise.all(result.cards.map(async c => {
      const s = byId.get(c.studentProfileId);
      const name = s ? nameOf(s) : '', initials = s ? initialsOf(s.givenName, s.familyName) : '';
      let photo: string | null = null;
      // The server decided whether this card carries the photo (saved look, photo on file, approval when the school asks for it).
      if (c.printPhoto && s?.hasPhoto) {
        try { const r = await photos.read({ schoolId: school }, s.personId, AbortSignal.timeout(15000), owned); photo = r.photo ? `data:${r.photo.mediaType};base64,${r.photo.data}` : null; } catch { photo = null; }
      }
      return { studentProfileId: c.studentProfileId, name, initials, code: c.code!, photo };
    }));
    if (owned()) setSheet(cards);
  }, [photos]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current || !ready || !look) return;
    sending.current = true; setLock('SENDING'); setOutcome({ kind: 'SENDING' });
    const owned = () => mounted.current && pending.current?.key === request.key, signal = AbortSignal.timeout(30000);
    let next: CardsOutcome = null, keep = false;
    try {
      if (request.op === 'look') {
        await api.configure({ schoolId: request.schoolId, expectedVersion: request.expectedVersion, ...request.look }, request.key, signal, owned);
        next = { kind: 'LOOK_SAVED' };
      } else if (request.op === 'consent') {
        await api.photoConsent(request.schoolId, request.studentProfileId, request.given, request.expectedVersion, request.key, signal, owned);
        next = { kind: 'CONSENT_SAVED' };
      } else if (request.op === 'cancel') {
        await api.cancel(request.schoolId, request.cardId, request.expectedVersion, request.key, signal, owned);
        next = { kind: 'CANCELED' }; setConfirmCancel(null);
      } else {
        const result = await api.print(request.schoolId, request.ids, request.key, signal, owned);
        if (result.replayed) next = { kind: 'REPLAYED' };
        else { await showSheet(result, ready, request.schoolId, () => mounted.current); next = null; }
        setSelected(new Set());
      }
    } catch (error) {
      keep = keepForRetry(error);
      next = { kind: error instanceof CardsError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN' };
    } finally { sending.current = false; }
    if (!mounted.current) return;
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE'); setOutcome(next);
    if (!keep) setRefresh(n => n + 1);
  }, [api, ready, look, showSheet]);

  const start = (request: Request) => {
    if (lock !== 'NONE' || pending.current || !schoolId) return;
    pending.current = { ...request, key: globalThis.crypto.randomUUID(), schoolId };
    void send();
  };
  const effectiveLook = look ?? (ready ? lookOf(ready.settings) : { codeType: 'QR', showPhoto: true, showLogo: true, design: 'CLASSIC', photoApprovalRequired: false } as Look);
  const withoutCard = useMemo(() => ready?.students.filter(s => !s.card).map(s => s.studentProfileId).slice(0, ATTENDANCE_CARD_MAX_PER_PRINT) ?? [], [ready]);

  return <CardsView language={preferences.language} read={read} look={effectiveLook} selected={selected} confirmCancel={confirmCancel} outcome={outcome}
    locked={lock !== 'NONE'} canRetry={lock === 'KEPT'} sheet={sheet}
    onLook={setLook}
    onSaveLook={() => { if (ready) start({ op: 'look', look: effectiveLook, expectedVersion: ready.settings.version }); }}
    onToggle={id => setSelected(prior => { const next = new Set(prior); if (next.has(id)) next.delete(id); else if (next.size < ATTENDANCE_CARD_MAX_PER_PRINT) next.add(id); return next; })}
    onSelectAll={() => setSelected(new Set(withoutCard))} onClear={() => setSelected(new Set())}
    onPrintNew={() => { if (selected.size) start({ op: 'print', ids: [...selected] }); }}
    onAskCancel={id => { if (lock === 'NONE') { setConfirmCancel(id); setOutcome(null); } }}
    onCancel={() => {
      const card = ready?.students.find(s => s.card?.cardId === confirmCancel)?.card;
      if (card) start({ op: 'cancel', cardId: card.cardId, expectedVersion: card.version });
    }}
    onConsent={(studentProfileId, given) => {
      const student = ready?.students.find(s => s.studentProfileId === studentProfileId);
      if (student) start({ op: 'consent', studentProfileId, given, expectedVersion: student.photoConsentVersion });
    }}
    onKeep={() => setConfirmCancel(null)} onReload={() => setRefresh(n => n + 1)} onTryAgain={() => { void send(); }}
    onStop={() => { if (lock !== 'KEPT' || sending.current) return; pending.current = null; setLock('NONE'); setOutcome(null); setRefresh(n => n + 1); }}
    onPrint={() => window.print()} onDone={() => { setSheet(null); setRefresh(n => n + 1); }}/>;
}
