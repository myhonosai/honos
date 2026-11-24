'use client';
import React, { useEffect, useId, useRef, useState } from 'react';
import { FAMILY_ACCESS_LEVELS, type FamilyAccessInvitation, type FamilyAccessLevel } from '@hon/contracts';
import { onShellPrivacyEvent } from '../school-shell/privacy';
import { FamilyAccessController, type FamilySnapshot } from '../family-access/controller';
import { familyText } from '../family-access/copy';
import type { FamilyScope } from '../family-access/http';
import { panelText } from './panel-copy';
import styles from './people.module.css';

/** Only the invitations of the family the card names. */
export function familyInvitations<T extends Pick<FamilyAccessInvitation, 'familyId'>>(invitations: readonly T[], familyId: string): T[] {
  const id = familyId.toLowerCase();
  return invitations.filter(i => i.familyId.toLowerCase() === id);
}
type FKey = Parameters<typeof familyText>[1];
const CODES = new Set(['ACCOUNT_INPUT_INVALID', 'ACCOUNT_FORBIDDEN', 'VERIFIED_EMAIL_REQUIRED', 'ACCOUNT_UNAVAILABLE', 'ACCOUNT_REVIEW_REQUIRED', 'ACCOUNT_CONFLICT',
  'ACCOUNT_RATE_LIMITED', 'ACCOUNT_BUSY']);

/**
 * One family's app access inside the contact card, through the same controller and endpoints as the Family access page:
 * the school is the one the shell verified, the family is the one the card read, and the server checks the family
 * access manager on every read and command. Nobody types an id. Invite, revoke and end each need the confirm box.
 */
