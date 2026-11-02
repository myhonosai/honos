'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import type { LeadListItem, CrmLeadRegistrationRecovery, CrmGuardianChildEnrollment } from '@hon/contracts';
import { CrmLeadAccessError, loadCrmLeads, type CrmLeadStatus } from './crm-leads-http';
import { crmFollowUpHref } from './crm-follow-up-handoff';
import { CrmLeadClosePanel } from './crm-lead-close-panel';
import { CrmLeadCreatePanel } from './crm-lead-create-panel';
import { CrmAdultFlow } from './crm-adult-flow';
import { CrmAdultRecoveryPending } from './crm-adult-recovery-pending';
import { AdultAccessError, AdultRecoveryError, readAdultRecovery } from './crm-adult-flow-http';
import { CrmFamilyFlow } from './crm-family-flow';
import { readFamilyEnrollment } from './crm-family-http';
import { PlanAccessError, PlanRejectedError } from './membership-plans/http';
import styles from './staff-availability-workbench.module.css';
import privacyStyles from './crm-enrollment-privacy.module.css';
import { verifyEnrollmentSession } from './crm-enrollment-privacy';
import { useLocale } from './localization/provider';
import type { KnownMembership } from './membership-activation-http';
import { CrmEnrollmentDiscard } from './crm-enrollment-discard';
import { CrmJourneyLink } from './crm-journey/entry';
import { HON_SESSION_INVALIDATED_EVENT } from './session-invalidation';

function trialHref(organizationId: string, schoolId: string, leadId: string): string {
  return `/staff/crm/trials?${new URLSearchParams({ organizationId, schoolId, leadId }).toString()}`;
}

export type CrmLeadsInitialScope = { organizationId?: string | undefined; schoolId?: string | undefined };

