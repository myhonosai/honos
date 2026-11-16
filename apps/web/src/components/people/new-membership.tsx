'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PERSON_MEMBERSHIP_START_CONFIRMATION, type MembershipPlanListing, type PersonMembershipStartInput, type PersonMembershipStartOptions } from '@hon/contracts';
import { PlanAccessError, readAdultPlanOptions } from '../membership-plans/http';
import { formatMinor, type MembershipItem } from './contact-card';
import { newText, type NewKey } from './new-membership-copy';
import {
  NewMembershipError, prepareNewMembership, readNewMembershipOptions, sendNewMembership, type NewMembershipRequest, type PersonScope,
} from './new-membership-http';
import { StartMembership } from './start-membership';
import styles from './people.module.css';

export { NEW_COPY } from './new-membership-copy';

/**
 * New membership and Renew on the contact card (0398). Staff pick a plan for sale, a first day and who pays; the server makes one
 * membership that has not started, bound to that exact plan version, and the card goes straight on to the usual start review
 * (0177). One membership per program at a time: the server refuses overlaps. Nothing here charges, schedules or sends anything.
 */
export type RenewTarget = Readonly<{ membershipId: string; programId: string | null; planCode: string; label: string; endDate: string; renewStartDate: string }>;
export type NewMode = Readonly<{ kind: 'NEW' }> | Readonly<{ kind: 'RENEW'; target: RenewTarget }>;
export type NewForm = Readonly<{ planId: string; startDate: string; payerPersonId: string | null }>;
export type NewLoad = Readonly<{ kind: 'LOADING' | 'UNAVAILABLE' | 'DENIED' }> | Readonly<{ kind: 'READY'; plans: readonly MembershipPlanListing[] }>;
type Body = Omit<PersonMembershipStartInput, 'personId'>;

/** Plans staff may pick: for a renewal, only plans in the same program (plans without a program share one group). */
export function plansFor(plans: readonly MembershipPlanListing[], mode: NewMode): readonly MembershipPlanListing[] {
  return mode.kind === 'RENEW' ? plans.filter(p => p.programId === mode.target.programId) : plans;
}
/** The first form: the school's today (or the day after the renewed membership ends), the same plan code when renewing, the server's default payer. */
export function initialForm(options: PersonMembershipStartOptions, plans: readonly MembershipPlanListing[], mode: NewMode): NewForm {
  const choices = plansFor(plans, mode);
  const same = mode.kind === 'RENEW' ? choices.find(p => p.planCode === mode.target.planCode) : undefined;
  const planId = same?.planId ?? (choices.length === 1 ? choices[0]!.planId : '');
  return { planId, startDate: mode.kind === 'RENEW' ? mode.target.renewStartDate : options.schoolToday, payerPersonId: options.defaultPayerPersonId };
}
/** The exact request body for the picked plan version, or what is still missing. */
export function newMembershipBody(form: NewForm, plans: readonly MembershipPlanListing[], mode: NewMode): Body | 'p_PLAN' | 'p_DATE' {
  const plan = plansFor(plans, mode).find(p => p.planId === form.planId);
  if (!plan) return 'p_PLAN';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.startDate)) return 'p_DATE';
  return { membershipPlanId: plan.planId, membershipPlanVersion: plan.version, kind: mode.kind, renewsMembershipId: mode.kind === 'RENEW' ? mode.target.membershipId : null,
    startDate: form.startDate, payerPersonId: form.payerPersonId, confirmation: PERSON_MEMBERSHIP_START_CONFIRMATION };
}
/** What the server said, in staff words. Unknown blocker codes were already dropped by the HTTP layer. */
export function problemKeys(error: unknown): readonly NewKey[] {
  if (!(error instanceof NewMembershipError)) return ['p_UNKNOWN'];
  if (error.problem === 'BLOCKED') return error.blockers.length ? error.blockers.map(b => `b_${b}` as NewKey) : ['p_REFUSED'];
  return [`p_${error.problem}` as NewKey];
}
/** Memberships the server says can be renewed, named as the card names them. */
export function renewTargets(options: PersonMembershipStartOptions, items: readonly MembershipItem[]): readonly RenewTarget[] {
  return options.memberships.filter(m => m.renewable && m.endDate && m.renewStartDate).map(m => {
    const item = items.find(i => i.membershipId === m.membershipId);
    return { membershipId: m.membershipId, programId: m.programId, planCode: m.planCode, label: item?.planName ?? m.planCode, endDate: m.endDate!, renewStartDate: m.renewStartDate! };
  });
}

