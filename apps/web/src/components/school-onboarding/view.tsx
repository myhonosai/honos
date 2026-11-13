import React from 'react';
import {
  ONBOARDING_DISCIPLINES, ONBOARDING_GOALS, ONBOARDING_IMPORT_WISHES, ONBOARDING_PATHS, ONBOARDING_PREVIOUS_SOFTWARE, ONBOARDING_SITUATIONS,
  type OnboardingAnswers, type OnboardingSkippableStep, type OnboardingStep, type SchoolOnboarding,
} from '@hon/contracts';
import { HON_INTERFACE_THEMES, type HonInterfaceTheme } from '@hon/design-system';
import { onboardingText, type OnboardingKey } from './copy';
import type { OnboardingErrorKind } from './http';
import { STEP_HREF, canSkip, goalsForStep, nextStep, progressOf, schoolTime, textProblem, toggle } from './plan';
import styles from './school-onboarding.module.css';

type T = (key: OnboardingKey, vars?: Record<string, string>) => string;
export type ReadState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; onboarding: SchoolOnboarding };
export type SaveOutcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | OnboardingErrorKind }>;
export type ModeState = 'IDLE' | 'SAVING' | 'SAVED' | 'FAILED';
const LANGUAGES = ['en', 'ko', 'es'] as const;
const MODES: readonly HonInterfaceTheme[] = HON_INTERFACE_THEMES.map((m) => m.id);

export type SchoolOnboardingViewProps = Readonly<{
  language: string; locale: string; waiting: boolean; concealed: boolean; hasSchool: boolean;
  read: ReadState; draft: OnboardingAnswers; editing: boolean; outcome: SaveOutcome; locked: boolean; canRetry: boolean;
  mode: HonInterfaceTheme; modeState: ModeState; languageBlocked: boolean;
  onRefresh?: (() => void) | undefined; onDraft?: ((next: OnboardingAnswers) => void) | undefined; onEdit?: ((editing: boolean) => void) | undefined;
  onSave?: (() => void) | undefined; onSkip?: ((key: OnboardingSkippableStep, skip: boolean) => void) | undefined;
  onMode?: ((mode: HonInterfaceTheme) => void) | undefined; onLanguage?: ((language: 'en' | 'ko' | 'es') => void) | undefined; onTryAgain?: (() => void) | undefined;
}>;

function Access({ onboarding, t, locale }: { onboarding: SchoolOnboarding; t: T; locale: string }): React.ReactElement | null {
  const { access, timezone } = onboarding;
  if (access.state === 'NOT_STARTED') return <div className={`${styles.notice} ${styles.warn}`} data-onboarding-access="NOT_STARTED">
    <p>{t('access_NOT_STARTED')}</p><a className={styles.primary} href="/account/start">{t('startTrial')}</a></div>;
  if (access.state === 'ENDED') return <div className={`${styles.notice} ${styles.warn}`} data-onboarding-access="ENDED">
    <p>{t('access_ENDED')}</p><a className={styles.secondary} href="/staff/subscription">{t('seePlans')}</a></div>;
  if (access.trialStatus === 'TRIAL_ACTIVE' && access.trialEndsAt) return <p className={styles.notice} data-onboarding-access="TRIAL">
    {t('trialEnds', { date: schoolTime(access.trialEndsAt, timezone, locale, true) })}</p>;
  return null;
}

function Summary({ answers, t }: { answers: OnboardingAnswers; t: T }): React.ReactElement {
  const list = (items: string[]) => items.length ? items.join(', ') : t('notAnswered');
  const disciplines = answers.disciplines.map((d) => d === 'OTHER' && answers.customDiscipline ? answers.customDiscipline : t(`dis_${d}`));
  const previous = answers.previousSoftware === 'OTHER' && answers.previousSoftwareOther ? answers.previousSoftwareOther : answers.previousSoftware ? t(`sw_${answers.previousSoftware}`) : null;
  return <dl className={styles.summary}>
    <dt>{t('summarySituation')}</dt><dd>{answers.situation ? t(`sit_${answers.situation}`) : t('notAnswered')}</dd>
    <dt>{t('summaryDisciplines')}</dt><dd>{list(disciplines)}</dd>
    <dt>{t('summaryGoals')}</dt><dd>{list(answers.goals.map((g) => t(`goal_${g}`)))}</dd>
    <dt>{t('summaryPath')}</dt><dd>{answers.path ? t(`path_${answers.path}`) : t('notAnswered')}</dd>
    {answers.path === 'SWITCHING' && <><dt>{t('summaryPrevious')}</dt><dd>{previous ?? t('notAnswered')}</dd>
      <dt>{t('summaryImports')}</dt><dd>{list(answers.importWishes.map((w) => t(`imp_${w}`)))}</dd></>}
  </dl>;
}

