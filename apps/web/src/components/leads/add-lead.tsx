'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CrmLeadCreateAccessError, CrmLeadCreateUncertainError, prepareCrmLeadCreate, submitCrmLeadCreate, type PreparedCrmLeadCreate } from '../crm-lead-create-http';
import { StarterRefusedError, addLeadApi, buildLeadInput, openStageChoices, type AddLeadApi, type LeadForm } from './add-lead-http';
import { AddLeadView, type PipelinesState, type SaveState, type SetupState } from './add-lead-view';
import { LeadsError, type LeadsScope } from './http';

/** Only an unknown starter outcome keeps its key for the same retry; any definite answer drops it. */
export function starterKeyAfter(error: unknown): 'keep' | 'clear' {
  if (error instanceof StarterRefusedError) return 'clear';
  if (error instanceof LeadsError && (error.kind === 'DENIED' || error.kind === 'SESSION')) return 'clear';
  return 'keep';
}
/** Reopening the form never hides an uncertain save: its retained request is still the only retry. */
export function saveAfterOpen(save: SaveState, retained: boolean): SaveState {
  return retained && save.state === 'UNCERTAIN' ? save : { state: 'IDLE' };
}

const EMPTY: LeadForm = Object.freeze({ givenName: '', familyName: '', email: '', phone: '' });

/**
 * Add a lead from the Leads page, and add the starter lead stages first when the school has none. Commands go only
 * through the existing human lead-create command and the starter-stages command; each key is made on the button press
 * and reused only to retry that same uncertain press. Nothing is kept outside memory.
 */
export function AddLead({ scope, language, onAdded, api = addLeadApi, submit = submitCrmLeadCreate }: {
  scope: LeadsScope; language: string; onAdded?: () => void; api?: AddLeadApi; submit?: typeof submitCrmLeadCreate;
}): React.ReactElement | null {
  const [pipelines, setPipelines] = useState<PipelinesState>({ state: 'LOADING' });
  const [reload, setReload] = useState(0);
  const [setup, setSetup] = useState<SetupState>({ state: 'IDLE' });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<LeadForm>(EMPTY);
  const [stageId, setStageId] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>({ state: 'IDLE' });
  const pending = useRef<PreparedCrmLeadCreate | null>(null), setupKey = useRef<string | null>(null), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; pending.current = null; }; }, []);

  useEffect(() => {
    let current = true; const abort = new AbortController();
    setPipelines({ state: 'LOADING' });
    api.pipelines(scope, AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]), () => current && alive.current).then(
      (items) => { if (!current) return; setPipelines({ state: 'READY', items }); const first = openStageChoices(items)[0]; setStageId((now) => openStageChoices(items).some((c) => c.stageId === now) ? now : first?.stageId ?? null); },
      (error) => { if (current && !abort.signal.aborted) setPipelines({ state: error instanceof LeadsError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { current = false; abort.abort(); };
  }, [scope.organizationId, scope.schoolId, reload, api]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSetUp = useCallback(() => {
    const key = setupKey.current ??= crypto.randomUUID();
    setSetup({ state: 'WORKING' });
    api.setUpStarter(scope, key).then(
      (pipeline) => { if (!alive.current) return; setupKey.current = null; setSetup({ state: 'IDLE' }); setPipelines({ state: 'READY', items: [pipeline] });
        setStageId(openStageChoices([pipeline])[0]?.stageId ?? null); setOpen(true); },
      (error) => { if (!alive.current) return; if (starterKeyAfter(error) === 'clear') setupKey.current = null;
        setSetup({ state: error instanceof LeadsError && error.kind === 'DENIED' ? 'DENIED' : 'FAILED' }); });
  }, [api, scope]);

  const send = useCallback((request: PreparedCrmLeadCreate, name: string) => {
    setSave({ state: 'SAVING' });
    submit(request).then(
      () => { if (!alive.current) return; pending.current = null; setForm(EMPTY); setSave({ state: 'SAVED', name }); setOpen(false); onAdded?.(); },
      (error) => { if (!alive.current) return;
        if (error instanceof CrmLeadCreateUncertainError) { setSave({ state: 'UNCERTAIN' }); return; }
        pending.current = null; setSave({ state: error instanceof CrmLeadCreateAccessError ? 'DENIED' : 'REJECTED' }); });
  }, [submit, onAdded]);

  const onSave = useCallback(() => {
    const choice = pipelines.state === 'READY' ? openStageChoices(pipelines.items).find((c) => c.stageId === stageId) ?? null : null;
    const built = buildLeadInput(form, choice);
    if (!built.ok) { setSave({ state: 'PROBLEM', problem: built.problem }); return; }
    let request: PreparedCrmLeadCreate;
    try { request = prepareCrmLeadCreate(scope.organizationId, scope.schoolId, built.input, crypto.randomUUID()); } catch { setSave({ state: 'REJECTED' }); return; }
    pending.current = request;
    send(request, `${built.input.primaryContact.givenName} ${built.input.primaryContact.familyName}`);
  }, [pipelines, stageId, form, scope, send]);

  const onRetry = useCallback(() => { if (pending.current) send(pending.current, `${form.givenName.trim()} ${form.familyName.trim()}`); }, [send, form]);
  const onDiscard = useCallback(() => { pending.current = null; setForm(EMPTY); setSave({ state: 'IDLE' }); }, []);
  const onField = useCallback((field: keyof LeadForm, value: string) => { setForm((now) => ({ ...now, [field]: value })); setSave((now) => now.state === 'SAVING' || now.state === 'UNCERTAIN' ? now : { state: 'IDLE' }); }, []);
  const onOpen = useCallback((next: boolean) => { setOpen(next); if (next) setSave((now) => saveAfterOpen(now, pending.current !== null)); }, []);

  return <AddLeadView language={language} pipelines={pipelines} setup={setup} open={open} form={form} stageId={stageId} save={save}
    onSetUp={onSetUp} onReload={() => setReload((n) => n + 1)} onOpen={onOpen} onField={onField} onStage={setStageId} onSave={onSave} onRetry={onRetry} onDiscard={onDiscard}/>;
}
