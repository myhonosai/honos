'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import type { CrmIntakeStage, LeadListItem } from '@hon/contracts';
import { loadCurrentStaffReportingSchool, type CurrentStaffReportingSchool } from './current-staff-reporting-school-http';
import { loadStaffReportingSchools, type StaffReportingSchoolChoice, type StaffReportingSchools } from './staff-reporting-schools-http';
import { CrmIntakeStagesAccessError, loadCrmIntakeStages } from './crm-intake-stages-http';
import { CrmLeadAccessError, loadCrmLeads, type CrmLeadStatus } from './crm-leads-http';
import { crmFollowUpHref } from './crm-follow-up-handoff';
import { CrmLeadClosePanel } from './crm-lead-close-panel';
import { CrmLeadCreatePanel } from './crm-lead-create-panel';
import styles from './staff-availability-workbench.module.css';

function trialHref(organizationId: string, schoolId: string, leadId: string): string {
  return `/staff/crm/trials?${new URLSearchParams({ organizationId, schoolId, leadId }).toString()}`;
}
type CrmScope = { organizationId: string; schoolId: string };
type ScopeState = 'RESOLVING' | 'SELECTION_REQUIRED' | 'STAGE_LOADING' | 'READY' | 'UNAVAILABLE';

/** URL scope prefill remains inert; only server-authoritative staff scope reads can select CRM context. */
export type CrmLeadsInitialScope = { organizationId?: string | undefined; schoolId?: string | undefined };

