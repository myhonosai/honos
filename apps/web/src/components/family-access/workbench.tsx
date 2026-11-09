'use client';
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { FAMILY_ACCESS_LEVELS, type FamilyAccessLevel } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT } from '../session-invalidation';
import { FamilyAccessController } from './controller';
import { familyScope, type FamilyScope } from './http';
import { familyText } from './copy';
import styles from './workbench.module.css';

/** Inert school selectors never confer authority or cause a read or command. */
type Binding = { controller: FamilyAccessController; scope: FamilyScope | null };
export function FamilyAccessWorkspace({ sessionSubject, acceptance = false, initialOrganizationId = '', initialSchoolId = '' }: { sessionSubject: string; acceptance?: boolean; initialOrganizationId?: string; initialSchoolId?: string }): React.ReactElement {
  const locale = useLocale(), t = (key: Parameters<typeof familyText>[1]) => familyText(locale.preferences.language, key);
  const [org, setOrg] = useState(initialOrganizationId), [school, setSchool] = useState(initialSchoolId), [scope, setScope] = useState<FamilyScope | null>(null), [known, setKnown] = useState(false);
  const [problem, setProblem] = useState(false), [scopeKey, setScopeKey] = useState(0), [isLocked, setIsLocked] = useState(false), [mode, setMode] = useState<'modern' | 'classic' | 'big'>('modern');
  const scopeFields = useRef<HTMLFieldSetElement | null>(null);
  const binding = useRef<Binding | null>(null);
  const generation = useRef(0), revision = generation.current;
  const change = (setter: (v: string) => void, value: string) => { if (binding.current?.controller.snapshot().active) return; binding.current?.controller.contextChanged(); generation.current++; setter(value); setProblem(false); };
  useEffect(() => {
    const clear = (event?: Event) => { if (event?.type === HON_SCHOOL_CONTEXT_CHANGED_EVENT) binding.current?.controller.contextChanged(); generation.current++; for (const input of scopeFields.current?.querySelectorAll('input') ?? []) input.value = ''; setOrg(''); setSchool(''); };
    const visibility = () => { if (document.visibilityState !== 'visible') clear(); };
    const events = ['blur', 'pagehide', HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT];
    for (const event of events) window.addEventListener(event, clear); document.addEventListener('visibilitychange', visibility);
    return () => { for (const event of events) window.removeEventListener(event, clear); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  const bind = (knownReference = false) => {
    if (generation.current !== revision) return;
    const active = binding.current?.controller.snapshot();
    if (active?.active || active && ['SESSION', 'IDENTITY', 'REVIEW'].includes(active.phase) && !active.retained) return;
    try {
      const next = familyScope({ organizationId: org.trim(), schoolId: school.trim() });
      if (binding.current?.scope?.organizationId === next.organizationId && binding.current.scope.schoolId === next.schoolId) {
        void (knownReference ? binding.current.controller.verifyKnown(next) : binding.current.controller.load(next)); generation.current++; setProblem(false); return;
      }
      if (active?.retained) { setProblem(true); return; }
      setKnown(knownReference); setScope(next); setScopeKey(k => k + 1); generation.current++; setProblem(false);
    } catch { setProblem(true); }
  };
  return <main className={`${styles.page} ${styles[mode]}`} data-testid="family-access" data-interface-theme={mode}>
    <h1>{t(acceptance ? 'acceptTitle' : 'title')}</h1><p>{t('intro')}</p>
    <div className={styles.modes} role="group" aria-label={t('mode')}>{(['modern', 'classic', 'big'] as const).map(value => <button type="button" key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>{t(value)}</button>)}</div>
    {!acceptance && <fieldset ref={scopeFields} disabled={isLocked}><legend>{t('scope')}</legend><label>{t('org')}<input autoComplete="off" value={org} onChange={e => change(setOrg, e.target.value)} /></label><label>{t('school')}<input autoComplete="off" value={school} onChange={e => change(setSchool, e.target.value)} /></label><button type="button" onClick={() => bind()}>{t('read')}</button><button type="button" onClick={() => bind(true)}>{t('knownVerify')}</button>{problem && <p role="alert">{t('ACCOUNT_INPUT_INVALID')}</p>}</fieldset>}
    {(acceptance || scope) && <BoundFamilyAccess key={`${sessionSubject}:${scopeKey}:${scope?.organizationId ?? ''}:${scope?.schoolId ?? ''}`} sessionSubject={sessionSubject} scope={acceptance ? null : scope} autoLoad={!acceptance} known={known} binding={binding} onLock={(value, terminal) => { setIsLocked(binding.current?.controller.snapshot().active === true || terminal && !binding.current?.controller.snapshot().retained); }} />}
    <aside className={styles.notice}><p>{t('mixed')}</p><p>{t('suspension')}</p><p>{t('boundary')}</p></aside>
  </main>;
}

function BoundFamilyAccess({ sessionSubject, scope, autoLoad, known, onLock, binding }: { sessionSubject: string; scope: FamilyScope | null; autoLoad: boolean; known: boolean; onLock: (value: boolean, terminal: boolean) => void; binding: React.MutableRefObject<Binding | null> }): React.ReactElement {
  const locale = useLocale(), t = (key: Parameters<typeof familyText>[1]) => familyText(locale.preferences.language, key);
  const familySelectId = useId(), levelSelectId = useId(), knownActionId = useId();
  const holder = useRef<FamilyAccessController | null>(null); if (!holder.current) holder.current = new FamilyAccessController(sessionSubject, scope);
  const controller = holder.current;
  useLayoutEffect(() => { binding.current = { controller, scope }; return () => { if (binding.current?.controller === controller) binding.current = null; }; }, [binding, controller, scope]);
  const [snapshot, setSnapshot] = useState(controller.snapshot());
  const [email, setEmail] = useState(''), [level, setLevel] = useState<FamilyAccessLevel>('PRIMARY_GUARDIAN'), [hours, setHours] = useState('24');
  const [id, setId] = useState(''), [token, setToken] = useState(''), [confirmed, setConfirmed] = useState(false), [abandon, setAbandon] = useState(false);
  const [action, setAction] = useState<{ id: string; kind: 'revoke' | 'end' } | null>(null), [invalid, setInvalid] = useState(false);
  const [knownKind, setKnownKind] = useState<'revoke' | 'end'>('revoke');
  const privateDomEpoch = useRef(0);
  const area = useRef<HTMLDivElement | null>(null), latest = useRef(snapshot); latest.current = snapshot;
  const hide = () => { privateDomEpoch.current++; if (area.current) { area.current.hidden = true; area.current.inert = true; for (const link of area.current.querySelectorAll('a')) link.removeAttribute('href'); } };
  useEffect(() => {
    controller.activate();
    const unsubscribe = controller.subscribe(next => {
      if (!['READY', 'LIMITED'].includes(next.phase)) { hide(); setEmail(''); setToken(''); setId(''); setAction(null); }
      onLock(next.active || next.retained, next.phase === 'SESSION' || next.phase === 'IDENTITY' || next.phase === 'REVIEW'); latest.current = next; setConfirmed(false); setAbandon(false); setInvalid(false); setSnapshot(next);
    });
    const conceal = (event: Event) => { hide(); if (event.type === HON_SCHOOL_CONTEXT_CHANGED_EVENT) controller.contextChanged(); else controller.conceal(event.type === HON_SESSION_INVALIDATED_EVENT); };
    const visibility = () => { if (document.visibilityState !== 'visible') conceal(new Event('visibilitychange')); };
    const beforeUnload = (event: BeforeUnloadEvent) => { if (latest.current.active || latest.current.retained) { event.preventDefault(); event.returnValue = ''; } };
    const events = ['blur', 'pagehide', HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT];
    for (const event of events) window.addEventListener(event, conceal); document.addEventListener('visibilitychange', visibility); window.addEventListener('beforeunload', beforeUnload);
    if (autoLoad && document.visibilityState === 'visible') void (known ? controller.verifyKnown() : controller.load());
    return () => { hide(); unsubscribe(); controller.dispose(); if (binding.current?.controller === controller) binding.current = null; for (const event of events) window.removeEventListener(event, conceal); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('beforeunload', beforeUnload); };
  }, [controller]);
  const current = snapshot.revision === controller.snapshot().revision;
  const visible = current && ['READY', 'LIMITED'].includes(snapshot.phase), limited = snapshot.phase === 'LIMITED';
  const busy = snapshot.active || snapshot.retained || snapshot.needsRefresh;
  const execute = (action: () => Promise<void>) => { void action().catch(() => { if (['READY', 'LIMITED'].includes(controller.snapshot().phase)) setInvalid(true); }); };
  const edit = (action: () => void) => { if (controller.review(snapshot.revision)) { setAction(null); action(); } };
  const selected = snapshot.families.find(f => f.id === snapshot.selected);
  const invitations = snapshot.invitations.filter(i => i.familyId === snapshot.selected);
  return <section>
    <p className={styles.status} role="status" aria-live="polite" aria-atomic="true" data-testid="family-access-status">{t(snapshot.phase)}</p>
    {snapshot.active && <p role="status">{t('pending')}</p>}
    <button type="button" disabled={snapshot.active || snapshot.phase === 'LOADING' || snapshot.phase === 'CONTEXT' && Boolean(scope) || ['SESSION', 'IDENTITY', 'REVIEW'].includes(snapshot.phase) && !snapshot.retained} onClick={() => execute(() => controller.load())}>{t(snapshot.phase === 'CONCEALED' ? 'restore' : scope ? 'read' : 'identity')}</button>
    {scope && <button type="button" disabled={snapshot.active || snapshot.phase === 'LOADING' || snapshot.phase === 'CONTEXT' || ['SESSION', 'IDENTITY', 'REVIEW'].includes(snapshot.phase) && !snapshot.retained} onClick={() => execute(() => controller.verifyKnown())}>{t('knownVerify')}</button>}
    <div key={privateDomEpoch.current} ref={area} hidden={!visible} inert={!visible} data-testid="family-access-private">
      {scope && limited ? <>
        <h2>{t('knownTitle')}</h2><p>{t('knownBoundary')}</p><p>{t('school')}: <code>{scope.schoolId}</code></p>
        <form autoComplete="off" onSubmit={e => { e.preventDefault(); execute(() => controller.changeKnown(id, knownKind, confirmed, snapshot.revision)); }}><fieldset disabled={busy}>
          <legend>{t('knownTitle')}</legend><label>{t('id')}<input required autoComplete="off" value={id} onChange={e => edit(() => setId(e.target.value))}/></label>
          <label htmlFor={knownActionId}>{t('knownAction')}</label><select id={knownActionId} value={knownKind} onChange={e => edit(() => setKnownKind(e.target.value as 'revoke' | 'end'))}><option value="revoke">{t('revoke')}</option><option value="end">{t('end')}</option></select>
          <label><input type="checkbox" checked={confirmed} onChange={e => edit(() => setConfirmed(e.target.checked))}/>{t(knownKind === 'end' ? 'knownConfirmEnd' : 'knownConfirmRevoke')}</label><button disabled={!confirmed}>{t('apply')}</button>
        </fieldset></form>
      </> : scope ? <>
        <section aria-label={t('verifiedScope')}><h2>{t('verifiedScope')}</h2><p>{t('org')}: <code>{scope.organizationId}</code><br/>{t('school')}: <code>{scope.schoolId}</code></p></section>
        <label htmlFor={familySelectId}>{t('family')}</label><select id={familySelectId} value={snapshot.selected} disabled={busy} onChange={e => { controller.choose(e.target.value, snapshot.revision); setAction(null); }}><option value="">{t('choose')}</option>{snapshot.families.filter(f => f.status === 'ACTIVE').map(f => <option key={f.id} value={f.id}>{f.displayName}</option>)}</select>
        {snapshot.families.filter(f => f.status === 'ACTIVE').length === 0 && <p>{t('empty')}</p>}<p>{t('limit')}</p>
        {selected && <><h2>{selected.displayName}</h2><form autoComplete="off" onSubmit={e => { e.preventDefault(); execute(() => controller.invite(email, level, Number(hours), confirmed, snapshot.revision)); }}>
          <fieldset disabled={busy}><legend>{t('invite')}</legend><label>{t('email')}<input type="email" required maxLength={254} value={email} onChange={e => edit(() => setEmail(e.target.value))} autoComplete="off" /></label>
            <label htmlFor={levelSelectId}>{t('level')}</label><select id={levelSelectId} value={level} onChange={e => edit(() => setLevel(e.target.value as FamilyAccessLevel))}>{FAMILY_ACCESS_LEVELS.map(v => <option key={v} value={v}>{t(v)}</option>)}</select>
            <label>{t('hours')}<input type="number" min={1} max={168} required value={hours} onChange={e => edit(() => setHours(e.target.value))} /></label>
            <label><input type="checkbox" checked={confirmed && !action} onChange={e => edit(() => setConfirmed(e.target.checked))} />{t('confirmInvite')}</label><button disabled={!confirmed || Boolean(action)}>{t('invite')}</button>
          </fieldset></form>
          <h3>{t('invitations')}</h3>{invitations.length === 0 && <p>{t('noInvitations')}</p>}<ul className={styles.records}>{invitations.map(item => <li key={item.invitationId}><strong>{item.email}</strong> · {t(item.accessLevel)} · {t(item.status)}<p>{t('expires')}: {item.expiresAt}</p>
            {['PENDING', 'ACCEPTED'].includes(item.status) && <button type="button" disabled={busy} onClick={() => { if (controller.review(snapshot.revision)) { setAction({ id: item.invitationId, kind: item.status === 'PENDING' ? 'revoke' : 'end' }); setConfirmed(false); } }}>{t(item.status === 'PENDING' ? 'revoke' : 'end')}</button>}
          </li>)}</ul>
          {action && <fieldset disabled={busy}><legend>{t(action.kind === 'end' ? 'end' : 'revoke')}</legend><label><input type="checkbox" checked={confirmed} onChange={e => { if (controller.review(snapshot.revision)) setConfirmed(e.target.checked); }} />{t(action.kind === 'end' ? 'confirmEnd' : 'confirmRevoke')}</label><button type="button" disabled={!confirmed} onClick={() => execute(() => controller.change(action.id, action.kind, confirmed, snapshot.revision))}>{t('apply')}</button></fieldset>}
        </>}
      </> : <form autoComplete="off" onSubmit={e => { e.preventDefault(); execute(() => controller.accept(id, token, confirmed, snapshot.revision)); }}><fieldset disabled={busy}>
        <legend>{t('acceptTitle')}</legend><label>{t('id')}<input required autoComplete="off" value={id} onChange={e => edit(() => setId(e.target.value))} /></label><label>{t('token')}<input required type="password" autoComplete="off" spellCheck={false} value={token} onChange={e => edit(() => setToken(e.target.value))} /></label><label><input type="checkbox" checked={confirmed} onChange={e => { if (controller.review(snapshot.revision)) setConfirmed(e.target.checked); }} />{t('recipientConfirm')}</label><button disabled={!confirmed}>{t('accept')}</button>
      </fieldset></form>}
      {invalid && <p role="alert">{t('ACCOUNT_INPUT_INVALID')}</p>}
      {snapshot.code && <p role="alert">{t((snapshot.code in Object.fromEntries(['ACCOUNT_INPUT_INVALID','ACCOUNT_FORBIDDEN','VERIFIED_EMAIL_REQUIRED','ACCOUNT_UNAVAILABLE','ACCOUNT_REVIEW_REQUIRED','ACCOUNT_CONFLICT','ACCOUNT_RATE_LIMITED','ACCOUNT_BUSY'].map(k => [k, true])) ? snapshot.code : 'ACCOUNT_UNAVAILABLE') as Parameters<typeof t>[0])}</p>}
      {snapshot.receipt && <p role="status">{t(limited ? 'knownRecorded' : 'accountStatus' in snapshot.receipt ? 'accepted' : 'recorded')}{limited && <> <code>{snapshot.receipt.invitationId}</code> · {t((snapshot.receipt as { status: 'REVOKED' | 'ENDED' }).status)}</>}</p>}
      {snapshot.share && <aside className={styles.notice}><p>{t('manual')}</p><label>{t('id')}<input readOnly autoComplete="off" value={snapshot.share.invitationId} /></label><label>{t('token')}<input readOnly autoComplete="off" value={snapshot.share.token} /></label><a href="/account/family-invitation">{t('fixedLink')}</a><p>{t('once')}</p></aside>}
      {snapshot.needsRefresh && <p>{t(limited ? 'knownNext' : 'refresh')}</p>}
      {snapshot.recovery && <aside className={styles.notice}><p role="alert">{t(snapshot.reviewRequired ? 'reviewRecovery' : snapshot.recovery === 'UNKNOWN' ? 'unknown' : 'notSubmitted')}</p>{limited && <p>{t('knownReconcile')}</p>}<button type="button" disabled={snapshot.active || snapshot.reviewRequired} onClick={() => execute(() => controller.retry(snapshot.revision))}>{t('retry')}</button><label><input type="checkbox" checked={abandon} disabled={snapshot.active} onChange={e => setAbandon(e.target.checked)} />{t(limited ? 'knownAbandon' : 'confirmAbandon')}</label><button type="button" disabled={snapshot.active || !abandon} onClick={() => controller.abandon(abandon, snapshot.revision)}>{t('abandon')}</button></aside>}
    </div>
    {snapshot.retained && <p>{t('recoveryDocument')}</p>}
    <nav aria-label={t('nav')}><a href={scope ? '/staff/dashboard' : '/parent'} onClick={event => { if (controller.snapshot().active || controller.snapshot().retained) event.preventDefault(); }}>{t(scope ? 'back' : 'familyHome')}</a> · <a href="/auth/login" target={snapshot.retained ? '_blank' : undefined} rel="noopener noreferrer">{t('signin')}</a></nav>
  </section>;
}
