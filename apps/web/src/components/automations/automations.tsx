'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AutomationWorkflowDetail } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { automationsText, type AutomationsKey } from './copy';
import {
  AutomationCommandError, AutomationReadError, automationsApi, prepareActivate, prepareCreate, preparePause, prepareSave,
  type AutomationScope, type AutomationsApi, type PreparedAutomationCommand,
} from './http';
import { blankAutomation, fromDefinition, fromTemplate, problems, toDefinition, type SimpleAutomation, type TemplateKey } from './model';
import { AutomationsView, type ActivityState, type EditorState, type ListState, type Notice } from './view';

/** The command error, in plain words. */
export function commandErrorKey(error: unknown): AutomationsKey {
  if (!(error instanceof AutomationCommandError)) return 'errInvalid';
  if (error.kind === 'DENIED') return 'errDenied';
  if (error.kind === 'SESSION') return 'errSession';
  if (error.kind === 'CONFLICT') return 'errStale';
  if (error.kind === 'UNCERTAIN') return 'errUncertain';
  if (error.code === 'AUTOMATION_LIMIT_REACHED') return 'errLimit';
  if (error.code === 'AUTOMATION_STALE') return 'errStale';
  if (error.code && /NOT_AVAILABLE_YET|_UNAVAILABLE$/.test(error.code)) return 'errNotYet';
  return 'errInvalid';
}

/** The editor for a saved automation: the simple form when its definition fits, else a read-only summary. */
export function editorFor(detail: AutomationWorkflowDetail): NonNullable<EditorState> {
  return { workflowId: detail.workflow.workflowId, revision: detail.workflow.revision, status: detail.workflow.status, name: detail.latest.name,
    draft: fromDefinition(detail.latest.name, detail.latest.definition), showProblems: false, busy: false };
}

/**
 * Automations for the school the shell verified: a list of automations with plain status, starters, a three-question editor
 * (when it starts, who it is for, what gets sent), turn on / pause, and recent activity. Every change is a same-origin human
 * command the API re-proves; a school change, a hidden tab or a session end hides the page and drops every retained command.
 */
