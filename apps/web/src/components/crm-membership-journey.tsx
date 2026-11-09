'use client';

import React, { useRef, useState } from 'react';
import { CrmLeadsWorkbench, type CrmLeadsInitialScope } from './crm-leads-workbench';
import { MembershipActivationWorkbench } from './membership-activation-workbench';
import { MembershipDatesWorkbench } from './membership-dates-workbench';
import { membershipActivationPath, type KnownMembership } from './membership-activation-http';
import { useLocale } from './localization/provider';
import { membershipJourneyText } from './crm-membership-journey-copy';
import styles from './crm-membership-journey.module.css';

/** A local navigation handoff. Its selectors carry no record, receipt or activation authority. */
export function CrmMembershipJourney({ sessionSubject, initialScope = {} }: { sessionSubject?: string; initialScope?: CrmLeadsInitialScope }): React.ReactElement {
  const { preferences } = useLocale();
  const [selection, setSelection] = useState<KnownMembership | null>(null), [instance, setInstance] = useState(0);
  const [stage, setStage] = useState<'activation' | 'dates'>('activation');
  const navigation = useRef<{ instance: number; selection: KnownMembership | null; stage: 'activation' | 'dates' }>({ instance: 0, selection: null, stage: 'activation' });
  const t = (key: Parameters<typeof membershipJourneyText>[1]) => membershipJourneyText(preferences?.language, key);
  const session = sessionSubject === undefined ? {} : { sessionSubject };
  const current = instance;
  function review(input: KnownMembership): void {
    if (navigation.current.instance !== current || navigation.current.selection) return;
    // Reuse the existing destination's pure selector validation, without performing a read.
    try { membershipActivationPath(input); } catch { return; }
    const selectors = Object.freeze({ organizationId: input.organizationId, schoolId: input.schoolId, membershipId: input.membershipId });
    navigation.current = { instance: current, selection: selectors, stage: 'activation' }; setStage('activation'); setSelection(selectors);
  }
  function returnToCrm(): void {
    if (!selection || navigation.current.instance !== current || navigation.current.selection !== selection) return;
    navigation.current = { instance: current + 1, selection: null, stage: 'activation' }; setStage('activation'); setSelection(null); setInstance(current + 1);
  }
  function manageDates(input: KnownMembership): void {
    if (!selection || navigation.current.instance !== current || navigation.current.selection !== selection || navigation.current.stage !== 'activation') return;
    try { membershipActivationPath(input); } catch { return; }
    if (input.organizationId !== selection.organizationId || input.schoolId !== selection.schoolId || input.membershipId !== selection.membershipId) return;
    navigation.current = { instance: current + 1, selection, stage: 'dates' }; setStage('dates'); setInstance(current + 1);
  }
  function returnToActivation(): void {
    if (!selection || navigation.current.instance !== current || navigation.current.selection !== selection || navigation.current.stage !== 'dates') return;
    navigation.current = { instance: current + 1, selection, stage: 'activation' }; setStage('activation'); setInstance(current + 1);
  }
  return <>
    <aside className={styles.progress} aria-label={t('title')}><ol><li aria-current={!selection ? 'step' : undefined}>{t('registration')}</li><li aria-current={selection && stage === 'activation' ? 'step' : undefined}>{t('activation')}</li><li aria-current={selection && stage === 'dates' ? 'step' : undefined}>{t('dates')}</li></ol><p>{t('note')}</p></aside>
    {selection ? stage === 'dates' ? <MembershipDatesWorkbench key={`dates:${current}:${selection.organizationId}:${selection.schoolId}:${selection.membershipId}`} {...session} initialMembership={selection} onReturn={returnToActivation} onAbandon={returnToCrm} />
      : <MembershipActivationWorkbench key={`activation:${current}:${selection.organizationId}:${selection.schoolId}:${selection.membershipId}`} {...session} initialMembership={selection} onReturn={returnToCrm} onManageDates={manageDates} />
      : <CrmLeadsWorkbench key={`crm:${current}`} {...session} initialScope={initialScope} onMembershipReview={review} />}
  </>;
}
