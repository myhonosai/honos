'use client';
import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import type { DocumentPublicationRecord, DocumentTemplateRecord } from '@hon/contracts';
import styles from './document-workbench.module.css';
import { ManualSchoolFields, useShellSchoolInto } from './school-shell/page-school';
import { IdFields } from './school-pickers/pickers';
import { documentBase, documentRequest, isDocumentId, loadFamilies, loadPublications, loadTemplate, template, type FamilyChoice } from './documents/document-http';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const request=documentRequest;
function retryKey(last:React.RefObject<{fingerprint:string;key:string}|null>,url:string,body:object):string {
  const fingerprint=JSON.stringify({url,body});if(last.current?.fingerprint!==fingerprint)last.current={fingerprint,key:crypto.randomUUID()};return last.current!.key;
}
const audienceLabel=(a:string)=>a==='PARENT'?'For one family':'For staff';
const day=(iso:string)=>new Date(iso).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});
const failed=(e:unknown)=>e instanceof Error?e.message:"We couldn't confirm that. Try again.";
/**
 * Staff documents for the signed-in school: published documents are listed by title, a document is opened from the
 * list (or by record ID as a fallback), and writing, versioning and publishing are plain buttons. Every command still
 * carries the template's version, and the server checks school, permission and family on every call.
 */
