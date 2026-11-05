'use client';
import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import type { LeadListItem, FollowUpQueue, CrmAppointmentSummary } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT } from '../session-invalidation';
import { journeyText, type JourneyKey } from './catalog';
import { readCurrentSchool, readLeads, readQueue, readRegistration, verifyJourneySession, prepareCommand, sendCommand, JourneyError, CRM_LEAD_REGISTRATION_CONFIRMATION, type Scope, type Command, type Receipt, type Kind } from './http';
import styles from './workbench.module.css';
import { leadMembershipHref } from '../crm-lead-memberships-http';
import { membershipRecoveryText } from '../crm-lead-memberships-copy';
import { readTrialRecovery, readTrialDetail, parseTrialConflict, type TrialRecovery } from './trial-recovery-http';

type Step = 'lead' | 'follow' | 'trial' | 'outcome' | 'close' | 'register' | 'history';
const steps: Step[] = ['lead','follow','trial','outcome','close','register','history'];
type Notice = 'denied' | 'readError' | 'rejected' | 'unknown' | 'invalid' | 'restoredMissing' | 'retryRejected' | 'trialConflict' | '';
type CommandResult = Exclude<Kind, 'REGISTER'> | 'REGISTERED' | 'REVIEW' | '';
const timeout = () => AbortSignal.timeout(20_000);
const trialScopeKey = (s: Scope, lead: string) => [s.organizationId, s.schoolId, lead].map(v => v.toLowerCase()).join(':');
export function CrmJourney({ sessionSubject, initialScope = {}, initialLeadId = '' }: { sessionSubject: string; initialScope?: Partial<Scope>; initialLeadId?: string }): React.ReactElement {
  const locale = useLocale(), t = (k: JourneyKey) => journeyText(locale.preferences.language, k);
  const [mode, setMode] = useState('modern'), [step, setStep] = useState<Step>('lead');
  const [scope, setScope] = useState<Scope>({ organizationId: initialScope.organizationId ?? '', schoolId: initialScope.schoolId ?? '' });
  const [rows, setRows] = useState<LeadListItem[] | null>(null), [leadId, setLeadId] = useState(initialLeadId), [query, setQuery] = useState('');
  const [queue, setQueue] = useState<FollowUpQueue | null>(null), [registration, setRegistration] = useState<'NOT_REGISTERED' | 'EXISTING_RECORD' | 'UNAVAILABLE' | 'UNVERIFIED_PREPARED' | null>(null);
  const [trial, setTrial] = useState<CrmAppointmentSummary | null>(null);
  const [trialRecovery, setTrialRecovery] = useState<TrialRecovery | null>(null), [trialVerified, setTrialVerified] = useState(false), [retryReviewed, setRetryReviewed] = useState(false);
  const [receipts, setReceipts] = useState<Receipt[]>([]), [receiptConcealed, setReceiptConcealed] = useState(false);
  const [commandResult, setCommandResult] = useState<CommandResult>('');
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [dirty, setDirty] = useState(false), [needsRefresh, setNeedsRefresh] = useState(false);
  const [concealed, setConcealed] = useState(false), [sessionLost, setSessionLost] = useState(false), [notice, setNotice] = useState<Notice>(''), [discard, setDiscard] = useState(false), [confirmed, setConfirmed] = useState(false);
  const [subject, setSubject] = useState(''), [note, setNote] = useState(''), [due, setDue] = useState(''), [priority, setPriority] = useState('NORMAL');
  const [start, setStart] = useState(''), [end, setEnd] = useState(''), [location, setLocation] = useState(''), [outcome, setOutcome] = useState('COMPLETED'), [decision, setDecision] = useState('WON');
  const [path, setPath] = useState('ADULT'), [birth, setBirth] = useState(''), [childGiven, setChildGiven] = useState(''), [childFamily, setChildFamily] = useState('');
  const area = useRef<HTMLDivElement | null>(null), heading = useRef<HTMLHeadingElement | null>(null), shieldHeading = useRef<HTMLHeadingElement | null>(null);
  const registrationReadDenied = useRef(false);
  const mounted = useRef(true), readEpoch = useRef(0), readAbort = useRef<AbortController | null>(null), readActive = useRef(false);
  // Command lifetime deliberately does not use the read epoch: blur invalidates reads, never command settlement.
  const commandEpoch = useRef(0), commandBusy = useRef(false), pending = useRef<Command | null>(null), shield = useRef(false), dead = useRef(false);
  // Negative-only, private mounted-lifetime guard. Never a current appointment fact or cross-session recovery.
  const trialHolds = useRef(new Set<string>()), refreshRequired = useRef(false);
  // A bounded read cannot prove that an earlier unknown command failed, even after local abandonment.
  const unresolvedTrials = useRef(new Set<string>());
  const facts = useRef(false), scopeRef = useRef(scope), rowRef = useRef<LeadListItem | null>(null), queueRef = useRef<FollowUpQueue | null>(null), dirtyRef = useRef(false);
  const selected = rows?.find(r => r.id === leadId) ?? null;
  const trialUsed = Boolean(selected && trialHolds.current.has(trialScopeKey(scope, selected.id)));
  facts.current = Boolean(rows || trial || trialRecovery || receipts.length || dirty || pending.current); rowRef.current = selected; scopeRef.current = scope; queueRef.current = queue; dirtyRef.current = dirty;
  const locked = busy || loading || uncertain || dirty;
  function requireRefresh(): void { refreshRequired.current = true; setNeedsRefresh(true); }
  function clearDraft(): void { setSubject(''); setNote(''); setDue(''); setPriority('NORMAL'); setStart(''); setEnd(''); setLocation(''); setBirth(''); setChildGiven(''); setChildFamily(''); setConfirmed(false); setCommandResult(''); setDirty(false); dirtyRef.current = false; }
  function conceal(): void {
    readEpoch.current++; readAbort.current?.abort(); readActive.current = false; setLoading(false);
    setTrialRecovery(null); setTrialVerified(false); setRetryReviewed(false);
    if (!facts.current && !commandBusy.current && !shield.current) return;
    shield.current = true;
    if (area.current) { area.current.hidden = true; area.current.inert = true; }
    setConcealed(true); setDiscard(false); setNotice('');
  }
  function invalidateSession(): void {
    conceal(); registrationReadDenied.current = false; dead.current = true; commandEpoch.current++; pending.current = null;
    trialHolds.current.clear(); unresolvedTrials.current.clear(); refreshRequired.current = false; setNeedsRefresh(false);
    setRows(null); setQueue(null); setTrial(null); setReceipts([]); setRegistration(null); setQuery(''); clearDraft();
    setUncertain(false); setSessionLost(true); setNotice('');
  }
  useEffect(() => {
    mounted.current = true;
    const hidden = () => { if (document.visibilityState === 'hidden') conceal(); };
    window.addEventListener('blur', conceal); window.addEventListener('pagehide', conceal); document.addEventListener('visibilitychange', hidden);
    window.addEventListener(HON_SESSION_INVALIDATED_EVENT, invalidateSession); window.addEventListener(HON_SCHOOL_CONTEXT_CHANGED_EVENT, conceal);
    return () => { mounted.current = false; commandEpoch.current++; readEpoch.current++; readAbort.current?.abort(); pending.current = null; trialHolds.current.clear(); unresolvedTrials.current.clear(); refreshRequired.current = false;
      window.removeEventListener('blur', conceal); window.removeEventListener('pagehide', conceal); document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener(HON_SESSION_INVALIDATED_EVENT, invalidateSession); window.removeEventListener(HON_SCHOOL_CONTEXT_CHANGED_EVENT, conceal); };
  }, []);
  useEffect(() => { if (concealed) shieldHeading.current?.focus(); }, [concealed]);
  function error(e: unknown, isCommand = false): void {
    if (e instanceof JourneyError && e.kind === 'SESSION') { invalidateSession(); return; }
    if (e instanceof JourneyError && e.kind === 'DENIED') { setRows(null); setQueue(null); setRegistration(null); setTrial(null); setTrialRecovery(null); setTrialVerified(false); setRetryReviewed(false); setReceipts([]); setNotice('denied'); return; }
    setNotice(e instanceof JourneyError && e.kind === 'REJECTED' ? 'rejected' : isCommand ? 'unknown' : 'readError');
  }
  async function load(useCurrent = false): Promise<void> {
    if (dead.current || readActive.current || commandBusy.current || (!shield.current && (pending.current || dirtyRef.current))) return;
    const restoring = shield.current, original = rowRef.current ?? (pending.current ? { id: pending.current.leadId, primaryPersonId: pending.current.contactId } : null);
    readActive.current = true; const epoch = ++readEpoch.current, controller = new AbortController(); readAbort.current?.abort(); readAbort.current = controller;
    const signal = AbortSignal.any([controller.signal, timeout()]); setLoading(true); setNotice(''); setConfirmed(false); setCommandResult('');
    setTrialRecovery(null); setTrialVerified(false); setRetryReviewed(false);
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
      if (normalized.schoolId !== scopeRef.current.schoolId || normalized.organizationId !== scopeRef.current.organizationId) { clearDraft(); setReceipts([]); setTrial(null); setReceiptConcealed(false); }
      if (original && list.some(r => r.id === original.id && r.primaryPersonId !== original.primaryPersonId)) { setLeadId(''); setTrial(null); trialHolds.current.add(trialScopeKey(normalized, original.id)); setReceipts([]); clearDraft(); }
      setScope(normalized); setRows(list); setQuery(''); setQueue(null); setRegistration(registrationReadDenied.current ? 'UNAVAILABLE' : null); registrationReadDenied.current = false; refreshRequired.current = false; setNeedsRefresh(false);
      if (!list.some(r => r.id === leadId)) setLeadId('');
      if (restoring) { setReceipts([]); setTrial(null); setReceiptConcealed(true); clearDraft(); }
      shield.current = false; setConcealed(false);
    } catch (e) { if (mounted.current && epoch === readEpoch.current && !controller.signal.aborted) { setRows(null); error(e); } }
    finally { if (mounted.current && epoch === readEpoch.current) { readActive.current = false; setLoading(false); } }
  }
  async function readExtra(kind: 'follow' | 'registration'): Promise<void> {
    if (!selected || commandBusy.current || pending.current || readActive.current || dirty || shield.current || dead.current || refreshRequired.current) return;
    const current = selected, s = scope, epoch = ++readEpoch.current, controller = new AbortController(); readAbort.current = controller;
    readActive.current = true; setLoading(true); setNotice(''); setConfirmed(false); setCommandResult(''); const signal = AbortSignal.any([controller.signal, timeout()]);
    try {
      await verifyJourneySession(sessionSubject, signal); if (signal.aborted) return;
      const v = kind === 'follow' ? await readQueue(s, signal) : await readRegistration(s, current, signal);
      await verifyJourneySession(sessionSubject, signal);
      if (epoch !== readEpoch.current || signal.aborted || shield.current || dead.current || !mounted.current) return;
      if (kind === 'follow') setQueue(v as FollowUpQueue); else setRegistration(v as 'NOT_REGISTERED' | 'EXISTING_RECORD');
    } catch (e) { if (epoch === readEpoch.current && !controller.signal.aborted && mounted.current) { if (kind === 'registration' && e instanceof JourneyError && e.kind === 'DENIED') { registrationReadDenied.current = true; conceal(); setNotice('denied'); } else { if (kind === 'follow') setQueue(null); else setRegistration(null); error(e); } } }
    finally { if (epoch === readEpoch.current && mounted.current) { readActive.current = false; setLoading(false); } }
  }
  async function recoverTrials(appointmentId?: string): Promise<void> {
    if (!selected || commandBusy.current || readActive.current || shield.current || dead.current || refreshRequired.current
      || pending.current && !['SCHEDULE', 'OUTCOME'].includes(pending.current.kind) || dirty && !pending.current) return;
    const current = selected, s = scope, epoch = ++readEpoch.current, controller = new AbortController();
    readAbort.current?.abort(); readAbort.current = controller; readActive.current = true;
    setLoading(true); setNotice(''); setConfirmed(false); setCommandResult(''); setTrialVerified(false); setRetryReviewed(false);
    const signal = AbortSignal.any([controller.signal, timeout()]);
    try {
      await verifyJourneySession(sessionSubject, signal);
      const recovered = appointmentId ? await readTrialDetail(s, current.id, appointmentId, signal) : await readTrialRecovery(s, current.id, signal);
      await verifyJourneySession(sessionSubject, signal);
      if (!mounted.current || epoch !== readEpoch.current || signal.aborted || shield.current || dead.current
        || rowRef.current?.id !== current.id || rowRef.current.primaryPersonId !== current.primaryPersonId
        || scopeRef.current.organizationId !== s.organizationId || scopeRef.current.schoolId !== s.schoolId) return;
      const key = trialScopeKey(s, current.id);
      if (appointmentId) { setTrial(recovered as CrmAppointmentSummary); setTrialVerified(true); }
      else {
        const result = recovered as TrialRecovery;
        setTrialRecovery(result); setTrial(null);
        if (result.activeTrial) trialHolds.current.add(key);
        else if (!pending.current && !unresolvedTrials.current.has(key)) trialHolds.current.delete(key);
      }
      // A read never becomes a command receipt or settles the retained request by inference.
      if (pending.current) setRetryReviewed(true);
    } catch (e) {
      if (mounted.current && epoch === readEpoch.current && !controller.signal.aborted) {
        setTrialRecovery(null); setTrial(null); setTrialVerified(false); setRetryReviewed(false);
        if (e instanceof JourneyError && e.kind === 'DENIED') conceal();
        error(e);
      }
    } finally { if (mounted.current && epoch === readEpoch.current) { readActive.current = false; setLoading(false); } }
  }
  async function send(c: Command, retry = false): Promise<void> {
    if (commandBusy.current || readActive.current || shield.current || dead.current || pending.current && pending.current !== c
      || !retry && (refreshRequired.current || c.kind === 'SCHEDULE' && trialHolds.current.has(trialScopeKey(c.scope, c.leadId)))
      || retry && (c.kind === 'SCHEDULE' || c.kind === 'OUTCOME') && !retryReviewed
      || rowRef.current?.id !== c.leadId || rowRef.current.primaryPersonId !== c.contactId
      || scopeRef.current.schoolId !== c.scope.schoolId || scopeRef.current.organizationId !== c.scope.organizationId) return;
    commandBusy.current = true; setBusy(true); pending.current = c; setUncertain(false); setConfirmed(false); setNotice(''); setDiscard(false); setCommandResult('');
    const epoch = commandEpoch.current;
    try {
      await verifyJourneySession(sessionSubject, timeout());
      if (dead.current || epoch !== commandEpoch.current || !mounted.current) return;
      if (retry && (c.kind === 'SCHEDULE' || c.kind === 'OUTCOME')) {
        // This read is part of an explicit exact retry, never an automatic command from recovery.
        await readTrialRecovery(c.scope, c.leadId, timeout());
        await verifyJourneySession(sessionSubject, timeout());
      }
      if (c.kind === 'OUTCOME' && !retry) {
        const prior = c.prior ? JSON.parse(c.prior) as CrmAppointmentSummary : null;
        if (!prior) throw new JourneyError('REJECTED');
        const current = await readTrialDetail(c.scope, c.leadId, prior.id, timeout());
        await verifyJourneySession(sessionSubject, timeout());
        if (current.version !== prior.version || current.status !== 'SCHEDULED') throw new JourneyError('REJECTED', 409);
      }
      if (dead.current || epoch !== commandEpoch.current || !mounted.current) return;
      // If focus moved while verifying identity, do not initiate a consequential action behind the shield.
      if (shield.current) { if (c.kind === 'SCHEDULE') trialHolds.current.add(trialScopeKey(c.scope, c.leadId)); setUncertain(true); return; }
      if (c.kind === 'SCHEDULE') trialHolds.current.add(trialScopeKey(c.scope, c.leadId));
      const r = await sendCommand(c, timeout());
      if (dead.current || epoch !== commandEpoch.current || !mounted.current) return;
      pending.current = null; setUncertain(false); clearDraft(); requireRefresh();
      setCommandResult(r.kind === 'REGISTER' ? r.record.outcome === 'REGISTERED' ? 'REGISTERED' : 'REVIEW' : r.kind);
      setReceipts(old => [...old.slice(-19), r]);
      if (r.kind === 'SCHEDULE' || r.kind === 'OUTCOME') { setTrial(r.record); setTrialRecovery(null); setTrialVerified(false); setRetryReviewed(false); trialHolds.current.add(trialScopeKey(c.scope, c.leadId)); if (r.kind === 'SCHEDULE') unresolvedTrials.current.delete(trialScopeKey(c.scope, c.leadId)); }
      if (r.kind === 'REGISTER') setRegistration('EXISTING_RECORD');
    } catch (e) {
      if (dead.current || epoch !== commandEpoch.current || !mounted.current) return;
      if (c.kind === 'SCHEDULE' && e instanceof JourneyError && e.status === 409 && e.trialConflict !== undefined) {
        try {
          const existing = parseTrialConflict(e.trialConflict, c.leadId);
          if (existing) {
            trialHolds.current.add(trialScopeKey(c.scope, c.leadId));
            if (retry) unresolvedTrials.current.add(trialScopeKey(c.scope, c.leadId));
            pending.current = retry ? c : null; setUncertain(retry); clearDraft(); if (!retry) requireRefresh();
            setTrial(existing); setTrialVerified(false); setTrialRecovery(null); setRetryReviewed(false); setNotice('trialConflict');
            return;
          }
        } catch { /* Malformed conflict evidence is uncertain, not proof that the original command failed. */
          unresolvedTrials.current.add(trialScopeKey(c.scope, c.leadId)); pending.current = c; setUncertain(true); setRetryReviewed(false); setNotice('unknown'); return;
        }
      }
      if (e instanceof JourneyError && e.kind === 'SESSION') { invalidateSession(); }
      else if (e instanceof JourneyError && e.kind === 'DENIED') {
        // A denied replay says nothing about the earlier unknown action. Retain its exact identity privately until fresh access or deliberate abandonment.
        if (!retry && c.kind === 'SCHEDULE') trialHolds.current.delete(trialScopeKey(c.scope, c.leadId));
        pending.current = retry ? c : null; setUncertain(retry); clearDraft(); error(e, true); conceal();
      }
      else if (!retry && e instanceof JourneyError && e.kind === 'REJECTED') { if (c.kind === 'SCHEDULE') trialHolds.current.delete(trialScopeKey(c.scope, c.leadId)); pending.current = null; setUncertain(false); setDirty(false); requireRefresh(); setNotice('rejected'); }
      else { if (c.kind === 'SCHEDULE') { trialHolds.current.add(trialScopeKey(c.scope, c.leadId)); unresolvedTrials.current.add(trialScopeKey(c.scope, c.leadId)); } pending.current = c; setUncertain(true); setRetryReviewed(false); setTrialVerified(false); setNotice(e instanceof JourneyError && e.kind === 'REJECTED' ? 'retryRejected' : 'unknown'); }
    } finally {
      // Settlement cannot be suppressed by focus/read invalidation. Never unlock a later component instance.
      if (mounted.current && epoch === commandEpoch.current) { commandBusy.current = false; setBusy(false); }
    }
  }
  function submit(event: FormEvent, kind: Kind): void {
    event.preventDefault();
    if (!selected || !confirmed || commandBusy.current || readActive.current || pending.current || shield.current || dead.current || refreshRequired.current
      || kind === 'SCHEDULE' && trialHolds.current.has(trialScopeKey(scope, selected.id))) return;
    try {
      let input: unknown;
      if (kind === 'FOLLOW_UP') {
        if (!queue || queue.schoolId !== scope.schoolId) throw new Error();
        input = { expectedVersion: 0, leadId: selected.id, assigneeId: queue.principalId, subject: subject.trim(), note: note.trim(), dueAt: due ? new Date(`${due}:00Z`).toISOString() : null, priority };
      } else if (kind === 'SCHEDULE') {
        if (trialUsed) throw new Error();
        input = { startsAt: new Date(`${start}:00Z`).toISOString(), endsAt: new Date(`${end}:00Z`).toISOString(), ...(location.trim() ? { location: location.trim() } : {}), ...(note.trim() ? { notes: note.trim() } : {}) };
      } else if (kind === 'OUTCOME') { if (!trial || !trialVerified || trial.status !== 'SCHEDULED') throw new Error(); input = { expectedVersion: trial.version, status: outcome, ...(note.trim() ? { outcomeNotes: note.trim() } : {}) }; }
      else if (kind === 'CLOSE') input = { expectedVersion: selected.version, status: decision, ...(note.trim() ? { closeNote: note.trim() } : {}) };
      else {
        if (registration !== 'NOT_REGISTERED' && registration !== 'UNVERIFIED_PREPARED') throw new Error();
        input = { registrationPath: path, ...(path === 'ADULT' ? { birthDate: birth } : { childGivenName: childGiven.trim(), childFamilyName: childFamily.trim(), childBirthDate: birth }), confirmation: CRM_LEAD_REGISTRATION_CONFIRMATION };
      }
      const c = prepareCommand(kind, scope, selected, input, crypto.randomUUID(), kind === 'OUTCOME' ? trial : null);
      void send(c);
    } catch { setNotice('invalid'); }
  }
  function abandon(): void {
    if (commandBusy.current) return;
    if (pending.current?.kind === 'SCHEDULE') { trialHolds.current.add(trialScopeKey(pending.current.scope, pending.current.leadId)); unresolvedTrials.current.add(trialScopeKey(pending.current.scope, pending.current.leadId)); }
    commandEpoch.current++; registrationReadDenied.current = false; pending.current = null; setUncertain(false); setDiscard(false); clearDraft(); setNotice('');
    // Deliberate abandonment discards only local state. The next facts require an explicit server read.
    setRows(null); setQueue(null); setRegistration(null); setTrial(null); setTrialRecovery(null); setTrialVerified(false); setRetryReviewed(false); setReceipts([]); requireRefresh(); setLeadId('');
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
  const trialReadDisabled = busy || loading || needsRefresh || dirty && !pending.current || Boolean(pending.current && !['SCHEDULE','OUTCOME'].includes(pending.current.kind));
  const trialRow = (r: CrmAppointmentSummary) => <li key={r.id}>
    {statusLabel(r.status)} · {locale.date(r.startsAt)} — {locale.date(r.endsAt)} · {t('version')} {locale.number(r.version)}{' '}
    <button data-testid={`inspect-trial-${r.id}`} disabled={trialReadDisabled} onClick={() => void recoverTrials(r.id)}>{t('reviewTrial')}</button>
  </li>;
  return <main className={styles.page} data-mode={mode}>
    <header><p className={styles.eyebrow}>HON OS · CRM</p><h1>{t('title')}</h1><p>{t('subtitle')}</p></header>
    <div className={styles.toolbar}><label>{t('mode')}<select data-testid="mode" value={mode} onChange={e => setMode(e.target.value)}>{(['modern','classic','big'] as const).map(m => <option key={m} value={m}>{t(m)}</option>)}</select></label><a href="/staff/hon">{t('hon')}</a><a href="/staff/crm/leads">{t('leadsWorkbench')}</a></div>
    <div className={styles.announce} role="status" aria-live="polite" aria-atomic="true">{sessionLost ? t('reauth') : busy ? t('saving') : loading ? t('loading') : uncertain ? t('pending') : concealed ? t('shield') : ''}</div>
    {sessionLost ? <section><h2>{t('reauth')}</h2><a href="/auth/login">{t('signIn')}</a></section> : <>
      {concealed && <section className={styles.shield} aria-busy={loading}><h2 ref={shieldHeading} tabIndex={-1}>{t('shield')}</h2><p>{t('shieldText')}</p>{busy && <p>{t('saving')}</p>}{notice && <p role="alert">{t(notice)}</p>}<button data-testid="restore" disabled={busy || loading} onClick={() => void load()}>{t('restore')}</button><button data-testid="shield-discard" disabled={busy || loading} onClick={() => setDiscard(true)}>{t('discard')}</button></section>}
      <div ref={area} hidden={concealed} inert={concealed} aria-hidden={concealed || undefined}>
      <div className={styles.announce} data-testid="command-status" role="status" aria-live="polite" aria-atomic="true">{commandResult === 'REVIEW' ? t('review') : commandResult === 'REGISTERED' ? t('registered') : commandResult ? `${t(({FOLLOW_UP:'follow',SCHEDULE:'trial',OUTCOME:'outcome',CLOSE:'close'} as const)[commandResult])}: ${t('receipt')}` : trialVerified || trialRecovery ? t('trialReadComplete') : ''}</div>
      <p className={styles.limit}>{t('intro')}</p>
      <section aria-label={t('school')}><h2>{t('school')}</h2><div className={styles.actions}><button data-testid="current-school" disabled={locked} onClick={() => void load(true)}>{t('currentSchool')}</button><button data-testid="load" disabled={locked || !scope.organizationId || !scope.schoolId} onClick={() => void load()}>{t('load')}</button></div>
        <details><summary>{t('knownSchool')}</summary><p>{t('scopeHelp')}</p><fieldset disabled={locked} className={styles.fields}><label>{t('organization')}<input data-testid="organization" value={scope.organizationId} onChange={e => { setScope({ ...scope, organizationId: e.target.value }); setCommandResult(''); setTrialRecovery(null); setTrialVerified(false); setRetryReviewed(false); setRows(null); setLeadId(''); setQueue(null); setTrial(null); setReceipts([]); }} /></label><label>{t('schoolId')}<input data-testid="school" value={scope.schoolId} onChange={e => { setScope({ ...scope, schoolId: e.target.value }); setCommandResult(''); setTrialRecovery(null); setTrialVerified(false); setRetryReviewed(false); setRows(null); setLeadId(''); setQueue(null); setTrial(null); setReceipts([]); }} /></label></fieldset></details>
        {rows ? <><p>{t('limit')}</p><label>{t('search')}<input data-testid="search" disabled={locked} value={query} onChange={e => setQuery(e.target.value)} /></label><label>{t('choose')}<select data-testid="lead-select" disabled={locked} value={leadId} onChange={e => { setLeadId(e.target.value); setTrialRecovery(null); setTrialVerified(false); setRetryReviewed(false); setQueue(null); setRegistration(null); setTrial(null); setReceipts([]); setReceiptConcealed(false); clearDraft(); }}><option value="">{t('choose')}</option>{rows.filter(r => r.id === leadId || `${r.givenName} ${r.familyName} ${r.email ?? ''}`.toLowerCase().includes(query.toLowerCase())).map(r => <option key={r.id} value={r.id}>{r.givenName} {r.familyName} · {statusLabel(r.status)}</option>)}</select></label></> : <p>{t('empty')}</p>}
      </section>
      <div className={styles.layout}>
        <nav className={styles.steps} aria-label={t('steps')}>{steps.map((s,i) => <button data-testid={`step-${s}`} key={s} disabled={busy || loading} aria-current={s === step ? 'step' : undefined} onClick={() => navigate(s)}><span>{i + 1}</span>{t(s)}</button>)}<p>{t('stepHint')}</p></nav>
        <section className={styles.workspace} aria-busy={busy || loading}><h2 ref={heading} tabIndex={-1}>{t(step)}</h2>
          {notice && <p role="alert" className={styles.error}>{t(notice)}</p>}
          {busy && <p>{t('saving')}</p>}{uncertain && <div className={styles.warning}><p>{t('pending')}</p><button data-testid="retry" disabled={busy || loading || Boolean(pending.current && ['SCHEDULE','OUTCOME'].includes(pending.current.kind) && !retryReviewed)} onClick={() => { if (pending.current) void send(pending.current, true); }}>{t('retry')}</button></div>}
          {needsRefresh && <p className={styles.warning}>{t('needsRefresh')}</p>}
          {!selected ? <p>{t('noLead')}</p> : <>
            <div className={styles.lead}><strong>{selected.givenName} {selected.familyName}</strong><p>{t('status')}: {statusLabel(selected.status)} · {t('version')} {locale.number(selected.version)}</p></div><p><a data-testid="membership-recovery" href={!locked && !needsRefresh ? leadMembershipHref({ ...scope, leadId: selected.id }) : undefined} aria-disabled={locked || needsRefresh} onClick={event => { if (busy || loading || pending.current || shield.current || refreshRequired.current) event.preventDefault(); }}>{membershipRecoveryText(locale.preferences.language, 'title')}</a></p>
            {step === 'lead' && <><dl><dt>{t('email')}</dt><dd>{selected.email ?? t('missing')}</dd><dt>{t('phone')}</dt><dd>{selected.phoneE164 ?? t('missing')}</dd><dt>{t('created')}</dt><dd>{locale.date(selected.createdAt)}</dd><dt>{t('next')}</dt><dd>{selected.nextFollowUpAt ? locale.date(selected.nextFollowUpAt) : t('missing')}</dd></dl><button disabled={locked} onClick={() => navigate('follow')}>{t('continue')}</button></>}
            <div>
            {step === 'follow' && <><p>{t('followHelp')}</p><button data-testid="verify-follow" disabled={locked || needsRefresh} onClick={() => void readExtra('follow')}>{t('verifyFollow')}</button>{!queue ? <p>{t('followUnavailable')}</p> : <><form autoComplete="off" onSubmit={e => submit(e,'FOLLOW_UP')}><fieldset disabled={inert}><label>{t('subject')}<input data-testid="subject" required maxLength={120} value={subject} onChange={e => edit(setSubject, e.target.value)} /></label>{noteField}<label>{t('due')}<input type="datetime-local" value={due} onChange={e => edit(setDue, e.target.value)} /></label><label>{t('priority')}<select value={priority} onChange={e => edit(setPriority, e.target.value)}>{(['LOW','NORMAL','HIGH'] as const).map(v => <option key={v} value={v}>{t(v)}</option>)}</select></label>{confirmation}<button data-testid="save-follow" disabled={!confirmed}>{t('followSave')}</button></fieldset></form><h3>{t('queue')}</h3><p>{t('boundedQueue')}</p><ul>{queue.items.filter(r => r.leadId === selected.id).map(r => <li key={r.followUpId}>{statusLabel(r.status)} · {r.dueAt ? locale.date(r.dueAt) : t('missing')} · {t('version')} {locale.number(r.version)}</li>)}</ul><a href={`/staff/crm/follow-ups?${new URLSearchParams({leadId:selected.id})}`}>{t('followWorkbench')}</a></> }</>}
            {['trial','outcome','history'].includes(step) && <section className={styles.receipts} aria-label={t('savedTrials')}>
              <h3>{t('savedTrials')}</h3><p>{t('trialReadHelp')}</p>
              <button data-testid="read-trials" disabled={trialReadDisabled} onClick={() => void recoverTrials()}>{t('readTrials')}</button>
              {trial && <button data-testid="verify-trial-detail" disabled={trialReadDisabled} onClick={() => void recoverTrials(trial.id)}>{t('reviewTrial')}</button>}
              {uncertain && pending.current && ['SCHEDULE','OUTCOME'].includes(pending.current.kind) && <p>{t('trialRetryReview')}</p>}
              {trialRecovery && <><p data-testid="trial-active-status">{t(trialRecovery.activeTrial ? 'activeTrial' : 'noActiveTrial')}</p>
                {trialRecovery.activeTrial && <ul>{trialRow(trialRecovery.activeTrial)}</ul>}
                <details><summary>{t('trialHistoryBound')}</summary><ul>{trialRecovery.trials.filter(r => r.id !== trialRecovery.activeTrial?.id).map(trialRow)}</ul></details></>}
              {trialVerified && trial && <p data-testid="verified-trial">{t('trialReadStatus')}: {statusLabel(trial.status)} · {locale.date(trial.startsAt)} — {locale.date(trial.endsAt)} · {t('version')} {locale.number(trial.version)}</p>}
              {selected && unresolvedTrials.current.has(trialScopeKey(scope, selected.id)) && <p>{t('trialUnresolvedHold')}</p>}
            </section>}
            {step === 'trial' && <><p>{t('trialHelp')}</p><p>{t('UTC')}</p>{trialUsed ? <p>{t('trialHold')}</p> : <form autoComplete="off" onSubmit={e => submit(e,'SCHEDULE')}><fieldset disabled={inert}><div className={styles.fields}><label>{t('start')}<input data-testid="start" type="datetime-local" required value={start} onChange={e => edit(setStart, e.target.value)} /></label><label>{t('end')}<input data-testid="end" type="datetime-local" required value={end} onChange={e => edit(setEnd, e.target.value)} /></label></div><label>{t('location')}<input maxLength={160} value={location} onChange={e => edit(setLocation, e.target.value)} /></label>{noteField}{confirmation}<button data-testid="save-trial" disabled={!confirmed}>{t('trialSave')}</button></fieldset></form>}</>}
            {step === 'outcome' && <><p>{t('outcomeHelp')}</p>{trial?.status === 'SCHEDULED' && trialVerified ? <><p>{t('trialReadStatus')}</p><p>{locale.date(trial.startsAt)} — {locale.date(trial.endsAt)}</p><form autoComplete="off" onSubmit={e => submit(e,'OUTCOME')}><fieldset disabled={inert}><label>{t('outcome')}<select data-testid="outcome" value={outcome} onChange={e => edit(setOutcome, e.target.value)}>{(['COMPLETED','NO_SHOW','CANCELLED'] as const).map(v => <option key={v} value={v}>{t(v)}</option>)}</select></label>{noteField}{confirmation}<button data-testid="save-outcome" disabled={!confirmed}>{t('outcomeSave')}</button></fieldset></form></> : <p>{t('outcomeMissing')}</p>}</>}
            {step === 'close' && <><p>{t('closeHelp')}</p>{selected.status !== 'OPEN' ? <p>{t('closeBlocked')}</p> : <form autoComplete="off" onSubmit={e => submit(e,'CLOSE')}><fieldset disabled={inert}><label>{t('closeChoice')}<select data-testid="decision" value={decision} onChange={e => edit(setDecision, e.target.value)}><option value="WON">{t('WON')}</option><option value="LOST">{t('LOST')}</option></select></label>{noteField}{confirmation}<button data-testid="save-close" disabled={!confirmed}>{t('closeSave')}</button></fieldset></form>}</>}
            {step === 'register' && <><p>{t('registerHelp')}</p><button data-testid="verify-registration" disabled={locked || needsRefresh} onClick={() => void readExtra('registration')}>{t('checkRegistration')}</button>{registration === null ? <p>{t('unchecked')}</p> : registration === 'EXISTING_RECORD' ? <p>{t('existingRegistration')}</p> : registration === 'UNAVAILABLE' ? <><p>{t('registrationLimited')}</p><button data-testid="prepare-record" disabled={inert} onClick={() => { setRegistration('UNVERIFIED_PREPARED'); setConfirmed(false); }}>{t('prepareRecord')}</button></> : <><p>{t(registration === 'NOT_REGISTERED' ? 'registrationReady' : 'registrationUnverified')}</p><form autoComplete="off" onSubmit={e => submit(e,'REGISTER')}><fieldset disabled={inert}><label>{t('registrationPath')}<select data-testid="registration-path" value={path} onChange={e => { edit(setPath, e.target.value); setBirth(''); }}><option value="ADULT">{t('adult')}</option><option value="GUARDIAN_CHILD">{t('family')}</option></select></label>{path === 'GUARDIAN_CHILD' && <div className={styles.fields}><label>{t('childGiven')}<input data-testid="child-given" required maxLength={100} value={childGiven} onChange={e => edit(setChildGiven, e.target.value)} /></label><label>{t('childFamily')}<input data-testid="child-family" required maxLength={100} value={childFamily} onChange={e => edit(setChildFamily, e.target.value)} /></label></div>}<label>{t(path === 'ADULT' ? 'birth' : 'childBirth')}<input data-testid="birth" type="date" required value={birth} onChange={e => edit(setBirth, e.target.value)} /></label>{confirmation}<button data-testid="save-registration" disabled={!confirmed}>{t('registerSave')}</button></fieldset></form></>}<p><a href={`/staff/crm/leads?${linkedScope}`}>{t('registrationWorkbench')}</a></p></>}
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
