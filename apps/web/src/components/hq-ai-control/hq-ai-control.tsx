'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AiSchoolCostAlertAckInput, AiSchoolCostAlertList, AiSchoolUsageReport, AiSpendPauseInput, AiSpendPauseList, AiUnknownQueue, AiUnknownResolutionInput, AiLateProviderExpenseInput } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { loadHqSchoolDirectory } from '../hq-school-directory-http';
import { AiControlError, aiControlApi, keepForRetry, lastDays, toMicro, type AiControlApi } from './http';
import { AiCostAlertsView, AiCostsView, AiSafetyView, alertKey, type AlertOutcome, RANGE_DAYS, type Fields, type Names, type RangeKey, type ReadState, type SafetyAction, type SafetyForm, type SafetyOutcome } from './view';

/** School names for display only: schoolId -> "Organization — School". Never authority. */
export type DirectoryLoader = (signal: AbortSignal) => Promise<ReadonlyMap<string, { school: string; org: string }>>;
const loadDirectory: DirectoryLoader = async (signal) => new Map((await loadHqSchoolDirectory(signal)).schools
  .map((s) => [s.schoolId.toLowerCase(), { school: s.schoolDisplayName, org: s.organizationDisplayName }] as const));
const systemNow = () => Date.now();
const EMPTY: Names = { schools: new Map(), orgs: new Map() };
/** Names from the directory, with each organization named through a school the usage read places in it. */
function namesFrom(directory: ReadonlyMap<string, { school: string; org: string }>, usage: AiSchoolUsageReport | null): Names {
  const schools = new Map<string, string>(), orgs = new Map<string, string>();
  for (const [id, d] of directory) schools.set(id, `${d.org} — ${d.school}`);
  for (const s of usage?.schools ?? []) { const d = directory.get(s.schoolId.toLowerCase()); if (d) orgs.set(s.organizationId.toLowerCase(), d.org); }
  for (const o of usage?.organizations ?? []) if (!orgs.has(o.organizationId.toLowerCase())) orgs.set(o.organizationId.toLowerCase(), '');
  for (const [id, name] of orgs) if (!name) orgs.delete(id);
  return { schools, orgs };
}
const readFailed = (error: unknown): { state: 'DENIED' | 'UNAVAILABLE' } => ({ state: error instanceof AiControlError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' });

/** Blur, a hidden tab, page hide or a session end: hide everything and retire reads. "Show again" reads fresh. */
function useConceal(onConceal: () => void): [boolean, () => void] {
  const [concealed, setConcealed] = useState(false);
  const callback = useRef(onConceal); callback.current = onConceal;
  useEffect(() => {
    const conceal = () => { callback.current(); setConcealed(true); };
    const visibility = () => { if (document.visibilityState === 'hidden') conceal(); };
    window.addEventListener('blur', conceal); document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', conceal);
    window.addEventListener(HON_SESSION_INVALIDATED_EVENT, conceal);
    return () => { window.removeEventListener('blur', conceal); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', conceal);
      window.removeEventListener(HON_SESSION_INVALIDATED_EVENT, conceal); };
  }, []);
  return [concealed, useCallback(() => setConcealed(false), [])];
}

/** HQ AI Costs (S4-e): per-school usage and provider cost for the last 7, 30 or 90 days. Read only. */
export function HqAiCosts({ api = aiControlApi, directoryLoader = loadDirectory, now = systemNow }: { api?: AiControlApi; directoryLoader?: DirectoryLoader; now?: () => number }): React.ReactElement {
  const { preferences } = useLocale();
  const [range, setRange] = useState<RangeKey>('r30');
  const [usage, setUsage] = useState<ReadState<AiSchoolUsageReport>>({ state: 'LOADING' });
  const [directory, setDirectory] = useState<ReadonlyMap<string, { school: string; org: string }>>(new Map());
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0), privacy = useRef(0), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; privacy.current++; }; }, []);
  const [concealed, reveal] = useConceal(() => { generation.current++; privacy.current++; setUsage({ state: 'LOADING' }); setDirectory(new Map()); });

  useEffect(() => {
    if (concealed) return;
    const current = ++generation.current, shown = privacy.current;
    const owned = () => mounted.current && current === generation.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    setUsage({ state: 'LOADING' });
    const { from, to } = lastDays(RANGE_DAYS[range], now());
    api.usage(from, to, signal, owned).then((view) => { if (owned()) setUsage({ state: 'READY', view }); },
      (error) => { if (owned() && !abort.signal.aborted) setUsage(readFailed(error)); });
    // Names are a display aid: a refused directory leaves ids shown, never hides a number.
    directoryLoader(signal).then((map) => { if (owned()) setDirectory(map); }, () => {});
    return () => { abort.abort(); };
  }, [api, directoryLoader, now, range, refresh, concealed]);

  return <AiCostsView language={preferences.language} concealed={concealed} range={range} usage={usage}
    names={namesFrom(directory, usage.state === 'READY' ? usage.view : null)}
    onRange={setRange} onRefresh={() => setRefresh((n) => n + 1)} onReveal={reveal}/>;
}