export function CrmLeadsWorkbench({ initialScope = {}, sessionSubject, onMembershipReview }: { initialScope?: CrmLeadsInitialScope; sessionSubject?: string; onMembershipReview?(selectors: KnownMembership): void } = {}): React.ReactElement {
  const { date } = useLocale();
  const [concealed, setConcealed] = useState(false), [restoring, setRestoring] = useState(false), [privacyError, setPrivacyError] = useState('');
  const privacyEpoch = useRef(0), restoreActive = useRef(false), restoreAbort = useRef<AbortController | null>(null);
  const privateArea = useRef<HTMLDivElement | null>(null), shieldHeading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => { if (concealed) shieldHeading.current?.focus(); }, [concealed]);
  const [organizationId, setOrganizationId] = useState(initialScope.organizationId ?? '');
  const [schoolId, setSchoolId] = useState(initialScope.schoolId ?? '');
  const [status, setStatus] = useState<CrmLeadStatus | ''>('OPEN');
  const [leads, setLeads] = useState<LeadListItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<LeadListItem | null>(null);
  const [closeBusy, setCloseBusy] = useState(false);
  const closeEpoch = useRef(0), closeOpen = useRef(false);
  const [closeCurrent, setCloseCurrent] = useState<LeadListItem | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [draftEpoch, setDraftEpoch] = useState(0);
  const [adult, setAdult] = useState<LeadListItem | null>(null);
  const [adultBusy, setAdultBusy] = useState(false);
  const adultOpen = useRef(false); adultOpen.current = adult !== null;
  const [resuming, setResuming] = useState(false);
  const [recovery, setRecovery] = useState<CrmLeadRegistrationRecovery | null>(null);
  const [recoveryError, setRecoveryError] = useState('');
  const [recovering, setRecovering] = useState(false);
  const recoveryActive = useRef(false);
  const recoveryAbort = useRef<AbortController | null>(null);
  const readEpoch = useRef(0);
  const readActive = useRef(false);
  const [familyRow, setFamilyRow] = useState<LeadListItem | null>(null);
  const [familyData, setFamilyData] = useState<CrmGuardianChildEnrollment | null>(null);
  const [familyBusy, setFamilyBusy] = useState(false), [familyLoading, setFamilyLoading] = useState(false), [familyError, setFamilyError] = useState('');
  const familyReadActive = useRef(false), familyOpen = useRef(false), familyAbort = useRef<AbortController | null>(null);
  const sensitive = useRef(false), inputDirty = useRef(false), shielded = useRef(false);
  const activity = useRef({ adult: false, family: false, create: false, close: false });
  const membershipEpoch = useRef(0);
  const membershipContext = useRef({ organizationId, schoolId, adultId: '', familyId: '' });
  membershipContext.current = { organizationId, schoolId, adultId: adult?.id ?? '', familyId: familyRow?.id ?? '' };
  sensitive.current = Boolean(leads?.length || adult || familyRow || selected || inputDirty.current);
  function busy(kind: keyof typeof activity.current, value: boolean): void {
    activity.current[kind] = value; if (value) inputDirty.current = true;
    ({ adult: setAdultBusy, family: setFamilyBusy, create: setCreateBusy, close: setCloseBusy })[kind](value);
  }
  const unsettled = (): boolean => Object.values(activity.current).some(Boolean);
  function discardLocalView(): void {
    if (unsettled()) return;
    clear(); shielded.current = false; setConcealed(false);
  }
  const familyHeading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => { if (familyRow && !familyData) familyHeading.current?.focus(); }, [familyRow, familyData]);

  function clear(): void {
    membershipEpoch.current++;
    closeEpoch.current++; closeOpen.current = false; setCloseCurrent(null); setCloseBusy(false);
    inputDirty.current = false; activity.current = { adult: false, family: false, create: false, close: false };
    privacyEpoch.current++; restoreActive.current = false; restoreAbort.current?.abort(); setRestoring(false); setPrivacyError('');
    familyAbort.current?.abort(); familyReadActive.current = false; familyOpen.current = false;
    setFamilyRow(null); setFamilyData(null); setFamilyBusy(false); setFamilyLoading(false); setFamilyError('');
    recoveryAbort.current?.abort(); recoveryActive.current = false;
    setResuming(false); setRecovery(null); setRecoveryError(''); setRecovering(false);
    readEpoch.current++; readActive.current = false; setLoading(false);
    setLeads(null); setError(''); setSelected(null); setNeedsReload(false); setAdult(null); setAdultBusy(false); setDraftEpoch(value => value + 1);
  }
  function accessLost(): void {
    clear(); shielded.current = false; setConcealed(false); setOrganizationId(''); setSchoolId(''); setCreateBusy(false); setCloseBusy(false);
    setError('Human session or current school authority unavailable. Scoped list, draft, retry and receipt discarded.');
  }
  useEffect(() => {
    // Local invalidation only, never a session read, polling or background command.
    const leave = (): void => {
      const conceal = shielded.current || sensitive.current || inputDirty.current || unsettled();
      clear(); setCreateBusy(false); setCloseBusy(false); shielded.current = conceal; setConcealed(conceal);
      if (conceal && privateArea.current) { privateArea.current.hidden = true; privateArea.current.inert = true; }
    };
    const hide = (event?: Event): void => {
      membershipEpoch.current++;
      // An idle empty view has no facts or retry to conceal. Invalidate late
      // reads without inventing a school or installing a focus grace period.
      if (!shielded.current && !sensitive.current && !inputDirty.current && !unsettled()) { clear(); return; }
      // Confirmed session loss conceals mounted command capsules, including
      // already-settled unknown outcomes. Do not destroy their immutable keys
      // or instance-lifetime busy ownership; settlement must finish privately.
      if (event?.type !== HON_SESSION_INVALIDATED_EVENT && !shielded.current && !familyOpen.current && !adultOpen.current && !closeOpen.current && !unsettled()) { clear(); setCreateBusy(false); setCloseBusy(false); }
      shielded.current = true;
      // Hide synchronously, including the accessibility tree. Mounted enrollment
      // components keep only their in-memory request state; no command is retried.
      if (privateArea.current) { privateArea.current.hidden = true; privateArea.current.inert = true; }
      setConcealed(true); privacyEpoch.current++; restoreAbort.current?.abort(); restoreActive.current = false; setRestoring(false); setPrivacyError('');
      readEpoch.current++; recoveryAbort.current?.abort(); familyAbort.current?.abort();
      readActive.current = false; recoveryActive.current = false; familyReadActive.current = false;
      setLoading(false); setRecovering(false); setFamilyLoading(false);
    };
    const hidden = (): void => { if (document.visibilityState === 'hidden') hide(); };
    window.addEventListener('pagehide', leave); window.addEventListener('blur', hide); window.addEventListener(HON_SESSION_INVALIDATED_EVENT, hide); document.addEventListener('visibilitychange', hidden);
    return () => { membershipEpoch.current++; closeEpoch.current++; closeOpen.current = false; readEpoch.current++; privacyEpoch.current++; restoreAbort.current?.abort(); recoveryAbort.current?.abort(); familyAbort.current?.abort(); window.removeEventListener('pagehide', leave); window.removeEventListener('blur', hide); window.removeEventListener(HON_SESSION_INVALIDATED_EVENT, hide); document.removeEventListener('visibilitychange', hidden); };
  }, []);
  async function load(event: FormEvent): Promise<void> {
    event.preventDefault(); if (unsettled() || closeOpen.current || closeBusy || createBusy || adultBusy || adult || familyRow || familyBusy || readActive.current) return;
    clear(); const generation = readEpoch.current; readActive.current = true; setLoading(true);
    try { const rows = await loadCrmLeads(organizationId, schoolId, status || undefined); if (generation === readEpoch.current) setLeads(rows); }
    catch (caught) {
      if (generation !== readEpoch.current) return;
      if (caught instanceof CrmLeadAccessError) accessLost();
      else { setLeads(null); setError(caught instanceof Error ? caught.message : 'No verified CRM lead list.'); }
    }
    finally { if (generation === readEpoch.current) { readActive.current = false; setLoading(false); } }
  }

  function closeAdult(): void {
    membershipEpoch.current++;
    readEpoch.current++; recoveryAbort.current?.abort(); recoveryActive.current = false;
    setAdult(null); setAdultBusy(false); setResuming(false); setRecovery(null); setRecoveryError(''); setRecovering(false);
  }
  async function resume(lead: LeadListItem, fromFamily = false): Promise<void> {
    if (unsettled() || closeOpen.current || recoveryActive.current || readActive.current || loading || closeBusy || createBusy || adultBusy || selected || needsReload && !adult && !fromFamily) return;
    membershipEpoch.current++;
    recoveryActive.current = true;
    const generation = readEpoch.current, abort = new AbortController(); recoveryAbort.current = abort;
    setAdult(lead); setResuming(true); setRecovery(null); setRecoveryError(''); setRecovering(true);
    try {
      const data = await readAdultRecovery({ organizationId, schoolId }, lead.id, lead.primaryPersonId, abort.signal);
      if (generation === readEpoch.current) setRecovery(data);
    } catch (caught) {
      if (generation !== readEpoch.current) return;
      if (caught instanceof AdultAccessError) accessLost();
      else if (caught instanceof AdultRecoveryError && caught.status === 404) {
        closeAdult(); setNeedsReload(true); setError(caught.message);
      } else setRecoveryError(caught instanceof Error ? caught.message : 'Saved setup is unavailable. Try this read again.');
    } finally { if (generation === readEpoch.current) { recoveryActive.current = false; setRecovering(false); } }
  }

  function closeFamily(): void {
    membershipEpoch.current++;
    readEpoch.current++; familyAbort.current?.abort(); familyReadActive.current = false; familyOpen.current = false;
    setFamilyRow(null); setFamilyData(null); setFamilyError(''); setFamilyLoading(false); setFamilyBusy(false);
  }
  async function resumeFamily(lead: LeadListItem): Promise<void> {
    if (unsettled() || closeOpen.current || familyReadActive.current || readActive.current || loading || closeBusy || createBusy || adult || adultBusy || familyBusy || selected || needsReload && !familyRow) return;
    membershipEpoch.current++;
    const generation = readEpoch.current, controller = new AbortController(); familyAbort.current = controller;
    familyReadActive.current = true; familyOpen.current = true; setFamilyRow(lead); setFamilyData(null); setFamilyError(''); setFamilyLoading(true);
    try { const data = await readFamilyEnrollment({ organizationId, schoolId }, lead.id, lead.primaryPersonId, controller.signal); if (generation === readEpoch.current) setFamilyData(data); }
    catch (e) {
      if (generation !== readEpoch.current) return;
      if (e instanceof PlanAccessError) accessLost();
      else if (e instanceof PlanRejectedError && e.status === 404) { closeFamily(); setNeedsReload(true); setError('This lead is unavailable. Reload the authorized list before selecting another family.'); }
      else setFamilyError(e instanceof Error ? e.message : 'Family setup is unavailable. Try the read again.');
    } finally { if (generation === readEpoch.current) { familyReadActive.current = false; setFamilyLoading(false); } }
  }

  async function restorePrivateView(): Promise<void> {
    if (restoreActive.current || unsettled()) return;
    const generation = ++privacyEpoch.current, controller = new AbortController(); restoreAbort.current = controller;
    restoreActive.current = true; setRestoring(true); setPrivacyError('');
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    try {
      await verifyEnrollmentSession(sessionSubject, signal);
      // A close may already have moved an OPEN lead to WON/LOST. Use the
      // existing all-status bounded read, never a receipt as current authority.
      const rows = await loadCrmLeads(organizationId, schoolId, selected ? undefined : status || undefined, signal);
      const original = familyRow ?? adult ?? selected;
      const current = original ? rows.find(r => r.id === original.id && r.primaryPersonId === original.primaryPersonId) : null;
      if (original && !current) throw new Error('The selected lead is not in the freshly authorized list. Information remains hidden. Close this local view and reload the school.');
      const family = familyRow && current ? await readFamilyEnrollment({ organizationId, schoolId }, current.id, current.primaryPersonId, signal) : null;
      const adultData = adult && current ? await readAdultRecovery({ organizationId, schoolId }, current.id, current.primaryPersonId, signal) : null;
      await verifyEnrollmentSession(sessionSubject, signal);
      if (generation !== privacyEpoch.current || signal.aborted || document.visibilityState === 'hidden') return;
      // Keep component keys stable so exact unknown requests survive; replace all
      // displayed authority/record facts with the fresh response before revealing.
      setLeads(rows);
      if (selected && current) { setCloseCurrent(current); setStatus(''); }
      else setSelected(null);
      if (familyRow && current && family) { setFamilyRow(current); setFamilyData(family); }
      if (adult && current && adultData) { setAdult(current); setResuming(true); setRecovery(adultData); }
      shielded.current = false; setConcealed(false);
    } catch (e) {
      if (generation !== privacyEpoch.current) return;
      if (e instanceof PlanAccessError || e instanceof AdultAccessError || e instanceof CrmLeadAccessError) accessLost();
      else setPrivacyError('CRM information remains hidden. The session, selected school and enrollment permissions could not all be verified. Retry verification or discard this local view.');
    } finally { if (generation === privacyEpoch.current) { restoreActive.current = false; setRestoring(false); } }
  }

  useEffect(() => { if (!concealed) privateArea.current?.querySelector<HTMLElement>('#family-flow-title, #adult-flow-title, #crm-close-title')?.focus(); }, [concealed]);

  // Command ownership survives read invalidation/blur, but not another panel,
  // scope, discard or session-mounted workbench instance.
  const closeInstance = closeEpoch.current;
  const ownsClose = (): boolean => closeOpen.current && closeInstance === closeEpoch.current;
  const membershipInstance = membershipEpoch.current;
  function reviewMembership(kind: 'adult' | 'family', leadId: string, selectors: KnownMembership): void {
    const current = membershipContext.current;
    if (!onMembershipReview || membershipInstance !== membershipEpoch.current || shielded.current || concealed || unsettled()
      || readActive.current || recoveryActive.current || familyReadActive.current || restoreActive.current || closeOpen.current
      || current[kind === 'adult' ? 'adultId' : 'familyId'] !== leadId
      || current.organizationId !== selectors.organizationId || current.schoolId !== selectors.schoolId) return;
    membershipEpoch.current++;
    // Only selectors leave CRM. No receipt, person, child, plan or permission is passed as authority.
    onMembershipReview({ organizationId: selectors.organizationId, schoolId: selectors.schoolId, membershipId: selectors.membershipId });
  }
  return <main className={styles.page}>
    <nav aria-label="Staff navigation"><CrmJourneyLink /><a href="/staff/billing/membership-plans">Membership plans</a><a href="/core">HON Core</a><a href="/staff/search">Staff search</a><a href="/staff/crm/follow-ups">CRM follow-ups</a><a href="/staff/crm/trials">Trial appointments</a><a href="/staff/command-center">School Command Center</a><a href="/auth/login">Sign in</a></nav>
    {concealed && <section className={privacyStyles.shield} aria-labelledby="crm-privacy-title" aria-busy={restoring}>
      <h2 id="crm-privacy-title" ref={shieldHeading} tabIndex={-1}>CRM information hidden</h2>
      <p>Focus or session access changed. CRM requests remain only in memory. No command will be resent automatically. Verify current access before revealing information.</p>
      <p>Verify your signed session, selected school and current CRM read and relevant enrollment permissions before revealing information.</p>
      {(familyBusy || adultBusy || closeBusy || createBusy) && <p role="status">An existing request is settling. You can verify access after it finishes. Local recovery cannot be discarded while a request is unsettled.</p>}
      {privacyError && <p role="alert">{privacyError}</p>}
      <button type="button" disabled={restoring || familyBusy || adultBusy || closeBusy || createBusy} onClick={() => void restorePrivateView()}>{restoring ? 'Verifying access…' : 'Verify access and resume'}</button>{' '}
      <CrmEnrollmentDiscard label="Discard local view" disabled={familyBusy || adultBusy || closeBusy || createBusy} onDiscard={discardLocalView} />
    </section>}
    <div onInputCapture={event => { if (!(event.target as HTMLElement).closest('[aria-labelledby="crm-lead-scope"]')) inputDirty.current = true; }} ref={privateArea} className={privacyStyles.sensitive} hidden={concealed} inert={concealed} aria-hidden={concealed || undefined}>
    <header><p>HUMAN CRM / LEADS</p><h1>Current school CRM leads</h1><p>A bounded, conventional CRM list. An earlier verified view may prefill untrusted UUIDs, but entries never grant access and no list is loaded until this page's server read verifies them.</p></header>
    <details className={privacyStyles.compact}><summary>CRM scope and workflow safeguards</summary><aside><strong>Explicit CRM intake; response-backed list; separate CRM-only close.</strong><p>The server returns at most 50 existing CRM lead summaries for the selected filter. A separate explicit intake form uses the canonical lead-create service. Only a freshly loaded returned OPEN row can prepare an explicit human WON/LOST close; never a creation receipt. Terminal CRM state is not enrollment or payment. The separate adult setup panel uses the verified registration, account and DRAFT APIs; it never activates membership or collects payment. The lead list itself does not move a pipeline stage, contact anyone, record a trial, book a class, create a student/family/enrollment/membership, accept consent, or invoke a provider, AI, Action Engine, automation, or external delivery.</p></aside>
    <section aria-labelledby="crm-lead-automation"><h2 id="crm-lead-automation">CRM automation</h2><p>These local automation tabs pass only a closed trigger prefill to a separate, idle Automation Rules draft. They do not load a rule or scope, create or revise configuration, dry-run or execute automation, or pass lead, appointment, contact, receipt, permission, or authority facts.</p><nav aria-label="CRM automation tabs" className={styles.actions}><a href="/staff/automation/rules?trigger=LEAD_CREATED">Lead automation</a><a href="/staff/automation/rules?trigger=TRIAL_NO_SHOW">No-show automation</a></nav></section>
    </details>
    <section aria-labelledby="crm-lead-scope"><h2 id="crm-lead-scope">Current school selectors / explicit list load</h2><form onSubmit={(event) => void load(event)}><fieldset disabled={loading || closeBusy || createBusy || adultBusy || familyBusy || familyLoading}><div className={styles.row}><label>Organization UUID<input required autoComplete="off" value={organizationId} onChange={(event) => { setOrganizationId(event.target.value); clear(); }} /></label><label>School UUID<input required autoComplete="off" value={schoolId} onChange={(event) => { setSchoolId(event.target.value); clear(); }} /></label><label>Status filter<select value={status} onChange={(event) => { setStatus(event.target.value as CrmLeadStatus | ''); clear(); }}><option value="">All current lead states</option><option value="OPEN">Open</option><option value="WON">Won</option><option value="LOST">Lost</option><option value="ARCHIVED">Archived</option></select></label></div><button disabled={adult !== null || familyRow !== null || selected !== null}>{loading ? 'Verifying school…' : 'Load CRM leads'}</button></fieldset></form>{error && <p className={styles.error} role="alert">{error}</p>}{!leads && !loading && !error && <p role="status">No verified school list is loaded.</p>}</section>
    <div hidden={adult !== null || familyRow !== null}><CrmLeadCreatePanel key={`${organizationId}:${schoolId}:${draftEpoch}`} organizationId={organizationId} schoolId={schoolId} disabled={loading || closeBusy || selected !== null || adult !== null || familyRow !== null} onStarted={() => { setNeedsReload(true); setSelected(null); }} onBusy={value => busy('create', value)} onAccessLost={accessLost} /></div>
    {needsReload && <p role="status">Loaded list snapshot only — not refreshed after a close or create attempt. No row status, filter membership or count has been inferred. Explicitly reload to verify current CRM facts. {familyRow ? 'Close family setup first if it is open.' : 'Close adult setup first if it is open.'}</p>}
    {adult && (resuming && !recovery ? <CrmAdultRecoveryPending row={adult} busy={recovering} error={recoveryError} onRetry={() => void resume(adult)} onCancel={closeAdult} />
      : <CrmAdultFlow key={`${organizationId}:${schoolId}:${adult.id}:${draftEpoch}`} row={adult} organizationId={organizationId} schoolId={schoolId} {...(recovery ? { initialRecovery: recovery } : {})} onRecover={() => void resume(adult)} {...(onMembershipReview ? { onMembershipReview: (selectors: KnownMembership) => reviewMembership('adult', adult.id, selectors) } : {})} onCancel={closeAdult} onBusy={value => busy('adult', value)} onStarted={() => setNeedsReload(true)} onAccessLost={accessLost} />)}
    {familyRow && (familyData ? <CrmFamilyFlow key={`${organizationId}:${schoolId}:${familyRow.id}:${draftEpoch}`} scope={{ organizationId, schoolId }} row={familyRow} initialFamily={familyData} {...(onMembershipReview ? { onMembershipReview: (selectors: KnownMembership) => reviewMembership('family', familyRow.id, selectors) } : {})} onCancel={closeFamily} onBusy={value => busy('family', value)} onStarted={() => setNeedsReload(true)} onAccessLost={accessLost} onAdult={() => { const lead = familyRow; closeFamily(); void resume(lead, true); }} />
      : <section aria-labelledby="family-recovery-title" aria-busy={familyLoading}><h2 id="family-recovery-title" tabIndex={-1} ref={familyHeading}>Resume family setup for {familyRow.givenName} {familyRow.familyName}</h2>{familyLoading && <p role="status">Checking current family setup. No records are being created.</p>}{familyError && <p role="alert">{familyError}</p>}{!familyLoading && <button type="button" onClick={() => void resumeFamily(familyRow)}>Retry family setup read</button>}<button type="button" onClick={closeFamily}>Close family setup</button></section>)}
    {selected && <CrmLeadClosePanel key={`${organizationId}:${schoolId}:${selected.id}:${closeInstance}`} row={selected} currentRow={closeCurrent ?? selected} organizationId={organizationId} schoolId={schoolId} onStarted={() => { if (ownsClose()) setNeedsReload(true); }} onBusy={value => { if (ownsClose()) busy('close', value); }} onCancel={() => { if (!ownsClose() || activity.current.close) return; closeEpoch.current++; closeOpen.current = false; setSelected(null); setCloseCurrent(null); }} />}
    {leads && <section aria-labelledby="crm-lead-results"><h2 id="crm-lead-results">{leads.length === 0 ? 'No matching CRM leads' : `${leads.length} verified CRM ${leads.length === 1 ? 'lead' : 'leads'}`}</h2><p>Contact facts are the existing protected lead-list projection for this authorized current-school read. A trial handoff does not load or create an appointment; a follow-up handoff likewise only pre-fills an untrusted UUID after its own queue is authorized.</p>{leads.map((lead) => <article className={styles.row} key={lead.id}><div><strong>{lead.givenName} {lead.familyName}</strong><p>Status: {lead.status} · lead v{lead.version}</p><p>Email: {lead.email ?? 'Not recorded'} · Phone: {lead.phoneE164 ?? 'Not recorded'}</p><p>Next follow-up: {lead.nextFollowUpAt ? date(lead.nextFollowUpAt) : 'Not scheduled'} · Created: {date(lead.createdAt)}</p><p><code>{lead.id}</code></p></div><div className={styles.actions}>{lead.status === 'OPEN' && <button type="button" disabled={needsReload || closeBusy || createBusy || adult !== null || familyRow !== null || selected !== null} onClick={() => { if (unsettled() || closeOpen.current) return; closeEpoch.current++; closeOpen.current = true; setSelected(lead); setCloseCurrent(lead); }}>Prepare CRM-only close</button>}{lead.status !== 'ARCHIVED' && <button type="button" disabled={needsReload || closeBusy || createBusy || adult !== null || familyRow !== null || selected !== null} onClick={() => { if (unsettled() || closeOpen.current) return; setAdult(lead); setSelected(null); }}>Set up adult membership</button>}{lead.status !== 'ARCHIVED' && <button type="button" disabled={needsReload || closeBusy || createBusy || adult !== null || familyRow !== null || selected !== null} onClick={() => void resume(lead)}>Resume setup</button>}{lead.status !== 'ARCHIVED' && <button type="button" disabled={needsReload || closeBusy || createBusy || adult !== null || familyRow !== null || selected !== null} onClick={() => void resumeFamily(lead)}>Set up / resume family</button>}<CrmJourneyLink organizationId={organizationId} schoolId={schoolId} leadId={lead.id} /><a href={trialHref(organizationId, schoolId, lead.id)}>Prepare trial appointment</a>{crmFollowUpHref(lead.id) && <a href={crmFollowUpHref(lead.id)}>Create human follow-up</a>}</div></article>)}</section>}
    </div>
  </main>;
}
