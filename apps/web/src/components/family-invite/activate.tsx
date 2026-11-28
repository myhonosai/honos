'use client';
import React, { useEffect, useRef, useState } from 'react';
import { useLocale } from '../localization/provider';
import { familyInviteText, type FamilyInviteKey } from './copy';
import { FamilyInviteError, familyInviteApi, type FamilyInviteApi, type InviteErrorKind } from './http';
import { dropFamilyInvite, readFamilyInvite, type FamilyInvite } from './store';
import styles from './family-invite.module.css';

export type ActivateState = { state: 'CHECKING' | 'NONE' | 'READY' | 'ACTIVATING' | 'DONE' } | { state: 'PROBLEM'; kind: InviteErrorKind };
/** After these answers the kept invitation can never work for anyone on this device, so it is dropped. */
const FINAL: readonly InviteErrorKind[] = ['GONE', 'REJECTED', 'REVIEW'];

/**
 * One press finishes an emailed family app invitation (0714). The invitation is the one this tab kept from the email's
 * button; the email is the signed-in one, shown so the parent can see which account will get access. The server decides:
 * it accepts only for a HON-verified sign-in with the invited address. The same key is reused until a definite answer,
 * so pressing twice can never do anything twice. With nothing kept, `fallback` (the ID and code page) is shown instead.
 */
export function FamilyInviteActivate({ sessionEmail, fallback, api = familyInviteApi, newKey = () => crypto.randomUUID(), read = readFamilyInvite, drop = dropFamilyInvite }: {
  sessionEmail: string | null; fallback: React.ReactNode; api?: FamilyInviteApi; newKey?: () => string; read?: () => FamilyInvite | null; drop?: () => void;
}): React.ReactElement {
  const { preferences } = useLocale();
  const email = sessionEmail ?? '';
  const t = (key: FamilyInviteKey) => familyInviteText(preferences.language, key, { email });
  const [view, setView] = useState<ActivateState>({ state: 'CHECKING' });
  const invite = useRef<FamilyInvite | null>(null), key = useRef<string | null>(null), alive = useRef(true);
  useEffect(() => { alive.current = true; invite.current = read(); setView({ state: invite.current ? 'READY' : 'NONE' }); return () => { alive.current = false; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const activate = () => {
    const held = invite.current; if (!held) return;
    key.current ??= newKey();
    setView({ state: 'ACTIVATING' });
    api.activate(held.invitationId, held.token, key.current).then(
      () => { drop(); invite.current = null; key.current = null; if (alive.current) setView({ state: 'DONE' }); },
      (error) => {
        const kind = error instanceof FamilyInviteError ? error.kind : 'UNKNOWN';
        // A definite answer ends this attempt; only "could not confirm" keeps the key so the retry is the same request.
        if (kind !== 'UNKNOWN') key.current = null;
        if (FINAL.includes(kind)) { drop(); invite.current = null; }
        if (alive.current) setView({ state: 'PROBLEM', kind });
      });
  };

  if (view.state === 'NONE') return <>{fallback}</>;
  const problem = view.state === 'PROBLEM' ? view.kind : null;
  const canPress = view.state === 'READY' || (problem !== null && !FINAL.includes(problem) && problem !== 'SESSION');
  return <main className={styles.page}><section className={styles.card} aria-live="polite" data-testid="family-invite-activate">
    <h1>{t(view.state === 'DONE' ? 'doneTitle' : 'title')}</h1>
    {view.state === 'CHECKING' ? <p className={styles.meta} role="status">{t('opening')}</p>
      : view.state === 'DONE' ? <><p role="status">{t('done')}</p><div className={styles.links}><a className={styles.link} href="/parent">{t('portal')}</a></div></>
      : <>
        <p>{t('lead')}</p>
        {email ? <p className={styles.meta}>{t('signedIn')}</p> : null}
        {problem ? <p className={styles.notice} role="alert">{t(problem === 'OFF' || problem === 'LIMIT' ? 'UNKNOWN' : problem)}</p> : null}
        {canPress || view.state === 'ACTIVATING' ? <button type="button" className={styles.primary} disabled={view.state === 'ACTIVATING'} onClick={activate}>{t(view.state === 'ACTIVATING' ? 'activating' : 'activate')}</button> : null}
        <div className={styles.links}>
          {problem === 'SESSION' ? <a className={styles.link} href="/auth/login?for=family-invitation">{t('signIn')}</a> : null}
          {/* Sign-out is a POST from HON's own page; the kept invitation stays in this tab for the next sign-in. */}
          {problem === 'DENIED' || problem === 'VERIFY' ? <form method="post" action="/auth/logout"><button type="submit" className={styles.linkButton}>{t('signOut')}</button></form> : null}
        </div>
      </>}
  </section></main>;
}
