'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AI_SPEND_PAUSE_CLASSES, AI_UNKNOWN_DECISIONS,
  type AiSpendPause, type AiSpendPauseClass, type AiSpendPauseList, type AiUnknownDecision, type AiUnknownOpenItem, type AiUnknownQueue,
  type AiUnknownResolutionInput,
} from '@hon/contracts';
import { HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { HQ_AI_SAFETY_API, HqAiSafetyError, preparePause, prepareResolution, type AiSafetyFailure, type HqAiSafetyApi, type PreparedCommand } from './ai-safety-http';
import { formatSaasMoney } from './saas-review';
import base from './hq-modern.module.css';
import shared from './champions-management.module.css';
import styles from './ai-safety.module.css';

export const SPEND_CLASS_LABEL: Record<AiSpendPauseClass, string> = {
  AGENT_INFERENCE: 'Included AI team replies', CREATIVE_MEDIA: 'Creative Studio media', ALL: 'All AI work',
};
export const DECISION_LABEL: Record<AiUnknownDecision, string> = {
  RECORD_PROVIDER_COST: 'Provider charged: record the provider’s cost',
  NO_PROVIDER_CHARGE: 'Provider did not charge',
  WRITE_OFF: 'Cannot be verified: write off at HON’s expense',
};
const AGENT_LABEL = { MARKETING: 'Marcus · marketing drafts', TEACHING: 'Kai · teaching drafts', CHAD_FOLLOW_UP: 'Chad · follow-up drafts' } as const;
const FAILURE_TEXT: Record<AiSafetyFailure, string> = {
  SESSION: 'Your session ended. Sign in again.',
  FORBIDDEN: 'Not permitted. Only a human HQ owner can pause, resume or resolve; billing staff can read.',
  INVALID: 'The request was refused as invalid. Check the fields and try again.',
  CONFLICT: 'This record changed or is already settled. Refresh to see the current state.',
  UNAVAILABLE: 'HQ AI safety records are unavailable right now. Nothing is shown in their place.',
  UNKNOWN: 'The outcome is unknown: it may or may not have been recorded. Retry sends the exact same request and cannot apply it twice.',
};
const time = (value: string | null) => value === null ? 'No trustworthy time recorded' : `${new Date(value).toLocaleString('en-US', { timeZone: 'UTC' })} UTC`;
const short = (value: string) => value.slice(0, 8);
const n = (value: number) => value.toLocaleString('en-US');

export type Records = { pauses: AiSpendPauseList; queue: AiUnknownQueue };
export type ViewPhase = 'LOADING' | 'READY' | 'CONCEALED' | AiSafetyFailure;
type Pending = { prepared: PreparedCommand; label: string; kind: 'pause' | 'resolve'; state: 'SENDING' | AiSafetyFailure };

// ---------------------------------------------------------------- pure view

export type AiSafetyViewProps = {
  phase: ViewPhase; records: Records | null; pending: Pending | null; notice: string | null;
  onRefresh: () => void; onPause: (form: PauseForm) => void; onResume: (pause: AiSpendPause, reason: string) => void;
  onResolve: (item: AiUnknownOpenItem, form: ResolveForm) => void; onRetry: () => void; onDiscard: () => void;
};
export type PauseForm = { scope: 'PLATFORM' | 'ORGANIZATION'; organizationId: string; spendClass: AiSpendPauseClass; reason: string; confirmed: boolean };
export type ResolveForm = { decision: AiUnknownDecision; reason: string; reference: string; inputTokens: string; outputTokens: string; costMicrounits: string };

export function HqAiSafetyView(props: AiSafetyViewProps): React.ReactElement {
  const { phase, records, pending } = props;
  const locked = pending !== null;
  return <div className={styles.page} data-ai-safety={phase}>
    <section className={base.panel}>
      <div className={base.sectionHeader}><div><h1 className={styles.title}>AI safety</h1>
        <p>Emergency pauses and lost provider outcomes. The database decides who may act: a human HQ owner pauses, resumes and resolves; billing staff can read.</p></div>
        <button type="button" onClick={props.onRefresh} disabled={locked}>Refresh</button></div>
      <p className={shared.note}>The AI team is included in HON OS. Nothing here charges a school: pauses stop new AI work before any provider call, and resolutions settle HON’s own internal usage records.</p>
      {props.notice && <p role="status" className={styles.notice}>{props.notice}</p>}
      {pending && <div role="alert" className={styles.pending} data-pending={pending.state}>
        <strong>{pending.label}</strong>
        <p>{pending.state === 'SENDING' ? 'Sending…' : FAILURE_TEXT[pending.state]}</p>
        {pending.state === 'UNKNOWN' && <div className={styles.actions}><button type="button" onClick={props.onRetry}>Retry the same request</button>
          <button type="button" onClick={props.onDiscard}>Stop and refresh</button></div>}
        {pending.state !== 'SENDING' && pending.state !== 'UNKNOWN' && <button type="button" onClick={props.onDiscard}>Dismiss</button>}
      </div>}
    </section>
    {phase !== 'READY' || !records
      ? <section className={base.panel} role="status"><h2>{phase === 'LOADING' ? 'Loading AI safety records…' : phase === 'CONCEALED' ? 'Hidden while you were away' : 'AI safety records not shown'}</h2>
        <p>{phase === 'LOADING' ? 'Checking your HQ access.' : phase === 'CONCEALED' ? 'Refresh to check your access and show them again.' : FAILURE_TEXT[phase as AiSafetyFailure]}</p>
        {phase === 'SESSION' ? <a href="/auth/login">Sign in</a> : phase !== 'LOADING' && <button type="button" onClick={props.onRefresh}>Refresh</button>}</section>
      : <div key="records" className={styles.columns} data-ai-safety-records="">
        <PausesPanel list={records.pauses} locked={locked} onPause={props.onPause} onResume={props.onResume} />
        <UnknownPanel queue={records.queue} locked={locked} onResolve={props.onResolve} />
      </div>}
  </div>;
}

function PausesPanel({ list, locked, onPause, onResume }: { list: AiSpendPauseList; locked: boolean; onPause: AiSafetyViewProps['onPause']; onResume: AiSafetyViewProps['onResume'] }): React.ReactElement {
  const [form, setForm] = useState<PauseForm>({ scope: 'PLATFORM', organizationId: '', spendClass: 'ALL', reason: '', confirmed: false });
  const [resume, setResume] = useState<Record<string, string>>({});
  const active = list.pauses.filter(p => p.status === 'ACTIVE'), ended = list.pauses.filter(p => p.status === 'ENDED');
  return <section className={base.panel} aria-labelledby="ai-pauses" data-ai-pauses="">
    <div className={base.sectionHeader}><h2 id="ai-pauses">Emergency AI pauses</h2><span className={base.badge}>{active.length ? `${active.length} active` : 'None active'}</span></div>
    <form className={styles.form} onSubmit={event => { event.preventDefault(); onPause(form); }}>
      <fieldset disabled={locked}><legend>Pause new AI work</legend>
        <label>Applies to<select value={form.scope} onChange={e => setForm({ ...form, scope: e.target.value as PauseForm['scope'], confirmed: false })}>
          <option value="PLATFORM">The whole platform</option><option value="ORGANIZATION">One organization</option></select></label>
        {form.scope === 'ORGANIZATION' && <label>Organization ID<input value={form.organizationId} autoComplete="off" spellCheck={false}
          onChange={e => setForm({ ...form, organizationId: e.target.value.trim(), confirmed: false })} /></label>}
        <label>AI work to pause<select value={form.spendClass} onChange={e => setForm({ ...form, spendClass: e.target.value as AiSpendPauseClass, confirmed: false })}>
          {AI_SPEND_PAUSE_CLASSES.map(value => <option key={value} value={value}>{SPEND_CLASS_LABEL[value]}</option>)}</select></label>
        <label>Reason (10–500 characters)<textarea value={form.reason} maxLength={500} rows={2} onChange={e => setForm({ ...form, reason: e.target.value, confirmed: false })} /></label>
        <label className={styles.check}><input type="checkbox" checked={form.confirmed} onChange={e => setForm({ ...form, confirmed: e.target.checked })} />
          I understand new {SPEND_CLASS_LABEL[form.spendClass].toLowerCase()} stops for {form.scope === 'PLATFORM' ? 'every school' : 'this organization'} until a human HQ owner resumes it.</label>
        <button type="submit" disabled={!form.confirmed}>Pause</button>
      </fieldset>
    </form>
    <h3 className={styles.subhead}>Active</h3>
    {active.length === 0 ? <p className={shared.note}>No active pause. AI work runs within its normal safeguards.</p>
      : <ul className={styles.records}>{active.map(pause => <li key={pause.pauseId} data-pause={pause.pauseId}>
        <strong>{SPEND_CLASS_LABEL[pause.spendClass]} · {pause.organizationId ? `organization ${short(pause.organizationId)}` : 'whole platform'}</strong>
        <p>{pause.reason}</p><p className={shared.note}>Paused {time(pause.pausedAt)}</p>
        <label>Reason to resume<textarea value={resume[pause.pauseId] ?? ''} maxLength={500} rows={2} disabled={locked}
          onChange={e => setResume({ ...resume, [pause.pauseId]: e.target.value })} /></label>
        <button type="button" disabled={locked} onClick={() => onResume(pause, resume[pause.pauseId] ?? '')}>Resume</button>
      </li>)}</ul>}
    {ended.length > 0 && <details className={styles.history}><summary>Ended pauses ({ended.length})</summary><ul className={styles.records}>{ended.map(pause => <li key={pause.pauseId}>
      <strong>{SPEND_CLASS_LABEL[pause.spendClass]} · {pause.organizationId ? `organization ${short(pause.organizationId)}` : 'whole platform'}</strong>
      <p className={shared.note}>Paused {time(pause.pausedAt)} · ended {time(pause.endedAt)}</p><p>{pause.endReason}</p></li>)}</ul></details>}
    <p className={shared.note}>Records as of {time(list.asOf)}.</p>
  </section>;
}

const EMPTY_RESOLVE: ResolveForm = { decision: 'NO_PROVIDER_CHARGE', reason: '', reference: '', inputTokens: '', outputTokens: '', costMicrounits: '' };

function UnknownPanel({ queue, locked, onResolve }: { queue: AiUnknownQueue; locked: boolean; onResolve: AiSafetyViewProps['onResolve'] }): React.ReactElement {
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState<ResolveForm>(EMPTY_RESOLVE);
  const field = (key: keyof ResolveForm, label: string, numeric = false) => <label>{label}<input value={form[key]} autoComplete="off" spellCheck={false}
    inputMode={numeric ? 'numeric' : undefined} onChange={e => setForm({ ...form, [key]: e.target.value })} /></label>;
  return <section className={base.panel} aria-labelledby="ai-unknown" data-ai-unknown="">
    <div className={base.sectionHeader}><h2 id="ai-unknown">Lost provider outcomes</h2><span className={base.badge}>{queue.open.length ? `${queue.open.length} open` : 'None open'}</span></div>
    <p className={shared.note}>An AI call whose provider result was lost keeps its internal hold until a human HQ owner checks the provider’s own usage record and settles it once.
      Items older than {n(Math.round(queue.staleAfterSeconds / 60))} minutes are ready to check.</p>
    {queue.open.length === 0 ? <p className={shared.note}>Nothing to resolve.</p>
      : <ul className={styles.records}>{queue.open.map(item => <li key={item.invocationId} data-unknown={item.invocationId}>
        <strong>{AGENT_LABEL[item.agent]} · {item.status === 'UNKNOWN' ? 'result lost' : 'still marked sending'}</strong>
        <p className={shared.note}>Call {short(item.invocationId)} · school {short(item.schoolId)} · organization {short(item.organizationId)}</p>
        <p className={shared.note}>Held {time(item.heldAt)} · {n(item.reservedCredits)} internal usage units held{item.countsAgainstCurrentWindow ? ' · counts toward this month’s included limit' : ''}</p>
        {open !== item.invocationId
          ? <button type="button" disabled={locked} onClick={() => { setOpen(item.invocationId); setForm(EMPTY_RESOLVE); }}>Resolve</button>
          : <form className={styles.form} onSubmit={event => { event.preventDefault(); onResolve(item, form); }}>
            <fieldset disabled={locked}><legend>Resolve call {short(item.invocationId)}</legend>
              <label>What the provider’s record shows<select value={form.decision} onChange={e => setForm({ ...form, decision: e.target.value as AiUnknownDecision })}>
                {AI_UNKNOWN_DECISIONS.map(value => <option key={value} value={value}>{DECISION_LABEL[value]}</option>)}</select></label>
              {form.decision === 'NO_PROVIDER_CHARGE' && field('reference', 'Provider lookup reference')}
              {form.decision === 'RECORD_PROVIDER_COST' && <>{field('reference', 'Provider generation ID')}{field('inputTokens', 'Input tokens', true)}
                {field('outputTokens', 'Output tokens', true)}{field('costMicrounits', 'Provider cost (USD micro-units, 1,000,000 = USD 1.00)', true)}</>}
              {form.decision === 'WRITE_OFF' && field('costMicrounits', 'Estimated provider cost (USD micro-units)', true)}
              {form.costMicrounits && /^\d+$/.test(form.costMicrounits) && form.decision !== 'NO_PROVIDER_CHARGE'
                && <p className={shared.note}>= {formatSaasMoney(Number(form.costMicrounits), 6)} (HON’s cost; the school is not charged)</p>}
              <label>Reason (10–500 characters)<textarea value={form.reason} maxLength={500} rows={2} onChange={e => setForm({ ...form, reason: e.target.value })} /></label>
              <div className={styles.actions}><button type="submit">Record resolution</button><button type="button" onClick={() => setOpen(null)}>Cancel</button></div>
            </fieldset>
          </form>}
      </li>)}</ul>}
    {queue.resolved.length > 0 && <details className={styles.history}><summary>Recent resolutions ({queue.resolved.length})</summary><ul className={styles.records}>{queue.resolved.map(item => <li key={item.resolutionId}>
      <strong>{AGENT_LABEL[item.agent]} · {DECISION_LABEL[item.decision]}</strong>
      <p className={shared.note}>Call {short(item.invocationId)} · resolved {time(item.resolvedAt)} · {n(item.releasedCredits)} internal units released</p><p>{item.reason}</p></li>)}</ul></details>}
    <p className={shared.note}>Records as of {time(queue.asOf)}.</p>
  </section>;
}

// ---------------------------------------------------------------- input mapping (pure)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const int = (value: string): number => /^\d{1,15}$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;

export function pauseInput(form: PauseForm): { action: 'PAUSE'; organizationId: string | null; spendClass: AiSpendPauseClass; reason: string } | null {
  const reason = form.reason.trim();
  if (!form.confirmed || reason.length < 10 || reason.length > 500) return null;
  if (form.scope === 'ORGANIZATION' && !UUID.test(form.organizationId)) return null;
  return { action: 'PAUSE', organizationId: form.scope === 'PLATFORM' ? null : form.organizationId.toLowerCase(), spendClass: form.spendClass, reason };
}

export function resolutionInput(form: ResolveForm): AiUnknownResolutionInput | null {
  const reason = form.reason.trim();
  if (reason.length < 10 || reason.length > 500) return null;
  if (form.decision === 'NO_PROVIDER_CHARGE') return { decision: 'NO_PROVIDER_CHARGE', reason, evidence: { providerLookupReference: form.reference.trim() } };
  if (form.decision === 'WRITE_OFF') return { decision: 'WRITE_OFF', reason, evidence: { estimatedProviderCostMicrounits: int(form.costMicrounits) } };
  return { decision: 'RECORD_PROVIDER_COST', reason, evidence: { providerGenerationId: form.reference.trim(), inputTokens: int(form.inputTokens),
    outputTokens: int(form.outputTokens), providerCostMicrounits: int(form.costMicrounits) } };
}

// ---------------------------------------------------------------- container

/**
 * Private HQ records: concealed and dropped on blur, a hidden tab, page hide or session end; shown again only after an
 * explicit refresh re-reads them under the current session. A sent command is never cancelled by concealment.
 */
export function HqAiSafety({ api = HQ_AI_SAFETY_API }: { api?: HqAiSafetyApi }): React.ReactElement {
  const [phase, setPhase] = useState<ViewPhase>('LOADING');
  const [records, setRecords] = useState<Records | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0), reads = useRef<AbortController | null>(null), ended = useRef(false);

  const load = useCallback(() => {
    if (ended.current) return;
    const current = ++generation.current; reads.current?.abort(); const abort = new AbortController(); reads.current = abort;
    setPhase('LOADING'); setRecords(null);
    Promise.all([api.pauses(abort.signal), api.queue(abort.signal)]).then(
      ([pauses, queue]) => { if (current === generation.current) { setRecords({ pauses, queue }); setPhase('READY'); } },
      error => { if (current !== generation.current || abort.signal.aborted) return; const kind = error instanceof HqAiSafetyError ? error.kind : 'UNAVAILABLE';
        if (kind === 'SESSION') ended.current = true; setPhase(kind); });
  }, [api]);

  useEffect(() => {
    load();
    const conceal = (event: Event) => {
      if (event.type === 'visibilitychange' && document.visibilityState === 'visible') return;
      generation.current++; reads.current?.abort(); setRecords(null);
      for (const node of document.querySelectorAll<HTMLElement>('[data-ai-safety-records]')) { node.hidden = true; node.inert = true; }
      if (event.type === HON_SESSION_INVALIDATED_EVENT) { ended.current = true; setPhase('SESSION'); } else setPhase(current => current === 'SESSION' ? current : 'CONCEALED');
    };
    const windowEvents = ['blur', 'pagehide', HON_SESSION_INVALIDATED_EVENT];
    for (const name of windowEvents) window.addEventListener(name, conceal);
    document.addEventListener('visibilitychange', conceal);
    return () => { generation.current++; reads.current?.abort(); for (const name of windowEvents) window.removeEventListener(name, conceal); document.removeEventListener('visibilitychange', conceal); };
  }, [load]);

  const run = useCallback((next: Pending) => {
    setPending({ ...next, state: 'SENDING' }); setNotice(null);
    const send = next.kind === 'pause' ? api.sendPause(next.prepared) : api.sendResolution(next.prepared);
    send.then(() => { setPending(null); setNotice(`${next.label}: recorded.`); load(); },
      error => { const kind = error instanceof HqAiSafetyError ? error.kind : 'UNKNOWN'; if (kind === 'SESSION') ended.current = true; setPending({ ...next, state: kind }); });
  }, [api, load]);

  const prepare = (work: () => PreparedCommand, label: string, kind: Pending['kind']) => {
    try { run({ prepared: work(), label, kind, state: 'SENDING' }); } catch { setNotice(`${label}: check the fields. ${FAILURE_TEXT.INVALID}`); }
  };

  return <HqAiSafetyView phase={phase} records={records} pending={pending} notice={notice}
    onRefresh={() => { setNotice(null); load(); }}
    onPause={form => { const input = pauseInput(form); if (!input) { setNotice('Pause: confirm, give a 10–500 character reason and, for one organization, a valid organization ID.'); return; }
      prepare(() => preparePause(input), `Pause ${SPEND_CLASS_LABEL[input.spendClass].toLowerCase()}`, 'pause'); }}
    onResume={(pause, reason) => prepare(() => preparePause({ action: 'RESUME', organizationId: pause.organizationId, spendClass: pause.spendClass, reason: reason.trim() }),
      `Resume ${SPEND_CLASS_LABEL[pause.spendClass].toLowerCase()}`, 'pause')}
    onResolve={(item, form) => { const input = resolutionInput(form); if (!input) { setNotice('Resolve: give a 10–500 character reason.'); return; }
      prepare(() => prepareResolution(item.agent, item.invocationId, input), `Resolve call ${short(item.invocationId)}`, 'resolve'); }}
    onRetry={() => { if (pending) run({ ...pending, state: 'SENDING' }); }}
    onDiscard={() => { setPending(null); load(); }} />;
}
