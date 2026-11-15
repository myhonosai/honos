'use client';

import React, { useEffect, useRef, useState } from 'react';
import type { TeachingCurriculumOption, TeachingInvocationView } from '@hon/contracts';
import styles from './campaign-workbench.module.css';
import { loadTeachingCurricula, normalizedTeachingRequest, TeachingAssistantUiError, teachingAssistantRequest, verifyTeachingInvocation } from './teaching-assistant-http';
import { INCLUDED_AI_NOTE } from './included-ai-copy';
import { AgentIntro } from './ai-workspace/agent-intro';
import { canTryAgain, draftStatus, plainReason } from './ai-workspace/plain';

const base = '/api/v1/staff/teaching-assistant';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function resumeInvocationId(): string | null { if (typeof window === 'undefined' || !/^#invocation=[0-9a-f-]+$/i.test(window.location.hash)) return null; const id = window.location.hash.slice('#invocation='.length); return UUID.test(id) ? id : null; }

export function TeachingAssistantWorkbench(): React.ReactElement {
  const [curriculumId, setCurriculumId] = useState('');
  const [curricula, setCurricula] = useState<TeachingCurriculumOption[]>([]);
  const [brief, setBrief] = useState('');
  const [view, setView] = useState<TeachingInvocationView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const retry = useRef<{ input: ReturnType<typeof normalizedTeachingRequest>; key: string } | null>(null);
  async function run(work: () => Promise<void>) { if (busy) return; setBusy(true); setError(''); try { await work(); } catch (caught) { if (caught instanceof TeachingAssistantUiError && [401, 403].includes(caught.status)) { setView(null); setCurriculumId(''); setBrief(''); retry.current = null; } setError(caught instanceof Error ? caught.message : 'The teaching draft assistant is unavailable.'); } finally { setBusy(false); } }
  async function submit() { const input = normalizedTeachingRequest(curriculumId, brief); if (JSON.stringify(retry.current?.input) !== JSON.stringify(input)) retry.current = { input, key: crypto.randomUUID() }; const retained = retry.current!; setView(verifyTeachingInvocation(await teachingAssistantRequest(base, retained.input, retained.key), retained.input.curriculumId)); }
  useEffect(() => { const id = resumeInvocationId(); if (!id) return; window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`); void run(async () => { setView(verifyTeachingInvocation(await teachingAssistantRequest(`${base}/${id}`), undefined, id)); }); }, []);
  // Your school's published curricula load as soon as the page opens; no ID is ever typed.
  useEffect(() => { void run(async () => setCurricula(await loadTeachingCurricula())); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const status = view ? draftStatus(view.status) : null;
  return <main className={styles.page}>
    <AgentIntro agent="kai" name="Kai" role="Teaching & Curriculum" lead="Pick one of your published curricula and Kai drafts a lesson outline for your instructors. Kai never records progress, belt ranks or test results; those stay instructor decisions."
      links={[{ href: '/staff/teaching-studio', label: 'Teaching studio' }, { href: '/staff/curriculum/library', label: 'Curriculum library' }, { href: '/staff/ai-work', label: 'Drafts you asked for' }]} />
    {busy && <p role="status">Checking…</p>}{error && <p role="alert">{error}</p>}
    <section><h2>Ask for a lesson draft</h2><form onSubmit={(event) => { event.preventDefault(); void run(submit); }}><label>Curriculum<select required value={curriculumId} disabled={busy} onChange={(event) => { setCurriculumId(event.target.value); setView(null); retry.current = null; }}><option value="">Choose a curriculum</option>{curricula.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{!busy && curricula.length === 0 && <p>No published curricula yet. Publish one in the <a href="/staff/curriculum/library">curriculum library</a> first.</p>}<label>Anything Kai should focus on? (optional)<textarea maxLength={1200} disabled={busy} value={brief} onChange={(event) => { setBrief(event.target.value); retry.current = null; }} placeholder="For example: a 45-minute class outline for beginners." /></label><p>Do not include student names or personal information.</p><button disabled={busy || !curriculumId.trim()}>Write the draft</button></form></section>
    {view && status && <section data-draft-status={view.status}><h2>{status.title}</h2><p>{status.detail}</p>{plainReason(view.reason) && <p>{plainReason(view.reason)}</p>}<button disabled={busy} onClick={() => void run(async () => setView(verifyTeachingInvocation(await teachingAssistantRequest(`${base}/${view.id}`), view.curriculumId, view.id)))}>Refresh</button>{canTryAgain(view.status) && <button disabled={busy} onClick={() => void run(async () => setView(verifyTeachingInvocation(await teachingAssistantRequest(`${base}/${view.id}/retry`, {}, view.id), view.curriculumId, view.id)))}>Try again</button>}{view.draft && <article><h3>{view.draft.title}</h3><p style={{ whiteSpace: 'pre-wrap' }}>{view.draft.content}</p><p>{INCLUDED_AI_NOTE}</p></article>}{view.actionRequestId && view.status === 'AWAITING_APPROVAL' && <p>Ready for approval in <a href="/staff/action-center/approvals">Approvals</a>. A different staff member must approve it; you cannot approve your own draft. Once approved, save it to the Teaching studio here.</p>}{view.status === 'AWAITING_APPROVAL' && <button disabled={busy} onClick={() => void run(async () => setView(verifyTeachingInvocation(await teachingAssistantRequest(`${base}/${view.id}/save-approved`, {}, view.id), view.curriculumId, view.id)))}>Save to Teaching studio (after approval)</button>}</section>}
  </main>;
}