const day = (language: string, value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString(language, { dateStyle: 'medium', timeZone: 'UTC' });

export type NewMembershipViewProps = Readonly<{
  language: string; mode: NewMode; options: PersonMembershipStartOptions; load: NewLoad; form: NewForm; notices: readonly NewKey[]; busy: boolean; canRetry: boolean;
  onForm?: ((form: NewForm) => void) | undefined; onSubmit?: (() => void) | undefined; onRetry?: (() => void) | undefined; onClose?: (() => void) | undefined;
}>;

/** Pure view: plan, first day, who pays, and one Continue button. */
export function NewMembershipView(p: NewMembershipViewProps): React.ReactElement {
  const t = (key: NewKey, vars?: Record<string, string | number>) => newText(p.language, key, vars);
  const title = p.mode.kind === 'RENEW' ? t('titleRenew') : t('titleNew');
  const close = p.onClose ? <button type="button" className={styles.secondary} onClick={p.onClose} disabled={p.busy}>{t('close')}</button> : null;
  const notices = p.notices.length ? <div className={styles.notice} role="status" data-testid="new-membership-problem">
    {p.notices.map(k => <p key={k}>{t(k)}</p>)}
    {p.canRetry && p.onRetry ? <button type="button" className={styles.primary} onClick={p.onRetry} disabled={p.busy}>{t('tryAgain')}</button> : null}</div> : null;
  const shell = (body: React.ReactNode) => <section className={styles.subsection} data-testid="new-membership" aria-label={title}><h3>{title}</h3>{body}</section>;
  if (p.load.kind !== 'READY') return shell(<><p className={styles.notice} role="status" data-kind={p.load.kind}>
    {p.load.kind === 'LOADING' ? t('loading') : p.load.kind === 'DENIED' ? t('denied') : t('unavailable')}</p>{close}</>);
  const plans = plansFor(p.load.plans, p.mode);
  if (!plans.length) return shell(<><p className={styles.notice} role="status" data-kind="NO_PLANS">{p.mode.kind === 'RENEW' ? t('noRenewPlans') : t('noPlans')}</p>{close}</>);
  const plan = plans.find(x => x.planId === p.form.planId);
  const o = p.options;
  const payerName = (id: string) => { const x = o.payers.find(y => y.personId === id)!;
    return `${x.givenName} ${x.familyName} (${x.relation === 'SELF' ? t('payerSelf') : t('payerGuardian')}${x.billingContact ? `, ${t('billingContact')}` : ''})`; };
  return shell(<>
    {p.mode.kind === 'RENEW' ? <p className={styles.meta}>{t('renewing', { plan: p.mode.target.label, date: day(p.language, p.mode.target.endDate) })}</p> : null}
    <fieldset disabled={p.busy}>
      <label>{t('plan')}<select required value={p.form.planId} data-testid="new-membership-plan" onChange={e => p.onForm?.({ ...p.form, planId: e.target.value })}>
        <option value="">{t('choosePlan')}</option>
        {plans.map(x => <option key={x.planId} value={x.planId}>{x.displayName} · {formatMinor(p.language, x.currency, x.priceMinor)}</option>)}
      </select></label>
      {plan ? <dl className={styles.facts2} data-testid="new-membership-terms">
        <div><dt>{t('program')}</dt><dd>{plan.programName ?? t('noProgram')}</dd></div>
        <div><dt>{t('term')}</dt><dd>{plan.termKind === 'FIXED_MONTHS' && plan.termMonths ? t('months', { n: plan.termMonths }) : t('openEnded')}</dd></div>
        <div><dt>{t('price')}</dt><dd>{formatMinor(p.language, plan.currency, plan.priceMinor)}</dd></div>
      </dl> : null}
      <label>{t('startDate')}<input type="date" required value={p.form.startDate} data-testid="new-membership-start"
        onChange={e => p.onForm?.({ ...p.form, startDate: e.target.value })}/></label>
      {o.payers.length ? <label>{t('payer')}<select value={p.form.payerPersonId ?? ''} data-testid="new-membership-payer"
        onChange={e => p.onForm?.({ ...p.form, payerPersonId: e.target.value || null })}>
        {o.defaultPayerPersonId === null ? <option value="">{t('payer')}…</option> : null}
        {o.payers.map(x => <option key={x.personId} value={x.personId}>{payerName(x.personId)}</option>)}
      </select></label> : null}
      {o.payerProblem && p.form.payerPersonId === null ? <p className={styles.meta} role="note">{t(`pb_${o.payerProblem}`)}</p> : null}
    </fieldset>
    <p className={styles.meta}>{t('oneProgram')} {t('nothingCharged')}</p>
    {notices}
    <div className={styles.row}>
      <button type="button" className={styles.primary} data-testid="new-membership-submit" disabled={p.busy || !plan || !p.form.startDate} onClick={p.onSubmit}>
        {p.busy ? t('saving') : t('next')}</button>
      {close}
    </div>
  </>);
}

export type NewMembershipApi = Readonly<{
  options: typeof readNewMembershipOptions; plans: (scope: Readonly<{ organizationId: string; schoolId: string }>, signal?: AbortSignal) => Promise<{ plans: MembershipPlanListing[] }>;
  send: typeof sendNewMembership;
}>;
const defaultApi: NewMembershipApi = { options: readNewMembershipOptions, plans: readAdultPlanOptions, send: sendNewMembership };

/**
 * The form for one new or renewed membership. A request whose outcome is unknown is kept in memory only, so Try again resends
 * the identical request and key; the server never adds it twice. A stale plan version reads the plans again.
 */
function NewMembershipForm({ language, scope, mode, options, onDrafted, onClose, api }: { language: string; scope: PersonScope; mode: NewMode;
  options: PersonMembershipStartOptions; onDrafted: (membershipId: string) => void; onClose: () => void; api: NewMembershipApi }): React.ReactElement {
  const [load, setLoad] = useState<NewLoad>({ kind: 'LOADING' });
  const [form, setForm] = useState<NewForm>({ planId: '', startDate: '', payerPersonId: options.defaultPayerPersonId });
  const [notices, setNotices] = useState<readonly NewKey[]>([]);
  const [busy, setBusy] = useState(false), [reads, setReads] = useState(0);
  const kept = useRef<NewMembershipRequest | null>(null), mounted = useRef(true), first = useRef(true);
  const { organizationId, schoolId } = scope;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; kept.current = null; }; }, []);
  useEffect(() => {
    const abort = new AbortController();
    api.plans({ organizationId, schoolId }, abort.signal).then(result => {
      if (abort.signal.aborted) return;
      setLoad({ kind: 'READY', plans: result.plans });
      if (first.current) { first.current = false; setForm(initialForm(options, result.plans, mode)); }
      else setForm(prior => ({ ...prior, planId: '' }));
    }, error => { if (!abort.signal.aborted) setLoad({ kind: error instanceof PlanAccessError ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, organizationId, schoolId, reads]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = useCallback(async (request: NewMembershipRequest) => {
    setBusy(true); setNotices([]);
    try {
      const { receipt } = await api.send(request);
      kept.current = null;
      if (mounted.current) onDrafted(receipt.membershipId);
    } catch (error) {
      const keys = problemKeys(error);
      kept.current = keys[0] === 'p_UNKNOWN' ? request : null;
      if (!mounted.current) return;
      setNotices(keys);
      if (keys[0] === 'p_STALE') setReads(n => n + 1);
    } finally { if (mounted.current) setBusy(false); }
  }, [api, onDrafted]);
  const onSubmit = useCallback(() => {
    if (busy || kept.current || load.kind !== 'READY') return;
    const body = newMembershipBody(form, load.plans, mode);
    if (typeof body === 'string') { setNotices([body]); return; }
    let request: NewMembershipRequest;
    try { request = prepareNewMembership(scope, body, globalThis.crypto.randomUUID()); } catch { setNotices(['p_REFUSED']); return; }
    void send(request);
  }, [busy, load, form, mode, scope, send]);
  const onRetry = useCallback(() => { if (kept.current && !busy) void send(kept.current); }, [busy, send]);
  const onForm = useCallback((next: NewForm) => { if (kept.current) return; setForm(next); setNotices([]); }, []);
  return <NewMembershipView language={language} mode={mode} options={options} load={load} form={form} notices={notices} busy={busy}
    canRetry={kept.current !== null} onForm={onForm} onSubmit={onSubmit} onRetry={onRetry} onClose={onClose}/>;
}

type Opened = NewMode | Readonly<{ kind: 'START'; membershipId: string }>;
type OptionsState = Readonly<{ kind: 'LOADING' | 'UNAVAILABLE' | 'DENIED' }> | Readonly<{ kind: 'READY'; options: PersonMembershipStartOptions }>;

export type NewMembershipToolsViewProps = Readonly<{ language: string; state: OptionsState; items: readonly MembershipItem[]; opened: boolean;
  onOpen?: ((mode: NewMode) => void) | undefined; onReload?: (() => void) | undefined }>;
/** Pure view: New membership, one Renew per renewable membership, and why neither can be used when the server says so. */
export function NewMembershipToolsView(p: NewMembershipToolsViewProps): React.ReactElement | null {
  const t = (key: NewKey, vars?: Record<string, string | number>) => newText(p.language, key, vars);
  const s = p.state;
  if (p.opened || s.kind === 'LOADING') return null;
  if (s.kind !== 'READY') return s.kind === 'DENIED' ? <p className={styles.meta} role="note" data-testid="new-membership-tools">{t('denied')}</p>
    : <div className={styles.notice} role="status" data-testid="new-membership-tools"><p>{t('unavailable')}</p>
      {p.onReload ? <button type="button" className={styles.secondary} onClick={p.onReload}>{t('tryAgain')}</button> : null}</div>;
  const o = s.options;
  if (o.blockers.length) return <div className={styles.notice} role="status" data-testid="new-membership-tools">{o.blockers.map(b => <p key={b}>{t(`b_${b}`)}</p>)}</div>;
  return <div className={styles.row} data-testid="new-membership-tools">
    <button type="button" className={styles.primary} data-testid="new-membership-open" onClick={() => p.onOpen?.({ kind: 'NEW' })}>{t('newMembership')}</button>
    {renewTargets(o, p.items).map(target => <button key={target.membershipId} type="button" className={styles.secondary} data-testid={`renew-${target.membershipId}`}
      onClick={() => p.onOpen?.({ kind: 'RENEW', target })}>{t('renew')}: {target.label}</button>)}
  </div>;
}

/**
 * The top of the membership tab. It reads what this person can be offered (blockers, payers, which memberships renew), opens the
 * form, and after the server made the membership goes straight on to the start review for it.
 */
export function NewMembershipTools({ language, scope, items, onChanged, api = defaultApi }: { language: string; scope: PersonScope; items: readonly MembershipItem[];
  onChanged?: (() => void) | undefined; api?: NewMembershipApi }): React.ReactElement {
  const [state, setState] = useState<OptionsState>({ kind: 'LOADING' });
  const [opened, setOpened] = useState<Opened | null>(null);
  const [reads, setReads] = useState(0);
  const { organizationId, schoolId, personId } = scope;
  useEffect(() => {
    const abort = new AbortController();
    api.options({ organizationId, schoolId, personId }, abort.signal).then(options => { if (!abort.signal.aborted) setState({ kind: 'READY', options }); },
      error => { if (!abort.signal.aborted) setState({ kind: error instanceof NewMembershipError && (error.problem === 'DENIED' || error.problem === 'SESSION') ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, organizationId, schoolId, personId, reads]);
  const changed = useCallback(() => { setReads(n => n + 1); onChanged?.(); }, [onChanged]);
  const onDrafted = useCallback((membershipId: string) => { setOpened({ kind: 'START', membershipId }); changed(); }, [changed]);
  const close = useCallback(() => setOpened(null), []);
  return <div className={styles.membershipPanel} data-testid="new-membership-area">
    <NewMembershipToolsView language={language} state={state} items={items} opened={opened !== null} onOpen={setOpened} onReload={() => setReads(n => n + 1)}/>
    {opened?.kind === 'START' ? <StartMembership language={language} scope={{ organizationId, schoolId, membershipId: opened.membershipId }} onStarted={changed} onClose={close}/>
      : opened && state.kind === 'READY' ? <NewMembershipForm language={language} scope={scope} mode={opened} options={state.options} onDrafted={onDrafted} onClose={close} api={api}/> : null}
  </div>;
}
