'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  MEMBERSHIP_ACTIVATION_CONFIRMATION, MEMBERSHIP_ACTIVATION_OVERRIDE_CONFIRMATION, validateConfirmMembershipActivationInput,
  type ConfirmMembershipActivationInput, type MembershipActivationPreview, type MembershipActivationPreviewInput, type MembershipEffectiveStatus,
} from '@hon/contracts';
import {
  MembershipActivationError, activateKnownMembership, prepareMembershipActivation, previewMembershipActivation,
  type ActivationRequest, type KnownMembership,
} from '../membership-activation-http';
import { startText, type StartKey } from './start-membership-copy';
import styles from './people.module.css';

export { START_COPY } from './start-membership-copy';

/**
 * Starting a membership from the contact card. Under the hood this is the existing two-step server check (0177): the server
 * previews the dates, warnings and blocks, and the confirmation must match that preview exactly. Staff see one review and one
 * Start membership button. Nothing here charges, signs an agreement or records consent.
 */
export type StartFields = Readonly<{ checked: readonly string[]; note: string; overrideReason: string }>;
export type StartProblem = 'UNCHECKED' | 'NOTE_REQUIRED' | 'OVERRIDE_REASON_REQUIRED' | 'NOT_ALLOWED' | 'BLOCKED' | 'STALE' | 'DENIED' | 'REFUSED' | 'UNKNOWN' | 'SESSION';
type BodyProblem = Extract<StartProblem, 'UNCHECKED' | 'NOTE_REQUIRED' | 'OVERRIDE_REASON_REQUIRED' | 'NOT_ALLOWED' | 'BLOCKED'>;

/** The confirmation body for exactly this preview, or why it cannot be sent yet. */
export function startBody(preview: MembershipActivationPreview, fields: StartFields): ConfirmMembershipActivationInput | BodyProblem {
  if (!preview.canConfirm || preview.blocks.length > 0 || preview.proposedDates.startDate === null) return 'BLOCKED';
  const codes = preview.warnings.map(w => w.code);
  if (codes.some(c => !fields.checked.includes(c))) return 'UNCHECKED';
  const note = fields.note.trim(), adjusted = preview.proposedDates.dateSource === 'STAFF_ADJUSTED', backdated = codes.includes('START_DATE_BACKDATED');
  if ((adjusted || backdated) && !note) return 'NOTE_REQUIRED';
  const overrides = [];
  if (preview.overridableWarnings.length > 0) {
    if (preview.overridableWarnings.some(c => !preview.availableOverrides.includes(c))) return 'NOT_ALLOWED';
    const reason = fields.overrideReason.trim();
    if (reason.length < 10) return 'OVERRIDE_REASON_REQUIRED';
    for (const code of preview.overridableWarnings) overrides.push({ code, reason, confirmation: MEMBERSHIP_ACTIVATION_OVERRIDE_CONFIRMATION });
  }
  const body: Record<string, unknown> = { expectedVersion: preview.version, previewDigest: preview.previewDigest, startDate: preview.proposedDates.startDate,
    endDate: preview.proposedDates.endDate, dateSource: preview.proposedDates.dateSource, acknowledgedWarnings: codes, overrides, reasonCode: 'ROUTINE_ENROLLMENT',
    confirmation: MEMBERSHIP_ACTIVATION_CONFIRMATION };
  if (adjusted) body.dateAdjustmentReason = note;
  if (note) body.reasonText = note;
  try { return validateConfirmMembershipActivationInput(body); } catch { return note.length > 500 ? 'NOTE_REQUIRED' : 'BLOCKED'; }
}

export type StartState = Readonly<{ kind: 'LOADING' | 'UNAVAILABLE' | 'DENIED' | 'GONE' }> | Readonly<{ kind: 'READY'; preview: MembershipActivationPreview }>
  | Readonly<{ kind: 'DONE'; status: MembershipEffectiveStatus; startDate: string }>;
export type StartDates = Readonly<{ startDate: string; endDate: string | null }>;
export type StartMembershipViewProps = Readonly<{
  language: string; state: StartState; dates: StartDates; checked: readonly string[]; note: string; overrideReason: string;
  problem: StartProblem | null; busy: boolean; canRetry: boolean;
  onDates?: ((dates: StartDates) => void) | undefined; onCheck?: ((code: string, on: boolean) => void) | undefined; onNote?: ((note: string) => void) | undefined;
  onOverrideReason?: ((reason: string) => void) | undefined; onSubmit?: (() => void) | undefined; onRetry?: (() => void) | undefined; onClose?: (() => void) | undefined;
}>;

