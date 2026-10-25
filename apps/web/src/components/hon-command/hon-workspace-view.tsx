'use client';

import React, { useEffect, useRef, useState } from 'react';
import type { ActionReviewItem, AiDraftWorkItem, CommandCenterRecommendation } from '@hon/contracts';
import type { HonInterfaceTheme } from '@hon/design-system';
import { HON_MARK_SOURCE } from '../classic-dashboard/portraits';
import type { HonCommandSnapshot, HonSection } from './hon-command-data';
import { HON_CONVERSATION_BOUNDARY, honComposerEnabled } from './hon-conversation';
import { HON_COMMAND_ROSTER, HON_DRAFT_WORK_SOURCES, HON_RECOMMENDATION_AREAS, HON_TEACHING_AI, teachingAiPortrait, approvalSourceLabel, honAgent, type HonCommandAgent } from './roster';
import styles from './hon-command.module.css';

/** The existing requester-scoped reads return at most 20 records per source across all schools. */
export const HON_PARTIAL_HISTORY = 'Shows up to your 20 most recent drafts per source, across all your schools, so older drafts may not appear. This is not a complete history.';

export type HonTab = 'team' | 'suggested' | 'work' | 'approvals';
export const HON_TABS: readonly { id: HonTab; label: string }[] = [
  { id: 'team', label: 'AI team' },
  { id: 'suggested', label: 'Suggested' },
  { id: 'work', label: 'AI work' },
  { id: 'approvals', label: 'Approvals' },
];

export interface HonWorkspaceViewProps {
  snapshot: HonCommandSnapshot;
  variant: HonInterfaceTheme;
  presentation: 'panel' | 'full';
  tab: HonTab;
  selectedAgentId: string | null;
  headingId: string;
  onTab?: ((tab: HonTab) => void) | undefined;
  onSelectAgent?: ((id: string | null) => void) | undefined;
  onRefresh?: (() => void) | undefined;
  onClose?: (() => void) | undefined;
  expandHref?: string | undefined;
  returnHref?: string | undefined;
}

const STATUS_WORDS = (value: string): string => value.replaceAll('_', ' ').toLowerCase().replace(/^\w/, (letter) => letter.toUpperCase());
function when(value: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

export function HonMark({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }): React.ReactElement {
  const [failed, setFailed] = useState(false);
  const image = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const element = image.current;
    if (element?.complete && element.naturalWidth === 0) setFailed(true);
  }, []);
  return <span className={styles.mark} data-size={size} aria-hidden="true">
    {failed ? <span className={styles.markFallback}>H</span> : <img ref={image} src={HON_MARK_SOURCE} alt="" onError={() => setFailed(true)} />}
  </span>;
}

export function AgentPortrait({ agent, size = 'md' }: { agent: Pick<HonCommandAgent, 'name' | 'color' | 'portrait'>; size?: 'sm' | 'md' | 'lg' }): React.ReactElement {
  const [failed, setFailed] = useState(false);
  const image = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const element = image.current;
    if (element?.complete && element.naturalWidth === 0) setFailed(true);
  }, []);
  return <span className={styles.portrait} data-size={size} style={{ '--agent': agent.color } as React.CSSProperties} aria-hidden="true">
    {failed ? <span>{agent.name.charAt(0)}</span> : <img ref={image} src={agent.portrait} alt="" onError={() => setFailed(true)} />}
  </span>;
}

export function AvailabilityBadge({ agent, compact = false }: { agent: HonCommandAgent; compact?: boolean }): React.ReactElement {
  return agent.availability === 'GOVERNED_DRAFTS'
    ? <span className={styles.badge} data-tone="ready">{compact ? 'Drafts · approval' : 'Drafts · approval required'}</span>
    : <span className={styles.badge} data-tone="planned">{compact ? 'Planned' : 'Planned · not yet available'}</span>;
}

function SectionState<T>({ section, label }: { section: HonSection<T>; label: string }): React.ReactElement | null {
  if (section.state === 'READY') return null;
  if (section.state === 'LOADING' || section.state === 'IDLE') return <p className={styles.state} role="status" aria-live="polite" data-state={section.state}>{section.message}</p>;
  if (section.state === 'EMPTY') return <p className={styles.state} data-state="EMPTY">{section.message}</p>;
  return <div className={styles.state} role={section.state === 'ERROR' ? 'alert' : 'status'} data-state={section.state}>
    <strong>{section.state === 'DENIED' ? `${label}: not available for your access` : `${label}: unavailable`}</strong>
    <p>{section.message}</p>
  </div>;
}

