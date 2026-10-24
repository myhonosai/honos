'use client';

import React, { useCallback, useEffect, useState } from 'react';
import type { AiDraftWorkAgentKey, AiDraftWorkItem } from '@hon/contracts';
import { loadAllMyAiDraftWork } from './ai-draft-work-http';
import styles from './ai-draft-work-inbox.module.css';

const AGENTS: Record<AiDraftWorkAgentKey, { name: string; destination: string; destinationLabel: string; role: string }> = {
  marcus: { name: 'Marcus', role: 'Growth planning', destination: '/staff/marketing/assistant', destinationLabel: 'Open marketing draft guide' },
  // Legacy record key: these are curriculum teaching drafts, not Claire's Business Performance work.
  claire: { name: 'Teaching drafts', role: 'Legacy curriculum drafts', destination: '/staff/teaching-assistant', destinationLabel: 'Open teaching draft guide' },
  chad: { name: 'Chad', role: 'CRM follow-up drafts', destination: '/staff/leads/assistant', destinationLabel: 'Open follow-up draft guide' },
};

function statusLabel(status: AiDraftWorkItem['status']): string {
  return status.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function reasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  return reason.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function describeApprovalHandoff(item: AiDraftWorkItem): { message: string; canOpenActionCenter: boolean } {
  if (!item.actionRequestId) return { message: 'No approval handoff is recorded for this durable work item.', canOpenActionCenter: false };
  if (item.status === 'AWAITING_APPROVAL') return { message: 'A recorded approval handoff may be available in Action Center. That queue independently determines whether the current qualified human can review it.', canOpenActionCenter: true };
  if (item.status === 'APPROVED' || item.status === 'REJECTED') return { message: 'A governed approval handoff was recorded previously. The durable status above is the only state shown here.', canOpenActionCenter: false };
  return { message: 'A governed approval handoff is recorded, but its current review availability is not inferred here.', canOpenActionCenter: false };
}

function approvalMessage(item: AiDraftWorkItem): React.ReactElement {
  const handoff = describeApprovalHandoff(item);
  if (!handoff.canOpenActionCenter) return <p className={styles.handoffMuted}>{handoff.message}</p>;
  return <p className={styles.handoff}><strong>Approval handoff recorded.</strong> {handoff.message} <a href="/staff/action-center/approvals">Open the existing Action Center</a></p>;
}

export function AiDraftWorkInbox() {
  const [items, setItems] = useState<AiDraftWorkItem[]>([]);
  const [unavailable, setUnavailable] = useState<AiDraftWorkAgentKey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await loadAllMyAiDraftWork();
      setItems(result.items);
      setUnavailable(result.unavailable);
    } catch (caught) {
      setItems([]);
      setUnavailable([]);
      setError(caught instanceof Error ? caught.message : 'The Governed AI Work workspace is temporarily unavailable.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return <main className={styles.workspace} aria-labelledby="ai-draft-work-title">
    <header className={styles.header}>
      <div>
        <p className={styles.kicker}>HON COMPLETE / GOVERNED AI WORK</p>
        <h1 id="ai-draft-work-title">My governed AI work</h1>
        <p className={styles.summary}>Review durable, private pointers for drafting work that you initiated. The workspace shows recorded state only; it is not a chat transcript, provider console, delivery queue, or agent activity feed.</p>
      </div>
      <div className={styles.headerActions}>
        <button type="button" onClick={() => void refresh()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh recorded state'}</button>
      </div>
    </header>

    <section className={styles.boundary} aria-label="Governed work boundary">
      <span>WORK BOUNDARY</span>
      <p>Opening this workspace never sends, publishes, pays, retries an unknown provider result, assigns staff, or approves anything. A linked approval still requires the existing qualified-human Action Center review.</p>
    </section>

    <nav className={styles.agentLinks} aria-label="Bounded drafting workbenches">
      {(Object.entries(AGENTS) as Array<[AiDraftWorkAgentKey, typeof AGENTS[AiDraftWorkAgentKey]]>).map(([key, agent]) => <a key={key} href={agent.destination}><span>{agent.name}</span><small>{agent.role}</small><b>{agent.destinationLabel} →</b></a>)}
    </nav>

    {error ? <section className={styles.error} role="alert"><strong>Workspace unavailable.</strong><p>{error}</p></section> : null}
    {unavailable.length ? <section className={styles.notice}><strong>Limited access</strong><p>Current permissions do not include {unavailable.map((agent) => AGENTS[agent]?.name ?? agent).join(', ')} draft work in this school. No missing work is assumed.</p></section> : null}
    {!loading && !error && !items.length ? <section className={styles.empty}><h2>No current durable draft work</h2><p>There are no Marcus, Chad, or legacy teaching draft requests available to your current direct-human scope. Create a bounded request from an established draft guide when authorized.</p></section> : null}

    <section className={styles.list} aria-live="polite" aria-busy={loading} aria-label="Recorded governed AI work">
      {loading ? <p className={styles.loading}>Loading only the durable work available to your current direct-human scope…</p> : null}
      {items.map((item) => {
        const agent = AGENTS[item.agentKey];
        if (!agent) return null;
        return <article className={styles.card} key={item.id}>
          <div className={styles.cardTitle}>
            <span className={styles.agentMark}>{agent.name.slice(0, 1)}</span>
            <div><p>{agent.name} · {agent.role}</p><h2>{statusLabel(item.status)}</h2></div>
          </div>
          <div className={styles.cardBody}>
            <p>{reasonLabel(item.reason) ?? 'No additional recorded status reason is available.'}</p>
            <p className={styles.meta}>Recorded state updated {new Date(item.updatedAt).toLocaleString()}.</p>
            {approvalMessage(item)}
          </div>
          <div className={styles.cardActions}>
            <a href={`${agent.destination}#invocation=${item.id}`}>Open secure work record →</a>
          </div>
        </article>;
      })}
    </section>
  </main>;
}