export function DocumentWorkbench():React.ReactElement {
  const [org,setOrg]=useState(''),[school,setSchool]=useState('');
  const shell=useShellSchoolInto(s=>{setOrg(s.organizationId);setSchool(s.schoolId);});
  const [publications,setPublications]=useState<DocumentPublicationRecord[]|null>(null),[families,setFamilies]=useState<FamilyChoice[]|null>(null);
  const [selected,setSelected]=useState<DocumentTemplateRecord|null>(null),[openId,setOpenId]=useState('');
  const [audience,setAudience]=useState('STAFF'),[family,setFamily]=useState(''),[title,setTitle]=useState(''),[content,setContent]=useState(''),[reviewed,setReviewed]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const last=useRef<{fingerprint:string;key:string}|null>(null);
  const scope=UUID.test(org)&&UUID.test(school)?{organizationId:org,schoolId:school}:null;
  useEffect(()=>{if(!shell)return;let live=true;const s={organizationId:shell.organizationId,schoolId:shell.schoolId};
    loadPublications(s).then(p=>{if(live)setPublications(p);},e=>{if(live){setPublications(null);setError(failed(e));}});
    loadFamilies(s).then(f=>{if(live)setFamilies(f);},()=>{if(live)setFamilies(null);});
    return()=>{live=false;};},[shell?.organizationId,shell?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps
  function show(t:DocumentTemplateRecord|null){setSelected(t);setTitle(t?.title??'');setContent(t?.content??'');setAudience(t?.audience??'STAFF');setFamily(t?.familyId??'');setReviewed(false);}
  async function run(work:(s:{organizationId:string;schoolId:string})=>Promise<void>){
    if(busy)return;setError('');setNotice('');if(!scope){setError('Enter the organization and school first.');return;}
    setBusy(true);try{await work(scope);}catch(e){setError(failed(e));}finally{setBusy(false);}
  }
  const refresh=()=>run(async s=>{setPublications(await loadPublications(s));});
  const open=(id:string)=>run(async s=>{show(await loadTemplate(s,id));});
  function save(e:FormEvent<HTMLFormElement>){e.preventDefault();void run(async s=>{
    if(!selected&&audience==='PARENT'&&!isDocumentId(family))throw new Error('Choose the family this document is for.');
    const base=documentBase(s);const url=selected?`${base}/templates/${selected.id}/versions`:`${base}/templates`;
    const body=selected?{title,content,expectedVersion:selected.version}:{title,content,audience,...(audience==='PARENT'?{familyId:family.toLowerCase()}:{})};
    const r=await request(url,body,retryKey(last,url,body));const t=template(r.data);show(t);
    setNotice(r.meta?.replayed?'This was already saved.':`Saved as version ${t.versionNumber}. Publish it when it's ready.`);
  });}
  function publish(){if(!selected||!reviewed)return;const t=selected;void run(async s=>{
    const url=`${documentBase(s)}/templates/${t.id}/publish`,body={versionId:t.latestVersionId,expectedVersion:t.version};
    const r=await request(url,body,retryKey(last,url,body));show(template(r.data));setNotice(r.meta?.replayed?'This was already published.':`Version ${t.versionNumber} is published.`);
    try{setPublications(await loadPublications(s));}catch{setPublications(null);}
  });}
  const live=selected?publications?.find(p=>p.templateId===selected.id):undefined;
  const latestLive=!!selected&&live?.versionId===selected.latestVersionId;
  const familyName=(id:string|null)=>families?.find(f=>f.id===id)?.displayName;
  return <main className={styles.page}><nav><a href="/staff/dashboard">School dashboard</a></nav><header><p>Staff</p><h1>Documents</h1><p>Write a document for staff or a family and publish it. Acknowledge documents published to you.</p></header>
    <aside data-plain-note=""><strong>An acknowledgement is a record, not a legal e-signature. Nothing is sent automatically.</strong></aside>
    {!shell&&<fieldset disabled={busy}><legend>School</legend><ManualSchoolFields current={school}><label>Organization UUID<input required value={org} onChange={e=>setOrg(e.target.value)}/></label><label>School UUID<input required value={school} onChange={e=>setSchool(e.target.value)}/></label></ManualSchoolFields></fieldset>}
    {error&&<p role="alert" className={styles.error}>{error}</p>}{notice&&<p role="status">{notice}</p>}
    <section><h2>Published documents</h2><button type="button" disabled={busy} onClick={()=>void refresh()}>Refresh</button>
      {publications?.length===0&&<p>Nothing is published yet.</p>}
      <ul>{publications?.map(p=><li key={p.id}><button type="button" disabled={busy} onClick={()=>void open(p.templateId)}>{p.title} · {audienceLabel(p.audience)} · version {p.versionNumber} · published {day(p.publishedAt)}</button></li>)}</ul>
      <IdFields manual={!shell}><form onSubmit={e=>{e.preventDefault();void open(openId);}}><label>Document record ID<input value={openId} onChange={e=>setOpenId(e.target.value)}/></label><button type="submit" disabled={busy||!isDocumentId(openId)}>Open document</button></form></IdFields>
    </section>
    <section><h2>{selected?`Edit: ${selected.title}`:'Write a new document'}</h2>
      {selected&&<p>{audienceLabel(selected.audience)}{selected.audience==='PARENT'&&familyName(selected.familyId)?` (${familyName(selected.familyId)})`:''} · latest version {selected.versionNumber}{latestLive?' is published':live?` · version ${live.versionNumber} is published`:' · not published yet'}. <button type="button" disabled={busy} onClick={()=>show(null)}>Write a new document instead</button></p>}
      <form onSubmit={save}><fieldset disabled={busy}>
      {!selected&&<><label>Who it's for<select value={audience} onChange={e=>setAudience(e.target.value)}><option value="STAFF">Staff</option><option value="PARENT">One family</option></select></label>
        {audience==='PARENT'&&<>{families&&<label>Family<select required value={family} onChange={e=>setFamily(e.target.value)}><option value="">Choose a family</option>{families.map(f=><option key={f.id} value={f.id}>{f.displayName}</option>)}</select></label>}
          <IdFields manual={!families}><label>Family record ID<input required={!families} value={family} onChange={e=>setFamily(e.target.value)}/></label></IdFields>
          <small>A family document can't be moved to another family later.</small></>}</>}
      <label>Title<input required maxLength={200} value={title} onChange={e=>setTitle(e.target.value)}/></label><label>Text<textarea required rows={10} maxLength={100000} value={content} onChange={e=>setContent(e.target.value)}/><small>Plain text. Saving a change makes a new version; people keep seeing the published version until you publish the new one.</small></label>
      <button type="submit">{busy?'Saving…':selected?'Save as a new version':'Save draft'}</button></fieldset></form>
      {selected&&!latestLive&&<div><label className={styles.check}><input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)}/>I've read version {selected.versionNumber} and want to publish it {selected.audience==='PARENT'?'to this family':'to staff'}.</label><button type="button" disabled={busy||!reviewed} onClick={publish}>Publish version {selected.versionNumber}</button></div>}
    </section>
    <DocumentAcknowledgementDesk embedded publications={publications??undefined} scope={scope}/>
  </main>;
}
type Publication={id:string;title:string;content:string;contentHash:string;versionNumber:number;current:boolean};
/** Staff pass the shell school and the published list, so a document is picked by title; parents keep their own reads. */
export function DocumentAcknowledgementDesk({parent=false,embedded=false,publications,scope}:{parent?:boolean;embedded?:boolean;publications?:readonly DocumentPublicationRecord[]|undefined;scope?:{organizationId:string;schoolId:string}|null}):React.ReactElement {
  const [ownOrg,setOrg]=useState(''),[ownSchool,setSchool]=useState(''),[id,setId]=useState(''),[doc,setDoc]=useState<Publication|null>(null);
  const [base,setBase]=useState(''),[checked,setChecked]=useState(false),[attestation,setAttestation]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[receipt,setReceipt]=useState('');
  const last=useRef<{fingerprint:string;key:string}|null>(null);
  const staffScope=!parent&&scope?scope:null;
  const org=staffScope?.organizationId??ownOrg,school=staffScope?.schoolId??ownSchool;
  const choices=!parent&&publications?publications.filter(p=>p.current):null;
  function reset(){setDoc(null);setChecked(false);setReceipt('');setError('');}
  async function load(e:FormEvent<HTMLFormElement>){e.preventDefault();reset();if(!UUID.test(school)||!UUID.test(id)||(!parent&&!UUID.test(org))){setError(choices?'Choose a document first.':'Enter valid known school and publication UUIDs.');return;}
    const b=parent?`/api/v1/parent/schools/${school}/documents`:`/api/v1/organizations/${org}/schools/${school}/documents`;setBusy(true);
    try{const r=await request(`${b}/publications/${id}`);const d=r.data as Publication;if(!d.current||d.id!==id||typeof d.content!=='string'||!/^[a-f0-9]{64}$/.test(d.contentHash))throw new Error('A newer version of this document is published. Refresh and open it again.');setBase(b);setDoc(d);}catch(e){setError(failed(e));}finally{setBusy(false);}}
  async function acknowledge(e:FormEvent<HTMLFormElement>){e.preventDefault();if(!doc||!checked||busy)return;setBusy(true);setError('');
    const url=`${base}/publications/${doc.id}/acknowledgements`,body={contentHash:doc.contentHash,choice:'ACKNOWLEDGE',...(attestation?{attestationText:attestation}:{})};
    try{const r=await request(url,body,retryKey(last,url,body));const at=(r.data as {acknowledgedAt?:unknown})?.acknowledgedAt;setReceipt(`${r.meta?.replayed?'You already acknowledged this version':'Acknowledged'}${typeof at==='string'&&Number.isFinite(Date.parse(at))?` on ${day(at)}`:''}. Your receipt is saved.`);}catch(e){setError(failed(e));}finally{setBusy(false);}}
  const contents=<><header><p>Documents</p><h1>{parent?'Your published documents.':'Acknowledge a document'}</h1><p>{parent?'Read the currently published content, then make an explicit choice. This is internal immutable evidence, not legal signature verification.':'Read a published document, then confirm you have read it.'}</p></header>
    {parent&&<aside>School access and family audience are resolved from your verified human session. No family, person or signer identifiers are accepted. Only your own receipt is returned.</aside>}
    <form onSubmit={load}><fieldset disabled={busy}><legend>{parent?'Read authorized publication':'Choose a document'}</legend>
      {!parent&&!staffScope&&<ManualSchoolFields current={school}><label>Organization UUID<input required value={org} onChange={e=>{setOrg(e.target.value);reset();}}/></label></ManualSchoolFields>}
      {!staffScope&&<ManualSchoolFields current={school}><label>School UUID<input required value={school} onChange={e=>{setSchool(e.target.value);reset();}}/></label></ManualSchoolFields>}
      {choices&&<label>Document<select value={choices.some(p=>p.id===id)?id:''} onChange={e=>{setId(e.target.value);reset();}}><option value="">Choose a document</option>{choices.map(p=><option key={p.id} value={p.id}>{p.title} · version {p.versionNumber}</option>)}</select></label>}
      {parent?<label>Publication UUID<input required value={id} onChange={e=>{setId(e.target.value);reset();}}/></label>:<IdFields manual={!choices}><label>Publication record ID<input required={!choices} value={id} onChange={e=>{setId(e.target.value);reset();}}/></label></IdFields>}
      <button type="submit">{busy?'Loading…':parent?'Read current publication':'Read document'}</button></fieldset></form>
    {doc&&<section className={styles.document}><h2>{doc.title}</h2><p>Version {doc.versionNumber}</p><pre>{doc.content}</pre><form onSubmit={acknowledge}><fieldset disabled={busy}><legend>{parent?'Your explicit acknowledgement':'Confirm you have read it'}</legend><label className={styles.check}><input type="checkbox" required checked={checked} onChange={e=>setChecked(e.target.checked)}/>I acknowledge that I have read this published version.</label><label>Optional note (500 characters maximum)<textarea maxLength={500} rows={3} value={attestation} onChange={e=>setAttestation(e.target.value)}/></label><button type="submit" disabled={!checked||busy}>{busy?'Saving…':'Acknowledge'}</button></fieldset></form></section>}
    {error&&<p role="alert" className={styles.error}>{error}</p>}{receipt&&<p role="status" className={styles.result}>{receipt}</p>}
  </>;
  return embedded?<section>{contents}</section>:<main className={styles.page}><nav><a href={parent?'/parent':'/staff/dashboard'}>Return to HON</a></nav>{contents}</main>;
}
