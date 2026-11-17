'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CrmBoardStatus, LeadListItem } from '@hon/contracts';
import { CrmLeadCloseRejectedError, prepareCrmLeadClose, submitCrmLeadClose, type PreparedCrmLeadClose } from '../crm-lead-close-http';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { AddLead } from '../leads/add-lead';
import type { AddLeadApi } from '../leads/add-lead-http';
import { LeadsError, leadsApi, type LeadsApi } from '../leads/http';
import { pipelineText, type PipelineKey } from './copy';
import { BoardCommandError, BoardError, boardApi, prepareMove, prepareSave, type BoardApi, type PreparedCommand } from './http';
import { applyMove, draftFrom, draftInput, fullName, type BoardView, type Filters } from './model';
import { PipelineView, type BoardState, type CloseState, type EditState, type Notice, type TrialState } from './view';

const SAVE_REASON: Record<string, PipelineKey> = {
  CRM_STAGE_NAME_TAKEN: 'errName', CRM_STAGE_VISIBLE_REQUIRED: 'errVisible', CRM_STAGE_MOVE_REQUIRED: 'errMove', VALIDATION_FAILED: 'errName',
};
const FILTERS: Filters = Object.freeze({ search: '', program: '', sort: 'NEWEST' });

/** A board lead in the shape the existing close command checks: only id, status and version are read from it. */
function closeRow(lead: { id: string; status: LeadListItem['status']; version: number; stageId: string; personId: string; createdAt: string; givenName: string; familyName: string }): LeadListItem {
  return { id: lead.id, status: lead.status, version: lead.version, pipelineStageId: lead.stageId, primaryPersonId: lead.personId, createdAt: lead.createdAt, givenName: lead.givenName, familyName: lead.familyName };
}

/**
 * Leads as one pipeline board (0417) for the school the shell verified: stats, filters, board and list, a lead panel,
 * moving a lead between stages, closing it as won or lost through the existing close command, editing the stages and
 * adding a lead. Blur, a hidden tab, page hide, a school change or a session end hide the page at once, retire every read
 * and drop every retained command; reads start again only after the shell re-verifies the school.
 */
