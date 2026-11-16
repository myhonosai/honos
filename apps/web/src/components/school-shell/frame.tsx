import React, { useEffect, useState, type ReactNode } from 'react';
import type { HonInterfaceTheme } from '@hon/design-system';
import type { EntryPhase } from '../school-entry/controller';
import type { StaffReportingSchoolChoice } from '../staff-reporting-schools-http';
import type { OperationalSchoolScope } from '../operational-navigation';
import { SCHOOL_SHELL_MOBILE, SCHOOL_SHELL_NAV, schoolShellActiveItem, schoolShellActiveRoute, schoolShellGroups, schoolShellHref, schoolShellListed } from './catalog';
import { shellText, type ShellKey } from './copy';
import { ShellIcon } from './icons';
import { SCHOOL_TOUR_STEPS, SchoolTourDialog } from './tour';
import { tourCopy } from './tour-copy';
import { SignOutButton } from '../auth/sign-out-button';
import styles from './shell.module.css';

export type ShellViewState = 'LOCAL' | 'SAVING' | 'SAVED' | 'ERROR';
export type SchoolShellFrameProps = {
  path: string; language: string; phase: EntryPhase; selection: OperationalSchoolScope | null; schoolName: string | null;
  choices: readonly StaffReportingSchoolChoice[]; mode: HonInterfaceTheme; viewState: ShellViewState; menuOpen: boolean;
  onMode: (mode: HonInterfaceTheme) => void; onMenu: (open: boolean) => void; onSwitch: () => void; onChoose: (schoolId: string) => void; onRestore: () => void;
  utility?: ReactNode; children?: ReactNode;
  /** Guided tour step, or null when closed. */
  tourStep?: number | null; onTour?: (step: number | null) => void;
  /** Screensaver over the whole app (away or idle). The page behind it stays mounted and inert. */
  asleep?: boolean; onWake?: () => void;
};
const MODES: readonly HonInterfaceTheme[] = ['big-button', 'modern', 'classic'];
const VIEW_STATE: Record<ShellViewState, ShellKey> = { LOCAL: 'viewLocal', SAVING: 'viewSaving', SAVED: 'viewSaved', ERROR: 'viewError' };

