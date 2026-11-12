'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { LeadIntakeMonitorForm } from '@hon/contracts';
import { FormUiError, loadLeadIntakeMonitor } from './public-form-client';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from './session-invalidation';
import { useLocale } from './localization/provider';
import { leadIntakeCopy } from './lead-sources-intake-copy';
import styles from './lead-sources-intake-monitor.module.css';

type MonitorState = 'IDLE' | 'LOADING' | 'READY' | 'SESSION_INVALID' | 'DENIED' | 'UNAVAILABLE';
type Presentation = 'modern' | 'classic' | 'big-button';

function totalAccepted(forms: readonly LeadIntakeMonitorForm[]): number {
  return forms.reduce((total, form) => total + form.acceptedCount, 0);
}

/**
 * A scoped monitor never accepts authority from the browser. It clears its
 * memory on privacy boundaries, confirmed session invalidation, and any
 * application-level school-context transition; each later load is separately
 * server-authorized and deliberately human-triggered.
 */
export function LeadSourcesIntakeMonitor(): React.ReactElement {
  const { preferences, number } = useLocale();
  const copy = leadIntakeCopy(preferences.language);
  const [state, setState] = useState<MonitorState>('IDLE');
  const [forms, setForms] = useState<LeadIntakeMonitorForm[] | null>(null);
  const [presentation, setPresentation] = useState<Presentation>('modern');
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);

  const discard = useCallback((nextState: MonitorState = 'IDLE'): void => {
    generation.current += 1;
    request.current?.abort();
    request.current = null;
    setForms(null);
    setState(nextState);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const clearOnPrivacyBoundary = (): void => discard();
    const clearWhenHidden = (): void => { if (document.visibilityState === 'hidden') discard(); };
    const clearForConfirmedSessionInvalidation = (): void => discard('SESSION_INVALID');
    const clearForSchoolContextTransition = (): void => discard();
    window.addEventListener('pagehide', clearOnPrivacyBoundary);
    window.addEventListener('blur', clearOnPrivacyBoundary);
    window.addEventListener(HON_SESSION_INVALIDATED_EVENT, clearForConfirmedSessionInvalidation);
    window.addEventListener(HON_SCHOOL_CONTEXT_CHANGED_EVENT, clearForSchoolContextTransition);
    document.addEventListener('visibilitychange', clearWhenHidden);
    return () => {
      generation.current += 1;
      request.current?.abort();
      request.current = null;
      window.removeEventListener('pagehide', clearOnPrivacyBoundary);
      window.removeEventListener('blur', clearOnPrivacyBoundary);
      window.removeEventListener(HON_SESSION_INVALIDATED_EVENT, clearForConfirmedSessionInvalidation);
      window.removeEventListener(HON_SCHOOL_CONTEXT_CHANGED_EVENT, clearForSchoolContextTransition);
      document.removeEventListener('visibilitychange', clearWhenHidden);
    };
  }, [discard]);

  async function load(): Promise<void> {
    if (state === 'LOADING') return;
    const current = ++generation.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setForms(null);
    setState('LOADING');
    try {
      const next = await loadLeadIntakeMonitor(controller.signal);
      if (current !== generation.current || request.current !== controller) return;
      request.current = null;
      setForms(next);
      setState('READY');
    } catch (reason) {
      if (current !== generation.current || request.current !== controller) return;
      if (reason instanceof FormUiError && reason.sessionInvalid) {
        discard('SESSION_INVALID');
        return;
      }
      request.current = null;
      setForms(null);
      setState(reason instanceof FormUiError && reason.denied ? 'DENIED' : 'UNAVAILABLE');
    }
  }

  const classes = [styles.page, presentation === 'modern' ? styles.modern : presentation === 'classic' ? styles.classic : styles.bigButton].join(' ');
  const accepted = forms ? totalAccepted(forms) : 0;
  const isReady = state === 'READY' && forms !== null;
  const status = state === 'IDLE' ? copy.idle
    : state === 'LOADING' ? copy.loading
      : state === 'SESSION_INVALID' ? copy.sessionInvalid
        : state === 'DENIED' ? copy.denied
          : state === 'UNAVAILABLE' ? copy.unavailable
            : copy.websiteReady(number(accepted));
  const alert = state === 'SESSION_INVALID' || state === 'DENIED' || state === 'UNAVAILABLE';

  return <main className={classes} data-monitor-state={state} data-presentation={presentation}>
    <nav className={styles.nav} aria-label={copy.staffNavigation}>
      <a href="/staff/dashboard">{copy.navCore}</a><a href="/staff/marketing/forms">{copy.navForms}</a><a href="/staff/crm/leads">{copy.navLeads}</a><a href="/staff/marketing/campaigns">{copy.navCampaigns}</a><a href="/staff/migration/leads">{copy.navImports}</a><a href="/staff/leads/assistant">{copy.navChad}</a><a href="/auth/login">{copy.signIn}</a>
    </nav>

    <header className={styles.hero}>
      <p className={styles.eyebrow}>{copy.eyebrow}</p>
      <h1>{copy.title}</h1>
      <p>{copy.introduction}</p>
      <aside className={styles.guardrail}><strong>{copy.noEffects}</strong><span>{copy.guardrail}</span></aside>
    </header>

    <section className={styles.controlPanel} aria-labelledby="lead-intake-load-heading" aria-busy={state === 'LOADING'}>
      <div><p className={styles.eyebrow}>{copy.currentSchoolRead}</p><h2 id="lead-intake-load-heading">{copy.sourceTitle}</h2>
        <div className={styles.liveRegion} aria-live={alert ? 'assertive' : 'polite'} aria-atomic="true">
          <p role={alert ? 'alert' : 'status'} className={alert ? styles.statusAlert : styles.statusNotice}>{status}</p>
        </div>
      </div>
      <button type="button" className={styles.primary} disabled={state === 'LOADING'} onClick={() => void load()}>{state === 'LOADING' ? copy.loading : copy.load}</button>
    </section>

    <section className={styles.modeControls} aria-labelledby="presentation-mode-heading">
      <div><p className={styles.eyebrow}>{copy.presentationOnly}</p><h2 id="presentation-mode-heading">{copy.viewLabel}</h2><p>{copy.viewNote}</p></div>
      <div className={styles.modeButtons} role="group" aria-label={copy.viewLabel}>
        <button type="button" aria-pressed={presentation === 'modern'} onClick={() => setPresentation('modern')}>{copy.modern}</button>
        <button type="button" aria-pressed={presentation === 'classic'} onClick={() => setPresentation('classic')}>{copy.classic}</button>
        <button type="button" aria-pressed={presentation === 'big-button'} onClick={() => setPresentation('big-button')}>{copy.bigButton}</button>
      </div>
    </section>

    <section className={styles.lanes} aria-label={copy.sourceTitle}>
      <article className={`${styles.lane} ${isReady ? styles.ready : styles.awaiting}`}>
        <p className={styles.laneStatus}>{isReady ? copy.verifiedRead : copy.awaitingRead}</p><h2>{copy.website}</h2>
        <p>{isReady ? copy.websiteReady(number(accepted)) : copy.idle}</p>
        <a href="/staff/marketing/forms">{copy.openForms}</a>
      </article>
      <article className={`${styles.lane} ${styles.unavailable}`}>
        <p className={styles.laneStatus}>{copy.notConnected}</p><h2>{copy.zernioTitle}</h2><p>{copy.zernioBody}</p>
      </article>
      <article className={`${styles.lane} ${styles.unavailable}`}>
        <p className={styles.laneStatus}>{copy.unavailableLabel}</p><h2>{copy.googleTitle}</h2><p>{copy.googleBody}</p>
      </article>
    </section>

    {isReady && <section className={styles.forms} aria-labelledby="current-form-heading">
      <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>{copy.websiteResponseBacked}</p><h2 id="current-form-heading">{copy.formCount(number(forms.length))}</h2></div><p>{copy.websiteReady(number(accepted))}</p></div>
      {forms.length === 0 ? <p className={styles.empty}>{copy.formEmpty}</p> : <div className={styles.formGrid}>{forms.map((form, index) => <article className={styles.formCard} key={`${form.title}:${form.status}:${form.acceptedCount}:${index}`}>
        <div className={styles.cardTop}><span className={styles.status}>{copy.formStatus[form.status]}</span></div>
        <h3>{form.title}</h3><p className={styles.count}>{copy.accepted(number(form.acceptedCount))}</p><p className={form.hasCampaignAssociation ? styles.linked : styles.unlinked}>{form.hasCampaignAssociation ? copy.campaignRecorded : copy.campaignMissing}</p>
      </article>)}</div>}
    </section>}

    <section className={styles.nextSteps} aria-label={copy.governedNextSteps}>
      <article><p className={styles.eyebrow}>{copy.noInferredFunnel}</p><h2>{copy.conversionTitle}</h2><p>{copy.conversionBody}</p><p className={styles.muted}>{copy.conversionUnavailable}</p><div className={styles.links}><a href="/staff/crm/leads">{copy.openLeads}</a><a href="/staff/crm/trials">{copy.openTrials}</a><a href="/staff/marketing/campaigns">{copy.openCampaigns}</a></div></article>
      <article><p className={styles.eyebrow}>{copy.humanReview}</p><h2>{copy.duplicateTitle}</h2><p>{copy.duplicateBody}</p><div className={styles.links}><a href="/staff/migration/leads">{copy.openImports}</a></div></article>
      <article><p className={styles.eyebrow}>{copy.governedDraftsOnly}</p><h2>{copy.chadTitle}</h2><p>{copy.chadBody}</p><div className={styles.links}><a href="/staff/leads/assistant">{copy.openChad}</a></div></article>
    </section>
  </main>;
}
