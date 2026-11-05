'use client';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FAMILY_ACCESS_LEVELS, type FamilyAccessLevel } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT } from '../session-invalidation';
import { FamilyAccessController } from './controller';
import { familyScope, type FamilyScope } from './http';
import { familyText } from './copy';
import styles from './workbench.module.css';

/** No URL/token parsing. A pasted selector is never authority; only the canonical reads reveal records. */
type Binding = { controller: FamilyAccessController; scope: FamilyScope | null };
export function FamilyAccessWorkspace({ sessionSubject, acceptance = false }: { sessionSubject: string; acceptance?: boolean }): React.ReactElement {
  const locale = useLocale(), t = (key: Parameters<typeof familyText>[1]) => familyText(locale.preferences.language, key);
  const [org, setOrg] = useState(''), [school, setSchool] = useState(''), [scope, setScope] = useState<FamilyScope | null>(null);
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
  const bind = () => {
    if (generation.current !== revision) return;
    const active = binding.current?.controller.snapshot();
    if (active?.active || active && ['SESSION', 'IDENTITY', 'REVIEW'].includes(active.phase) && !active.retained) return;
    try {
      const next = familyScope({ organizationId: org.trim(), schoolId: school.trim() });
      if (binding.current?.scope?.organizationId === next.organizationId && binding.current.scope.schoolId === next.schoolId) {
        void binding.current.controller.load(next); generation.current++; setProblem(false); return;
      }
      if (active?.retained) { setProblem(true); return; }
      setScope(next); setScopeKey(k => k + 1); generation.current++; setProblem(false);
    } catch { setProblem(true); }
  };
  return <main className={`${styles.page} ${styles[mode]}`} data-testid="family-access" data-interface-theme={mode}>
    <h1>{t(acceptance ? 'acceptTitle' : 'title')}</h1><p>{t('intro')}</p>
    <div className={styles.modes} role="group" aria-label={t('mode')}>{(['modern', 'classic', 'big'] as const).map(value => <button type="button" key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>{t(value)}</button>)}</div>
    {!acceptance && <fieldset ref={scopeFields} disabled={isLocked}><legend>{t('scope')}</legend><label>{t('org')}<input autoComplete="off" value={org} onChange={e => change(setOrg, e.target.value)} /></label><label>{t('school')}<input autoComplete="off" value={school} onChange={e => change(setSchool, e.target.value)} /></label><button type="button" onClick={bind}>{t('read')}</button>{problem && <p role="alert">{t('ACCOUNT_INPUT_INVALID')}</p>}</fieldset>}
    {(acceptance || scope) && <BoundFamilyAccess key={`${sessionSubject}:${scopeKey}:${scope?.organizationId ?? ''}:${scope?.schoolId ?? ''}`} sessionSubject={sessionSubject} scope={acceptance ? null : scope} autoLoad={!acceptance} binding={binding} onLock={(value, terminal) => { setIsLocked(binding.current?.controller.snapshot().active === true || terminal && !binding.current?.controller.snapshot().retained); }} />}
    <aside className={styles.notice}><p>{t('mixed')}</p><p>{t('suspension')}</p><p>{t('boundary')}</p></aside>
  </main>;
}

