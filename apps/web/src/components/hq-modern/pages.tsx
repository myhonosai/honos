'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { HQ_EXECUTIVES, HQ_GROWTH, HQ_PLANNED, HQ_RESPONSIBILITIES } from './catalog';
import { ExecutiveCards, ExecutivePortrait, GrowthLinks } from './dashboard';
import { useHqModern } from './shell';
import { HqIcon } from './icon';
import styles from './hq-modern.module.css';

export function HqModernExecutives(): React.ReactElement {
  return <><ExecutiveCards/><div className={`${styles.panel} ${styles.explanation}`}><HqIcon name="shield"/><div><h2>Coordinated, governed, separate.</h2><p>HON coordinates the six HQ specialists. A portrait or workspace never grants tools or access to school records. Durable work and delegated execution remain unavailable.</p></div></div></>;
}

export function HqExecutiveWorkspace({ executiveKey }: { executiveKey: string }): React.ReactElement {
  const executive = HQ_EXECUTIVES.find((item) => item.executiveKey === executiveKey);
  const [tab, setTab] = useState('Task history');
  const { openAssistant } = useHqModern();
  if (!executive) return <p>Executive workspace unavailable.</p>;
  const index = HQ_EXECUTIVES.indexOf(executive);
  return <>
    <Link href="/hq/executives" className={styles.backLink}>← Executive Team</Link>
    <section className={`${styles.panel} ${styles.profileHero}`}><ExecutivePortrait index={index} name={executive.displayName}/><div><p className={styles.eyebrow}>HQ executive workspace</p><h2>{executive.displayName}</h2><h3>{executive.title}</h3><p>{HQ_RESPONSIBILITIES[executiveKey]}</p><span className={styles.badge}>No recorded work</span></div><button type="button" className={styles.primary} onClick={openAssistant}>Open HON assistant</button></section>
    <div className={styles.tabBar} role="group" aria-label={`${executive.displayName} workspace sections`}>{['Task history', 'Recommendations', 'Approvals', 'Performance'].map((label) => <button type="button" key={label} aria-pressed={tab === label} onClick={() => setTab(label)}>{label}</button>)}</div>
    <section className={`${styles.panel} ${styles.emptyState}`} aria-live="polite"><HqIcon name="database" size={36}/><h2>{tab} unavailable</h2><p>This executive does not have an active durable HQ workspace service. No tasks, recommendations, decisions or results are inferred.</p><span className={styles.badge}>Planned integration</span></section>
  </>;
}

export function HqPlannedPage({ pagePath }: { pagePath: string }): React.ReactElement {
  const page = HQ_PLANNED[pagePath];
  const [stage, setStage] = useState('Draft');
  if (!page) return <p>HQ module unavailable.</p>;
  return <>
    <section className={`${styles.panel} ${styles.moduleIntro}`}><span className={styles.badge}>Planned</span><h2>{page.title}</h2><p>{page.description}</p></section>
    {pagePath === '/hq/growth' && <GrowthLinks/>}
    {pagePath.startsWith('/hq/growth/') && <nav className={styles.moduleLinks} aria-label="Growth modules">{HQ_GROWTH.map((item) => <Link key={item.path} href={item.path} aria-current={pagePath === item.path ? 'page' : undefined}>{item.title}</Link>)}</nav>}
    <div className={styles.plannedGrid}>{page.areas.map((area) => <section key={area} className={styles.panel}><HqIcon name="database"/><h3>{area}</h3><p>Unavailable</p><small>An authorized HQ data source is required.</small></section>)}</div>
    {pagePath === '/hq/growth/contests' && <section className={`${styles.panel} ${styles.contestPreview}`}><div className={styles.sectionHeader}><h2>Competition lifecycle</h2><span className={styles.badge}>Workflow preview</span></div><p>Explore the planned owner controls. These do not create or change a competition.</p><div className={styles.tabBar} role="group" aria-label="Contest lifecycle preview">{['Draft', 'Schedule', 'Launch', 'Pause', 'End', 'Review'].map((label) => <button type="button" key={label} aria-pressed={stage === label} onClick={() => setStage(label)}>{label}</button>)}</div><div className={styles.stageDetail} aria-live="polite"><h3>{stage} — planned</h3><p>{({ Draft: 'Define eligibility, verified qualification rules, dates, prizes, budget and versioned terms.', Schedule: 'Select a future start after reviewing readiness and owner authorization.', Launch: 'Owner-approved publication is required before entrants or spending can be activated.', Pause: 'Pause new activity under the published rules without silently disadvantaging entrants.', End: 'Close the competition and freeze evidence before reviewing results.', Review: 'Review verified winners and authorize fulfillment separately from publication.' } as Record<string, string>)[stage]}</p><button type="button" disabled>{stage} competition — unavailable</button></div></section>}
    <p className={styles.finePrint}>No service is called and no business action is performed by this planned interface.</p>
  </>;
}
