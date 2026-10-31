'use client';
import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import type { LeadListItem, FollowUpQueue, CrmAppointmentSummary } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT } from '../session-invalidation';
import { journeyText, type JourneyKey } from './catalog';
import { readCurrentSchool, readLeads, readQueue, readRegistration, verifyJourneySession, prepareCommand, sendCommand, JourneyError, CRM_LEAD_REGISTRATION_CONFIRMATION, type Scope, type Command, type Receipt, type Kind } from './http';
import styles from './workbench.module.css';

type Step = 'lead' | 'follow' | 'trial' | 'outcome' | 'close' | 'register' | 'history';
const steps: Step[] = ['lead','follow','trial','outcome','close','register','history'];
type Notice = 'denied' | 'readError' | 'rejected' | 'unknown' | 'invalid' | 'restoredMissing' | 'retryRejected' | '';
const timeout = () => AbortSignal.timeout(20_000);
export function CrmJourney({ sessionSubject, initialScope = {}, initialLeadId = '' }: { sessionSubject: string; initialScope?: Partial<Scope>; initialLeadId?: string }): React.ReactElement {
  const locale = useLocale(), t = (k: JourneyKey) => journeyText(locale.preferences.language, k);
  const [mode, setMode] = useState('modern'), [step, setStep] = useState<Step>('lead');
  const [scope, setScope] = useState<Scope>({ organizationId: initialScope.organizationId ?? '', schoolId: initialScope.schoolId ?? '' });
  const [rows, setRows] = useState<LeadListItem[] | null>(null), [leadId, setLeadId] = useState(initialLeadId), [query, setQuery] = useState('');
  const [queue, setQueue] = useState<FollowUpQueue | null>(null), [registration, setRegistration] = useState<'NOT_REGISTERED' | 'EXISTING_RECORD' | null>(null);
  const [trial, setTrial] = useState<CrmAppointmentSummary | null>(null), [trialUsed, setTrialUsed] = useState(false);
  const [receipts, setReceipts] = useState<Receipt[]>([]), [receiptConcealed, setReceiptConcealed] = useState(false);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [dirty, setDirty] = useState(false), [needsRefresh, setNeedsRefresh] = useState(false);
  const [concealed, setConcealed] = useState(false), [sessionLost, setSessionLost] = useState(false), [notice, setNotice] = useState<Notice>(''), [discard, setDiscard] = useState(false), [confirmed, setConfirmed] = useState(false);
  const [subject, setSubject] = useState(''), [note, setNote] = useState(''), [due, setDue] = useState(''), [priority, setPriority] = useState('NORMAL');
  const [start, setStart] = useState(''), [end, setEnd] = useState(''), [location, setLocation] = useState(''), [outcome, setOutcome] = useState('COMPLETED'), [decision, setDecision] = useState('WON');
  const [path, setPath] = useState('ADULT'), [birth, setBirth] = useState(''), [childGiven, setChildGiven] = useState(''), [childFamily, setChildFamily] = useState('');
  const area = useRef<HTMLDivElement | null>(null), heading = useRef<HTMLHeadingElement | null>(null), shieldHeading = useRef<HTMLHeadingElement | null>(null);
  const mounted = useRef(true), readEpoch = useRef(0), readAbort = useRef<AbortController | null>(null), readActive = useRef(false);
  // Command lifetime deliberately does not use the read epoch: blur invalidates reads, never command settlement.
  const commandEpoch = useRef(0), commandBusy = useRef(false), pending = useRef<Command | null>(null), shield = useRef(false), dead = useRef(false);
  const facts = useRef(false), scopeRef = useRef(scope), rowRef = useRef<LeadListItem | null>(null), queueRef = useRef<FollowUpQueue | null>(null), dirtyRef = useRef(false);
  const selected = rows?.find(r => r.id === leadId) ?? null;
  facts.current = Boolean(rows || trial || receipts.length || dirty || pending.current); rowRef.current = selected; scopeRef.current = scope; queueRef.current = queue; dirtyRef.current = dirty;
  const locked = busy || loading || uncertain || dirty;
  function clearDraft(): void { setSubject(''); setNote(''); setDue(''); setPriority('NORMAL'); setStart(''); setEnd(''); setLocation(''); setBirth(''); setChildGiven(''); setChildFamily(''); setConfirmed(false); setDirty(false); dirtyRef.current = false; }
  function conceal(): void {
    readEpoch.current++; readAbort.current?.abort(); readActive.current = false; setLoading(false);
    if (!facts.current && !commandBusy.current && !shield.current) return;
    shield.current = true;
    if (area.current) { area.current.hidden = true; area.current.inert = true; }
    setConcealed(true); setDiscard(false); setNotice('');
  }
  function invalidateSession(): void {
    conceal(); dead.current = true; commandEpoch.current++; pending.current = null;
    setRows(null); setQueue(null); setTrial(null); setReceipts([]); setRegistration(null); setQuery(''); clearDraft();
    setUncertain(false); setSessionLost(true); setNotice('');
  }
  useEffect(() => {
    mounted.current = true;
    const hidden = () => { if (document.visibilityState === 'hidden') conceal(); };
    window.addEventListener('blur', conceal); window.addEventListener('pagehide', conceal); document.addEventListener('visibilitychange', hidden);
    window.addEventListener(HON_SESSION_INVALIDATED_EVENT, invalidateSession); window.addEventListener(HON_SCHOOL_CONTEXT_CHANGED_EVENT, conceal);
    return () => { mounted.current = false; commandEpoch.current++; readEpoch.current++; readAbort.current?.abort(); pending.current = null;
      window.removeEventListener('blur', conceal); window.removeEventListener('pagehide', conceal); document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener(HON_SESSION_INVALIDATED_EVENT, invalidateSession); window.removeEventListener(HON_SCHOOL_CONTEXT_CHANGED_EVENT, conceal); };
  }, []);
  useEffect(() => { if (concealed) shieldHeading.current?.focus(); }, [concealed]);
  function error(e: unknown, isCommand = false): void {
    if (e instanceof JourneyError && e.kind === 'SESSION') { invalidateSession(); return; }
    if (e instanceof JourneyError && e.kind === 'DENIED') { setRows(null); setQueue(null); setRegistration(null); setTrial(null); setReceipts([]); setNotice('denied'); return; }
    setNotice(e instanceof JourneyError && e.kind === 'REJECTED' ? 'rejected' : isCommand ? 'unknown' : 'readError');
  }
  async function load(useCurrent = false): Promise<void> {
    if (dead.current || readActive.current || commandBusy.current || (!shield.current && (pending.current || dirtyRef.current))) return;
    const restoring = shield.current, original = rowRef.current ?? (pending.current ? { id: pending.current.leadId, primaryPersonId: pending.current.contactId } : null);
    readActive.current = true; const epoch = ++readEpoch.current, controller = new AbortController(); readAbort.current?.abort(); readAbort.current = controller;
    const signal = AbortSignal.any([controller.signal, timeout()]); setLoading(true); setNotice('');
    try {
      await verifyJourneySession(sessionSubject, signal); if (signal.aborted) return;
      const next = useCurrent ? await readCurrentSchool(signal) : scopeRef.current;
      if (!next) throw new JourneyError('READ');
      const normalized = { organizationId: next.organizationId.toLowerCase(), schoolId: next.schoolId.toLowerCase() };
      const list = await readLeads(normalized, signal); if (signal.aborted) return;
      if (restoring && original && !list.some(r => r.id === original.id && r.primaryPersonId === original.primaryPersonId)) {
        if (epoch === readEpoch.current) setNotice('restoredMissing'); return;
      }
      // No old notes/receipts are revealed using lead-read alone. Follow-up and registration reads require their own explicit authorization again.
      await verifyJourneySession(sessionSubject, signal);
      if (!mounted.current || epoch !== readEpoch.current || signal.aborted || document.visibilityState === 'hidden') return;
      if (normalized.schoolId !== scopeRef.current.schoolId || normalized.organizationId !== scopeRef.current.organizationId) { clearDraft(); setReceipts([]); setTrial(null); setTrialUsed(false); setReceiptConcealed(false); }
      if (original && list.some(r => r.id === original.id && r.primaryPersonId !== original.primaryPersonId)) { setLeadId(''); setTrial(null); setTrialUsed(true); setReceipts([]); clearDraft(); }
      setScope(normalized); setRows(list); setQuery(''); setQueue(null); setRegistration(null); setNeedsRefresh(false);
      if (!list.some(r => r.id === leadId)) setLeadId('');
      if (restoring) { setReceipts([]); setTrial(null); setReceiptConcealed(true); clearDraft(); }
      shield.current = false; setConcealed(false);
    } catch (e) { if (mounted.current && epoch === readEpoch.current && !controller.signal.aborted) { setRows(null); error(e); } }
    finally { if (mounted.current && epoch === readEpoch.current) { readActive.current = false; setLoading(false); } }
  }
  async function readExtra(kind: 'follow' | 'registration'): Promise<void> {
    if (!selected || commandBusy.current || pending.current || readActive.current || dirty || shield.current || dead.current) return;
    const current = selected, s = scope, epoch = ++readEpoch.current, controller = new AbortController(); readAbort.current = controller;
    readActive.current = true; setLoading(true); setNotice(''); const signal = AbortSignal.any([controller.signal, timeout()]);
    try {
      await verifyJourneySession(sessionSubject, signal); if (signal.aborted) return;
      const v = kind === 'follow' ? await readQueue(s, signal) : await readRegistration(s, current, signal);
      await verifyJourneySession(sessionSubject, signal);
      if (epoch !== readEpoch.current || signal.aborted || shield.current || dead.current || !mounted.current) return;
      if (kind === 'follow') setQueue(v as FollowUpQueue); else setRegistration(v as 'NOT_REGISTERED' | 'EXISTING_RECORD');
    } catch (e) { if (epoch === readEpoch.current && !controller.signal.aborted && mounted.current) { if (kind === 'follow') setQueue(null); else setRegistration(null); error(e); } }
    finally { if (epoch === readEpoch.current && mounted.current) { readActive.current = false; setLoading(false); } }
  }
  async function send(c: Command, retry = false): Promise<void> {
    if (commandBusy.current || readActive.current || shield.current || dead.current || pending.current && pending.current !== c
      || rowRef.current?.id !== c.leadId || rowRef.current.primaryPersonId !== c.contactId
      || scopeRef.current.schoolId !== c.scope.schoolId || scopeRef.current.organizationId !== c.scope.organizationId) return;
    commandBusy.current = true; setBusy(true); pending.current = c; setUncertain(false); setNotice(''); setDiscard(false);
    const epoch = commandEpoch.current;
    try {
      await verifyJourneySession(sessionSubject, timeout());
      if (dead.current || epoch !== commandEpoch.current || !mounted.current) return;
      // If focus moved while verifying identity, do not initiate a consequential action behind the shield.
      if (shield.current) { setUncertain(true); return; }
      const r = await sendCommand(c, timeout());
      if (dead.current || epoch !== commandEpoch.current || !mounted.current) return;
      pending.current = null; setUncertain(false); clearDraft(); setNeedsRefresh(true);
      setReceipts(old => [...old.slice(-19), r]);
      if (r.kind === 'SCHEDULE' || r.kind === 'OUTCOME') { setTrial(r.record); setTrialUsed(true); }
      if (r.kind === 'REGISTER') setRegistration('EXISTING_RECORD');
    } catch (e) {
      if (dead.current || epoch !== commandEpoch.current || !mounted.current) return;
      if (e instanceof JourneyError && e.kind === 'SESSION') { invalidateSession(); }
      else if (e instanceof JourneyError && e.kind === 'DENIED') {
        // A denied replay says nothing about the earlier unknown action. Retain its exact identity privately until fresh access or deliberate abandonment.
        pending.current = retry ? c : null; setUncertain(retry); clearDraft(); error(e, true); conceal();
      }
      else if (!retry && e instanceof JourneyError && e.kind === 'REJECTED') { pending.current = null; setUncertain(false); setDirty(false); setNeedsRefresh(true); setNotice('rejected'); }
      else { pending.current = c; setUncertain(true); setNotice(e instanceof JourneyError && e.kind === 'REJECTED' ? 'retryRejected' : 'unknown'); }
    } finally {
      // Settlement cannot be suppressed by focus/read invalidation. Never unlock a later component instance.
      if (mounted.current && epoch === commandEpoch.current) { commandBusy.current = false; setBusy(false); }
    }
  }
  function submit(event: FormEvent, kind: Kind): void {
    event.preventDefault();
    if (!selected || !confirmed || commandBusy.current || readActive.current || pending.current || shield.current || dead.current || needsRefresh) return;
    try {
      let input: unknown;
      if (kind === 'FOLLOW_UP') {
        if (!queue || queue.schoolId !== scope.schoolId) throw new Error();
        input = { expectedVersion: 0, leadId: selected.id, assigneeId: queue.principalId, subject: subject.trim(), note: note.trim(), dueAt: due ? new Date(`${due}:00Z`).toISOString() : null, priority };
      } else if (kind === 'SCHEDULE') {
        if (trialUsed) throw new Error();
        input = { startsAt: new Date(`${start}:00Z`).toISOString(), endsAt: new Date(`${end}:00Z`).toISOString(), ...(location.trim() ? { location: location.trim() } : {}), ...(note.trim() ? { notes: note.trim() } : {}) };
      } else if (kind === 'OUTCOME') { if (!trial || trial.status !== 'SCHEDULED') throw new Error(); input = { expectedVersion: trial.version, status: outcome, ...(note.trim() ? { outcomeNotes: note.trim() } : {}) }; }
      else if (kind === 'CLOSE') input = { expectedVersion: selected.version, status: decision, ...(note.trim() ? { closeNote: note.trim() } : {}) };
      else {
        if (registration !== 'NOT_REGISTERED') throw new Error();
        input = { registrationPath: path, ...(path === 'ADULT' ? { birthDate: birth } : { childGivenName: childGiven.trim(), childFamilyName: childFamily.trim(), childBirthDate: birth }), confirmation: CRM_LEAD_REGISTRATION_CONFIRMATION };
      }
      const c = prepareCommand(kind, scope, selected, input, crypto.randomUUID(), kind === 'OUTCOME' ? trial : null);
      void send(c);
    } catch { setNotice('invalid'); }
  }
  function abandon(): void {
    if (commandBusy.current) return;
    const couldHaveScheduled = pending.current?.kind === 'SCHEDULE';
    commandEpoch.current++; pending.current = null; setUncertain(false); setDiscard(false); clearDraft(); setNotice('');
    if (couldHaveScheduled) setTrialUsed(true);
    // Deliberate abandonment discards only local state. The next facts require an explicit server read.
    setRows(null); setQueue(null); setRegistration(null); setTrial(null); setReceipts([]); setNeedsRefresh(false); setLeadId('');
    readEpoch.current++; readAbort.current?.abort(); readActive.current = false; setLoading(false); shield.current = false; setConcealed(false);
  }
  function navigate(next: Step): void { setStep(next); setConfirmed(false); setNotice(''); queueMicrotask(() => heading.current?.focus()); }
  function edit(setter: (value: string) => void, value: string): void {
    // Read the event value before scheduling React updates. A capture-phase update can restore a controlled input before its onChange runs.
    setter(value); setDirty(true); dirtyRef.current = true; setConfirmed(false);
  }
  const inert = busy || loading || uncertain || needsRefresh || !selected;
  const confirmation = <label className={styles.confirm}><input data-testid="confirm" type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{t('confirm')}</label>;
  const noteField = <label>{t('note')}<textarea data-testid="note" maxLength={2000} value={note} onChange={e => edit(setNote, e.target.value)} /></label>;
  const statusLabel = (s: string) => journeyText(locale.preferences.language, s as JourneyKey) ?? s;
  const linkedScope = selected ? new URLSearchParams({ organizationId: scope.organizationId, schoolId: scope.schoolId }).toString() : '';
  return <main className={styles.page} data-mode={mode}>
    <header><p className={styles.eyebrow}>HON OS · CRM</p><h1>{t('title')}</h1><p>{t('subtitle')}</p></header>
    <div className={styles.toolbar}><label>{t('mode')}<select data-testid="mode" value={mode} onChange={e => setMode(e.target.value)}>{(['modern','classic','big'] as const).map(m => <option key={m} value={m}>{t(m)}</option>)}</select></label><a href="/staff/hon">{t('hon')}</a><a href="/staff/crm/leads">{t('leadsWorkbench')}</a></div>
    <div className={styles.announce} role="status" aria-live="polite" aria-atomic="true">{sessionLost ? t('reauth') : busy ? t('saving') : loading ? t('loading') : uncertain ? t('pending') : concealed ? t('shield') : ''}</div>
    {sessionLost ? <section><h2>{t('reauth')}</h2><a href="/auth/login">{t('signIn')}</a></section> : <>
      {concealed && <section className={styles.shield} aria-busy={loading}><h2 ref={shieldHeading} tabIndex={-1}>{t('shield')}</h2><p>{t('shieldText')}</p>{busy && <p>{t('saving')}</p>}{notice && <p role="alert">{t(notice)}</p>}<button data-testid="restore" disabled={busy || loading} onClick={() => void load()}>{t('restore')}</button><button data-testid="shield-discard" disabled={busy || loading} onClick={() => setDiscard(true)}>{t('discard')}</button></section>}
      <div ref={area} hidden={concealed} inert={concealed} aria-hidden={concealed || undefined}>
      <p className={styles.limit}>{t('intro')}</p>
      <section aria-label={t('school')}><h2>{t('school')}</h2><div className={styles.actions}><button data-testid="current-school" disabled={locked} onClick={() => void load(true)}>{t('currentSchool')}</button><button data-testid="load" disabled={locked || !scope.organizationId || !scope.schoolId} onClick={() => void load()}>{t('load')}</button></div>
        <details><summary>{t('knownSchool')}</summary><p>{t('scopeHelp')}</p><fieldset disabled={locked} className={styles.fields}><label>{t('organization')}<input data-testid="organization" value={scope.organizationId} onChange={e => { setScope({ ...scope, organizationId: e.target.value }); setRows(null); setLeadId(''); setQueue(null); setTrial(null); setTrialUsed(false); setReceipts([]); }} /></label><label>{t('schoolId')}<input data-testid="school" value={scope.schoolId} onChange={e => { setScope({ ...scope, schoolId: e.target.value }); setRows(null); setLeadId(''); setQueue(null); setTrial(null); setTrialUsed(false); setReceipts([]); }} /></label></fieldset></details>
        {rows ? <><p>{t('limit')}</p><label>{t('search')}<input data-testid="search" disabled={locked} value={query} onChange={e => setQuery(e.target.value)} /></label><label>{t('choose')}<select data-testid="lead-select" disabled={locked} value={leadId} onChange={e => { setLeadId(e.target.value); setQueue(null); setRegistration(null); setTrial(null); setTrialUsed(false); setReceipts([]); setReceiptConcealed(false); setNeedsRefresh(false); clearDraft(); }}><option value="">{t('choose')}</option>{rows.filter(r => r.id === leadId || `${r.givenName} ${r.familyName} ${r.email ?? ''}`.toLowerCase().includes(query.toLowerCase())).map(r => <option key={r.id} value={r.id}>{r.givenName} {r.familyName} · {statusLabel(r.status)}</option>)}</select></label></> : <p>{t('empty')}</p>}
      </section>
      <div className={styles.layout}>
        <nav className={styles.steps} aria-label={t('steps')}>{steps.map((s,i) => <button data-testid={`step-${s}`} key={s} disabled={busy || loading} aria-current={s === step ? 'step' : undefined} onClick={() => navigate(s)}><span>{i + 1}</span>{t(s)}</button>)}<p>{t('stepHint')}</p></nav>
        <section className={styles.workspace} aria-busy={busy || loading}><h2 ref={heading} tabIndex={-1}>{t(step)}</h2>
          {notice && <p role="alert" className={styles.error}>{t(notice)}</p>}
          {busy && <p>{t('saving')}</p>}{uncertain && <div className={styles.warning}><p>{t('pending')}</p><button data-testid="retry" disabled={busy || loading} onClick={() => { if (pending.current) void send(pending.current, true); }}>{t('retry')}</button></div>}
          {needsRefresh && <p className={styles.warning}>{t('needsRefresh')}</p>}
          {!selected ? <p>{t('noLead')}</p> : <>
            <div className={styles.lead}><strong>{selected.givenName} {selected.familyName}</strong><p>{t('status')}: {statusLabel(selected.status)} · {t('version')} {locale.number(selected.version)}</p></div>
            {step === 'lead' && <><dl><dt>{t('email')}</dt><dd>{selected.email ?? t('missing')}</dd><dt>{t('phone')}</dt><dd>{selected.phoneE164 ?? t('missing')}</dd><dt>{t('created')}</dt><dd>{locale.date(selected.createdAt)}</dd><dt>{t('next')}</dt><dd>{selected.nextFollowUpAt ? locale.date(selected.nextFollowUpAt) : t('missing')}</dd></dl><button disabled={locked} onClick={() => navigate('follow')}>{t('continue')}</button></>}
            <div>
            {step === 'follow' && <><p>{t('followHelp')}</p><button data-testid="verify-follow" disabled={locked} onClick={() => void readExtra('follow')}>{t('verifyFollow')}</button>{!queue ? <p>{t('followUnavailable')}</p> : <><form autoComplete="off" onSubmit={e => submit(e,'FOLLOW_UP')}><fieldset disabled={inert}><label>{t('subject')}<input data-testid="subject" required maxLength={120} value={subject} onChange={e => edit(setSubject, e.target.value)} /></label>{noteField}<label>{t('due')}<input type="datetime-local" value={due} onChange={e => edit(setDue, e.target.value)} /></label><label>{t('priority')}<select value={priority} onChange={e => edit(setPriority, e.target.value)}>{(['LOW','NORMAL','HIGH'] as const).map(v => <option key={v} value={v}>{t(v)}</option>)}</select></label>{confirmation}<button data-testid="save-follow" disabled={!confirmed}>{t('followSave')}</button></fieldset></form><h3>{t('queue')}</h3><p>{t('boundedQueue')}</p><ul>{queue.items.filter(r => r.leadId === selected.id).map(r => <li key={r.followUpId}>{statusLabel(r.status)} · {r.dueAt ? locale.date(r.dueAt) : t('missing')} · {t('version')} {locale.number(r.version)}</li>)}</ul><a href={`/staff/crm/follow-ups?${new URLSearchParams({leadId:selected.id})}`}>{t('followWorkbench')}</a></> }</>}
            {step === 'trial' && <><p>{t('trialHelp')}</p><p>{t('UTC')}</p>{trialUsed ? <p>{trial ? t('historical') : t('outcomeMissing')}</p> : <form autoComplete="off" onSubmit={e => submit(e,'SCHEDULE')}><fieldset disabled={inert}><div className={styles.fields}><label>{t('start')}<input data-testid="start" type="datetime-local" required value={start} onChange={e => edit(setStart, e.target.value)} /></label><label>{t('end')}<input data-testid="end" type="datetime-local" required value={end} onChange={e => edit(setEnd, e.target.value)} /></label></div><label>{t('location')}<input maxLength={160} value={location} onChange={e => edit(setLocation, e.target.value)} /></label>{noteField}{confirmation}<button data-testid="save-trial" disabled={!confirmed}>{t('trialSave')}</button></fieldset></form>}</>}
            {step === 'outcome' && <><p>{t('outcomeHelp')}</p>{trial?.status === 'SCHEDULED' ? <><p>{t('historical')}</p><p>{locale.date(trial.startsAt)} — {locale.date(trial.endsAt)}</p><form autoComplete="off" onSubmit={e => submit(e,'OUTCOME')}><fieldset disabled={inert}><label>{t('outcome')}<select data-testid="outcome" value={outcome} onChange={e => edit(setOutcome, e.target.value)}>{(['COMPLETED','NO_SHOW','CANCELLED'] as const).map(v => <option key={v} value={v}>{t(v)}</option>)}</select></label>{noteField}{confirmation}<button data-testid="save-outcome" disabled={!confirmed}>{t('outcomeSave')}</button></fieldset></form></> : <p>{t('outcomeMissing')}</p>}</>}
            {step === 'close' && <><p>{t('closeHelp')}</p>{selected.status !== 'OPEN' ? <p>{t('closeBlocked')}</p> : <form autoComplete="off" onSubmit={e => submit(e,'CLOSE')}><fieldset disabled={inert}><label>{t('closeChoice')}<select data-testid="decision" value={decision} onChange={e => edit(setDecision, e.target.value)}><option value="WON">{t('WON')}</option><option value="LOST">{t('LOST')}</option></select></label>{noteField}{confirmation}<button data-testid="save-close" disabled={!confirmed}>{t('closeSave')}</button></fieldset></form>}</>}
            {step === 'register' && <><p>{t('registerHelp')}</p><button data-testid="verify-registration" disabled={locked} onClick={() => void readExtra('registration')}>{t('checkRegistration')}</button>{registration === null ? <p>{t('unchecked')}</p> : registration === 'EXISTING_RECORD' ? <p>{t('existingRegistration')}</p> : <><p>{t('registrationReady')}</p><form autoComplete="off" onSubmit={e => submit(e,'REGISTER')}><fieldset disabled={inert}><label>{t('registrationPath')}<select data-testid="registration-path" value={path} onChange={e => { edit(setPath, e.target.value); setBirth(''); }}><option value="ADULT">{t('adult')}</option><option value="GUARDIAN_CHILD">{t('family')}</option></select></label>{path === 'GUARDIAN_CHILD' && <div className={styles.fields}><label>{t('childGiven')}<input data-testid="child-given" required maxLength={100} value={childGiven} onChange={e => edit(setChildGiven, e.target.value)} /></label><label>{t('childFamily')}<input data-testid="child-family" required maxLength={100} value={childFamily} onChange={e => edit(setChildFamily, e.target.value)} /></label></div>}<label>{t(path === 'ADULT' ? 'birth' : 'childBirth')}<input data-testid="birth" type="date" required value={birth} onChange={e => edit(setBirth, e.target.value)} /></label>{confirmation}<button data-testid="save-registration" disabled={!confirmed}>{t('registerSave')}</button></fieldset></form></>}<p><a href={`/staff/crm/leads?${linkedScope}`}>{t('registrationWorkbench')}</a></p></>}
            </div>
            {step === 'history' && <><p>{t('historyUnavailable')}</p>{receipts.length === 0 && <p>{t('noReceipts')}</p>}</>}
            {receipts.length > 0 && <section className={styles.receipts} aria-label={t('history')}><h3>{t('receipt')}</h3><p>{t('historical')}</p>{receipts.map((r,i) => <p key={i} data-testid="receipt">{t(({FOLLOW_UP:'follow',SCHEDULE:'trial',OUTCOME:'outcome',CLOSE:'close',REGISTER:'register'} as const)[r.kind])}: {r.kind === 'REGISTER' ? t(r.record.outcome === 'REGISTERED' ? 'registered' : 'review') : <>{statusLabel(r.record.status)} · {t('version')} {locale.number(r.record.version)} · {locale.date(r.kind === 'FOLLOW_UP' ? r.record.recordedAt : r.kind === 'CLOSE' ? r.record.closedAt : r.record.updatedAt)}{(r.kind === 'SCHEDULE' || r.kind === 'OUTCOME') && <span data-testid="trial-window"><br />{locale.date(r.record.startsAt)} — {locale.date(r.record.endsAt)}</span>}</>}</p>)}</section>}
            {receiptConcealed && <p>{t('receiptLost')}</p>}
            <div className={styles.actions}><button data-testid="refresh" disabled={locked} onClick={() => void load()}>{t('refresh')}</button><button data-testid="discard" disabled={busy || loading} onClick={() => setDiscard(true)}>{t('discard')}</button></div>
          </>}
        </section>
        <aside className={styles.help}><h2>{t('help')}</h2><p>{t('helpText')}</p><a href="/staff/hon">{t('hon')}</a></aside>
      </div>
      </div>
      {discard && <section className={styles.warning} role="region" aria-label={t('discard')}><h2>{t('discard')}</h2><p>{t('discardWarning')}</p><button data-testid="abandon" disabled={busy || loading} onClick={abandon}>{t('abandon')}</button><button onClick={() => setDiscard(false)}>{t('keep')}</button></section>}
    </>}
  </main>;
}
