'use client';
import React, { useEffect, useRef, useState } from 'react';
import { useLocale } from '../localization/provider';
import { HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT } from '../session-invalidation';
import { FounderReadError, readFounderEvidence, type SetupEvidence, type DirectoryEvidence } from './http';
import { founderText, searchFounderHelp, type FounderCopyKey } from './catalog';
import styles from './guide.module.css';

type Phase = 'idle' | 'loading' | 'loaded' | 'hidden' | 'signedout' | 'denied' | 'error' | 'identity';
const STEP_TITLES = Array.from({ length: 8 }, (_, n) => `step${n}Title` as FounderCopyKey);
const STEP_BODIES = Array.from({ length: 8 }, (_, n) => `step${n}Body` as FounderCopyKey);
export function FounderSetupLink(): React.ReactElement {
  const { preferences } = useLocale();
  return <nav className={styles.entry}><a href="/staff/founder-setup">{founderText(preferences.language, 'founderLink')} →</a></nav>;
}
export function FounderSetup({ plane = 'school' }: { plane?: 'school' | 'hq' }): React.ReactElement {
  const { preferences, number } = useLocale();
  const t = (key: FounderCopyKey) => founderText(preferences.language, key);
  const [phase, setPhase] = useState<Phase>('idle'), [facts, setFacts] = useState<SetupEvidence | null>(null), [directory, setDirectory] = useState<DirectoryEvidence | null>(null);
  const [step, setStep] = useState(0), [mode, setMode] = useState<'modern' | 'classic' | 'big-button'>('modern'), [query, setQuery] = useState(''), [sample, setSample] = useState(false), [copy, setCopy] = useState<'copied' | 'copyFailed' | null>(null);
  const life = useRef({ mounted: false, epoch: 0, busy: false, sensitive: false });
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    const s = life.current; s.mounted = true;
    const hide = (next: Phase = 'hidden') => {
      if (!s.sensitive && !s.busy && next === 'hidden') return;
      ++s.epoch; pending.current?.abort(); s.busy = false; s.sensitive = false;
      setFacts(null); setDirectory(null); setQuery(''); setCopy(null); setSample(false); setPhase(next);
    };
    const blur = () => hide(), expired = () => hide('signedout'), school = () => hide();
    const visibility = () => { if (document.visibilityState === 'hidden') hide(); };
    const events = [['blur', blur], ['pagehide', blur], [HON_SESSION_INVALIDATED_EVENT, expired], [HON_SCHOOL_CONTEXT_CHANGED_EVENT, school]] as const;
    for (const [event, handler] of events) window.addEventListener(event, handler);
    document.addEventListener('visibilitychange', visibility);
    return () => { s.mounted = false; ++s.epoch; pending.current?.abort(); for (const [event, handler] of events) window.removeEventListener(event, handler); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  async function load() {
    const s = life.current;
    if (s.busy) return;
    const epoch = ++s.epoch, controller = new AbortController(); pending.current?.abort(); pending.current = controller;
    s.busy = true; s.sensitive = true; setFacts(null); setDirectory(null); setCopy(null); setPhase('loading');
    try {
      const result = plane === 'school' ? await readFounderEvidence('school', controller.signal) : await readFounderEvidence('hq', controller.signal);
      if (!s.mounted || s.epoch !== epoch || pending.current !== controller) return;
      if (plane === 'school') setFacts(result as SetupEvidence); else setDirectory(result as DirectoryEvidence);
      setPhase('loaded');
    } catch (e) {
      if (!s.mounted || pending.current !== controller) return;
      if (e instanceof FounderReadError && e.status === 401) setPhase(e.kind === 'IDENTITY' ? 'identity' : 'signedout');
      else if (s.epoch === epoch && !controller.signal.aborted) setPhase(e instanceof FounderReadError && e.status === 403 ? 'denied' : 'error');
      setFacts(null); setDirectory(null);
    } finally { if (s.mounted && pending.current === controller) s.busy = false; }
  }
  async function copyOutline() {
    const s = life.current, epoch = s.epoch; s.sensitive = true;
    try { await navigator.clipboard.writeText(t('outline')); if (s.mounted && s.epoch === epoch) setCopy('copied'); }
    catch { if (s.mounted && s.epoch === epoch) setCopy('copyFailed'); }
  }
  const evidence = <section className={styles.card} aria-label={t('evidence')}>
    <h2>{t('evidence')}</h2>
    {facts ? <><p className={styles.school}>{facts.schoolName}</p><p><strong>{number([facts.program, facts.classSession, facts.registration].filter(Boolean).length)}</strong> {t('count')}</p><ul className={styles.evidence}>{(['program', 'classSession', 'registration'] as const).map((key, i) => <li key={key}><span>{t((['program', 'class', 'registration'] as const)[i]!)}</span><strong>{t(facts[key] ? 'recorded' : 'notRecorded')}</strong></li>)}</ul></> : <p>{t('unknown')}</p>}
    <p className={styles.small}>{t('history')}</p>
  </section>;
  const support = <section className={styles.card} aria-label={t('help')}>
    <h2>{t('help')}</h2><label>{t('search')}<input type="search" value={query} maxLength={100} onChange={e => { life.current.sensitive = true; setQuery(e.target.value); }} /></label>
    <div className={styles.answers}>{searchFounderHelp(preferences.language, query).map(topic => <details key={topic}><summary>{t(`help${topic}Q`)}</summary><p>{t(`help${topic}A`)}</p></details>)}</div>
    {searchFounderHelp(preferences.language, query).length === 0 && <p role="status">{t('noResults')}</p>}
    <h3>{t('support')}</h3><p>{t('supportNote')}</p><pre className={styles.outline}>{t('outline')}</pre>
    <div className={styles.actions}><button type="button" onClick={() => void copyOutline()}>{t('copy')}</button><button type="button" disabled>{t('submit')}</button></div><p role="status" aria-live="polite">{copy ? t(copy) : ''}</p>
  </section>;
  const Root = plane === 'hq' ? 'section' : 'main';
  return <Root className={styles.page} data-guide-mode={mode} data-founder-plane={plane}>
    <header className={styles.hero}><p className={styles.kicker}>HON OS · {t('eyebrow')}</p><h1>{t(plane === 'hq' ? 'hqTitle' : 'heading')}</h1><p>{t(plane === 'hq' ? 'hqIntro' : 'intro')}</p><p className={styles.boundary}>{t('boundary')}</p></header>
    <section className={styles.toolbar}><div role="group" aria-label={t('mode')}>{(['modern','classic','big-button'] as const).map(value => <button type="button" key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>{t(value)}</button>)}</div><small>{t('modeNote')}</small><button type="button" disabled={phase === 'loading'} onClick={() => void load()}>{t(phase === 'loading' ? 'loading' : plane === 'hq' ? 'hqLoad' : 'load')}</button><p role="status" aria-live="polite" aria-atomic="true" data-founder-status>{t(phase === 'denied' && plane === 'hq' ? 'hqDenied' : phase)}</p>{(phase === 'signedout' || phase === 'identity') && <a href="/auth/login">{t('signin')}</a>}</section>
    {plane === 'school' ? <div className={styles.grid}>
      <nav className={styles.steps} aria-label={t('steps')}><ol>{STEP_TITLES.map((key, index) => <li key={key}><button type="button" aria-current={step === index ? 'step' : undefined} onClick={() => setStep(index)}><span className={styles.stepNumber}>{number(index + 1)}</span><span>{t(key)}</span></button></li>)}</ol><a href="/staff/launch">{t('openLaunch')} →</a></nav>
      <div className={styles.content}><section className={styles.card} aria-labelledby="founder-current-step"><p className={styles.kicker}>{number(step + 1)} / {number(8)} · {t('guide')}</p><h2 id="founder-current-step">{t(STEP_TITLES[step]!)}</h2><p>{t(STEP_BODIES[step]!)}</p>
        {step === 0 && <><h3>{t('resume')}</h3><p>{t('resumeText')}</p></>}
        {step === 1 && <><h3>{t('school')}</h3><p>{facts?.schoolName ?? t('unknown')}</p><p>{t('profileGap')}</p><button type="button" disabled>{t('unsupported')}</button></>}
        {step === 2 && <><p>{t('staffGap')}</p><a href="/staff/roles">{t('openRoles')} →</a><button type="button" disabled>{t('unsupported')}</button></>}
        {step === 3 && <div className={styles.links}><a href="/staff/launch">{t('openLaunch')} →</a><a href="/staff/schedule/sessions">{t('openSchedule')} →</a></div>}
        {step === 4 && <><p>{t('crmCheck')}</p><div className={styles.links}><a href="/staff/crm/leads">{t('openCrm')} →</a><a href="/staff/billing/membership-plans">{t('openPlans')} →</a><a href="/staff/migration/leads">{t('openImport')} →</a></div></>}
        {step === 5 && <><p>{t('aiIntro')}</p><a href="/staff/hon">{t('openHon')} →</a></>}
        {step === 6 && <><p>{t('reviewNote')}</p><a href="/staff/subscription">{t('openSubscription')} →</a></>}
        {step === 7 && <p>{t('supportNote')}</p>}
        <div className={styles.actions}><button type="button" disabled={step === 0} onClick={() => setStep(v => v - 1)}>{t('previous')}</button><button type="button" disabled={step === 7} onClick={() => setStep(v => v + 1)}>{t('next')}</button></div>
      </section>{evidence}{step === 7 && support}</div>
      <aside className={styles.assistant}><div className={styles.honMark} aria-hidden="true">H</div><h2>{t('honTitle')}</h2><small>{t('honNote')}</small><p>{t(STEP_BODIES[step]!)}</p><a href="/staff/hon">{t('openHon')} →</a><button type="button" onClick={() => setStep(7)}>{t('help')}</button></aside>
    </div> : <div className={styles.hqGrid}><section className={styles.card}><h2>{t('evidence')}</h2><p>{t('hqGap')}</p>{directory && (directory.length ? <ul className={styles.directory}>{directory.map((school, index) => <li key={index}><strong>{school.schoolName}</strong><span>{school.organizationName}</span><small>{t('hqUnknown')}</small></li>)}</ul> : <p>{t('empty')}</p>)}<a href="/hq/school-owner-invitations">{t('hqInvites')} →</a></section>{support}</div>}
    <section className={styles.sample}><button type="button" aria-expanded={sample} onClick={() => setSample(v => !v)}>{t(sample ? 'sampleHide' : 'sample')}</button>{sample && <div><h2>{t('sampleBanner')}</h2><h3>{t('sampleSchool')}</h3><p>{t('sampleDetail')}</p>{plane === 'hq' && <p>{t('hqSample')}</p>}</div>}</section>
  </Root>;
}
