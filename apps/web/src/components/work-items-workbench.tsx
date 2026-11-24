'use client';
import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { HUMAN_WORK_STATUSES, type HumanWorkInput, type HumanWorkTransition, type HumanWorkOperation, type HumanWorkQueue, type HumanWorkRecord, type HumanWorkStatus } from '@hon/contracts';
import { loadHumanWork, readHumanWork, mutateHumanWork, workFingerprint, WorkAccessError } from './work-items-http';
import { useShellSchool } from './school-shell/page-school';
import { IdFields, StaffPicker, personLabel, type ListState } from './school-pickers/pickers';
import styles from './staff-availability-workbench.module.css';
const initial = (assigneeId: string|null = null): HumanWorkInput => ({expectedVersion:0,title:'',description:'',priority:'NORMAL',dueAt:null,assigneeId});
const fields = (r: HumanWorkRecord): HumanWorkInput => ({expectedVersion:r.version,title:r.title,description:r.description,priority:r.priority,dueAt:r.dueAt,assigneeId:r.assigneeId});
const labels: Record<HumanWorkStatus,string> = {READY:'New',WORKING:'In progress',WAITING:'Waiting',NEEDS_ATTENTION:'Needs attention',COMPLETED:'Completed',FAILED:'Closed, not done'};
const PRIORITY: Record<HumanWorkInput['priority'],string> = {LOW:'Low priority',NORMAL:'Normal priority',HIGH:'High priority'};
const OPERATION: Record<string,string> = {CREATE:'Created',UPDATE:'Edited',TRANSITION:'Status changed'};
const targets: Record<HumanWorkStatus,HumanWorkStatus[]> = {READY:['WORKING','WAITING','NEEDS_ATTENTION','FAILED'],WORKING:['WAITING','COMPLETED','NEEDS_ATTENTION','FAILED'],WAITING:['READY','WORKING','NEEDS_ATTENTION','FAILED'],NEEDS_ATTENTION:['READY','FAILED'],COMPLETED:[],FAILED:[]};
export function WorkItemsWorkbench(): React.ReactElement {
  const [context,setContext] = useState<HumanWorkQueue|null>(null), [selected,setSelected] = useState<HumanWorkRecord|null>(null), [draft,setDraft] = useState<HumanWorkInput>(initial);
  const [queue,setQueue] = useState<'mine'|'team'>('mine'), [status,setStatus] = useState<HumanWorkStatus|'ACTIVE'|'ALL'>('ACTIVE'), [busy,setBusy] = useState(false), [error,setError] = useState(''), [notice,setNotice] = useState(''), [knownId,setKnownId] = useState('');
  const [uncertain,setUncertain] = useState(false), [needsRefresh,setNeedsRefresh] = useState(false);
  const retry = useRef<{fingerprint:string;key:string;op:HumanWorkOperation;id:string|null;input:HumanWorkInput|HumanWorkTransition}|null>(null);
  const active = useRef(false);
  const [staff,setStaff] = useState<ReadonlyMap<string,string>>(new Map()), [staffList,setStaffList] = useState<ListState<unknown>['state']>('LOADING');
  // The staff list only for the shell's verified school, and only when it is the school the queue came from.
  const shell = useShellSchool(), pickScope = shell && context && context.canManage && shell.schoolId === context.schoolId ? shell : null;
  const manualStaff = !pickScope || staffList === 'DENIED' || staffList === 'UNAVAILABLE';
  const who = (id: string|null) => personLabel(id, context?.principalId ?? '', staff);
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- open on the signed-in school right away
  async function run(work:()=>Promise<void>) {
    if(active.current) return; active.current=true; setBusy(true); setError(''); setNotice('');
    try { await work(); } catch(e) {
      // Never leave an old private detail visible on a failed scope/record check.
      setSelected(null); setDraft(initial());
      if(e instanceof WorkAccessError) { setContext(null); retry.current=null; setUncertain(false); }
      setError(e instanceof Error?e.message:'Nothing could be confirmed.');
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
    if(!context || r.schoolId!==context.schoolId) throw new WorkAccessError('School changed. Refresh the list.'); choose(r);
  }); }
  async function submit(op:HumanWorkOperation,id:string|null,input:HumanWorkInput|HumanWorkTransition) {
    const fingerprint=workFingerprint({op,id,input});
    if(retry.current?.fingerprint!==fingerprint) retry.current={fingerprint,key:crypto.randomUUID(),op,id,input:structuredClone(input)};
    setUncertain(true); const saved=await mutateHumanWork(op,id,input,retry.current.key);
    if(!context || saved.schoolId!==context.schoolId) throw new WorkAccessError('School changed. Nothing is assumed saved; refresh the list.');
    setUncertain(false); setNeedsRefresh(true); setSelected(saved); setDraft(fields(saved));
    setContext({...context,items:context.items.filter(r=>r.workItemId!==saved.workItemId)});
    setNotice(`Saved: ${labels[saved.status].toLowerCase()}. Reload current detail before editing again.`);
  }
  async function save(e:FormEvent) { e.preventDefault(); await run(()=>submit(selected?'UPDATE':'CREATE',selected?.workItemId??null,draft)); }
  function resetFilter() { setContext(null); setSelected(null); setDraft(initial()); }
  return <main className={styles.page}>
    <nav><a href="/staff/dashboard">School dashboard</a><a href="/staff/hon">Ask HON</a><a href="/staff/search">Staff search</a><a href="/auth/login">Sign in</a></nav>
    <header><p>Home</p><h1>Work</h1><p>Your team’s to-do list: what needs doing, who has it, and where it stands.</p></header>
    <aside data-plain-note=""><strong>Work items are for people. The AI team does not run them.</strong></aside>
    <section><h2>Show</h2><div className={styles.row}>
      <label>Whose<select disabled={busy||uncertain} value={queue} onChange={e=>{setQueue(e.target.value as 'mine'|'team');resetFilter();}}><option value="mine">Mine (assigned to me or created by me)</option><option value="team">Whole team (managers)</option></select></label>
      <label>Status<select disabled={busy||uncertain} value={status} onChange={e=>{setStatus(e.target.value as HumanWorkStatus|'ACTIVE'|'ALL');resetFilter();}}><option value="ACTIVE">Active work</option>{HUMAN_WORK_STATUSES.map(s=><option key={s} value={s}>{labels[s]}</option>)}<option value="ALL">All</option></select></label>
      <button disabled={busy} onClick={()=>void load()}>Refresh</button></div><p>Due dates are in UTC and are for planning only. Descriptions stay private to the open item.</p></section>
    {busy&&<p role="status">Working…</p>}
    {error&&<p role="alert" className={styles.error}>{error} No save is assumed until the page confirms it.</p>}
    {notice&&<p role="status" className={styles.notice}>{notice}</p>}
    {uncertain&&retry.current&&<aside><p>The last save was not confirmed. Retry sends the same request again; nothing else can be saved until you retry or discard it.</p><button disabled={busy||!context} onClick={()=>void run(async()=>{const r=retry.current!;await submit(r.op,r.id,r.input);})}>Retry exact retained request</button><button disabled={busy} onClick={()=>{retry.current=null;setUncertain(false);resetFilter();setNotice('Retry discarded. The earlier save may still have gone through, so refresh and check before changing work.');}}>Discard retry and clear private view</button></aside>}
    {context&&<><section><h2>{context.queue==='team'?'Team work':'My work'}</h2>
      {context.canCreate&&<button disabled={busy||uncertain} onClick={()=>choose(null)}>New work item</button>}
      {context.items.length===0&&<p>No work items here. Choose another status or create one.</p>}
      <div className={styles.actions}>{context.items.map(r=><button key={r.workItemId} disabled={busy||uncertain} onClick={()=>void open(r.workItemId)}><strong>{r.title}</strong><br/>{labels[r.status]} · {PRIORITY[r.priority]} · due {r.dueAt??'not set'}<br/>Assigned to: {who(r.assigneeId)}</button>)}</div>
      {context.nextAfter&&<button disabled={busy||uncertain} onClick={()=>void load(context.nextAfter)}>Next 50 records</button>}
      <IdFields manual={false}><form onSubmit={e=>{e.preventDefault();void open(knownId);}}><label>Work item record ID<input required value={knownId} disabled={busy||uncertain} onChange={e=>setKnownId(e.target.value)}/></label><button disabled={busy||uncertain}>Open</button></form></IdFields>
    </section>
    {selected&&<section><h2>{selected.title}</h2><p>{labels[selected.status]} · created by {who(selected.createdBy)} at {selected.createdAt}</p><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{selected.description||'No description recorded.'}</p><p>{PRIORITY[selected.priority]} · due {selected.dueAt??'not set'} · assigned to: {who(selected.assigneeId)}</p>
      <div className={styles.actions}><button disabled={busy||uncertain} onClick={()=>void open(selected.workItemId)}>Reload current detail</button>{selected.canTransition&&targets[selected.status].map(target=><button key={target} disabled={busy||uncertain||needsRefresh} onClick={()=>void run(()=>submit('TRANSITION',selected.workItemId,{expectedVersion:selected.version,targetStatus:target}))}>{target==='COMPLETED'?'Mark completed':`Move to ${labels[target].toLowerCase()}`}</button>)}</div>
      {['COMPLETED','FAILED'].includes(selected.status)&&<p>This item is closed and cannot be reopened.</p>}
      <h3>History</h3><ol>{selected.history.map(h=><li key={h.version}>{OPERATION[h.operation]??'Changed'} · {labels[h.status]} · assigned to: {who(h.assigneeId)} · by {who(h.actorId)} · {h.recordedAt}</li>)}</ol>
      {selected.nextBeforeVersion&&<button disabled={busy||uncertain} onClick={()=>void open(selected.workItemId,selected.nextBeforeVersion)}>Older history</button>}
      {selected.aiPlanIds.length>0&&<aside><h3>Linked AI plans</h3><p>{selected.aiPlanIds.length === 1 ? 'One AI plan refers to this item.' : `${selected.aiPlanIds.length} AI plans refer to this item.`} No AI execution or AI employee completion is implied.</p></aside>}
    </section>}
    {((!selected&&context.canCreate)||selected?.canEdit)&&<section><h2>{selected?'Edit or reassign':'New work item'}</h2><p>Nobody is assigned automatically.</p>
      <form onSubmit={save}><fieldset disabled={busy||uncertain||needsRefresh}>
        <label>Title<input required maxLength={120} value={draft.title} onChange={e=>edit({title:e.target.value})}/></label>
        <label>Private description<textarea maxLength={2000} rows={5} value={draft.description} onChange={e=>edit({description:e.target.value})}/></label>
        {context.canManage ? <>{pickScope&&<StaffPicker scope={pickScope} purpose="work" label="Assign to (optional)" value={draft.assigneeId??''} disabled={busy} onState={setStaffList} onItems={items=>setStaff(m=>new Map([...m,...items.map(p=>[p.principalId,p.displayName] as const)]))} onPick={person=>edit({assigneeId:person?.principalId??null})}/>}
          {(()=>{ const input=<label>Staff record ID (optional)<input value={draft.assigneeId??''} onChange={e=>edit({assigneeId:e.target.value||null})}/></label>; return manualStaff?input:<IdFields manual={false}>{input}</IdFields>; })()}</>
          : <><p>Assigned to: {who(draft.assigneeId)}</p><button type="button" onClick={()=>edit({assigneeId:draft.assigneeId?null:context.principalId})}>{draft.assigneeId?'Leave unassigned':'Assign to myself'}</button></>}
        <div className={styles.row}><label>Due at UTC (optional)<input type="datetime-local" step="0.001" min="2000-01-01T00:00" max="2099-12-31T23:59:59.999" value={draft.dueAt?.slice(0,-1)??''} onChange={e=>{const value=e.target.value;const date=value?new Date(`${value}Z`):null;if(!date||Number.isFinite(date.getTime()))edit({dueAt:date?.toISOString()??null});}}/></label>
        <label>Priority<select value={draft.priority} onChange={e=>edit({priority:e.target.value as HumanWorkInput['priority']})}><option value="LOW">Low</option><option value="NORMAL">Normal</option><option value="HIGH">High</option></select></label></div>
        <button type="submit">{selected?'Save changes':'Create work item'}</button>
      </fieldset></form></section>}
    </>}
  </main>;
}
