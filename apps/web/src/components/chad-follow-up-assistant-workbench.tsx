'use client';

import React, { useEffect, useRef, useState } from 'react';
import { FOLLOW_UP_DRAFT_PURPOSES, type ChadFollowUpInvocationView } from '@hon/contracts';
import styles from './campaign-workbench.module.css';
import { base, ChadFollowUpUiError, chadFollowUpRequest, normalizedChadFollowUpRequest, verifyChadFollowUpInvocation } from './chad-follow-up-assistant-http';
import { INCLUDED_AI_NOTE } from './included-ai-copy';
import { AgentIntro } from './ai-workspace/agent-intro';
import { canTryAgain, draftStatus, plainReason, purposeLabel } from './ai-workspace/plain';
import { ChadLeadPicker } from './chad-lead-picker';

export type ChadShellScope = Readonly<{ organizationId: string; schoolId: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function resumeInvocationId(): string | null { if (typeof window === 'undefined' || !/^#invocation=[0-9a-f-]+$/i.test(window.location.hash)) return null; const id = window.location.hash.slice('#invocation='.length); return UUID.test(id) ? id : null; }

export function ChadFollowUpAssistantWorkbench({ shellScope = null }: { shellScope?: ChadShellScope | null } = {}): React.ReactElement {
  const [leadId, setLeadId] = useState('');
  const [pickedSchool, setPickedSchool] = useState('');
  const [version, setVersion] = useState('');
  const [purpose, setPurpose] = useState('INTRODUCTION');
  const [view, setView] = useState<ChadFollowUpInvocationView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A lead picked at one shell school is dropped once the shell switches school.
  const picked = shellScope && pickedSchool && pickedSchool.toLowerCase() !== shellScope.schoolId.toLowerCase() ? { leadId: '', version: '' } : { leadId, version };
  const retry = useRef<{ input: ReturnType<typeof normalizedChadFollowUpRequest>; key: string } | null>(null);
  async function run(work: () => Promise<void>) { if (busy) return; setBusy(true); setError(''); try { await work(); } catch (caught) { if (caught instanceof ChadFollowUpUiError && [401, 403].includes(caught.status)) { setView(null); setLeadId(''); setVersion(''); retry.current = null; } setError(caught instanceof Error ? caught.message : 'Chad is unavailable.'); } finally { setBusy(false); } }
  async function submit() { const input = normalizedChadFollowUpRequest(picked.leadId, picked.version, purpose); if (JSON.stringify(retry.current?.input) !== JSON.stringify(input)) retry.current = { input, key: crypto.randomUUID() }; const retained = retry.current!; setView(verifyChadFollowUpInvocation(await chadFollowUpRequest(base, retained.input, retained.key), retained.input.leadId)); }
  async function refresh() { if (!view) return; setView(verifyChadFollowUpInvocation(await chadFollowUpRequest(`${base}/${view.id}`), view.leadId, view.id)); }
  async function retryPreSend() { if (!view) return; setView(verifyChadFollowUpInvocation(await chadFollowUpRequest(`${base}/${view.id}/retry`, {}, view.id), view.leadId, view.id)); }
  useEffect(() => { const id = resumeInvocationId(); if (!id) return; window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`); void run(async () => { setView(verifyChadFollowUpInvocation(await chadFollowUpRequest(`${base}/${id}`), undefined, id)); }); }, []);
  const status = view ? draftStatus(view.status) : null;
  return <main className={styles.page}>
    <AgentIntro agent="chad" name="Chad" role="Enrollment Director" lead="Pick a lead and Chad writes a follow-up message for you to review. Chad never sends anything: after a teammate approves the draft, it goes through your school’s usual messaging steps."
      links={[{ href: '/staff/crm/follow-ups', label: 'Your follow-up list' }, { href: '/staff/ai-work', label: 'Drafts you asked for' }, { href: '/staff/action-center/approvals', label: 'Approvals' }]} />
    {busy && <p role="status">Checking…</p>}{error && <p role="alert">{error}</p>}
    <section><h2>Write a follow-up</h2><p>{shellScope ? 'Choose an open lead at your school. Chad sees only what the lead is about, never their phone or email.' : 'Choose your school at the top of the page to see your leads.'}</p><form onSubmit={(event) => { event.preventDefault(); void run(submit); }}>{shellScope ? <ChadLeadPicker scope={shellScope} leadId={picked.leadId} disabled={busy} onPick={(lead) => { setLeadId(lead.id); setVersion(String(lead.version)); setPickedSchool(shellScope.schoolId); setView(null); retry.current = null; }}/> : null}<label>What is this message for?<select value={purpose} disabled={busy} onChange={(event) => { setPurpose(event.target.value); setView(null); retry.current = null; }}>{FOLLOW_UP_DRAFT_PURPOSES.map((item) => <option key={item} value={item}>{purposeLabel(item)}</option>)}</select></label><button disabled={busy || !picked.leadId.trim() || !picked.version.trim()}>Write the draft</button></form></section>
    {view && status && <section data-draft-status={view.status}><h2>{status.title}</h2><p>{status.detail}</p>{plainReason(view.reason) && <p>{plainReason(view.reason)}</p>}<button disabled={busy} onClick={() => void run(refresh)}>Refresh</button>{canTryAgain(view.status) && <button disabled={busy} onClick={() => void run(retryPreSend)}>Try again</button>}{view.draft && <article><h3>{view.draft.subject}</h3><p style={{ whiteSpace: 'pre-wrap' }}>{view.draft.content}</p><p>{INCLUDED_AI_NOTE}</p></article>}{view.actionRequestId && <p>Ready for approval in <a href="/staff/action-center/approvals">Approvals</a>. A different staff member must approve it; you cannot approve your own draft.</p>}</section>}
  </main>;
}
