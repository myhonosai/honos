'use client';
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { OwnerLaunchProjection, OwnerLaunchFirstClassBookingContext, OwnerLaunchMembershipDraftConfirmationReceipt } from '@hon/contracts';
import { DEFAULT_HON_INTERFACE_THEME, type HonInterfaceTheme } from '@hon/design-system';
import { OwnerLaunchAccessError, postOwnerLaunch, postOwnerLaunchFirstClassBooking, postOwnerLaunchMembershipDraft, loadOwnerLaunchWithConfirmations } from './owner-launch-http';
import { InterfaceThemePicker } from './interface-theme-picker';
import { loadInterfaceThemePreference, saveInterfaceThemePreference } from './interface-theme-preference';
import progressStyles from './owner-launch-progress.module.css';

export function ownerDashboardHandoffPath(context: Pick<OwnerLaunchProjection, 'organizationId' | 'schoolId'>): string {
  return `/staff/dashboard?${new URLSearchParams({ organizationId: context.organizationId, schoolId: context.schoolId }).toString()}`;
}

type OwnerLaunchProgressState = 'RECORDED' | 'NOT_RECORDED' | 'UNAVAILABLE';

export function OwnerLaunchProgress({
  context,
  booking,
  bookingState,
  draftState,
}: {
  context: OwnerLaunchProjection;
  booking: OwnerLaunchFirstClassBookingContext | null;
  bookingState: 'NO_RECORDED_BOOKING'|'RECORDED_BOOKING'|'BOOKING_UNAVAILABLE';
  draftState: 'NO_RECORDED_DRAFT'|'RECORDED_DRAFT'|'DRAFT_UNAVAILABLE';
}): React.ReactElement {
  const saved = context.guardianChildRegistration ?? context.registration;
  const steps: Array<{ title: string; state: OwnerLaunchProgressState; detail: string }> = [
    { title: 'Verified school context', state: 'RECORDED', detail: `${context.schoolName} · current ${context.tier} context` },
    { title: 'First program', state: context.program ? 'RECORDED' : 'NOT_RECORDED', detail: context.program ? `${context.program.status} receipt recorded` : 'No first-program receipt is recorded.' },
    { title: 'First class', state: context.classSession ? 'RECORDED' : 'NOT_RECORDED', detail: context.classSession ? `${context.classSession.status} receipt recorded` : 'No first-class receipt is recorded.' },
    { title: 'Student registration', state: saved ? 'RECORDED' : 'NOT_RECORDED', detail: saved ? 'Registered — no booking' : 'No saved registration receipt is recorded.' },
    { title: 'First class booking', state: !saved ? 'NOT_RECORDED' : bookingState === 'RECORDED_BOOKING' && booking ? 'RECORDED' : bookingState === 'NO_RECORDED_BOOKING' ? 'NOT_RECORDED' : 'UNAVAILABLE', detail: !saved ? 'Available only after a saved registration.' : bookingState === 'RECORDED_BOOKING' && booking ? `${booking.booking.status} booking confirmation recorded` : bookingState === 'NO_RECORDED_BOOKING' ? 'No receipt-linked booking is recorded.' : 'Current booking confirmation is unavailable.' },
    { title: 'Membership DRAFT', state: !saved ? 'NOT_RECORDED' : draftState === 'RECORDED_DRAFT' ? 'RECORDED' : draftState === 'NO_RECORDED_DRAFT' ? 'NOT_RECORDED' : 'UNAVAILABLE', detail: !saved ? 'Available only after a saved registration.' : draftState === 'RECORDED_DRAFT' ? 'DRAFT only — not active' : draftState === 'NO_RECORDED_DRAFT' ? 'No receipt-linked membership DRAFT is recorded.' : 'Current DRAFT confirmation is unavailable.' },
  ];
  return <section className={progressStyles.progress} aria-labelledby="owner-launch-progress-title" aria-describedby="owner-launch-progress-description">
    <p className={progressStyles.eyebrow}>SETUP PROGRESS / RECEIPT-BACKED</p>
    <h2 id="owner-launch-progress-title">Your verified setup progress</h2>
    <p id="owner-launch-progress-description" className={progressStyles.description}>Each tile is a narrow verified context or saved receipt. It is not a school-readiness score and does not claim activation, payment, attendance, eligibility, parent access, communication, or additional authority.</p>
    <dl className={progressStyles.steps}>{steps.map((step) => <div key={step.title} className={`${progressStyles.step} ${step.state === 'RECORDED' ? progressStyles.recorded : step.state === 'UNAVAILABLE' ? progressStyles.unavailable : progressStyles.notRecorded}`}><dt>{step.title}</dt><dd><strong>{step.state === 'RECORDED' ? 'Recorded' : step.state === 'UNAVAILABLE' ? 'Unavailable' : 'Not recorded'}</strong><span>{step.detail}</span></dd></div>)}</dl>
  </section>;
}