function Conversation({ presentation }: { presentation: 'panel' | 'full' }): React.ReactElement {
  // No server-confirmed readiness exists yet, so the composer stays disabled.
  const enabled = honComposerEnabled(null);
  return <section className={styles.conversation} aria-labelledby={`hon-conversation-${presentation}`}>
    <div className={styles.conversationHead}>
      <h3 id={`hon-conversation-${presentation}`}>Ask HON</h3>
      <span className={styles.badge} data-tone="blocked">Not connected</span>
    </div>
    <p className={styles.conversationNote}><strong>{HON_CONVERSATION_BOUNDARY.headline}.</strong> {HON_CONVERSATION_BOUNDARY.detail}</p>
    <div className={styles.composer}>
      <label htmlFor={`hon-composer-${presentation}`} className={styles.visuallyHidden}>Message HON (not connected)</label>
      <textarea id={`hon-composer-${presentation}`} rows={presentation === 'full' ? 3 : 2} disabled={!enabled} placeholder="Conversation is not connected yet" aria-describedby={`hon-composer-help-${presentation}`} />
      <button type="button" disabled={!enabled}>Send</button>
    </div>
    <p id={`hon-composer-help-${presentation}`} className={styles.meta}>{HON_CONVERSATION_BOUNDARY.history}</p>
    <a className={styles.inlineLink} href={HON_CONVERSATION_BOUNDARY.handoff.href}>{HON_CONVERSATION_BOUNDARY.handoff.label} →</a>
    <p className={styles.meta}>{HON_CONVERSATION_BOUNDARY.handoff.detail}</p>
  </section>;
}

function draftCount(snapshot: HonCommandSnapshot, agent: HonCommandAgent): number | null {
  if (!agent.draftWorkKey || snapshot.draftWork.state !== 'READY' && snapshot.draftWork.state !== 'EMPTY') return null;
  if (snapshot.draftWork.data?.unavailable.includes(agent.draftWorkKey)) return null;
  return snapshot.draftWork.data?.items.filter((item) => item.agentKey === agent.draftWorkKey).length ?? 0;
}

function TeamGrid({ snapshot, variant, onSelectAgent }: { snapshot: HonCommandSnapshot; variant: HonInterfaceTheme; onSelectAgent?: (id: string) => void }): React.ReactElement {
  return <ul className={styles.team} data-variant={variant} aria-label="HON AI management team">
    {HON_COMMAND_ROSTER.map((agent) => {
      const count = draftCount(snapshot, agent);
      return <li key={agent.id}>
        <button type="button" className={styles.agentCard} style={{ '--agent': agent.color } as React.CSSProperties} onClick={() => onSelectAgent?.(agent.id)} aria-label={`${agent.name}, ${agent.title}. ${agent.availability === 'GOVERNED_DRAFTS' ? 'Governed drafts available with approval' : 'Planned, not yet available'}. Open details`}>
          <AgentPortrait agent={agent} />
          <span className={styles.agentText}>
            <strong>{agent.name}</strong>
            <small>{agent.title}</small>
            <AvailabilityBadge agent={agent} />
            {count !== null ? <span className={styles.meta}>{count === 0 ? 'No recent drafts here' : `${count} recent ${count === 1 ? 'draft' : 'drafts'}`}</span> : null}
          </span>
        </button>
      </li>;
    })}
  </ul>;
}

function TeachingAiCard({ variant }: { variant: HonInterfaceTheme }): React.ReactElement {
  const ai = HON_TEACHING_AI;
  const portrait = teachingAiPortrait(variant);
  return <section className={styles.teachingAi} style={{ '--agent': ai.color } as React.CSSProperties} aria-labelledby="hon-teaching-ai" data-kai-style={variant}>
    {/* Keyed by source so a mode switch retries the image instead of keeping an earlier fallback. */}
    <AgentPortrait key={portrait} agent={{ ...ai, portrait }} size="lg" />
    <div>
      <p className={styles.kicker}>Separate instructional AI · not part of the management team</p>
      <h3 id="hon-teaching-ai">{ai.name} <small>(provisional name)</small></h3>
      <p className={styles.role}>{ai.title}</p>
      <span className={styles.badge} data-tone="planned">Planned · not yet available</span>
      <p>{ai.purpose}</p>
      <p className={styles.note}>{ai.boundary}</p>
      <h4>Existing teaching tools you run yourself</h4>
      <ul className={styles.links}>{ai.tools.map((tool) => <li key={tool.href}><a href={tool.href}>{tool.label} →</a></li>)}</ul>
    </div>
  </section>;
}

