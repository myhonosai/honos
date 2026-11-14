'use client';

import React, { useEffect, useRef, useState } from 'react';
import { validateMarketingRequest, type CampaignSummary, type MarketingInvocationView } from '@hon/contracts';
import { campaignRequest } from './campaign-workbench';
import styles from './campaign-workbench.module.css';
import { marketingRequest, MarketingUiError, verifyMarketingView } from './marketing-assistant-http';
import { INCLUDED_AI_NOTE } from './included-ai-copy';
import { AgentIntro } from './ai-workspace/agent-intro';
import { canTryAgain, draftStatus, plainReason } from './ai-workspace/plain';

const base = '/api/v1/marketing/assistant';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function resumeInvocationId(): string | null { if (typeof window === 'undefined' || !/^#invocation=[0-9a-f-]+$/i.test(window.location.hash)) return null; const id = window.location.hash.slice('#invocation='.length); return UUID.test(id) ? id : null; }

export function MarketingAssistantWorkbench(): React.ReactElement {
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [campaignId, setCampaignId] = useState('');
  const [request, setRequest] = useState('');
  const [view, setView] = useState<MarketingInvocationView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const retry = useRef<{ input: { campaignId: string; request: string }; key: string } | null>(null);
  async function run(work: () => Promise<void>) { if (busy) return; setBusy(true); setError(''); try { await work(); } catch (caught) { if (caught instanceof MarketingUiError && [401, 403].includes(caught.status)) { setView(null); setCampaigns([]); setCampaignId(''); setRequest(''); retry.current = null; } setError(caught instanceof Error ? caught.message : 'Marketing assistant unavailable.'); } finally { setBusy(false); } }
  async function submit() { const input = validateMarketingRequest({ campaignId, request }); if (JSON.stringify(retry.current?.input) !== JSON.stringify(input)) retry.current = { input, key: crypto.randomUUID() }; const retained = retry.current!; setView(verifyMarketingView(await marketingRequest(base, retained.input, retained.key), input.campaignId)); }
  useEffect(() => { const id = resumeInvocationId(); if (!id) return; window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`); void run(async () => { setView(verifyMarketingView(await marketingRequest(`${base}/${id}`), undefined, id)); }); }, []);
  const loadCampaigns = () => run(async () => { setView(null); retry.current = null; setCampaigns((await campaignRequest<CampaignSummary[]>('/api/v1/marketing/campaigns')).filter((campaign) => campaign.status !== 'ARCHIVED')); });
  // Your school's campaigns load as soon as the page opens (unless you are resuming a draft).
  useEffect(() => { if (!resumeInvocationId()) void loadCampaigns(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const status = view ? draftStatus(view.status) : null;
  return <main className={styles.page}>
    <AgentIntro agent="marcus" name="Marcus" role="Marketing Director" lead="Pick one of your campaigns, tell Marcus what you need, and Marcus writes a draft for you to review. Nothing is published or sent."
      links={[{ href: '/staff/marketing/campaigns', label: 'Your campaigns' }, { href: '/staff/ai-work', label: 'Drafts you asked for' }, { href: '/staff/action-center/approvals', label: 'Approvals' }]} />
    {busy && <p role="status">Checking…</p>}{error && <p role="alert">{error}</p>}
    <section><h2>Ask for a marketing draft</h2><label>Campaign<select disabled={busy} value={campaignId} onChange={(event) => { setCampaignId(event.target.value); setView(null); retry.current = null; }}><option value="">Choose a campaign</option>{campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}</select></label>{!busy && campaigns.length === 0 && <p>No campaigns yet. <a href="/staff/marketing/campaigns">Create one in the campaign planner</a>, then <button type="button" onClick={() => void loadCampaigns()}>refresh the list</button>.</p>}<form onSubmit={(event) => { event.preventDefault(); void run(submit); }}><label>What should Marcus write?<textarea required maxLength={2000} disabled={busy} value={request} onChange={(event) => { setRequest(event.target.value); retry.current = null; }} placeholder="For example: a friendly post introducing our beginner classes. Leave dates and prices blank for me to fill in." /></label><p>Do not include passwords, payment details or private student information.</p><button disabled={busy || !campaignId || !request.trim()}>Write the draft</button></form></section>
    {view && status && <section data-draft-status={view.status}><h2>{status.title}</h2><p>{status.detail}</p>{plainReason(view.reason) && <p>{plainReason(view.reason)}</p>}<button disabled={busy} onClick={() => void run(async () => setView(verifyMarketingView(await marketingRequest(`${base}/${view.id}`), view.campaignId, view.id)))}>Refresh</button>{canTryAgain(view.status) && <button disabled={busy} onClick={() => void run(async () => setView(verifyMarketingView(await marketingRequest(`${base}/${view.id}/retry`, {}), view.campaignId, view.id)))}>Try again</button>}{view.draft && <article><h3>{view.draft.title}</h3><p style={{ whiteSpace: 'pre-wrap' }}>{view.draft.content}</p><p>{INCLUDED_AI_NOTE}</p></article>}{view.actionRequestId && view.status === 'AWAITING_APPROVAL' && <p>Ready for approval in <a href="/staff/action-center/approvals">Approvals</a>. A different staff member must approve it; you cannot approve your own draft. Once approved, save it to the campaign here.</p>}{view.status === 'AWAITING_APPROVAL' && <button disabled={busy} onClick={() => void run(async () => setView(verifyMarketingView(await marketingRequest(`${base}/${view.id}/save-approved`, {}), view.campaignId, view.id)))}>Save to campaign (after approval)</button>}</section>}
  </main>;
}