export function CardFamilyAccess({ language, scope, sessionSubject, familyId }: { language: string; scope: FamilyScope; sessionSubject: string; familyId: string }): React.ReactElement {
  const t = (key: FKey) => familyText(language, key);
  const holder = useRef<FamilyAccessController | null>(null);
  if (!holder.current) holder.current = new FamilyAccessController(sessionSubject, scope);
  const controller = holder.current;
  const [snap, setSnap] = useState<FamilySnapshot>(controller.snapshot());
  const [email, setEmail] = useState(''), [level, setLevel] = useState<FamilyAccessLevel>('PRIMARY_GUARDIAN'), [hours, setHours] = useState('24');
  const [confirmed, setConfirmed] = useState(false), [action, setAction] = useState<{ id: string; kind: 'revoke' | 'end' } | null>(null);
  const levelId = useId();
  useEffect(() => {
    controller.activate();
    const off = controller.subscribe(next => {
      // The family is chosen for the person as soon as the school's families are read; it never comes from a typed value.
      if (next.phase === 'READY' && next.selected !== familyId && !next.retained && !next.active) controller.choose(familyId, next.revision);
      if (!['READY', 'LIMITED'].includes(next.phase)) { setEmail(''); setAction(null); }
      setConfirmed(false); setSnap(controller.snapshot());
    });
    const offPrivacy = onShellPrivacyEvent(() => controller.conceal());
    if (globalThis.document?.visibilityState === 'visible') void controller.load();
    return () => { off(); offPrivacy(); controller.dispose(); };
  }, [controller, familyId]);
  const busy = snap.active || snap.retained || snap.needsRefresh;
  const run = (step: () => Promise<void>) => { void step().catch(() => undefined); };
  const edit = (change: () => void) => { if (controller.review(snap.revision)) { setAction(null); change(); } };
  const ready = snap.phase === 'READY' && snap.selected === familyId;
  const invitations = ready ? familyInvitations(snap.invitations, familyId) : [];
  return <div className={styles.subsection} data-testid="card-family-access">
    <h4>{panelText(language, 'accessTitle')}</h4>
    {snap.phase === 'DENIED' ? <p className={styles.meta} role="note">{panelText(language, 'accessDenied')}</p>
      : snap.phase === 'LOADING' ? <p className={styles.meta} role="status">{panelText(language, 'accessLoading')}</p>
      : !ready ? <div className={styles.actions}><p className={styles.meta} role="status">{snap.phase === 'READY' ? panelText(language, 'accessUnavailable') : t(snap.phase as FKey)}</p>
          <button type="button" className={styles.secondary} disabled={snap.active} onClick={() => run(() => controller.load())}>{panelText(language, 'accessRead')}</button></div>
      : <>
        {invitations.length === 0 ? <p className={styles.meta}>{panelText(language, 'accessNone')}</p> : <ul className={styles.plain}>{invitations.map(item => <li key={item.invitationId}
          data-testid="card-family-invitation"><strong>{item.email}</strong> · {t(item.accessLevel)} · {t(item.status)}
          {['PENDING', 'ACCEPTED'].includes(item.status) ? <> <button type="button" className={styles.secondary} disabled={busy}
            onClick={() => { if (controller.review(snap.revision)) { setAction({ id: item.invitationId, kind: item.status === 'PENDING' ? 'revoke' : 'end' }); setConfirmed(false); } }}>
            {t(item.status === 'PENDING' ? 'revoke' : 'end')}</button></> : null}</li>)}</ul>}
        {action ? <fieldset className={styles.fields} disabled={busy}><legend>{t(action.kind)}</legend>
          <label><input type="checkbox" checked={confirmed} onChange={e => { if (controller.review(snap.revision)) setConfirmed(e.target.checked); }}/> {t(action.kind === 'end' ? 'confirmEnd' : 'confirmRevoke')}</label>
          <div className={styles.actions}><button type="button" className={styles.danger} disabled={!confirmed}
            onClick={() => run(() => controller.change(action.id, action.kind, confirmed, snap.revision))}>{t('apply')}</button></div>
        </fieldset> : <form className={styles.form} autoComplete="off" onSubmit={e => { e.preventDefault(); run(() => controller.invite(email, level, Number(hours), confirmed, snap.revision)); }}>
          <fieldset className={styles.fields} disabled={busy}><legend>{t('invite')}</legend>
            <label>{t('email')}<input type="email" required maxLength={254} value={email} autoComplete="off" onChange={e => edit(() => setEmail(e.target.value))}/></label>
            <label htmlFor={levelId}>{t('level')}</label>
            <select id={levelId} value={level} onChange={e => edit(() => setLevel(e.target.value as FamilyAccessLevel))}>{FAMILY_ACCESS_LEVELS.map(v => <option key={v} value={v}>{t(v)}</option>)}</select>
            <label>{t('hours')}<input type="number" min={1} max={168} required value={hours} onChange={e => edit(() => setHours(e.target.value))}/></label>
            <label><input type="checkbox" checked={confirmed} onChange={e => edit(() => setConfirmed(e.target.checked))}/> {t('confirmInvite')}</label>
            <div className={styles.actions}><button type="submit" className={styles.primary} disabled={!confirmed}>{t('invite')}</button></div>
          </fieldset></form>}
      </>}
    {snap.active ? <p className={styles.meta} role="status">{t('pending')}</p> : null}
    {snap.code ? <p className={styles.notice} role="alert">{t((CODES.has(snap.code) ? snap.code : 'ACCOUNT_UNAVAILABLE') as FKey)}</p> : null}
    {snap.receipt ? <p className={styles.notice} role="status">{t('accountStatus' in snap.receipt ? 'accepted' : 'recorded')}</p> : null}
    {snap.share ? <div className={styles.notice}><p>{t('manual')}</p>
      <label>{t('id')}<input readOnly autoComplete="off" value={snap.share.invitationId}/></label>
      <label>{t('token')}<input readOnly autoComplete="off" value={snap.share.token}/></label><p>{t('once')}</p></div> : null}
    {snap.needsRefresh ? <div className={styles.actions}><p className={styles.meta}>{t('refresh')}</p>
      <button type="button" className={styles.secondary} disabled={snap.active} onClick={() => run(() => controller.load())}>{t('read')}</button></div> : null}
    {snap.recovery ? <div className={styles.notice}><p role="alert">{t(snap.reviewRequired ? 'reviewRecovery' : snap.recovery === 'UNKNOWN' ? 'unknown' : 'notSubmitted')}</p>
      <button type="button" className={styles.secondary} disabled={snap.active || snap.reviewRequired} onClick={() => run(() => controller.retry(snap.revision))}>{t('retry')}</button></div> : null}
  </div>;
}