/** Pure presentation. Never reads, commands or derives authority; the selection only becomes the closed URL prefill. */
export function SchoolShellFrame(props: SchoolShellFrameProps): React.ReactElement {
  const { path, language, phase, mode, menuOpen, onMenu, children } = props;
  const tourStep = props.tourStep ?? null, onTour = props.onTour ?? (() => {});
  const tourArea = tourStep === null ? null : (s => s?.kind === 'area' ? s.item.key : null)(SCHOOL_TOUR_STEPS[tourStep]);
  const t = (key: ShellKey) => shellText(language, key);
  const verified = phase === 'READY' ? props.selection : null;
  const active = schoolShellActiveItem(path), activeRoute = schoolShellActiveRoute(path);
  const ended = phase === 'SESSION' || phase === 'IDENTITY';
  // Long areas show their groups first, then only the pages of the current group.
  const groups = active ? schoolShellGroups(active) : [];
  const activeGroup = activeRoute?.group ?? null;
  const listed = active ? schoolShellListed(active) : [];
  const tabRoutes = activeGroup ? listed.filter(route => route.group === activeGroup) : listed;
  // Phone "where am I": when the current area is not one of the four bottom shortcuts, the last slot names it.
  const offBar = active && !SCHOOL_SHELL_MOBILE.includes(active.key) ? active : null;
  // Owner direction 2026-11-06: Classic keeps the left sidebar, Modern a top navigation bar with a
  // Menu panel, Big Button large cards. Presentation only; every link is the same closed catalog.
  const sidebar = mode === 'classic';
  // HON waits in the corner on every page except where it is already the main content.
  const honHere = path === '/staff/dashboard' || path === '/staff/hon' || path.startsWith('/staff/hon/');

  // The Menu panel is modal: everything behind it is inert, so keyboard focus stays inside it.
  const asleep = props.asleep ?? false, onWake = props.onWake ?? (() => {});
  const modal = (menuOpen && !sidebar) || tourStep !== null || asleep;

  const school = <section className={styles.school} aria-label={t('schoolRegion')} data-phase={phase}>
    <span className={styles.schoolMark} aria-hidden="true"><ShellIcon name="school" /></span>
    <div className={styles.schoolText}>
      {phase === 'READY' ? <strong key="school-name" data-shell-private="">{props.schoolName ?? t('READY')}</strong> : <strong key="school-phase">{t(phase)}</strong>}
      <small>{phase === 'READY' ? t('verified') : t('schoolLabel')}</small>
    </div>
    {ended ? <a className={styles.schoolAction} href="/auth/login">{t('signIn')}</a>
      : phase === 'CONCEALED' ? <button type="button" className={styles.schoolAction} onClick={props.onRestore}>{t('showSchool')}</button>
        : phase === 'DENIED' || phase === 'UNAVAILABLE' ? <button type="button" className={styles.schoolAction} onClick={props.onSwitch}>{t('recheck')}</button>
          : phase === 'READY' ? <button type="button" className={styles.schoolAction} onClick={props.onSwitch} aria-label={t('switchSchool')}><ShellIcon name="swap" /><span>{t('switchSchool')}</span></button>
            : null}
    {phase === 'CHOICE' && props.choices.length > 0 && <ul className={styles.choices} aria-label={t('chooseSchool')} data-shell-private="">
      {props.choices.map(choice => <li key={choice.schoolId}><button type="button" onClick={() => props.onChoose(choice.schoolId)}>
        <strong>{choice.schoolName}</strong><small>{choice.organizationName}</small></button></li>)}
    </ul>}
  </section>;

  const rail = <>
    <a className={styles.brand} href={schoolShellHref(SCHOOL_SHELL_NAV[0]!.routes[0]!, verified)}>
      <span className={styles.brandMark} aria-hidden="true" /><span><strong>{t('brand')}</strong><small>{t('brandTagline')}</small></span>
    </a>
    {sidebar && school}
    <nav className={styles.nav} aria-label={t('primaryNav')}>
      {SCHOOL_SHELL_NAV.map(item => <a key={item.key} data-nav={item.key} href={schoolShellHref(item.routes[0]!, verified)}
        aria-current={active?.key === item.key ? 'page' : undefined} data-tour-current={tourArea === item.key ? 'true' : undefined} onClick={() => onMenu(false)}>
        <ShellIcon name={item.key} /><span>{t(item.titleKey)}</span></a>)}
    </nav>
    {/* Top bar only: the areas that do not fit stay one click away in the Menu instead of silently disappearing. */}
    {mode === 'modern' && <button type="button" className={styles.navMore} data-nav-more="" aria-expanded={menuOpen} onClick={() => onMenu(true)}>
      <ShellIcon name="more" /><span>{t('more')}</span></button>}
    <footer className={styles.railFoot}>
      <a href="/settings/language-region">{t('account')}</a>
      <a href="/hq">{t('hq')}</a>
      <SignOutButton label={t('signOut')} className={styles.signOut} />
    </footer>
  </>;

  return <div className={styles.shell} data-hon-ui="school" data-hon-mode={mode} data-hon-layout={sidebar ? 'sidebar' : mode === 'modern' ? 'topnav' : 'cards'}>
    <a className={styles.skip} href="#hon-main" inert={modal}>{t('skip')}</a>
    <aside className={styles.rail} data-drawer={menuOpen ? 'open' : 'closed'} inert={modal}>
      <button type="button" className={styles.closeMenu} aria-label={t('closeMenu')} onClick={() => onMenu(false)}><ShellIcon name="close" /></button>
      {rail}
    </aside>
    {menuOpen && <div className={styles.scrim} aria-hidden="true" onClick={() => onMenu(false)} />}
    {asleep && <SchoolScreensaver language={language} schoolName={phase === 'READY' ? props.schoolName ?? t('READY') : t('brand')} onWake={onWake} />}
    {tourStep !== null && <div inert={asleep} style={{ display: 'contents' }}><div className={styles.tourScrim} aria-hidden="true" onClick={() => onTour(null)} />
      <SchoolTourDialog language={language} step={tourStep} verified={verified} onStep={onTour} onClose={() => onTour(null)} /></div>}
    {menuOpen && !sidebar && tourStep === null && <div className={styles.menuPanel} role="dialog" aria-modal="true" aria-label={t('menuTitle')} inert={asleep}>
      <header><strong>{t('menuTitle')}</strong><small>{t('menuLead')}</small>
        <button type="button" className={styles.closeMenu} aria-label={t('closeMenu')} onClick={() => onMenu(false)} autoFocus><ShellIcon name="close" /></button></header>
      <ul className={styles.menuGrid}>
        {SCHOOL_SHELL_NAV.map(item => <li key={item.key} data-menu={item.key} aria-current={active?.key === item.key ? 'true' : undefined}>
          <a href={schoolShellHref(item.routes[0]!, verified)} onClick={() => onMenu(false)}><span className={styles.menuIcon} aria-hidden="true"><ShellIcon name={item.key} size={24} /></span><strong>{t(item.titleKey)}</strong></a>
          <ul>{schoolShellListed(item).map(route => <li key={route.href}><a href={schoolShellHref(route, verified)} onClick={() => onMenu(false)}>{t(route.titleKey)}</a></li>)}</ul>
        </li>)}
      </ul>
      <footer className={styles.menuFoot}>
        <button type="button" className={styles.tourStart} data-tour-start="" onClick={() => { onMenu(false); onTour(0); }}>{tourCopy(language).start}</button>
        <SignOutButton label={t('signOut')} className={styles.signOut} /></footer>
    </div>}
    <div className={styles.workspace} inert={modal}>
      <header className={styles.topbar}>
        <button type="button" className={styles.menuButton} aria-label={t('openMenu')} aria-expanded={menuOpen} onClick={() => onMenu(true)}><ShellIcon name="menu" /></button>
        <div className={styles.titleBlock}>
          <p className={styles.eyebrow}>{active ? t(active.titleKey) : t('brand')}</p>
          <p className={styles.pageTitle}>{activeRoute ? t(activeRoute.titleKey) : t('brand')}</p>
        </div>
        <div className={styles.views} role="group" aria-label={t('view')} title={t('viewHelp')}>
          {MODES.map(value => <button type="button" key={value} aria-pressed={mode === value} aria-label={`${t('view')}: ${t(value)}`} onClick={() => props.onMode(value)}>{t(value)}</button>)}
          <small role="status">{t(VIEW_STATE[props.viewState])}</small>
        </div>
        {props.utility && <div className={styles.locale}>{props.utility}</div>}
        <a className={styles.iconButton} href="/staff/search" aria-label={t('search')} title={t('search')}><ShellIcon name="search" /></a>
      </header>
      {!sidebar && <div className={styles.schoolStrip}>{school}</div>}
      {active && groups.length > 0 && <nav className={styles.groups} aria-label={t('groupNav')} data-shell-groups="">
        {groups.map(group => { const first = active.routes.find(route => route.group === group)!;
          return <a key={group} href={schoolShellHref(first, verified)} aria-current={activeGroup === group ? 'true' : undefined}>{t(group)}</a>; })}
      </nav>}
      {active && tabRoutes.length > 1 && <nav className={styles.tabs} aria-label={t('sectionNav')} data-shell-tabs="">
        {tabRoutes.map(route => <a key={route.href} href={schoolShellHref(route, verified)} aria-current={activeRoute?.href === route.href ? 'page' : undefined}>{t(route.titleKey)}</a>)}
      </nav>}
      <div id="hon-main" tabIndex={-1} className={styles.main}>{children}</div>
    </div>
    {!honHere && <a inert={modal} className={styles.honLauncher} href="/staff/hon" aria-label={t('askHon')} title={t('honLauncher')}>
      <img src="/ai/hon-core.webp" alt="" width={44} height={44} /><span>{t('askHon')}</span></a>}
    <nav className={styles.mobileNav} aria-label={t('mobileNav')} inert={modal}>
      {SCHOOL_SHELL_MOBILE.map(key => { const item = SCHOOL_SHELL_NAV.find(candidate => candidate.key === key)!;
        return <a key={key} href={schoolShellHref(item.routes[0]!, verified)} aria-current={active?.key === key ? 'page' : undefined}><ShellIcon name={key} /><span>{t(item.titleKey)}</span></a>; })}
      {offBar ? <button type="button" aria-expanded={menuOpen} aria-current="true" aria-label={`${t('more')}: ${t('currentArea')} ${t(offBar.titleKey)}`} data-mobile-current="" onClick={() => onMenu(true)}>
        <ShellIcon name={offBar.key} /><span>{t(offBar.titleKey)}</span></button>
        : <button type="button" aria-expanded={menuOpen} onClick={() => onMenu(true)}><ShellIcon name="more" /><span>{t('more')}</span></button>}
    </nav>
  </div>;
}

