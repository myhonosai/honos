'use client';

import { useLocale } from '../localization/provider';
import React, { type CSSProperties } from 'react';
import Link from 'next/link';
import { HQ_EXECUTIVES, HQ_GROWTH, HQ_RESPONSIBILITIES } from './catalog';
import { useHqModern, HonCore } from './shell';
import { HonComposer } from './assistant';
import { CommercialStatus } from './commercial-status';
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
  const { t,text,number,money,date,formattingLocale } = useLocale();
  const { art } = useHqModern();
  if (art === 'anime') return <span className={styles.portraitFallback} role="img" aria-label={t("{name}: Anime artwork pending",{name})}>{name[0]}</span>;
  const position = (art === 'chibi' ? CHIBI : REALISTIC)[index] ?? REALISTIC[0]!;
  return <span role="img" aria-label={t("{name}, {style} portrait",{name,style:text(art==='chibi'?'Chibi':'Realistic')})} className={styles.portrait} style={{ '--portrait-x': position[0]!, '--portrait-y': position[1]! } as CSSProperties}/>;
}

export function ExecutiveCards(): React.ReactElement {
  const { t,text,number,money,date,formattingLocale } = useLocale();
  return <section className={`${styles.panel} ${styles.executiveSection}`} aria-labelledby="hq-team-title">
    <div className={styles.sectionHeader}><div><h2 id="hq-team-title">{t("Your executive team")}</h2><p>{t("Six specialists. One coordinated company.")}</p></div><Link href="/hq/executives">{t("View team")}{" "}<HqIcon name="chevron" size={16}/></Link></div>
    <div className={styles.executiveGrid}>{HQ_EXECUTIVES.map((executive, index) => <Link className={styles.executiveCard} href={`/hq/executives/${executive.executiveKey}`} key={executive.executiveKey} aria-label={t("View {name}'s {role} workspace",{name:executive.displayName,role:text(executive.domain.replaceAll('_',' ').toLowerCase().replace(/\b\w/g,l=>l.toUpperCase()))})}>
      <ExecutivePortrait index={index} name={executive.displayName}/><div><h3>{executive.displayName}</h3><p>{text(executive.domain.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase()))}</p><small>{text(HQ_RESPONSIBILITIES[executive.executiveKey] ?? '')}</small><span>{t("View workspace")}{" "}<HqIcon name="arrow" size={15}/></span></div>
    </Link>)}</div>
    <p className={styles.finePrint}>{t("No recorded work. Executive task services are not active.")}</p>
  </section>;
}

export function NeedsAttention(): React.ReactElement {
  const { t,text,number,money,date,formattingLocale } = useLocale();
  return <section className={`${styles.panel} ${styles.attention}`} aria-labelledby="hq-attention-title">
    <h2 id="hq-attention-title"><HqIcon name="attention"/>{t("Needs Your Attention")}</h2>
    {([
      [t("Pending approvals"), '/hq/approvals', 'check'], [t("Support escalations"), '/hq/support', 'support'],
      [t("Failed operations"), '/hq/support', 'settings'], [t("Owner decisions"), '/hq/approvals', 'team'],
    ] as const).map(([label, href, icon]) => <Link className={styles.attentionRow} key={label} href={href}><HqIcon name={icon} size={19}/><span>{label}</span><span className={styles.badge}>{t("Unavailable")}</span><HqIcon name="chevron" size={15}/></Link>)}
    <p className={styles.finePrint}>{t("Verified HQ queues are not available yet. No pending count is assumed.")}</p>
  </section>;
}

