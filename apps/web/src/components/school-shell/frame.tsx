import React, { type ReactNode } from 'react';
import type { HonInterfaceTheme } from '@hon/design-system';
import type { EntryPhase } from '../school-entry/controller';
import type { StaffReportingSchoolChoice } from '../staff-reporting-schools-http';
import type { OperationalSchoolScope } from '../operational-navigation';
import { SCHOOL_SHELL_MOBILE, SCHOOL_SHELL_NAV, schoolShellActiveItem, schoolShellActiveRoute, schoolShellHref } from './catalog';
import { shellText, type ShellKey } from './copy';
import { ShellIcon } from './icons';
import styles from './shell.module.css';

export type ShellViewState = 'LOCAL' | 'SAVING' | 'SAVED' | 'ERROR';
export type SchoolShellFrameProps = {
  path: string; language: string; phase: EntryPhase; selection: OperationalSchoolScope | null; schoolName: string | null;
  choices: readonly StaffReportingSchoolChoice[]; mode: HonInterfaceTheme; viewState: ShellViewState; menuOpen: boolean;
  onMode: (mode: HonInterfaceTheme) => void; onMenu: (open: boolean) => void; onSwitch: () => void; onChoose: (schoolId: string) => void; onRestore: () => void;
  utility?: ReactNode; children?: ReactNode;
};
const MODES: readonly HonInterfaceTheme[] = ['big-button', 'modern', 'classic'];
const VIEW_STATE: Record<ShellViewState, ShellKey> = { LOCAL: 'viewLocal', SAVING: 'viewSaving', SAVED: 'viewSaved', ERROR: 'viewError' };

/** Pure presentation. Never reads, commands or derives authority; the selection only becomes the closed URL prefill. */
export function SchoolShellFrame(props: SchoolShellFrameProps): React.ReactElement {
  const { path, language, phase, mode, menuOpen, onMenu, children } = props;
  const t = (key: ShellKey) => shellText(language, key);
  const verified = phase === 'READY' ? props.selection : null;
  const active = schoolShellActiveItem(path), activeRoute = schoolShellActiveRoute(path);
  const ended = phase === 'SESSION' || phase === 'IDENTITY';
  // Owner direction 2026-11-06: Classic keeps the left sidebar, Modern a top navigation bar with a
  // Menu panel, Big Button large cards. Presentation only; every link is the same closed catalog.
  const sidebar = mode === 'classic';
  // HON waits in the corner on every page except where it is already the main content.
  const honHere = path === '/staff/dashboard' || path === '/staff/hon' || path.startsWith('/staff/hon/');

  // The Menu panel is modal: everything behind it is inert, so keyboard focus stays inside it.
  const modal = menuOpen && !sidebar;

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
        aria-current={active?.key === item.key ? 'page' : undefined} onClick={() => onMenu(false)}>
        <ShellIcon name={item.key} /><span>{t(item.titleKey)}</span></a>)}
    </nav>
    <footer className={styles.railFoot}>
      <a href="/settings/language-region">{t('account')}</a>
      <a href="/hq">{t('hq')}</a>
    </footer>
  </>;

  return <div className={styles.shell} data-hon-ui="school" data-hon-mode={mode} data-hon-layout={sidebar ? 'sidebar' : mode === 'modern' ? 'topnav' : 'cards'}>
    <a className={styles.skip} href="#hon-main" inert={modal}>{t('skip')}</a>
    <aside className={styles.rail} data-drawer={menuOpen ? 'open' : 'closed'} inert={modal}>
      <button type="button" className={styles.closeMenu} aria-label={t('closeMenu')} onClick={() => onMenu(false)}><ShellIcon name="close" /></button>
      {rail}
    </aside>
    {menuOpen && <div className={styles.scrim} aria-hidden="true" onClick={() => onMenu(false)} />}
    {modal && <div className={styles.menuPanel} role="dialog" aria-modal="true" aria-label={t('menuTitle')}>
      <header><strong>{t('menuTitle')}</strong><small>{t('menuLead')}</small>
        <button type="button" className={styles.closeMenu} aria-label={t('closeMenu')} onClick={() => onMenu(false)} autoFocus><ShellIcon name="close" /></button></header>
      <ul className={styles.menuGrid}>
        {SCHOOL_SHELL_NAV.map(item => <li key={item.key} data-menu={item.key} aria-current={active?.key === item.key ? 'true' : undefined}>
          <a href={schoolShellHref(item.routes[0]!, verified)} onClick={() => onMenu(false)}><span className={styles.menuIcon} aria-hidden="true"><ShellIcon name={item.key} size={24} /></span><strong>{t(item.titleKey)}</strong></a>
          <ul>{item.routes.slice(1, 5).map(route => <li key={route.href}><a href={schoolShellHref(route, verified)} onClick={() => onMenu(false)}>{t(route.titleKey)}</a></li>)}</ul>
        </li>)}
      </ul>
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
      {active && active.routes.length > 1 && <nav className={styles.tabs} aria-label={t('sectionNav')}>
        {active.routes.map(route => <a key={route.href} href={schoolShellHref(route, verified)} aria-current={activeRoute?.href === route.href ? 'page' : undefined}>{t(route.titleKey)}</a>)}
      </nav>}
      <div id="hon-main" tabIndex={-1} className={styles.main}>{children}</div>
    </div>
    {!honHere && <a inert={modal} className={styles.honLauncher} href="/staff/hon" aria-label={t('askHon')} title={t('honLauncher')}>
      <img src="/ai/hon-core.webp" alt="" width={44} height={44} /><span>{t('askHon')}</span></a>}
    <nav className={styles.mobileNav} aria-label={t('mobileNav')} inert={modal}>
      {SCHOOL_SHELL_MOBILE.map(key => { const item = SCHOOL_SHELL_NAV.find(candidate => candidate.key === key)!;
        return <a key={key} href={schoolShellHref(item.routes[0]!, verified)} aria-current={active?.key === key ? 'page' : undefined}><ShellIcon name={key} /><span>{t(item.titleKey)}</span></a>; })}
      <button type="button" aria-expanded={menuOpen} onClick={() => onMenu(true)}><ShellIcon name="more" /><span>{t('more')}</span></button>
    </nav>
  </div>;
}
