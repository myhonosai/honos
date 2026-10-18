'use client';

import React, { type CSSProperties } from 'react';
import Link from 'next/link';
import { HQ_EXECUTIVES, HQ_GROWTH, HQ_RESPONSIBILITIES } from './catalog';
import { useHqModern, HonCore } from './shell';
import { HonComposer } from './assistant';
import { HqIcon } from './icon';
import styles from './hq-modern.module.css';

const REALISTIC = [
  ['17.95%', '74.15%'], ['40.18%', '74.15%'], ['60.78%', '74.15%'],
  ['17.95%', '88.65%'], ['40.18%', '88.65%'], ['60.78%', '88.65%'],
];
const CHIBI = [
  ['21.07%', '74.83%'], ['36.1%', '74.83%'], ['51.3%', '74.83%'],
  ['66.4%', '74.83%'], ['81.5%', '74.83%'], ['96.6%', '74.83%'],
];

export function ExecutivePortrait({ index, name }: { index: number; name: string }): React.ReactElement {
  const { art } = useHqModern();
  if (art === 'anime') return <span className={styles.portraitFallback} role="img" aria-label={`${name}: Anime artwork pending`}>{name[0]}</span>;
  const position = (art === 'chibi' ? CHIBI : REALISTIC)[index] ?? REALISTIC[0]!;
  return <span role="img" aria-label={`${name}, ${art} portrait`} className={styles.portrait} style={{ '--portrait-x': position[0]!, '--portrait-y': position[1]! } as CSSProperties}/>;
}

export function ExecutiveCards(): React.ReactElement {
  return <section className={`${styles.panel} ${styles.executiveSection}`} aria-labelledby="hq-team-title">
    <div className={styles.sectionHeader}><div><h2 id="hq-team-title">Your executive team</h2><p>Six specialists. One coordinated company.</p></div><Link href="/hq/executives">View team <HqIcon name="chevron" size={16}/></Link></div>
    <div className={styles.executiveGrid}>{HQ_EXECUTIVES.map((executive, index) => <Link className={styles.executiveCard} href={`/hq/executives/${executive.executiveKey}`} key={executive.executiveKey} aria-label={`View ${executive.displayName}'s ${executive.domain.toLowerCase().replaceAll('_', ' ')} workspace`}>
      <ExecutivePortrait index={index} name={executive.displayName}/><div><h3>{executive.displayName}</h3><p>{executive.domain.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase())}</p><small>{HQ_RESPONSIBILITIES[executive.executiveKey]}</small><span>View workspace <HqIcon name="arrow" size={15}/></span></div>
    </Link>)}</div>
    <p className={styles.finePrint}>No recorded work. Executive task services are not active.</p>
  </section>;
}

export function NeedsAttention(): React.ReactElement {
  return <section className={`${styles.panel} ${styles.attention}`} aria-labelledby="hq-attention-title">
    <h2 id="hq-attention-title"><HqIcon name="attention"/>Needs Your Attention</h2>
    {([
      ['Pending approvals', '/hq/approvals', 'check'], ['Support escalations', '/hq/support', 'support'],
      ['Failed operations', '/hq/support', 'settings'], ['Owner decisions', '/hq/approvals', 'team'],
    ] as const).map(([label, href, icon]) => <Link className={styles.attentionRow} key={label} href={href}><HqIcon name={icon} size={19}/><span>{label}</span><span className={styles.badge}>Unavailable</span><HqIcon name="chevron" size={15}/></Link>)}
    <p className={styles.finePrint}>Verified HQ queues are not available yet. No pending count is assumed.</p>
  </section>;
}

