'use client';
import React, { useEffect, useRef, useState } from 'react';
import type { CrmLeadMembershipItem, CrmLeadMemberships } from '@hon/contracts';
import { useLocale } from './localization/provider';
import { verifyEnrollmentSession } from './crm-enrollment-privacy';
import { PlanAccessError } from './membership-plans/http';
import { HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT } from './session-invalidation';
import { MembershipDatesWorkbench } from './membership-dates-workbench';
import { MembershipActivationWorkbench } from './membership-activation-workbench';
import { activationText } from './membership-activation-catalog';
import { type KnownMembership } from './membership-activation-http';
import { readLeadMemberships, leadWorkflowHref, LeadMembershipReadError, type LeadMembershipScope, type DiscoveryFailure } from './crm-lead-memberships-http';
import { membershipRecoveryText, recoveryLifecycleText } from './crm-lead-memberships-copy';
import styles from './crm-lead-memberships-workbench.module.css';
import { ConnectedStudentOperations } from './connected-student-operations';
import { operationsText } from './connected-student-operations-copy';
import { StudentOperationsError } from './connected-student-operations-http';

type Selection = Readonly<{ key: string; scope: KnownMembership; studentProfileId: string; stage: 'activation' | 'dates' | 'operations' }>;
/** The list is a fresh lead-bound observation, never a membership detail/activation capability. */
export function CrmLeadMembershipsWorkbench({ scope, sessionSubject }: { scope: LeadMembershipScope | null; sessionSubject: string }): React.ReactElement {
  const { preferences, date, number } = useLocale(), language = preferences?.language ?? 'en';
  const t = (key: Parameters<typeof membershipRecoveryText>[1]) => membershipRecoveryText(language, key);
  const key = JSON.stringify([sessionSubject, scope?.organizationId, scope?.schoolId, scope?.leadId]);
  const [mode, setMode] = useState<'modern' | 'classic' | 'big'>('modern');
  const [result, setResult] = useState<{ key: string; data: CrmLeadMemberships } | null>(null);
  const [loading, setLoading] = useState(false), [hidden, setHidden] = useState(false), [failure, setFailure] = useState<DiscoveryFailure | ''>(scope ? '' : 'INVALID');
  const [selection, setSelection] = useState<Selection | null>(null);
  const epoch = useRef(0), abort = useRef<AbortController | null>(null), active = useRef(false), mounted = useRef(true), concealed = useRef(false);
  const currentKey = useRef(key); currentKey.current = key;
  const observed = useRef<typeof result>(null); observed.current = result;
  const selected = useRef<Selection | null>(null), privateArea = useRef<HTMLDivElement | null>(null), shield = useRef<HTMLHeadingElement | null>(null), heading = useRef<HTMLHeadingElement | null>(null);
  function conceal(reason: DiscoveryFailure | '' = ''): void {
    epoch.current++; abort.current?.abort(); active.current = false; observed.current = null;
    if (privateArea.current) { privateArea.current.hidden = true; privateArea.current.inert = true; }
    concealed.current = true; setHidden(true); setLoading(false); setResult(null); setFailure(reason);
    // Do not unmount an open detail workbench: it owns any unsettled immutable command.
  }
  useEffect(() => {
    mounted.current = true;
    const hide = (event: Event) => { if (observed.current || active.current || selected.current || concealed.current) conceal(event.type === HON_SESSION_INVALIDATED_EVENT ? 'SESSION' : ''); };
    const visibility = () => { if (document.visibilityState !== 'visible') hide(new Event('visibilitychange')); };
    const events = ['blur', 'pagehide', HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT];
    for (const event of events) window.addEventListener(event, hide);
    document.addEventListener('visibilitychange', visibility);
    return () => { mounted.current = false; epoch.current++; abort.current?.abort(); active.current = false; selected.current = null; for (const event of events) window.removeEventListener(event, hide); document.removeEventListener('visibilitychange', visibility); };
  }, [key]);
  useEffect(() => { if (hidden && !selection) shield.current?.focus(); else if (!selection) heading.current?.focus(); }, [hidden, selection]);
  async function load(): Promise<void> {
    if (!scope || active.current || selected.current || !mounted.current) return;
    const run = ++epoch.current, ownership = key, controller = new AbortController(); abort.current?.abort(); abort.current = controller;
    active.current = true; observed.current = null; setResult(null); setLoading(true); setFailure('');
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
    try {
      await verifyEnrollmentSession(sessionSubject, signal);
      if (run !== epoch.current || currentKey.current !== ownership || signal.aborted) return;
      const data = await readLeadMemberships(scope, signal);
      if (!mounted.current || run !== epoch.current || currentKey.current !== ownership || signal.aborted) return;
      await verifyEnrollmentSession(sessionSubject, signal);
      if (!mounted.current || run !== epoch.current || currentKey.current !== ownership || signal.aborted || document.visibilityState !== 'visible') return;
      const next = { key: ownership, data }; observed.current = next; setResult(next); concealed.current = false; setHidden(false);
    } catch (error) {
      if (!mounted.current || run !== epoch.current || currentKey.current !== ownership) return;
      const reason = error instanceof PlanAccessError ? 'SESSION' : error instanceof LeadMembershipReadError ? error.kind : 'UNAVAILABLE';
      if (reason === 'SESSION' || reason === 'DENIED') conceal(reason); else setFailure(reason);
    } finally { if (mounted.current && run === epoch.current && currentKey.current === ownership) { active.current = false; setLoading(false); } }
  }
  const data = result?.key === key ? result.data : null, observation = result, observationEpoch = epoch.current;
  function open(item: CrmLeadMembershipItem, operations = false): void {
    if (!scope || !data || !mounted.current || selected.current || concealed.current || active.current || observationEpoch !== epoch.current || observed.current !== observation || currentKey.current !== key || !data.memberships.includes(item)) return;
    const next: Selection = Object.freeze({ key, scope: Object.freeze({ organizationId: scope.organizationId, schoolId: scope.schoolId, membershipId: item.membershipId }), studentProfileId: item.studentProfileId, stage: operations ? 'operations' : item.state === 'DRAFT' ? 'activation' : 'dates' });
    selected.current = next; epoch.current++; observed.current = null; setResult(null); setSelection(next);
  }
  function back(expected: Selection): void {
    if (!mounted.current || selected.current !== expected || currentKey.current !== key) return;
    selected.current = null; epoch.current++; setSelection(null); observed.current = null; setResult(null); setFailure('');
  }
  function manageDates(expected: Selection, input: KnownMembership): void {
    if (!mounted.current || selected.current !== expected || currentKey.current !== key || Object.keys(input).length !== 3 || Object.keys(expected.scope).some(k => input[k as keyof KnownMembership] !== expected.scope[k as keyof KnownMembership])) return;
    const next: Selection = Object.freeze({ key, scope: expected.scope, studentProfileId: expected.studentProfileId, stage: 'dates' }); selected.current = next; setSelection(next);
  }
  if (selection && selection.key === key && selection.stage === 'operations') return <ConnectedStudentOperations
    selection={{ organizationId: selection.scope.organizationId, schoolId: selection.scope.schoolId, studentProfileId: selection.studentProfileId }}
    sessionSubject={sessionSubject} initialPresentation={mode} onReturn={() => back(selection)} verifyStudent={async signal => {
      if (!scope || !mounted.current || selected.current !== selection || currentKey.current !== key) throw new StudentOperationsError(403);
      const current = await readLeadMemberships(scope, signal);
      if (signal.aborted || !mounted.current || selected.current !== selection || currentKey.current !== key) throw new StudentOperationsError(403);
      if (!current.memberships.some(item => item.membershipId === selection.scope.membershipId && item.studentProfileId === selection.studentProfileId)) throw new StudentOperationsError(404);
    }} />;
  if (selection && selection.key === key) return selection.stage === 'dates'
    ? <MembershipDatesWorkbench key={`dates:${key}:${selection.scope.membershipId}`} sessionSubject={sessionSubject} initialMembership={selection.scope} initialPresentation={mode} onReturnLabel={t('back')} onReturn={() => back(selection)} onAbandon={() => back(selection)} />
    : <MembershipActivationWorkbench key={`activation:${key}:${selection.scope.membershipId}`} sessionSubject={sessionSubject} initialMembership={selection.scope} initialPresentation={mode} onReturnLabel={t('back')} onReturn={() => back(selection)} onManageDates={input => manageDates(selection, input)} />;
  return <main data-membership-recovery className={`${styles.page} ${styles[`mode_${mode}`]}`}>
    <label>{activationText(language, 'Presentation')}<select value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="modern">{activationText(language, 'Modern')}</option><option value="classic">{activationText(language, 'Classic')}</option><option value="big">{activationText(language, 'Big Button')}</option></select></label>
    <header><h1 ref={heading} tabIndex={-1}>{t('title')}</h1><p>{t('intro')}</p></header>
    <aside><p>{t('limits')}</p><p>{t('references')}</p></aside>
    <div role="status" aria-live="polite" aria-atomic="true" className={styles.status}>{loading ? t('loading') : hidden ? t('hidden') : data ? t('loaded') : ''}</div>
    {hidden && <section aria-labelledby="membership-recovery-shield"><h2 id="membership-recovery-shield" tabIndex={-1} ref={shield}>{t('hidden')}</h2><p>{t('privacy')}</p><button type="button" disabled={loading} onClick={() => void load()}>{t('verify')}</button></section>}
    <div ref={privateArea} hidden={hidden} inert={hidden}>
      {scope && <><section><h2>{t('selectors')}</h2><code>{scope.leadId}</code><p>{t('idle')}</p><button type="button" disabled={loading} onClick={() => void load()}>{t(data ? 'refresh' : 'load')}</button></section>
        <nav className={styles.actions}><a href={leadWorkflowHref(scope)}>{t('crm')}</a></nav><p>{t('crmNote')}</p></>}
      {data && <section aria-label={t('title')}>
        {data.memberships.length === 0 && <p>{t('empty')}</p>}{data.truncated && <p role="note">{t('bounded')}</p>}
        <ol className={styles.records}>{data.memberships.map((item, index) => <li key={item.membershipId} className={styles.record}>
          <h2>{t(item.origin === 'ADULT_REGISTRATION' ? 'adult' : 'child')} · {number(index + 1)}</h2>
          <dl><dt>{t('profile')}</dt><dd><code>{item.studentProfileId}</code></dd><dt>{t('membership')}</dt><dd><code>{item.membershipId}</code></dd><dt>{t('lifecycle')}</dt><dd>{recoveryLifecycleText(language, item.state)}</dd><dt>{t('version')}</dt><dd>{number(item.version)}</dd><dt>{t('created')}</dt><dd>{date(item.createdAt)}</dd></dl>
          <button type="button" onClick={() => open(item)}>{t(item.state === 'DRAFT' ? 'draft' : 'dates')} · {number(index + 1)}</button>
          <button type="button" onClick={() => open(item, true)}>{operationsText(language, 'title')} · {number(index + 1)}</button>
        </li>)}</ol>
      </section>}
    </div>
    {failure && <p role="alert">{t(failure)}</p>}
  </main>;
}
