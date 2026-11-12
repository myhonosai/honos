'use client';

import { useLocale } from '../localization/provider';
import React, { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { HqPlatformOverview } from '@hon/contracts';
import { HqOverviewAccessError, loadHqOverview } from '../hq-overview-http';
import { HQ_ART, HQ_NAV, HQ_NAV_GROUPS, HQ_VIEWS, hqGroupContains, hqPageLabel, type HqArt, type HqView } from './catalog';
import { HqIcon } from './icon';
import { SignOutButton } from '../auth/sign-out-button';
import { HonAssistant } from './assistant';
import styles from './hq-modern.module.css';

type AccessState = { kind: 'loading' | 'unauthorized' | 'forbidden' | 'unavailable' } | { kind: 'ready'; overview: HqPlatformOverview };
type HqContextValue = { overview: HqPlatformOverview; view: HqView; art: HqArt; draft: string; setDraft: (value: string) => void; openAssistant: () => void };
const HqContext = createContext<HqContextValue | null>(null);

export function useHqModern(): HqContextValue {
  const value = useContext(HqContext);
  if (!value) throw new Error('HQ content requires the verified HQ shell.');
  return value;
}

/** Decorative artwork, never an indicator of listening, health or executive work. */
export function HonCore({ small = false }: { small?: boolean }): React.ReactElement {
  const { t,text,number,money,date,formattingLocale } = useLocale();
  return <span className={small ? styles.coreSmall : styles.core} role="img" aria-label={t("HON Core")} />;
}

export function HqModernShell({ children }: { children: ReactNode }): React.ReactElement {
  const { t,text,number,money,date,formattingLocale } = useLocale();
  const path = usePathname();
  useEffect(()=>{document.title=(path==='/hq'?t('Overview'):text(hqPageLabel(path)))+' | HON HQ';},[path,t,text]);
  const [access, setAccess] = useState<AccessState>({ kind: 'loading' });
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState<HqView>('modern');
  const [art, setArt] = useState<HqArt>('realistic');
  const [ambientMotion, setAmbientMotion] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(true);
  const [menu, setMenu] = useState(false);
  const [assistant, setAssistant] = useState(false);
  const [draft, setDraft] = useState('');
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLDialogElement>(null);
  const assistantButton = useRef<HTMLButtonElement>(null);
  const assistantOpener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => { setReducedMotion(query.matches); setAmbientMotion(!query.matches); };
    update(); query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    let current = true;
    setAccess({ kind: 'loading' });
    setAssistant(false);
    setDraft('');
    loadHqOverview().then(
      (overview) => { if (current) setAccess({ kind: 'ready', overview }); },
      (error: unknown) => {
        if (current) setAccess({ kind: error instanceof HqOverviewAccessError ? error.status === 401 ? 'unauthorized' : 'forbidden' : 'unavailable' });
      },
    );
    return () => { current = false; };
  }, [revision]);

  useEffect(() => { setMenu(false); setDraft(''); }, [path]);
  useEffect(() => {
    const dialog = drawer.current;
    if (menu && dialog && !dialog.open) dialog.showModal();
    if (!menu && dialog?.open) { dialog.close(); menuButton.current?.focus(); }
  }, [menu]);

  const openAssistant = () => {
    assistantOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setAssistant(true);
  };
  const closeAssistant = () => {
    setAssistant(false);
    requestAnimationFrame(() => {
      const target = assistantOpener.current;
      if (target?.isConnected) target.focus();
      else assistantButton.current?.focus();
    });
  };
  const nav = <>
    <Link href="/hq" className={styles.brand}><strong>{t("HON HQ")}</strong><span>{t("Company control plane")}</span></Link>
    <nav className={styles.navigation} aria-label={t("HQ navigation")}>
      {HQ_NAV.map((item) => {
        const group = HQ_NAV_GROUPS[item.path];
        if (!group) return <Link key={item.path} href={item.path} onClick={() => setMenu(false)} aria-current={(item.path === '/hq' ? path === item.path : path === item.path || path.startsWith(`${item.path}/`)) ? 'page' : undefined}><HqIcon name={item.icon}/>{text(item.title)}</Link>;
        const links = [...(group.overview ? [group.overview] : []), ...group.children];
        return <details className={styles.growthNav} key={`${group.key}:${hqGroupContains(group, path)}`} open={hqGroupContains(group, path)} data-hq-nav-group={group.key}>
          <summary><HqIcon name={group.icon}/><span>{text(group.title)}</span></summary>
          {links.map((child) => <Link key={child.path} href={child.path} onClick={() => setMenu(false)} aria-current={path === child.path || (child !== group.overview && child.path !== '/hq/revenue' && child.path !== '/hq/schools' && path.startsWith(`${child.path}/`)) ? 'page' : undefined}>{child === group.overview ? null : <HqIcon name={child.icon} size={17}/>}{text(child.title)}</Link>)}
        </details>;
      })}
    </nav>
    <footer className={styles.railFooter}><span className={styles.ownerAvatar} aria-hidden="true">{t("HQ")}</span><span>{t("HQ workspace")}</span><SignOutButton label={t("Sign out")} className={styles.signOut}/></footer>
  </>;

  return <div className={styles.shell} data-view={view} data-art={art} data-motion={!reducedMotion && ambientMotion ? 'on' : 'off'}>
    <a className={styles.skip} href="#hq-main">{t("Skip to main content")}</a>
    <aside className={styles.sidebar}>{nav}</aside>
    <dialog ref={drawer} className={styles.drawer} aria-label={t("HQ navigation menu")} onCancel={(event) => { event.preventDefault(); setMenu(false); }} onClick={(event) => { if (event.target === drawer.current) setMenu(false); }}>
      <div><button type="button" className={styles.closeMenu} aria-label={t("Close navigation")} onClick={() => setMenu(false)}><HqIcon name="close"/></button>{nav}</div>
    </dialog>
    <div className={styles.workspace} data-hq-background>
      <header className={styles.topbar}>
        <button ref={menuButton} type="button" className={styles.menuButton} aria-label={t("Open HQ navigation")} aria-expanded={menu} onClick={() => setMenu(true)}><HqIcon name="menu"/></button>
        <div><p className={styles.eyebrow}>HON HQ / {path === '/hq' ? t("Company command center") : text(hqPageLabel(path))}</p><h1>{path === '/hq' ? t("Your company. In command.") : text(hqPageLabel(path))}</h1><p className={styles.subtitle}>{path === '/hq' ? t("One workspace for HON and your executive team.") : t("Your company. One governed workspace.")}</p></div>
        <span className={styles.ownerAvatar} title={t("Company control plane")} aria-label={t("HQ workspace")}>{t("HQ")}</span>
      </header>
      <section className={styles.appearance} data-hq-appearance aria-label={t("HQ appearance")}>
        <div className={styles.appearanceGroup} role="group" aria-label={t("Platform view")}><span>{t("View")}</span>{HQ_VIEWS.map((option) => <button type="button" key={option.key} aria-pressed={view === option.key} onClick={() => setView(option.key)}>{text(option.label)}</button>)}</div>
        <div className={styles.appearanceGroup} role="group" aria-label={t("AI portrait style")}><span>{t("AI Style")}</span>{HQ_ART.map((option) => <button type="button" key={option.key} aria-pressed={art === option.key} onClick={() => setArt(option.key)}>{text(option.label)}</button>)}</div>
        <button type="button" className={styles.motionControl} aria-label={t("Ambient motion")} aria-pressed={!reducedMotion && ambientMotion} disabled={reducedMotion} onClick={() => setAmbientMotion((value) => !value)} title={reducedMotion ? t("Motion is off because your device prefers reduced motion") : t("Pause or resume decorative motion")}><HqIcon name={ambientMotion && !reducedMotion ? 'pause' : 'play'} size={14}/><span>{t("Motion")}</span><small>{!reducedMotion && ambientMotion ? t("On") : t("Off")}</small></button>
        <small>{t("Presentation only")}</small>
      </section>
      {art === 'anime' && <p className={styles.artNotice} role="status">{t("Anime portraits are awaiting approved artwork. Executive identities remain unchanged.")}</p>}
      {access.kind === 'ready' ? <HqContext.Provider value={{ overview: access.overview, art, view, draft, setDraft, openAssistant }}>
        <div className={`${styles.contentLayout} ${assistant ? styles.withAssistant : ''}`}>
          <main id="hq-main" tabIndex={-1} className={styles.main}>{children}</main>
          {assistant && <div className={styles.assistantBackdrop} aria-hidden="true" onClick={closeAssistant}/>}
          {assistant && <HonAssistant context={text(hqPageLabel(path))} onMinimize={closeAssistant}/>}
        </div>
        {(!assistant && path !== '/hq') && <button ref={assistantButton} type="button" className={styles.assistantLauncher} onClick={openAssistant} aria-label={t("Ask HON anywhere")} aria-expanded={false} title={t("Open HON assistant")}><HonCore small/><strong>{t("Ask HON anywhere")}</strong><HqIcon name="expand"/></button>}
      </HqContext.Provider> : <main id="hq-main" tabIndex={-1} className={styles.accessState}>
        <HonCore small/>
        <p className={styles.eyebrow}>{access.kind === 'loading' ? t("Verifying HQ access") : access.kind === 'forbidden' ? t("HQ access denied") : access.kind === 'unauthorized' ? t("Account required") : t("HQ unavailable")}</p>
        <h2>{access.kind === 'loading' ? t("Loading your company workspace…") : access.kind === 'forbidden' ? t("This account has no current HQ authority.") : access.kind === 'unauthorized' ? t("Sign in to verify HQ access.") : t("The HQ overview could not be verified.")}</h2>
        <p role="status">{access.kind === 'loading' ? t("Company information will appear after HQ access is verified.") : t("No cached, sample or inferred company data is displayed.")}</p>
        {access.kind === 'unauthorized' ? <Link href="/auth/login" className={styles.primary}>{t("Sign in to HON")}</Link> : access.kind !== 'loading' && <button type="button" className={styles.primary} onClick={() => setRevision((value) => value + 1)}>{t("Check access again")}</button>}
      </main>}
      <footer className={styles.pageFooter}><HqIcon name="shield" size={16}/><span>{t("HQ remains separate from school CRM. You retain final approval.")}</span><button type="button" onClick={() => { setAccess({ kind: 'loading' }); setRevision((value) => value + 1); }}>{t("Refresh HQ access")}</button></footer>
    </div>
    <nav className={styles.mobileNav} aria-label={t("Mobile HQ navigation")}>
      <Link href="/hq" aria-current={path === '/hq' ? 'page' : undefined}><HqIcon name="home"/><span>{t("Home")}</span></Link>
      <button type="button" disabled={access.kind !== 'ready'} aria-label={assistant ? t("Minimize HON assistant") : t("Expand HON assistant")} aria-expanded={assistant} onClick={assistant ? closeAssistant : openAssistant}><HqIcon name="mic"/><span>{t("HON")}</span></button>
      <Link href="/hq/approvals"><HqIcon name="attention"/><span>{t("Attention")}</span></Link>
      <Link href="/hq/growth"><HqIcon name="growth"/><span>{t("Growth")}</span></Link>
      <button type="button" aria-label={t("More HQ navigation")} aria-expanded={menu} onClick={() => setMenu(true)}><HqIcon name="more"/><span>{t("More")}</span></button>
    </nav>
  </div>;
}
