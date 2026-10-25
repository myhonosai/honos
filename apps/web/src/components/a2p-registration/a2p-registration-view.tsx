'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import type { HonInterfaceTheme, TranslationKey } from '@hon/design-system';
import { useLocale } from '../localization/provider';
import { HonMark } from '../hon-command/hon-workspace-view';
import {
  A2P_ANSWER_KEYS, A2P_CONFIRMATION_KEYS, A2P_FINDING_OUTCOMES, A2P_REGISTRATION_STATUSES, A2P_STEPS,
  type A2pAnswerKey, type A2pFinding, type A2pFindingOutcome, type A2pSource, type A2pStep,
} from './contract';
import { a2pCapabilities, a2pReadiness, answerProvenance, answerValue, type A2pController, type A2pSnapshot } from './controller';
import styles from './a2p-registration.module.css';

type T = (key: TranslationKey, params?: Readonly<Record<string, string | number>>) => string;
const k = (value: string) => value as TranslationKey;

const OUTCOME_ORDER: readonly A2pFindingOutcome[] = ['NEEDS_FIXING', 'REVIEW_REQUIRED', 'UNABLE_TO_VERIFY', 'PASSED'];
const OUTCOME_TONE: Record<A2pFindingOutcome, string> = { PASSED: 'ready', NEEDS_FIXING: 'blocked', REVIEW_REQUIRED: 'waiting', UNABLE_TO_VERIFY: 'planned' };
const ANSWER_GROUPS: ReadonlyArray<{ id: string; keys: readonly A2pAnswerKey[] }> = [
  { id: 'campaign', keys: ['CAMPAIGN_DESCRIPTION', 'MESSAGE_FLOW'] },
  { id: 'samples', keys: ['SAMPLE_MESSAGE_1', 'SAMPLE_MESSAGE_2', 'SAMPLE_MESSAGE_3'] },
  { id: 'replies', keys: ['HELP_RESPONSE', 'STOP_RESPONSE'] },
  { id: 'links', keys: ['WEBSITE_URL', 'PRIVACY_POLICY_URL', 'TERMS_URL'] },
];
const URL_KEYS: readonly A2pAnswerKey[] = ['WEBSITE_URL', 'PRIVACY_POLICY_URL', 'TERMS_URL'];
const tipKey = (key: A2pAnswerKey) => k(`a2p.tip.${key.startsWith('SAMPLE_MESSAGE') ? 'SAMPLE_MESSAGE' : key}`);

type FindingFilter = 'ALL' | A2pFindingOutcome;
type HonPrompt = 'website' | 'checkbox' | 'samples' | 'reject' | 'final';
export interface A2pHonPrompt { id: HonPrompt; step: A2pStep; filter?: FindingFilter; focus?: string }
const HON_PROMPTS: readonly A2pHonPrompt[] = [
  { id: 'website', step: 'FIX_WEBSITE', filter: 'NEEDS_FIXING' },
  { id: 'checkbox', step: 'FIX_WEBSITE', filter: 'ALL', focus: 'area-OPT_IN' },
  { id: 'samples', step: 'ANSWERS', focus: 'a2p-answer-SAMPLE_MESSAGE_1' },
  { id: 'reject', step: 'REVIEW', focus: 'a2p-review-contradictions' },
  { id: 'final', step: 'REVIEW' },
];

export interface A2pRegistrationViewProps {
  controller: A2pController;
  snapshot: A2pSnapshot;
  theme: HonInterfaceTheme;
  initialStep?: A2pStep;
  /** Reviewer-only controls rendered by the gated preview. */
  previewControls?: React.ReactNode;
}

