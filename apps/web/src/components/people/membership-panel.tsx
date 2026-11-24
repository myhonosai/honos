'use client';
import React, { useState } from 'react';
import { MembershipChanges } from '../membership-changes/membership-changes';
import { StartMembership } from './start-membership';
import type { MembershipItem } from './contact-card';
import styles from './people.module.css';

/** Wording for the membership buttons on the contact card (en / ko / es). */
const en = { finishStarting: 'Start membership', pauseOrCancel: 'Pause or cancel', resumeOrCancel: 'Resume or cancel', refundsAndHistory: 'Refunds and history',
  history: 'History', hide: 'Hide' };
type PanelKey = keyof typeof en;
const ko: Record<PanelKey, string> = { finishStarting: '회원권 시작', pauseOrCancel: '일시정지 또는 취소', resumeOrCancel: '재개 또는 취소', refundsAndHistory: '환불 및 기록',
  history: '기록', hide: '숨기기' };
const es: Record<PanelKey, string> = { finishStarting: 'Iniciar membresía', pauseOrCancel: 'Pausar o cancelar', resumeOrCancel: 'Reanudar o cancelar',
  refundsAndHistory: 'Reembolsos e historial', history: 'Historial', hide: 'Ocultar' };
export const PANEL_COPY = { en, ko, es } as const;
const panelText = (language: string, key: PanelKey) => (language.startsWith('ko') ? ko : language.startsWith('es') ? es : en)[key];

export type CardMembershipButton = Readonly<{ action: 'start' | 'manage'; label: PanelKey }>;
/** One plain button per membership. The opened panel reads the membership again and offers only what the server allows. */
export function cardMembershipButton(state: string): CardMembershipButton {
  switch (state) {
    case 'DRAFT': return { action: 'start', label: 'finishStarting' };
    case 'ACTIVE': return { action: 'manage', label: 'pauseOrCancel' };
    case 'FROZEN': return { action: 'manage', label: 'resumeOrCancel' };
    case 'CANCELLED': return { action: 'manage', label: 'refundsAndHistory' };
    default: return { action: 'manage', label: 'history' };
  }
}

/** The actions under one membership on the contact card. Opening one reads that membership; nothing is sent until staff confirm. */
export function MembershipPanel({ language, scope, item, onChanged }: { language: string; scope: Readonly<{ organizationId: string; schoolId: string }>;
  item: MembershipItem; onChanged?: (() => void) | undefined }): React.ReactElement {
  // The panel keeps what it was opened for, so a start that just succeeded still shows its answer after the card reads itself again.
  const [open, setOpen] = useState<CardMembershipButton['action'] | null>(null);
  const button = cardMembershipButton(item.state);
  const label = item.planName ?? item.planCode;
  return <div className={styles.membershipPanel} data-testid={`membership-panel-${item.membershipId}`}>
    <button type="button" className={open ? styles.secondary : styles.primary} aria-expanded={open !== null} onClick={() => setOpen(v => v ? null : button.action)}>
      {open ? panelText(language, 'hide') : panelText(language, button.label)}</button>
    {open ? open === 'start'
      ? <StartMembership language={language} scope={{ organizationId: scope.organizationId, schoolId: scope.schoolId, membershipId: item.membershipId }}
        onStarted={onChanged} onClose={() => setOpen(null)}/>
      : <MembershipChanges fixed={{ membershipId: item.membershipId, label }} onChanged={onChanged}/> : null}
  </div>;
}
