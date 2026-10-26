'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { A2P_FINDING_CODES, A2P_TEMPLATES, type A2pDraft, type A2pFinding, type A2pStatus, type A2pTemplate } from '@hon/contracts';
import { isTranslationKey, type HonInterfaceTheme, type TranslationKey } from '@hon/design-system';
import { useLocale } from '../localization/provider';
import { HonMark } from '../hon-command/hon-workspace-view';
import { A2P_REGISTRATION_STATUSES, A2P_STEPS, type A2pStep } from './contract';
import { CopyButton, HonAssistant, type A2pHonPrompt } from './a2p-registration-view';
import { A2P_DRAFT_ANSWER_KEYS, a2pLink } from './preparation-contract';
import {
  A2P_FACT_KEYS, A2P_FACT_LIMITS, A2P_URL_FACTS,
  type A2pFactKey, type A2pPreparationController, type A2pPrepSnapshot, type A2pPurpose,
} from './preparation-controller';
import styles from './a2p-registration.module.css';

type T = (key: TranslationKey, params?: Readonly<Record<string, string | number>>) => string;
const k = (value: string) => value as TranslationKey;
/** Closed server codes get their own copy; anything else is labelled generically rather than shown raw. */
const known = (t: T, prefix: string, code: string, fallback: string) => {
  const key = `${prefix}.${code}`;
  return isTranslationKey(key) ? t(key) : t(k(fallback), { code });
};

const STATUS_ORDER: readonly A2pStatus[] = ['NEEDS_FIX', 'REVIEW_REQUIRED', 'UNAVAILABLE', 'PASS'];
const STATUS_TONE: Record<A2pStatus, string> = { PASS: 'ready', NEEDS_FIX: 'blocked', REVIEW_REQUIRED: 'waiting', UNAVAILABLE: 'planned' };
type Filter = 'ALL' | A2pStatus;
const FACT_GROUPS: ReadonlyArray<{ id: string; keys: readonly A2pFactKey[] }> = [
  { id: 'school', keys: ['businessName', 'supportContact', 'messageFrequency'] },
  { id: 'pages', keys: ['websiteUrl', 'privacyUrl', 'termsUrl', 'optInUrl'] },
  { id: 'flow', keys: ['messageFlow'] },
];
const PURPOSES: readonly A2pPurpose[] = ['SERVICE_NOTIFICATIONS', 'MIXED', 'MARKETING'];
const PROMPTS: readonly A2pHonPrompt[] = [
  { id: 'website', step: 'FIX_WEBSITE' },
  { id: 'checkbox', step: 'FIX_WEBSITE', focus: 'a2p-check-CONSENT_OPTIONAL_UNCHECKED' },
  { id: 'samples', step: 'ANSWERS', focus: 'a2p-prep-purpose' },
  { id: 'reject', step: 'REVIEW', focus: 'a2p-prep-validation' },
  { id: 'final', step: 'REVIEW' },
];
const STATUS_GUIDE_TONE: Record<string, string> = { NOT_STARTED: 'planned', DRAFT: 'neutral', NEEDS_CORRECTION: 'waiting', SUBMITTED: 'neutral', UNDER_REVIEW: 'neutral', APPROVED: 'ready', REJECTED: 'blocked', UNKNOWN: 'planned' };

export interface A2pPreparationViewProps { controller: A2pPreparationController; snapshot: A2pPrepSnapshot; theme: HonInterfaceTheme; initialStep?: A2pStep }

