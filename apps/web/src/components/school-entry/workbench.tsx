'use client';
import React, { useEffect, useRef, useState } from 'react';
import { useLocale } from '../localization/provider';
import { HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT } from '../session-invalidation';
import { SchoolEntryController, schoolWorkflowLinks } from './controller';
import { entryText } from './copy';
import styles from './workbench.module.css';

export function SchoolEntry({ sessionSubject }: { sessionSubject: string }): React.ReactElement {
  const locale = useLocale(), t = (key: Parameters<typeof entryText>[1]) => entryText(locale.preferences.language, key);
  const controller = useRef<SchoolEntryController | null>(null);
  if (!controller.current) controller.current = new SchoolEntryController(sessionSubject);
  const entry = controller.current;
  const [snapshot, setSnapshot] = useState(entry.snapshot());
  const [mode, setMode] = useState<'modern' | 'classic' | 'big'>('modern');
  const privateArea = useRef<HTMLDivElement | null>(null);
  const hideImmediately = () => {
    if (privateArea.current) {
      privateArea.current.hidden = true; privateArea.current.inert = true;
      // Also retire detached/native anchors retained before React commits concealment.
      for (const link of privateArea.current.querySelectorAll('a')) link.removeAttribute('href');
    }
  };
  useEffect(() => {
    entry.activate();
    const unsubscribe = entry.subscribe(next => { if (!['READY', 'CHOICE'].includes(next.phase)) hideImmediately(); setSnapshot(next); });
    const hide = (event: Event) => { hideImmediately(); entry.conceal(event.type === HON_SESSION_INVALIDATED_EVENT ? 'SESSION' : 'CONCEALED'); };
    const visibility = () => { if (document.visibilityState !== 'visible') hide(new Event('visibilitychange')); };
    const events = ['blur', 'pagehide', HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT];
    for (const event of events) window.addEventListener(event, hide);
    document.addEventListener('visibilitychange', visibility);
    if (document.visibilityState === 'visible') void entry.load(); else entry.conceal();
    return () => {
      hideImmediately(); unsubscribe(); entry.dispose();
      for (const event of events) window.removeEventListener(event, hide);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [entry]);
  const current = snapshot.revision === entry.snapshot().revision;
  const privateVisible = current && (snapshot.phase === 'READY' || snapshot.phase === 'CHOICE');
  const links = snapshot.selection ? schoolWorkflowLinks(snapshot.selection) : [];
  const locked = snapshot.phase === 'LOADING' || snapshot.phase === 'SESSION' || snapshot.phase === 'IDENTITY';
  return <main className={`${styles.page} ${styles[mode]}`} data-testid="school-entry" data-interface-theme={mode}>
    <header><p>HON OS</p><h1>{t('title')}</h1><p>{t('intro')}</p></header>
    <fieldset className={styles.modes}><legend>{t('mode')}</legend>{(['modern', 'classic', 'big'] as const).map(value => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}>{t(value)}</button>)}</fieldset>
    <p className={styles.help}>{t('modeHelp')}</p>
    <p className={styles.status} role="status" aria-live="polite" aria-atomic="true" data-testid="entry-status">{t(snapshot.phase)}</p>
    <div className={styles.actions}>
      <button type="button" data-testid="verify-entry" disabled={locked} onClick={() => void entry.load()}>{t(snapshot.phase === 'CONCEALED' ? 'restore' : snapshot.phase === 'READY' ? 'change' : 'verify')}</button>
      <a href="/auth/login">{t('signIn')}</a>
    </div>
    <div key={snapshot.revision} ref={privateArea} hidden={!privateVisible} inert={!privateVisible} data-testid="entry-private">
      {privateVisible && snapshot.phase === 'CHOICE' && <section aria-labelledby="entry-school-choice"><h2 id="entry-school-choice">{t('school')}</h2>
        <ul className={styles.choices}>{snapshot.choices.map(choice => <li key={choice.schoolId}><button type="button" data-testid={`school-choice-${choice.schoolId}`} onClick={() => void entry.choose(choice.schoolId, snapshot.revision)}>{choice.schoolName} — {choice.organizationName}<span>{t('choose')}</span></button></li>)}</ul>
      </section>}
      {privateVisible && snapshot.selection && <>
        <h2>{t('selected')}</h2>
        <details><summary>{t('scope')}</summary><p><code>{snapshot.selection.organizationId}</code><br/><code>{snapshot.selection.schoolId}</code></p></details>
        <nav aria-label={t('operations')} className={styles.workflows}>{links.map(link => <a key={link.key} href={link.href} data-testid={`entry-${link.key}`} onClick={event => { if (!snapshot.selection || !entry.canNavigate(snapshot.revision, snapshot.selection)) event.preventDefault(); }}><strong>{t(link.key)}</strong><span>{t(`${link.key}Help`)}</span></a>)}</nav>
        <p className={styles.help}>{t('boundary')}</p>
      </>}
    </div>
    <aside className={styles.unavailable}><h2>{t('unavailable')}</h2><p>{t('unavailableHelp')}</p></aside>
    <nav aria-label={t('nav')}><a href="/hq">{t('hq')}</a> <a href="/staff/account-status">{t('account')}</a></nav>
  </main>;
}
