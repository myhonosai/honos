import React, { type ReactNode } from 'react';
import type { HonInterfaceTheme } from '@hon/design-system';
import type { EntryPhase } from '../school-entry/controller';
import type { StaffReportingSchoolChoice } from '../staff-reporting-schools-http';
import type { OperationalSchoolScope } from '../operational-navigation';
import { SCHOOL_SHELL_EVERYDAY, SCHOOL_SHELL_MOBILE, SCHOOL_SHELL_NAV, SCHOOL_SHELL_SECTIONS, schoolShellActiveItem, schoolShellActiveRoute, schoolShellFooterItems, schoolShellHref,
  schoolShellListed, schoolShellSectionItems, type SchoolShellItem } from './catalog';
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
};
const MODES: readonly HonInterfaceTheme[] = ['big-button', 'modern', 'classic'];
const VIEW_STATE: Record<ShellViewState, ShellKey> = { LOCAL: 'viewLocal', SAVING: 'viewSaving', SAVED: 'viewSaved', ERROR: 'viewError' };

/** Pure presentation. Never reads, commands or derives authority; the selection only becomes the closed URL prefill. */
export function SchoolShellFrame(props: SchoolShellFrameProps): React.ReactElement {
  const { path, language, phase, mode, menuOpen, onMenu, children } = props;
  const tourStep = props.tourStep ?? null, onTour = props.onTour ?? (() => {});
  const tourArea = tourStep === null ? null : (s => s?.kind === 'area' ? s.area.key : null)(SCHOOL_TOUR_STEPS[tourStep]);
  const t = (key: ShellKey) => shellText(language, key);
  const verified = phase === 'READY' ? props.selection : null;
  const active = schoolShellActiveItem(path), activeRoute = schoolShellActiveRoute(path);
  const ended = phase === 'SESSION' || phase === 'IDENTITY';
  // Two levels only (owner, 2026-11-16): the menu lists pages; the tab row shows the current page's tabs.
  const tabRoutes = active ? schoolShellListed(active) : [];
  // Phone "where am I": when the current area is not one of the four bottom shortcuts, the last slot names it.
  const offBar = active && !SCHOOL_SHELL_MOBILE.includes(active.key) ? active : null;
  // Owner direction 2026-11-06: Classic keeps the left sidebar, Modern a top navigation bar with a
  // Menu panel, Big Button large cards. Presentation only; every link is the same closed catalog.
  const sidebar = mode === 'classic';
  // HON waits in the corner on every page except where it is already the main content.
  const honHere = path === '/staff/dashboard' || path === '/staff/hon' || path.startsWith('/staff/hon/');

  // The Menu panel is modal: everything behind it is inert, so keyboard focus stays inside it.
  const modal = (menuOpen && !sidebar) || tourStep !== null;

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

  const navLink = (item: SchoolShellItem) => <a key={item.key} data-nav={item.key} data-everyday={SCHOOL_SHELL_EVERYDAY.includes(item.key) ? 'true' : 'false'}
    href={schoolShellHref(item.routes[0]!, verified)} aria-current={active?.key === item.key ? 'page' : undefined}
    data-tour-current={tourArea !== null && tourArea === (item.section ?? 'settings') ? 'true' : undefined} onClick={() => onMenu(false)}><ShellIcon name={item.key} /><span>{t(item.titleKey)}</span></a>;
  const menuCard = (item: SchoolShellItem) => <li key={item.key} data-menu={item.key} aria-current={active?.key === item.key ? 'true' : undefined}>
    <a href={schoolShellHref(item.routes[0]!, verified)} onClick={() => onMenu(false)}><span className={styles.menuIcon} aria-hidden="true"><ShellIcon name={item.key} size={24} /></span><strong>{t(item.titleKey)}</strong></a>
  </li>;

  const rail = <>
    <a className={styles.brand} href={schoolShellHref(SCHOOL_SHELL_NAV[0]!.routes[0]!, verified)}>
      <span className={styles.brandMark} aria-hidden="true" /><span><strong>{t('brand')}</strong><small>{t('brandTagline')}</small></span>
    </a>
    {sidebar && school}
    <nav className={styles.nav} aria-label={t('primaryNav')}>
      {SCHOOL_SHELL_SECTIONS.map(section => <div key={section.key} className={styles.navSection} role="group" aria-labelledby={`hon-nav-${section.key}`} data-nav-section={section.key}>
        <p className={styles.navHeading} id={`hon-nav-${section.key}`}>{t(section.titleKey)}</p>
        {schoolShellSectionItems(section.key).map(navLink)}
      </div>)}
      <div className={styles.navSection} data-nav-section="footer">{schoolShellFooterItems().map(navLink)}</div>
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
    {tourStep !== null && <><div className={styles.tourScrim} aria-hidden="true" onClick={() => onTour(null)} />
      <SchoolTourDialog language={language} step={tourStep} verified={verified} onStep={onTour} onClose={() => onTour(null)} /></>}
    {menuOpen && !sidebar && tourStep === null && <div className={styles.menuPanel} role="dialog" aria-modal="true" aria-label={t('menuTitle')}>
      <header><strong>{t('menuTitle')}</strong><small>{t('menuLead')}</small>
        <button type="button" className={styles.closeMenu} aria-label={t('closeMenu')} onClick={() => onMenu(false)} autoFocus><ShellIcon name="close" /></button></header>
      {SCHOOL_SHELL_SECTIONS.map(section => <section key={section.key} className={styles.menuSection} aria-labelledby={`hon-menu-${section.key}`} data-menu-section={section.key}>
        <h2 id={`hon-menu-${section.key}`}>{t(section.titleKey)}</h2>
        <ul className={styles.menuGrid}>{schoolShellSectionItems(section.key).map(menuCard)}</ul>
      </section>)}
      <ul className={styles.menuGrid} data-menu-section="footer">{schoolShellFooterItems().map(menuCard)}</ul>
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
