'use client';

import React, { useEffect, useState } from 'react';
import type { HqSchoolVisit } from '@hon/contracts';
import { readHqHint } from '../school-switcher/switcher';
import { hqSchoolVisitText } from './copy';
import { HqSchoolVisitError, leaveSchoolAsHq, readMyHqSchoolVisits } from './http';
import styles from './banner.module.css';

/** Pure view so it renders in tests without a network. */
export function HqVisitBannerView({ language, visit, busy = false, error = '', onLeave = () => {}, timeLabel }: {
  language: string; visit: HqSchoolVisit | null; busy?: boolean; error?: string; onLeave?: () => void; timeLabel?: string | undefined;
}): React.ReactElement | null {
  if (!visit) return null;
  const t = (key: Parameters<typeof hqSchoolVisitText>[1]) => hqSchoolVisitText(language, key);
  return <aside className={styles.banner} role="status" data-hq-visit-banner={visit.schoolId}>
    <strong>{t('bannerTitle')}</strong>
    {timeLabel && <span className={styles.until}>{t('until')} {timeLabel}</span>}
    <p>{t('bannerHelp')}</p>
    <button type="button" onClick={onLeave} disabled={busy} data-hq-visit-leave="">{busy ? t('leaving') : t('leave')}</button>
    {error && <p className={styles.error} role="alert">{error}</p>}
  </aside>;
}

/**
 * Shown inside a school while the signed-in HQ person has a live visit there. School pages read nothing on mount for
 * ordinary staff: the visit read happens only when this browser has the HQ display hint (set by HQ pages). The banner
 * is a display; every school page and API still decides access itself.
 */
export function HqVisitBanner({ language, schoolId }: { language: string; schoolId: string | null }): React.ReactElement | null {
  const [visit, setVisit] = useState<HqSchoolVisit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  useEffect(() => {
    setVisit(null);
    if (!schoolId || !readHqHint()) return;
    const abort = new AbortController();
    readMyHqSchoolVisits(abort.signal).then(result => {
      if (!abort.signal.aborted) setVisit(result.visits.find(v => v.schoolId === schoolId.toLowerCase()) ?? null);
    }, () => {});
    return () => abort.abort();
  }, [schoolId]);
  const leave = async () => {
    if (!visit || busy) return;
    setBusy(true); setError('');
    try { await leaveSchoolAsHq(visit.schoolId, key); window.location.assign('/hq/schools'); }
    catch (failure) {
      const reason = failure instanceof HqSchoolVisitError ? failure.reason : 'unavailable';
      setError(hqSchoolVisitText(language, reason === 'signedOut' ? 'failSignedOut' : reason === 'forbidden' ? 'failForbidden' : 'failUnknown'));
      if (reason !== 'unknown') setKey(crypto.randomUUID());
      setBusy(false);
    }
  };
  const timeLabel = visit ? new Date(visit.endsAt).toLocaleTimeString(language === 'ko' ? 'ko-KR' : language === 'es' ? 'es' : 'en-US', { hour: 'numeric', minute: '2-digit' }) : undefined;
  return <HqVisitBannerView language={language} visit={visit} busy={busy} error={error} onLeave={() => void leave()} timeLabel={timeLabel} />;
}
