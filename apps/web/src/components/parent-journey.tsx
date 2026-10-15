'use client';
import Link from 'next/link';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { HON_INTERFACE_THEMES, DEFAULT_HON_INTERFACE_THEME, type HonInterfaceTheme } from '@hon/design-system';
import type { ParentJourneyView, JourneyChild, JourneyList } from '@hon/contracts';
import { loadParentJourney, ParentJourneyAccessError } from './parent-journey-http';
import s from './parent-journey.module.css';

function dateTime(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
function label(value: string) { return value.toLowerCase().replaceAll('_', ' '); }
function Unavailable({ children }: { children: React.ReactNode }) { return <div className={s.unavailable}><strong>Unavailable</strong><p>{children}</p></div>; }
function ReadList<T>({ list, empty, unavailable, render }: { list: JourneyList<T>; empty: string; unavailable: string; render: (item: T, index: number) => React.ReactNode }) {
  if (list.status === 'UNAVAILABLE') return <Unavailable>{unavailable}</Unavailable>;
  return <>{list.items.length === 0 ? <p className={s.empty}>{empty}</p> : <ul className={s.list}>{list.items.map((item, i) => <li key={i}>{render(item, i)}</li>)}</ul>}{list.limited && <p className={s.subtle}>This is a limited first page. More authorized records may exist; they are not counted or shown here.</p>}</>;
}
export function JourneyChildDetails({ child, from, to }: { child: JourneyChild; from: string; to: string }) {
  return <div className={s.sections}>
    <section aria-labelledby="progress-heading" className={s.card}><p className={s.eyebrow}>CURRENT PROGRAM & RANK</p><h2 id="progress-heading">What {child.name} is working toward</h2>
      {!child.profileAvailable ? <Unavailable>No current active student profile is available for this child.</Unavailable> : child.programs.length === 0 ? <p className={s.empty}>No active curriculum enrollment is returned for this child. Current program and rank are unavailable.</p> : child.programs.map((p, i) => <article key={i} className={s.program}><h3>{p.name}</h3><p>Current rank: <strong>{p.rank ?? 'Unavailable — no current rank returned'}</strong></p>
        <ReadList list={p.requirements} empty="No current-rank requirements are returned. No progress is inferred." unavailable="The parent requirement read API is not available." render={r => <><div className={s.row}><strong>{r.label}</strong><span className={s.badge}>{r.status === null ? 'Not recorded' : label(r.status)}</span></div><p className={s.subtle}>{label(r.kind)} · {r.required ? 'Required' : 'Optional'}{r.recordedAt && <> · Recorded {dateTime(r.recordedAt)}</>}</p></>}/>
      </article>)}<p className={s.notice}>Human-recorded observations only. MET or PASSED is not testing approval, readiness, promotion, or a guarantee. No progress percentage is inferred.</p>
    </section>
    <section aria-labelledby="schedule-heading" className={s.card}><p className={s.eyebrow}>AUTHORIZED BOOKINGS</p><h2 id="schedule-heading">Schedule for this child</h2><p className={s.subtle}>{dateTime(from)} to {dateTime(to)}. Times use your device’s time zone.</p>
      <ReadList list={child.schedule} empty="No bookings for this child are returned in this 30-day window." unavailable="The authorized schedule cannot currently be read or uniquely matched to this child. No sibling schedule is substituted." render={b => <><div className={s.row}><strong>{b.name}</strong><span className={s.badge}>{label(b.bookingStatus)}</span></div><p>{dateTime(b.startsAt)} – {dateTime(b.endsAt)}</p><p className={s.subtle}>{b.program} · {label(b.kind)} · Session {label(b.sessionStatus)}{b.room && <> · {b.room}</>}</p></>}/>
      <p className={s.subtle}>Self-service booking is unavailable here. This page cannot book, cancel or check in a class.</p>
    </section>
    <section aria-labelledby="achievements-heading" className={s.card}><p className={s.eyebrow}>SHARED RECOGNITION</p><h2 id="achievements-heading">Human-recorded achievements</h2>
      <ReadList list={child.achievements} empty="No currently visible achievements are returned for this child." unavailable="Visible achievements cannot currently be read for this child. No award is assumed." render={a => <><h3>{a.name}</h3><p className={s.subtle}>Awarded {a.awardedOn}</p><p className={s.description}>{a.description}</p></>}/><p className={s.subtle}>Only recognition explicitly shared by school staff. Private reasons and revision history are not shown.</p>
    </section>
  </div>;
}
export function ParentJourney() {
  const [theme, setTheme] = useState<HonInterfaceTheme>(DEFAULT_HON_INTERFACE_THEME);
  const [view, setView] = useState<ParentJourneyView | null>(null), [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [accessLost, setAccessLost] = useState(false);
  const generation = useRef(0), pending = useRef<AbortController | null>(null);
  const clear = useCallback(() => { ++generation.current; pending.current?.abort(); pending.current = null; setView(null); setSelected(0); setBusy(false); }, []);
  const load = useCallback(async () => {
    const token = ++generation.current; pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    setView(null); setSelected(0); setBusy(true); setError(''); setAccessLost(false);
    try { const data = await loadParentJourney(controller.signal); if (generation.current === token) setView(data); }
    catch (e) { if (generation.current === token) { setView(null); setError(e instanceof Error && e.name !== 'AbortError' ? e.message : 'Student Journey is unavailable.'); setAccessLost(e instanceof ParentJourneyAccessError); } }
    finally { if (generation.current === token) { setBusy(false); pending.current = null; } }
  }, []);
  useEffect(() => {
    void load();
    const hide = () => { clear(); setError('Family content is hidden. Return to this page to reverify access.'); };
    const visibility = () => { if (document.visibilityState === 'hidden') hide(); else void load(); };
    const focus = () => { if (document.visibilityState !== 'hidden') void load(); };
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible' && document.hasFocus()) void load(); }, 60000);
    document.addEventListener('visibilitychange', visibility); window.addEventListener('blur', hide); window.addEventListener('focus', focus); window.addEventListener('pagehide', hide);
    return () => { ++generation.current; pending.current?.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('blur', hide); window.removeEventListener('focus', focus); window.removeEventListener('pagehide', hide); };
  }, [load, clear]);
  const child = view?.children[selected];
  return <main className={`theme-${theme} ${s.page}`}><div className={s.shell}>
    <nav className={s.nav} aria-label="Family navigation"><Link href="/parent/journey" aria-current="page" className={s.wordmark}>HON <span>Family Journey</span></Link><Link href="/parent/documents" prefetch={false}>Document desk</Link></nav>
    <header className={s.header}><p className={s.eyebrow}>YOUR FAMILY · VERIFIED READS ONLY</p><h1>Every step, without the guesswork.</h1><p>Your child’s current curriculum, authorized bookings and shared recognition. No private staff notes, family contacts, co-parent evidence or billing details.</p></header>
    <section className={s.controls} aria-label="Presentation and access"><div className={s.themes}><span>Presentation</span>{HON_INTERFACE_THEMES.map(t => <button key={t.id} type="button" aria-pressed={theme === t.id} onClick={() => setTheme(t.id)}>{t.label}</button>)}</div><button type="button" disabled={busy} onClick={() => void load()}>{busy ? 'Verifying family access…' : 'Refresh verified Journey'}</button></section>
    <div aria-live="polite" aria-atomic="true">{busy && <p className={s.state} role="status">Loading Student Journey from your current verified family scope. No previous family content is retained.</p>}{error && <div className={s.error} role="alert"><strong>{accessLost ? 'Family access unavailable' : 'No verified result shown'}</strong><p>{error}</p>{accessLost && <Link href="/auth/login" prefetch={false}>Sign in again</Link>}</div>}</div>
    {!busy && view && <><div className={s.verified}><strong>Verified family view</strong><span>{label(view.accessLevel)} · Updated {dateTime(view.generatedAt)}</span></div>
      {view.children.length === 0 ? <section className={s.card}><h2>No authorized students returned</h2><p>No child record is invented or selected from a URL. Ask your school to confirm your family access.</p></section> : <section className={s.childPicker} aria-label="Choose an authorized child"><h2>Choose your child</h2><div>{view.children.map((c, i) => <button type="button" key={i} aria-pressed={selected === i} onClick={() => setSelected(i)}>{c.name}</button>)}</div><p className={s.subtle}>Choices come only from this live family read. Selecting a child sends no identifier or request.</p></section>}
      {child && <JourneyChildDetails child={child} from={view.from} to={view.to}/>}
      <div className={s.sections}><section className={s.card}><p className={s.eyebrow}>FAMILY DOCUMENTS</p><h2>Current shared documents</h2><ReadList list={view.documents} empty="No current parent document publications are returned." unavailable="Current family document publications cannot be read." render={d => <><strong>{d.title}</strong><p className={s.subtle}>Published {dateTime(d.publishedAt)}</p></>}/><Unavailable>Document receipt listing is not available in the existing parent API. Publication does not mean acknowledgement; no receipt status is inferred.</Unavailable><Link href="/parent/documents" prefetch={false} className={s.flowLink}>Open the existing document review & acknowledgement flow</Link><p className={s.subtle}>The document desk verifies its own scope and requires an explicit acknowledgement. This Journey page does not sign or acknowledge anything.</p></section>
      <section className={s.card}><p className={s.eyebrow}>PLANNED ABSENCES</p><h2>Absence requests & status</h2><Unavailable>The existing parent API has no planned-absence read endpoint. Requests, approval status and absence history are not shown or inferred.</Unavailable><p className={s.subtle}>Absence self-service is not connected here. No request, booking cancellation or makeup is submitted.</p></section></div>
    </>}
    <footer className={s.footer}>Read-only family space. No AI, voice, action execution, messages or payments are initiated here.</footer>
  </div></main>;
}