function BoundFamilyAccess({ sessionSubject, scope, autoLoad, onLock, binding }: { sessionSubject: string; scope: FamilyScope | null; autoLoad: boolean; onLock: (value: boolean, terminal: boolean) => void; binding: React.MutableRefObject<Binding | null> }): React.ReactElement {
  const locale = useLocale(), t = (key: Parameters<typeof familyText>[1]) => familyText(locale.preferences.language, key);
  const holder = useRef<FamilyAccessController | null>(null); if (!holder.current) holder.current = new FamilyAccessController(sessionSubject, scope);
  const controller = holder.current;
  useLayoutEffect(() => { binding.current = { controller, scope }; return () => { if (binding.current?.controller === controller) binding.current = null; }; }, [binding, controller, scope]);
  const [snapshot, setSnapshot] = useState(controller.snapshot());
  const [email, setEmail] = useState(''), [level, setLevel] = useState<FamilyAccessLevel>('PRIMARY_GUARDIAN'), [hours, setHours] = useState('24');
  const [id, setId] = useState(''), [token, setToken] = useState(''), [confirmed, setConfirmed] = useState(false), [abandon, setAbandon] = useState(false);
  const [action, setAction] = useState<{ id: string; kind: 'revoke' | 'end' } | null>(null), [invalid, setInvalid] = useState(false);
  const privateDomEpoch = useRef(0);
  const area = useRef<HTMLDivElement | null>(null), latest = useRef(snapshot); latest.current = snapshot;
  const hide = () => { privateDomEpoch.current++; if (area.current) { area.current.hidden = true; area.current.inert = true; for (const link of area.current.querySelectorAll('a')) link.removeAttribute('href'); } };
  useEffect(() => {
    controller.activate();
    const unsubscribe = controller.subscribe(next => {
      if (next.phase !== 'READY') { hide(); setEmail(''); setToken(''); setId(''); setAction(null); }
      onLock(next.active || next.retained, next.phase === 'SESSION' || next.phase === 'IDENTITY' || next.phase === 'REVIEW'); latest.current = next; setConfirmed(false); setAbandon(false); setInvalid(false); setSnapshot(next);
    });
    const conceal = (event: Event) => { hide(); if (event.type === HON_SCHOOL_CONTEXT_CHANGED_EVENT) controller.contextChanged(); else controller.conceal(event.type === HON_SESSION_INVALIDATED_EVENT); };
    const visibility = () => { if (document.visibilityState !== 'visible') conceal(new Event('visibilitychange')); };
    const beforeUnload = (event: BeforeUnloadEvent) => { if (latest.current.active || latest.current.retained) { event.preventDefault(); event.returnValue = ''; } };
    const events = ['blur', 'pagehide', HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT];
    for (const event of events) window.addEventListener(event, conceal); document.addEventListener('visibilitychange', visibility); window.addEventListener('beforeunload', beforeUnload);
    if (autoLoad && document.visibilityState === 'visible') void controller.load();
    return () => { hide(); unsubscribe(); controller.dispose(); if (binding.current?.controller === controller) binding.current = null; for (const event of events) window.removeEventListener(event, conceal); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('beforeunload', beforeUnload); };
  }, [controller]);
  const current = snapshot.revision === controller.snapshot().revision;
  const visible = current && snapshot.phase === 'READY';
  const busy = snapshot.active || snapshot.retained || snapshot.needsRefresh;
  const execute = (action: () => Promise<void>) => { void action().catch(() => { if (controller.snapshot().phase === 'READY') setInvalid(true); }); };
  const edit = (action: () => void) => { if (controller.review(snapshot.revision)) { setAction(null); action(); } };
  const selected = snapshot.families.find(f => f.id === snapshot.selected);
  const invitations = snapshot.invitations.filter(i => i.familyId === snapshot.selected);
  return <section>
    <p className={styles.status} role="status" aria-live="polite" aria-atomic="true" data-testid="family-access-status">{t(snapshot.phase)}</p>
    {snapshot.active && <p role="status">{t('pending')}</p>}
    <button type="button" disabled={snapshot.active || snapshot.phase === 'LOADING' || snapshot.phase === 'CONTEXT' && Boolean(scope) || ['SESSION', 'IDENTITY', 'REVIEW'].includes(snapshot.phase) && !snapshot.retained} onClick={() => execute(() => controller.load())}>{t(snapshot.phase === 'CONCEALED' ? 'restore' : scope ? 'read' : 'identity')}</button>
    <div key={privateDomEpoch.current} ref={area} hidden={!visible} inert={!visible} data-testid="family-access-private">
      {scope ? <>
        <section aria-label={t('verifiedScope')}><h2>{t('verifiedScope')}</h2><p>{t('org')}: <code>{scope.organizationId}</code><br/>{t('school')}: <code>{scope.schoolId}</code></p></section>
        <label>{t('family')}<select value={snapshot.selected} disabled={busy} onChange={e => { controller.choose(e.target.value, snapshot.revision); setAction(null); }}><option value="">{t('choose')}</option>{snapshot.families.filter(f => f.status === 'ACTIVE').map(f => <option key={f.id} value={f.id}>{f.displayName}</option>)}</select></label>
        {snapshot.families.filter(f => f.status === 'ACTIVE').length === 0 && <p>{t('empty')}</p>}<p>{t('limit')}</p>
        {selected && <><h2>{selected.displayName}</h2><form autoComplete="off" onSubmit={e => { e.preventDefault(); execute(() => controller.invite(email, level, Number(hours), confirmed, snapshot.revision)); }}>
          <fieldset disabled={busy}><legend>{t('invite')}</legend><label>{t('email')}<input type="email" required maxLength={254} value={email} onChange={e => edit(() => setEmail(e.target.value))} autoComplete="off" /></label>
            <label>{t('level')}<select value={level} onChange={e => edit(() => setLevel(e.target.value as FamilyAccessLevel))}>{FAMILY_ACCESS_LEVELS.map(v => <option key={v} value={v}>{t(v)}</option>)}</select></label>
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
      {snapshot.receipt && <p role="status">{t('accountStatus' in snapshot.receipt ? 'accepted' : 'recorded')}</p>}
      {snapshot.share && <aside className={styles.notice}><p>{t('manual')}</p><label>{t('id')}<input readOnly autoComplete="off" value={snapshot.share.invitationId} /></label><label>{t('token')}<input readOnly autoComplete="off" value={snapshot.share.token} /></label><a href="/account/family-invitation">{t('fixedLink')}</a><p>{t('once')}</p></aside>}
      {snapshot.needsRefresh && <p>{t('refresh')}</p>}
      {snapshot.recovery && <aside className={styles.notice}><p role="alert">{t(snapshot.reviewRequired ? 'reviewRecovery' : snapshot.recovery === 'UNKNOWN' ? 'unknown' : 'notSubmitted')}</p><button type="button" disabled={snapshot.active || snapshot.reviewRequired} onClick={() => execute(() => controller.retry(snapshot.revision))}>{t('retry')}</button><label><input type="checkbox" checked={abandon} disabled={snapshot.active} onChange={e => setAbandon(e.target.checked)} />{t('confirmAbandon')}</label><button type="button" disabled={snapshot.active || !abandon} onClick={() => controller.abandon(abandon, snapshot.revision)}>{t('abandon')}</button></aside>}
    </div>
    {snapshot.retained && <p>{t('recoveryDocument')}</p>}
    <nav aria-label={t('nav')}><a href={scope ? '/staff/dashboard' : '/parent'} onClick={event => { if (controller.snapshot().active || controller.snapshot().retained) event.preventDefault(); }}>{t(scope ? 'back' : 'familyHome')}</a> · <a href="/auth/login" target={snapshot.retained ? '_blank' : undefined} rel="noopener noreferrer">{t('signin')}</a></nav>
  </section>;
}
