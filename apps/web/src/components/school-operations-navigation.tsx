'use client';
import React from 'react';
import { useLocale } from './localization/provider';
import { schoolWorkflowLinks, type OperationalSchoolScope } from './operational-navigation';
import { entryText } from './school-entry/copy';
import styles from './school-operations-navigation.module.css';

/** Caller owns verified scope and its live revision. This component never reads or commands. */
export function SchoolOperationsNavigation({ scope, current, blocked, canNavigate }: {
  scope: OperationalSchoolScope; current: 'dashboard' | 'crm'; blocked: boolean; canNavigate: () => boolean;
}): React.ReactElement {
  const { preferences } = useLocale(), t = (key: Parameters<typeof entryText>[1]) => entryText(preferences.language, key);
  const links = schoolWorkflowLinks(scope).filter(link => link.key !== current && link.key !== 'registration'
    && (current !== 'crm' || !['membership', 'booking', 'attendance'].includes(link.key)));
  const disabled = blocked || !canNavigate();
  const guard = (event: React.MouseEvent<HTMLAnchorElement>) => { if (disabled || !canNavigate()) event.preventDefault(); };
  return <nav className={styles.navigation} aria-label={t('operations')} data-testid="school-operations-navigation">
    <a href={disabled ? undefined : '/staff/entry'} aria-disabled={disabled || undefined} onClick={guard} onAuxClick={guard}>{t('backToEntry')}</a>
    {links.map(link => <a key={link.key} data-testid={`operations-${link.key}`} href={disabled ? undefined : link.href} aria-disabled={disabled || undefined} onClick={guard} onAuxClick={guard}>{t(link.key)}</a>)}
    <p>{t(disabled ? 'navigationPaused' : 'navigationHelp')}</p>
  </nav>;
}
