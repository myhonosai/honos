'use client';
import React, { useEffect, useState } from 'react';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { textFor, type T } from './copy';
import type { ToolScope } from './http';
import styles from './custom-tools.module.css';

export type ToolContext = Readonly<{ scope: ToolScope; language: string; t: T }>;

/**
 * The verified school for a custom tool page. Blur, a hidden tab, page hide, a school change or a session end hide the
 * page at once and remount its content, which retires every read and drops anything typed (the children are keyed by the
 * shell phase, the school and each privacy event). Nothing here is authority: every API call re-proves the school.
 */
export function ToolFrame({ title, intro, children, testId }: { title: string; intro: string; testId: string; children: (ctx: ToolContext) => React.ReactNode }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const [epoch, setEpoch] = useState(0);
  useEffect(() => onShellPrivacyEvent(() => { concealShellPrivateNow(); setEpoch((n) => n + 1); }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);
  const t = textFor(preferences.language);
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const school = selection ? `${selection.organizationId}:${selection.schoolId}`.toLowerCase() : 'none';
  const waiting = shell.phase === 'IDLE' || shell.phase === 'LOADING';
  return <main className={styles.page} data-testid={testId}>
    <header className={styles.head}><div><h1>{title}</h1>{intro ? <p className={styles.intro}>{intro}</p> : null}</div></header>
    <div key={`${shell.phase}:${school}:${epoch}`} data-shell-private="" className={styles.stack}>
      {waiting ? <p className={styles.meta} role="status">{t('waiting')}</p>
        : shell.phase === 'CONCEALED' ? <p className={styles.notice} role="status">{t('concealed')}</p>
        : !selection ? <p className={styles.notice} role="status">{t('noSchool')}</p>
        : children({ scope: { organizationId: selection.organizationId, schoolId: selection.schoolId }, language: preferences.language, t })}
    </div>
  </main>;
}

/** The title of a frame in the reader's language, for pages that need it before the frame renders. */
export function useToolText(): T { const { preferences } = useLocale(); return textFor(preferences.language); }
