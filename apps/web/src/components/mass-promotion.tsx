'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { PROMOTION_DECISION_STATUSES } from '@hon/contracts';
import { PromotionDecisionAccessError, PromotionDecisionRejectedError, PromotionDecisionUncertainError, preparePromotionDecision, submitPromotionDecision,
  validatePromotionDecisionDraft, type PreparedPromotionDecision } from './promotion-decision-http';
import { PickerError, pickerApi, type PickerCandidate, type PickerScope } from './school-pickers/http';
import { candidateLabel } from './school-pickers/pickers';
import styles from './attendance-workbench.module.css';

type ListState = Readonly<{ state: 'LOADING' } | { state: 'READY'; items: readonly PickerCandidate[] } | { state: 'DENIED' } | { state: 'UNAVAILABLE' }>;
type Outcome = Readonly<{ state: 'RECORDED' | 'REPLAYED' | 'REJECTED' } | { state: 'UNCERTAIN'; command: PreparedPromotionDecision }>;
const OUTCOME: Record<Outcome['state'], string> = {
  RECORDED: 'Recorded', REPLAYED: 'Already recorded', REJECTED: 'Not recorded: the test or student changed. Read the list again.',
  UNCERTAIN: 'Not sure it was recorded. Retry sends the same decision again.',
};
const DECISION_LABEL: Record<string, string> = { PROMOTED: 'Promoted', DEFERRED: 'Deferred', NOT_PROMOTED: 'Not promoted' };
const done = (outcome: Outcome | undefined) => outcome?.state === 'RECORDED' || outcome?.state === 'REPLAYED';

/**
 * Mass rank promotion (owner menu, Ranks heading; docs/architecture/SCHOOL_APP_TARGET_LAYOUT.md L3): the instructor picks
 * graded students and records one decision for all of them. Each student is still the existing single human command, sent
 * one after another with its own idempotency key and the version the list returned; the server decides every one.
 */