function WorkItem({ item }: { item: AiDraftWorkItem }): React.ReactElement {
  const source = HON_DRAFT_WORK_SOURCES[item.agentKey];
  return <li className={styles.row} data-legacy={source.agentId === null ? 'true' : undefined}>
    <div>
      <strong>{source.label}</strong>
      <span className={styles.meta}>{source.detail}</span>
    </div>
    <div className={styles.rowStatus}>
      <span className={styles.badge} data-tone={item.status === 'AWAITING_APPROVAL' ? 'waiting' : item.status === 'UNKNOWN' || item.status === 'FAILED' ? 'blocked' : 'neutral'}>{STATUS_WORDS(item.status)}</span>
      <span className={styles.meta}>Recorded {when(item.updatedAt)}</span>
    </div>
    <a className={styles.inlineLink} href={`${source.destination}#invocation=${item.id}`}>Open record →</a>
  </li>;
}

function AgentDetail({ agent, snapshot, onBack }: { agent: HonCommandAgent; snapshot: HonCommandSnapshot; onBack?: () => void }): React.ReactElement {
  const work = snapshot.draftWork;
  const items = agent.draftWorkKey && work.data ? work.data.items.filter((item) => item.agentKey === agent.draftWorkKey) : [];
  const accessDenied = agent.draftWorkKey && work.data?.unavailable.includes(agent.draftWorkKey);
  return <article className={styles.detail} style={{ '--agent': agent.color } as React.CSSProperties} aria-labelledby={`hon-agent-${agent.id}`}>
    <button type="button" className={styles.back} onClick={onBack}>← All seven employees</button>
    <header className={styles.detailHead}>
      <AgentPortrait agent={agent} size="lg" />
      <div>
        <h3 id={`hon-agent-${agent.id}`}>{agent.name}</h3>
        <p className={styles.role}>{agent.title}</p>
        <AvailabilityBadge agent={agent} />
        <p>{agent.purpose}</p>
      </div>
    </header>
    {agent.workspace ? <a className={styles.primary} href={agent.workspace.href}>{agent.workspace.label} →</a> : null}
    <h4>Capabilities</h4>
    <ul className={styles.capabilities}>
      {agent.capabilities.map((capability) => <li key={capability.label} data-state={capability.state}>
        <span>{capability.label}</span>
        {capability.state === 'AVAILABLE' && capability.href
          ? <a href={capability.href}>Available · open</a>
          : <em>Backend required</em>}
      </li>)}
    </ul>
    <h4>Related school workflows</h4>
    <p className={styles.meta}>Conventional workflows you run yourself. Opening one does not ask {agent.name} to do anything.</p>
    <ul className={styles.links}>{agent.workflows.map((workflow) => <li key={workflow.href}><a href={workflow.href}>{workflow.label} →</a></li>)}</ul>
    <h4>Approval and review</h4>
    <p>{agent.approval}</p>
    <h4>Recent verified work</h4>
    {!agent.draftWorkKey
      ? <p className={styles.state} data-state="EMPTY">{agent.name} has no AI work contract yet, so there is no recorded work to show. Nothing is assumed.</p>
      : accessDenied
        ? <p className={styles.state} data-state="DENIED">Your current access does not include {agent.name}’s draft work in this school.</p>
        : work.state === 'READY' || work.state === 'EMPTY'
          ? items.length ? <ul className={styles.rows}>{items.map((item) => <WorkItem key={item.id} item={item} />)}</ul> : <p className={styles.state} data-state="EMPTY">No recent {agent.name} drafts for this school.</p>
          : <SectionState section={work} label="Recorded AI work" />}
    {agent.draftWorkKey ? <p className={styles.meta}>{HON_PARTIAL_HISTORY}</p> : null}
    {agent.id === 'claire' ? <p className={styles.note}>Older teaching drafts were stored under a legacy “claire” key before the roster was approved. They stay labeled as teaching drafts in AI work and are not shown as Claire’s business performance work.</p> : null}
  </article>;
}

function Recommendation({ item }: { item: CommandCenterRecommendation }): React.ReactElement {
  const area = honAgent(HON_RECOMMENDATION_AREAS[item.id]);
  return <li className={styles.row}>
    <div>
      <strong>{item.title}</strong>
      <span className={styles.meta}>{item.why}</span>
      {area ? <span className={styles.meta}>Team area: {area.name} · {area.title}</span> : null}
    </div>
    <a className={styles.inlineLink} href={item.route}>Open →</a>
  </li>;
}