export function OwnerLaunch() {
  const [context,setContext]=useState<OwnerLaunchProjection|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('Load your verified school context to begin. HQ provisioning is separate.');
  const [programName,setProgramName]=useState(''),[className,setClassName]=useState(''),[startsAt,setStartsAt]=useState(''),[endsAt,setEndsAt]=useState(''),[capacity,setCapacity]=useState(10);
  const [mode,setMode]=useState<'adult'|'guardian-child'>('adult');
  const [givenName,setGivenName]=useState(''),[familyName,setFamilyName]=useState(''),[birthDate,setBirthDate]=useState(''),[attested,setAttested]=useState(false);
  const [guardianGivenName,setGuardianGivenName]=useState(''),[guardianFamilyName,setGuardianFamilyName]=useState(''),[guardianBirthDate,setGuardianBirthDate]=useState('');
  const [booking,setBooking]=useState<OwnerLaunchFirstClassBookingContext|null>(null);
  const [bookingState,setBookingState]=useState<'NO_RECORDED_BOOKING'|'RECORDED_BOOKING'|'BOOKING_UNAVAILABLE'>('BOOKING_UNAVAILABLE');
  const [membershipDraft,setMembershipDraft]=useState<OwnerLaunchMembershipDraftConfirmationReceipt|null>(null);
  const [draftState,setDraftState]=useState<'NO_RECORDED_DRAFT'|'RECORDED_DRAFT'|'DRAFT_UNAVAILABLE'>('DRAFT_UNAVAILABLE');
  const [planCode,setPlanCode]=useState(''),[termStart,setTermStart]=useState(''),[termEnd,setTermEnd]=useState(''),[currency,setCurrency]=useState('');
  const [interfaceTheme,setInterfaceTheme]=useState<HonInterfaceTheme>(DEFAULT_HON_INTERFACE_THEME);
  const [interfaceThemeState,setInterfaceThemeState]=useState<'UNAVAILABLE'|'LOADING'|'READY'|'SAVING'|'ERROR'>('UNAVAILABLE');
  const [interfaceThemeMessage,setInterfaceThemeMessage]=useState('Load verified school context to view or change your personal interface preference.');
  const generation=useRef(0);
  const interfaceThemeGeneration=useRef(0);
  const retry=useRef<{operation:string;fingerprint:string;key:string}|null>(null);
  function clearPrivateInput() {setGivenName('');setFamilyName('');setBirthDate('');setGuardianGivenName('');setGuardianFamilyName('');setGuardianBirthDate('');setAttested(false);setPlanCode('');setTermStart('');setTermEnd('');setCurrency('');setMembershipDraft(null);setDraftState('DRAFT_UNAVAILABLE');retry.current=null;}
  useEffect(()=>{
    const stale=()=>{generation.current++;setContext(null);setBooking(null);setBookingState('BOOKING_UNAVAILABLE');setMembershipDraft(null);setBusy(false);setMessage('School state may have changed. Reload saved receipts before continuing.');clearPrivateInput();};
    window.addEventListener('focus',stale);document.addEventListener('visibilitychange',stale);
    return ()=>{generation.current++;window.removeEventListener('focus',stale);document.removeEventListener('visibilitychange',stale);};
  },[]);
  useEffect(()=>{
    const organizationId=context?.organizationId,schoolId=context?.schoolId;
    if(!organizationId||!schoolId){interfaceThemeGeneration.current++;setInterfaceTheme(DEFAULT_HON_INTERFACE_THEME);setInterfaceThemeState('UNAVAILABLE');setInterfaceThemeMessage('Load verified school context to view or change your personal interface preference.');return;}
    const current=++interfaceThemeGeneration.current;
    setInterfaceTheme(DEFAULT_HON_INTERFACE_THEME);setInterfaceThemeState('LOADING');setInterfaceThemeMessage('Loading your personal presentation preference…');
    void loadInterfaceThemePreference({organizationId,schoolId}).then(preference=>{
      if(current!==interfaceThemeGeneration.current)return;
      setInterfaceTheme(preference.interfaceTheme);setInterfaceThemeState('READY');setInterfaceThemeMessage(preference.selectedVia==='DEFAULT'?'Modern HON is the default presentation. Choosing another mode is optional and can be changed later.':'Saved for your current user only. You can change this presentation preference later.');
    }).catch(error=>{
      if(current!==interfaceThemeGeneration.current)return;
      setInterfaceThemeState('ERROR');setInterfaceThemeMessage(error instanceof Error?error.message:'The interface preference is unavailable. No presentation change is assumed.');
    });
    return ()=>{if(current===interfaceThemeGeneration.current)interfaceThemeGeneration.current++;};
  },[context?.organizationId,context?.schoolId]);
  async function reload() {const current=++generation.current;setBusy(true);setContext(null);setBooking(null);setBookingState('BOOKING_UNAVAILABLE');setMembershipDraft(null);setDraftState('DRAFT_UNAVAILABLE');try {const loaded=await loadOwnerLaunchWithConfirmations();if(current!==generation.current)return;setContext(loaded.context);setBooking(loaded.bookingConfirmation.context);setBookingState(loaded.bookingConfirmation.state);setMembershipDraft(loaded.confirmation.receipt);setDraftState(loaded.confirmation.state);setMessage('Saved creation receipts loaded. Membership confirmation is DRAFT only: saved configuration, NOT active or an agreement/payment/invoice/schedule/communication outcome.');}catch(error){if(current!==generation.current)return;setMessage(error instanceof Error?error.message:'School launch is unavailable.');if(error instanceof OwnerLaunchAccessError&&[401,403].includes(error.status))clearPrivateInput();}finally{if(current===generation.current)setBusy(false);}}
  async function chooseInterfaceTheme(next:HonInterfaceTheme) {
    if(!context||interfaceThemeState!=='READY')return;
    const current=++interfaceThemeGeneration.current;
    setInterfaceThemeState('SAVING');setInterfaceThemeMessage('Saving your personal presentation preference…');
    try {
      const preference=await saveInterfaceThemePreference({organizationId:context.organizationId,schoolId:context.schoolId},next,crypto.randomUUID());
      if(current!==interfaceThemeGeneration.current)return;
      setInterfaceTheme(preference.interfaceTheme);setInterfaceThemeState('READY');setInterfaceThemeMessage('Saved for your current user only. You can change this presentation preference later.');
    } catch(error) {
      if(current!==interfaceThemeGeneration.current)return;
      setInterfaceThemeState('ERROR');setInterfaceThemeMessage(error instanceof Error?error.message:'The interface preference is unavailable. No presentation change is assumed.');
    }
  }
  async function submit(operation:'program'|'class'|'student') {
    if (!context || busy) return;
    const current=++generation.current;
    const fixedOperation=operation==='student'&&mode==='guardian-child'?'guardian-child':operation;
    let input:unknown;
    try {
      if(operation==='program')input={name:programName.trim()};
      else if(operation==='class')input={programId:context.program?.id,name:className.trim(),startsAt:new Date(startsAt).toISOString(),endsAt:new Date(endsAt).toISOString(),capacity,bookingPolicy:'OPTIONAL_BOOKING'};
      else {
        if(!attested || !context.program || !context.classSession)throw new Error('Explicit new-person attestation and saved program/class receipts are required.');
        const target={programId:context.program.id,expectedProgramVersion:context.program.version,classSessionId:context.classSession.id,expectedClassSessionVersion:context.classSession.version};
        input=mode==='adult'?{...target,givenName:givenName.trim(),familyName:familyName.trim(),birthDate,attestation:'NEW_ADULT_NO_GUARDIAN_REQUIRED'}:{...target,guardianGivenName:guardianGivenName.trim(),guardianFamilyName:guardianFamilyName.trim(),guardianBirthDate,childGivenName:givenName.trim(),childFamilyName:familyName.trim(),childBirthDate:birthDate,attestation:'NEW_CHILD_WITH_NEW_GUARDIAN'};
      }
      const fingerprint=JSON.stringify(input);
      if(!retry.current || retry.current.operation!==fixedOperation || retry.current.fingerprint!==fingerprint)retry.current={operation:fixedOperation,fingerprint,key:crypto.randomUUID()};
      setBusy(true);setContext(null);setBooking(null);setBookingState('BOOKING_UNAVAILABLE');setMembershipDraft(null);setDraftState('DRAFT_UNAVAILABLE');
      await postOwnerLaunch(context,fixedOperation,input,retry.current.key);
      if(current!==generation.current)return;
      if(operation==='student')clearPrivateInput();
      const loaded=await loadOwnerLaunchWithConfirmations();if(current!==generation.current)return;setContext(loaded.context);setBooking(loaded.bookingConfirmation.context);setBookingState(loaded.bookingConfirmation.state);setMembershipDraft(loaded.confirmation.receipt);setDraftState(loaded.confirmation.state);setMessage('Saved receipt verified. No booking, attendance, membership, billing, parent login, parent access or message was created.');
    }catch(error){if(current!==generation.current)return;setContext(null);setMessage(error instanceof Error?error.message:'Outcome unavailable. Reload saved receipts before trying again.');if(error instanceof OwnerLaunchAccessError&&[401,403].includes(error.status))clearPrivateInput();}finally{if(current===generation.current)setBusy(false);}
  }
  async function bookFirstClass() {
    const saved=context?.guardianChildRegistration??context?.registration;
    if(!context || !saved || !context.classSession || busy) return;
    const current=++generation.current;
    const input={registrationId:saved.registrationId,expectedReceiptVersion:1 as const,expectedClassSessionVersion:context.classSession.version};
    const fingerprint=JSON.stringify(input);
    if(!retry.current || retry.current.operation!=='first-class-booking' || retry.current.fingerprint!==fingerprint)retry.current={operation:'first-class-booking',fingerprint,key:crypto.randomUUID()};
    try {
      setBusy(true);setBooking(null);setBookingState('BOOKING_UNAVAILABLE');
      const receipt=await postOwnerLaunchFirstClassBooking(context,input,retry.current.key);
      if(current!==generation.current)return;
      // POST is historical evidence; only the selector-free current GET can populate the card.
      const loaded=await loadOwnerLaunchWithConfirmations();
      if(current!==generation.current)return;
      if(loaded.bookingConfirmation.context && loaded.bookingConfirmation.context.booking.id!==receipt.bookingId)throw new Error('Booking confirmation changed. Needs staff; no current booking success is assumed.');
      setContext(loaded.context);setBooking(loaded.bookingConfirmation.context);setBookingState(loaded.bookingConfirmation.state);setMembershipDraft(loaded.confirmation.receipt);setDraftState(loaded.confirmation.state);
      setMessage(loaded.bookingConfirmation.state!=='RECORDED_BOOKING'?'Current booking confirmation unavailable. No booking success is assumed.':receipt.status==='BOOKED'?'First-class booking recorded as BOOKED. This is not membership, payment, attendance, eligibility, parent contact or family readiness.':'First-class booking recorded as WAITLISTED. No seat, membership, payment, attendance, eligibility, parent contact or family readiness is claimed.');
    } catch(error) {
      if(current!==generation.current)return;
      setBooking(null);setBookingState('BOOKING_UNAVAILABLE');
      setMessage(error instanceof Error?error.message:'Booking outcome is unavailable. Reload the saved receipt or retry the exact same request and key.');
      if(error instanceof OwnerLaunchAccessError&&[401,403].includes(error.status)){setContext(null);setBooking(null);setBookingState('BOOKING_UNAVAILABLE');clearPrivateInput();}
    } finally {if(current===generation.current)setBusy(false);}
  }
  async function draftMembership() {
    const saved=context?.guardianChildRegistration??context?.registration;
    if(!context || !saved || busy) return;
    const current=++generation.current;
    try {
      const input={registrationId:saved.registrationId,expectedReceiptVersion:1 as const,planCode,termStartedAt:new Date(termStart).toISOString(),termEndsAt:new Date(termEnd).toISOString(),currency};
      const fingerprint=JSON.stringify(input);
      if(!retry.current || retry.current.operation!=='membership-draft' || retry.current.fingerprint!==fingerprint)retry.current={operation:'membership-draft',fingerprint,key:crypto.randomUUID()};
      setBusy(true);setBooking(null);setBookingState('BOOKING_UNAVAILABLE');setMembershipDraft(null);setDraftState('DRAFT_UNAVAILABLE');
      const receipt=await postOwnerLaunchMembershipDraft(context,input,retry.current.key);
      if(current!==generation.current)return;
      // POST is historical creation evidence; display only a fresh current GET confirmation.
      const loaded=await loadOwnerLaunchWithConfirmations();
      if(current!==generation.current)return;
      if(loaded.confirmation.receipt && loaded.confirmation.receipt.membershipId!==receipt.membershipId)throw new Error('DRAFT confirmation changed. Needs staff; no success is assumed.');
      setContext(loaded.context);setBooking(loaded.bookingConfirmation.context);setBookingState(loaded.bookingConfirmation.state);setMembershipDraft(loaded.confirmation.receipt);setDraftState(loaded.confirmation.state);
      setMessage(loaded.confirmation.state==='RECORDED_DRAFT'?'DRAFT only: saved membership configuration, NOT active. No agreement, payment, invoice, schedule or communication is authorized.':'Current DRAFT confirmation unavailable. No saved membership or activation success is claimed.');
    } catch(error) {
      if(current!==generation.current)return;
      setBooking(null);setBookingState('BOOKING_UNAVAILABLE');
      setMessage(error instanceof Error?error.message:'DRAFT outcome unavailable. Retry the exact same input and key; do not assume success.');
      if(error instanceof OwnerLaunchAccessError&&[401,403].includes(error.status)){setContext(null);setBooking(null);setBookingState('BOOKING_UNAVAILABLE');clearPrivateInput();}
    } finally {if(current===generation.current)setBusy(false);}
  }
  const field={display:'grid',gap:6,marginBottom:12} as const;
  const saved=context?.guardianChildRegistration??context?.registration;
  return <main className={`owner-launch owner-launch-${interfaceTheme}`} data-interface-theme={interfaceTheme} style={{maxWidth:840,margin:'2rem auto',padding:24}}>
    <h1>Owner launch</h1><p>School context → first program → first class → student registration → saved receipt</p>
    <p>Conventional human setup only. No directory search or cross-school selection. HQ provisioning and owner grants remain a separate controlled workflow.</p>
    <p>Choose a new adult without a guardian, or exactly one new child with one new adult guardian. A recorded family relationship is not parent login, parent access or family readiness.</p>
    <section className="owner-launch-theme" aria-labelledby="owner-launch-interface-mode"><div><p className="owner-launch-theme-kicker">OPTIONAL PRESENTATION</p><h2 id="owner-launch-interface-mode">Choose your interface mode</h2><p>Big-Button / Phone favors large touch targets, Modern HON balances daily work, and Classic CRM favors dense keyboard-and-mouse controls.</p><p>This is a current-user presentation preference only. You can change it later; it never changes your school scope, tier, role, features, permissions, authority, data, or available launch actions.</p></div><InterfaceThemePicker current={interfaceTheme} onChange={theme=>void chooseInterfaceTheme(theme)} disabled={interfaceThemeState!=='READY'} busy={interfaceThemeState==='LOADING'||interfaceThemeState==='SAVING'} presentation="cards" ariaLabel="Optional interface mode for this owner launch" /><p className="owner-launch-theme-status" role="status" aria-live="polite">{interfaceThemeMessage}</p></section>
    <p role="status" aria-live="polite">{message}</p><button type="button" disabled={busy} onClick={()=>void reload()}>{busy?'Verifying…':'Load / refresh saved receipts'}</button>
    {context&&<>
      <OwnerLaunchProgress context={context} booking={booking} bookingState={bookingState} draftState={draftState} />
      <section aria-label="Verified school context"><h2>1. Verified school context</h2><p>{context.schoolName} · {context.tier}</p><p>School receipt context: <code>{context.schoolId}</code></p><p><Link href={ownerDashboardHandoffPath(context)}>Open verified operations dashboard</Link> — this only pre-fills school identifiers. The dashboard remains empty until it independently verifies current access and loads its report.</p></section>
      <section><h2>2. First program</h2>{context.program?<p>Saved program receipt: <code>{context.program.id}</code> · {context.program.status} · version {context.program.version}</p>:<form onSubmit={e=>{e.preventDefault();void submit('program');}}><label style={field}>Program name<input value={programName} onChange={e=>setProgramName(e.target.value)} maxLength={160} required /></label><button disabled={busy}>Save first program</button></form>}</section>
      <section><h2>3. First class</h2>{context.classSession?<p>Saved class receipt: <code>{context.classSession.id}</code> · {context.classSession.status} · version {context.classSession.version}</p>:context.program?<form onSubmit={e=>{e.preventDefault();void submit('class');}}><label style={field}>Class name<input value={className} onChange={e=>setClassName(e.target.value)} maxLength={160} required /></label><label style={field}>Starts (your local time)<input type="datetime-local" value={startsAt} onChange={e=>setStartsAt(e.target.value)} required /></label><label style={field}>Ends (your local time)<input type="datetime-local" value={endsAt} onChange={e=>setEndsAt(e.target.value)} required /></label><label style={field}>Capacity<input type="number" min={1} max={1000} value={capacity} onChange={e=>setCapacity(Number(e.target.value))} required /></label><p>Optional booking policy. This step saves a class; it does not book a student.</p><button disabled={busy}>Save first class</button></form>:<p>Save a program first.</p>}</section>
      <section><h2>4. Register a real student</h2><p>The adult-only command is unchanged. The separate guardian-and-child command requires current family.manage authority, a guardian adult and child under 18 at the exact future class date. Existing or potentially matching people, families and uncertain eligibility need staff; no identity is merged or inferred.</p><p>Registration creates only existing person/student records and program-only enrollment. Child mode also records one new family with explicit GUARDIAN and STUDENT links. No curriculum/rank, billing contact or parent access is inferred.</p>
        {saved?<p>Registration already saved in this flow. No additional registration action is shown.</p>:context.program&&context.classSession?<form onSubmit={e=>{e.preventDefault();void submit('student');}}>
          <fieldset disabled={busy}><legend>Registration mode</legend><label><input type="radio" name="registration-mode" checked={mode==='adult'} onChange={()=>{clearPrivateInput();setMode('adult');}} /> New adult — no guardian</label><label><input type="radio" name="registration-mode" checked={mode==='guardian-child'} onChange={()=>{clearPrivateInput();setMode('guardian-child');}} /> One new child with one new guardian</label></fieldset>
          {mode==='guardian-child'&&<fieldset><legend>New adult guardian</legend><label style={field}>Guardian given name<input autoComplete="off" value={guardianGivenName} onChange={e=>setGuardianGivenName(e.target.value)} maxLength={100} required /></label><label style={field}>Guardian family name<input autoComplete="off" value={guardianFamilyName} onChange={e=>setGuardianFamilyName(e.target.value)} maxLength={100} required /></label><label style={field}>Guardian birth date<input type="date" value={guardianBirthDate} onChange={e=>setGuardianBirthDate(e.target.value)} required /></label></fieldset>}
          <label style={field}>{mode==='adult'?'Student':'Child'} given name<input autoComplete="off" value={givenName} onChange={e=>setGivenName(e.target.value)} maxLength={100} required /></label><label style={field}>{mode==='adult'?'Student':'Child'} family name<input autoComplete="off" value={familyName} onChange={e=>setFamilyName(e.target.value)} maxLength={100} required /></label><label style={field}>{mode==='adult'?'Birth date':'Child birth date'}<input type="date" value={birthDate} onChange={e=>setBirthDate(e.target.value)} required /></label>
          <label style={field}><span><input type="checkbox" checked={attested} onChange={e=>setAttested(e.target.checked)} required /> {mode==='adult'?'I verified this is a new adult student and no guardian relationship is required.':'I verified exactly one new child and one different new adult guardian, their ages and explicit guardian/child relationship: NEW_CHILD_WITH_NEW_GUARDIAN.'}</span></label><button disabled={busy||!attested}>{mode==='adult'?'Save bounded student registration':'Save guardian-and-child registration'}</button>
        </form>:<p>Save a class first. Registration authority is rechecked at the server.</p>}</section>
      <section><h2>5. Saved receipt</h2>{saved?<><p><strong>REGISTERED — NO BOOKING</strong></p>{context.guardianChildRegistration&&<p>One new guardian/child relationship recorded. Not family readiness, parent login, parent access, membership, payment, attendance or communication.</p>}<p>Receipt: <code>{saved.registrationId}</code></p><p>Student: <code>{saved.studentProfileId}</code></p><p>Program enrollment: <code>{saved.enrollmentId}</code> — program-only, not membership or class booking.</p><p>Saved at {saved.createdAt}</p></>:<p>No saved student registration receipt yet. An unavailable result is never success.</p>}</section>
      <section><h2>6. Book first class</h2>{saved&&context.classSession?<><p>Human-only exact saved-receipt action. It uses no student, family, program, class or school selector; the current server rechecks receipt relation, authority, tier, versions and canonical capacity.</p>{context.guardianChildRegistration&&<p>For a guardian-and-child receipt, this is a class booking decision only. It does not create parent login, parent access, family readiness, parent contact, membership, payment, attendance or eligibility success.</p>}{booking?<section aria-label="Saved student's first-class booking" className="owner-launch-booking-card"><h3>{booking.student.displayName}</h3><p>Saved student: <code>{booking.student.studentProfileId}</code></p><p><strong>{booking.classSession.name}</strong> · class status: {booking.classSession.status}</p><p>{booking.classSession.startsAt} to {booking.classSession.endsAt}</p><p>Capacity: {booking.classSession.capacity} · booking policy: {booking.classSession.bookingPolicy}</p><p><strong>{booking.booking.status}</strong> · {booking.booking.bookingKind} booking · version {booking.booking.version}</p><p>Booking: <code>{booking.booking.id}</code> · class: <code>{booking.classSession.id}</code> · registration: <code>{booking.registrationId}</code></p><p>Recorded at {booking.booking.recordedAt}</p>{booking.classSession.status==='CANCELLED'&&<p>Class cancelled. The saved booking is not a seat or attendance claim.</p>}<p>Booking is not attendance, membership, payment, eligibility, parent access or communication.</p></section>:bookingState==='BOOKING_UNAVAILABLE'?<p>BOOKING_UNAVAILABLE — current booking confirmation unavailable. No booking success is assumed; reload or ask staff. No roster, search or selector is available.</p>:<><p>NO_RECORDED_BOOKING — no current receipt-linked booking is recorded. Registration alone does not book a class. A full class may return WAITLISTED; an unavailable result is not booking success.</p><button type="button" disabled={busy} onClick={()=>void bookFirstClass()}>{busy?'Verifying booking…':'Book first class'}</button></>}</>:<p>Save one registration receipt first. No booking action is available otherwise.</p>}</section>
      {saved&&<section aria-label="Receipt-bound membership draft"><h2>7. Optional fixed-term membership DRAFT</h2>
        <p>DRAFT only. No payment schedule, payment method, processor, payment, activation, invoice or communication. Activation remains a separate conventional human workflow and is not available here.</p>
        <p>The saved receipt determines payer and participant: adult student for both, or recorded guardian as payer and child as participant. No person, account, family or school selector is available. One same-currency account is reused or, only if none exists, one is created; ambiguity needs staff.</p>
        {membershipDraft?<><p><strong>DRAFT only — saved membership configuration, NOT active</strong></p><p>This is not a financial agreement, signature or consent. No payment, invoice, schedule, communication, attendance or parent login is authorized by this confirmation.</p><p>Membership: <code>{membershipDraft.membershipId}</code> · version {membershipDraft.membershipVersion}</p><p>Declared code: {membershipDraft.planCode} · {membershipDraft.currency} · {membershipDraft.termStartedAt} to {membershipDraft.termEndsAt}</p><p>Recorded at {membershipDraft.recordedAt}. No price or auto-renewal is inferred.</p></>:draftState==='DRAFT_UNAVAILABLE'?<p>Current DRAFT confirmation unavailable — needs staff review. No saved configuration or activation success is assumed; refresh saved receipts before continuing.</p>:<><p>NO_RECORDED_DRAFT — no receipt-bound DRAFT is recorded. This is not membership or activation success.</p><form onSubmit={e=>{e.preventDefault();void draftMembership();}}><fieldset disabled={busy}>
          <legend>Explicit DRAFT declaration</legend>
          <label style={field}>Opaque plan code<input value={planCode} onChange={e=>setPlanCode(e.target.value)} maxLength={80} autoComplete="off" required /></label><p>This bounded staff-declared code is not a price, catalog selection, discount or renewal promise.</p>
          <label style={field}>Term starts (your local time)<input type="datetime-local" value={termStart} onChange={e=>setTermStart(e.target.value)} required /></label>
          <label style={field}>Term ends (your local time)<input type="datetime-local" value={termEnd} onChange={e=>setTermEnd(e.target.value)} required /></label>
          <label style={field}>Exact ISO currency code<input value={currency} onChange={e=>setCurrency(e.target.value)} minLength={3} maxLength={3} pattern="[A-Z]{3}" autoComplete="off" required /></label>
          <button disabled={busy}>Save membership DRAFT only</button>
        </fieldset></form></>}
      </section>}
    </>}
    <nav aria-label="Conventional staff modules"><Link href="/staff/dashboard">Staff dashboard</Link> · <Link href="/staff/attendance">Attendance</Link> · <Link href="/staff/curriculum/library">Curriculum library</Link></nav>
  </main>;
}