export function MassPromotion({ scope }: { scope: PickerScope }): React.ReactElement {
  const [list, setList] = useState<ListState>({ state: 'LOADING' });
  const [reads, setReads] = useState(0);
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [status, setStatus] = useState('PROMOTED');
  const [rationale, setRationale] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, Outcome>>>({});
  const [stopped, setStopped] = useState(false);
  const active = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    pickerApi.candidates(scope, 'decision', '', controller.signal)
      .then(items => { if (mounted.current && !controller.signal.aborted) setList({ state: 'READY', items }); })
      .catch(error => { if (mounted.current && !controller.signal.aborted) setList({ state: error instanceof PickerError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => controller.abort();
  }, [scope.organizationId, scope.schoolId, reads]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = list.state === 'READY' ? list.items : [];
  const open = (candidate: PickerCandidate) => !done(outcomes[candidate.candidateId]);
  const chosen = items.filter(candidate => picked.includes(candidate.candidateId) && open(candidate));
  const ready = chosen.length > 0 && rationale.trim().length > 0 && rationale.length <= 2000 && PROMOTION_DECISION_STATUSES.includes(status as never);

  function edit(change: () => void): void {
    if (active.current) return;
    setConfirmed(false); setStopped(false); change();
  }
  function toggle(candidateId: string, checked: boolean): void {
    edit(() => setPicked(current => checked ? [...current.filter(value => value !== candidateId), candidateId] : current.filter(value => value !== candidateId)));
  }
  function stop(): void { setPicked([]); setRationale(''); setConfirmed(false); setStopped(true); }
  async function sendOne(candidateId: string, command: PreparedPromotionDecision): Promise<'GO' | 'STOP'> {
    try {
      const receipt = await submitPromotionDecision(command);
      if (mounted.current) setOutcomes(current => ({ ...current, [candidateId]: { state: receipt.replayed ? 'REPLAYED' : 'RECORDED' } }));
      return 'GO';
    } catch (caught) {
      if (!mounted.current) return 'STOP';
      if (caught instanceof PromotionDecisionAccessError) { stop(); return 'STOP'; }
      const outcome: Outcome = caught instanceof PromotionDecisionUncertainError ? { state: 'UNCERTAIN', command }
        : caught instanceof PromotionDecisionRejectedError ? { state: 'REJECTED' } : { state: 'UNCERTAIN', command };
      setOutcomes(current => ({ ...current, [candidateId]: outcome }));
      return 'GO';
    }
  }
  async function run(batch: readonly PickerCandidate[], decision: string, reason: string): Promise<void> {
    active.current = true; setBusy(true); setConfirmed(false); setRationale('');
    try {
      for (const candidate of batch) {
        if (!mounted.current) return;
        const command = preparePromotionDecision({ organizationId: scope.organizationId, schoolId: scope.schoolId, candidateId: candidate.candidateId },
          candidate.version, decision, reason, crypto.randomUUID());
        if (await sendOne(candidate.candidateId, command) === 'STOP') return;
      }
    } finally { active.current = false; if (mounted.current) { setBusy(false); setPicked(current => current.filter(value => !batch.some(c => c.candidateId === value))); } }
  }
  function submit(event: FormEvent): void {
    event.preventDefault();
    if (active.current || !confirmed || !ready) return;
    let batch: readonly PickerCandidate[] = chosen;
    try { batch.forEach(candidate => validatePromotionDecisionDraft({ ...scope, candidateId: candidate.candidateId }, candidate.version, status, rationale)); }
    catch { batch = []; }
    if (batch.length) void run(batch, status, rationale);
  }
  async function retry(candidateId: string, command: PreparedPromotionDecision): Promise<void> {
    const outcome = outcomes[candidateId];
    if (active.current || outcome?.state !== 'UNCERTAIN' || outcome.command !== command) return;
    active.current = true; setBusy(true);
    try { await sendOne(candidateId, command); } finally { active.current = false; if (mounted.current) setBusy(false); }
  }
  function reread(): void { if (active.current) return; setOutcomes({}); setPicked([]); setConfirmed(false); setList({ state: 'LOADING' }); setReads(value => value + 1); }

  const recorded = Object.values(outcomes).filter(done).length;
  const attempted = Object.keys(outcomes).length;
  return <section aria-labelledby="mass-promotion-title" data-mass-promotion="">
    <h2 id="mass-promotion-title">Promote a group</h2>
    <aside data-plain-note=""><strong>Only an instructor decides a promotion. HON and the AI team never promote a student.</strong></aside>
    {list.state === 'LOADING' && <p role="status">Reading graded students…</p>}
    {list.state === 'DENIED' && <p role="alert">Your access does not include promotion decisions at this school.</p>}
    {list.state === 'UNAVAILABLE' && <p role="alert">Graded students could not be loaded. <button type="button" onClick={reread}>Read the list again</button></p>}
    {list.state === 'READY' && items.length === 0 && <p className={styles.empty}>No graded students are waiting for a promotion decision.</p>}
    {stopped && <p role="alert">Your access changed, so the run stopped. Picks and reason were cleared. Reload the page before trying again.</p>}
    {list.state === 'READY' && items.length > 0 && <form autoComplete="off" onSubmit={submit}><fieldset disabled={busy}>
      <div className={styles.actions}>
        <button type="button" onClick={() => edit(() => setPicked(items.filter(candidate => candidate.result === 'PASSED' && open(candidate)).map(candidate => candidate.candidateId)))}>Pick everyone who passed</button>
        <button type="button" onClick={() => edit(() => setPicked([]))}>Clear picks</button>
        <button type="button" onClick={reread}>Read the list again</button>
      </div>
      <ul style={{ listStyle: 'none', padding: 0 }}>{items.map(candidate => { const outcome = outcomes[candidate.candidateId];
        return <li key={candidate.candidateId} data-row={candidate.candidateId}>
          <label className={styles.check}><input type="checkbox" name={`pick-${candidate.candidateId}`} checked={picked.includes(candidate.candidateId) && open(candidate)}
            disabled={busy || !open(candidate)} onChange={event => toggle(candidate.candidateId, event.target.checked)} />{candidateLabel(candidate)}</label>
          {outcome && <span data-outcome={outcome.state}>{OUTCOME[outcome.state]}</span>}
          {outcome?.state === 'UNCERTAIN' && <button type="button" disabled={busy} onClick={() => void retry(candidate.candidateId, outcome.command)}>{`Retry ${candidate.givenName} ${candidate.familyName}`}</button>}
        </li>; })}</ul>
      <label>Decision for everyone picked<select name="massStatus" required value={status} onChange={event => edit(() => setStatus(event.target.value))}>
        {PROMOTION_DECISION_STATUSES.map(decision => <option key={decision} value={decision}>{DECISION_LABEL[decision] ?? decision}</option>)}</select></label>
      <label>Reason (private, required, up to 2000 characters)<textarea name="massRationale" required maxLength={2000} value={rationale} onChange={event => edit(() => setRationale(event.target.value))} /></label>
      <label className={styles.check}><input type="checkbox" name="confirmMassPromotion" checked={confirmed} disabled={!ready || busy} onChange={event => { if (!active.current && ready) setConfirmed(event.target.checked); }} />
        {`I confirm this decision (${DECISION_LABEL[status] ?? status}) and reason for the ${chosen.length} picked students as my final instructor decision.`}</label>
      <div className={styles.actions}><button type="submit" disabled={!ready || !confirmed || busy}>{`Record decision for ${chosen.length} students`}</button></div>
    </fieldset></form>}
    {busy && <p role="status">Recording decisions one student at a time…</p>}
    {attempted > 0 && !busy && <p role="status">{`Recorded for ${recorded} of ${attempted}`}</p>}
  </section>;
}