function Approval({ item }: { item: ActionReviewItem }): React.ReactElement {
  return <li className={styles.row}>
    <div>
      <strong>{approvalSourceLabel(item.actionCode)}</strong>
      <span className={styles.meta}><code>{item.actionCode}</code> · requested {when(item.createdAt)}{item.approvalExpiresAt ? ` · expires ${when(item.approvalExpiresAt)}` : ''}</span>
    </div>
    <span className={styles.badge} data-tone="waiting">Awaiting review</span>
  </li>;
}

function TabPanel({ tab, snapshot, variant, selectedAgentId, onSelectAgent }: Pick<HonWorkspaceViewProps, 'tab' | 'snapshot' | 'variant' | 'selectedAgentId' | 'onSelectAgent'>): React.ReactElement {
  if (tab === 'team') {
    const agent = honAgent(selectedAgentId);
    if (agent) return <AgentDetail agent={agent} snapshot={snapshot} onBack={() => onSelectAgent?.(null)} />;
    return <>
      <p className={styles.lede}>Seven specialists coordinated by HON. Chad and Marcus can prepare governed drafts today; the others are planned and show no activity until a real contract exists.</p>
      <TeamGrid snapshot={snapshot} variant={variant} onSelectAgent={(id) => onSelectAgent?.(id)} />
      <TeachingAiCard variant={variant} />
    </>;
  }
  if (tab === 'suggested') {
    const section = snapshot.commandCenter;
    return <>
      <p className={styles.lede}>Deterministic suggestions from the School Command Center’s verified counts. They are navigation only; nothing runs automatically.</p>
      {section.data && section.data.entitlementTier !== 'COMPLETE' ? <p className={styles.note}>The Command Center reports this school on {section.data.entitlementTier}. AI employee drafting needs HON Complete, and the server enforces that on every request.</p> : null}
      {section.data ? <p className={styles.briefing}>{section.data.dailyBriefing}</p> : null}
      <SectionState section={section} label="Suggested actions" />
      {section.state === 'READY' && section.data ? <ul className={styles.rows}>{section.data.recommendations.map((item) => <Recommendation key={item.id} item={item} />)}</ul> : null}
      <a className={styles.inlineLink} href="/staff/command-center">Open the School Command Center →</a>
    </>;
  }
  if (tab === 'work') {
    const section = snapshot.draftWork;
    return <>
      <p className={styles.lede}>Durable AI draft work you requested in this school. Status only: no draft text, prompts, provider details or delivery.</p>
      <p className={styles.meta}>{HON_PARTIAL_HISTORY}</p>
      {section.data?.unavailable.length ? <p className={styles.note}>Your access does not include some draft sources here: {section.data.unavailable.map((key) => HON_DRAFT_WORK_SOURCES[key].label).join(', ')}. No missing work is assumed.</p> : null}
      <SectionState section={section} label="Recorded AI work" />
      {section.state === 'READY' && section.data ? <ul className={styles.rows}>{section.data.items.map((item) => <WorkItem key={item.id} item={item} />)}</ul> : null}
      <a className={styles.inlineLink} href="/staff/ai-work">Open My governed AI work →</a>
    </>;
  }
  const section = snapshot.approvals;
  const pending = snapshot.commandCenter.data?.metrics.pendingActionApprovals.count;
  return <>
    <p className={styles.lede}>Proposals waiting for a qualified human. Decide in Action Center, which re-checks your permission, the exact payload and its expiry.</p>
    {typeof pending === 'number' ? <p className={styles.briefing}>Command Center count: {pending} awaiting review.</p> : null}
    <SectionState section={section} label="Approvals" />
    {section.state === 'READY' && section.data ? <ul className={styles.rows}>{section.data.items.slice(0, 8).map((item) => <Approval key={item.id} item={item} />)}</ul> : null}
    {section.data && (section.data.more || section.data.items.length > 8) ? <p className={styles.meta}>More proposals are waiting than are listed here.</p> : null}
    <a className={styles.primary} href="/staff/action-center/approvals">Review in Action Center →</a>
  </>;
}