export function CompanySnapshot(): React.ReactElement {
  const { overview } = useHqModern();
  return <section className={styles.panel} aria-labelledby="hq-snapshot-title">
    <h2 id="hq-snapshot-title">Company at a glance</h2>
    <Link href="/hq/revenue" className={styles.metricRow}><HqIcon name="chart" size={28}/><div><h3>Revenue</h3><p>MRR / ARR</p></div><span className={styles.badge}>Unavailable</span><HqIcon name="chevron" size={16}/></Link>
    <Link href="/hq/schools" className={styles.metricRow}><HqIcon name="school" size={28}/><div><h3>Schools</h3><p>{overview.organizationCount.toLocaleString('en-US')} organizations</p></div><strong className={styles.metricValue}>{overview.schoolCount.toLocaleString('en-US')}</strong><HqIcon name="chevron" size={16}/></Link>
    <Link href="/hq/ai-costs" className={styles.metricRow}><HqIcon name="database" size={28}/><div><h3>AI costs</h3><p>Usage &amp; spend</p></div><span className={styles.badge}>Unavailable</span><HqIcon name="chevron" size={16}/></Link>
    <details className={styles.factDetails}><summary>Verified platform facts</summary><dl><div><dt>Onboarding requests</dt><dd>{overview.onboarding.requestCount}</dd></div><div><dt>In progress</dt><dd>{overview.onboarding.inProgressRequestCount}</dd></div><div><dt>Completed</dt><dd>{overview.onboarding.completedRequestCount}</dd></div><div><dt>Configured task profiles</dt><dd>{overview.taskProfileCount}</dd></div></dl><p className={styles.finePrint}>Recorded provider states, not a live health check:</p><dl>{Object.entries(overview.configuredProviderStates).map(([state, count]) => <div key={state}><dt>{state}</dt><dd>{count}</dd></div>)}</dl></details>
    <p className={styles.finePrint}>As of {new Date(overview.asOf).toLocaleString('en-US', { timeZone: 'UTC' })} UTC</p>
  </section>;
}

export function GrowthLinks(): React.ReactElement {
  return <section className={`${styles.panel} ${styles.growthPanel}`} aria-labelledby="hq-growth-title"><div className={styles.sectionHeader}><h2 id="hq-growth-title">Growth &amp; Referrals</h2><span className={styles.badge}>Planned</span></div><p>Champions Club &amp; founder campaigns</p><div className={styles.growthLinks}>{HQ_GROWTH.map((item) => <Link key={item.path} href={item.path}><HqIcon name={item.icon} size={18}/><span>{item.title}</span><HqIcon name="chevron" size={14}/></Link>)}</div><p className={styles.finePrint}>Owner-controlled contests &amp; rewards. No activation from this interface.</p></section>;
}

export function HqModernDashboard(): React.ReactElement {
  const { openAssistant } = useHqModern();
  return <>
    <div className={styles.dashboard}>
      <section className={`${styles.panel} ${styles.hero}`} aria-labelledby="hon-command-title">
        <div className={styles.heroHeading}><div><h2>HON</h2><p>Executive AI Coordinator</p></div><button type="button" onClick={openAssistant} aria-label="Expand HON conversation"><HqIcon name="expand"/>Expand</button></div>
        <HonCore/><h2 id="hon-command-title" className={styles.heroQuestion}>What would you like to move forward?</h2>
        <div className={styles.conversationEmpty}><HonCore small/><p>HQ conversation is not connected yet. Review your company information using the tools below.</p></div>
        <div className={styles.promptLinks}><Link href="/hq/schools"><HqIcon name="school"/>Review school directory</Link><Link href="/hq/executives"><HqIcon name="team"/>Meet the executive team</Link></div>
        <HonComposer context="Overview"/>
      </section>
      <div className={styles.attentionSlot}><NeedsAttention/></div>
      <div className={styles.teamSlot}><ExecutiveCards/></div>
      <div className={styles.snapshotSlot}><CompanySnapshot/></div>
      <div className={styles.growthSlot}><GrowthLinks/></div>
    </div>
    <div className={styles.governance}><HqIcon name="shield" size={28}/><div><strong>You retain final approval.</strong><p>Owner → HON → Executives → Shared Action Engine</p></div><span>Permissions · Policy · Approval · Audit</span></div>
  </>;
}
