'use client';
import React, { useRef, useState, type FormEvent } from 'react';
import { HUMAN_WORK_HELP, HUMAN_WORK_STATUSES, type HumanWorkInput, type HumanWorkTransition, type HumanWorkOperation, type HumanWorkQueue, type HumanWorkRecord, type HumanWorkStatus } from '@hon/contracts';
import { loadHumanWork, readHumanWork, mutateHumanWork, workFingerprint, WorkAccessError } from './work-items-http';
import styles from './staff-availability-workbench.module.css';
const initial = (assigneeId: string|null = null): HumanWorkInput => ({expectedVersion:0,title:'',description:'',priority:'NORMAL',dueAt:null,assigneeId});
const fields = (r: HumanWorkRecord): HumanWorkInput => ({expectedVersion:r.version,title:r.title,description:r.description,priority:r.priority,dueAt:r.dueAt,assigneeId:r.assigneeId});
const labels: Record<HumanWorkStatus,string> = {READY:'New · READY',WORKING:'In progress · WORKING',WAITING:'Blocked / waiting · WAITING',NEEDS_ATTENTION:'Human triage · NEEDS_ATTENTION',COMPLETED:'Completed',FAILED:'Closed unsuccessful · FAILED'};
const targets: Record<HumanWorkStatus,HumanWorkStatus[]> = {READY:['WORKING','WAITING','NEEDS_ATTENTION','FAILED'],WORKING:['WAITING','COMPLETED','NEEDS_ATTENTION','FAILED'],WAITING:['READY','WORKING','NEEDS_ATTENTION','FAILED'],NEEDS_ATTENTION:['READY','FAILED'],COMPLETED:[],FAILED:[]};
export function WorkItemsWorkbench(): React.ReactElement {
  const [context,setContext] = useState<HumanWorkQueue|null>(null), [selected,setSelected] = useState<HumanWorkRecord|null>(null), [draft,setDraft] = useState<HumanWorkInput>(initial);
  const [queue,setQueue] = useState<'mine'|'team'>('mine'), [status,setStatus] = useState<HumanWorkStatus|'ACTIVE'|'ALL'>('ACTIVE'), [busy,setBusy] = useState(false), [error,setError] = useState(''), [notice,setNotice] = useState(''), [knownId,setKnownId] = useState('');
  const [uncertain,setUncertain] = useState(false), [needsRefresh,setNeedsRefresh] = useState(false);
  const retry = useRef<{fingerprint:string;key:string;op:HumanWorkOperation;id:string|null;input:HumanWorkInput|HumanWorkTransition}|null>(null);
  const active = useRef(false);
  async function run(work:()=>Promise<void>) {
    if(active.current) return; active.current=true; setBusy(true); setError(''); setNotice('');
    try { await work(); } catch(e) {
      // Never leave an old private detail visible on a failed scope/record check.
      setSelected(null); setDraft(initial());
      if(e instanceof WorkAccessError) { setContext(null); retry.current=null; setUncertain(false); }
      setError(e instanceof Error?e.message:'No verified result.');
    } finally { active.current=false; setBusy(false); }
  }
  function choose(r:HumanWorkRecord|null) { setNeedsRefresh(false); setSelected(r); setDraft(r?fields(r):initial(context?.principalId??null)); }
  function edit(p:Partial<HumanWorkInput>) { setDraft(d=>({...d,...p})); setNotice(''); }
  async function load(after:string|null=null) { await run(async()=>{
    setContext(null); setSelected(null); setDraft(initial());
    const c=await loadHumanWork(queue,status,after); setContext(c); setDraft(initial(c.principalId));
  }); }
  async function open(id:string,beforeVersion:number|null=null) { await run(async()=>{
    setSelected(null); setDraft(initial()); const r=await readHumanWork(id,beforeVersion);
    if(!context || r.schoolId!==context.schoolId) throw new WorkAccessError('School changed. Reload the authorized queue.'); choose(r);
  }); }
  async function submit(op:HumanWorkOperation,id:string|null,input:HumanWorkInput|HumanWorkTransition) {
    const fingerprint=workFingerprint({op,id,input});
    if(retry.current?.fingerprint!==fingerprint) retry.current={fingerprint,key:crypto.randomUUID(),op,id,input:structuredClone(input)};
    setUncertain(true); const saved=await mutateHumanWork(op,id,input,retry.current.key);
    if(!context || saved.schoolId!==context.schoolId) throw new WorkAccessError('School changed. Reload current records; no save assumed.');
    setUncertain(false); setNeedsRefresh(true); setSelected(saved); setDraft(fields(saved));
    setContext({...context,items:context.items.filter(r=>r.workItemId!==saved.workItemId)});
    setNotice(`Verified saved revision ${saved.version}: ${labels[saved.status]}. Human recordkeeping only. Reload current detail before more edits; a retry may return an older saved revision.`);
  }
  async function save(e:FormEvent) { e.preventDefault(); await run(()=>submit(selected?'UPDATE':'CREATE',selected?.workItemId??null,draft)); }
  function resetFilter() { setContext(null); setSelected(null); setDraft(initial()); }
  return <main className={styles.page}>
    <nav><a href="/staff/dashboard">School dashboard</a><a href="/staff/hon">Ask HON</a><a href="/staff/search">Staff search</a><a href="/auth/login">Sign in</a></nav>
    <header><p>HUMAN WORK · ESSENTIAL / CORE / COMPLETE</p><h1>Work items</h1><p>A clear next step. A durable human record.</p></header>
    <aside><strong>Human work, not an AI execution queue.</strong><p>{HUMAN_WORK_HELP}</p><p>Exact school work_item.manage for team detail/revisions/assignment; work_item.self_manage for current-assignee state updates. work_item.create for self/unassigned creation and creator visibility. No identity directory. Avoid personal/contact data or raw AI prompts in titles and descriptions.</p></aside>
    <section><h2>Authorized school queue</h2><div className={styles.row}>
      <label>Queue<select disabled={busy||uncertain} value={queue} onChange={e=>{setQueue(e.target.value as 'mine'|'team');resetFilter();}}><option value="mine">My assignments / created records</option><option value="team">School team · managers only</option></select></label>
      <label>Status<select disabled={busy||uncertain} value={status} onChange={e=>{setStatus(e.target.value as HumanWorkStatus|'ACTIVE'|'ALL');resetFilter();}}><option value="ACTIVE">Active work</option>{HUMAN_WORK_STATUSES.map(s=><option key={s} value={s}>{labels[s]}</option>)}<option value="ALL">All states</option></select></label>
      <button disabled={busy} onClick={()=>void load()}>Load / refresh queue</button></div><p>Up to 50 human records per page, ordered by stable ID. Due dates are UTC planning metadata only. Private descriptions, directory fields and raw AI data never enter queues.</p></section>
    {busy&&<p role="status">Checking current human school authority…</p>}
    {error&&<p role="alert" className={styles.error}>{error} No save is assumed after an uncertain response.</p>}
    {notice&&<p role="status" className={styles.notice}>{notice}</p>}
    {uncertain&&retry.current&&<aside><p>An unverified request is retained in this page memory only. No automatic retries or new mutations while it is unresolved.</p><button disabled={busy||!context} onClick={()=>void run(async()=>{const r=retry.current!;await submit(r.op,r.id,r.input);})}>Retry exact retained request</button><button disabled={busy} onClick={()=>{retry.current=null;setUncertain(false);resetFilter();setNotice('Retained request discarded, not cancelled. A previous write may have committed. Reload and inspect current records before creating or changing work.');}}>Discard retry and clear private view</button></aside>}
    {context&&<><section><h2>{context.queue==='team'?'School team records':'My human work'}</h2><p>School {context.schoolId} · signed-in human {context.principalId}</p>
      {context.canCreate&&<button disabled={busy||uncertain} onClick={()=>choose(null)}>New human work item</button>}
      {context.items.length===0&&<p>No human work items on this page. Choose another state or create a human record if authorized. Future AI work is not shown here.</p>}
      <div className={styles.actions}>{context.items.map(r=><button key={r.workItemId} disabled={busy||uncertain} onClick={()=>void open(r.workItemId)}><strong>{r.title}</strong><br/>{labels[r.status]} · {r.priority} · v{r.version}<br/>Due {r.dueAt??'not set'}<br/>{r.assigneeId?`Human assignee ${r.assigneeId}`:'Unassigned'}<br/>Record {r.workItemId}</button>)}</div>
      {context.nextAfter&&<button disabled={busy||uncertain} onClick={()=>void load(context.nextAfter)}>Next 50 records</button>}
      <form onSubmit={e=>{e.preventDefault();void open(knownId);}}><label>Already-known work-item ID<input required value={knownId} disabled={busy||uncertain} onChange={e=>setKnownId(e.target.value)} placeholder="Record UUID"/></label><button disabled={busy||uncertain}>Load current detail</button></form>
    </section>
    {selected&&<section><h2>{selected.title}</h2><p>{labels[selected.status]} · human record · saved v{selected.version}</p><p>{selected.workItemId} · created by human {selected.createdBy} at {selected.createdAt}</p><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{selected.description||'No description recorded.'}</p><p>{selected.priority} · due {selected.dueAt??'not set'} · {selected.assigneeId?`Human assignee ${selected.assigneeId}`:'Unassigned'}</p>
      <div className={styles.actions}><button disabled={busy||uncertain} onClick={()=>void open(selected.workItemId)}>Reload current detail</button>{selected.canTransition&&targets[selected.status].map(target=><button key={target} disabled={busy||uncertain||needsRefresh} onClick={()=>void run(()=>submit('TRANSITION',selected.workItemId,{expectedVersion:selected.version,targetStatus:target}))}>{target==='COMPLETED'?'Mark completed (human record only)':labels[target]}</button>)}</div>
      {['COMPLETED','FAILED'].includes(selected.status)&&<p>Terminal record. No reopen or invented cancellation state is available.</p>}
      <h3>Human assignment / state history</h3><p>Metadata only; no old private descriptions or directory/contact data.</p><ol>{selected.history.map(h=><li key={h.version}>v{h.version} · {h.operation} · {labels[h.status]} · {h.assigneeId?`assignee ${h.assigneeId}`:'unassigned'} · human actor {h.actorId} · {h.recordedAt}</li>)}</ol>
      {selected.nextBeforeVersion&&<button disabled={busy||uncertain} onClick={()=>void open(selected.workItemId,selected.nextBeforeVersion)}>Older history</button>}
      {selected.aiPlanIds.length>0&&<aside><h3>Existing planning references only</h3><p>No AI execution or AI employee completion is implied.</p>{selected.aiPlanIds.map(id=><p key={id}>AI plan ID {id}</p>)}</aside>}
    </section>}
    {((!selected&&context.canCreate)||selected?.canEdit)&&<section><h2>{selected?'Revise / reassign human work':'Create human work item'}</h2><p>Expected version {draft.expectedVersion}. Optional assignment uses a known eligible human staff ID in this school only. Managers can recover inactive assignments; nobody is assigned automatically.</p>
      <form onSubmit={save}><fieldset disabled={busy||uncertain||needsRefresh}>
        <label>Title<input required maxLength={120} value={draft.title} onChange={e=>edit({title:e.target.value})}/></label>
        <label>Private description<textarea maxLength={2000} rows={5} value={draft.description} onChange={e=>edit({description:e.target.value})}/></label>
        <label>Known human assignee ID (optional)<input readOnly={!context.canManage} value={draft.assigneeId??''} onChange={e=>edit({assigneeId:e.target.value||null})}/></label>
        {!context.canManage&&<button type="button" onClick={()=>edit({assigneeId:draft.assigneeId?null:context.principalId})}>{draft.assigneeId?'Leave unassigned':'Assign to myself'}</button>}
        <div className={styles.row}><label>Due at UTC (optional)<input type="datetime-local" step="0.001" min="2000-01-01T00:00" max="2099-12-31T23:59:59.999" value={draft.dueAt?.slice(0,-1)??''} onChange={e=>{const value=e.target.value;const date=value?new Date(`${value}Z`):null;if(!date||Number.isFinite(date.getTime()))edit({dueAt:date?.toISOString()??null});}}/></label>
        <label>Priority<select value={draft.priority} onChange={e=>edit({priority:e.target.value as HumanWorkInput['priority']})}><option>LOW</option><option>NORMAL</option><option>HIGH</option></select></label></div>
        <button type="submit">{selected?'Save human revision':'Create human work record'}</button>
      </fieldset></form></section>}
    </>}
  </main>;
}
