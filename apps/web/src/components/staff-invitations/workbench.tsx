'use client';
import React, { useEffect, useRef, useState } from 'react';
import { useLocale } from '../localization/provider';
import { HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT } from '../session-invalidation';
import { StaffInvitationController, newStaffInvitationToken } from './controller';
import { staffInvitationText } from './copy';
import styles from './workbench.module.css';

export function StaffInvitations({ sessionSubject, acceptance = false }: { sessionSubject: string; acceptance?: boolean }): React.ReactElement {
  const locale = useLocale(), t = (key: Parameters<typeof staffInvitationText>[1]) => staffInvitationText(locale.preferences.language, key);
  const controller = useRef<StaffInvitationController | null>(null);
  if (!controller.current) controller.current = new StaffInvitationController(sessionSubject, acceptance);
  const c = controller.current, [s, set] = useState(c.snapshot());
  const [org, setOrg] = useState(''), [school, setSchool] = useState(''), [roleId, setRoleId] = useState(''), [email, setEmail] = useState('');
  const [ttl, setTtl] = useState(24), [token, setToken] = useState(''), [invitation, setInvitation] = useState(''), [confirmed, setConfirmed] = useState(false), [abandonConfirmed, setAbandonConfirmed] = useState(false);
  const [mode, setMode] = useState<'modern' | 'classic' | 'big'>('modern'), [handoff, setHandoff] = useState<{ invitationId: string; token: string } | null>(null);
  const privateArea = useRef<HTMLDivElement | null>(null);
  const status = useRef<HTMLParagraphElement | null>(null), receiptHeading = useRef<HTMLHeadingElement | null>(null);
  const priorPhase = useRef(s.phase), priorOutcome = useRef(s.outcome);
  const hideDom = () => { if (privateArea.current) { privateArea.current.hidden = true; privateArea.current.inert = true; for (const a of privateArea.current.querySelectorAll('a')) a.removeAttribute('href'); } };
  useEffect(() => {
    c.activate();
    const unsubscribe = c.subscribe(next => { if (!['READY', 'IDLE'].includes(next.phase)) hideDom(); set(next); });
    const hide = (event: Event) => { hideDom(); setHandoff(null); setToken(''); setEmail(''); setInvitation(''); setConfirmed(false); setAbandonConfirmed(false);
      c.conceal(event.type === HON_SESSION_INVALIDATED_EVENT ? 'SESSION' : event.type === HON_SCHOOL_CONTEXT_CHANGED_EVENT ? 'IDENTITY' : 'CONCEALED'); };
    const visibility = () => { if (document.visibilityState !== 'visible') hide(new Event('visibilitychange')); };
    const leaving = (event: BeforeUnloadEvent) => { if (c.snapshot().pending || c.snapshot().commandBusy) { event.preventDefault(); event.returnValue = ''; } };
    const events = ['blur', 'pagehide', HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT];
    for (const event of events) window.addEventListener(event, hide); document.addEventListener('visibilitychange', visibility);
    window.addEventListener('beforeunload', leaving);
    return () => { hideDom(); unsubscribe(); c.dispose(); for (const event of events) window.removeEventListener(event, hide); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('beforeunload', leaving); };
  }, [c]);
  const privateVisible = s.revision === c.snapshot().revision && (s.phase === 'READY' || s.phase === 'IDLE');
  useEffect(() => {
    // Restore only the CURRENT reauthorized revision. Batching may omit an
    // intermediate hidden render; ordinary input edits must not remount focus.
    if (!privateVisible || s.revision !== c.snapshot().revision || !privateArea.current) return;
    privateArea.current.hidden = false; privateArea.current.inert = false;
  }, [privateVisible, s.revision, c]);
  useEffect(() => {
    const previousPhase = priorPhase.current, previousOutcome = priorOutcome.current; priorPhase.current = s.phase; priorOutcome.current = s.outcome;
    if (c.snapshot().revision !== s.revision || s.phase !== 'READY') return;
    if (s.receipt && s.outcome === 'SUCCESS' && previousOutcome === 'SENDING') receiptHeading.current?.focus({ preventScroll: true });
    else if (previousPhase === 'READING') status.current?.focus({ preventScroll: true });
  }, [s.phase, s.outcome, s.receipt, s.revision, c]);
  const locked = s.commandBusy || s.phase === 'READING';
  const edit = (fn: () => void, clearRole = false) => { if (c.retirePreparation(s.revision, clearRole)) { setConfirmed(false); fn(); } };
  const editScope = (fn: () => void) => { if (c.changeScope(s.revision)) { hideDom(); setConfirmed(false); setHandoff(null); setToken(''); setEmail(''); fn(); } };
  const verify = () => { setHandoff(null); setConfirmed(false); setAbandonConfirmed(false); void c.verify(acceptance ? undefined : { organizationId: org, schoolId: school }); };
  const finish = () => { if (c.abandon(s.revision, abandonConfirmed)) { setHandoff(null); setToken(''); setEmail(''); setInvitation(''); setConfirmed(false); setAbandonConfirmed(false); } };
  const stamp = (value: string) => new Intl.DateTimeFormat(locale.preferences.language, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value)) + ' UTC';
  const errorHelp = (code: string) => code === 'ACCOUNT_REVIEW_REQUIRED' ? 'review' : code === 'ACCOUNT_INPUT_INVALID' ? 'validation'
    : code === 'ACCOUNT_CONFLICT' ? 'conflictHelp' : code === 'ACCOUNT_RATE_LIMITED' ? 'rateHelp' : code === 'ACCOUNT_BUSY' ? 'busyHelp'
    : code === 'VERIFIED_EMAIL_REQUIRED' ? 'emailHelp' : ['ACCOUNT_FORBIDDEN', 'ACCOUNT_UNAVAILABLE'].includes(code) ? 'forbiddenHelp' : 'error';
  return <main className={`${styles.page} ${styles[mode]}`} data-testid="staff-invitations" data-interface-theme={mode}>
    <header><p>HON OS</p><h1>{t(acceptance ? 'acceptTitle' : 'title')}</h1><p>{t(acceptance ? 'acceptIntro' : 'intro')}</p></header>
    <fieldset className={styles.modes}><legend>{t('presentation')}</legend>{(['modern', 'classic', 'big'] as const).map(m => <button type="button" key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>{t(m)}</button>)}</fieldset>
    <p className={styles.notice}>{t('boundary')}</p>
    <p ref={status} tabIndex={-1} role="status" aria-live="polite" aria-atomic="true" data-testid="staff-account-status">{t(s.phase)}</p>
    {s.commandBusy && <p role="status">{t('sending')}</p>}
    {!['IDLE', 'READY'].includes(s.phase) && <button type="button" disabled={locked} onClick={verify}>{t('restore')}</button>}
    <div ref={privateArea} hidden={!privateVisible} inert={!privateVisible} data-testid="staff-account-private">
      {privateVisible && <>
        {!acceptance && <fieldset disabled={locked || s.pending} className={styles.scope}><legend>{t('selectors')}</legend>
          <label>{t('org')}<input data-testid="staff-org" autoComplete="off" value={org} onChange={e => editScope(() => setOrg(e.target.value))}/></label>
          <label>{t('school')}<input data-testid="staff-school" autoComplete="off" value={school} onChange={e => editScope(() => setSchool(e.target.value))}/></label>
        </fieldset>}
        <button type="button" disabled={locked} onClick={verify}>{t(acceptance ? 'verifyAccept' : 'verify')}</button>
        {s.phase === 'IDLE' && s.errorCode && <p role="alert">{t('validation')} <code>{s.errorCode}</code></p>}
        {s.phase === 'READY' && <>
          {s.outcome === 'UNKNOWN' && <p role="alert">{t(s.errorCode === 'ACCOUNT_REVIEW_REQUIRED' ? 'review' : 'unknown')}</p>}
          {s.outcome === 'REJECTED' && <p role="alert">{t('rejected')}</p>}
          {s.errorCode && <p role="alert">{t(errorHelp(s.errorCode))} <code>{s.errorCode}</code></p>}
          {s.receipt && <section className={styles.receipt} aria-label={t('success')}><h2 ref={receiptHeading} tabIndex={-1}>{t('success')}</h2>
            <p>{t('invitation')}: {s.receipt.invitationId}</p><p>{t('school')}: {s.receipt.schoolId}</p>
            {'status' in s.receipt && <p>{t(s.receipt.status)} — {stamp(s.receipt.expiresAt)}</p>}
            {acceptance && <a key={`workspace-${s.revision}`} href="/staff/dashboard" onClick={e => { if (c.snapshot().revision !== s.revision || c.snapshot().phase !== 'READY') e.preventDefault(); }}>{t('workspace')}</a>}
          </section>}
          {s.pending && <aside className={styles.recovery}>
            <p>{t('handoffLoss')}</p>
            {s.errorCode !== 'ACCOUNT_REVIEW_REQUIRED' && (s.outcome === 'UNKNOWN' || ['ACCOUNT_BUSY', 'ACCOUNT_RATE_LIMITED'].includes(s.errorCode ?? '')) && <button disabled={locked} type="button" onClick={() => void c.retry(s.revision)}>{t('retry')}</button>}
            <label><input type="checkbox" checked={abandonConfirmed} disabled={locked} onChange={e => setAbandonConfirmed(e.target.checked)}/>{t('abandonConfirm')}</label>
            <button disabled={locked || !abandonConfirmed} type="button" onClick={finish}>{t('abandon')}</button>
            {!acceptance && s.outcome === 'SUCCESS' && <button type="button" disabled={locked} onClick={() => setHandoff(c.handoff(s.revision))}>{t('show')}</button>}
            {handoff && <div><p>{t('share')}</p><a key={`accept-${s.revision}`} href="/account/staff-invitation" onClick={e => { if (c.snapshot().revision !== s.revision || c.snapshot().phase !== 'READY') e.preventDefault(); }}>{t('acceptancePage')}</a>
              <label>{t('invitation')}<input readOnly value={handoff.invitationId} autoComplete="off"/></label><label>{t('token')}<input readOnly value={handoff.token} autoComplete="off"/></label></div>}
          </aside>}
          {acceptance ? <form autoComplete="off" onSubmit={e => { e.preventDefault(); void c.accept(invitation, token, s.revision, confirmed); }}>
            <fieldset disabled={locked || s.pending || c.hasAcceptanceReviewHold()}><label>{t('invitation')}<input data-testid="staff-invitation-id" value={invitation} onChange={e => edit(() => setInvitation(e.target.value))}/></label>
              <label>{t('token')}<input type="password" data-testid="staff-token" value={token} onChange={e => edit(() => setToken(e.target.value))}/></label>
              <label><input type="checkbox" data-testid="staff-confirm" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>{t('acceptConfirmation')}</label>
              <button type="submit" disabled={!confirmed || !invitation || !token}>{t('accept')}</button>
            </fieldset>
          </form> : <>
            <p className={styles.notice}>{t('roleGap')}</p>
            <fieldset disabled={locked || s.pending}><label>{t('knownRole')}<input data-testid="staff-role-id" value={roleId} autoComplete="off" onChange={e => edit(() => setRoleId(e.target.value), true)}/></label>
              <button type="button" disabled={!roleId} onClick={() => { setConfirmed(false); void c.loadRole(roleId, s.revision); }}>{t('loadRole')}</button>
            </fieldset>
            {s.role && <p>{t('role')}: <strong>{s.role.name}</strong> — {s.role.code}<br/>{t('roleCaution')}</p>}
            <form autoComplete="off" onSubmit={e => { e.preventDefault(); void c.invite({ email, ttlHours: ttl, token }, s.revision, confirmed); }}>
              <fieldset disabled={locked || s.pending || !s.role}>
                <label>{t('email')}<input type="email" data-testid="staff-email" value={email} onChange={e => edit(() => setEmail(e.target.value.toLowerCase().trim()))}/></label>
                <label>{t('ttl')}<input type="number" min={1} max={168} data-testid="staff-ttl" value={ttl} onChange={e => edit(() => setTtl(Number(e.target.value)))}/></label>
                <label>{t('token')}<input type="password" value={token} readOnly autoComplete="off"/></label>
                <button type="button" onClick={() => edit(() => setToken(newStaffInvitationToken()))}>{t('newToken')}</button>
                <label><input type="checkbox" data-testid="staff-confirm" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>{t('confirmation')}</label>
                <button type="submit" disabled={!confirmed || !email || !token}>{t('invite')}</button>
              </fieldset>
            </form>
            <section aria-label={t('recent')}><h2>{t('recent')}</h2><p>{t('bounded')}</p>
              {s.items.length === 0 && !s.pending && <p>{t('empty')}</p>}
              <ul>{s.items.map(item => <li key={item.invitationId}><strong>{item.email}</strong> — {item.roleName} — {t(item.status)}<p>{stamp(item.expiresAt)}</p>
                {item.status === 'PENDING' && <button type="button" disabled={locked || s.pending} onClick={() => { if (window.confirm(t('revokeConfirm'))) void c.revoke(item.invitationId, s.revision, true); }}>{t('revoke')}</button>}
              </li>)}</ul>
            </section>
          </>}
        </>}
      </>}
    </div>
    <nav aria-label={t('nav')}><a href="/auth/login">{t('signIn')}</a><a href="/staff/roles">{t('rolesLink')}</a><a href="/staff/dashboard">{t('workspace')}</a></nav>
  </main>;
}
