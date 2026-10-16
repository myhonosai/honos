'use client';
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { OwnerLaunchProjection } from '@hon/contracts';
import { loadOwnerLaunch, OwnerLaunchAccessError, postOwnerLaunch } from './owner-launch-http';
export function OwnerLaunch() {
  const [context,setContext]=useState<OwnerLaunchProjection|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('Load your verified school context to begin. HQ provisioning is separate.');
  const [programName,setProgramName]=useState(''),[className,setClassName]=useState(''),[startsAt,setStartsAt]=useState(''),[endsAt,setEndsAt]=useState(''),[capacity,setCapacity]=useState(10);
  const [givenName,setGivenName]=useState(''),[familyName,setFamilyName]=useState(''),[birthDate,setBirthDate]=useState(''),[attested,setAttested]=useState(false);
  const generation=useRef(0);
  const retry=useRef<{operation:string;fingerprint:string;key:string}|null>(null);
  function clearPrivateInput() {setGivenName('');setFamilyName('');setBirthDate('');setAttested(false);retry.current=null;}
  useEffect(()=>{
    const stale=()=>{generation.current++;setContext(null);setBusy(false);setMessage('School state may have changed. Reload saved receipts before continuing.');setGivenName('');setFamilyName('');setBirthDate('');setAttested(false);};
    window.addEventListener('focus',stale);document.addEventListener('visibilitychange',stale);
    return ()=>{generation.current++;window.removeEventListener('focus',stale);document.removeEventListener('visibilitychange',stale);};
  },[]);
  async function reload() {const current=++generation.current;setBusy(true);setContext(null);try {const loaded=await loadOwnerLaunch();if(current!==generation.current)return;setContext(loaded);setMessage('Saved creation receipts loaded. These are historical receipts, not current eligibility or class admission.');}catch(error){if(current!==generation.current)return;setMessage(error instanceof Error?error.message:'School launch is unavailable.');if(error instanceof OwnerLaunchAccessError&&[401,403].includes(error.status))clearPrivateInput();}finally{if(current===generation.current)setBusy(false);}}
  async function submit(operation:'program'|'class'|'student') {
    if (!context || busy) return;
    const current=++generation.current;
    let input:unknown;
    try {
      if(operation==='program')input={name:programName.trim()};
      else if(operation==='class')input={programId:context.program?.id,name:className.trim(),startsAt:new Date(startsAt).toISOString(),endsAt:new Date(endsAt).toISOString(),capacity,bookingPolicy:'OPTIONAL_BOOKING'};
      else {if(!attested || !context.program || !context.classSession)throw new Error('Explicit new-adult attestation and saved program/class receipts are required.');input={programId:context.program.id,expectedProgramVersion:context.program.version,classSessionId:context.classSession.id,expectedClassSessionVersion:context.classSession.version,givenName:givenName.trim(),familyName:familyName.trim(),birthDate,attestation:'NEW_ADULT_NO_GUARDIAN_REQUIRED'};}
      const fingerprint=JSON.stringify(input);
      if(!retry.current || retry.current.operation!==operation || retry.current.fingerprint!==fingerprint)retry.current={operation,fingerprint,key:crypto.randomUUID()};
      setBusy(true);setContext(null);
      await postOwnerLaunch(context,operation,input,retry.current.key);
      if(current!==generation.current)return;
      if(operation==='student')clearPrivateInput();
      const loaded=await loadOwnerLaunch();if(current!==generation.current)return;setContext(loaded);setMessage('Saved receipt verified. No booking, attendance, membership, billing, parent login or message was created.');
    }catch(error){if(current!==generation.current)return;setContext(null);setMessage(error instanceof Error?error.message:'Outcome unavailable. Reload saved receipts before trying again.');if(error instanceof OwnerLaunchAccessError&&[401,403].includes(error.status))clearPrivateInput();}finally{if(current===generation.current)setBusy(false);}
  }
  const field={display:'grid',gap:6,marginBottom:12} as const;
  return <main style={{maxWidth:840,margin:'2rem auto',padding:24}}>
    <h1>Owner launch</h1><p>School context → first program → first class → student registration → saved receipt</p>
    <p>Conventional human setup only. No directory search or cross-school selection. HQ provisioning and owner grants remain a separate controlled workflow.</p>
    <p role="status" aria-live="polite">{message}</p><button type="button" disabled={busy} onClick={()=>void reload()}>{busy?'Verifying…':'Load / refresh saved receipts'}</button>
    {context&&<>
      <section aria-label="Verified school context"><h2>1. Verified school context</h2><p>{context.schoolName} · {context.tier}</p><p>School receipt context: <code>{context.schoolId}</code></p></section>
      <section><h2>2. First program</h2>{context.program?<p>Saved program receipt: <code>{context.program.id}</code> · {context.program.status} · version {context.program.version}</p>:<form onSubmit={e=>{e.preventDefault();void submit('program');}}><label style={field}>Program name<input value={programName} onChange={e=>setProgramName(e.target.value)} maxLength={160} required /></label><button disabled={busy}>Save first program</button></form>}</section>
      <section><h2>3. First class</h2>{context.classSession?<p>Saved class receipt: <code>{context.classSession.id}</code> · {context.classSession.status} · version {context.classSession.version}</p>:context.program?<form onSubmit={e=>{e.preventDefault();void submit('class');}}><label style={field}>Class name<input value={className} onChange={e=>setClassName(e.target.value)} maxLength={160} required /></label><label style={field}>Starts (your local time)<input type="datetime-local" value={startsAt} onChange={e=>setStartsAt(e.target.value)} required /></label><label style={field}>Ends (your local time)<input type="datetime-local" value={endsAt} onChange={e=>setEndsAt(e.target.value)} required /></label><label style={field}>Capacity<input type="number" min={1} max={1000} value={capacity} onChange={e=>setCapacity(Number(e.target.value))} required /></label><p>Optional booking policy. This step saves a class; it does not book a student.</p><button disabled={busy}>Save first class</button></form>:<p>Save a program first.</p>}</section>
      <section><h2>4. Register a real student</h2><p>This bounded path is for a new adult (18+) who needs no guardian relationship. Children, existing people/students, guardian or parent access, and uncertain eligibility need staff; no identity or family relationship is inferred.</p><p>Registration creates only a person, student profile and program-only enrollment. No curriculum/rank is inferred; no family or parent account is needed for this adult path.</p>
        {context.registration?<p>Registration already saved in this flow. No additional registration action is shown.</p>:context.program&&context.classSession?<form onSubmit={e=>{e.preventDefault();void submit('student');}}><label style={field}>Student given name<input autoComplete="off" value={givenName} onChange={e=>setGivenName(e.target.value)} maxLength={100} required /></label><label style={field}>Student family name<input autoComplete="off" value={familyName} onChange={e=>setFamilyName(e.target.value)} maxLength={100} required /></label><label style={field}>Birth date<input type="date" value={birthDate} onChange={e=>setBirthDate(e.target.value)} required /></label><label style={field}><span><input type="checkbox" checked={attested} onChange={e=>setAttested(e.target.checked)} required /> I verified this is a new adult student and no guardian relationship is required.</span></label><button disabled={busy||!attested}>Save bounded student registration</button></form>:<p>Save a class first. Registration authority is rechecked at the server.</p>}</section>
      <section><h2>5. Saved receipt</h2>{context.registration?<><p><strong>REGISTERED — NO BOOKING</strong></p><p>Receipt: <code>{context.registration.registrationId}</code></p><p>Student: <code>{context.registration.studentProfileId}</code></p><p>Program enrollment: <code>{context.registration.enrollmentId}</code></p><p>Saved at {context.registration.createdAt}</p></>:<p>No saved student registration receipt yet. An unavailable result is never success.</p>}</section>
    </>}
    <nav aria-label="Conventional staff modules"><Link href="/staff/dashboard">Staff dashboard</Link> · <Link href="/staff/attendance">Attendance</Link> · <Link href="/staff/curriculum/library">Curriculum library</Link></nav>
  </main>;
}
