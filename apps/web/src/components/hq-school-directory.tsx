'use client';

import { useLocale } from './localization/provider';
import { hqSchoolText, hqSchoolStatus } from './hq-school-management-copy';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { HqSchoolDirectory } from '@hon/contracts';
import { HqSchoolDirectoryController, bindHqSchoolDirectoryPrivacy } from './hq-school-directory-controller';
import { useHqModern } from './hq-modern/shell';
import styles from './hq-school-directory.module.css';

function formatDate(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric',
  }).format(new Date(value));
}

function DirectoryTable({ directory }: { directory: HqSchoolDirectory }): React.ReactElement {
  const { preferences, formattingLocale } = useLocale();
  const t = (key: Parameters<typeof hqSchoolText>[1]) => hqSchoolText(preferences.language, key);
  if (directory.schools.length === 0) {
    return <section className={styles.state}><p className={styles.eyebrow}>{t('directoryEmptyEyebrow')}</p><h2>{t('directoryEmpty')}</h2><p>{t('directoryEmptyHelp')}</p></section>;
  }

  return <section className={styles.section} aria-labelledby="hq-schools-directory-title">
    <header><p className={styles.eyebrow}>{t('directoryTableEyebrow')}</p><h2 id="hq-schools-directory-title">{t('directorySchools')}</h2><p>{t('directoryTableHelp')}</p></header>
    <div className={styles.tableWrap} role="region" aria-label={t('directoryTableLabel')} tabIndex={0}>
      <table>
        <thead><tr><th>{t('directoryOrganization')}</th><th>{t('directorySchool')}</th><th>{t('directoryOperationalStatus')}</th><th>{t('directoryCurrentTier')}</th><th>{t('directoryCreated')}</th></tr></thead>
        <tbody>{directory.schools.map((school) => <tr key={school.schoolId}>
          <td><strong>{school.organizationDisplayName}</strong><small>{hqSchoolStatus(preferences.language, school.organizationOperationalStatus)}</small></td>
          <td><strong>{school.schoolDisplayName}</strong><small>{hqSchoolStatus(preferences.language, school.schoolOperationalStatus)}</small></td>
          <td><span className={styles.statusPair}>{hqSchoolStatus(preferences.language, school.organizationOperationalStatus)} / {hqSchoolStatus(preferences.language, school.schoolOperationalStatus)}</span></td>
          <td>{school.entitlementTier ?? <span className={styles.unavailable}>{t('directoryNoTier')}</span>}</td>
          <td>{formatDate(school.createdAt, formattingLocale)} UTC</td>
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}

export function HqSchoolDirectory(): React.ReactElement {
  const [controller] = useState(() => new HqSchoolDirectoryController());
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const facts = useRef<HTMLDivElement>(null);
  // Density follows the shared HQ View control; it never changes the directory, access or data fields.
  const { view } = useHqModern();
  const { preferences } = useLocale();
  const t = (key: Parameters<typeof hqSchoolText>[1]) => hqSchoolText(preferences.language, key);

  useEffect(() => {
    void controller.start();
    const unbind = bindHqSchoolDirectoryPrivacy(controller, () => { if (facts.current) { facts.current.hidden = true; facts.current.inert = true; } }, window, document);
    return () => { unbind(); controller.stop(); };
  }, [controller]);

  return <div className={`${styles.page} ${styles[`presentation_${view}`]}`} data-hq-directory data-hq-directory-busy={state.busy}>
    <header className={styles.header}><p className={styles.eyebrow}>{t('directoryEyebrow')}</p><h2>{t('directoryTitle')}</h2><p>{t('directoryIntro')}</p></header>
    <aside className={styles.notice}><strong>{t('directoryFactsTitle')}</strong><p>{t('directoryFactsLimit')}</p></aside>
    <p className={styles.announcement} role="status" aria-live="polite" aria-atomic="true">{state.kind === 'ready' ? `${t('directorySchools')}: ${state.directory?.schools.length ?? 0}` : t(state.kind === 'loading' ? 'directoryLoading' : state.kind === 'unauthorized' ? 'directorySignIn' : state.kind === 'forbidden' ? 'directoryDenied' : state.kind === 'concealed' ? 'directoryConcealed' : 'directoryUnavailable')}</p>
    {state.kind === 'loading' && <section className={styles.state}><p className={styles.eyebrow}>{t('directoryLoadingEyebrow')}</p><h2>{t('directoryLoading')}</h2><p>{t('directoryLoadingHelp')}</p></section>}
    {state.kind === 'unauthorized' && <section className={styles.state}><p className={styles.eyebrow}>{t('directoryAccountRequired')}</p><h2>{t('directorySignIn')}</h2><p>{t('directorySignInHelp')}</p><a className={styles.primaryLink} href="/auth/login">{t('signIn')}</a></section>}
    {state.kind === 'forbidden' && <section className={styles.state}><p className={styles.eyebrow}>{t('directoryDeniedEyebrow')}</p><h2>{t('directoryDenied')}</h2><p>{t('directoryDeniedHelp')}</p></section>}
    {state.kind === 'unavailable' && <section className={styles.state}><p className={styles.eyebrow}>{t('directoryUnavailableEyebrow')}</p><h2>{t('directoryUnavailable')}</h2><p>{t('directoryUnavailableHelp')}</p></section>}
    {state.kind === 'concealed' && <section className={styles.state}><h2>{t('directoryConcealed')}</h2><p>{t('directoryConcealedHelp')}</p></section>}
    {state.kind !== 'loading' && state.kind !== 'ready' && <button type="button" className={styles.primaryLink} disabled={state.busy} onClick={() => void controller.load()}>{t('directoryRead')}</button>}
    <div key={controller.revision()} ref={facts} data-hq-directory-facts hidden={state.kind !== 'ready'} inert={state.kind !== 'ready'}>{state.kind === 'ready' && state.directory && <DirectoryTable directory={state.directory} />}</div>
  </div>;
}
