'use client';
import React, { useEffect, useState } from 'react';
import type { OperationalSchoolScope } from '../operational-navigation';
import { SCHOOL_SHELL_NAV, schoolShellGroups, schoolShellHref, schoolShellListed, type SchoolShellItem } from './catalog';
import { shellText } from './copy';
import { ShellIcon } from './icons';
import { tourCopy } from './tour-copy';
import styles from './shell.module.css';

/**
 * Guided tour (owner, 2026-11-14): one short step per menu area, in menu order. Presentation only: it reads the closed
 * catalog, never a school record, and opening an area is an ordinary link the destination re-authorizes.
 */
export const SCHOOL_TOUR_OPEN_EVENT = 'hon:school-tour-open';
export const SCHOOL_TOUR_SEEN_KEY = 'hon.school-tour.v1';
const SCHOOL_TOUR_SEEN_EVENT = 'hon:school-tour-seen';
export type SchoolTourStep = { kind: 'welcome' } | { kind: 'area'; item: SchoolShellItem } | { kind: 'finish' };
export const SCHOOL_TOUR_STEPS: readonly SchoolTourStep[] = [{ kind: 'welcome' }, ...SCHOOL_SHELL_NAV.map(item => ({ kind: 'area' as const, item })), { kind: 'finish' }];

export function openSchoolTour(): void { window.dispatchEvent(new Event(SCHOOL_TOUR_OPEN_EVENT)); }
export function markSchoolTourSeen(): void {
  try { window.localStorage.setItem(SCHOOL_TOUR_SEEN_KEY, 'seen'); } catch { /* per-device convenience only */ }
  window.dispatchEvent(new Event(SCHOOL_TOUR_SEEN_EVENT));
}
function schoolTourSeen(): boolean { try { return window.localStorage.getItem(SCHOOL_TOUR_SEEN_KEY) === 'seen'; } catch { return true; } }

/** What an area holds: its named groups, or its first pages when it is short enough to show flat. */
export function schoolTourInside(item: SchoolShellItem, language: string): string[] {
  const groups = schoolShellGroups(item);
  return (groups.length > 0 ? groups : schoolShellListed(item).map(route => route.titleKey)).slice(0, 6).map(key => shellText(language, key));
}

export function SchoolTourDialog({ language, step, verified, onStep, onClose }: {
  language: string; step: number; verified: OperationalSchoolScope | null; onStep: (step: number) => void; onClose: () => void;
}): React.ReactElement {
  const c = tourCopy(language);
  const index = Math.min(Math.max(step, 0), SCHOOL_TOUR_STEPS.length - 1);
  const current = SCHOOL_TOUR_STEPS[index]!;
  const last = index === SCHOOL_TOUR_STEPS.length - 1;
  const area = current.kind === 'area' ? current.item : null;
  const title = area ? shellText(language, area.titleKey) : current.kind === 'welcome' ? c.welcomeTitle : c.finishTitle;
  const body = area ? c.areas[area.key] : current.kind === 'welcome' ? c.welcomeBody : c.finishBody;
  const inside = area ? schoolTourInside(area, language) : [];
  return <div className={styles.tour} role="dialog" aria-modal="true" aria-labelledby="hon-tour-title" aria-describedby="hon-tour-body"
    data-school-tour="" data-tour-step={area?.key ?? current.kind}>
    <header>
      <small>{c.label} · {c.stepOf.replace('{n}', String(index + 1)).replace('{total}', String(SCHOOL_TOUR_STEPS.length))}</small>
      <button type="button" className={styles.closeMenu} aria-label={c.close} onClick={onClose}><ShellIcon name="close" /></button>
    </header>
    <div className={styles.tourBody}>
      <span className={styles.menuIcon} aria-hidden="true"><ShellIcon name={area?.key ?? 'home'} size={24} /></span>
      <div>
        <h2 id="hon-tour-title">{title}</h2>
        <p id="hon-tour-body">{body}</p>
        {inside.length > 0 && <><p className={styles.tourInside}>{c.inside}</p><ul data-tour-inside="">{inside.map(name => <li key={name}>{name}</li>)}</ul></>}
        {area && <a className={styles.tourOpen} href={schoolShellHref(area.routes[0]!, verified)} onClick={onClose}>
          {c.open.replace('{area}', title)}<span aria-hidden="true"> →</span></a>}
      </div>
    </div>
    <ol className={styles.tourDots} aria-hidden="true">{SCHOOL_TOUR_STEPS.map((_, n) => <li key={n} data-on={n === index ? 'true' : undefined} />)}</ol>
    <footer>
      <button type="button" onClick={() => onStep(index - 1)} disabled={index === 0}>{c.back}</button>
      <button type="button" data-tour-next="" autoFocus onClick={() => (last ? onClose() : onStep(index + 1))}>{last ? c.done : c.next}</button>
    </footer>
  </div>;
}

export function TourInviteView({ language, onStart, onDismiss }: { language: string; onStart: () => void; onDismiss: () => void }): React.ReactElement {
  const c = tourCopy(language);
  return <aside className={styles.tourInvite} data-tour-invite="">
    <div><strong>{c.inviteTitle}</strong><span>{c.inviteLine}</span></div>
    <div><button type="button" onClick={onStart}>{c.start}</button><button type="button" onClick={onDismiss}>{c.notNow}</button></div>
  </aside>;
}

/** Home's one-time invitation; remembered per device only, and gone once the tour has been opened or dismissed. */
export function TourInvite({ language }: { language: string }): React.ReactElement | null {
  const [show, setShow] = useState(false);
  useEffect(() => {
    setShow(!schoolTourSeen());
    const hide = () => setShow(false);
    window.addEventListener(SCHOOL_TOUR_OPEN_EVENT, hide); window.addEventListener(SCHOOL_TOUR_SEEN_EVENT, hide);
    return () => { window.removeEventListener(SCHOOL_TOUR_OPEN_EVENT, hide); window.removeEventListener(SCHOOL_TOUR_SEEN_EVENT, hide); };
  }, []);
  if (!show) return null;
  return <TourInviteView language={language} onStart={openSchoolTour} onDismiss={() => { markSchoolTourSeen(); setShow(false); }} />;
}
