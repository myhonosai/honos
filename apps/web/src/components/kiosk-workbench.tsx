'use client';
import { useEffect, useRef, useState } from 'react';
import { kioskStaffRequest, newKioskSecret } from './kiosk-http';
import type { KioskClaimResult, KioskTerminalResult } from '@hon/contracts';
import styles from './attendance-workbench.module.css';
export function KioskWorkbench() {
 const [scope,setScope]=useState({organizationId:'',schoolId:''});
 const [draft,setDraft]=useState({terminalId:'',terminalSessionId:'',claimId:'',studentProfileId:'',classSessionId:''});
 const [secret,setSecret]=useState(''),[operation,setOperation]=useState<'activate'|'provision'>('activate');
 const [result,setResult]=useState<KioskClaimResult|KioskTerminalResult|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const generation=useRef(0);
 function clear(){generation.current++;setSecret('');setResult(null);setError('');}
 useEffect(()=>{const hide=()=>{if(document.visibilityState==='hidden')clear();};document.addEventListener('visibilitychange',hide);window.addEventListener('pagehide',clear);return()=>{document.removeEventListener('visibilitychange',hide);window.removeEventListener('pagehide',clear);};},[]);
 async function run(action:'activate'|'retire'|'provision'|'recover') {
  if(busy)return;const g=generation.current;const value=secret;
  setSecret('');setResult(null);setError('');setBusy(true);
  try {const r=await kioskStaffRequest(scope,action==='activate'||action==='retire'?'terminals':'claims',action==='activate'||action==='retire'?draft.terminalId:draft.claimId,action==='recover'?undefined:action,action==='activate'?{terminalSessionId:draft.terminalSessionId,terminalSession:value}:action==='provision'?{studentProfileId:draft.studentProfileId,classSessionId:draft.classSessionId,claim:value}:action==='retire'?{}:undefined);if(g===generation.current)setResult(r);}
  catch {if(g===generation.current)setError('Unavailable. The secret has been cleared and is never re-sent automatically. Recover by exact claim UUID; no admission or other outcome is assumed.');}
  finally {setBusy(false);}
 }
 return <main className={styles.page}><header className={styles.header}><p className={styles.eyebrow}>Direct human · exact context only</p><h1>Kiosk handoff foundation</h1><p>NO admission, redemption, check-in, attendance, payment or notification. This creates only a pending staff review. No ClassPass, booking, family or financial authority.</p></header>
 <section className={styles.panel}><h2>Known exact context</h2><p>No listing, search, queue or inferred identity. Owner-only terminal lifecycle. OWNER/ADMIN exact claim provisioning and recovery, with current school permissions and tier.</p><fieldset disabled={busy} className={styles.scopeGrid}>{(['organizationId','schoolId'] as const).map(k=><label key={k}>{k}<input autoComplete="off" value={scope[k]} onChange={e=>{clear();setScope(s=>({...s,[k]:e.target.value.trim().toLowerCase()}));}} /></label>)}</fieldset></section>
 <section className={styles.panel}><h2>Exact IDs</h2><fieldset disabled={busy} className={styles.recordForm}>{(Object.keys(draft) as Array<keyof typeof draft>).map(k=><label key={k}>{k}<input autoComplete="off" value={draft[k]} onChange={e=>{clear();setDraft(d=>({...d,[k]:e.target.value.trim().toLowerCase()}));}} /></label>)}</fieldset></section>
 <section className={styles.panel}><h2>Supply a bearer once, by a direct human</h2><p>Choose the operation and generate a cryptographically random 32-byte value. Transfer it manually to the terminal or guest before submitting; it is shown here only until submission. Do not put it in a URL, notes, messages or browser storage. Submit clears it, including on unknown outcomes; there is no secret replay or retrieval.</p><fieldset disabled={busy} className={styles.recordForm}><label>Operation<select value={operation} onChange={e=>{clear();setOperation(e.target.value as 'activate'|'provision');}}><option value="activate">Activate terminal session (15 minutes maximum)</option><option value="provision">Provision exact student/session claim (10 minutes maximum)</option></select></label><button onClick={()=>{clear();setSecret(newKioskSecret());}}>Generate one-time CSPRNG bearer</button>{secret&&<label>Transfer this bearer once<input readOnly autoComplete="off" value={secret} aria-label="One-time bearer" /></label>}<button disabled={!secret} onClick={()=>void run(operation)}>Submit once and clear bearer</button><button onClick={()=>void run('retire')}>Retire exact terminal permanently</button><button onClick={()=>void run('recover')}>Recover exact claim UUID only</button></fieldset><button onClick={clear}>Clear screen</button></section>
 <section className={styles.panel}><h2>Redacted outcome</h2>{busy&&<p role="status">Awaiting exact result…</p>}{error&&<p role="alert">{error}</p>}{result&&<pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(result,null,2)}</pre>}<p>UUIDs, states and times only. A consumed claim and pending handoff are NOT admission or any other operational outcome.</p></section>
 </main>;
}
