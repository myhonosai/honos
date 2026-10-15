'use client';
import React, { useEffect, useRef, useState } from 'react';
import { VOICE_AGENT_CATALOG_IDS, VOICE_DRAFT_NOTICE, VOICE_REASON_CODES, VOICE_UUID, safeVoiceDraft, type VoiceOperation, type VoiceReasonCode, type VoiceSession } from '@hon/contracts';
import { changeVoiceSession, readVoiceSession, VoiceAccessError, VoiceConflictError } from './voice-http';
import styles from './voice-workspace.module.css';
interface Pending { school: string; operation: VoiceOperation; id: string | null; input: unknown; key: string }
export function VoiceWorkspace(): React.ReactElement {
  const [school,setSchool] = useState(''), [agent,setAgent] = useState<typeof VOICE_AGENT_CATALOG_IDS[number]>('alex');
  const [resumeId,setResumeId] = useState(''), [workId,setWorkId] = useState(''), [actionId,setActionId] = useState(''), [approvalId,setApprovalId] = useState('');
  const [session,setSession] = useState<VoiceSession|null>(null), [draft,setDraft] = useState(''), [reason,setReason] = useState<VoiceReasonCode>('NOT_CONFIGURED');
  const [busy,setBusy] = useState(false), [error,setError] = useState(''), [notice,setNotice] = useState(''), [uncertain,setUncertain] = useState(false), [offline,setOffline] = useState(false);
  const pending = useRef<Pending|null>(null), epoch = useRef(0), active = useRef(false);
  useEffect(() => { const update = () => setOffline(!navigator.onLine); update(); window.addEventListener('online',update); window.addEventListener('offline',update); return () => { active.current = false; epoch.current++; window.removeEventListener('online',update); window.removeEventListener('offline',update); }; },[]);
  function clearPrivate() { setSession(null); setDraft(''); pending.current=null; setUncertain(false); setNotice(''); setResumeId(''); setWorkId(''); setActionId(''); setApprovalId(''); }
  function scope(value: string) { epoch.current++; active.current=false; setBusy(false); clearPrivate(); setError(''); setSchool(value); }
  async function run(work: () => Promise<void>) {
    if (active.current) return; active.current=true; const generation=epoch.current; setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (e) { if (generation!==epoch.current) return;
      if (e instanceof VoiceAccessError) clearPrivate();
      else { setSession(null); setDraft(''); if (e instanceof VoiceConflictError) { pending.current=null; setUncertain(false); } else setUncertain(pending.current!==null); }
      setError(e instanceof Error ? e.message : 'Unverified evidence. No voice connection or execution is assumed.');
    } finally { if (generation===epoch.current) { active.current=false; setBusy(false); } }
  }
  async function send(value: Pending) {
    const generation=epoch.current; const result=await changeVoiceSession(value.school,value.operation,value.id,value.input,value.key);
    if (generation!==epoch.current) return;
    setSession(result.session); setResumeId(result.session.id); setDraft(result.session.draftText??''); pending.current=null; setUncertain(false);
    setNotice(`${result.replayed?'Existing receipt':'Saved evidence'} at version ${result.receiptVersion}. Current version ${result.session.version}. No provider connection or command execution.`);
  }
  function change(operation: VoiceOperation, input: unknown, id: string|null=session?.id??null) {
    const value={school,operation,id,input,key:crypto.randomUUID()}; pending.current=value; void run(()=>send(value));
  }
  function load() { const generation=epoch.current; void run(async()=>{ const value=await readVoiceSession(school,resumeId); if(generation!==epoch.current)return; setSession(value); setDraft(value.draftText??''); setNotice('Exact actor-owned evidence loaded. References are IDs only; approvals and work must be reviewed in their own surfaces.'); }); }
  const ready=VOICE_UUID.test(school)&&!busy&&!offline&&!uncertain;
  const writable=ready&&session!==null&&!session.expired&&session.state!=='ENDED';
  const refsValid=[workId,actionId,approvalId].every(v=>!v||VOICE_UUID.test(v))&&(!approvalId||!!actionId);
  return <main className={styles.page}>
    <header className={styles.header}><a href="/">HON / School OS</a><nav><a href="/staff/search">Find work context</a><a href="/staff/action-center/approvals">Human approvals</a><a href="/">School overview</a></nav></header>
    <section className={styles.hero}><p className={styles.kicker}>COMPLETE / HUMAN HANDOFF FOUNDATION</p><h1>Voice, with an honest text fallback.</h1><p>Keep your place without granting an agent authority. This foundation stores human interaction evidence only.</p><div className={styles.warning}><strong>Voice unavailable — no provider is connected</strong><p>No microphone access, recording, audio, transcription, AI response or tool execution. A catalog selection does not invoke an employee.</p></div></section>
    <div className={styles.layout}>
      <section className={styles.card}><h2>School and selected employee</h2><p>Exact active Complete and current human school permission are checked on every request. Parent, Eian, HQ and public use are not supported here.</p>
        <label>School ID<input value={school} onChange={e=>scope(e.target.value)} placeholder="Authorized school UUID" autoComplete="off" spellCheck={false}/></label>
        <label>Approved catalog ID<select value={agent} disabled={busy||uncertain} onChange={e=>setAgent(e.target.value as typeof agent)}>{VOICE_AGENT_CATALOG_IDS.map(a=><option key={a} value={a}>{a}</option>)}</select></label>
        <details><summary>Optional stable context IDs</summary><p>No action payload, private work content, credentials or conversation text is accepted.</p><label>Work item ID<input value={workId} disabled={busy||uncertain} onChange={e=>setWorkId(e.target.value)}/></label><label>Action request ID<input value={actionId} disabled={busy||uncertain} onChange={e=>setActionId(e.target.value)}/></label><label>Approval evidence ID<input value={approvalId} disabled={busy||uncertain} onChange={e=>setApprovalId(e.target.value)}/></label></details>
        <button disabled={!ready||!refsValid} onClick={()=>change('create',{agentCatalogId:agent,...(workId?{workItemId:workId}:{}),...(actionId?{actionRequestId:actionId}:{}),...(approvalId?{approvalId}: {})},null)}>Request inert voice session</button>
        <h2>Resume exact context</h2><label>Session ID<input value={resumeId} disabled={busy||uncertain} onChange={e=>setResumeId(e.target.value)} placeholder="Your saved session UUID"/></label><div className={styles.buttons}><button disabled={!ready||!VOICE_UUID.test(resumeId)} onClick={load}>Load exact evidence</button><button disabled={!ready||!VOICE_UUID.test(resumeId)} onClick={()=>change('create',{agentCatalogId:agent,resumeSessionId:resumeId},null)}>Resume as new session</button></div><p>Resume preserves IDs, not drafts or authority. An expired or ended session never reconnects.</p>
      </section>
      <section className={styles.card} aria-busy={busy}><h2>Handoff and evidence</h2>
        {offline&&<p role="status" className={styles.warning}>Client offline. This is a local observation, not a provider health fact. Saving is unavailable; normal navigation remains available.</p>}
        {busy&&<p role="status">Saving or loading evidence only. No microphone or provider connection is being attempted.</p>}
        {error&&<p role="alert" className={styles.warning}>{error}</p>}{notice&&<p role="status">{notice}</p>}
        {uncertain&&<div className={styles.warning}><p>Outcome unknown. Do not create a second request. Retry only the exact retained request or discard it and reload evidence.</p><button disabled={busy||offline} onClick={()=>{const value=pending.current;if(value)void run(()=>send(value));}}>Retry exact request</button><button disabled={busy} onClick={()=>{pending.current=null;setUncertain(false);setNotice('Retry discarded. Reload your exact session before changing it.');}}>Discard retry</button></div>}
        {!session?<p className={styles.empty}>No verified session loaded. Voice is unavailable; no successful connection is implied.</p>:<><dl className={styles.evidence}><dt>Session</dt><dd>{session.id}</dd><dt>State / version</dt><dd>{session.state} / {session.version}</dd><dt>Reason observation</dt><dd>{session.reasonCode??'None recorded'}</dd><dt>Expiry</dt><dd>{session.expiresAt}{session.expired?' — expired':''}</dd><dt>Selected catalog ID</dt><dd>{session.agentCatalogId} — not an invocation</dd><dt>Resume reference</dt><dd>{session.resumeSessionId??'None'}</dd><dt>Work reference</dt><dd>{session.workItemId??'None'}</dd><dt>Action / approval IDs</dt><dd>{session.actionRequestId??'None'} / {session.approvalId??'None'}</dd><dt>Provider / execution</dt><dd>Not connected / not triggered</dd></dl>
          <label>Redacted unavailable reason<select value={reason} disabled={busy||uncertain} onChange={e=>setReason(e.target.value as VoiceReasonCode)}>{VOICE_REASON_CODES.map(r=><option key={r}>{r}</option>)}</select></label>
          <div className={styles.buttons}><button disabled={!writable||['VOICE_UNAVAILABLE','TEXT_FALLBACK'].includes(session.state)} onClick={()=>change('status',{expectedVersion:session.version,state:'VOICE_UNAVAILABLE',reasonCode:reason})}>Record voice unavailable</button><button disabled={!writable} onClick={()=>change('mark-fallback',{expectedVersion:session.version,reasonCode:reason})}>Use text fallback</button><button disabled={!ready||session.state==='ENDED'} onClick={()=>change('end',{expectedVersion:session.version})}>End session</button></div>
          {(session.expired||session.state==='ENDED')&&<p>Read-only historical evidence. Start a new session to preserve references; no connection is resumed.</p>}
          <h3>Private text fallback draft</h3><p><strong>{VOICE_DRAFT_NOTICE}</strong></p><label>Draft text<textarea value={draft} maxLength={500} disabled={!writable||session.state!=='TEXT_FALLBACK'} onChange={e=>setDraft(e.target.value)} rows={5} placeholder="Describe a non-sensitive topic in plain words."/></label><p>Letters, spaces and simple punctuation only, 1–500 characters. No contacts, numbers, URLs, markup, credentials or transcript/audio. Draft content is not placed in audit or outbox.</p><button disabled={!writable||session.state!=='TEXT_FALLBACK'||!safeVoiceDraft(draft)} onClick={()=>change('mark-fallback',{expectedVersion:session.version,reasonCode:reason,draftText:draft})}>Save private draft only</button>
        </>}
      </section>
    </div><footer className={styles.footer}>Conventional school tools stay available independently of voice. Work and approval references convey no new permission or authority.</footer>
  </main>;
}
