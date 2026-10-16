'use client';

import React, { useCallback, useEffect, useState } from 'react';
import type { AiDraftWorkAgentKey, AiDraftWorkItem } from '@hon/contracts';
import { loadAllMyAiDraftWork } from './ai-draft-work-http';

const AGENTS: Record<AiDraftWorkAgentKey, { name: string; destination: string }> = {
  marcus: { name: 'Marcus', destination: '/staff/marketing/assistant' },
  claire: { name: 'Claire', destination: '/staff/teaching-assistant' },
  chad: { name: 'Chad', destination: '/staff/leads/assistant' },
};

function statusLabel(status: AiDraftWorkItem['status']): string {
  return status.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function reasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  return reason.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
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
      setError(caught instanceof Error ? caught.message : 'The AI Draft Work inbox is temporarily unavailable.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return <main className="workbench-shell" aria-labelledby="ai-draft-work-title">
    <header className="workbench-header">
      <p className="workbench-kicker">HON AI Office</p>
      <h1 id="ai-draft-work-title">My AI Draft Work</h1>
      <p>Review the durable, private state of drafts that **you** initiated. This is not a chat transcript, provider console, or delivery queue.</p>
      <p className="workbench-boundary">No automatic resend, publishing, messaging, payment, staff decision, or approval occurs here. Any consequential change remains governed by the HON Action Engine.</p>
      <button type="button" className="secondary-button" onClick={() => void refresh()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh status'}</button>
    </header>

    {error ? <section className="workbench-error" role="alert"><strong>Inbox unavailable.</strong><p>{error}</p></section> : null}
    {unavailable.length ? <section className="workbench-notice"><strong>Limited access</strong><p>Current permissions do not include {unavailable.map((agent) => AGENTS[agent]?.name ?? agent).join(', ')} draft work in this school.</p></section> : null}
    {!loading && !error && !items.length ? <section className="workbench-empty"><h2>No current draft work</h2><p>There are no durable Marcus, Claire, or Chad draft requests available to your current direct-human scope.</p></section> : null}

    <section className="workbench-list" aria-live="polite" aria-busy={loading}>
      {items.map((item) => {
        const agent = AGENTS[item.agentKey];
        if (!agent) return null;
        return <article className="workbench-row" key={item.id}>
          <div>
            <p className="workbench-kicker">{agent.name}</p>
            <h2>{statusLabel(item.status)}</h2>
            <p>{reasonLabel(item.reason) ?? 'No additional status reason is recorded.'}</p>
            <p className="workbench-meta">Updated {new Date(item.updatedAt).toLocaleString()}</p>
          </div>
          <a className="primary-button" href={`${agent.destination}#invocation=${item.id}`}>Open securely</a>
        </article>;
      })}
    </section>
  </main>;
}
