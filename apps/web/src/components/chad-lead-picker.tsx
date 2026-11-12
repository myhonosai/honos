'use client';
import React, { useEffect, useId, useState } from 'react';
import type { LeadListItem } from '@hon/contracts';
import { LeadsError, leadsApi, type LeadsApi, type LeadsScope } from './leads/http';

/**
 * Owner decision 2026-11-12: Chad's page lists the verified shell school's OPEN leads through the existing CRM lead
 * list read (crm.lead.read), so staff pick a lead by name instead of typing its ID and version. Names stay on this page:
 * Chad's request still carries only the lead ID, the observed version and the purpose, and the server re-checks both.
 */
export type ChadLeadPickerState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; items: readonly LeadListItem[] };

export async function loadOpenLeads(api: Pick<LeadsApi, 'list'>, scope: LeadsScope, signal: AbortSignal, owned: () => boolean): Promise<LeadListItem[]> {
  const leads = await api.list(scope, 'OPEN', signal, owned);
  return leads.filter(lead => lead.status === 'OPEN');
}

export function leadPickLabel(lead: LeadListItem, language: string): string {
  const who = `${lead.givenName} ${lead.familyName}`.trim() || 'Unnamed lead';
  const added = new Date(lead.createdAt).toLocaleDateString(language, { dateStyle: 'medium', timeZone: 'UTC' });
  return `${who} · added ${added}`;
}

export function matchesLeadSearch(lead: LeadListItem, search: string): boolean {
  const needle = search.trim().toLowerCase();
  return !needle || `${lead.givenName} ${lead.familyName}`.toLowerCase().includes(needle);
}

export function ChadLeadPickerView({ state, leadId, search, disabled, language = 'en', onPick, onSearch, onReload }: {
  state: ChadLeadPickerState; leadId: string; search: string; disabled: boolean; language?: string;
  onPick?: (lead: LeadListItem) => void; onSearch?: (text: string) => void; onReload?: () => void;
}): React.ReactElement {
  const ids = { search: useId(), lead: useId() };
  if (state.state !== 'READY') return <><p role="status">{state.state === 'LOADING' ? 'Reading open leads…' : state.state === 'DENIED' ? 'Your access does not include this school’s leads. Nothing is shown.' : 'Open leads could not be loaded. Nothing is shown.'}</p>
    {state.state !== 'LOADING' && <button type="button" disabled={disabled} onClick={onReload}>Reload leads</button>}</>;
  if (!state.items.length) return <p role="status">There are no open leads at this school. Add one from the Leads page first.</p>;
  const shown = state.items.filter(lead => matchesLeadSearch(lead, search) || lead.id === leadId);
  return <>
    <label htmlFor={ids.search}>Find a lead</label>
    <input id={ids.search} type="search" autoComplete="off" maxLength={120} value={search} disabled={disabled} onChange={(e) => onSearch?.(e.target.value)}/>
    <label htmlFor={ids.lead}>Lead</label>
    <select id={ids.lead} required value={leadId} disabled={disabled} onChange={(e) => { const lead = state.items.find(item => item.id === e.target.value); if (lead) onPick?.(lead); }}>
      <option value="">Choose an open lead</option>
      {shown.map(lead => <option key={lead.id} value={lead.id}>{leadPickLabel(lead, language)}</option>)}
    </select>
  </>;
}

export function ChadLeadPicker({ scope, leadId, disabled, onPick, api = leadsApi }: {
  scope: LeadsScope; leadId: string; disabled: boolean; onPick: (lead: LeadListItem) => void; api?: Pick<LeadsApi, 'list'>;
}): React.ReactElement {
  const [state, setState] = useState<ChadLeadPickerState>({ state: 'LOADING' });
  const [search, setSearch] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let current = true; const abort = new AbortController();
    setState({ state: 'LOADING' });
    loadOpenLeads(api, scope, AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]), () => current).then(
      (items) => { if (current) setState({ state: 'READY', items }); },
      (error) => { if (current && !abort.signal.aborted) setState({ state: error instanceof LeadsError && (error.kind === 'DENIED' || error.kind === 'SESSION') ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { current = false; abort.abort(); };
  }, [scope.organizationId, scope.schoolId, reload, api]); // eslint-disable-line react-hooks/exhaustive-deps
  return <ChadLeadPickerView state={state} leadId={leadId} search={search} disabled={disabled} onPick={onPick} onSearch={setSearch} onReload={() => setReload(n => n + 1)}/>;
}
