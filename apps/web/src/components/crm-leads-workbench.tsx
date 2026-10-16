'use client';

import React, { useState, type FormEvent } from 'react';
import type { LeadListItem } from '@hon/contracts';
import { CrmLeadAccessError, loadCrmLeads, type CrmLeadStatus } from './crm-leads-http';
import styles from './staff-availability-workbench.module.css';

function trialHref(organizationId: string, schoolId: string, leadId: string): string {
  return `/staff/crm/trials?${new URLSearchParams({ organizationId, schoolId, leadId }).toString()}`;
}

export type CrmLeadsInitialScope = { organizationId?: string | undefined; schoolId?: string | undefined };

export function CrmLeadsWorkbench({ initialScope = {} }: { initialScope?: CrmLeadsInitialScope } = {}): React.ReactElement {
  const [organizationId, setOrganizationId] = useState(initialScope.organizationId ?? '');
  const [schoolId, setSchoolId] = useState(initialScope.schoolId ?? '');
  const [status, setStatus] = useState<CrmLeadStatus | ''>('OPEN');
  const [leads, setLeads] = useState<LeadListItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  function clear(): void { setLeads(null); setError(''); }
  async function load(event: FormEvent): Promise<void> {
    event.preventDefault(); setLoading(true); clear();
    try { setLeads(await loadCrmLeads(organizationId, schoolId, status || undefined)); }
    catch (caught) { setLeads(null); setError(caught instanceof Error ? caught.message : 'No verified CRM lead list.'); }
    finally { setLoading(false); }
  }

  return <main className={styles.page}>
    <nav aria-label="Staff navigation"><a href="/core">HON Core</a><a href="/staff/search">Staff search</a><a href="/staff/crm/follow-ups">CRM follow-ups</a><a href="/staff/crm/trials">Trial appointments</a><a href="/staff/command-center">School Command Center</a><a href="/auth/login">Sign in</a></nav>
    <header><p>HUMAN CRM / LEADS</p><h1>Current school CRM leads</h1><p>A bounded, conventional CRM list. An earlier verified view may prefill untrusted UUIDs, but entries never grant access and no list is loaded until this page's server read verifies them.</p></header>
    <aside><strong>Read-only list.</strong><p>The server returns at most 50 existing CRM lead summaries for the selected filter. This view does not create/edit a lead, move a pipeline stage, contact anyone, record a trial, book a class, create a student/family/enrollment/membership, accept consent, or invoke a provider, AI, Action Engine, automation, or external delivery.</p></aside>
    <section aria-labelledby="crm-lead-scope"><h2 id="crm-lead-scope">Load current school leads</h2><form onSubmit={(event) => void load(event)}><fieldset disabled={loading}><div className={styles.row}><label>Organization UUID<input required autoComplete="off" value={organizationId} onChange={(event) => { setOrganizationId(event.target.value); clear(); }} /></label><label>School UUID<input required autoComplete="off" value={schoolId} onChange={(event) => { setSchoolId(event.target.value); clear(); }} /></label><label>Status filter<select value={status} onChange={(event) => { setStatus(event.target.value as CrmLeadStatus | ''); clear(); }}><option value="">All current lead states</option><option value="OPEN">Open</option><option value="WON">Won</option><option value="LOST">Lost</option><option value="ARCHIVED">Archived</option></select></label></div><button>{loading ? 'Verifying school…' : 'Load CRM leads'}</button></fieldset></form>{error && <p className={styles.error} role="alert">{error}</p>}{!leads && !loading && !error && <p role="status">No verified school list is loaded.</p>}</section>
    {leads && <section aria-labelledby="crm-lead-results"><h2 id="crm-lead-results">{leads.length === 0 ? 'No matching CRM leads' : `${leads.length} verified CRM ${leads.length === 1 ? 'lead' : 'leads'}`}</h2><p>Contact facts are the existing protected lead-list projection for this authorized current-school read. A trial handoff only pre-fills untrusted UUIDs; it does not load or create an appointment.</p>{leads.map((lead) => <article className={styles.row} key={lead.id}><div><strong>{lead.givenName} {lead.familyName}</strong><p>Status: {lead.status} · lead v{lead.version}</p><p>Email: {lead.email ?? 'Not recorded'} · Phone: {lead.phoneE164 ?? 'Not recorded'}</p><p>Next follow-up: {lead.nextFollowUpAt ?? 'Not scheduled'} · Created: {lead.createdAt}</p><p><code>{lead.id}</code></p></div><a href={trialHref(organizationId, schoolId, lead.id)}>Prepare trial appointment</a></article>)}</section>}
  </main>;
}
