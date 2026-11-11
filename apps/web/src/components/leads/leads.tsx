'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { AddLead } from './add-lead';
import type { AddLeadApi } from './add-lead-http';
import { LeadsError, leadsApi, type LeadsApi } from './http';
import { LeadsView, tabStatus, type LeadTab, type ListState, type TrialState } from './view';

/**
 * Leads for the school the shell verified (U4): a status-tabbed list, a local name filter, and one lead's contact,
 * trials and links into the existing CRM flows. Adding a lead (and the starter lead stages a new school needs first) goes
 * through the existing human lead-create command; every other change happens in the CRM flows linked here. Blur, a hidden tab, page hide, a school change or a session
 * end hide the page at once and retire every read; reads start again only after the shell re-verifies the school.
 */
export function Leads({ api = leadsApi, addLeadApi }: { api?: LeadsApi; addLeadApi?: AddLeadApi }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const [tab, setTab] = useState<LeadTab>('OPEN');
  const [list, setList] = useState<ListState>({ state: 'LOADING' });
  const [listRefresh, setListRefresh] = useState(0);
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [trials, setTrials] = useState<TrialState>({ state: 'NONE' });
  const [trialsRefresh, setTrialsRefresh] = useState(0);
  const listGeneration = useRef(0), trialGeneration = useRef(0), privacy = useRef(0), mounted = useRef(false), lastSchool = useRef<string | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; listGeneration.current++; trialGeneration.current++; }; }, []);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); listGeneration.current++; trialGeneration.current++; privacy.current++;
    setList({ state: 'LOADING' }); setTrials({ state: 'NONE' }); setFilter('');
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  const school = selection ? selection.schoolId.toLowerCase() : null;
  useEffect(() => {
    if (school !== null && lastSchool.current !== null && school !== lastSchool.current) { setSelectedId(null); setFilter(''); setTab('OPEN'); }
    if (school !== null) lastSchool.current = school;
  }, [school]);

  useEffect(() => {
    const current = ++listGeneration.current, shown = privacy.current;
    setList({ state: 'LOADING' });
    if (!selection) return;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    const owned = () => mounted.current && current === listGeneration.current && shown === privacy.current;
    api.list({ organizationId: selection.organizationId, schoolId: selection.schoolId }, tabStatus(tab), signal, owned).then(
      (items) => { if (owned()) { setList({ state: 'READY', tab, items }); setSelectedId((now) => now && items.some((lead) => lead.id === now) ? now : null); } },
      (error) => { if (owned() && !abort.signal.aborted) setList({ state: error instanceof LeadsError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [selection?.organizationId, selection?.schoolId, tab, listRefresh, api]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const current = ++trialGeneration.current, shown = privacy.current;
    if (!selectedId || !selection) { setTrials({ state: 'NONE' }); return; }
    setTrials({ state: 'LOADING' });
    const abort = new AbortController(), leadId = selectedId;
    const owned = () => mounted.current && current === trialGeneration.current && shown === privacy.current;
    api.trials({ organizationId: selection.organizationId, schoolId: selection.schoolId }, leadId, abort.signal).then(
      (recovery) => { if (owned()) setTrials({ state: 'READY', leadId, recovery }); },
      (error) => { if (owned() && !abort.signal.aborted) setTrials({ state: error instanceof LeadsError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [selection?.organizationId, selection?.schoolId, selectedId, trialsRefresh, api]); // eslint-disable-line react-hooks/exhaustive-deps

  const onTab = useCallback((next: LeadTab) => { setTab(next); setFilter(''); setListRefresh((n) => n + 1); }, []);
  const onOpen = useCallback((leadId: string) => { setSelectedId(leadId); setTrialsRefresh((n) => n + 1); }, []);
  const onRefresh = useCallback(() => { setListRefresh((n) => n + 1); setTrialsRefresh((n) => n + 1); }, []);
  const onReloadTrials = useCallback(() => setTrialsRefresh((n) => n + 1), []);
  // A new lead is OPEN: show the Open tab so the person sees who they just added.
  const onAdded = useCallback(() => { setTab('OPEN'); setFilter(''); setListRefresh((n) => n + 1); }, []);

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <LeadsView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      scope={selection ? { organizationId: selection.organizationId, schoolId: selection.schoolId } : null} tab={tab} list={list} filter={filter}
      selectedId={selectedId} trials={trials} onTab={onTab} onFilter={setFilter} onOpen={onOpen} onRefresh={onRefresh} onReloadTrials={onReloadTrials}
      addLead={selection ? <AddLead key={selection.schoolId.toLowerCase()} scope={{ organizationId: selection.organizationId, schoolId: selection.schoolId }} language={preferences.language} onAdded={onAdded} {...(addLeadApi ? { api: addLeadApi } : {})}/> : null}/>
  </div>;
}