/** The request body for a safety action, from the form; it throws when the details are not acceptable. */
export function safetyBody(form: Exclude<SafetyForm, null>, fields: Fields, pauses: AiSpendPauseList | null): AiSpendPauseInput | AiUnknownResolutionInput | AiLateProviderExpenseInput {
  const reason = (fields.reason ?? '').trim();
  const count = (v: string | undefined) => { const s = (v ?? '').trim(); if (!/^\d{1,9}$/.test(s)) throw new AiControlError('INVALID'); return Number(s); };
  const micro = (v: string | undefined) => { const m = toMicro(v ?? ''); if (m === null) throw new AiControlError('INVALID'); return m; };
  const evidence = () => ({ providerGenerationId: (fields.providerGenerationId ?? '').trim(), inputTokens: count(fields.inputTokens), outputTokens: count(fields.outputTokens),
    providerCostMicrounits: micro(fields.providerCost) });
  if (form.action === 'pause') {
    const org = (fields.organizationId ?? '').trim();
    return { action: 'PAUSE', organizationId: org || null, spendClass: (fields.spendClass ?? '') as AiSpendPauseInput['spendClass'], reason };
  }
  if (form.action === 'resume') {
    const pause = pauses?.pauses.find((x) => x.pauseId === form.pauseId && x.status === 'ACTIVE');
    if (!pause) throw new AiControlError('CHANGED');
    return { action: 'RESUME', organizationId: pause.organizationId, spendClass: pause.spendClass, reason };
  }
  if (form.action === 'late') return { reason, evidence: evidence() };
  if (fields.decision === 'RECORD_PROVIDER_COST') return { decision: 'RECORD_PROVIDER_COST', reason, evidence: evidence() };
  if (fields.decision === 'NO_PROVIDER_CHARGE') return { decision: 'NO_PROVIDER_CHARGE', reason, evidence: { providerLookupReference: (fields.providerLookupReference ?? '').trim() } };
  if (fields.decision === 'WRITE_OFF') return { decision: 'WRITE_OFF', reason, evidence: { estimatedProviderCostMicrounits: micro(fields.estimate) } };
  throw new AiControlError('INVALID');
}

type Pending = Readonly<{ key: string; action: SafetyAction; form: Exclude<SafetyForm, null>; agent: string | null; body: unknown }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';
const FIXABLE = ['INVALID', 'RATE', 'UNKNOWN'];

/**
 * HQ AI Safety (S4-c, S4-d): emergency spend pauses and lost AI outcomes. The HQ owner pauses or resumes, settles a lost
 * call with the provider's evidence, or records a late provider charge after a write-off. Every answer is followed by fresh
 * reads; an unknown outcome keeps the exact request in memory so Try again replays the same key. Leaving the tab drops it.
 */
