'use client';

import { useLocale } from './localization/provider';
import { hqSchoolText } from './hq-school-management-copy';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { SchoolCreationController, bindSchoolCreationPrivacy } from './hq-onboarding-controller';
import { useHqModern } from './hq-modern/shell';
import styles from './hq-onboarding-panel.module.css';

export function HqOnboardingPanel(): React.ReactElement {
  const [controller] = useState(() => new SchoolCreationController());
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const privateArea = useRef<HTMLDivElement>(null);
  const { view } = useHqModern();
  const { preferences } = useLocale();
  const t = (key: Parameters<typeof hqSchoolText>[1]) => hqSchoolText(preferences.language, key);
  const announcement = state.busy ? t('announcementBusy')
    : state.receipt ? (state.receipt.replayed ? t('announcementReplay') : t('announcementReceipt'))
      : state.access === 'signed-out' ? t('announcementSignedOut')
        : state.access === 'forbidden' ? t('announcementForbidden')
          : state.access === 'unavailable' ? t('announcementUnavailable')
            : (state.message ? t(state.message) : '') || (state.concealed ? t('announcementConcealed') : t('announcementReady'));
  useEffect(() => {
    controller.start();
    const unbind = bindSchoolCreationPrivacy(controller, () => {
      if (privateArea.current) { privateArea.current.hidden = true; privateArea.current.inert = true; }
    }, window, document);
    return () => { unbind(); controller.stop(); };
  }, [controller]);
  return <section className={`${styles.panel} ${styles[`presentation_${view}`]}`} aria-labelledby="hq-school-create-title" data-school-create data-school-create-busy={state.busy}>
    <h2 id="hq-school-create-title">{t('createTitle')}</h2>
    <p>{t('createIntro')}</p>
    <p className={styles.policy}><strong>{t('provisionPolicyTitle')}</strong> {t('provisionPolicy')}</p>
    <p className={styles.announcement} role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
    {state.concealed ? <>
      <p>{state.access === 'signed-out' ? t('signedOut') : state.access === 'forbidden' ? t('forbidden') : state.access === 'unavailable' ? t('unavailable') : t('concealed')}</p>
      {state.access === 'signed-out' && <a href="/auth/login">{t('signIn')}</a>}
      <button type="button" disabled={state.busy} onClick={() => void controller.authorize()}>{t('verifyOwner')}</button>
    </> : null}
    <div key={controller.revision()} ref={privateArea} data-hq-create-private hidden={state.concealed} inert={state.concealed}>
    {!state.concealed && (state.receipt ? <section aria-labelledby="hq-school-created">
      <h3 id="hq-school-created">{t('receiptTitle')}</h3>
      <p>{state.receipt.replayed ? t('receiptReplay') : t('receiptCreated')}</p>
      <dl><dt>{t('organizationId')}</dt><dd><code>{state.receipt.organizationId}</code></dd><dt>{t('schoolId')}</dt><dd><code>{state.receipt.schoolId}</code></dd></dl>
      <p>{t('receiptLimit')}</p>
    </section> : <form onSubmit={event => { event.preventDefault(); void controller.submit(); }}>
      <fieldset disabled={state.busy || state.uncertain} className={styles.fields}><legend>{t('formLegend')}</legend>
        {([['legalName', t('legalName'), 180], ['displayName', t('displayName'), 120], ['schoolName', t('schoolName'), 120], ['schoolSlug', t('schoolSlug'), 80], ['timezone', t('timezone'), 64]] as const).map(([key, label, maxLength]) => <label key={key}>{label}<input name={key} required maxLength={maxLength} value={state.form[key]} pattern={key === 'schoolSlug' ? '[a-z0-9]+(-[a-z0-9]+)*' : undefined} onChange={event => controller.edit(key, event.target.value)} /></label>)}
      </fieldset>
      <p className={styles.note}>{t('productNote')}</p>
      {state.uncertain && <p>{t('unknownWarning')}</p>}
      <label className={styles.confirm}><input type="checkbox" disabled={state.busy} checked={state.confirmed} onChange={event => controller.confirm(event.target.checked)} />{state.uncertain ? t('confirmRetry') : t('confirmCreate')}</label>
      <button type="submit" disabled={state.busy || !state.confirmed}>{state.uncertain ? t('retry') : t('create')}</button>
    </form>)}
    </div>
    {state.busy && <p>{t('verifying')}</p>}
    {state.message && <p>{t(state.message)}</p>}
  </section>;
}