function WelcomeForm({ draft, t, locked, onDraft, onSave, onCancel }: { draft: OnboardingAnswers; t: T; locked: boolean; onDraft?: ((next: OnboardingAnswers) => void) | undefined;
  onSave?: (() => void) | undefined; onCancel?: (() => void) | undefined }): React.ReactElement {
  const set = (patch: Partial<OnboardingAnswers>) => onDraft?.({ ...draft, ...patch });
  const customBad = draft.disciplines.includes('OTHER') && textProblem(draft.customDiscipline);
  const otherBad = draft.path === 'SWITCHING' && draft.previousSoftware === 'OTHER' && textProblem(draft.previousSoftwareOther);
  return <form className={styles.form} onSubmit={(e) => { e.preventDefault(); if (!customBad && !otherBad) onSave?.(); }} data-onboarding-form>
    <fieldset className={styles.fieldset} disabled={locked}><legend>{t('q_situation')}</legend>
      <div className={styles.grid}>{ONBOARDING_SITUATIONS.map((s) => <label key={s} className={styles.check}>
        <input type="radio" name="situation" checked={draft.situation === s} onChange={() => set({ situation: s })} />{t(`sit_${s}`)}</label>)}</div>
    </fieldset>
    <fieldset className={styles.fieldset} disabled={locked}><legend>{t('q_disciplines')}</legend>
      <div className={styles.grid}>{ONBOARDING_DISCIPLINES.map((d) => <label key={d} className={styles.check}>
        <input type="checkbox" checked={draft.disciplines.includes(d)} onChange={(e) => set({ disciplines: toggle(draft.disciplines, d, e.target.checked) })} />{t(`dis_${d}`)}</label>)}</div>
      {draft.disciplines.includes('OTHER') && <label className={styles.field}>{t('customDiscipline')}
        <input maxLength={60} value={draft.customDiscipline ?? ''} aria-invalid={customBad} onChange={(e) => set({ customDiscipline: e.target.value })} /></label>}
      {customBad && <p className={styles.warnText} role="alert">{t('textProblem')}</p>}
    </fieldset>
    <fieldset className={styles.fieldset} disabled={locked}><legend>{t('q_goals')}</legend>
      <div className={styles.grid}>{ONBOARDING_GOALS.map((g) => <label key={g} className={styles.check}>
        <input type="checkbox" checked={draft.goals.includes(g)} onChange={(e) => set({ goals: toggle(draft.goals, g, e.target.checked) })} />{t(`goal_${g}`)}</label>)}</div>
    </fieldset>
    <fieldset className={styles.fieldset} disabled={locked}><legend>{t('q_path')}</legend>
      <div className={styles.grid}>{ONBOARDING_PATHS.map((p) => <label key={p} className={styles.check}>
        <input type="radio" name="path" checked={draft.path === p} onChange={() => set({ path: p })} />{t(`path_${p}`)}</label>)}</div>
    </fieldset>
    {draft.path === 'SWITCHING' && <>
      <fieldset className={styles.fieldset} disabled={locked}><legend>{t('q_previous')}</legend>
        <label className={styles.field}><span className={styles.meta}>{t('q_previous')}</span>
          <select value={draft.previousSoftware ?? ''} onChange={(e) => set({ previousSoftware: (e.target.value || null) as OnboardingAnswers['previousSoftware'] })}>
            <option value="">{t('choose')}</option>
            {ONBOARDING_PREVIOUS_SOFTWARE.map((s) => <option key={s} value={s}>{t(`sw_${s}`)}</option>)}
          </select></label>
        {draft.previousSoftware === 'OTHER' && <label className={styles.field}>{t('previousOther')}
          <input maxLength={60} value={draft.previousSoftwareOther ?? ''} aria-invalid={otherBad} onChange={(e) => set({ previousSoftwareOther: e.target.value })} /></label>}
        {otherBad && <p className={styles.warnText} role="alert">{t('textProblem')}</p>}
      </fieldset>
      <fieldset className={styles.fieldset} disabled={locked}><legend>{t('q_imports')}</legend>
        <div className={styles.grid}>{ONBOARDING_IMPORT_WISHES.map((w) => <label key={w} className={styles.check}>
          <input type="checkbox" checked={draft.importWishes.includes(w)} onChange={(e) => set({ importWishes: toggle(draft.importWishes, w, e.target.checked) })} />{t(`imp_${w}`)}</label>)}</div>
        <p className={styles.meta} data-onboarding-import-note>{t('importNote')}</p>
      </fieldset>
    </>}
    <div className={styles.row}>
      <button type="submit" className={styles.primary} disabled={locked || customBad || otherBad}>{locked ? t('saving') : t('save')}</button>
      {onCancel && <button type="button" className={styles.secondary} disabled={locked} onClick={onCancel}>{t('cancel')}</button>}
    </div>
  </form>;
}

