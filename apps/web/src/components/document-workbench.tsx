'use client';
import React, { useRef, useState, type FormEvent } from 'react';
import styles from './document-workbench.module.css';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEADERS={'Content-Type':'application/json','X-HON-Human-Command':'document-acknowledgement'};
async function request(url:string,body?:object,key?:string):Promise<{data:unknown;meta?:{replayed?:boolean}}> {
  const response=await fetch(url,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:body?{...HEADERS,'Idempotency-Key':key!}:{},...(body?{body:JSON.stringify(body)}:{})});
  const result=await response.json() as {data:unknown;meta?:{replayed?:boolean};detail?:string;message?:string};
  if(!response.ok) throw new Error(response.status===401?'Sign in with a verified human session.':result.detail??(typeof result.message==='string'?result.message:'This document command is unavailable in your scope.'));
  return result;
}
function retryKey(last:React.RefObject<{fingerprint:string;key:string}|null>,url:string,body:object):string {
  const fingerprint=JSON.stringify({url,body});if(last.current?.fingerprint!==fingerprint)last.current={fingerprint,key:crypto.randomUUID()};return last.current!.key;
}
export function DocumentWorkbench({initialMode='create'}:{initialMode?:'create'|'version'|'publish'}={}):React.ReactElement {
  const [org,setOrg]=useState(''),[school,setSchool]=useState(''),[mode,setMode]=useState<string>(initialMode),[id,setId]=useState('');
  const [audience,setAudience]=useState('STAFF'),[family,setFamily]=useState(''),[title,setTitle]=useState(''),[content,setContent]=useState('');
  const [version,setVersion]=useState('1'),[versionId,setVersionId]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState('');
  const last=useRef<{fingerprint:string;key:string}|null>(null);const read=['template','history','list'].includes(mode);
  async function submit(e:FormEvent<HTMLFormElement>){
    e.preventDefault();setError('');setResult('');
    if(!UUID.test(org)||!UUID.test(school)||(!['create','list'].includes(mode)&&!UUID.test(id))||(mode==='create'&&audience==='PARENT'&&!UUID.test(family))||(mode==='publish'&&!UUID.test(versionId))){setError('Use valid known school and document identifiers.');return;}
    const base=`/api/v1/organizations/${org}/schools/${school}/documents`;
    const url=mode==='create'?`${base}/templates`:mode==='version'?`${base}/templates/${id}/versions`:mode==='publish'?`${base}/templates/${id}/publish`:mode==='template'?`${base}/templates/${id}`:mode==='history'?`${base}/versions/${id}`:`${base}/publications`;
    const body=mode==='create'?{title,content,audience,...(audience==='PARENT'?{familyId:family}:{})}:mode==='version'?{title,content,expectedVersion:Number(version)}:mode==='publish'?{versionId,expectedVersion:Number(version)}:undefined;
    setBusy(true);try{const r=await request(url,body,body?retryKey(last,url,body):undefined);setResult(`${r.meta?.replayed?'Existing result, no duplicate effect':read?'Scoped read':'Committed internal document command'}\n${JSON.stringify(r.data,null,2)}`);}catch(e){setError(e instanceof Error?e.message:'Outcome uncertain. An identical retry uses the same key.');}finally{setBusy(false);}
  }
  return <main className={styles.page}><nav><a href="/core">HON Core</a><a href="/auth/login">Sign in</a></nav><header><p>HUMAN DOCUMENT CONTROL</p><h1>Versioned content. Deliberate publication.</h1><p>Create an immutable content version, then publish it with separate explicit permission. Further edits append a new version, never overwrite published bytes.</p></header>
    <aside>Internal acknowledgement evidence only, not a legal e-signature service. No provider, payments, AI execution, raw signature images or automatic messaging. STAFF and one-family PARENT audiences are supported; student authority is deferred.</aside>
    <form onSubmit={submit}><fieldset disabled={busy}><legend>Verified staff school scope</legend><label>Organization UUID<input required value={org} onChange={e=>setOrg(e.target.value)}/></label><label>School UUID<input required value={school} onChange={e=>setSchool(e.target.value)}/></label>
      <label>Operation<select value={mode} onChange={e=>{setMode(e.target.value);setResult('');setError('');}}><option value="create">Create template and version 1</option><option value="version">Append new content version</option><option value="publish">Publish immutable version</option><option value="template">Read current template</option><option value="history">Read immutable historical version</option><option value="list">List current publications</option></select></label>
      {!['create','list'].includes(mode)&&<label>{mode==='history'?'Version':'Template'} UUID<input required value={id} onChange={e=>setId(e.target.value)}/></label>}
      {mode==='create'&&<><label>Narrow audience<select value={audience} onChange={e=>setAudience(e.target.value)}><option value="STAFF">STAFF — scoped staff permission</option><option value="PARENT">PARENT — one verified family</option></select></label>{audience==='PARENT'&&<label>Staff-authorized family UUID<input required value={family} onChange={e=>setFamily(e.target.value)}/><small>Immutable target; checked against this school. Parents never submit a family or signer ID.</small></label>}</>}
      {['create','version'].includes(mode)&&<><label>Title<input required maxLength={200} value={title} onChange={e=>setTitle(e.target.value)}/></label><label>Plain-text content<textarea required rows={10} maxLength={100000} value={content} onChange={e=>setContent(e.target.value)}/><small>Exact bytes are hashed. HTML is never executed. A new version does not replace the current publication until a human publishes it.</small></label></>}
      {['version','publish'].includes(mode)&&<label>Expected template version<input required type="number" min={1} max={999999999} value={version} onChange={e=>setVersion(e.target.value)}/><small>Read the template first; publishing and versioning each advance this concurrency token.</small></label>}
      {mode==='publish'&&<><label>Exact latest content version UUID<input required value={versionId} onChange={e=>setVersionId(e.target.value)}/></label><label className={styles.check}><input required type="checkbox"/>I have reviewed this immutable version and intend to publish it to its fixed audience.</label></>}
      <button type="submit">{busy?'Verifying…':read?'Read authorized document':'Submit human document command'}</button></fieldset></form>
    {error&&<p role="alert" className={styles.error}>{error}</p>}{result&&<pre aria-live="polite" className={styles.result}>{result}</pre>}
    <DocumentAcknowledgementDesk embedded/>
  </main>;
}
type Publication={id:string;title:string;content:string;contentHash:string;versionNumber:number;current:boolean};
export function DocumentAcknowledgementDesk({parent=false,embedded=false}:{parent?:boolean;embedded?:boolean}):React.ReactElement {
  const [org,setOrg]=useState(''),[school,setSchool]=useState(''),[id,setId]=useState(''),[doc,setDoc]=useState<Publication|null>(null);
  const [base,setBase]=useState(''),[checked,setChecked]=useState(false),[attestation,setAttestation]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[receipt,setReceipt]=useState('');
  const last=useRef<{fingerprint:string;key:string}|null>(null);
  function reset(){setDoc(null);setChecked(false);setReceipt('');setError('');}
  async function load(e:FormEvent<HTMLFormElement>){e.preventDefault();reset();if(!UUID.test(school)||!UUID.test(id)||(!parent&&!UUID.test(org))){setError('Enter valid known school and publication UUIDs.');return;}
    const b=parent?`/api/v1/parent/schools/${school}/documents`:`/api/v1/organizations/${org}/schools/${school}/documents`;setBusy(true);
    try{const r=await request(`${b}/publications/${id}`);const d=r.data as Publication;if(!d.current||d.id!==id||typeof d.content!=='string'||!/^[a-f0-9]{64}$/.test(d.contentHash))throw new Error('This is not a current publication. Refresh its version.');setBase(b);setDoc(d);}catch(e){setError(e instanceof Error?e.message:'Document unavailable.');}finally{setBusy(false);}}
  async function acknowledge(e:FormEvent<HTMLFormElement>){e.preventDefault();if(!doc||!checked||busy)return;setBusy(true);setError('');
    const url=`${base}/publications/${doc.id}/acknowledgements`,body={contentHash:doc.contentHash,choice:'ACKNOWLEDGE',...(attestation?{attestationText:attestation}:{})};
    try{const r=await request(url,body,retryKey(last,url,body));setReceipt(`${r.meta?.replayed?'Existing immutable receipt':'Acknowledgement recorded'}\n${JSON.stringify(r.data,null,2)}`);}catch(e){setError(e instanceof Error?e.message:'Outcome uncertain. An identical retry uses the same key.');}finally{setBusy(false);}}
  const contents=<><header><p>INTERNAL HUMAN ACKNOWLEDGEMENT</p><h1>{parent?'Your published documents.':'Acknowledge a staff publication.'}</h1><p>Read the currently published content, then make an explicit choice. This is internal immutable evidence, not legal signature verification.</p></header>
    {parent&&<aside>School access and family audience are resolved from your verified human session. No family, person or signer identifiers are accepted. Only your own receipt is returned.</aside>}
    <form onSubmit={load}><fieldset disabled={busy}><legend>Read authorized publication</legend>{!parent&&<label>Organization UUID<input required value={org} onChange={e=>{setOrg(e.target.value);reset();}}/></label>}<label>School UUID<input required value={school} onChange={e=>{setSchool(e.target.value);reset();}}/></label><label>Publication UUID<input required value={id} onChange={e=>{setId(e.target.value);reset();}}/></label><button type="submit">{busy?'Verifying…':'Read current publication'}</button></fieldset></form>
    {doc&&<section className={styles.document}><h2>{doc.title}</h2><p>Content version {doc.versionNumber}</p><pre>{doc.content}</pre><details><summary>Immutable content hash</summary><code>{doc.contentHash}</code></details><form onSubmit={acknowledge}><fieldset disabled={busy}><legend>Your explicit acknowledgement</legend><label className={styles.check}><input type="checkbox" required checked={checked} onChange={e=>setChecked(e.target.checked)}/>I acknowledge that I have read this published version.</label><label>Optional typed attestation (500 characters maximum)<textarea maxLength={500} rows={3} value={attestation} onChange={e=>setAttestation(e.target.value)}/></label><button type="submit" disabled={!checked||busy}>{busy?'Recording…':'Record internal acknowledgement'}</button></fieldset></form></section>}
    {error&&<p role="alert" className={styles.error}>{error}</p>}{receipt&&<pre aria-live="polite" className={styles.result}>{receipt}</pre>}
  </>;
  return embedded?<section>{contents}</section>:<main className={styles.page}><nav><a href={parent?'/parent':'/core'}>Return to HON</a><a href="/auth/login">Sign in</a></nav>{contents}</main>;
}
