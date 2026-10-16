'use client';
import { useEffect, useRef, useState } from 'react';
import { submitKiosk } from './kiosk-http';
import styles from './attendance-workbench.module.css';
export function KioskScreen() {
 const [terminal,setTerminal]=useState(''),[draft,setDraft]=useState(''),[claim,setClaim]=useState(''),[busy,setBusy]=useState(false),[done,setDone]=useState(false);
 const generation=useRef(0);
 function lock(){generation.current++;setTerminal('');setDraft('');setClaim('');setDone(false);setBusy(false);}
 function reset(){generation.current++;setClaim('');setDone(false);setBusy(false);}
 useEffect(()=>{if(!terminal)return;const timer=setTimeout(lock,15*60*1000);return()=>clearTimeout(timer);},[terminal]);
 useEffect(()=>{const hide=()=>{if(document.visibilityState==='hidden')lock();};document.addEventListener('visibilitychange',hide);window.addEventListener('pagehide',lock);return()=>{document.removeEventListener('visibilitychange',hide);window.removeEventListener('pagehide',lock);};},[]);
 async function send(){if(busy)return;const current=generation.current;const value=claim;setClaim('');setBusy(true);await submitKiosk(terminal,value);if(current===generation.current){setBusy(false);setDone(true);}}
 return <main className={styles.page}><header className={styles.header}><p className={styles.eyebrow}>HON · staff assistance only</p><h1>Need staff assistance?</h1><p>This kiosk does NOT admit, redeem, check in, record attendance, take payment or send notifications.</p></header>
 {!terminal?<section className={styles.panel}><h2>Staff terminal setup</h2><p>A staff member must enter a freshly activated terminal bearer here. It stays in memory only, never in a URL or browser storage. Refresh or lock clears it. No staff login is given to this kiosk.</p><label>Terminal bearer<input type="password" autoComplete="off" value={draft} maxLength={43} onChange={e=>setDraft(e.target.value)} /></label><button onClick={()=>{if(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(draft)){setTerminal(draft);setDraft('');}}}>Use terminal for this screen</button></section>
 :<section className={styles.panel}><h2>Ask staff for an opaque claim</h2><p>No name, student search, roster or identity fallback. A claim requests staff review only.</p><label>One-time claim<input type="password" autoComplete="off" value={claim} maxLength={43} disabled={busy||done} onChange={e=>setClaim(e.target.value)} /></label><button disabled={busy||done} onClick={()=>void send()}>Request staff assistance</button>{busy&&<p role="status">Please wait for staff.</p>}{done&&<p role="status">NEEDS_STAFF_ASSISTANCE — Please speak to staff. No admission, redemption, check-in, attendance, payment or notification outcome is assumed.</p>}<button onClick={reset}>Reset for next guest</button><button onClick={lock}>Lock and clear terminal</button></section>}
 </main>;
}