export function LeadPipeline({ api = boardApi, leads = leadsApi, addLeadApi, closeSubmit = submitCrmLeadClose }: {
  api?: BoardApi; leads?: LeadsApi; addLeadApi?: AddLeadApi; closeSubmit?: typeof submitCrmLeadClose;
}): React.ReactElement {
  const { preferences } = useLocale();
  const language = preferences.language;
  const t = useCallback((key: PipelineKey, vars?: Record<string, string>) => pipelineText(language, key, vars), [language]);
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const scope = selection ? { organizationId: selection.organizationId, schoolId: selection.schoolId } : null;
  const [status, setStatus] = useState<CrmBoardStatus>('OPEN');
  const [pipelineId, setPipelineId] = useState<string | null>(null);
  const [board, setBoard] = useState<BoardState>({ state: 'LOADING' });
  const [refresh, setRefresh] = useState(0);
  const [filters, setFilters] = useState<Filters>(FILTERS);
  const [view, setView] = useState<BoardView>('BOARD');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [trials, setTrials] = useState<TrialState>({ state: 'NONE' });
  const [trialsRefresh, setTrialsRefresh] = useState(0);
  const [notice, setNotice] = useState<Notice>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [close, setClose] = useState<CloseState>(null);
  const [edit, setEdit] = useState<EditState>(null);
  const [adding, setAdding] = useState(false);
  const generation = useRef(0), trialGeneration = useRef(0), privacy = useRef(0), mounted = useRef(false), lastSchool = useRef<string | null>(null);
  const retainedClose = useRef<PreparedCrmLeadClose | null>(null), retainedSave = useRef<PreparedCommand | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; generation.current++; trialGeneration.current++; }; }, []);

  const reset = useCallback(() => {
    retainedClose.current = null; retainedSave.current = null;
    setClose(null); setEdit(null); setNotice(null); setMovingId(null); setFilters(FILTERS);
  }, []);
  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); generation.current++; trialGeneration.current++; privacy.current++;
    setBoard({ state: 'LOADING' }); setTrials({ state: 'NONE' }); reset();
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), [reset]);

  const school = selection ? selection.schoolId.toLowerCase() : null;
  useEffect(() => {
    if (school !== null && lastSchool.current !== null && school !== lastSchool.current) {
      setSelectedId(null); setStatus('OPEN'); setView('BOARD'); setPipelineId(null); setAdding(false); reset();
    }
    if (school !== null) lastSchool.current = school;
  }, [school, reset]);

  const owns = (current: number, shown: number) => () => mounted.current && current === generation.current && shown === privacy.current;
  useEffect(() => {
    const current = ++generation.current, shown = privacy.current;
    setBoard({ state: 'LOADING' });
    if (!selection) return;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    const owned = owns(current, shown);
    api.read({ organizationId: selection.organizationId, schoolId: selection.schoolId }, pipelineId, status, signal, owned).then(
      (next) => { if (owned()) { setBoard({ state: 'READY', board: next }); setSelectedId((now) => now && next.leads.some((l) => l.id === now) ? now : null); } },
      (error) => { if (owned() && !abort.signal.aborted) setBoard({ state: error instanceof BoardError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [selection?.organizationId, selection?.schoolId, status, pipelineId, refresh, api]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const current = ++trialGeneration.current, shown = privacy.current;
    if (!selectedId || !selection) { setTrials({ state: 'NONE' }); return; }
    setTrials({ state: 'LOADING' });
    const abort = new AbortController(), leadId = selectedId;
    const owned = () => mounted.current && current === trialGeneration.current && shown === privacy.current;
    leads.trials({ organizationId: selection.organizationId, schoolId: selection.schoolId }, leadId, abort.signal).then(
      (recovery) => { if (owned()) setTrials({ state: 'READY', leadId, recovery }); },
      (error) => { if (owned() && !abort.signal.aborted) setTrials({ state: error instanceof LeadsError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [selection?.organizationId, selection?.schoolId, selectedId, trialsRefresh, leads]); // eslint-disable-line react-hooks/exhaustive-deps

  const reload = useCallback(() => setRefresh((n) => n + 1), []);
  const ready = board.state === 'READY' ? board.board : null;

  const onMove = useCallback((leadId: string, stageId: string) => {
    if (!scope || !ready || movingId) return;
    const lead = ready.leads.find((l) => l.id === leadId), stage = ready.stages.find((s) => s.id === stageId);
    if (!lead || !stage || lead.status !== 'OPEN' || lead.stageId === stageId) return;
    let request: PreparedCommand;
    try { request = prepareMove(scope, lead.id, stage.id, lead.version, crypto.randomUUID()); } catch { setNotice({ tone: 'ERROR', text: t('moveFailed') }); return; }
    const shown = privacy.current;
    setMovingId(lead.id); setNotice(null);
    api.submitMove(request).then(
      (receipt) => { if (!mounted.current || shown !== privacy.current) return; setMovingId(null);
        setBoard((now) => now.state === 'READY' ? { state: 'READY', board: applyMove(now.board, receipt.leadId, receipt.fromStageId, receipt.stageId, receipt.version) } : now);
        setNotice({ tone: 'OK', text: t('moved', { name: fullName(lead), stage: stage.name }) }); },
      (error) => { if (!mounted.current || shown !== privacy.current) return; setMovingId(null);
        if (error instanceof BoardCommandError && error.kind === 'SESSION') return;
        setNotice({ tone: 'ERROR', text: t(error instanceof BoardCommandError && error.kind === 'UNCERTAIN' ? 'moveUnknown' : error instanceof BoardCommandError && error.kind === 'DENIED' ? 'errDenied' : 'moveFailed') });
        reload(); });
  }, [scope?.organizationId, scope?.schoolId, ready, movingId, api, t, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const onAskClose = useCallback((leadId: string, next: 'WON' | 'LOST') => {
    const lead = ready?.leads.find((l) => l.id === leadId);
    if (!lead || lead.status !== 'OPEN' || close) return;
    retainedClose.current = null; setClose({ leadId, status: next, note: '', phase: 'ASK' });
  }, [ready, close]);
  const onConfirmClose = useCallback(() => {
    if (!scope || !ready || !close || close.phase === 'SAVING') return;
    const lead = ready.leads.find((l) => l.id === close.leadId);
    if (!lead) return;
    let request = close.phase === 'UNCERTAIN' ? retainedClose.current : null;
    if (!request) {
      const note = close.note.trim();
      try { request = prepareCrmLeadClose(scope.organizationId, scope.schoolId, closeRow(lead), { status: close.status, expectedVersion: lead.version, ...(note ? { closeNote: note } : {}) }, crypto.randomUUID()); }
      catch { setClose({ ...close, phase: 'FAILED' }); return; }
    }
    const sent = request, shown = privacy.current, target = close;
    retainedClose.current = sent; setClose({ ...target, phase: 'SAVING' });
    closeSubmit(sent).then(
      () => { if (!mounted.current || shown !== privacy.current) return; retainedClose.current = null; setClose(null);
        setNotice({ tone: 'OK', text: t('closed', { name: fullName(lead), choice: t(target.status) }) }); setSelectedId(null); reload(); },
      (error) => { if (!mounted.current || shown !== privacy.current) return;
        if (error instanceof CrmLeadCloseRejectedError) { retainedClose.current = null; setClose({ ...target, phase: 'FAILED' }); return; }
        setClose({ ...target, phase: 'UNCERTAIN' }); });
  }, [scope?.organizationId, scope?.schoolId, ready, close, closeSubmit, t, reload]); // eslint-disable-line react-hooks/exhaustive-deps
  const onCancelClose = useCallback(() => {
    const was = close; retainedClose.current = null; setClose(null);
    if (was && was.phase !== 'ASK') reload();
  }, [close, reload]);

  const onEdit = useCallback((open: boolean) => {
    retainedSave.current = null;
    if (!open || !ready?.pipeline) { const wasUncertain = edit?.phase === 'UNCERTAIN'; setEdit(null); if (wasUncertain) reload(); return; }
    setEdit({ draft: draftFrom(ready.stages), newName: '', phase: 'EDIT', error: null });
  }, [ready, edit, reload]);
  const onDraft = useCallback((next: EditState) => {
    // Changing the draft after an unknown outcome starts a new command; the old one is no longer retried.
    if (next && edit?.phase === 'UNCERTAIN' && next.draft !== edit.draft) { retainedSave.current = null; setEdit({ ...next, phase: 'EDIT' }); return; }
    setEdit(next);
  }, [edit]);
  const onSave = useCallback(() => {
    if (!scope || !ready?.pipeline || !edit || edit.phase === 'SAVING') return;
    let request = edit.phase === 'UNCERTAIN' ? retainedSave.current : null;
    if (!request) {
      try { request = prepareSave(scope, ready.pipeline.id, draftInput(edit.draft, ready.pipeline.version), crypto.randomUUID()); }
      catch { setEdit({ ...edit, error: t('saveFailed', { reason: t('errName') }) }); return; }
    }
    const sent = request, shown = privacy.current, target = edit;
    retainedSave.current = sent; setEdit({ ...target, phase: 'SAVING', error: null });
    api.submitSave(sent).then(
      () => { if (!mounted.current || shown !== privacy.current) return; retainedSave.current = null; setEdit(null); setNotice({ tone: 'OK', text: t('saved') }); reload(); },
      (error) => { if (!mounted.current || shown !== privacy.current) return;
        const kind = error instanceof BoardCommandError ? error.kind : 'UNCERTAIN';
        if (kind === 'UNCERTAIN') { setEdit({ ...target, phase: 'UNCERTAIN' }); return; }
        retainedSave.current = null;
        if (kind === 'SESSION') { setEdit(null); return; }
        const code = error instanceof BoardCommandError ? error.code : null;
        const text = kind === 'CONFLICT' ? t('saveConflict') : kind === 'DENIED' ? t('errDenied') : t('saveFailed', { reason: t(SAVE_REASON[code ?? ''] ?? 'errName') });
        setEdit({ ...target, phase: 'EDIT', error: text }); });
  }, [scope?.organizationId, scope?.schoolId, ready, edit, api, t, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const onStatus = useCallback((next: CrmBoardStatus) => { setStatus(next); setSelectedId(null); if (next === 'OPEN') setView('BOARD'); }, []);
  const onOpen = useCallback((leadId: string | null) => { setSelectedId(leadId); if (leadId) setTrialsRefresh((n) => n + 1); }, []);
  const onRefresh = useCallback(() => { setNotice(null); reload(); setTrialsRefresh((n) => n + 1); }, [reload]);
  const onAdded = useCallback(() => { setStatus('OPEN'); setView('BOARD'); setFilters(FILTERS); reload(); }, [reload]);
  const onPipeline = useCallback((id: string) => { setPipelineId(id); setSelectedId(null); }, []);

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <PipelineView language={language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'} scope={scope}
      board={board} status={status} filters={filters} view={status === 'OPEN' ? view : 'LIST'} selectedId={selectedId} trials={trials}
      notice={notice} movingId={movingId} close={close} edit={edit} adding={adding}
      addLead={scope ? <AddLead key={scope.schoolId.toLowerCase()} scope={scope} language={language} onAdded={onAdded} {...(addLeadApi ? { api: addLeadApi } : {})}/> : null}
      onStatus={onStatus} onFilters={setFilters} onView={setView} onPipeline={onPipeline} onOpen={onOpen} onMove={onMove}
      onAskClose={onAskClose} onCloseNote={(note) => setClose((now) => now ? { ...now, note } : now)} onConfirmClose={onConfirmClose} onCancelClose={onCancelClose}
      onEdit={onEdit} onDraft={onDraft} onSave={onSave} onAdd={setAdding} onRefresh={onRefresh} onReloadTrials={() => setTrialsRefresh((n) => n + 1)}/>
  </div>;
}
