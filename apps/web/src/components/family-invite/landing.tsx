'use client';
import React, { useEffect, useState } from 'react';
import { useLocale } from '../localization/provider';
import { familyInviteText, type FamilyInviteKey } from './copy';
import { keepFamilyInvite, readFamilyInvite, takeFamilyInviteFromAddress } from './store';
import styles from './family-invite.module.css';

/** Where the parent finishes: the signed-in invitation page, which sends them through sign-in first when needed. */
export const FAMILY_INVITE_FINISH_PATH = '/account/family-invitation';
export type LandingState = 'OPENING' | 'READY' | 'INCOMPLETE' | 'STORAGE';

/** What the page the emailed button opens does with the address: keep the invitation for this tab, or say what is wrong. */
export function landFamilyInvite(): LandingState {
  const fromAddress = takeFamilyInviteFromAddress();
  if (fromAddress) return keepFamilyInvite(fromAddress) ? 'READY' : 'STORAGE';
  return readFamilyInvite() ? 'READY' : 'INCOMPLETE';
}

/**
 * The public page behind the email's button (0714). It takes the invitation out of the address, keeps it for this tab,
 * and moves on to the finishing page. It sends nothing anywhere and shows nothing about the invitation.
 */
export function FamilyInviteLanding({ go = (path: string) => globalThis.location?.replace(path) }: { go?: (path: string) => void }): React.ReactElement {
  const { preferences } = useLocale();
  const t = (key: FamilyInviteKey) => familyInviteText(preferences.language, key);
  const [state, setState] = useState<LandingState>('OPENING');
  useEffect(() => { const next = landFamilyInvite(); setState(next); if (next === 'READY') go(FAMILY_INVITE_FINISH_PATH); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <main className={styles.page}><section className={styles.card} aria-live="polite">
    <h1>{t('title')}</h1>
    {state === 'OPENING' ? <p className={styles.meta} role="status">{t('opening')}</p>
      : state === 'READY' ? <><p className={styles.meta} role="status">{t('opening')}</p><a className={styles.primary} href={FAMILY_INVITE_FINISH_PATH}>{t('continue')}</a></>
      : <p className={styles.notice} role="alert">{t(state === 'STORAGE' ? 'storage' : 'incomplete')}</p>}
  </section></main>;
}