export function A2pRegistrationView({ controller, snapshot, theme, initialStep = 'CHECK_WEBSITE', previewControls }: A2pRegistrationViewProps): React.ReactElement {
  const { t, date } = useLocale();
  const [step, setStep] = useState<A2pStep>(initialStep);
  const [filter, setFilter] = useState<FindingFilter>('ALL');
  const [navigation, setNavigation] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusTarget = useRef<string | null>(null);
  const source = controller.source;
  const index = A2P_STEPS.indexOf(step);

  // Move focus only after an explicit navigation: to the requested element, else the step heading.
  useEffect(() => {
    if (!navigation) return;
    const target = focusTarget.current ? findFocusTarget(focusTarget.current) : null;
    focusTarget.current = null;
    (target ?? heading.current)?.focus();
    target?.scrollIntoView({ block: 'center' });
  }, [navigation]);

  const go = (next: A2pStep, options: { filter?: FindingFilter; focus?: string } = {}) => {
    if (options.filter) setFilter(options.filter);
    focusTarget.current = options.focus ?? null;
    setStep(next);
    setNavigation((value) => value + 1);
  };

  return (
    <main className={styles.page} data-interface-theme={theme} data-source={source} aria-labelledby="a2p-title">
      <nav aria-label="Breadcrumb" className={styles.crumbs}>
        <ol>
          <li>{t('a2p.crumb.settings')}</li>
          <li>{t('a2p.crumb.communications')}</li>
          <li>{t('a2p.crumb.texting')}</li>
          <li aria-current="page">{t('a2p.crumb.a2p')}</li>
        </ol>
      </nav>
      <header className={styles.header}>
        <div className={styles.headerText}>
          <p className={styles.kicker}>HON · {t('a2p.crumb.texting')}</p>
          <h1 id="a2p-title">{t('a2p.title')}</h1>
          <p className={styles.lede}>{t('a2p.intro')}</p>
        </div>
        <a className={styles.honJump} href="#a2p-hon"><HonMark size="sm" />{t('a2p.hon.show')}</a>
      </header>
      {previewControls}
      <SourceBanner snapshot={snapshot} source={source} t={t} onRetry={() => { void controller.load(); }} />
      <div className={styles.layout}>
        <div className={styles.main}>
          <nav aria-label={t('a2p.steps.label')} className={styles.stepper}>
            <ol>
              {A2P_STEPS.map((value, position) => (
                <li key={value}>
                  <button type="button" aria-current={value === step ? 'step' : undefined} onClick={() => go(value)} data-done={stepDone(value, snapshot) || undefined}>
                    <span className={styles.stepNumber} aria-hidden="true">{position + 1}</span>
                    <span className={styles.stepText}><strong>{t(k(`a2p.step.${value}`))}</strong><small>{t(k(`a2p.stepHint.${value}`))}</small></span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          <section className={styles.stepPanel} aria-labelledby="a2p-step-heading">
            <p className={styles.stepOf}>{t('a2p.stepOf', { n: index + 1, total: A2P_STEPS.length })}</p>
            <h2 id="a2p-step-heading" ref={heading} tabIndex={-1}>{step === 'ANSWERS' ? t('a2p.answers.heading') : t(k(`a2p.step.${step}`))}</h2>
            {step === 'CHECK_WEBSITE' && <CheckStep controller={controller} snapshot={snapshot} t={t} date={date} onFix={() => go('FIX_WEBSITE', { filter: 'ALL' })} />}
            {step === 'FIX_WEBSITE' && <FixStep controller={controller} snapshot={snapshot} t={t} date={date} filter={filter} onFilter={setFilter} onRecheck={() => go('CHECK_WEBSITE')} />}
            {step === 'ANSWERS' && <AnswersStep controller={controller} snapshot={snapshot} t={t} date={date} />}
            {step === 'REVIEW' && <ReviewStep controller={controller} snapshot={snapshot} t={t} date={date} onGo={go} />}
            {step === 'STATUS' && <StatusStep snapshot={snapshot} source={source} t={t} date={date} />}
            <div className={styles.stepNav}>
              {index > 0 && <button type="button" className={styles.secondary} onClick={() => go(A2P_STEPS[index - 1]!)}>← {t('a2p.back')}</button>}
              {index < A2P_STEPS.length - 1 && <button type="button" className={styles.primary} onClick={() => go(A2P_STEPS[index + 1]!)}>{t('a2p.next')} →</button>}
            </div>
          </section>
        </div>
        <HonAssistant t={t} onPrompt={(prompt) => go(prompt.step, { ...(prompt.filter ? { filter: prompt.filter } : {}), ...(prompt.focus ? { focus: prompt.focus } : {}) })} />
      </div>
      <footer className={styles.footer}>
        <p>{t('a2p.noSubmission')}</p>
        <p>{t('a2p.noGuarantee')}</p>
      </footer>
    </main>
  );
}

function findFocusTarget(target: string): HTMLElement | null {
  if (target.startsWith('area-')) return document.querySelector<HTMLElement>(`[data-finding-area="${target.slice(5)}"] h3`);
  return document.getElementById(target);
}

function stepDone(step: A2pStep, snapshot: A2pSnapshot): boolean {
  if (step === 'CHECK_WEBSITE') return snapshot.check?.state === 'COMPLETED';
  if (step === 'FIX_WEBSITE') return snapshot.check?.state === 'COMPLETED' && a2pReadiness(snapshot).needsFixing === 0;
  return false;
}

function SourceBanner({ snapshot, source, t, onRetry }: { snapshot: A2pSnapshot; source: A2pSource; t: T; onRetry: () => void }): React.ReactElement {
  const availability = snapshot.availability;
  if (availability.state === 'LOADING') return <div className={styles.banner} data-tone="neutral" role="status">{t('a2p.loading')}</div>;
  if (availability.state === 'DENIED') return <div className={styles.banner} data-tone="waiting" role="alert"><strong>{t('a2p.denied.title')}</strong><p>{t('a2p.denied.body')}</p></div>;
  if (availability.state === 'ERROR') return <div className={styles.banner} data-tone="blocked" role="alert"><strong>{t('a2p.error.title')}</strong><p>{t('a2p.error.body')}</p><button type="button" className={styles.secondary} onClick={onRetry}>{t('a2p.retry')}</button></div>;
  if (availability.state === 'NOT_CONNECTED') return <div className={styles.banner} data-tone="planned" role="status" data-testid="a2p-not-connected"><strong>{t('a2p.notConnected.title')}</strong><p>{t('a2p.notConnected.body')}</p></div>;
  if (source === 'SYNTHETIC_FIXTURE') return <div className={styles.banner} data-tone="synthetic" role="status" data-testid="a2p-synthetic"><strong>{t('a2p.synthetic.title')}</strong><p>{t('a2p.synthetic.body')}</p></div>;
  return <></>;
}

function SyntheticChip({ source, t }: { source: A2pSource; t: T }): React.ReactElement | null {
  return source === 'SYNTHETIC_FIXTURE' ? <span className={styles.badge} data-tone="synthetic">{t('a2p.synthetic.chip')}</span> : null;
}

export function CopyButton({ text, label, t }: { text: string; label: string; t: T }): React.ReactElement {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('unavailable');
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch { setState('failed'); }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 4000);
  };
  return (
    <span className={styles.copy}>
      <button type="button" className={styles.secondary} onClick={() => { void copy(); }} disabled={!text.trim()} aria-label={`${label}: ${t('a2p.copy')}`}>{state === 'copied' ? `✓ ${t('a2p.copied')}` : t('a2p.copy')}</button>
      <span role="status" className={state === 'failed' ? styles.error : styles.visuallyHidden}>{state === 'copied' ? t('a2p.copied') : state === 'failed' ? t('a2p.copyFailed') : ''}</span>
    </span>
  );
}

function ReviewersGuide({ t }: { t: T }): React.ReactElement {
  return (
    <section className={styles.guide} aria-labelledby="a2p-guide">
      <h3 id="a2p-guide">{t('a2p.guide.heading')}</h3>
      <ul>{[1, 2, 3, 4, 5, 6].map((n) => <li key={n}>{t(k(`a2p.guide.${n}`))}</li>)}</ul>
      <p className={styles.meta}>{t('a2p.guide.note')}</p>
    </section>
  );
}

type StepProps = { controller: A2pController; snapshot: A2pSnapshot; t: T; date: (value: string) => string };

function CheckStep({ controller, snapshot, t, date, onFix }: StepProps & { onFix: () => void }): React.ReactElement {
  const capable = a2pCapabilities(snapshot).websiteCheck;
  const inputId = useId(), helpId = useId(), errorId = useId();
  const busy = snapshot.checkPhase === 'STARTING' || snapshot.checkPhase === 'POLLING';
  const check = snapshot.check;
  const counts = Object.fromEntries(A2P_FINDING_OUTCOMES.map((outcome) => [outcome, check?.findings.filter((finding) => finding.outcome === outcome).length ?? 0])) as Record<A2pFindingOutcome, number>;
  return (
    <>
      <p className={styles.lede}>{t('a2p.check.lede')}</p>
      <form className={styles.urlForm} onSubmit={(event) => { event.preventDefault(); void controller.startWebsiteCheck(); }} noValidate>
        <label htmlFor={inputId}>{t('a2p.check.label')}</label>
        <div className={styles.urlRow}>
          <input id={inputId} type="url" inputMode="url" autoComplete="url" spellCheck={false} placeholder={t('a2p.check.placeholder')} value={snapshot.websiteInput}
            onChange={(event) => controller.setWebsiteInput(event.target.value)} disabled={!capable || busy}
            aria-invalid={snapshot.inputError ? true : undefined} aria-describedby={`${helpId}${snapshot.inputError ? ` ${errorId}` : ''}`} />
          <button type="submit" className={styles.primary} disabled={!capable || busy}>{check?.state === 'COMPLETED' ? t('a2p.check.again') : t('a2p.check.start')}</button>
        </div>
        <p id={helpId} className={styles.meta}>{capable ? t('a2p.check.help') : t('a2p.check.unavailable')}</p>
        {snapshot.inputError && <p id={errorId} className={styles.error} role="alert">{t(k(`a2p.check.error.${snapshot.inputError}`))}</p>}
      </form>
      <CheckProgress snapshot={snapshot} t={t} date={date} />
      {check?.state === 'COMPLETED' && (
        <section className={styles.summary} aria-labelledby="a2p-check-summary">
          <div className={styles.rowBetween}><h3 id="a2p-check-summary">{t('a2p.check.summary')}</h3><SyntheticChip source={controller.source} t={t} /></div>
          <ul className={styles.tiles}>
            {OUTCOME_ORDER.map((outcome) => <li key={outcome} data-tone={OUTCOME_TONE[outcome]}><strong>{counts[outcome]}</strong><span>{t(k(`a2p.outcome.${outcome}`))}</span></li>)}
          </ul>
          <button type="button" className={styles.primary} onClick={onFix}>{t('a2p.check.seeFixes')} →</button>
        </section>
      )}
      <ReviewersGuide t={t} />
    </>
  );
}

function CheckProgress({ snapshot, t, date }: { snapshot: A2pSnapshot; t: T; date: (value: string) => string }): React.ReactElement | null {
  const { checkPhase: phase, check } = snapshot;
  if (phase === 'IDLE') return null;
  if (phase === 'FAILED') return <p className={styles.notice} data-tone="blocked" role="alert">{t('a2p.check.failed')}</p>;
  if (phase === 'TIMED_OUT') return <p className={styles.notice} data-tone="waiting" role="alert">{t('a2p.check.timedOut')}</p>;
  if (phase === 'DONE') {
    if (check?.inspection === 'SYNTHETIC_FIXTURE') return <p className={styles.notice} data-tone="synthetic" role="status" data-testid="a2p-inspection-sample">{t('a2p.check.doneSample')}</p>;
    if (check?.inspection !== 'LIVE') return <p className={styles.notice} data-tone="waiting" role="status" data-testid="a2p-inspection-off">{t('a2p.check.noInspection')}</p>;
    return <p className={styles.notice} data-tone="ready" role="status">✓ {t('a2p.check.done')}{check.completedAt ? ` · ${t('a2p.check.doneAt', { time: date(check.completedAt) })}` : ''}</p>;
  }
  const done = check?.pagesChecked ?? 0, total = check?.pagesPlanned ?? null;
  const label = phase === 'STARTING' ? t('a2p.check.starting') : check?.state === 'QUEUED' ? t('a2p.check.queued') : t('a2p.check.checking');
  return (
    <div className={styles.progress} role="status" aria-live="polite">
      <strong><span className={styles.spinner} aria-hidden="true" />{label}</strong>
      {total ? <progress max={total} value={done} aria-label={t('a2p.check.progress', { done, total })} /> : <progress aria-label={label} />}
      {phase === 'POLLING' && <span className={styles.meta}>{total ? t('a2p.check.progress', { done, total }) : t('a2p.check.progressOpen', { done })}</span>}
    </div>
  );
}

function FixStep({ controller, snapshot, t, date, filter, onFilter, onRecheck }: StepProps & { filter: FindingFilter; onFilter: (value: FindingFilter) => void; onRecheck: () => void }): React.ReactElement {
  const check = snapshot.check;
  if (check?.state !== 'COMPLETED') {
    return <><p className={styles.lede}>{t('a2p.fix.lede')}</p><p className={styles.empty}>{t('a2p.fix.none')}</p><button type="button" className={styles.secondary} onClick={onRecheck}>{t('a2p.check.start')}</button><ReviewersGuide t={t} /></>;
  }
  const sorted = [...check.findings].sort((a, b) => OUTCOME_ORDER.indexOf(a.outcome) - OUTCOME_ORDER.indexOf(b.outcome));
  const shown = filter === 'ALL' ? sorted : sorted.filter((finding) => finding.outcome === filter);
  return (
    <>
      <p className={styles.lede}>{t('a2p.fix.lede')}</p>
      <div className={styles.filters} role="group" aria-label={t('a2p.fix.filter')}>
        {(['ALL', ...OUTCOME_ORDER] as const).map((value) => {
          const n = value === 'ALL' ? sorted.length : sorted.filter((finding) => finding.outcome === value).length;
          return <button key={value} type="button" aria-pressed={filter === value} onClick={() => onFilter(value)} data-tone={value === 'ALL' ? undefined : OUTCOME_TONE[value]}>{value === 'ALL' ? t('a2p.fix.filter.ALL') : t(k(`a2p.outcome.${value}`))} <span>{n}</span></button>;
        })}
      </div>
      <div className={styles.rowBetween}><p className={styles.meta} role="status">{t('a2p.fix.count', { count: shown.length })}</p><SyntheticChip source={controller.source} t={t} /></div>
      <ol className={styles.findings}>
        {shown.map((finding) => <li key={finding.id}><FindingCard finding={finding} controller={controller} snapshot={snapshot} t={t} date={date} /></li>)}
      </ol>
      <button type="button" className={styles.secondary} onClick={onRecheck}>{t('a2p.check.again')}</button>
    </>
  );
}

function FindingCard({ finding, controller, snapshot, t, date }: StepProps & { finding: A2pFinding }): React.ReactElement {
  const [compare, setCompare] = useState(false);
  const compareId = useId();
  const reviewable = a2pCapabilities(snapshot).findingReview;
  const pending = snapshot.reviewPending.includes(finding.id);
  const failed = snapshot.reviewFailed.includes(finding.id);
  const marked = finding.review === 'MARKED_FOR_REVIEW';
  return (
    <article className={styles.finding} data-outcome={finding.outcome} data-finding-area={finding.area} id={`a2p-finding-${finding.id}`}>
      <header>
        <span className={styles.badge} data-tone={OUTCOME_TONE[finding.outcome]}>{t(k(`a2p.outcome.${finding.outcome}`))}</span>
        <span className={styles.area}>{t(k(`a2p.area.${finding.area}`))}</span>
        {marked && <span className={styles.badge} data-tone="neutral">⚑ {t('a2p.fix.marked')}</span>}
      </header>
      <h3 tabIndex={-1}>{finding.title}</h3>
      <dl className={styles.facts}>
        <div><dt>{t('a2p.fix.what')}</dt><dd>{finding.explanation}</dd></div>
        <div><dt>{t('a2p.fix.where')}</dt><dd>
          {finding.location.sectionLabel ?? t('a2p.fix.whereUnknown')}
          {finding.location.pageUrl && <> · <a href={finding.location.pageUrl} target="_blank" rel="noopener noreferrer">{t('a2p.fix.openPage')}<span className={styles.visuallyHidden}> ({finding.location.pageUrl})</span> ↗</a></>}
        </dd></div>
        <div><dt>{t('a2p.fix.why')}</dt><dd>{finding.whyItMatters}</dd></div>
      </dl>
      {finding.suggestedText && (
        <div className={styles.suggestion}>
          <p className={styles.label}>{t('a2p.fix.proposed')}</p>
          <p className={styles.wording}>{finding.suggestedText}</p>
          <div className={styles.actions}>
            <CopyButton text={finding.suggestedText} label={`${finding.title} · ${t('a2p.fix.copy')}`} t={t} />
            <button type="button" className={styles.secondary} aria-expanded={compare} aria-controls={compareId} onClick={() => setCompare(!compare)}>{compare ? t('a2p.fix.hideCompare') : t('a2p.fix.compare')}</button>
          </div>
          <div id={compareId} className={styles.compare} hidden={!compare}>
            <div data-side="original"><p className={styles.label}>{t('a2p.fix.original')}</p><p className={styles.wording}>{finding.originalText ?? <em>{t('a2p.fix.noOriginal')}</em>}</p></div>
            <div data-side="proposed"><p className={styles.label}>{t('a2p.fix.proposed')}</p><p className={styles.wording}>{finding.suggestedText}</p></div>
          </div>
        </div>
      )}
      <footer className={styles.findingFoot}>
        {finding.outcome !== 'PASSED' && (
          <button type="button" className={styles.secondary} aria-pressed={marked} disabled={!reviewable || pending} onClick={() => { void controller.toggleReview(finding.id); }}>
            {pending ? t('a2p.fix.marking') : marked ? t('a2p.fix.unmark') : `⚑ ${t('a2p.fix.mark')}`}
          </button>
        )}
        {!reviewable && finding.outcome !== 'PASSED' && <span className={styles.meta}>{t('a2p.fix.markUnavailable')}</span>}
        {failed && <span className={styles.error} role="alert">{t('a2p.fix.markFailed')}</span>}
        {snapshot.check?.inspection === 'SYNTHETIC_FIXTURE' ? <span className={styles.badge} data-tone="synthetic">{t('a2p.fix.observedSample')}</span>
          : finding.observedAt ? <span className={styles.meta}>{t('a2p.fix.observed', { time: date(finding.observedAt) })}</span>
            : <span className={styles.meta}>{t('a2p.fix.notObserved')}</span>}
      </footer>
    </article>
  );
}

const PROVENANCE_TONE = { VERIFIED: 'ready', VERIFIED_SAMPLE: 'synthetic', OWNER_CONFIRMED: 'neutral', UNVERIFIED_DRAFT: 'waiting', EDITED: 'edited', EMPTY: 'planned' } as const;

function AnswersStep({ controller, snapshot, t, date }: StepProps): React.ReactElement {
  const capabilities = a2pCapabilities(snapshot);
  const drafted = snapshot.answers.answers.some((answer) => answer.value.trim());
  const edits = Object.keys(snapshot.edits).length;
  return (
    <>
      <p className={styles.lede}>{t('a2p.answers.lede')}</p>
      <div className={styles.toolbar}>
        {capabilities.answerDrafts
          ? <button type="button" className={styles.primary} disabled={snapshot.answerPhase === 'WORKING'} onClick={() => { void controller.draftAnswers(); }}>{snapshot.answerPhase === 'WORKING' ? t('a2p.answers.drafting') : drafted ? t('a2p.answers.redraft') : t('a2p.answers.draft')}</button>
          : <p className={styles.notice} data-tone="planned">{t('a2p.answers.draftUnavailable')}</p>}
        <SyntheticChip source={controller.source} t={t} />
      </div>
      {snapshot.answerPhase === 'WORKING' && <p className={styles.meta} role="status"><span className={styles.spinner} aria-hidden="true" />{t('a2p.answers.drafting')}</p>}
      {snapshot.answerPhase === 'FAILED' && <p className={styles.error} role="alert">{t('a2p.answers.draftFailed')}</p>}
      <div className={styles.legend}>
        <span className={styles.meta}>{t('a2p.answers.legend')}</span>
        {([controller.source === 'SYNTHETIC_FIXTURE' ? 'VERIFIED_SAMPLE' : 'VERIFIED', 'OWNER_CONFIRMED', 'UNVERIFIED_DRAFT', 'EDITED'] as const).map((value) => <span key={value} className={styles.badge} data-tone={PROVENANCE_TONE[value]}>{t(k(`a2p.provenance.${value}`))}</span>)}
      </div>
      {ANSWER_GROUPS.map((group) => (
        <fieldset key={group.id} className={styles.group}>
          <legend>{t(k(`a2p.group.${group.id}`))}</legend>
          {group.keys.map((key) => <AnswerField key={key} answerKey={key} controller={controller} snapshot={snapshot} t={t} />)}
        </fieldset>
      ))}
      <div className={styles.saveBar} data-dirty={edits > 0 || undefined}>
        {capabilities.saveAnswers
          ? <button type="button" className={styles.primary} disabled={!edits || snapshot.savePhase === 'SAVING'} onClick={() => { void controller.saveAnswers(); }}>{snapshot.savePhase === 'SAVING' ? t('a2p.answers.saving') : t('a2p.answers.save')}</button>
          : null}
        <div role="status" aria-live="polite">
          {snapshot.savePhase === 'SAVED' && !edits && <p className={styles.success}>✓ {t('a2p.answers.saved')}</p>}
          {snapshot.savePhase === 'UNKNOWN' && <p className={styles.error}>{t('a2p.answers.saveUnknown')}</p>}
          {edits > 0 && snapshot.savePhase !== 'UNKNOWN' && <p className={styles.warning}>{t('a2p.answers.notSaved')}</p>}
        </div>
        <p className={styles.meta}>{t('a2p.answers.noAutosave')}</p>
      </div>
      <Confirmations controller={controller} snapshot={snapshot} t={t} date={date} />
    </>
  );
}

function AnswerField({ answerKey, controller, snapshot, t }: { answerKey: A2pAnswerKey; controller: A2pController; snapshot: A2pSnapshot; t: T }): React.ReactElement {
  const id = `a2p-answer-${answerKey}`, tipId = `${id}-tip`;
  const value = answerValue(snapshot, answerKey);
  const provenance = answerProvenance(snapshot, answerKey);
  const notes = snapshot.answers.answers.find((answer) => answer.key === answerKey)?.notes ?? [];
  const label = t(k(`a2p.field.${answerKey}`));
  const url = URL_KEYS.includes(answerKey);
  return (
    <div className={styles.field} data-provenance={provenance}>
      <div className={styles.fieldHead}>
        <label htmlFor={id}>{label}</label>
        <span className={styles.badge} data-tone={PROVENANCE_TONE[provenance]}>{t(k(`a2p.provenance.${provenance}`))}</span>
      </div>
      {url
        ? <input id={id} type="url" inputMode="url" spellCheck={false} value={value} onChange={(event) => controller.editAnswer(answerKey, event.target.value)} aria-describedby={tipId} />
        : <textarea id={id} rows={answerKey.startsWith('SAMPLE') || answerKey.endsWith('RESPONSE') ? 3 : 5} value={value} onChange={(event) => controller.editAnswer(answerKey, event.target.value)} aria-describedby={tipId} />}
      <div className={styles.fieldFoot}>
        <p id={tipId} className={styles.meta}>{t(tipKey(answerKey))}{!url && <> · {t('a2p.answers.chars', { count: value.length })}</>}</p>
        <CopyButton text={value} label={label} t={t} />
      </div>
      {notes.length > 0 && <ul className={styles.notes}>{notes.map((note) => <li key={note}>{note}</li>)}</ul>}
    </div>
  );
}

function Confirmations({ controller, snapshot, t, date }: StepProps): React.ReactElement {
  const capable = a2pCapabilities(snapshot).ownerConfirmations;
  return (
    <section className={styles.confirmations} aria-labelledby="a2p-confirmations">
      <h3 id="a2p-confirmations">{t('a2p.confirm.heading')}</h3>
      <p className={styles.meta}>{t('a2p.confirm.lede')}</p>
      {!capable && <p className={styles.notice} data-tone="planned">{t('a2p.confirm.unavailable')}</p>}
      <ul>
        {A2P_CONFIRMATION_KEYS.map((key) => {
          const item = snapshot.answers.confirmations.find((entry) => entry.key === key);
          const pending = snapshot.confirmationPending.includes(key);
          const confirmed = item?.confirmed === true;
          return (
            <li key={key} data-confirmed={confirmed || undefined}>
              <span className={styles.check} aria-hidden="true">{confirmed ? '✓' : ''}</span>
              <div>
                <p>{t(k(`a2p.confirm.${key}`))}</p>
                <span className={styles.meta}>{confirmed && item?.confirmedAt ? t('a2p.confirm.confirmed', { time: date(item.confirmedAt) }) : t('a2p.confirm.notConfirmed')}</span>
                {snapshot.confirmationFailed.includes(key) && <span className={styles.error} role="alert"> {t('a2p.confirm.failed')}</span>}
              </div>
              <button type="button" className={styles.secondary} disabled={!capable || pending} aria-label={`${confirmed ? t('a2p.confirm.withdraw') : t('a2p.confirm.action')}: ${t(k(`a2p.confirm.${key}`))}`} onClick={() => { void controller.setConfirmation(key, !confirmed); }}>
                {pending ? t('a2p.confirm.saving') : confirmed ? t('a2p.confirm.withdraw') : t('a2p.confirm.action')}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const READINESS_COUNTS = ['needsFixing', 'reviewRequired', 'unableToVerify', 'markedForReview', 'missingConfirmations', 'emptyAnswers', 'unverifiedAnswers', 'unsavedEdits', 'contradictions'] as const;

function ReviewStep({ controller, snapshot, t, date, onGo }: StepProps & { onGo: (step: A2pStep, options?: { filter?: FindingFilter; focus?: string }) => void }): React.ReactElement {
  const readiness = a2pReadiness(snapshot);
  const capabilities = a2pCapabilities(snapshot);
  const checked = snapshot.check?.state === 'COMPLETED';
  const problems = checked ? snapshot.check!.findings.filter((finding) => finding.outcome !== 'PASSED').sort((a, b) => OUTCOME_ORDER.indexOf(a.outcome) - OUTCOME_ORDER.indexOf(b.outcome)) : [];
  const missing = snapshot.answers.confirmations.filter((item) => !item.confirmed);
  return (
    <>
      <p className={styles.lede}>{t('a2p.review.lede')}</p>
      <section className={styles.readiness} data-label={readiness.label} aria-labelledby="a2p-readiness">
        <div className={styles.rowBetween}><h3 id="a2p-readiness">{t('a2p.review.readiness')}</h3><SyntheticChip source={controller.source} t={t} /></div>
        <p className={styles.readinessLabel}>{t(k(`a2p.review.label.${readiness.label}`))}</p>
        <ul className={styles.counts}>
          {READINESS_COUNTS.map((key) => <li key={key} data-zero={readiness[key] === 0 || undefined}><strong>{readiness[key]}</strong><span>{t(k(`a2p.review.count.${key}`))}</span></li>)}
        </ul>
        <p className={styles.meta}>{t('a2p.review.labelNote')}</p>
      </section>
      <section className={styles.reviewBlock} aria-labelledby="a2p-review-problems">
        <div className={styles.rowBetween}><h3 id="a2p-review-problems">{t('a2p.review.problems')}</h3>{problems.length > 0 && <button type="button" className={styles.secondary} onClick={() => onGo('FIX_WEBSITE', { filter: 'ALL' })}>{t('a2p.review.goFix')}</button>}</div>
        {!checked ? <p className={styles.empty}>{t('a2p.review.problemsUnavailable')}</p> : problems.length === 0 ? <p className={styles.empty}>{t('a2p.review.noProblems')}</p> : (
          <ul className={styles.compactList}>{problems.map((finding) => <li key={finding.id}><span className={styles.badge} data-tone={OUTCOME_TONE[finding.outcome]}>{t(k(`a2p.outcome.${finding.outcome}`))}</span> {finding.title}</li>)}</ul>
        )}
      </section>
      <section className={styles.reviewBlock} aria-labelledby="a2p-review-missing">
        <h3 id="a2p-review-missing">{t('a2p.review.missing')}</h3>
        {missing.length === 0 ? <p className={styles.empty}>{t('a2p.review.noMissing')}</p> : <ul className={styles.compactList}>{missing.map((item) => <li key={item.key}>○ {t(k(`a2p.confirm.${item.key}`))}</li>)}</ul>}
      </section>
      <section className={styles.reviewBlock} aria-labelledby="a2p-review-contradictions-heading">
        <h3 id="a2p-review-contradictions-heading"><span id="a2p-review-contradictions" tabIndex={-1}>{t('a2p.review.contradictions')}</span></h3>
        {!capabilities.answerDrafts ? <p className={styles.empty}>{t('a2p.review.contradictionsUnavailable')}</p>
          : snapshot.answers.contradictions.length === 0 ? <p className={styles.empty}>{t('a2p.review.noContradictions')}</p>
            : <ul className={styles.compactList}>{snapshot.answers.contradictions.map((item) => <li key={item.id} data-tone="waiting">⚠ {item.summary}{item.answerKeys.length > 0 && <span className={styles.meta}> · {item.answerKeys.map((key) => t(k(`a2p.field.${key}`))).join(', ')}</span>}</li>)}</ul>}
      </section>
      <section className={styles.reviewBlock} aria-labelledby="a2p-review-answers">
        <div className={styles.rowBetween}><h3 id="a2p-review-answers">{t('a2p.review.answers')}</h3><button type="button" className={styles.secondary} onClick={() => onGo('ANSWERS')}>{t('a2p.review.edit')}</button></div>
        <dl className={styles.answerList}>
          {A2P_ANSWER_KEYS.map((key) => {
            const value = answerValue(snapshot, key), provenance = answerProvenance(snapshot, key), label = t(k(`a2p.field.${key}`));
            return (
              <div key={key}>
                <dt>{label} <span className={styles.badge} data-tone={PROVENANCE_TONE[provenance]}>{t(k(`a2p.provenance.${provenance}`))}</span></dt>
                <dd>{value.trim() ? <span className={styles.wording}>{value}</span> : <em>{t('a2p.review.empty')}</em>}<CopyButton text={value} label={label} t={t} /></dd>
              </div>
            );
          })}
        </dl>
      </section>
      <div className={styles.exportBar}>
        <button type="button" className={styles.primary} onClick={() => downloadText(buildA2pExport(snapshot, t, date, controller.source))}>⤓ {t('a2p.review.export')}</button>
        <button type="button" className={styles.secondary} disabled aria-describedby="a2p-submit-note">{t('a2p.review.submit')}</button>
        <p className={styles.meta}>{t('a2p.review.exportNote')}</p>
        <p id="a2p-submit-note" className={styles.meta}>{t('a2p.review.submitNote')} {t('a2p.noGuarantee')}</p>
      </div>
    </>
  );
}

/** Plain-text draft of what is on screen. Built locally; nothing is uploaded. */
export function buildA2pExport(snapshot: A2pSnapshot, t: T, date: (value: string) => string, source: A2pSource, now = new Date()): string {
  const readiness = a2pReadiness(snapshot);
  const lines: string[] = [t('a2p.export.title'), t('a2p.export.downloaded', { time: date(now.toISOString()) })];
  if (source === 'SYNTHETIC_FIXTURE') lines.push(t('a2p.export.synthetic'));
  lines.push('', `## ${t('a2p.review.readiness')}`, t(k(`a2p.review.label.${readiness.label}`)));
  for (const key of READINESS_COUNTS) lines.push(`- ${t(k(`a2p.review.count.${key}`))}: ${readiness[key]}`);
  lines.push(t('a2p.review.labelNote'), '', `## ${t('a2p.review.answers')}`);
  for (const key of A2P_ANSWER_KEYS) {
    const value = answerValue(snapshot, key);
    lines.push('', `### ${t(k(`a2p.field.${key}`))} [${t(k(`a2p.provenance.${answerProvenance(snapshot, key)}`))}]`, value.trim() || `(${t('a2p.review.empty')})`);
  }
  if (snapshot.check?.state === 'COMPLETED') {
    lines.push('', `## ${t('a2p.review.problems')}`);
    for (const finding of snapshot.check.findings.filter((item) => item.outcome !== 'PASSED')) lines.push(`- [${t(k(`a2p.outcome.${finding.outcome}`))}] ${finding.title}${finding.location.pageUrl ? ` (${finding.location.pageUrl})` : ''}`);
  }
  lines.push('', `## ${t('a2p.review.missing')}`);
  for (const item of snapshot.answers.confirmations) lines.push(`- [${item.confirmed ? 'x' : ' '}] ${t(k(`a2p.confirm.${item.key}`))}`);
  if (snapshot.answers.contradictions.length) {
    lines.push('', `## ${t('a2p.review.contradictions')}`);
    for (const item of snapshot.answers.contradictions) lines.push(`- ${item.summary}`);
  }
  lines.push('', t('a2p.noSubmission'), t('a2p.noGuarantee'), '');
  return lines.join('\n');
}

function downloadText(content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'hon-texting-registration-draft.txt';
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const STATUS_TONE: Record<string, string> = { NOT_STARTED: 'planned', DRAFT: 'neutral', NEEDS_CORRECTION: 'waiting', SUBMITTED: 'neutral', UNDER_REVIEW: 'neutral', APPROVED: 'ready', REJECTED: 'blocked', UNKNOWN: 'planned' };

function StatusStep({ snapshot, source, t, date }: { snapshot: A2pSnapshot; source: A2pSource; t: T; date: (value: string) => string }): React.ReactElement {
  const section = snapshot.status;
  return (
    <>
      <p className={styles.lede}>{t('a2p.status.lede')}</p>
      <section className={styles.statusCard} aria-labelledby="a2p-status-current" data-state={section.state}>
        <div className={styles.rowBetween}><h3 id="a2p-status-current">{t('a2p.status.current')}</h3><SyntheticChip source={source} t={t} /></div>
        {section.state === 'UNAVAILABLE' && <div data-testid="a2p-status-unavailable"><p className={styles.statusValue}><span className={styles.badge} data-tone="planned">{t('a2p.status.unavailable.title')}</span></p><p className={styles.meta}>{t('a2p.status.unavailable.body')}</p></div>}
        {section.state === 'LOADING' && <p className={styles.meta} role="status"><span className={styles.spinner} aria-hidden="true" />{t('a2p.status.loading')}</p>}
        {section.state === 'ERROR' && <p className={styles.error} role="alert">{t('a2p.status.error')}</p>}
        {section.state === 'READY' && (
          <div>
            <p className={styles.statusValue}><span className={styles.badge} data-tone={STATUS_TONE[section.view.status]}>{t(k(`a2p.status.${section.view.status}`))}</span></p>
            <p className={styles.meta}>{t(k(`a2p.statusDetail.${section.view.status}`))}</p>
            <p className={styles.meta}>{section.view.reportedAt ? t('a2p.status.reported', { time: date(section.view.reportedAt) }) : t('a2p.status.notReported')}{section.view.providerReference ? ` · ${t('a2p.status.reference', { ref: section.view.providerReference })}` : ''}</p>
            {section.view.reasons.length > 0 && <><p className={styles.label}>{t('a2p.status.reasons')}</p><ul className={styles.compactList}>{section.view.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></>}
          </div>
        )}
      </section>
      <section className={styles.statusGuide} aria-labelledby="a2p-status-guide">
        <h3 id="a2p-status-guide">{t('a2p.status.guide')}</h3>
        <dl>
          {A2P_REGISTRATION_STATUSES.map((status) => <div key={status}><dt><span className={styles.badge} data-tone={STATUS_TONE[status]}>{t(k(`a2p.status.${status}`))}</span></dt><dd>{t(k(`a2p.statusDetail.${status}`))}</dd></div>)}
        </dl>
      </section>
    </>
  );
}

/** Suggested prompts only navigate; the composer stays disabled until a governed HON conversation exists. */
export function HonAssistant({ t, onPrompt, prompts = HON_PROMPTS }: { t: T; onPrompt: (prompt: A2pHonPrompt) => void; prompts?: readonly A2pHonPrompt[] }): React.ReactElement {
  const composerId = useId(), noteId = useId();
  return (
    <aside id="a2p-hon" className={styles.hon} aria-labelledby="a2p-hon-title">
      <div className={styles.honHead}><HonMark size="md" /><div><h2 id="a2p-hon-title">{t('a2p.hon.title')}</h2><p className={styles.meta}>{t('a2p.hon.lede')}</p></div></div>
      <ul className={styles.prompts}>
        {prompts.map((prompt) => (
          <li key={prompt.id}>
            <button type="button" onClick={() => onPrompt(prompt)}>
              <span>“{t(k(`a2p.hon.prompt.${prompt.id}`))}”</span>
              <small>{t('a2p.hon.opens', { step: t(k(`a2p.step.${prompt.step}`)) })}</small>
            </button>
          </li>
        ))}
      </ul>
      <p id={noteId} className={styles.notice} data-tone="planned" data-testid="a2p-hon-not-connected">{t('a2p.hon.notConnected')}</p>
      <form className={styles.composer} onSubmit={(event) => event.preventDefault()} aria-label={t('a2p.hon.composer')}>
        <label htmlFor={composerId} className={styles.visuallyHidden}>{t('a2p.hon.composer')}</label>
        <textarea id={composerId} rows={2} disabled placeholder={t('a2p.hon.composerPlaceholder')} aria-describedby={noteId} />
        <button type="submit" className={styles.primary} disabled>{t('a2p.hon.send')}</button>
      </form>
    </aside>
  );
}
