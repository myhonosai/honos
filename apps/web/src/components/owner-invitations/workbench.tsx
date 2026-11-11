'use client';
import React, { useEffect, useRef, useState } from 'react';
import { OWNER_INVITATION_CONFIRMATION, accountClosed, validateOwnerInvitation, validateOwnerAccountReceipt, type OwnerInvitation, type HqSchoolDirectoryEntry } from '@hon/contracts';
import { HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT, reportConfirmedSessionInvalidation } from '../session-invalidation';
import { accountRequest, AccountError } from './http';
import styles from './workbench.module.css';
import { verifyHqSchoolDirectorySnapshot } from '../hq-school-directory-http';
type School=HqSchoolDirectoryEntry;
type Command=Readonly<{path:string;body:Readonly<Record<string,unknown>>;key:string;identity:string;kind:'invite'|'revoke'|'accept'}>;
export function SchoolOwnerInvitations({hq=false}:{hq?:boolean}) {
  const [hidden,setHidden]=useState(false),[verified,setVerified]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[schools,setSchools]=useState<School[]>([]),[school,setSchool]=useState(''),[items,setItems]=useState<OwnerInvitation[]>([]),[email,setEmail]=useState(''),[token,setToken]=useState(''),[invitation,setInvitation]=useState(''),[confirmed,setConfirmed]=useState(false),[retry,setRetry]=useState(false),[receipt,setReceipt]=useState('');
  const life=useRef({mounted:false,concealed:false,busy:false,epoch:0,identity:'',sensitive:false,mountId:0});
  const pending=useRef<Command|null>(null),read=useRef<AbortController|null>(null);
  const conceal=()=>{ const s=life.current; if(!s.sensitive&&!s.identity&&!pending.current&&!s.busy)return; s.concealed=true;s.epoch++;read.current?.abort();setHidden(true);setVerified(false);setSchools([]);setItems([]);setReceipt('');setMessage('');setToken('');setEmail('');setInvitation('');setConfirmed(false); };
  useEffect(()=>{
    life.current.mounted=true;life.current.mountId++;
    const visibility=()=>{if(document.visibilityState==='hidden')conceal();};
    const events=[['blur',conceal],['pagehide',conceal],[HON_SESSION_INVALIDATED_EVENT,conceal],[HON_SCHOOL_CONTEXT_CHANGED_EVENT,conceal]] as const;
    for(const [e,h] of events)window.addEventListener(e,h);document.addEventListener('visibilitychange',visibility);
    return ()=>{life.current.mounted=false;life.current.epoch++;read.current?.abort();pending.current=null;for(const[e,h]of events)window.removeEventListener(e,h);document.removeEventListener('visibilitychange',visibility);};
  },[]);
  async function verify() {
    if(life.current.busy)return;
    const s=life.current,instance=s.mountId,epoch=++s.epoch,controller=new AbortController(); read.current?.abort();read.current=controller;s.sensitive=true;s.busy=true;setBusy(true);
    try {
      const me=await fetch('/api/identity/me',{credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal});
      if(me.status===401)reportConfirmedSessionInvalidation(); if(!me.ok)throw new AccountError(me.status,'SIGN_IN_REQUIRED');
      const identity=(await me.json()).data?.externalSubject;
      if(typeof identity!=='string')throw new AccountError(401,'SIGN_IN_REQUIRED');
      if(s.identity&&s.identity!==identity) { pending.current=null;throw new AccountError(403,'ACCOUNT_CHANGED_RESTART_REQUIRED'); }
      if(hq){ const scope=await accountRequest('hq/session',controller.signal) as {hqRole?:string}; if(scope.hqRole!=='HON_HQ_OWNER')throw new AccountError(403,'HQ_OWNER_REQUIRED'); }
      if(!s.mounted||s.epoch!==epoch)return;
      s.identity=identity;s.concealed=false;setHidden(false);setVerified(true);setRetry(!!pending.current);setMessage('Access verified. Choose an explicit action; no command was repeated.');
    } catch(e){ if(s.mounted&&s.epoch===epoch){s.concealed=true;setHidden(true);setVerified(false);setMessage(e instanceof AccountError?e.code:'Access could not be verified.');} }
    finally{if(s.mounted&&s.mountId===instance){s.busy=false;setBusy(false);}}
  }
  async function load(path:string,apply:(v:unknown)=>void){
    const s=life.current;if(s.busy||s.concealed||!verified)return;const instance=s.mountId,epoch=++s.epoch,c=new AbortController();read.current?.abort();read.current=c;s.busy=true;s.sensitive=true;setBusy(true);setMessage('Loading authorized records…');
    try{const v=await accountRequest(path,c.signal);if(s.mounted&&s.epoch===epoch&&!s.concealed){apply(v);setMessage('Authorized records loaded.');}}
    catch(e){if(s.mounted&&s.epoch===epoch&&!s.concealed){if(e instanceof AccountError&&e.status===403)conceal();setSchools([]);setItems([]);setMessage(e instanceof AccountError?e.code:'Read unavailable.');}}
    finally{if(s.mounted&&s.mountId===instance){s.busy=false;setBusy(false);}}
  }
  async function execute(command:Command){
    const s=life.current;if(s.busy||s.concealed||!verified||command.identity!==s.identity)return;
    const instance=s.mountId;pending.current=command;s.busy=true;s.sensitive=true;setBusy(true);setRetry(true);setMessage('Command in progress. Do not discard this view.');
    // Command lifetime is independent of read epochs/focus loss; never abort an unsettled consequential request.
    try{const result=await accountRequest(command.path,new AbortController().signal,{body:command.body,key:command.key});
      if(!s.mounted||s.mountId!==instance||s.concealed)return;
      if(command.kind==='accept'){validateOwnerAccountReceipt(result);setReceipt('School-owner account bound. Operating access depends on separate authorized entitlements. No payment or AI credits were activated.');}
      else{const i=validateOwnerInvitation(result);setItems([i]);setReceipt(command.kind==='invite'?'Invitation recorded. Securely share its ID and the token you entered with the intended owner. Nothing was sent.':'Invitation and its own owner grant revoked. Other authority is unchanged.');}
      pending.current=null;setRetry(false);setMessage('Verified command receipt received.');
    }catch(e){if(!s.mounted||s.mountId!==instance||s.concealed)return;
      setMessage(e instanceof AccountError?(e.status===429?'Please wait up to 60 seconds, then explicitly retry the exact request. This attempt was not submitted; any earlier unknown outcome remains unresolved.':e.code):'Outcome unknown. Retry the exact request explicitly after checking access.');
      if(e instanceof AccountError&&e.status>=400&&e.status<500&&e.status!==429){pending.current=null;setRetry(false);if(e.status===403)conceal();}
    }finally{if(s.mounted&&s.mountId===instance){s.busy=false;setBusy(false);}}
  }
  const start=(kind:Command['kind'],body:Record<string,unknown>)=>{
    if(pending.current||life.current.busy)return;
    void execute(Object.freeze({kind,path:kind==='accept'?'account/school-owner-invitations/accept':kind==='revoke'?'hq/school-owner-invitations/revoke':'hq/school-owner-invitations',body:Object.freeze({...body}),key:crypto.randomUUID(),identity:life.current.identity}));
  };
  return <section className={styles.page} aria-label={hq?'School-owner invitations':'Accept school-owner invitation'}>
    <h1>{hq?'School-owner invitations':'Welcome to HON OS'}</h1>
    <p>{hq?'Invite an owner to an existing HQ-approved school. Roles and school authority are assigned by the server.':'Sign in using the verified email named in your invitation, then accept it explicitly.'}</p>
    <p>Account creation does not activate paid access, billing, trials or AI credits. Password and MFA recovery use your configured identity provider. A changed identity requires HQ review.</p>
    <p role="status" aria-live="polite" aria-atomic="true">{message||'No protected records loaded.'}</p>
    <a href="/auth/login">Sign in / recover identity-provider account</a>
    {(!verified||hidden)&&<div><p>{hidden?'Private account information is concealed. Verify access to continue.':'Verify your account before continuing.'}</p><button disabled={busy} onClick={()=>void verify()}>Verify access</button></div>}
    {verified&&!hidden&&<>
      {receipt&&<p className={styles.notice}>{receipt}</p>}
      {retry&&<aside><p>The exact request remains in private memory. Retry requires your action. Abandoning local recovery cannot reverse a server action; a full page reload loses this request.</p><button disabled={busy} onClick={()=>pending.current&&void execute(pending.current)}>Retry exact request</button><button disabled={busy} onClick={()=>{if(window.confirm('Abandon local recovery? This cannot reverse an action already committed by HON.')){pending.current=null;setRetry(false);}}}>Abandon local recovery</button></aside>}
      <fieldset disabled={busy||retry}>
        {hq?<>
          <button type="button" onClick={()=>void load('hq/schools',v=>{const d=accountClosed(v,['directory']);setSchools(verifyHqSchoolDirectorySnapshot(d.directory).schools);})}>Load approved schools</button>
          <label>Approved school<select value={school} onChange={e=>{setSchool(e.target.value);setItems([]);setReceipt('');}}><option value="">Select a school</option>{schools.map(s=><option value={s.schoolId} key={s.schoolId}>{s.organizationDisplayName} — {s.schoolDisplayName}</option>)}</select></label>
          <button type="button" disabled={!school} onClick={()=>void load('hq/schools/'+school+'/owner-invitations',v=>{if(!Array.isArray(v))throw new Error();setItems(v.map(validateOwnerInvitation));})}>Review invitations (latest 50)</button>
          <label>Owner email<input type="email" value={email} onChange={e=>setEmail(e.target.value.toLowerCase())}/></label>
          <label>Private invitation token<input value={token} readOnly autoComplete="off"/></label>
          <button type="button" onClick={()=>{const b=crypto.getRandomValues(new Uint8Array(32));setToken(btoa(String.fromCharCode(...b)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''));}}>Generate private token</button>
          <p>Keep this token out of URLs, logs and browser storage. Send the ID and token through your approved secure channel. Expires in 24 hours.</p>
          <button type="button" disabled={!school||!email||!token} onClick={()=>{const s=schools.find(x=>x.schoolId===school);if(s&&window.confirm('Invite this email as owner of the selected school?'))start('invite',{schoolId:s.schoolId,email,token,ttlHours:24});}}>Record owner invitation</button>
          <ul>{items.map(i=><li key={i.invitationId}><p>{i.email} — {i.status}</p><p>Invitation ID: {i.invitationId}</p><p>Expires: {i.expiresAt}</p>{i.status!=='REVOKED'&&<button type="button" onClick={()=>{if(window.confirm('Revoke this invitation and only the owner grant it created?'))start('revoke',{invitationId:i.invitationId});}}>Revoke invitation / bound grant</button>}</li>)}</ul>
        </>:<>
          <label>Invitation ID<input value={invitation} onChange={e=>setInvitation(e.target.value)} autoComplete="off"/></label>
          <label>Private invitation token<input type="password" value={token} onChange={e=>setToken(e.target.value)} autoComplete="off"/></label>
          <label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>I am the invited school owner and explicitly accept this account invitation.</label>
          <button type="button" disabled={!confirmed||!invitation||!token} onClick={()=>start('accept',{invitationId:invitation,token,confirmation:OWNER_INVITATION_CONFIRMATION})}>Accept invitation</button>
          {receipt&&<a href="/staff/entry">Open staff workspace</a>}
        </>}
      </fieldset>
    </>}
  </section>;
}