export function HqAiSafety({ api = aiControlApi, directoryLoader = loadDirectory, now = systemNow }: { api?: AiControlApi; directoryLoader?: DirectoryLoader; now?: () => number }): React.ReactElement {
  const { preferences } = useLocale();
  const [pauses, setPauses] = useState<ReadState<AiSpendPauseList>>({ state: 'LOADING' });
  const [unknown, setUnknown] = useState<ReadState<AiUnknownQueue>>({ state: 'LOADING' });
  const [names, setNames] = useState<Names>(EMPTY);
  const [form, setForm] = useState<SafetyForm>(null);
  const [outcome, setOutcome] = useState<SafetyOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0), privacy = useRef(0), mounted = useRef(false), pending = useRef<Pending | null>(null), sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; privacy.current++; pending.current = null; }; }, []);
  const [concealed, reveal] = useConceal(() => {
    generation.current++; privacy.current++; pending.current = null; setLock(sending.current ? 'SENDING' : 'NONE');
    setPauses({ state: 'LOADING' }); setUnknown({ state: 'LOADING' }); setNames(EMPTY); setForm(null); setOutcome(null);
  });

  useEffect(() => {
    if (concealed) return;
    const current = ++generation.current, shown = privacy.current;
    const owned = () => mounted.current && current === generation.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    setPauses({ state: 'LOADING' }); setUnknown({ state: 'LOADING' });
    api.pauses(signal, owned).then((view) => { if (owned()) setPauses({ state: 'READY', view }); }, (error) => { if (owned() && !abort.signal.aborted) setPauses(readFailed(error)); });
    api.unknown(signal, owned).then((view) => { if (owned()) setUnknown({ state: 'READY', view }); }, (error) => { if (owned() && !abort.signal.aborted) setUnknown(readFailed(error)); });
    // Organization choices for a pause come from the last 90 days of usage; names are a display aid only.
    const { from, to } = lastDays(90, now());
    Promise.all([directoryLoader(signal).catch(() => new Map()), api.usage(from, to, signal, owned).catch(() => null)])
      .then(([directory, usage]) => { if (owned()) setNames(namesFrom(directory, usage)); });
    return () => { abort.abort(); };
  }, [api, directoryLoader, now, refresh, concealed]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING', action: request.action });
    let next: SafetyOutcome, keep = false;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      const signal = AbortSignal.timeout(30000), id = 'invocationId' in request.form ? request.form.invocationId : '';
      let replayed: boolean | undefined;
      if (request.action === 'pause' || request.action === 'resume') replayed = (await api.pause(request.body as AiSpendPauseInput, request.key, signal, owned)).replayed;
      else if (request.action === 'resolve') replayed = (await api.resolve(request.agent as never, id, request.body as AiUnknownResolutionInput, request.key, signal, owned)).replayed;
      else replayed = (await api.lateExpense(request.agent as never, id, request.body as AiLateProviderExpenseInput, request.key, signal, owned)).replayed;
      next = { kind: 'DONE', action: request.action, replayed };
    } catch (error) {
      keep = keepForRetry(error);
      next = { kind: error instanceof AiControlError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN', action: request.action };
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next);
    if (next.kind === 'DONE' || !FIXABLE.includes(next.kind)) setForm(null);
    setRefresh((n) => n + 1);
  }, [api]);

  const onSubmit = useCallback((target: Exclude<SafetyForm, null>, fields: Fields) => {
    if (lock !== 'NONE' || pending.current || sending.current) return;
    const action: SafetyAction = target.action;
    let agent: string | null = null;
    if (target.action === 'resolve' || target.action === 'late') {
      const queue = unknown.state === 'READY' ? unknown.view : null;
      const item = target.action === 'resolve' ? queue?.open.find((x) => x.invocationId === target.invocationId) : queue?.resolved.find((x) => x.invocationId === target.invocationId);
      if (!item) { setOutcome({ kind: 'CHANGED', action }); setForm(null); return; }
      agent = item.agent;
    }
    let body: unknown;
    try { body = safetyBody(target, fields, pauses.state === 'READY' ? pauses.view : null); }
    catch (error) { setOutcome({ kind: error instanceof AiControlError ? error.kind : 'INVALID', action }); return; }
    pending.current = { key: globalThis.crypto.randomUUID(), action, form: target, agent, body };
    void send();
  }, [lock, unknown, pauses, send]);

  return <AiSafetyView language={preferences.language} concealed={concealed} pauses={pauses} unknown={unknown} names={names}
    form={form} outcome={outcome} locked={lock !== 'NONE'} canRetry={lock === 'KEPT'}
    onRefresh={() => setRefresh((n) => n + 1)} onReveal={reveal}
    onOpen={(next) => { if (lock === 'NONE') { setForm(next); setOutcome(null); } }} onClose={() => { if (lock === 'NONE') setForm(null); }}
    onSubmit={onSubmit} onTryAgain={() => { void send(); }}
    // Dropping a kept request is safe: the database refuses a second pause, settlement or late charge for the same item, and fresh reads show what happened.
    onDiscard={() => { if (lock !== 'KEPT' || sending.current) return; pending.current = null; setLock('NONE'); setForm(null); setOutcome(null); setRefresh((n) => n + 1); }}/>;
}