const day = (language: string, value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString(language, { dateStyle: 'medium', timeZone: 'UTC' });
function planName(p: MembershipActivationPreview): string {
  const name = p.plan?.terms && typeof p.plan.terms.displayName === 'string' ? p.plan.terms.displayName : null;
  return name ?? p.planCode;
}

/** Pure view: one review, one button. */
export function StartMembershipView(p: StartMembershipViewProps): React.ReactElement {
  const t = (key: StartKey, vars?: Readonly<Record<string, string | number>>) => startText(p.language, key, vars);
  const close = p.onClose ? <button type="button" className={styles.secondary} onClick={p.onClose} disabled={p.busy}>{t('close')}</button> : null;
  const problem = p.problem ? <div className={styles.notice} role="status" data-testid="start-membership-problem"><p>{t(`p_${p.problem}`)}</p>
    {p.canRetry && p.onRetry ? <button type="button" className={styles.primary} onClick={p.onRetry} disabled={p.busy}>{t('tryAgain')}</button> : null}</div> : null;
  const s = p.state;
  if (s.kind !== 'READY') {
    const text = s.kind === 'DONE' ? s.status === 'SCHEDULED' ? t('doneScheduled', { date: day(p.language, s.startDate) }) : s.status === 'ENDED' ? t('doneEnded') : t('doneStarted')
      : s.kind === 'LOADING' ? t('loading') : s.kind === 'DENIED' ? t('denied') : s.kind === 'GONE' ? t('gone') : t('unavailable');
    return <section className={styles.subsection} data-testid="start-membership" aria-label={t('title')}>
      <p className={styles.notice} role="status" data-kind={s.kind}>{text}</p>{problem}{close}</section>;
  }
  const v = s.preview, unchecked = v.warnings.some(w => !p.checked.includes(w.code));
  const needsOverride = v.overridableWarnings.length > 0, overrideAllowed = needsOverride && v.overridableWarnings.every(c => v.availableOverrides.includes(c));
  const disabled = p.busy || !v.canConfirm || v.blocks.length > 0 || unchecked || (needsOverride && !overrideAllowed);
  return <section className={styles.subsection} data-testid="start-membership" aria-labelledby="start-membership-title">
    <h3 id="start-membership-title">{t('title')}</h3>
    <dl className={styles.facts2}>
      <div><dt>{t('student')}</dt><dd>{v.participantDisplayName ?? '—'}</dd></div>
      <div><dt>{t('plan')}</dt><dd>{planName(v)}</dd></div>
    </dl>
    <fieldset disabled={p.busy}>
      <label>{t('startDate')}<input type="date" required value={p.dates.startDate} onChange={e => p.onDates?.({ ...p.dates, startDate: e.target.value })}/></label>
      <label>{t('endDate')}<input type="date" value={p.dates.endDate ?? ''} onChange={e => p.onDates?.({ ...p.dates, endDate: e.target.value || null })}/></label>
      <p className={styles.meta}>{v.proposedDates.dateSource === 'SUGGESTED' ? t('suggested') : null} {t('openEnded')}</p>
      {v.blocks.length > 0 ? <div className={styles.notice} role="status"><h4>{t('blockTitle')}</h4>
        <ul>{v.blocks.map(b => <li key={b.code}>{t(`b_${b.code}`)}</li>)}</ul></div> : null}
      {v.warnings.length > 0 ? <div><h4>{t('checkTitle')}</h4>{v.warnings.map(w => <label key={w.code} className={styles.check}>
        <input type="checkbox" checked={p.checked.includes(w.code)} onChange={e => p.onCheck?.(w.code, e.target.checked)}/>
        {t(`w_${w.code}`, { days: w.days ?? '', date: w.planEndDate ? day(p.language, w.planEndDate) : '' })}</label>)}</div> : null}
      {needsOverride ? overrideAllowed ? <label>{t('overrideReason')}<textarea minLength={10} maxLength={500} value={p.overrideReason}
        onChange={e => p.onOverrideReason?.(e.target.value)}/><span className={styles.meta}>{t('overrideHelp')}</span></label>
        : <p className={styles.meta} role="note">{t('overrideNotAllowed')}</p> : null}
      <label>{t('note')}<textarea maxLength={500} value={p.note} onChange={e => p.onNote?.(e.target.value)}/><span className={styles.meta}>{t('noteHelp')}</span></label>
    </fieldset>
    <p className={styles.meta}>{t('nothingCharged')}</p>
    {problem}
    <div className={styles.row}>
      <button type="button" className={styles.primary} data-testid="start-membership-submit" disabled={disabled} onClick={p.onSubmit}>{p.busy ? t('starting') : t('submit')}</button>
      {close}
    </div>
  </section>;
}

const STALE_CODES = ['ACTIVATION_PREVIEW_STALE', 'VERSION_CONFLICT', 'DATE_SOURCE_MISMATCH', 'ACTIVATION_ACKNOWLEDGEMENT_REQUIRED'];
function problemOf(error: unknown): StartProblem {
  if (!(error instanceof MembershipActivationError)) return 'UNKNOWN';
  if (error.status === 401) return 'SESSION';
  if (error.uncertain) return 'UNKNOWN';
  if (STALE_CODES.includes(error.code)) return 'STALE';
  if (error.status === 403 || error.code === 'ACTIVATION_OVERRIDE_FORBIDDEN') return 'DENIED';
  if (error.code === 'ACTIVATION_BLOCKED' || error.code === 'MEMBERSHIP_NOT_DRAFT') return 'BLOCKED';
  return 'REFUSED';
}

export type StartMembershipApi = Readonly<{
  preview: (scope: KnownMembership, input: MembershipActivationPreviewInput, signal?: AbortSignal) => Promise<MembershipActivationPreview>;
  start: (request: ActivationRequest) => ReturnType<typeof activateKnownMembership>;
}>;
const defaultApi: StartMembershipApi = { preview: previewMembershipActivation, start: activateKnownMembership };

/**
 * Reads the server's check for one membership that has not started, lets staff adjust the dates (each change asks the server
 * again), and sends one start request. A request whose outcome is unknown is kept in memory only, so Try again resends the
 * identical request and key; the server never starts it twice.
 */
export function StartMembership({ language, scope, onStarted, onClose, api = defaultApi }: { language: string; scope: KnownMembership;
  onStarted?: (() => void) | undefined; onClose?: (() => void) | undefined; api?: StartMembershipApi }): React.ReactElement {
  const [state, setState] = useState<StartState>({ kind: 'LOADING' });
  const [dates, setDates] = useState<StartDates>({ startDate: '', endDate: null });
  const [checked, setChecked] = useState<readonly string[]>([]);
  const [note, setNote] = useState(''), [overrideReason, setOverrideReason] = useState('');
  const [problem, setProblem] = useState<StartProblem | null>(null);
  const [busy, setBusy] = useState(false), [previewing, setPreviewing] = useState(true);
  const [ask, setAsk] = useState<{ n: number; input: MembershipActivationPreviewInput }>({ n: 0, input: {} });
  const kept = useRef<ActivationRequest | null>(null), mounted = useRef(true), generation = useRef(0);
  const { organizationId, schoolId, membershipId } = scope;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; kept.current = null; }; }, []);

  useEffect(() => {
    const current = ++generation.current, abort = new AbortController();
    setState(prior => prior.kind === 'READY' ? prior : { kind: 'LOADING' }); setPreviewing(true);
    api.preview({ organizationId, schoolId, membershipId }, ask.input, abort.signal).then(
      preview => {
        if (current !== generation.current) return;
        setPreviewing(false);
        if (preview.state !== 'DRAFT') { setState({ kind: 'GONE' }); return; }
        setState({ kind: 'READY', preview }); setChecked([]);
        if (preview.proposedDates.startDate) setDates({ startDate: preview.proposedDates.startDate, endDate: preview.proposedDates.endDate });
      },
      error => {
        if (current !== generation.current || abort.signal.aborted) return;
        setPreviewing(false);
        const kind = problemOf(error);
        setState({ kind: kind === 'DENIED' || kind === 'SESSION' ? 'DENIED' : error instanceof MembershipActivationError && error.status === 404 ? 'GONE' : 'UNAVAILABLE' });
      });
    return () => { abort.abort(); };
  }, [api, organizationId, schoolId, membershipId, ask]);

  const onDates = useCallback((next: StartDates) => {
    setDates(next); setProblem(null);
    if (/^\d{4}-\d{2}-\d{2}$/.test(next.startDate) && (next.endDate === null || /^\d{4}-\d{2}-\d{2}$/.test(next.endDate)))
      setAsk(prior => ({ n: prior.n + 1, input: { startDate: next.startDate, endDate: next.endDate } }));
  }, []);
  const onCheck = useCallback((code: string, on: boolean) => setChecked(prior => on ? [...prior.filter(c => c !== code), code] : prior.filter(c => c !== code)), []);

  const send = useCallback(async (request: ActivationRequest) => {
    setBusy(true); setProblem(null);
    try {
      const result = await api.start(request);
      kept.current = null;
      if (!mounted.current) return;
      setState({ kind: 'DONE', status: result.receipt.effectiveStatusAtActivation, startDate: result.receipt.effectivePeriod.startDate });
      onStarted?.();
    } catch (error) {
      const kind = problemOf(error);
      kept.current = kind === 'UNKNOWN' ? request : null;
      if (!mounted.current) return;
      setProblem(kind);
      if (kind === 'STALE') setAsk(prior => ({ n: prior.n + 1, input: prior.input }));
    } finally { if (mounted.current) setBusy(false); }
  }, [api, onStarted]);

  const onSubmit = useCallback(() => {
    if (busy || previewing || kept.current || state.kind !== 'READY') return;
    const body = startBody(state.preview, { checked, note, overrideReason });
    if (typeof body === 'string') { setProblem(body); return; }
    let request: ActivationRequest;
    try { request = prepareMembershipActivation({ organizationId, schoolId, membershipId }, body, globalThis.crypto.randomUUID()); }
    catch { setProblem('REFUSED'); return; }
    void send(request);
  }, [busy, previewing, state, checked, note, overrideReason, organizationId, schoolId, membershipId, send]);
  const onRetry = useCallback(() => { if (kept.current && !busy) void send(kept.current); }, [busy, send]);

  return <StartMembershipView language={language} state={state} dates={dates} checked={checked} note={note} overrideReason={overrideReason}
    problem={problem} busy={busy || previewing} canRetry={kept.current !== null} onDates={onDates} onCheck={onCheck} onNote={setNote} onOverrideReason={setOverrideReason}
    onSubmit={onSubmit} onRetry={onRetry} onClose={onClose}/>;
}
