'use client';

import React, { useRef, useState } from 'react';
import { FOLLOW_UP_DRAFT_PURPOSES, type ChadFollowUpInvocationView } from '@hon/contracts';
import styles from './campaign-workbench.module.css';
import { base, ChadFollowUpUiError, chadFollowUpRequest, normalizedChadFollowUpRequest, verifyChadFollowUpInvocation } from './chad-follow-up-assistant-http';

export function ChadFollowUpAssistantWorkbench(): React.ReactElement {
  const [leadId, setLeadId] = useState('');
  const [version, setVersion] = useState('');
  const [purpose, setPurpose] = useState('INTRODUCTION');
  const [view, setView] = useState<ChadFollowUpInvocationView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const retry = useRef<{ input: ReturnType<typeof normalizedChadFollowUpRequest>; key: string } | null>(null);
  async function run(work: () => Promise<void>) { if (busy) return; setBusy(true); setError(''); try { await work(); } catch (e) { if (e instanceof ChadFollowUpUiError && [401,403].includes(e.status)) { setView(null); setLeadId(''); setVersion(''); retry.current=null; } setError(e instanceof Error ? e.message : 'Chad is unavailable.'); } finally { setBusy(false); } }
  async function submit() { const input=normalizedChadFollowUpRequest(leadId,version,purpose); if (JSON.stringify(retry.current?.input)!==JSON.stringify(input)) retry.current={input,key:crypto.randomUUID()}; const retained=retry.current!; setView(verifyChadFollowUpInvocation(await chadFollowUpRequest(base,retained.input,retained.key),retained.input.leadId)); }
  async function refresh() { if (!view) return; setView(verifyChadFollowUpInvocation(await chadFollowUpRequest(`${base}/${view.id}`),view.leadId)); }
  async function retryPreSend() { if (!view) return; setView(verifyChadFollowUpInvocation(await chadFollowUpRequest(`${base}/${view.id}/retry`,{} ,view.id),view.leadId)); }
  return <main className={styles.page}>
    <nav><a href="/staff/crm/follow-ups">Human CRM follow-ups</a><a href="/staff/action-center/approvals">Existing approval workbench</a></nav>
    <header><p>COMPLETE / CHAD — CRM FOLLOW-UP DRAFT GUIDE</p><h1>AI sales follow-up draft assistant</h1><p>Prepare one bounded, structured content proposal for a known permitted current-school CRM lead.</p></header>
    <aside><strong>Live inference remains blocked until the existing operator paid-call gate is explicitly configured.</strong><p>Every proposal begins as <code>NOT_CREATED_OR_SENT</code>. Chad has no lead directory, school/provider/model/tier/authority selector, delivery queue, contact address, calendar, discount, payment, membership, or lead-update control. Do not enter names, contact details, consent facts, private notes, credentials, URLs, or other personal data.</p></aside>
    {busy && <p role="status">Checking durable Chad state…</p>}{error && <p role="alert">{error} No success is assumed.</p>}
    <section><h2>1 / Known permitted lead</h2><p>Enter an already-known CRM lead UUID and its observed current version. This page intentionally does not provide a lead directory or contact lookup.</p>
      <form onSubmit={e=>{e.preventDefault();void run(submit);}}>
        <label>Known CRM lead UUID<input required value={leadId} disabled={busy} onChange={e=>{setLeadId(e.target.value);setView(null);retry.current=null;}} placeholder="Known current-school lead UUID" /></label>
        <label>Observed lead version<input required inputMode="numeric" value={version} disabled={busy} onChange={e=>{setVersion(e.target.value);setView(null);retry.current=null;}} placeholder="Current lead version" /></label>
        <label>Draft purpose<select value={purpose} disabled={busy} onChange={e=>{setPurpose(e.target.value);setView(null);retry.current=null;}}>{FOLLOW_UP_DRAFT_PURPOSES.map(p=><option key={p}>{p}</option>)}</select></label>
        <button disabled={busy || !leadId.trim() || !version.trim()}>Prepare durable follow-up content proposal</button>
      </form>
    </section>
    {view && <section><h2>2 / Durable proposal: {view.status}</h2><p>School {view.schoolId}<br />Lead {view.leadId} · version {view.leadVersion}<br />Request {view.id}<br />Work item {view.workItemId}<br />Delivery state: {view.delivery}</p>
      {view.reason && <p>{view.reason}. No content or provider success is invented.</p>}
      <button disabled={busy} onClick={()=>void run(refresh)}>Refresh status</button>
      {['CONFIGURATION_REQUIRED','BLOCKED','PENDING'].includes(view.status) && <button disabled={busy} onClick={()=>void run(retryPreSend)}>Recheck configuration / safe pre-send retry</button>}
      {view.status==='UNKNOWN' && <p>Unknown provider or persistence outcome is quarantined. No automatic or manual resend is permitted.</p>}
      {view.draft && <article><h3>{view.draft.subject}</h3><p style={{whiteSpace:'pre-wrap'}}>{view.draft.content}</p><p>Recorded usage: {view.inputTokens} input / {view.outputTokens} output tokens; provider cost {view.providerCostMicrounits} USD microunits; customer credits {view.customerCredits}.</p></article>}
      {view.actionRequestId && <p>CONFIRM proposal {view.actionRequestId}. A different qualified human must review the exact lead/version/purpose/content payload hash, policy and expiry in the <a href="/staff/action-center/approvals">existing approval workbench</a>. The requester cannot self-approve.</p>}
      {view.status==='APPROVED' && <p>Approved content proposal only. Acceptance did not send, deliver, queue, schedule, or create any message; it did not change the lead, follow-up, appointment, membership, discount, refund, or payment. A separate reviewed communication, consent, and receipt workflow is still required before any outbound message.</p>}
      {view.status==='REJECTED' && <p>Human rejected. No follow-up, lead, message, delivery, calendar, financial, or membership effect occurred.</p>}
    </section>}
  </main>;
}