function Step({ step, t, isNext, goals, locked, onSkip }: { step: OnboardingStep; t: T; isNext: boolean; goals: string[]; locked: boolean;
  onSkip?: ((key: OnboardingSkippableStep, skip: boolean) => void) | undefined }): React.ReactElement {
  const href = STEP_HREF[step.key];
  const showLink = href && step.status !== 'UNAVAILABLE' && step.status !== 'COMPLETE';
  return <li className={styles.step} data-step={step.key} data-status={step.status} data-next={isNext ? 'true' : undefined}>
    <div className={styles.stepMain}>
      <strong>{t(`step_${step.key}`)}</strong>
      <div className={styles.chips}>
        <span className={styles.chip} data-state={step.status}>{t(`st_${step.status}`)}</span>
        {step.optional && <span className={styles.chip}>{t('optional')}</span>}
        {step.skipped && <span className={styles.chip} data-kind="skipped">{t('skipped')}</span>}
        {step.count > 0 && step.key !== 'SCHOOL_DETAILS' && step.key !== 'WELCOME' && step.key !== 'INTERFACE' && <span className={styles.meta}>{t('found', { n: String(step.count) })}</span>}
      </div>
      {goals.length > 0 && step.status !== 'COMPLETE' && <span className={styles.meta}>{t('helpsWith', { goals: goals.join(', ') })}</span>}
    </div>
    <div className={styles.row}>
      {showLink && !step.skipped && <a className={isNext ? styles.primary : styles.secondary} href={href}>{t('open')}</a>}
      {canSkip(step) && step.status !== 'UNAVAILABLE' && <button type="button" className={styles.secondary} disabled={locked}
        onClick={() => onSkip?.(step.key as OnboardingSkippableStep, !step.skipped)}>{step.skipped ? t('unskip') : t('skip')}</button>}
    </div>
  </li>;
}

