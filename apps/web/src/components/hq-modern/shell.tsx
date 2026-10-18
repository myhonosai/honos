'use client';

import React, { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { HqPlatformOverview } from '@hon/contracts';
import { HqOverviewAccessError, loadHqOverview } from '../hq-overview-http';
import { HQ_ART, HQ_GROWTH, HQ_NAV, HQ_VIEWS, hqPageLabel, type HqArt, type HqView } from './catalog';
import { HqIcon } from './icon';
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

/** Static artwork, never an indicator of listening, health or executive work. */
export function HonCore({ small = false }: { small?: boolean }): React.ReactElement {
  return <span className={small ? styles.coreSmall : styles.core} role="img" aria-label="HON Core" />;
}

export function HqModernShell({ children }: { children: ReactNode }): React.ReactElement {
  const path = usePathname();
  const [access, setAccess] = useState<AccessState>({ kind: 'loading' });
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState<HqView>('modern');
  const [art, setArt] = useState<HqArt>('realistic');
  const [menu, setMenu] = useState(false);
  const [assistant, setAssistant] = useState(false);
  const [draft, setDraft] = useState('');
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLDialogElement>(null);
  const assistantButton = useRef<HTMLButtonElement>(null);
  const assistantOpener = useRef<HTMLElement | null>(null);
  // Existing independently authorized pages already own their main landmark.
  const ContentElement = path === '/hq/schools' || path === '/hq/ai-providers' ? 'div' : 'main';

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
    <Link href="/hq" className={styles.brand}><strong>HON HQ</strong><span>Company control plane</span></Link>
    <nav className={styles.navigation} aria-label="HQ navigation">
      {HQ_NAV.map((item) => item.path === '/hq/growth' ? <details className={styles.growthNav} key={item.path} open>
        <summary><HqIcon name="growth" /><span>Growth &amp; Referrals</span></summary>
        <Link href={item.path} onClick={() => setMenu(false)} aria-current={path === item.path ? 'page' : undefined}>Growth overview</Link>
        {HQ_GROWTH.map((child) => <Link key={child.path} href={child.path} onClick={() => setMenu(false)} aria-current={path === child.path ? 'page' : undefined}><HqIcon name={child.icon} size={17}/>{child.title}</Link>)}
      </details> : <Link key={item.path} href={item.path} onClick={() => setMenu(false)} aria-current={(item.path === '/hq' ? path === item.path : path === item.path || path.startsWith(`${item.path}/`)) ? 'page' : undefined}><HqIcon name={item.icon}/>{item.title}</Link>)}
    </nav>
    <footer className={styles.railFooter}><span className={styles.ownerAvatar} aria-hidden="true">HQ</span><span>HQ workspace</span><Link href="/auth/login">Account</Link></footer>
  </>;

  return <div className={styles.shell} data-view={view} data-art={art}>
    <a className={styles.skip} href="#hq-main">Skip to main content</a>
    <aside className={styles.sidebar}>{nav}</aside>
    <dialog ref={drawer} className={styles.drawer} aria-label="HQ navigation menu" onCancel={(event) => { event.preventDefault(); setMenu(false); }} onClick={(event) => { if (event.target === drawer.current) setMenu(false); }}>
      <div><button type="button" className={styles.closeMenu} aria-label="Close navigation" onClick={() => setMenu(false)}><HqIcon name="close"/></button>{nav}</div>
    </dialog>
    <div className={styles.workspace}>
      <header className={styles.topbar}>
        <button ref={menuButton} type="button" className={styles.menuButton} aria-label="Open HQ navigation" aria-expanded={menu} onClick={() => setMenu(true)}><HqIcon name="menu"/></button>
        <div><p className={styles.eyebrow}>HON HQ / {path === '/hq' ? 'Overview' : hqPageLabel(path)}</p><h1>{path === '/hq' ? 'Lead with clarity.' : hqPageLabel(path)}</h1><p className={styles.subtitle}>{path === '/hq' ? 'Your company. In command with AI.' : 'Your company. One governed workspace.'}</p></div>
        <span className={styles.ownerAvatar} title="Company control plane" aria-label="HQ workspace">HQ</span>
      </header>
      <section className={styles.appearance} aria-label="HQ appearance">
        <div role="group" aria-label="Platform view"><span>View</span>{HQ_VIEWS.map((option) => <button type="button" key={option.key} aria-pressed={view === option.key} onClick={() => setView(option.key)}>{option.label}</button>)}</div>
        <div role="group" aria-label="AI portrait style"><span>AI style</span>{HQ_ART.map((option) => <button type="button" key={option.key} aria-pressed={art === option.key} onClick={() => setArt(option.key)}>{option.label}</button>)}</div>
        <small>Presentation only</small>
      </section>
      {art === 'anime' && <p className={styles.artNotice} role="status">Anime portraits are awaiting approved artwork. Executive identities remain unchanged.</p>}
      {access.kind === 'ready' ? <HqContext.Provider value={{ overview: access.overview, art, view, draft, setDraft, openAssistant }}>
        <div className={`${styles.contentLayout} ${assistant ? styles.withAssistant : ''}`}>
          <ContentElement id="hq-main" tabIndex={-1} className={styles.main}>{children}</ContentElement>
          {assistant && <div className={styles.assistantBackdrop} aria-hidden="true" onClick={closeAssistant}/>}
          {assistant && <HonAssistant context={hqPageLabel(path)} onMinimize={closeAssistant}/>}
        </div>
        {(!assistant && path !== '/hq') && <button ref={assistantButton} type="button" className={styles.assistantLauncher} onClick={openAssistant} aria-label="Ask HON anywhere" aria-expanded={false}><HonCore small/><strong>Ask HON anywhere</strong><HqIcon name="expand"/></button>}
      </HqContext.Provider> : <main id="hq-main" tabIndex={-1} className={styles.accessState}>
        <HonCore small/>
        <p className={styles.eyebrow}>{access.kind === 'loading' ? 'Verifying HQ access' : access.kind === 'forbidden' ? 'HQ access denied' : access.kind === 'unauthorized' ? 'Account required' : 'HQ unavailable'}</p>
        <h2>{access.kind === 'loading' ? 'Loading your company workspace…' : access.kind === 'forbidden' ? 'This account has no current HQ authority.' : access.kind === 'unauthorized' ? 'Sign in to verify HQ access.' : 'The HQ overview could not be verified.'}</h2>
        <p role="status">{access.kind === 'loading' ? 'Company information will appear after HQ access is verified.' : 'No cached, sample or inferred company data is displayed.'}</p>
        {access.kind === 'unauthorized' ? <Link href="/auth/login" className={styles.primary}>Sign in to HON</Link> : access.kind !== 'loading' && <button type="button" className={styles.primary} onClick={() => setRevision((value) => value + 1)}>Check access again</button>}
      </main>}
      <footer className={styles.pageFooter}><HqIcon name="shield" size={16}/><span>HQ remains separate from school CRM. You retain final approval.</span><button type="button" onClick={() => { setAccess({ kind: 'loading' }); setRevision((value) => value + 1); }}>Refresh HQ access</button></footer>
    </div>
    <nav className={styles.mobileNav} aria-label="Mobile HQ navigation">
      <Link href="/hq" aria-current={path === '/hq' ? 'page' : undefined}><HqIcon name="home"/><span>Home</span></Link>
      <button type="button" disabled={access.kind !== 'ready'} aria-label={assistant ? 'Minimize HON assistant' : 'Expand HON assistant'} aria-expanded={assistant} onClick={assistant ? closeAssistant : openAssistant}><HqIcon name="mic"/><span>HON</span></button>
      <Link href="/hq/approvals"><HqIcon name="attention"/><span>Attention</span></Link>
      <Link href="/hq/growth"><HqIcon name="growth"/><span>Growth</span></Link>
      <button type="button" aria-label="More HQ navigation" aria-expanded={menu} onClick={() => setMenu(true)}><HqIcon name="more"/><span>More</span></button>
    </nav>
  </div>;
}