export function CrmLeadsWorkbench({ initialScope = {} }: { initialScope?: CrmLeadsInitialScope } = {}): React.ReactElement {
  void initialScope;
  const [scope, setScope] = useState<CrmScope | null>(null);
  const [scopeState, setScopeState] = useState<ScopeState>('RESOLVING');
  const [scopeMessage, setScopeMessage] = useState('Resolving current staff CRM scope…');
  const [schoolChoices, setSchoolChoices] = useState<StaffReportingSchoolChoice[]>([]);
  const [schoolChoiceId, setSchoolChoiceId] = useState('');
  const [intakeStages, setIntakeStages] = useState<CrmIntakeStage[] | null>(null);
  const [intakeStagesMessage, setIntakeStagesMessage] = useState('A verified current CRM school is required before configured intake stages can be read.');
  const [status, setStatus] = useState<CrmLeadStatus | ''>('OPEN');
  const [leads, setLeads] = useState<LeadListItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<LeadListItem | null>(null);
  const [closeBusy, setCloseBusy] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [draftEpoch, setDraftEpoch] = useState(0);
  const [scopeReload, setScopeReload] = useState(0);
  const readEpoch = useRef(0);
  const readActive = useRef(false);
  const scopeEpoch = useRef(0);
  const resolverRead = useRef<Promise<CurrentStaffReportingSchool> | null>(null);
  const selectorRead = useRef<Promise<StaffReportingSchools> | null>(null);

  function clearList(): void {
    readEpoch.current++; readActive.current = false; setLoading(false);
    setLeads(null); setError(''); setSelected(null); setNeedsReload(false); setDraftEpoch(value => value + 1);
  }
  function accessLost(): void {
    scopeEpoch.current++; resolverRead.current = null; selectorRead.current = null; clearList(); setScope(null); setScopeState('UNAVAILABLE'); setSchoolChoices([]); setSchoolChoiceId(''); setIntakeStages(null);
    setIntakeStagesMessage('Current human CRM intake access is unavailable. No school or stage is selected.');
    setCreateBusy(false); setCloseBusy(false); setError('Human session or current school authority unavailable. Scoped list, draft, retry and receipt discarded.');
  }
  async function verifyCrmScope(next: CrmScope): Promise<void> {
    const generation = ++scopeEpoch.current;
    clearList(); setScope(null); setSchoolChoiceId(''); setIntakeStages(null); setScopeState('STAGE_LOADING');
    setScopeMessage('Verifying CRM intake access and reading configured stages for the selected school…');
    setIntakeStagesMessage('Verifying the current human, exact school, CRM entitlement and lead-create permission before configured intake stages are shown.');
    try {
      const stages = await loadCrmIntakeStages(next.organizationId, next.schoolId);
      if (generation !== scopeEpoch.current) return;
      setScope(next); setIntakeStages(stages); setScopeState('READY');
      setScopeMessage('Current CRM school verified. The configured intake-stage choices below are bounded and memory-only.');
      setIntakeStagesMessage(stages.length === 0
        ? 'No configured non-terminal CRM intake stage is available for this verified school.'
        : 'Choose one configured non-terminal stage before preparing an explicit CRM lead-create command.');
    } catch (caught) {
      if (generation !== scopeEpoch.current) return;
      if (caught instanceof CrmIntakeStagesAccessError) { accessLost(); return; }
      setScope(null); setIntakeStages(null); setScopeState('UNAVAILABLE');
      setScopeMessage('Current CRM intake scope could not be verified. No school or intake stage is selected.');
      setIntakeStagesMessage('Configured intake stages are unavailable. No create action is shown.');
      setError(caught instanceof Error ? caught.message : 'CRM intake-stage access is unavailable.');
    }
  }
  useEffect(() => {
    let active = true;
    const generation = ++scopeEpoch.current;
    const current = (): boolean => active && generation === scopeEpoch.current;
    resolverRead.current ??= loadCurrentStaffReportingSchool();
    void resolverRead.current.then(async (resolved) => {
      if (!current()) return;
      if (resolved.state === 'RESOLVED') {
        await verifyCrmScope({ organizationId: resolved.organizationId, schoolId: resolved.schoolId });
        return;
      }
      selectorRead.current ??= loadStaffReportingSchools();
      const choices = await selectorRead.current;
      if (!current()) return;
      if (choices.state === 'SELECTION_REQUIRED') {
        setSchoolChoices(choices.schools); setSchoolChoiceId(''); setScope(null); setIntakeStages(null); setScopeState('SELECTION_REQUIRED');
        setScopeMessage('Choose one authorized reporting school for CRM. No school, stage or lead list is selected automatically.');
        setIntakeStagesMessage('Choose an authorized school before configured intake stages can be read.');
      } else {
        setSchoolChoices([]); setScope(null); setIntakeStages(null); setScopeState('UNAVAILABLE');
        setScopeMessage('A safe ordinary-staff CRM scope is unavailable. No school candidates or CRM data are shown.');
        setIntakeStagesMessage('Configured intake stages are unavailable. No create action is shown.');
      }
    }).catch((caught) => {
      if (!current()) return;
      setScope(null); setSchoolChoices([]); setIntakeStages(null); setScopeState('UNAVAILABLE');
      setScopeMessage('Current CRM staff scope is unavailable. No school, stage or lead list is selected.');
      setIntakeStagesMessage('Configured intake stages are unavailable. No create action is shown.');
      setError(caught instanceof Error ? caught.message : 'Current CRM staff scope is unavailable.');
    });
    return () => { active = false; scopeEpoch.current++; };
  }, [scopeReload]);
  useEffect(() => {
    const leave = (): void => {
      scopeEpoch.current++; resolverRead.current = null; selectorRead.current = null; clearList(); setScope(null); setSchoolChoices([]); setSchoolChoiceId(''); setIntakeStages(null);
      setScopeState('RESOLVING'); setScopeMessage('CRM scope was cleared while this page was inactive. Re-verifying current staff authority before showing CRM data.');
      setIntakeStagesMessage('No school or intake stage remains selected while this page is inactive.'); setCreateBusy(false); setCloseBusy(false);
    };
    const resume = (): void => { if (document.visibilityState === 'visible') setScopeReload(value => value + 1); };
    const visibility = (): void => { if (document.visibilityState === 'hidden') leave(); else resume(); };
    window.addEventListener('pagehide', leave); window.addEventListener('blur', leave); window.addEventListener('pageshow', resume); window.addEventListener('focus', resume); document.addEventListener('visibilitychange', visibility);
    return () => { readEpoch.current++; scopeEpoch.current++; window.removeEventListener('pagehide', leave); window.removeEventListener('blur', leave); window.removeEventListener('pageshow', resume); window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  async function chooseSchool(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (scopeState !== 'SELECTION_REQUIRED') return;
    const choice = schoolChoices.find((school) => school.schoolId === schoolChoiceId);
    if (!choice) { setError('Choose an authorized school before using CRM.'); return; }
    await verifyCrmScope({ organizationId: choice.organizationId, schoolId: choice.schoolId });
  }
  async function load(event: FormEvent): Promise<void> {
    event.preventDefault(); if (!scope || scopeState !== 'READY' || closeBusy || createBusy || readActive.current) return;
    clearList(); const generation = readEpoch.current; readActive.current = true; setLoading(true);
    try { const rows = await loadCrmLeads(scope.organizationId, scope.schoolId, status || undefined); if (generation === readEpoch.current) setLeads(rows); }
    catch (caught) {
      if (generation !== readEpoch.current) return;
      if (caught instanceof CrmLeadAccessError) accessLost();
      else { setLeads(null); setError(caught instanceof Error ? caught.message : 'No verified CRM lead list.'); }
    } finally { if (generation === readEpoch.current) { readActive.current = false; setLoading(false); } }
  }

  const snapshotEpoch = readEpoch.current;
  const choiceNames = schoolChoices.find((choice) => choice.schoolId === scope?.schoolId);
  return <main className={styles.page}>
    <nav aria-label="Staff navigation"><a href="/core">HON Core</a><a href="/staff/search">Staff search</a><a href="/staff/crm/follow-ups">CRM follow-ups</a><a href="/staff/crm/trials">Trial appointments</a><a href="/staff/command-center">School Command Center</a><a href="/auth/login">Sign in</a></nav>
    <header><p>HUMAN CRM / LEADS</p><h1>Current school CRM leads</h1><p>A bounded, conventional CRM list. Current staff scope comes only from the existing server-authoritative reporting-school reads; it never comes from an entered or URL-supplied identifier, and no list is loaded until this page&apos;s explicit server read verifies it.</p></header>
    <aside><strong>Explicit CRM intake; response-backed list; separate CRM-only close.</strong><p>The server returns at most 50 existing CRM lead summaries for the selected filter. A separate explicit intake form uses the canonical lead-create service and a bounded configured stage read. Only a freshly loaded returned OPEN row can prepare an explicit human WON/LOST close; never a creation receipt. Terminal CRM state is not enrollment or payment. This view does not move a pipeline stage, contact anyone, record a trial, book a class, create a student/family/enrollment/membership, accept consent, or invoke a provider, AI, Action Engine, automation, or external delivery.</p></aside>
    <section aria-labelledby="crm-lead-automation"><h2 id="crm-lead-automation">CRM automation</h2><p>These local automation tabs pass only a closed trigger prefill to a separate, idle Automation Rules draft. They do not load a rule or scope, create or revise configuration, dry-run or execute automation, or pass lead, appointment, contact, receipt, permission, or authority facts.</p><nav aria-label="CRM automation tabs" className={styles.actions}><a href="/staff/automation/rules?trigger=LEAD_CREATED">Lead automation</a><a href="/staff/automation/rules?trigger=TRIAL_NO_SHOW">No-show automation</a></nav></section>
    <section aria-labelledby="crm-lead-scope"><h2 id="crm-lead-scope">Current school CRM context</h2><p>Current staff scope is re-resolved for this view. A listed school name is a selection aid only: each CRM read and command independently verifies the current human, exact school, permission and entitlement.</p>
      {scopeState === 'SELECTION_REQUIRED' && <form onSubmit={(event) => void chooseSchool(event)}><fieldset disabled={loading || closeBusy || createBusy}><label>Authorized school<select required autoComplete="off" value={schoolChoiceId} onChange={(event) => { clearList(); setSchoolChoiceId(event.target.value); setError(''); }}><option value="">Choose a school…</option>{schoolChoices.map((school) => <option key={school.schoolId} value={school.schoolId}>{school.schoolName} — {school.organizationName}</option>)}</select></label><button disabled={!schoolChoiceId}>Use selected school for CRM</button></fieldset></form>}
      {scopeState === 'READY' && <p role="status"><strong>Verified current CRM school.</strong>{choiceNames ? ` ${choiceNames.schoolName} — ${choiceNames.organizationName}.` : ' Current staff scope is verified for CRM intake.'} {scopeMessage}</p>}
      {scopeState !== 'READY' && scopeState !== 'SELECTION_REQUIRED' && <p role="status">{scopeMessage}</p>}
      <form onSubmit={(event) => void load(event)}><fieldset disabled={loading || closeBusy || createBusy || scopeState !== 'READY'}><div className={styles.row}><label>Status filter<select value={status} onChange={(event) => { setStatus(event.target.value as CrmLeadStatus | ''); clearList(); }}><option value="">All current lead states</option><option value="OPEN">Open</option><option value="WON">Won</option><option value="LOST">Lost</option><option value="ARCHIVED">Archived</option></select></label></div><button>{loading ? 'Verifying school…' : 'Load CRM leads'}</button></fieldset></form>{error && <p className={styles.error} role="alert">{error}</p>}{!leads && !loading && !error && <p role="status">No verified school list is loaded.</p>}</section>
    <CrmLeadCreatePanel key={`${scope?.organizationId ?? 'none'}:${scope?.schoolId ?? 'none'}:${draftEpoch}`} organizationId={scope?.organizationId ?? ''} schoolId={scope?.schoolId ?? ''} intakeStages={scopeState === 'READY' ? intakeStages : null} intakeStagesMessage={intakeStagesMessage} disabled={scopeState !== 'READY' || loading || closeBusy || selected !== null} onStarted={() => { setNeedsReload(true); setSelected(null); }} onBusy={setCreateBusy} onAccessLost={accessLost} />
    {needsReload && <p role="status">Loaded list snapshot only — not refreshed after a close or create attempt. No row status, filter membership or count has been inferred. Explicitly reload to verify current CRM facts.</p>}
    {selected && scope && <CrmLeadClosePanel key={selected.id} row={selected} organizationId={scope.organizationId} schoolId={scope.schoolId} onStarted={() => setNeedsReload(true)} onBusy={busy => { if (snapshotEpoch === readEpoch.current) setCloseBusy(busy); }} onCancel={() => setSelected(null)} />}
    {leads && scope && <section aria-labelledby="crm-lead-results"><h2 id="crm-lead-results">{leads.length === 0 ? 'No matching CRM leads' : `${leads.length} verified CRM ${leads.length === 1 ? 'lead' : 'leads'}`}</h2><p>Contact facts are the existing protected lead-list projection for this authorized current-school read. A trial handoff does not load or create an appointment; a follow-up handoff likewise only pre-fills an untrusted UUID after its own queue is authorized.</p>{leads.map((lead) => <article className={styles.row} key={lead.id}><div><strong>{lead.givenName} {lead.familyName}</strong><p>Status: {lead.status} · lead v{lead.version}</p><p>Email: {lead.email ?? 'Not recorded'} · Phone: {lead.phoneE164 ?? 'Not recorded'}</p><p>Next follow-up: {lead.nextFollowUpAt ?? 'Not scheduled'} · Created: {lead.createdAt}</p></div><div className={styles.actions}>{lead.status === 'OPEN' && <button type="button" disabled={needsReload || closeBusy || createBusy || selected !== null} onClick={() => setSelected(lead)}>Prepare CRM-only close</button>}<a href={trialHref(scope.organizationId, scope.schoolId, lead.id)}>Prepare trial appointment with this untrusted lead selection</a>{crmFollowUpHref(lead.id) && <a href={crmFollowUpHref(lead.id)}>Create human follow-up</a>}</div></article>)}</section>}
  </main>;
}
