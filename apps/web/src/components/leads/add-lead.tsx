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
 * One lead-create press whose answer was lost: the exact prepared request (path, school, body and Idempotency-Key),
 * the name it was for and the form as typed, with the IC1 (0634) consent tick that went into the request. It is immutable once made and is the only thing a retry may send.
 */
export type LeadCreateCapsule = Readonly<{ request: PreparedCrmLeadCreate; name: string; form: LeadForm; consent: boolean }>;
/**
 * Where the capsule lives. The page that shows the form owns it, above every boundary that can unmount the form
 * (Close add, a board refresh, a concealed shell, a stage setup remount), so reopening the form after a lost answer
 * shows the same uncertain save with its same-key retry instead of an empty form that would add the lead twice.
 * Only a definite answer or Discard clears it; the owner also clears it on a school change or session end.
 */
export type LeadCreateCustody = { current: LeadCreateCapsule | null };
export const createLeadCreateCustody = (): LeadCreateCustody => ({ current: null });
/** The capsule this form may show and retry: only one made for this exact school. */
export function custodyFor(custody: LeadCreateCustody, scope: LeadsScope): LeadCreateCapsule | null {
  const held = custody.current;
  return held && held.request.organizationId === scope.organizationId.toLowerCase() && held.request.schoolId === scope.schoolId.toLowerCase() ? held : null;
}

/**
 * Add a lead from the Leads page, and add the starter lead stages first when the school has none. Commands go only
 * through the existing human lead-create command and the starter-stages command; each key is made on the button press
 * and reused only to retry that same uncertain press. The uncertain press lives in the owner's custody, in memory only.
 */
export function AddLead({ scope, language, onAdded, api = addLeadApi, submit = submitCrmLeadCreate, custody: given }: {
  scope: LeadsScope; language: string; onAdded?: () => void; api?: AddLeadApi; submit?: typeof submitCrmLeadCreate; custody?: LeadCreateCustody;
}): React.ReactElement | null {
  const own = useRef<LeadCreateCustody | null>(null);
  const custody = given ?? (own.current ??= createLeadCreateCustody());
  const held = custodyFor(custody, scope);
  const [pipelines, setPipelines] = useState<PipelinesState>({ state: 'LOADING' });
  const [reload, setReload] = useState(0);
  const [setup, setSetup] = useState<SetupState>({ state: 'IDLE' });
  // A form mounted while its school still holds an unanswered press opens on that press, locked, with its retry.
  const [open, setOpen] = useState(held !== null);
  const [form, setForm] = useState<LeadForm>(held?.form ?? EMPTY);
  // IC1 (0634): consent channels staff leave ticked (both by default); a held press shows the tick it was sent with.
  const [consent, setConsent] = useState(held?.consent ?? true);
  const [stageId, setStageId] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>(held ? { state: 'UNCERTAIN' } : { state: 'IDLE' });
  const setupKey = useRef<string | null>(null), alive = useRef(true);
  // Unmounting stops this form's state updates only; the capsule stays with its owner.
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

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

  const send = useCallback((capsule: LeadCreateCapsule) => {
    custody.current = capsule;
    setSave({ state: 'SAVING' });
    // A definite answer settles this capsule even if the form was closed meanwhile; it never clears a newer one.
    const settle = () => { if (custody.current === capsule) custody.current = null; };
    submit(capsule.request).then(
      () => { settle(); if (!alive.current) return; setForm(EMPTY); setConsent(true); setSave({ state: 'SAVED', name: capsule.name }); setOpen(false); onAdded?.(); },
      (error) => {
        if (error instanceof CrmLeadCreateUncertainError) { if (alive.current) setSave({ state: 'UNCERTAIN' }); return; }
        settle(); if (alive.current) setSave({ state: error instanceof CrmLeadCreateAccessError ? 'DENIED' : 'REJECTED' }); });
  }, [submit, onAdded, custody]);

  const onSave = useCallback(() => {
    const choice = pipelines.state === 'READY' ? openStageChoices(pipelines.items).find((c) => c.stageId === stageId) ?? null : null;
    const built = buildLeadInput(form, choice, consent);
    if (!built.ok) { setSave({ state: 'PROBLEM', problem: built.problem }); return; }
    let request: PreparedCrmLeadCreate;
    try { request = prepareCrmLeadCreate(scope.organizationId, scope.schoolId, built.input, crypto.randomUUID()); } catch { setSave({ state: 'REJECTED' }); return; }
    send(Object.freeze({ request, name: `${built.input.primaryContact.givenName} ${built.input.primaryContact.familyName}`, form: Object.freeze({ ...form }), consent }));
  }, [pipelines, stageId, form, consent, scope, send]);

  // Retry resends the held capsule exactly: same path, body and Idempotency-Key, whatever the fields show now.
  const onRetry = useCallback(() => { const capsule = custodyFor(custody, scope); if (capsule) send(capsule); }, [send, custody, scope]);
  const onDiscard = useCallback(() => { custody.current = null; setForm(EMPTY); setConsent(true); setSave({ state: 'IDLE' }); }, [custody]);
  const onField = useCallback((field: keyof LeadForm, value: string) => { setForm((now) => ({ ...now, [field]: value })); setSave((now) => now.state === 'SAVING' || now.state === 'UNCERTAIN' ? now : { state: 'IDLE' }); }, []);
  const onOpen = useCallback((next: boolean) => { setOpen(next); if (next) setSave((now) => saveAfterOpen(now, custodyFor(custody, scope) !== null)); }, [custody, scope]);

  return <AddLeadView language={language} pipelines={pipelines} setup={setup} open={open} form={form} stageId={stageId} save={save}
    onSetUp={onSetUp} onReload={() => setReload((n) => n + 1)} onOpen={onOpen} onField={onField} consent={consent} onConsent={setConsent} onStage={setStageId} onSave={onSave} onRetry={onRetry} onDiscard={onDiscard}/>;
}