export function Automations({ api = automationsApi }: { api?: AutomationsApi }): React.ReactElement {
  const { preferences } = useLocale();
  const language = preferences.language;
  const t = useCallback((key: AutomationsKey, vars?: Record<string, string>) => automationsText(language, key, vars), [language]);
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const scope: AutomationScope | null = selection ? { organizationId: selection.organizationId, schoolId: selection.schoolId } : null;
  const [list, setList] = useState<ListState>({ state: 'LOADING' });
  const [refresh, setRefresh] = useState(0);
  const [editor, setEditor] = useState<EditorState>(null);
  const [picking, setPicking] = useState(false);
  const [activity, setActivity] = useState<ActivityState>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const generation = useRef(0), privacy = useRef(0), mounted = useRef(false);
  const retained = useRef<{ fingerprint: string; key: string } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; generation.current++; }; }, []);

  const reset = useCallback(() => { retained.current = null; setEditor(null); setPicking(false); setActivity(null); setNotice(null); setBusyId(null); }, []);
  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); generation.current++; privacy.current++; setList({ state: 'LOADING' }); reset();
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), [reset]);

  useEffect(() => {
    const current = ++generation.current, shown = privacy.current;
    setList((now) => (now.state === 'READY' ? now : { state: 'LOADING' }));
    if (!selection) return;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    const owned = () => mounted.current && current === generation.current && shown === privacy.current;
    api.list({ organizationId: selection.organizationId, schoolId: selection.schoolId }, signal, owned).then(
      (next) => { if (owned()) setList({ state: 'READY', list: next }); },
      (error) => { if (owned() && !abort.signal.aborted) setList({ state: error instanceof AutomationReadError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [selection?.organizationId, selection?.schoolId, refresh, api]); // eslint-disable-line react-hooks/exhaustive-deps
  const reload = useCallback(() => setRefresh((n) => n + 1), []);

  /** One key per distinct request; an uncertain press retried unchanged reuses its key so it is never done twice. */
  const keyFor = (make: (key: string) => PreparedAutomationCommand): PreparedAutomationCommand => {
    const probe = make(crypto.randomUUID()), fingerprint = `${probe.command}\u0000${probe.path}\u0000${probe.body}`;
    if (retained.current?.fingerprint === fingerprint) return make(retained.current.key);
    retained.current = { fingerprint, key: probe.key };
    return probe;
  };
  const owner = () => { const shown = privacy.current; return () => mounted.current && shown === privacy.current; };

  const onTemplate = useCallback((key: TemplateKey | null) => {
    retained.current = null; setNotice(null); setPicking(false); setActivity(null);
    setEditor({ workflowId: null, revision: null, status: null, name: '', draft: key ? fromTemplate(key) : blankAutomation(), showProblems: false, busy: false });
  }, []);

  const onEdit = useCallback((workflowId: string) => {
    if (!scope) return;
    const owned = owner();
    setNotice(null); setBusyId(workflowId); retained.current = null;
    api.detail(scope, workflowId, AbortSignal.timeout(15000), owned).then(
      (detail) => { if (owned()) { setBusyId(null); setActivity(null); setEditor(editorFor(detail)); } },
      () => { if (owned()) { setBusyId(null); setNotice({ tone: 'ERROR', text: t('unavailable') }); } });
  }, [scope?.organizationId, scope?.schoolId, api, t]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSave = useCallback(async (turnOn: boolean) => {
    if (!scope || !editor?.draft || editor.busy) return;
    const draft: SimpleAutomation = editor.draft;
    if (problems(draft).length) { setEditor({ ...editor, showProblems: true }); return; }
    const owned = owner();
    let definition;
    try { definition = toDefinition(draft); } catch { setNotice({ tone: 'ERROR', text: t('errInvalid') }); return; }
    const name = draft.name.trim();
    setEditor({ ...editor, busy: true }); setNotice(null);
    let saved: AutomationWorkflowDetail;
    try {
      const request = editor.workflowId && editor.revision !== null
        ? keyFor((key) => prepareSave(scope, editor.workflowId!, editor.revision!, name, definition, key))
        : keyFor((key) => prepareCreate(scope, name, definition, key));
      saved = await api.submit(request);
    } catch (error) {
      if (!owned()) return;
      setEditor((now) => (now ? { ...now, busy: false } : now));
      setNotice({ tone: 'ERROR', text: t(commandErrorKey(error)) });
      if (error instanceof AutomationCommandError && error.kind === 'CONFLICT') reload();
      return;
    }
    if (!owned()) return;
    retained.current = null;
    if (turnOn) {
      try {
        await api.submit(keyFor((key) => prepareActivate(scope, saved.workflow.workflowId, saved.workflow.revision, saved.latest.version, key)));
        if (!owned()) return;
        retained.current = null;
        setNotice({ tone: 'OK', text: t('savedOn', { name }) });
      } catch (error) {
        if (!owned()) return;
        retained.current = null;
        setNotice({ tone: 'ERROR', text: t('savedNotOn', { name, why: t(commandErrorKey(error)) }) });
      }
    } else setNotice({ tone: 'OK', text: t('savedDraft', { name }) });
    setEditor(null); reload();
  }, [scope?.organizationId, scope?.schoolId, editor, api, t, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const onToggle = useCallback(async (workflowId: string) => {
    if (!scope || list.state !== 'READY' || busyId) return;
    const w = list.list.workflows.find((x) => x.workflowId === workflowId);
    if (!w) return;
    const owned = owner();
    setBusyId(workflowId); setNotice(null);
    try {
      const request = w.status === 'ACTIVE'
        ? keyFor((key) => preparePause(scope, w.workflowId, w.revision, key))
        : keyFor((key) => prepareActivate(scope, w.workflowId, w.revision, w.latestVersion, key));
      await api.submit(request);
      if (!owned()) return;
      retained.current = null;
      setNotice({ tone: 'OK', text: t(w.status === 'ACTIVE' ? 'paused' : 'turnedOn', { name: w.name }) });
    } catch (error) {
      if (!owned()) return;
      setNotice({ tone: 'ERROR', text: t(commandErrorKey(error)) });
    }
    setBusyId(null); reload();
  }, [scope?.organizationId, scope?.schoolId, list, busyId, api, t, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const onActivity = useCallback((workflowId: string) => {
    if (!scope) return;
    if (activity?.workflowId === workflowId) { setActivity(null); return; }
    const owned = owner();
    setActivity({ workflowId, state: 'LOADING' });
    api.runs(scope, workflowId, AbortSignal.timeout(15000), owned).then(
      (runs) => { if (owned()) setActivity((now) => (now?.workflowId === workflowId ? { workflowId, state: 'READY', runs } : now)); },
      () => { if (owned()) setActivity((now) => (now?.workflowId === workflowId ? { workflowId, state: 'ERROR' } : now)); });
  }, [scope?.organizationId, scope?.schoolId, activity, api]); // eslint-disable-line react-hooks/exhaustive-deps

  const onCancel = useCallback(() => { retained.current = null; setEditor(null); setPicking(false); }, []);

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <AutomationsView language={language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'} scope={scope}
      list={list} editor={editor} picking={picking} activity={activity} notice={notice} busyId={busyId}
      onNew={() => { setNotice(null); setPicking(true); }} onTemplate={onTemplate} onEdit={onEdit}
      onDraft={(draft) => setEditor((now) => (now ? { ...now, draft } : now))} onSave={(on) => { void onSave(on); }} onCancel={onCancel}
      onToggle={(id) => { void onToggle(id); }} onActivity={onActivity} onRefresh={() => { setNotice(null); reload(); }}/>
  </div>;
}