function tabCount(tab: HonTab, snapshot: HonCommandSnapshot): number | null {
  if (tab === 'suggested' && snapshot.commandCenter.data) return snapshot.commandCenter.data.recommendations.length;
  if (tab === 'work' && snapshot.draftWork.data) return snapshot.draftWork.data.items.length;
  if (tab === 'approvals' && snapshot.approvals.data) return snapshot.approvals.data.items.length + (snapshot.approvals.data.more ? 1 : 0);
  return null;
}

export function HonTabs({ tab, snapshot, onTab, idPrefix }: { tab: HonTab; snapshot: HonCommandSnapshot; onTab?: ((tab: HonTab) => void) | undefined; idPrefix: string }): React.ReactElement {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  function move(event: React.KeyboardEvent<HTMLDivElement>) {
    const index = HON_TABS.findIndex((item) => item.id === tab);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % HON_TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + HON_TABS.length) % HON_TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = HON_TABS.length - 1;
    else return;
    event.preventDefault();
    onTab?.(HON_TABS[next]!.id);
    refs.current[next]?.focus();
  }
  return <div className={styles.tabs} role="tablist" aria-label="HON workspace sections" onKeyDown={move}>
    {HON_TABS.map((item, index) => {
      const count = tabCount(item.id, snapshot);
      const label = item.id === 'approvals' && count !== null && snapshot.approvals.data?.more ? `${count - 1}+` : count;
      return <button key={item.id} ref={(element) => { refs.current[index] = element; }} type="button" role="tab" id={`${idPrefix}-tab-${item.id}`} aria-controls={`${idPrefix}-panel`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} onClick={() => onTab?.(item.id)}>
        {item.label}{label !== null ? <span className={styles.count}>{label}</span> : null}
      </button>;
    })}
  </div>;
}

/** Pure presentation shared by the panel, the full workspace and all three modes. */
export function HonWorkspaceView(props: HonWorkspaceViewProps): React.ReactElement {
  const { snapshot, variant, presentation, tab, headingId } = props;
  const scope = snapshot.scope;
  const verified = scope.state === 'VERIFIED';
  const idPrefix = `${headingId}-${presentation}`;
  return <div className={styles.workspace} data-variant={variant} data-presentation={presentation}>
    <header className={styles.header}>
      <HonMark size={presentation === 'full' ? 'lg' : 'md'} />
      <div className={styles.headerText}>
        <p className={styles.kicker}>HON OS · AI management team</p>
        <h2 id={headingId} tabIndex={-1}>HON</h2>
        <p className={styles.meta}>{scope.message}</p>
      </div>
      <div className={styles.headerActions}>
        {verified ? <button type="button" onClick={props.onRefresh}>Refresh</button> : null}
        {props.expandHref ? <a href={props.expandHref}>Full workspace</a> : null}
        {props.returnHref ? <a href={props.returnHref}>Back to dashboard</a> : null}
        {props.onClose ? <button type="button" onClick={props.onClose} aria-label="Close HON">Close</button> : null}
      </div>
    </header>
    {scope.state === 'SELECTION_REQUIRED' || scope.state === 'DENIED' || scope.state === 'ERROR'
      ? <div className={styles.state} role={scope.state === 'ERROR' ? 'alert' : 'status'} data-state={scope.state}>
        <strong>{scope.state === 'SELECTION_REQUIRED' ? 'Choose a school first' : scope.state === 'DENIED' ? 'School access unavailable' : 'School check failed'}</strong>
        <p>{scope.message}</p>
        <p className={styles.meta}>HON’s management team appears only after the server confirms school management access. Teaching-only access does not include it.</p>
        <a className={styles.inlineLink} href="/staff/dashboard">Open the operations dashboard →</a>
      </div>
      : null}
    {scope.state === 'RESOLVING' ? <p className={styles.state} role="status" data-state="LOADING">{scope.message}</p> : null}
    {/* Management agents, suggestions, AI work and approvals render only for a server-verified management scope. */}
    {verified ? <div className={styles.body}>
      <Conversation presentation={presentation} />
      <section className={styles.sections} aria-label="HON workspace">
        <HonTabs tab={tab} snapshot={snapshot} onTab={props.onTab} idPrefix={idPrefix} />
        <div className={styles.tabPanel} role="tabpanel" id={`${idPrefix}-panel`} aria-labelledby={`${idPrefix}-tab-${tab}`} tabIndex={0}>
          <TabPanel tab={tab} snapshot={snapshot} variant={variant} selectedAgentId={props.selectedAgentId} onSelectAgent={props.onSelectAgent} />
        </div>
      </section>
    </div> : null}
  </div>;
}