export function A2pPreparationView({ controller, snapshot, theme, initialStep = 'CHECK_WEBSITE' }: A2pPreparationViewProps): React.ReactElement {
  const { t, date } = useLocale();
  const [step, setStep] = useState<A2pStep>(initialStep);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [navigation, setNavigation] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusTarget = useRef<string | null>(null);
  const index = A2P_STEPS.indexOf(step);
  const ready = snapshot.access.state === 'READY';

  useEffect(() => {
    if (!navigation) return;
    const target = focusTarget.current ? document.getElementById(focusTarget.current) : null;
    focusTarget.current = null;
    (target ?? heading.current)?.focus();
    target?.scrollIntoView({ block: 'center' });
  }, [navigation]);
  const go = (next: A2pStep, focus?: string) => { focusTarget.current = focus ?? null; setStep(next); setNavigation((value) => value + 1); };

  return (
    <main className={styles.page} data-interface-theme={theme} data-source="SERVER" aria-labelledby="a2p-title">
      <nav aria-label="Breadcrumb" className={styles.crumbs}>
        <ol>
          <li>{t('a2p.crumb.settings')}</li><li>{t('a2p.crumb.communications')}</li><li>{t('a2p.crumb.texting')}</li><li aria-current="page">{t('a2p.crumb.a2p')}</li>
        </ol>
      </nav>
      <header className={styles.header}>
        <div className={styles.headerText}>
          <p className={styles.kicker}>HON · {t('a2p.crumb.texting')}</p>
          <h1 id="a2p-title">{t('a2p.title')}</h1>
          <p className={styles.lede}>{t('a2p.prep.intro')}</p>
        </div>
        <a className={styles.honJump} href="#a2p-hon"><HonMark size="sm" />{t('a2p.hon.show')}</a>
      </header>
      <AccessBanner snapshot={snapshot} t={t} onRetry={() => { void controller.load(); }} />
      {snapshot.cleared && ready && (
        <div className={styles.notice} data-tone="waiting" role="status" data-testid="a2p-prep-cleared">
          {t(k(`a2p.prep.cleared.${snapshot.cleared}`))} <button type="button" className={styles.secondary} onClick={() => controller.dismissCleared()}>{t('a2p.prep.dismiss')}</button>
        </div>
      )}
      <div className={styles.layout}>
        <div className={styles.main}>
          <nav aria-label={t('a2p.steps.label')} className={styles.stepper}>
            <ol>
              {A2P_STEPS.map((value, position) => (
                <li key={value}>
                  <button type="button" aria-current={value === step ? 'step' : undefined} onClick={() => go(value)} data-done={stepDone(value, snapshot) || undefined}>
                    <span className={styles.stepNumber} aria-hidden="true">{position + 1}</span>
                    <span className={styles.stepText}><strong>{t(k(`a2p.step.${value}`))}</strong><small>{t(k(`a2p.prep.stepHint.${value}`))}</small></span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          <section className={styles.stepPanel} aria-labelledby="a2p-step-heading">
            <p className={styles.stepOf}>{t('a2p.stepOf', { n: index + 1, total: A2P_STEPS.length })}</p>
            <h2 id="a2p-step-heading" ref={heading} tabIndex={-1}>{step === 'ANSWERS' ? t('a2p.prep.draft.heading') : t(k(`a2p.step.${step}`))}</h2>
            {step === 'CHECK_WEBSITE' && <FactsStep controller={controller} snapshot={snapshot} t={t} onChecks={() => go('FIX_WEBSITE')} />}
            {step === 'FIX_WEBSITE' && <ChecksStep controller={controller} snapshot={snapshot} t={t} date={date} filter={filter} onFilter={setFilter} onFacts={() => go('CHECK_WEBSITE')} />}
            {step === 'ANSWERS' && <DraftStep controller={controller} snapshot={snapshot} t={t} />}
            {step === 'REVIEW' && <ReviewStep controller={controller} snapshot={snapshot} t={t} onDraft={() => go('ANSWERS')} />}
            {step === 'STATUS' && <StatusStep t={t} />}
            <div className={styles.stepNav}>
              {index > 0 && <button type="button" className={styles.secondary} onClick={() => go(A2P_STEPS[index - 1]!)}>← {t('a2p.back')}</button>}
              {index < A2P_STEPS.length - 1 && <button type="button" className={styles.primary} onClick={() => go(A2P_STEPS[index + 1]!)}>{t('a2p.next')} →</button>}
            </div>
          </section>
        </div>
        <HonAssistant t={t} prompts={PROMPTS} onPrompt={(prompt) => go(prompt.step, prompt.focus)} />
      </div>
      <footer className={styles.footer}>
        <p>{t('a2p.noSubmission')}</p>
        <p>{t('a2p.prep.notSaved')}</p>
        <p>{t('a2p.noGuarantee')}</p>
      </footer>
    </main>
  );
}

function stepDone(step: A2pStep, s: A2pPrepSnapshot): boolean {
  if (step === 'CHECK_WEBSITE') return s.review.phase === 'DONE';
  if (step === 'ANSWERS') return s.draft.result?.draft.state === 'DRAFT_FOR_OWNER_REVIEW';
  if (step === 'REVIEW') return s.copy.phase === 'DONE';
  return false;
}

function AccessBanner({ snapshot, t, onRetry }: { snapshot: A2pPrepSnapshot; t: T; onRetry: () => void }): React.ReactElement {
  const access = snapshot.access;
  if (access.state === 'LOADING') return <div className={styles.banner} data-tone="neutral" role="status"><span className={styles.spinner} aria-hidden="true" />{t('a2p.prep.loading')}</div>;
  if (access.state !== 'READY') {
    const tone = access.state === 'UNAVAILABLE' ? 'blocked' : 'waiting';
    return (
      <div className={styles.banner} data-tone={tone} role="alert" data-testid={`a2p-prep-${access.state}`}>
        <strong>{t(k(`a2p.prep.access.${access.state}.title`))}</strong><p>{t(k(`a2p.prep.access.${access.state}.body`))}</p>
        {access.state === 'UNAVAILABLE' && <button type="button" className={styles.secondary} onClick={onRetry}>{t('a2p.retry')}</button>}
      </div>
    );
  }
  return (
    <div className={styles.banner} data-tone="neutral" role="status" data-testid="a2p-prep-ready">
      <strong>{t('a2p.prep.ready.title', { school: access.scope.schoolName })}</strong>
      <p>{t('a2p.prep.ready.body')}</p>
      <p className={styles.meta} data-testid="a2p-prep-authority">{access.scope.canConfirmOwnerFacts ? t('a2p.prep.authority.owner') : t('a2p.prep.authority.staff')}</p>
    </div>
  );
}

type StepProps = { controller: A2pPreparationController; snapshot: A2pPrepSnapshot; t: T };

function ErrorLine({ kind, t }: { kind: string | null; t: T }): React.ReactElement | null {
  return kind ? <p className={styles.error} role="alert">{known(t, 'a2p.prep.error', kind, 'a2p.prep.error.OTHER')}</p> : null;
}

function FactField({ name, controller, snapshot, t }: StepProps & { name: A2pFactKey }): React.ReactElement {
  const id = `a2p-fact-${name}`, help = `${id}-help`, err = `${id}-error`;
  const error = snapshot.factErrors[name];
  const url = A2P_URL_FACTS.includes(name);
  const common = {
    id, value: snapshot.facts[name], maxLength: A2P_FACT_LIMITS[name], disabled: snapshot.access.state !== 'READY', spellCheck: !url,
    'aria-invalid': error ? true : undefined, 'aria-describedby': `${help}${error ? ` ${err}` : ''}`,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => controller.setFact(name, event.target.value),
  } as const;
  return (
    <div className={styles.field}>
      <div className={styles.fieldHead}><label htmlFor={id}>{t(k(`a2p.prep.fact.${name}`))}{name === 'websiteUrl' ? ` (${t('a2p.prep.required')})` : ''}</label></div>
      {name === 'messageFlow' ? <textarea rows={5} {...common} /> : <input type={url ? 'url' : 'text'} inputMode={url ? 'url' : undefined} autoComplete="off" {...common} />}
      <p id={help} className={styles.meta}>{t(k(`a2p.prep.factHelp.${name}`))}{name === 'messageFlow' && <> · {t('a2p.answers.chars', { count: snapshot.facts.messageFlow.length })}</>}</p>
      {error && <p id={err} className={styles.error} role="alert">{t(k(`a2p.prep.factError.${error}`))}</p>}
    </div>
  );
}

function FactsStep({ controller, snapshot, t, onChecks }: StepProps & { onChecks: () => void }): React.ReactElement {
  const review = snapshot.review;
  const ready = snapshot.access.state === 'READY';
  return (
    <>
      <p className={styles.lede}>{t('a2p.prep.facts.lede')}</p>
      <p className={styles.notice} data-tone="waiting" data-testid="a2p-prep-inspection-off">{t('a2p.prep.facts.noCrawl')}</p>
      <form onSubmit={(event) => { event.preventDefault(); void controller.reviewWebsite(); }} noValidate>
        {FACT_GROUPS.map((group) => (
          <fieldset key={group.id} className={styles.group}>
            <legend>{t(k(`a2p.prep.factGroup.${group.id}`))}</legend>
            {group.keys.map((name) => <FactField key={name} name={name} controller={controller} snapshot={snapshot} t={t} />)}
          </fieldset>
        ))}
        <p className={styles.meta}>{t('a2p.prep.facts.statements')}</p>
        <div className={styles.toolbar}>
          <button type="submit" className={styles.primary} disabled={!ready || review.phase === 'WORKING'}>{review.phase === 'WORKING' ? t('a2p.prep.review.working') : review.phase === 'DONE' ? t('a2p.prep.review.again') : t('a2p.prep.review.start')}</button>
        </div>
      </form>
      {review.phase === 'WORKING' && <p className={styles.meta} role="status"><span className={styles.spinner} aria-hidden="true" />{t('a2p.prep.review.working')}</p>}
      <ErrorLine kind={review.error} t={t} />
      {review.result && (
        <section className={styles.summary} aria-labelledby="a2p-prep-summary" data-testid="a2p-prep-summary">
          <h3 id="a2p-prep-summary">{t('a2p.prep.review.summary', { count: review.result.review.findings.length })}</h3>
          <InspectionNotice inspection={review.result.review.inspection} t={t} />
          <ul className={styles.tiles}>
            {STATUS_ORDER.map((status) => <li key={status} data-tone={STATUS_TONE[status]}><strong>{review.result!.review.findings.filter((f) => f.status === status).length}</strong><span>{t(k(`a2p.prep.status.${status}`))}</span></li>)}
          </ul>
          <p className={styles.meta}>{t('a2p.prep.review.noApproval')}</p>
          <button type="button" className={styles.primary} onClick={onChecks}>{t('a2p.prep.review.seeChecks')} →</button>
        </section>
      )}
    </>
  );
}

function InspectionNotice({ inspection, t }: { inspection: 'LIVE_INSPECTION_DISABLED' | 'SYNTHETIC_FIXTURE'; t: T }): React.ReactElement {
  return inspection === 'SYNTHETIC_FIXTURE'
    ? <p className={styles.notice} data-tone="synthetic" role="status" data-testid="a2p-prep-inspection-fixture">{t('a2p.prep.inspection.fixture')}</p>
    : <p className={styles.notice} data-tone="waiting" role="status" data-testid="a2p-prep-inspection-disabled">{t('a2p.prep.inspection.disabled')}</p>;
}

function ChecksStep({ controller, snapshot, t, date, filter, onFilter, onFacts }: StepProps & { date: (value: string) => string; filter: Filter; onFilter: (value: Filter) => void; onFacts: () => void }): React.ReactElement {
  const result = snapshot.review.result;
  if (!result) {
    return (
      <>
        <p className={styles.lede}>{t('a2p.prep.checks.lede')}</p>
        <p className={styles.empty}>{t('a2p.prep.checks.none')}</p>
        <button type="button" className={styles.secondary} onClick={onFacts}>{t('a2p.prep.review.start')}</button>
        <ol className={styles.findings} aria-label={t('a2p.prep.checks.listLabel')}>
          {A2P_FINDING_CODES.map((code) => <li key={code}><article className={styles.finding} data-outcome="UNAVAILABLE"><h3>{t(k(`a2p.prep.code.${code}.title`))}</h3><p className={styles.meta}>{t(k(`a2p.prep.code.${code}.looksFor`))}</p></article></li>)}
        </ol>
      </>
    );
  }
  const findings = [...result.review.findings].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
  const shown = filter === 'ALL' ? findings : findings.filter((f) => f.status === filter);
  return (
    <>
      <p className={styles.lede}>{t('a2p.prep.checks.lede')}</p>
      <InspectionNotice inspection={result.review.inspection} t={t} />
      <div className={styles.filters} role="group" aria-label={t('a2p.fix.filter')}>
        {(['ALL', ...STATUS_ORDER] as const).map((value) => {
          const n = value === 'ALL' ? findings.length : findings.filter((f) => f.status === value).length;
          return <button key={value} type="button" aria-pressed={filter === value} onClick={() => onFilter(value)} data-tone={value === 'ALL' ? undefined : STATUS_TONE[value]}>{value === 'ALL' ? t('a2p.fix.filter.ALL') : t(k(`a2p.prep.status.${value}`))} <span>{n}</span></button>;
        })}
      </div>
      <p className={styles.meta} role="status">{t('a2p.prep.checks.count', { count: shown.length, total: findings.length })}</p>
      <ol className={styles.findings} data-testid="a2p-prep-checks">
        {shown.map((finding) => <li key={finding.code}><CheckCard finding={finding} controller={controller} snapshot={snapshot} t={t} date={date} /></li>)}
      </ol>
    </>
  );
}

function CheckCard({ finding, controller, snapshot, t, date }: StepProps & { finding: A2pFinding; date: (value: string) => string }): React.ReactElement {
  const sources = snapshot.review.result?.review.sources.filter((source) => finding.sourceIds.includes(source.id)) ?? [];
  const details = snapshot.details?.code === finding.code ? snapshot.details : null;
  const same = details?.result ? JSON.stringify(details.result.finding) === JSON.stringify(finding) : null;
  return (
    <article className={styles.finding} data-outcome={finding.status} data-code={finding.code} aria-labelledby={`a2p-check-${finding.code}`}>
      <header>
        <span className={styles.badge} data-tone={STATUS_TONE[finding.status]}>{t(k(`a2p.prep.status.${finding.status}`))}</span>
        <span className={styles.area}>{finding.code}</span>
      </header>
      <h3 id={`a2p-check-${finding.code}`} tabIndex={-1}>{t(k(`a2p.prep.code.${finding.code}.title`))}</h3>
      <dl className={styles.facts}>
        <div><dt>{t('a2p.prep.check.looksFor')}</dt><dd>{t(k(`a2p.prep.code.${finding.code}.looksFor`))}</dd></div>
        <div><dt>{t('a2p.prep.check.result')}</dt><dd>{known(t, 'a2p.prep.reason', finding.reason, 'a2p.prep.reason.OTHER')}</dd></div>
        <div><dt>{t('a2p.prep.check.fix')} <span className={styles.badge} data-tone="neutral">{t('a2p.prep.english')}</span></dt><dd lang="en">{finding.remediation}</dd></div>
      </dl>
      <div>
        <p className={styles.label}>{t('a2p.prep.check.evidence')}</p>
        {finding.evidence.length === 0 ? <p className={styles.meta} data-testid="a2p-prep-no-evidence">{t('a2p.prep.check.noEvidence')}</p> : (
          <ul className={styles.compactList}>
            {finding.evidence.map((e) => (
              <li key={e.id}>
                <span className={styles.badge} data-tone="synthetic">{t('a2p.prep.check.fixtureEvidence')}</span>{' '}
                <span lang="en">{e.excerpt}</span>
                <span className={styles.meta}> · {e.url} · {t('a2p.prep.check.fixtureTime', { time: date(e.observedAt) })}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className={styles.label}>{t('a2p.prep.check.sources')}</p>
        <ul className={styles.compactList}>
          {sources.map((source) => {
            const href = a2pLink(source.url);
            return <li key={source.id}>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{known(t, 'a2p.prep.source', source.id, 'a2p.prep.source.OTHER')} ↗</a> : source.id}<span className={styles.meta}> · {t('a2p.prep.check.reviewedOn', { date: source.reviewedOn })}</span></li>;
          })}
        </ul>
      </div>
      <footer className={styles.findingFoot}>
        <button type="button" className={styles.secondary} disabled={snapshot.details?.phase === 'WORKING'} onClick={() => { void controller.findingDetails(finding.code); }}>
          {details?.phase === 'WORKING' ? t('a2p.prep.check.detailsWorking') : t('a2p.prep.check.details')}
        </button>
        {details?.phase === 'DONE' && <span className={same ? styles.meta : styles.warning} role="status">{same ? t('a2p.prep.check.detailsSame') : t('a2p.prep.check.detailsDifferent')}</span>}
        <ErrorLine kind={details?.error ?? null} t={t} />
        <span className={styles.meta}>{t('a2p.prep.check.noMark')}</span>
      </footer>
    </article>
  );
}

function DraftStep({ controller, snapshot, t }: StepProps): React.ReactElement {
  const ready = snapshot.access.state === 'READY' ? snapshot.access : null;
  const canConfirm = ready?.scope.canConfirmOwnerFacts === true;
  const promotional = snapshot.templates.includes('PROMOTIONAL');
  const confirmId = useId();
  const result = snapshot.draft.result;
  return (
    <>
      <p className={styles.lede}>{t('a2p.prep.draft.lede')}</p>
      <fieldset className={styles.group} id="a2p-prep-purpose" tabIndex={-1}>
        <legend>{t('a2p.prep.purpose.legend')}</legend>
        {PURPOSES.map((purpose) => (
          <label key={purpose} className={styles.choice}>
            <input type="radio" name="a2p-purpose" value={purpose} checked={snapshot.purpose === purpose} disabled={!ready} onChange={() => controller.setPurpose(purpose)} />
            <span><strong>{t(k(`a2p.prep.purpose.${purpose}`))}</strong><small>{t(k(`a2p.prep.purposeHelp.${purpose}`))}</small></span>
          </label>
        ))}
        <p className={styles.meta}>{t('a2p.prep.purpose.note')}</p>
      </fieldset>
      <fieldset className={styles.group}>
        <legend>{t('a2p.prep.templates.legend')}</legend>
        {A2P_TEMPLATES.map((template: A2pTemplate) => {
          const locked = (snapshot.purpose === 'SERVICE_NOTIFICATIONS' && template === 'PROMOTIONAL') || (snapshot.purpose === 'MARKETING' && template !== 'PROMOTIONAL');
          return (
            <label key={template} className={styles.choice}>
              <input type="checkbox" checked={snapshot.templates.includes(template)} disabled={!ready || locked} onChange={() => controller.toggleTemplate(template)} />
              <span><strong>{t(k(`a2p.prep.template.${template}`))}</strong></span>
            </label>
          );
        })}
        <p className={styles.meta}>{t(k(`a2p.prep.templates.rule.${snapshot.purpose}`))}</p>
        {snapshot.campaignError && <p className={styles.error} role="alert">{t(k(`a2p.prep.campaignError.${snapshot.campaignError}`))}</p>}
      </fieldset>
      {promotional && (
        <fieldset className={styles.group}>
          <legend>{t('a2p.prep.consent.legend')}</legend>
          {(['SEPARATE_CONFIRMED', 'NOT_CONFIRMED'] as const).map((value) => (
            <label key={value} className={styles.choice}>
              <input type="radio" name="a2p-consent" checked={snapshot.marketingConsent === value} disabled={!ready} onChange={() => controller.setMarketingConsent(value)} />
              <span><strong>{t(k(`a2p.prep.consent.${value}`))}</strong></span>
            </label>
          ))}
          <p className={styles.meta}>{t('a2p.prep.consent.note')}</p>
        </fieldset>
      )}
      <section className={styles.confirmations} aria-labelledby="a2p-prep-attest">
        <h3 id="a2p-prep-attest">{t('a2p.prep.attest.heading')}</h3>
        <label className={styles.choice} htmlFor={confirmId}>
          <input id={confirmId} type="checkbox" checked={snapshot.ownerConfirmed} disabled={!canConfirm} onChange={(event) => controller.setOwnerConfirmed(event.target.checked)} data-testid="a2p-prep-attest" />
          <span><strong>{t('a2p.prep.attest.label')}</strong><small>{t('a2p.prep.attest.note')}</small></span>
        </label>
        {!canConfirm && <p className={styles.notice} data-tone="planned" data-testid="a2p-prep-attest-unavailable">{t('a2p.prep.attest.notOwner')}</p>}
      </section>
      <div className={styles.toolbar}>
        <button type="button" className={styles.primary} disabled={!ready || snapshot.draft.phase === 'WORKING'} onClick={() => { void controller.generateDraft(); }}>
          {snapshot.draft.phase === 'WORKING' ? t('a2p.prep.draft.working') : result ? t('a2p.prep.draft.again') : t('a2p.prep.draft.start')}
        </button>
        <span className={styles.badge} data-tone="neutral">{t('a2p.prep.englishOnly')}</span>
      </div>
      {snapshot.draft.phase === 'WORKING' && <p className={styles.meta} role="status"><span className={styles.spinner} aria-hidden="true" />{t('a2p.prep.draft.working')}</p>}
      <ErrorLine kind={snapshot.draft.error} t={t} />
      {result && <DraftResult draft={result.draft} t={t} />}
    </>
  );
}

function CodeList({ codes, prefix, t, testId }: { codes: readonly string[]; prefix: 'missing' | 'warning'; t: T; testId: string }): React.ReactElement {
  return <ul className={styles.compactList} data-testid={testId}>{codes.map((code) => <li key={code} data-tone={prefix === 'missing' ? 'blocked' : 'waiting'}>{prefix === 'missing' ? '○' : '⚠'} {known(t, `a2p.prep.${prefix}`, code, `a2p.prep.${prefix}.OTHER`)}</li>)}</ul>;
}

function DraftResult({ draft, t }: { draft: A2pDraft; t: T }): React.ReactElement {
  const ready = draft.state === 'DRAFT_FOR_OWNER_REVIEW';
  return (
    <section className={styles.reviewBlock} aria-labelledby="a2p-prep-draft-result" data-testid="a2p-prep-draft">
      <div className={styles.rowBetween}>
        <h3 id="a2p-prep-draft-result">{t('a2p.prep.draft.result')}</h3>
        <span className={styles.badge} data-tone={ready ? 'neutral' : 'waiting'}>{t(k(`a2p.prep.draftState.${draft.state}`))}</span>
      </div>
      <p className={styles.meta}>{t('a2p.prep.draft.provenance')}</p>
      {draft.missingFields.length > 0 && <><p className={styles.label}>{t('a2p.prep.missingHeading')}</p><CodeList codes={draft.missingFields} prefix="missing" t={t} testId="a2p-prep-missing" /></>}
      <p className={styles.label}>{t('a2p.prep.warningHeading')}</p>
      <CodeList codes={draft.warnings} prefix="warning" t={t} testId="a2p-prep-warnings" />
      {draft.answers && (
        <dl className={styles.answerList}>
          {A2P_DRAFT_ANSWER_KEYS.map((key) => {
            const value = draft.answers![key], label = t(k(`a2p.prep.answer.${key}`));
            return <div key={key}><dt>{label} <span className={styles.badge} data-tone="waiting">{t('a2p.provenance.UNVERIFIED_DRAFT')}</span></dt><dd><span className={styles.wording} lang="en">{value}</span><CopyButton text={value} label={label} t={t} /></dd></div>;
          })}
          {draft.sampleMessages.map((sample, n) => {
            const label = t('a2p.prep.answer.sample', { n: n + 1, template: t(k(`a2p.prep.template.${sample.template}`)) });
            return <div key={`${sample.template}-${n}`}><dt>{label}</dt><dd><span className={styles.wording} lang="en">{sample.content}</span><CopyButton text={sample.content} label={label} t={t} /></dd></div>;
          })}
          {draft.helpResponseSample && <div><dt>{t('a2p.prep.answer.help')}</dt><dd><span className={styles.wording} lang="en">{draft.helpResponseSample}</span><CopyButton text={draft.helpResponseSample} label={t('a2p.prep.answer.help')} t={t} /></dd></div>}
          {draft.stopResponseSample && <div><dt>{t('a2p.prep.answer.stop')}</dt><dd><span className={styles.wording} lang="en">{draft.stopResponseSample}</span><CopyButton text={draft.stopResponseSample} label={t('a2p.prep.answer.stop')} t={t} /></dd></div>}
        </dl>
      )}
      <p className={styles.warning}>{t('a2p.prep.notSaved')}</p>
    </section>
  );
}

function ReviewStep({ controller, snapshot, t, onDraft }: StepProps & { onDraft: () => void }): React.ReactElement {
  const ready = snapshot.access.state === 'READY' ? snapshot.access : null;
  const validation = snapshot.validation.result;
  const digest = controller.copyDigest();
  const ackId = useId();
  const copy = snapshot.copy.result;
  return (
    <>
      <p className={styles.lede}>{t('a2p.prep.final.lede')}</p>
      <section className={styles.readiness} aria-labelledby="a2p-prep-validation-heading">
        <div className={styles.rowBetween}>
          <h3 id="a2p-prep-validation-heading"><span id="a2p-prep-validation" tabIndex={-1}>{t('a2p.prep.final.validation')}</span></h3>
          <button type="button" className={styles.primary} disabled={!ready || snapshot.validation.phase === 'WORKING'} onClick={() => { void controller.validateDraft(); }}>
            {snapshot.validation.phase === 'WORKING' ? t('a2p.prep.final.working') : t('a2p.prep.final.check')}
          </button>
        </div>
        <ErrorLine kind={snapshot.validation.error} t={t} />
        {!validation ? <p className={styles.empty}>{t('a2p.prep.final.notChecked')}</p> : (
          <div data-testid="a2p-prep-validation-result">
            <p className={styles.readinessLabel}>{validation.validation.readyForCopyPreparation ? t('a2p.prep.final.readyForCopy') : t('a2p.prep.final.needsInput')}</p>
            <ul className={styles.counts}>
              <li><strong>{validation.validation.missingFields.length}</strong><span>{t('a2p.prep.final.missingCount')}</span></li>
              <li><strong>{validation.validation.warnings.length}</strong><span>{t('a2p.prep.final.warningCount')}</span></li>
            </ul>
            <dl className={styles.facts}>
              <div><dt>{t('a2p.prep.final.eligibility')}</dt><dd>{t('a2p.prep.final.NOT_VERIFIED')}</dd></div>
              <div><dt>{t('a2p.prep.final.approval')}</dt><dd>{t('a2p.prep.final.NOT_REQUESTED')}</dd></div>
            </dl>
            {validation.validation.missingFields.length > 0 && <><CodeList codes={validation.validation.missingFields} prefix="missing" t={t} testId="a2p-prep-validation-missing" /><button type="button" className={styles.secondary} onClick={onDraft}>{t('a2p.prep.final.goDraft')}</button></>}
            <p className={styles.label}>{t('a2p.prep.warningHeading')}</p>
            <CodeList codes={validation.validation.warnings} prefix="warning" t={t} testId="a2p-prep-validation-warnings" />
          </div>
        )}
      </section>
      <section className={styles.reviewBlock} aria-labelledby="a2p-prep-copy-heading">
        <h3 id="a2p-prep-copy-heading">{t('a2p.prep.copy.heading')}</h3>
        <p className={styles.meta}>{t('a2p.prep.copy.lede')}</p>
        <label className={styles.choice} htmlFor={ackId}>
          <input id={ackId} type="checkbox" checked={snapshot.copyAcknowledged} disabled={!digest} onChange={(event) => controller.setCopyAcknowledged(event.target.checked)} data-testid="a2p-prep-copy-ack" />
          <span><strong>{t('a2p.prep.copy.ack')}</strong></span>
        </label>
        <div className={styles.exportBar}>
          <button type="button" className={styles.primary} disabled={!digest || !snapshot.copyAcknowledged || snapshot.copy.phase === 'WORKING'} onClick={() => { void controller.prepareCopy(); }}>
            {snapshot.copy.phase === 'WORKING' ? t('a2p.prep.copy.working') : t('a2p.prep.copy.prepare')}
          </button>
          {!digest && <p className={styles.meta} data-testid="a2p-prep-copy-locked">{t('a2p.prep.copy.locked')}</p>}
        </div>
        <ErrorLine kind={snapshot.copy.error} t={t} />
        {copy && (
          <div data-testid="a2p-prep-copy-result">
            <pre className={styles.wording} lang="en" tabIndex={0} aria-label={t('a2p.prep.copy.text')}>{copy.content}</pre>
            <div className={styles.actions}>
              <CopyButton text={copy.content} label={t('a2p.prep.copy.text')} t={t} />
              <button type="button" className={styles.secondary} onClick={() => downloadText(copy.content, copy.filename)}>⤓ {t('a2p.prep.copy.download', { file: copy.filename })}</button>
            </div>
            <p className={styles.meta}>{t('a2p.prep.copy.after')}</p>
          </div>
        )}
      </section>
      <div className={styles.exportBar}>
        <button type="button" className={styles.secondary} disabled aria-describedby="a2p-submit-note">{t('a2p.review.submit')}</button>
        <p id="a2p-submit-note" className={styles.meta}>{t('a2p.review.submitNote')} {t('a2p.noGuarantee')}</p>
      </div>
    </>
  );
}

function downloadText(content: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function StatusStep({ t }: { t: T }): React.ReactElement {
  return (
    <>
      <p className={styles.lede}>{t('a2p.status.lede')}</p>
      <section className={styles.statusCard} aria-labelledby="a2p-status-current" data-state="UNAVAILABLE">
        <h3 id="a2p-status-current">{t('a2p.status.current')}</h3>
        <div data-testid="a2p-status-unavailable"><p className={styles.statusValue}><span className={styles.badge} data-tone="planned">{t('a2p.status.unavailable.title')}</span></p><p className={styles.meta}>{t('a2p.prep.statusStep.unavailable')}</p></div>
      </section>
      <section className={styles.statusGuide} aria-labelledby="a2p-status-guide">
        <h3 id="a2p-status-guide">{t('a2p.status.guide')}</h3>
        <dl>{A2P_REGISTRATION_STATUSES.map((status) => <div key={status}><dt><span className={styles.badge} data-tone={STATUS_GUIDE_TONE[status]}>{t(k(`a2p.status.${status}`))}</span></dt><dd>{t(k(`a2p.statusDetail.${status}`))}</dd></div>)}</dl>
      </section>
    </>
  );
}