type AlertPending = Readonly<{ key: string; body: AiSchoolCostAlertAckInput }>;

/**
 * HQ AI cost limit alerts (0343): schools at 75%, 90% or 100% of their internal AI cost limit this window. Any HQ billing
 * reader sees them; only the human HQ owner acknowledges, once per school, level and window. An unknown outcome keeps the
 * exact request so Try again replays the same key. Acknowledging changes no limit, pause or spend decision.
 */
export function HqAiCostAlerts({ api = aiControlApi }: { api?: AiControlApi }): React.ReactElement {
  const { preferences } = useLocale();
  const [alerts, setAlerts] = useState<ReadState<AiSchoolCostAlertList>>({ state: 'LOADING' });
  const [open, setOpen] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<AlertOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0), privacy = useRef(0), mounted = useRef(false), pending = useRef<AlertPending | null>(null), sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; privacy.current++; pending.current = null; }; }, []);
  const [concealed, reveal] = useConceal(() => {
    generation.current++; privacy.current++; pending.current = null; setLock(sending.current ? 'SENDING' : 'NONE');
    setAlerts({ state: 'LOADING' }); setOpen(null); setOutcome(null);
  });

  useEffect(() => {
    if (concealed) return;
    const current = ++generation.current, shown = privacy.current;
    const owned = () => mounted.current && current === generation.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    setAlerts({ state: 'LOADING' });
    api.costAlerts(signal, owned).then((view) => { if (owned()) setAlerts({ state: 'READY', view }); }, (error) => { if (owned() && !abort.signal.aborted) setAlerts(readFailed(error)); });
    return () => { abort.abort(); };
  }, [api, refresh, concealed]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING' });
    let next: AlertOutcome, keep = false;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      next = { kind: 'DONE', replayed: (await api.acknowledgeCostAlert(request.body, request.key, AbortSignal.timeout(30000), owned)).replayed };
    } catch (error) {
      keep = keepForRetry(error);
      next = { kind: error instanceof AiControlError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN' };
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next);
    if (next.kind === 'DONE' || !FIXABLE.includes(next.kind)) setOpen(null);
    setRefresh((n) => n + 1);
  }, [api]);

  const onSubmit = useCallback((target: string, reason: string) => {
    if (lock !== 'NONE' || pending.current || sending.current) return;
    const alert = alerts.state === 'READY' ? alerts.view.alerts.find((a) => alertKey(a) === target && a.acknowledgement === null) : undefined;
    if (!alert) { setOutcome({ kind: 'CHANGED' }); setOpen(null); return; }
    const text = reason.trim();
    if (text.length < 10 || text.length > 500) { setOutcome({ kind: 'INVALID' }); return; }
    pending.current = { key: globalThis.crypto.randomUUID(), body: { schoolId: alert.schoolId, level: alert.level, windowStart: alert.windowStart, reason: text } };
    void send();
  }, [lock, alerts, send]);

  return <AiCostAlertsView language={preferences.language} concealed={concealed} alerts={alerts} open={open} outcome={outcome}
    locked={lock !== 'NONE'} canRetry={lock === 'KEPT'} onRefresh={() => setRefresh((n) => n + 1)} onReveal={reveal}
    onOpen={(key) => { if (lock === 'NONE') { setOpen(key); setOutcome(null); } }} onClose={() => { if (lock === 'NONE') setOpen(null); }}
    onSubmit={onSubmit} onTryAgain={() => { void send(); }}
    // Dropping a kept request is safe: the database accepts one acknowledgement per school, level and window.
    onDiscard={() => { if (lock !== 'KEPT' || sending.current) return; pending.current = null; setLock('NONE'); setOpen(null); setOutcome(null); setRefresh((n) => n + 1); }}/>;
}
