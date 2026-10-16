'use client';
import React, { useRef, useState } from 'react';
import { CLASSPASS_ACTIONS, type ClassPassAction, type ClassPassInput, type ClassPassReceipt, type ClassPassReadKind } from '@hon/contracts';
import { commandClassPass, readClassPass } from './classpass-workbench-http';
import styles from './attendance-workbench.module.css';
export type ClassPassInitialScope={organizationId?:string|undefined;schoolId?:string|undefined};
export function ClassPassWorkbench({initialScope={}}:{initialScope?:ClassPassInitialScope}={}) {
 const [scope,setScope]=useState({organizationId:initialScope.organizationId??'',schoolId:initialScope.schoolId??''});
 const [action,setAction]=useState<ClassPassAction>('CONFIGURE_PRODUCT');
 const [draft,setDraft]=useState({target:'',programId:'',studentProfileId:'',passId:'',name:'',allowedUses:'1',validityDays:'30',expectedVersion:'0',reason:''});
 const [readKind,setReadKind]=useState<ClassPassReadKind>('PRODUCT');const [readId,setReadId]=useState('');
 const [result,setResult]=useState<ClassPassReceipt|null>(null);const [error,setError]=useState('');const [busy,setBusy]=useState(false);
 const retained=useRef<{fingerprint:string;key:string}|null>(null);const generation=useRef(0);
 function clear() { generation.current++;setResult(null);setError(''); }
 function change(field:keyof typeof draft,value:string) {clear();setDraft(d=>({...d,[field]:value}));}
 async function run(work:()=>Promise<ClassPassReceipt>) {if(busy)return;const g=generation.current;setBusy(true);setError('');setResult(null);try {const r=await work();if(g===generation.current)setResult(r);}catch(e){if(g===generation.current)setError(`${e instanceof Error?e.message:'Unavailable' } No success is assumed. Retry an unchanged command with its retained key; refresh exact records before changing a version.`);}finally{setBusy(false);}}
 function submit() {
  const base={expectedVersion:Number(draft.expectedVersion)};
  let input:ClassPassInput;
  if(action==='CONFIGURE_PRODUCT') input={...base,programId:draft.programId,name:draft.name,allowedUses:Number(draft.allowedUses),validityDays:Number(draft.validityDays),reason:draft.reason};
  else if(action==='ISSUE') input={...base,studentProfileId:draft.studentProfileId,issuanceKind:'MANUAL_NONFINANCIAL',reason:draft.reason};
  else if(action==='ADMIT') input={...base,passId:draft.passId};
  else if(action==='REVERSE_REDEMPTION') input={...base,passId:draft.passId,reason:draft.reason};
  else input={...base,reason:draft.reason};
  const fingerprint=JSON.stringify({scope,action,target:draft.target,input});
  if(retained.current?.fingerprint!==fingerprint)retained.current={fingerprint,key:crypto.randomUUID()};
  const key=retained.current!.key;
  void run(()=>commandClassPass(scope,action,draft.target,input,key));
 }
 return <main className={styles.page}>
  <header className={styles.header}><p className={styles.eyebrow}>Human staff · operational allowance</p><h1>ClassPass &amp; Walk-In</h1><p>Manual nonfinancial grants only. No purchase, reconciliation, refund or credit. Payment/provider outcome unavailable.</p></header>
  <section className={styles.panel}><h2>Exact known school context</h2><p>No directory, roster, search or inferred family association. A verified view may prefill untrusted UUIDs only; no record or command runs until a direct human selects an operation. Parent ClassPass projection unavailable.</p><fieldset disabled={busy} className={styles.scopeGrid}>{(['organizationId','schoolId'] as const).map(field=><label key={field}>{field}<input value={scope[field]} onChange={e=>{clear();setScope(s=>({...s,[field]:e.target.value.trim().toLowerCase()}));}} /></label>)}</fieldset></section>
  <section className={styles.panel}><h2>Read one exact operational record</h2><fieldset disabled={busy} className={styles.recordForm}><label>Record kind<select value={readKind} onChange={e=>{clear();setReadKind(e.target.value as ClassPassReadKind);}}>{['PRODUCT','PASS','BOOKING'].map(k=><option key={k}>{k}</option>)}</select></label><label>Exact record UUID<input value={readId} onChange={e=>{clear();setReadId(e.target.value.trim().toLowerCase());}} /></label><button onClick={()=>void run(()=>readClassPass(scope,readKind,readId))}>Read exact record</button></fieldset></section>
  <section className={styles.panel}><h2>Direct human command</h2><p>Configure target = product UUID (new: expected version 0). Issue target = product UUID/version. Admit target = exact session UUID; version = pass version. Reverse redemption target = exact booking UUID; version = pass version. Retirement does not alter frozen issued allowances.</p>
   <fieldset disabled={busy} className={styles.recordForm}><label>Operation<select value={action} onChange={e=>{clear();setAction(e.target.value as ClassPassAction);}}>{CLASSPASS_ACTIONS.map(a=><option key={a}>{a}</option>)}</select></label>
    <label>Exact target UUID<input value={draft.target} onChange={e=>change('target',e.target.value.trim().toLowerCase())} /></label><label>Expected version<input type="number" min="0" value={draft.expectedVersion} onChange={e=>change('expectedVersion',e.target.value)} /></label>
    {action==='CONFIGURE_PRODUCT'&&<><label>Exact program UUID<input value={draft.programId} onChange={e=>change('programId',e.target.value.trim().toLowerCase())} /></label><label>Operational product name<input maxLength={100} value={draft.name} onChange={e=>change('name',e.target.value)} /></label><label>Allowed uses (1–1000)<input type="number" min="1" max="1000" value={draft.allowedUses} onChange={e=>change('allowedUses',e.target.value)} /></label><label>Validity days (1–365)<input type="number" min="1" max="365" value={draft.validityDays} onChange={e=>change('validityDays',e.target.value)} /></label></>}
    {action==='ISSUE'&&<label>Exact student UUID<input value={draft.studentProfileId} onChange={e=>change('studentProfileId',e.target.value.trim().toLowerCase())} /></label>}
    {(action==='ADMIT'||action==='REVERSE_REDEMPTION')&&<label>Exact issued pass UUID<input value={draft.passId} onChange={e=>change('passId',e.target.value.trim().toLowerCase())} /></label>}
    {action!=='ADMIT'&&<label>Required operational reason (1–500 characters)<textarea maxLength={500} value={draft.reason} onChange={e=>change('reason',e.target.value)} /></label>}
    <button onClick={submit}>{action==='ISSUE'?'Grant MANUAL_NONFINANCIAL allowance':'Submit direct human command'}</button>
   </fieldset><p>Admission opens two hours before class and closes at class end. Full capacity means WAITLISTED_NOT_REDEEMED, not admission. A new-key retry may promote only when capacity becomes available. Use “New admission attempt” only after reading current pass/version; unchanged retries retain the saved receipt.</p><button disabled={busy||action!=='ADMIT'} onClick={()=>{retained.current=null;clear();}}>New admission attempt</button>
  </section>
  <section className={styles.panel}><h2>Verified outcome</h2><p>Booking ≠ walk-in decision ≠ redemption ≠ attendance. ClassPass never records attendance or check-in. Payment/provider outcome unavailable.</p>{busy&&<p role="status">Awaiting verified response…</p>}{error&&<p role="alert">{error}</p>}{result&&<><p role="status">{result.decision??'Operational record'} · version {result.version}. Payment/provider: UNAVAILABLE. Attendance: not recorded by ClassPass.</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(result,null,2)}</pre></>}</section>
 </main>;
}
