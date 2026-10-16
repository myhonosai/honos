'use client';

import React, { useEffect, useState } from 'react';
import { HON_HQ_EXECUTIVE_CATALOG, type HqPlatformOverview, type HonHqExecutiveCatalogEntry } from '@hon/contracts';
import { HqOverviewAccessError, loadHqOverview } from './hq-overview-http';
import styles from './hq-executive-team.module.css';

type ViewState =
  | { kind: 'loading' }
  | { kind: 'unauthorized' }
  | { kind: 'forbidden' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; overview: HqPlatformOverview };

type PresentationMode = 'big-button' | 'modern' | 'classic';
const PRESENTATION_MODES: readonly { id: PresentationMode; label: string; detail: string }[] = [
  { id: 'big-button', label: 'Big-Button', detail: 'Larger controls' },
  { id: 'modern', label: 'Modern', detail: 'Balanced density' },
  { id: 'classic', label: 'Classic', detail: 'Compact density' },
];

function remitFor(executive: HonHqExecutiveCatalogEntry): string {
  if (executive.executiveKey === 'hon') {
    return 'Coordinator remit: bounded HQ explanation and consolidation. HON does not duplicate a specialist remit.';
  }
  return `Specialist remit: HQ ${executive.domain.replaceAll('_', ' ').toLowerCase()}.`;
}

function WorkEvidence({ overview }: { overview: HqPlatformOverview }): React.ReactElement {
  return <section className={styles.emptyWork} aria-labelledby="hq-work-evidence-title">
    <p className={styles.eyebrow}>NO RECORDED DURABLE WORK</p>
    <h2 id="hq-work-evidence-title">Work evidence is unavailable.</h2>
    <p>Tasks, history, results, approvals, and cost have no recorded durable HQ work source in this view.</p>
    <small>{overview.durableHqWork.reason}</small>
  </section>;
}

function ExecutiveProfile({ executive, overview }: { executive: HonHqExecutiveCatalogEntry; overview: HqPlatformOverview }): React.ReactElement {
  return <article className={styles.profile}>
    <span className={styles.profileKey}>{executive.executiveKey === 'hon' ? 'HQ COORDINATOR' : 'HQ SPECIALIST'}</span>
    <h3>{executive.displayName}</h3>
    <dl>
      <div><dt>Locked identity</dt><dd>{executive.title}</dd></div>
      <div><dt>Remit</dt><dd>{remitFor(executive)}</dd></div>
      <div><dt>Scope</dt><dd>Presentation-only catalog entry; not a principal, role, authority grant, or selector.</dd></div>
      <div><dt>Data &amp; tools</dt><dd>No staff, school, parent, or customer data; no model, provider, or Action Engine tool access.</dd></div>
    </dl>
    <footer className={styles.workStatus}>
      <span>{overview.durableHqWork.availability.replaceAll('_', ' ')} · {overview.durableHqWork.state.replaceAll('_', ' ')}</span>
      <strong>Task, history, result, approval, and cost: unavailable</strong>
      <small>{overview.durableHqWork.reason}</small>
    </footer>
  </article>;
}

/** Renders only the fixed catalog after the shared authenticated overview projection verifies. */
export function HqExecutiveTeamPresentation({ overview }: { overview: HqPlatformOverview }): React.ReactElement {
  return <>
    <section className={styles.verified} aria-label="Verified HQ executive team scope">
      <strong>Platform HQ {overview.callerHqRole.toLowerCase()} view verified</strong>
      <span>The fixed catalog is owner-locked and does not expose a person, tenant, school, or data selector.</span>
    </section>
    <section className={styles.relationship} aria-labelledby="hq-relationship-title">
      <p className={styles.eyebrow}>INFORMATIONAL RELATIONSHIP</p>
      <h2 id="hq-relationship-title">Owner approval → HON coordinator → specialists → shared Action Engine</h2>
      <p>Owner approval remains outside this presentation. The shared Action Engine is informational only; this route cannot create, approve, route, or run anything.</p>
    </section>
    <WorkEvidence overview={overview} />
    <section className={styles.team} aria-labelledby="hq-executive-team-title">
      <header><p className={styles.eyebrow}>LOCKED HQ CATALOG</p><h2 id="hq-executive-team-title">The Executive Team</h2><p>Each profile is a fixed presentation record. It does not represent a live agent, workspace, work queue, or data connection.</p></header>
      <div className={styles.profileGrid}>{HON_HQ_EXECUTIVE_CATALOG.map((executive) => <ExecutiveProfile key={executive.executiveKey} executive={executive} overview={overview} />)}</div>
    </section>
  </>;
}

export function HqExecutiveTeam(): React.ReactElement {
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
    <nav className={styles.navigation} aria-label="HON HQ navigation"><a href="/hq">Overview</a><a href="/hq/executives" aria-current="page">Executive Team</a><a href="/hq/schools">Schools</a><a href="/hq/ai-providers">AI provider configuration</a><a href="/auth/login">Account</a></nav>
    <header className={styles.header}><p className={styles.eyebrow}>HON HQ / EXECUTIVE TEAM</p><h1>Executive Team</h1><p>A bounded presentation of the approved HQ hierarchy. This screen depends on the existing authenticated HQ overview read and never creates a separate executive access path.</p></header>
    <section className={styles.presentation} aria-label="Presentation mode">
      <strong>Presentation</strong><div>{PRESENTATION_MODES.map((mode) => <button key={mode.id} type="button" aria-pressed={presentation === mode.id} onClick={() => setPresentation(mode.id)}><span>{mode.label}</span><small>{mode.detail}</small></button>)}</div><p>Big-Button, Modern, and Classic change display density only. They never change identity, scope, authority, data, or tools.</p>
    </section>
    <aside className={styles.notice}><strong>Presentation, not an execution surface.</strong><p>No task, conversation, approval, cost record, provider call, data selector, or Action Engine action is available here. No staff, school, parent, or customer data is shown.</p></aside>
    {state.kind === 'loading' && <section className={styles.state} role="status"><p className={styles.eyebrow}>VERIFYING HQ ACCESS</p><h2>Loading the fixed Executive Team presentation…</h2><p>No profile is displayed until the existing authenticated HQ overview scope and closed read projection verify.</p></section>}
    {state.kind === 'unauthorized' && <section className={styles.state}><p className={styles.eyebrow}>ACCOUNT REQUIRED</p><h2>Sign in to verify HQ access.</h2><p>HON returns no Executive Team presentation until an authenticated application identity is present.</p><a className={styles.primaryLink} href="/auth/login">Sign in to HON</a></section>}
    {state.kind === 'forbidden' && <section className={styles.state}><p className={styles.eyebrow}>HQ ACCESS DENIED</p><h2>This account has no current platform HQ Executive Team authority.</h2><p>School, family, AI, delegated, and support authority never bridge into the HQ platform-operator context.</p></section>}
    {state.kind === 'unavailable' && <section className={styles.state}><p className={styles.eyebrow}>EXECUTIVE TEAM UNAVAILABLE</p><h2>HQ access or the fixed overview could not be verified.</h2><p>HON fails closed. No sample, cached, inferred, or simulated Executive Team state is displayed.</p></section>}
    {state.kind === 'ready' && <HqExecutiveTeamPresentation overview={state.overview} />}
  </main>;
}
