'use client';
import React, { useEffect, useState } from 'react';
import type { AiTeamReadiness } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { loadAiTeamReadiness } from '../ai-team-readiness-http';
import { panelFromError } from '../home/home';
import { ASK_HON_AGENTS, homeAiTeam, type AgentCard, type Panel } from '../home/model';
import { homeText, type HomeKey } from '../home/copy';
import { aiTeamText, type AiTeamKey } from './copy';
import styles from './ai-team.module.css';

export type AiTeamLoader = (organizationId: string, schoolId: string, signal: AbortSignal) => Promise<AiTeamReadiness>;

/**
 * The whole launch roster in one place. Who is available comes only from the verified readiness read for the
 * school the shell verified; a refused or unverifiable read never shows anyone as ready.
 */
export function AiTeamPage({ load = loadAiTeamReadiness }: { load?: AiTeamLoader }): React.ReactElement {
  const { preferences } = useLocale();
  const { selection, artStyle } = useSchoolShell();
  const [readiness, setReadiness] = useState<Panel<AiTeamReadiness>>({ state: 'LOADING' });
  useEffect(() => {
    setReadiness({ state: 'LOADING' });
    if (!selection) return;
    const abort = new AbortController();
    load(selection.organizationId, selection.schoolId, abort.signal).then(
      value => { if (!abort.signal.aborted) setReadiness({ state: 'READY', value }); },
      error => { if (!abort.signal.aborted) setReadiness(panelFromError(error)); });
    return () => abort.abort();
  }, [selection?.organizationId, selection?.schoolId, load]); // eslint-disable-line react-hooks/exhaustive-deps
  return <AiTeamView language={preferences.language} hasSchool={Boolean(selection)} readiness={readiness} team={homeAiTeam(readiness, artStyle)} />;
}

export function AiTeamView({ language, hasSchool, readiness, team }: { language: string; hasSchool: boolean; readiness: Panel<AiTeamReadiness>; team: readonly AgentCard[] }): React.ReactElement {
  const t = (key: AiTeamKey, values?: Record<string, string>) => aiTeamText(language, key, values);
  const notice = !hasSchool ? t('noSchool') : readiness.state === 'LOADING' ? t('checking') : readiness.state === 'DENIED' ? t('denied') : readiness.state === 'UNAVAILABLE' ? t('unavailable') : null;
  return <main className={styles.page} data-hon-native="">
    <header className={styles.header}><h1>{t('title')}</h1><p>{t('lead')}</p></header>
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    <ul className={styles.grid}>
      {team.map(agent => {
        const asks = ASK_HON_AGENTS.has(agent.id);
        const usable = hasSchool && agent.href !== null && agent.status === 'READY';
        return <li key={agent.id} className={styles.card} data-agent={agent.id} data-status={agent.status} style={{ '--agent': agent.color } as React.CSSProperties}>
          <span className={styles.portrait}><img src={agent.portrait} alt="" width={160} height={200} loading="lazy" /></span>
          <div className={styles.body}>
            <h2>{agent.name}<small>{homeText(language, agent.title)}</small></h2>
            <p>{t(agent.id as AiTeamKey)}</p>
            <p className={styles.status}><i aria-hidden="true" />{homeText(language, `status${agent.status}` as HomeKey)}<span> · {t(asks ? 'answers' : 'workspace')}</span></p>
            {usable && <a className={styles.action} href={agent.href!}>{asks ? t('ask', { name: agent.name }) : t('open')}</a>}
          </div>
        </li>;
      })}
    </ul>
  </main>;
}
