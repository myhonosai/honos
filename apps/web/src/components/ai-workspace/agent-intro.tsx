'use client';
import React, { useEffect, useState } from 'react';
import type { AiTeamReadiness } from '@hon/contracts';
import { useSchoolShell } from '../school-shell/context';
import { loadAiTeamReadiness } from '../ai-team-readiness-http';
import { panelFromError } from '../home/home';
import { agentStatus, type AgentStatus, type Panel } from '../home/model';
import { homeText, type HomeKey } from '../home/copy';
import { aiTeamPortrait } from '../hon-command/roster';
import { useLocale } from '../localization/provider';
import styles from './agent-intro.module.css';

type AgentKey = 'chad' | 'marcus' | 'kai' | 'maya';
export type AgentIntroProps = Readonly<{ agent: AgentKey; language?: string | undefined; name: string; role: string; lead: string; status: AgentStatus; portrait: string; links?: readonly { href: string; label: string }[] }>;

/** Pure presentation: who this is, what they do, and whether they are available, from readiness only. */
export function AgentIntroView({ language, name, role, lead, status, portrait, links = [] }: AgentIntroProps): React.ReactElement {
  return <header className={styles.intro} data-agent-status={status}>
    <img className={styles.portrait} src={portrait} alt="" width={96} height={120} />
    <div>
      <p className={styles.role}>{role}</p>
      <h1>{name}</h1>
      <p className={styles.lead}>{lead}</p>
      <p className={styles.status} role="status"><i aria-hidden="true" />{homeText(language ?? 'en', `status${status}` as HomeKey)}</p>
      {links.length > 0 && <nav aria-label={`More for ${name}`} className={styles.links}>{links.map(link => <a key={link.href} href={link.href}>{link.label}</a>)}</nav>}
    </div>
  </header>;
}

/** Loads this agent's readiness for the school the shell verified. A refused or unverifiable read never shows "Ready". */
export function AgentIntro(props: Omit<AgentIntroProps, 'status' | 'portrait' | 'language'>): React.ReactElement {
  const { phase, selection, artStyle } = useSchoolShell();
  const { preferences } = useLocale();
  const school = phase === 'READY' ? selection : null;
  const [readiness, setReadiness] = useState<Panel<AiTeamReadiness>>({ state: 'LOADING' });
  useEffect(() => {
    // Still checking while the shell verifies the school; once it settles without one, say we cannot tell.
    setReadiness(school || phase === 'IDLE' || phase === 'LOADING' ? { state: 'LOADING' } : { state: 'UNAVAILABLE' });
    if (!school) return;
    const abort = new AbortController();
    loadAiTeamReadiness(school.organizationId, school.schoolId, abort.signal).then(
      value => { if (!abort.signal.aborted) setReadiness({ state: 'READY', value }); },
      error => { if (!abort.signal.aborted) setReadiness(panelFromError(error)); });
    return () => abort.abort();
  }, [phase, school?.organizationId, school?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps
  return <AgentIntroView {...props} language={preferences?.language} status={agentStatus(readiness, props.agent)} portrait={aiTeamPortrait(props.agent, artStyle) ?? ''} />;
}