export function CompanySnapshot(): React.ReactElement {
  const { t,text,number,money,date,formattingLocale } = useLocale();
  const { overview } = useHqModern();
  return <section className={styles.panel} aria-labelledby="hq-snapshot-title">
    <h2 id="hq-snapshot-title">{t("Company at a glance")}</h2>
    <Link href="/hq/revenue" className={styles.metricRow}><HqIcon name="chart" size={28}/><div><h3>{t("Revenue")}</h3><p>{t("MRR / ARR")}</p></div><span className={styles.badge}>{t("Unavailable")}</span><HqIcon name="chevron" size={16}/></Link>
    <Link href="/hq/schools" className={styles.metricRow}><HqIcon name="school" size={28}/><div><h3>{t("Schools")}</h3><p>{t("{count} organizations",{count:number(overview.organizationCount)})}</p></div><strong className={styles.metricValue}>{overview.schoolCount.toLocaleString(formattingLocale)}</strong><HqIcon name="chevron" size={16}/></Link>
    <Link href="/hq/ai-costs" className={styles.metricRow}><HqIcon name="database" size={28}/><div><h3>{t("AI costs")}</h3><p>{t("Usage & spend")}</p></div><span className={styles.badge}>{t("Unavailable")}</span><HqIcon name="chevron" size={16}/></Link>
    <details className={styles.factDetails}><summary>{t("Verified platform facts")}</summary><dl><div><dt>{t("Onboarding requests")}</dt><dd>{number(overview.onboarding.requestCount)}</dd></div><div><dt>{t("In progress")}</dt><dd>{number(overview.onboarding.inProgressRequestCount)}</dd></div><div><dt>{t("Completed")}</dt><dd>{number(overview.onboarding.completedRequestCount)}</dd></div><div><dt>{t("Configured task profiles")}</dt><dd>{number(overview.taskProfileCount)}</dd></div></dl><p className={styles.finePrint}>{t("Recorded provider states, not a live health check:")}</p><dl>{Object.entries(overview.configuredProviderStates).map(([state, count]) => <div key={state}><dt>{text(state[0]!.toUpperCase()+state.slice(1))}</dt><dd>{number(count)}</dd></div>)}</dl></details>
    <p className={styles.finePrint}>{t("As of {date}",{date:date(overview.asOf)})}</p>
  </section>;
}

export function GrowthLinks(): React.ReactElement {
  const { t,text,number,money,date,formattingLocale } = useLocale();
  return <section className={`${styles.panel} ${styles.growthPanel}`} aria-labelledby="hq-growth-title"><div className={styles.sectionHeader}><h2 id="hq-growth-title">{t("Growth & Referrals")}</h2><span className={styles.badge}>{t("Read-only standings")}</span></div><p>{t("Champions Club & founder campaigns")}</p><div className={styles.growthLinks}>{HQ_GROWTH.map((item) => <Link key={item.path} href={item.path}><HqIcon name={item.icon} size={18}/><span>{text(item.title)}</span><HqIcon name="chevron" size={14}/></Link>)}</div><Link className={styles.growthOpen} href="/hq/growth">{t("Open Growth & Referrals")}{" "}<HqIcon name="chevron" size={16}/></Link><p className={styles.finePrint}>{t("Qualified standings use the authorized HQ service. Contests & reward actions remain planned.")}</p></section>;
}

