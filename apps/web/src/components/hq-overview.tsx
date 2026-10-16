'use client';

import React, { useEffect, useState } from 'react';
import { HON_HQ_EXECUTIVE_CATALOG, type HqPlatformOverview } from '@hon/contracts';
import { HqOverviewAccessError, loadHqOverview } from './hq-overview-http';
import styles from './hq-overview.module.css';

type ViewState =
  | { kind: 'loading' }
  | { kind: 'unauthorized' }
  | { kind: 'forbidden' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; overview: HqPlatformOverview };

type PresentationMode = 'big-button' | 'modern' | 'classic';
const PRESENTATION_MODES: readonly { id: PresentationMode; label: string; detail: string }[] = [
  { id: 'big-button', label: 'Touch-first', detail: 'Larger controls' },
  { id: 'modern', label: 'Modern', detail: 'Balanced density' },
  { id: 'classic', label: 'High density', detail: 'Compact view' },
];

function formattedAsOf(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(value));
}

function UnavailableCard({ title, reason }: { title: string; reason: string }): React.ReactElement {
  return <article className={styles.unavailable}><span>UNAVAILABLE</span><h3>{title}</h3><p>{reason}</p></article>;
}

function ExecutiveCatalog(): React.ReactElement {
  return <section className={styles.section} aria-labelledby="hq-executives-title">
    <header><p className={styles.eyebrow}>HQ EXECUTIVE CATALOG</p><h2 id="hq-executives-title">Bounded presentation roster</h2><p>The roster is code-owned presentation only. It is not a principal directory, model selector, tool grant, role, authority, or execution surface.</p></header>
    <div className={styles.executives}>
      {HON_HQ_EXECUTIVE_CATALOG.map((executive) => <article className={styles.executive} key={executive.executiveKey}>
        <span className={styles.domain}>{executive.domain.replaceAll('_', ' ')}</span>
        <h3>{executive.displayName}</h3><strong>{executive.title}</strong><p>{executive.summary}</p>
        <div className={styles.workspace}><span>{executive.workspace.availability.replaceAll('_', ' ')}</span><strong>No recorded HQ work</strong><small>{executive.workspace.reason}</small></div>
      </article>)}
    </div>
  </section>;
}

function Overview({ overview }: { overview: HqPlatformOverview }): React.ReactElement {
  const providers = overview.configuredProviderStates;
  return <>
    <section className={styles.verified} aria-label="Verified HQ overview scope"><strong>Platform HQ {overview.callerHqRole.toLowerCase()} view</strong><span>As of {formattedAsOf(overview.asOf)} UTC</span><small>Aggregate-only; no organization, school, user, provider, model, credential, or per-school detail is displayed.</small></section>
    <section className={styles.section} aria-labelledby="hq-platform-facts">
      <header><p className={styles.eyebrow}>VERIFIED PLATFORM COUNTS</p><h2 id="hq-platform-facts">Current aggregate facts</h2><p>Counts are platform-wide aggregates only. They do not select or expose an organization or school.</p></header>
      <div className={styles.cards}>
        <article className={styles.card}><span>ORGANIZATIONS</span><strong>{overview.organizationCount.toLocaleString('en-US')}</strong><p>Total recorded organizations.</p></article>
        <article className={styles.card}><span>SCHOOLS</span><strong>{overview.schoolCount.toLocaleString('en-US')}</strong><p>Total recorded schools.</p></article>
        <article className={styles.card}><span>TASK PROFILES</span><strong>{overview.taskProfileCount.toLocaleString('en-US')}</strong><p>Configured task-profile records; no model IDs or routing detail.</p></article>
      </div>
    </section>
    <section className={styles.section} aria-labelledby="hq-onboarding-title">
      <header><p className={styles.eyebrow}>HQ ONBOARDING REQUESTS</p><h2 id="hq-onboarding-title">Authoritative request state counts</h2><p>Only aggregate counts are shown. Request, actor, organization, and school details stay private.</p></header>
      <div className={styles.cards}>
        <article className={styles.card}><span>ALL REQUESTS</span><strong>{overview.onboarding.requestCount.toLocaleString('en-US')}</strong><p>Recorded onboarding requests.</p></article>
        <article className={styles.card}><span>IN PROGRESS</span><strong>{overview.onboarding.inProgressRequestCount.toLocaleString('en-US')}</strong><p>Current request state count.</p></article>
        <article className={styles.card}><span>COMPLETED</span><strong>{overview.onboarding.completedRequestCount.toLocaleString('en-US')}</strong><p>Current request state count.</p></article>
      </div>
    </section>
    <section className={styles.section} aria-labelledby="hq-provider-title">
      <header><p className={styles.eyebrow}>CONFIGURED PROVIDER STATES</p><h2 id="hq-provider-title">State counts only</h2><p>No provider names, credentials, model IDs, endpoints, health probes, or calls are shown or made.</p></header>
      <div className={styles.providerCounts}>
        {(['disabled', 'configured', 'healthy', 'degraded', 'unavailable'] as const).map((state) => <div key={state}><span>{state.toUpperCase()}</span><strong>{providers[state].toLocaleString('en-US')}</strong></div>)}
      </div>
    </section>
    <section className={styles.section} aria-labelledby="hq-unavailable-title">
      <header><p className={styles.eyebrow}>HONEST LIMITS</p><h2 id="hq-unavailable-title">Not calculated or activated in HQ-1</h2><p>Unavailable is not zero, healthy, or an outcome. HON does not synthesize financial or AI economics from unrelated records.</p></header>
      <div className={styles.unavailableGrid}>
        <UnavailableCard title="Financial MRR / ARR / cash / gross margin" reason={overview.financialMetrics.reason} />
        <UnavailableCard title="AI usage and cost" reason={overview.aiUsage.reason} />
        <UnavailableCard title="Durable HQ work" reason={overview.durableHqWork.reason} />
      </div>
    </section>
    <ExecutiveCatalog />
  </>;
}

