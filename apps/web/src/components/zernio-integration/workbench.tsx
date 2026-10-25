'use client';
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { useLocale } from '../localization/provider';
import { ZernioController, type ZernioViewState } from './controller';
import styles from './zernio.module.css';

export function ZernioIntegrationWorkbench(): React.ReactElement {
  const [controller] = useState(() => new ZernioController());
  const view = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  useEffect(() => {
    controller.start();
    const conceal = () => controller.conceal();
    const visibility = () => { if (document.visibilityState === 'hidden') conceal(); };
    window.addEventListener('blur', conceal); document.addEventListener('visibilitychange', visibility);
    return () => { controller.stop();
      window.removeEventListener('blur', conceal); document.removeEventListener('visibilitychange', visibility); };
  }, [controller]);
  return <ZernioIntegrationView view={view} refresh={() => void controller.refresh()} verify={() => void controller.verify()} />;
}

/** Same view in the authenticated route and deterministic presentation tests; no bypass route. */
export function ZernioIntegrationView({ view, refresh, verify }: { view: ZernioViewState; refresh: () => void; verify: () => void }): React.ReactElement {
  const { t, date } = useLocale();
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => { setConfirmed(false); }, [view.concealed, view.busy, view.configuration]);
  return <div className={styles.page}>
    <header><h1>{t('zernio.title')}</h1><p>{t('zernio.intro')}</p></header>
    {view.concealed ? <section aria-labelledby="zernio-privacy"><h2 id="zernio-privacy">{t('zernio.concealed')}</h2>
      <p>{t('zernio.privacy')}</p><button disabled={view.busy} onClick={refresh}>{t('zernio.restore')}</button></section> : <>
      <p className={styles.notice}>{t('zernio.safety')}</p>
      <section aria-labelledby="zernio-setup"><h2 id="zernio-setup">{t('zernio.setup')}</h2>
        <p>{t('zernio.managed')}</p><p>{t('zernio.local')}</p><code>node scripts/configure-zernio.mjs</code><p>{t('zernio.file')}</p>
        <a href="https://zernio.com/dashboard/api-keys" target="_blank" rel="noopener noreferrer">{t('zernio.dashboard')}</a></section>
      <section aria-labelledby="zernio-status"><h2 id="zernio-status">{t('zernio.status')}</h2>
        {view.configuration && <p>{t(`zernio.${view.configuration.credential}`)}</p>}
        <button disabled={view.busy} onClick={refresh}>{t('zernio.refresh')}</button>
        {!view.configuration?.verificationEnabled && <p>{t('zernio.gate')}</p>}
        <label className={styles.confirm}><input type="checkbox" checked={confirmed} disabled={view.busy || !view.configuration?.verificationEnabled}
          onChange={e => setConfirmed(e.target.checked)} />{t('zernio.confirm')}</label>
        <button disabled={view.busy || !confirmed || !view.configuration?.verificationEnabled} onClick={() => { setConfirmed(false); verify(); }}>{t('zernio.verify')}</button>
      </section>
      <section aria-labelledby="zernio-receipt"><h2 id="zernio-receipt">{t('zernio.receipt')}</h2>
        {view.receipt ? <><p role="status">{t(`zernio.${view.receipt.status}`)}</p><time dateTime={view.receipt.checkedAt}>{date(view.receipt.checkedAt)}</time></> : <p>{t('zernio.notChecked')}</p>}
      </section>
    </>}
    {view.busy && <p role="status">{t('zernio.working')}</p>}
    {view.error && <p role="alert">{t('zernio.error')} <a href="/auth/login">{t('zernio.signin')}</a></p>}
  </div>;
}