function CommandStage(): React.ReactElement {
  const { t,text,number,money,date,formattingLocale } = useLocale();
  const { openAssistant } = useHqModern();
  return <section className={styles.commandStage} aria-labelledby="hq-team-title">
    <div className={styles.stageHeader}><div><h2 id="hq-team-title">{t("Your executive team")}</h2><p>{t("Six specialists. One company command center.")}</p></div><Link href="/hq/executives">{t("View team")}{" "}<HqIcon name="chevron" size={15}/></Link></div>
    <div className={styles.commandLineup}>
      <div className={styles.commandCore}>
        <div className={styles.orbFrame}><span className={styles.coreOrbits} data-hq-orbits aria-hidden="true"><i/><i/><i/></span><HonCore/><strong aria-hidden="true">{t("HON")}</strong></div>
        <div className={styles.honDock} data-hq-conversation-dock>
          <div className={styles.coreCaption}><h2>{t("HON")}</h2><p>{t("Executive AI Coordinator")}</p></div>
          <button type="button" className={styles.honEntry} onClick={openAssistant} aria-label={t("Expand HON conversation")}><HqIcon name="mic" size={22}/><span>{t("Ask HON anything")}</span><HqIcon name="expand" size={15}/></button>
          <small className={styles.coreState}>{t("Conversation unavailable · Microphone off")}</small>
        </div>
      </div>
      <div className={styles.stageTeam}>{HQ_EXECUTIVES.map((executive, index) => <Link className={styles.stageExecutive} style={{ '--stage-column': index < 3 ? index + 1 : index + 2 } as CSSProperties} href={`/hq/executives/${executive.executiveKey}`} key={executive.executiveKey} aria-label={t("View {name}'s {role} workspace",{name:executive.displayName,role:text(executive.domain.replaceAll('_',' ').toLowerCase().replace(/\b\w/g,l=>l.toUpperCase()))})}>
        <ExecutivePortrait index={index} name={executive.displayName}/>
        <div className={styles.stageIdentity}><h3>{executive.displayName}</h3><p>{text(executive.domain.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase()))}</p><small>{text(HQ_RESPONSIBILITIES[executive.executiveKey] ?? '')}</small></div>
        <span className={styles.workspaceEntry}>{t("Workspace")}{" "}<HqIcon name="arrow" size={14}/></span>
      </Link>)}</div>
    </div>
    <div className={styles.commandBar}><div className={styles.commandPrompt}><HqIcon name="mic" size={22}/><h2>{t("How can HON help today?")}</h2><span>{t("No recorded work · Executive task services are not active")}</span></div><HonComposer context="Overview"/><div className={styles.commandShortcuts}><Link href="/hq/schools">{t("Review schools")}{" "}<HqIcon name="chevron" size={13}/></Link><Link href="/hq/revenue">{t("Revenue overview")}{" "}<HqIcon name="chevron" size={13}/></Link><Link href="/hq/ai-costs">{t("Review AI costs")}{" "}<HqIcon name="chevron" size={13}/></Link><Link href="/hq/growth">{t("Growth & Referrals")}{" "}<HqIcon name="chevron" size={13}/></Link></div></div>
  </section>;
}

function PerformanceStrip(): React.ReactElement {
  const { t,text,number,money,date,formattingLocale } = useLocale();
  const { overview } = useHqModern();
  return <section className={styles.performanceStrip} aria-label={t("Company performance overview")}>
    {([
      [t("Schools"), '/hq/schools', 'school', overview.schoolCount, t("Verified directory")],
      [t("Organizations"), '/hq/schools', 'team', overview.organizationCount, t("Verified overview")],
      [t("Revenue"), '/hq/revenue', 'chart', null, t("Unavailable")],
      [t("AI costs"), '/hq/ai-costs', 'database', null, t("Unavailable")],
      [t("Approvals"), '/hq/approvals', 'check', null, t("Unavailable")],
      [t("Support"), '/hq/support', 'support', null, t("Unavailable")],
    ] as const).map(([label, href, icon, value, state]) => <Link className={styles.performanceTile} href={href} key={label}><span className={styles.metricIcon}><HqIcon name={icon} size={23}/></span><div><h2>{label}</h2><strong>{value === null ? '—' : value.toLocaleString(formattingLocale)}</strong><small>{state}</small></div></Link>)}
  </section>;
}

export function HqModernDashboard(): React.ReactElement {
  const { t,text,number,money,date,formattingLocale } = useLocale();
  return <>
    <div className={styles.dashboard}>
      <CommandStage/>
      <PerformanceStrip/>
      <CommercialStatus/>
      <div className={styles.managementGrid}>
        <div className={styles.attentionSlot}><NeedsAttention/></div>
        <div className={styles.snapshotSlot}><CompanySnapshot/></div>
        <div className={styles.growthSlot}><GrowthLinks/></div>
      </div>
    </div>
    <div className={styles.governance}><HqIcon name="shield" size={28}/><div><strong>{t("You retain final approval.")}</strong><p>{t("Owner → HON → Executives → Shared Action Engine")}</p></div><span>{t("Permissions · Policy · Approval · Audit")}</span></div>
  </>;
}