/** Pure view: everything shown is either the server's verified read or this person's unsaved draft. */
export function SchoolOnboardingView(p: SchoolOnboardingViewProps): React.ReactElement {
  const t: T = (key, vars) => onboardingText(p.language, key, vars);
  const head = <div className={styles.head}><div><h1>{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
    {p.read.state === 'READY' && <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onRefresh}>{t('refresh')}</button>}</div>;
  if (p.waiting) return <section className={styles.page}>{head}<p className={styles.meta} role="status">{t('waiting')}</p></section>;
  if (p.concealed) return <section className={styles.page}>{head}<p className={styles.notice}>{t('concealed')}</p></section>;
  if (!p.hasSchool) return <section className={styles.page}>{head}<p className={styles.notice}>{t('noSchool')}</p></section>;
  if (p.read.state !== 'READY') return <section className={styles.page}>{head}
    {p.read.state === 'LOADING' ? <p className={styles.meta} role="status">{t('loading')}</p>
      : <div className={styles.notice} role="alert"><p>{t(p.read.state === 'DENIED' ? 'denied' : 'unavailable')}</p>
        {p.read.state === 'UNAVAILABLE' && <button type="button" className={styles.secondary} onClick={p.onRefresh}>{t('refresh')}</button>}</div>}
  </section>;

  const o = p.read.onboarding, next = nextStep(o), progress = progressOf(o), saved = o.profile;
  const goalNames = (key: OnboardingStep['key']) => goalsForStep(key, saved?.goals ?? []).map((g) => t(`goal_${g}`));
  const outcome = p.outcome;
  // A skip saves the last-saved answers, so it waits while the welcome form is open and could hold unsaved changes.
  const formOpen = !saved || p.editing;
  return <section className={styles.page}>
    {head}
    <Access onboarding={o} t={t} locale={p.locale} />
    {outcome && outcome.kind !== 'SENDING' && <div className={`${styles.notice} ${outcome.kind === 'DONE' ? '' : styles.warn}`} role={outcome.kind === 'DONE' ? 'status' : 'alert'} data-onboarding-outcome={outcome.kind}>
      <p>{outcome.kind === 'DONE' ? t('saved') : t(`e_${outcome.kind}`)}</p>
      {p.canRetry && <button type="button" className={styles.primary} onClick={p.onTryAgain}>{t('tryAgain')}</button>}</div>}

    <div className={styles.card} data-onboarding-welcome>
      <div className={styles.cardHead}><h2>{t('welcomeTitle')}</h2>
        {saved && !p.editing && <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onEdit?.(true)}>{t('edit')}</button>}</div>
      {saved && !p.editing ? <Summary answers={saved} t={t} />
        : <WelcomeForm draft={p.draft} t={t} locked={p.locked} onDraft={p.onDraft} onSave={p.onSave} onCancel={saved ? () => p.onEdit?.(false) : undefined} />}
    </div>

    <div className={styles.card} data-onboarding-interface>
      <h2>{t('interfaceTitle')}</h2><p className={styles.meta}>{t('interfaceHelp')}</p>
      <div className={styles.modes}>{MODES.map((m) => <button key={m} type="button" className={styles.mode} aria-pressed={p.mode === m} disabled={p.modeState === 'SAVING'}
        onClick={() => p.onMode?.(m)} data-mode={m}><strong>{t(`mode_${m}` as OnboardingKey)}</strong><span>{t(`modeDetail_${m}` as OnboardingKey)}</span></button>)}</div>
      {p.modeState !== 'IDLE' && <p className={p.modeState === 'FAILED' ? styles.warnText : styles.meta} role="status">
        {t(p.modeState === 'SAVING' ? 'modeSaving' : p.modeState === 'SAVED' ? 'modeSaved' : 'modeFailed')}</p>}
      <h3>{t('languageTitle')}</h3>
      <div className={styles.tabs}>{LANGUAGES.map((l) => <button key={l} type="button" className={styles.tab} lang={l} aria-pressed={p.language === l}
        disabled={p.languageBlocked} onClick={() => p.onLanguage?.(l)}>{t(`lang_${l}`)}</button>)}</div>
    </div>

    <div className={styles.card} data-onboarding-checklist>
      <div className={styles.cardHead}><h2>{t('checklistTitle')}</h2>
        <span className={styles.meta}>{t('progress', { done: String(progress.done), total: String(progress.total) })}</span></div>
      <p data-onboarding-next>{next ? t('nextStep', { step: t(`step_${next.key}`) }) : t('allDone')}</p>
      <ol className={styles.steps}>{o.steps.map((s) => <Step key={s.key} step={s} t={t} isNext={next?.key === s.key} goals={goalNames(s.key)} locked={p.locked || formOpen} onSkip={p.onSkip} />)}</ol>
      <p className={styles.meta}>{t('checkedAt', { time: schoolTime(o.checkedAt, o.timezone, p.locale) })}</p>
      <p className={styles.meta}><a href="/staff/founder-setup">{t('founderGuide')}</a></p>
    </div>
  </section>;
}