/** Clock shown on the screensaver; device time, minutes only. */
function ScreensaverClock({ language }: { language: string }): React.ReactElement {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 15_000); return () => window.clearInterval(timer); }, []);
  let time: string;
  try { time = now.toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit' }); } catch { time = now.toLocaleTimeString(); }
  return <time className={styles.screensaverClock} dateTime={now.toISOString()} suppressHydrationWarning>{time}</time>;
}

/**
 * The screensaver (owner request 2026-11-16, replaces "School hidden while away"). Shows only the
 * HON mark, the school name the shell already shows, and the time: never page content. Any tap,
 * click or key lifts it; the same page and school are underneath.
 */
export function SchoolScreensaver({ language, schoolName, onWake }: { language: string; schoolName: string; onWake: () => void }): React.ReactElement {
  const t = (key: ShellKey) => shellText(language, key);
  // Focus goes back to where the viewer was once the screensaver lifts.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => { if (before?.isConnected) before.focus({ preventScroll: true }); };
  }, []);
  return <div className={styles.screensaver} role="dialog" aria-modal="true" aria-label={t('screensaverLabel')} data-screensaver=""
    onClick={onWake} onKeyDown={onWake}>
    <span className={styles.screensaverGlow} aria-hidden="true" />
    <img className={styles.screensaverMark} src="/ai/hon-core.webp" alt="" width={132} height={132} />
    <ScreensaverClock language={language} />
    <p className={styles.screensaverSchool}>{schoolName}</p>
    <button type="button" className={styles.screensaverTap} autoFocus onClick={onWake}>{t('screensaverTap')}</button>
    <small className={styles.screensaverHint}>{t('screensaverHint')}</small>
  </div>;
}