export function HqOverview(): React.ReactElement {
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [presentation, setPresentation] = useState<PresentationMode>('modern');

  useEffect(() => {
    let current = true;
    loadHqOverview().then(
      (overview) => { if (current) setState({ kind: 'ready', overview }); },
      (error: unknown) => {
        if (!current) return;
        if (error instanceof HqOverviewAccessError) setState({ kind: error.status === 401 ? 'unauthorized' : 'forbidden' });
        else setState({ kind: 'unavailable' });
      },
    );
    return () => { current = false; };
  }, []);

  return <main className={`${styles.page} ${styles[`presentation_${presentation}`]}`}>
    <nav className={styles.navigation} aria-label="HON HQ navigation"><a href="/hq">Overview</a><a href="/hq/executives">Executive Team</a><a href="/hq/schools">Schools</a><a href="/hq/ai-providers">AI provider configuration</a><a href="/auth/login">Account</a></nav>
    <header className={styles.header}><p className={styles.eyebrow}>HON HQ / PLATFORM OPERATOR</p><h1>HQ overview</h1><p>A separate, conventional, read-only platform overview. School authority, family access, AI employees, delegated context, and unauthenticated clients do not grant HQ access.</p></header>
    <section className={styles.presentation} aria-label="Presentation mode">
      <strong>Presentation</strong><div>{PRESENTATION_MODES.map((mode) => <button key={mode.id} type="button" aria-pressed={presentation === mode.id} onClick={() => setPresentation(mode.id)}><span>{mode.label}</span><small>{mode.detail}</small></button>)}</div><p>These are the existing three display modes only. Changing a mode never changes data, scope, authority, or execution.</p>
    </section>
    <aside className={styles.notice}><strong>Commands, delegation, voice, and executive workspaces are not active.</strong><p>This overview neither invokes a provider nor creates work, Action Engine proposals, audit records, usage, financial records, communications, or provider effects.</p></aside>
    {state.kind === 'loading' && <section className={styles.state} role="status"><p className={styles.eyebrow}>VERIFYING HQ ACCESS</p><h2>Loading the minimized platform overview…</h2><p>No platform detail is shown until the authenticated HQ scope and fixed read-only projection are verified.</p></section>}
    {state.kind === 'unauthorized' && <section className={styles.state}><p className={styles.eyebrow}>ACCOUNT REQUIRED</p><h2>Sign in to verify HQ access.</h2><p>HON returns no overview until an authenticated application identity is present.</p><a className={styles.primaryLink} href="/auth/login">Sign in to HON</a></section>}
    {state.kind === 'forbidden' && <section className={styles.state}><p className={styles.eyebrow}>HQ ACCESS DENIED</p><h2>This account has no current platform HQ overview authority.</h2><p>School and family authority never bridge into the HQ platform-operator context.</p></section>}
    {state.kind === 'unavailable' && <section className={styles.state}><p className={styles.eyebrow}>OVERVIEW UNAVAILABLE</p><h2>HQ access or the read-only projection could not be verified.</h2><p>HON fails closed. No cached, sample, or inferred platform state is displayed.</p></section>}
    {state.kind === 'ready' ? <Overview overview={state.overview} /> : <ExecutiveCatalog />}
  </main>;
}
