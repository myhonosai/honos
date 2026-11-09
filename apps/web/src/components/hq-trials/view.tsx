import React from 'react';
import type { TrialCampaignDefinition, TrialCampaignVersion, TrialGovernanceView, TrialPolicyDecision, TrialPolicyTerms, TrialPolicyVersion, TrialPublication,
  TrialPublicationPreview } from '@hon/contracts';
import { trialsText, type TrialsKey } from './copy';
import { dollars } from './http';
import styles from './hq-trials.module.css';

type T = (key: TrialsKey, vars?: Record<string, string>) => string;
export type ReadState<V> = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; view: V };
export type PreviewState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE'; versionId: string } | { state: 'READY'; versionId: string; preview: TrialPublicationPreview };

const BLOCKERS = new Set(['CAMPAIGN_VERSION_STALE', 'CAMPAIGN_ALREADY_PUBLISHED', 'TRIAL_POLICY_REQUIRED', 'ENROLLMENT_WINDOW_ENDED', 'DURATION_NOT_ALLOWED',
  'CAPABILITY_PROFILE_NOT_ALLOWED', 'ELIGIBILITY_NOT_ALLOWED', 'LINK_MODE_NOT_ALLOWED', 'TERMS_REFERENCE_MISMATCH', 'CAPACITY_EXCEEDS_POLICY',
  'ENROLLMENT_WINDOW_EXCEEDS_POLICY', 'PROMOTIONAL_METADATA_NOT_ALLOWED', 'PROMOTIONAL_METADATA_EXCEEDS_POLICY', 'AGGREGATE_CAPACITY_EXCEEDS_POLICY',
  'AGGREGATE_PROMOTIONAL_METADATA_EXCEEDS_POLICY']);
const moment = (language: string, value: string) => new Date(value).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
const num = (language: string, n: number) => n.toLocaleString(language);

/** Where the trial rules stand now: the decision with the highest revision is the current one. */
export type RuleState = { kind: 'NONE' } | { kind: 'IN_FORCE' | 'NOT_YET' | 'EXPIRED'; decision: TrialPolicyDecision; version: number | null }
  | { kind: 'WITHDRAWN' | 'REVOKED'; decision: TrialPolicyDecision };
export function ruleState(view: TrialGovernanceView, now: number): RuleState {
  const decision = view.policyDecisions.reduce<TrialPolicyDecision | null>((best, d) => !best || d.revision > best.revision ? d : best, null);
  if (!decision) return { kind: 'NONE' };
  if (decision.decision !== 'APPROVED') return { kind: decision.decision, decision };
  const version = view.policyVersions.find((v) => v.policyId.toLowerCase() === decision.policyId.toLowerCase())?.version ?? null;
  const from = Date.parse(decision.validFrom), until = Date.parse(decision.validUntil);
  return { kind: now < from ? 'NOT_YET' : now >= until ? 'EXPIRED' : 'IN_FORCE', decision, version };
}

/** One campaign: its newest version and where publication stands, from the governance read only. */
export type CampaignRow = Readonly<{ campaignId: string; latest: TrialCampaignVersion; versions: TrialCampaignVersion[]; publications: TrialPublication[];
  status: 'DRAFT' | 'PUBLISHED' | 'WITHDRAWN'; publishedVersion: number | null }>;
export function campaignsOf(view: TrialGovernanceView): CampaignRow[] {
  const groups = new Map<string, { versions: TrialCampaignVersion[]; publications: TrialPublication[] }>();
  const group = (id: string) => { const key = id.toLowerCase(); let g = groups.get(key); if (!g) { g = { versions: [], publications: [] }; groups.set(key, g); } return g; };
  for (const v of view.campaignVersions) group(v.campaignId).versions.push(v);
  for (const p of view.publications) group(p.campaignId).publications.push(p);
  const rows: CampaignRow[] = [];
  for (const [campaignId, g] of groups) {
    // A publication whose version is not in this read (beyond the latest 100) is not shown as a campaign of its own.
    if (g.versions.length === 0) continue;
    const versions = [...g.versions].sort((a, b) => b.version - a.version), publications = [...g.publications].sort((a, b) => b.revision - a.revision);
    const last = publications[0];
    const publishedVersion = last?.kind === 'PUBLISHED' ? versions.find((v) => v.versionId.toLowerCase() === last.versionId.toLowerCase())?.version ?? null : null;
    rows.push({ campaignId, latest: versions[0]!, versions, publications, status: !last ? 'DRAFT' : last.kind, publishedVersion });
  }
  return rows.sort((a, b) => Date.parse(b.latest.recordedAt) - Date.parse(a.latest.recordedAt));
}

function Notice({ state, t, onRefresh }: { state: { state: string }; t: T; onRefresh?: (() => void) | undefined }) {
  if (state.state === 'LOADING') return <p className={styles.meta} role="status">{t('loading')}</p>;
  if (state.state === 'DENIED') return <p className={styles.notice} role="status">{t('denied')}</p>;
  return <div className={styles.notice} role="status"><p>{t('unavailable')}</p>{onRefresh ? <button type="button" className={styles.secondary} onClick={onRefresh}>{t('refresh')}</button> : null}</div>;
}
function Terms({ terms, language, t }: { terms: TrialPolicyTerms; language: string; t: T }) {
  const promo = terms.promotionalLimits;
  return <dl className={styles.facts}>
    <div><dt>{t('durations')}</dt><dd>{terms.allowedDurationsDays.map((n) => t('days', { n: String(n) })).join(', ')}</dd></div>
    <div><dt>{t('profiles')}</dt><dd>{terms.allowedCapabilityProfiles.map((p) => t(`p_${p}` as TrialsKey)).join(', ')}</dd></div>
    <div><dt>{t('eligibility')}</dt><dd>{terms.allowedEligibilityCodes.map((e) => t(`el_${e}` as TrialsKey)).join(', ')}</dd></div>
    <div><dt>{t('linkModes')}</dt><dd>{terms.allowedLinkModes.map((m) => t(`lm_${m}` as TrialsKey)).join(', ')}</dd></div>
    <div><dt>{t('capacity')}</dt><dd>{num(language, terms.maxEnrollmentCapacity)}</dd></div>
    <div><dt>{t('totalCapacity')}</dt><dd>{num(language, terms.maxTotalEnrollmentCapacity)}</dd></div>
    <div><dt>{t('window')}</dt><dd>{t('days', { n: num(language, terms.maxEnrollmentWindowDays) })}</dd></div>
    <div><dt>{t('maxCampaigns')}</dt><dd>{num(language, terms.maxPublishedCampaigns)}</dd></div>
    <div><dt>{t('terms')}</dt><dd><code>{terms.termsReference}</code></dd></div>
    <div><dt>{t('promoLimits')}</dt><dd>{promo ? t('promoLimitRow', { credits: num(language, promo.maxCreditsPerEnrollment), expiry: String(promo.maxCreditExpiryDays),
      daily: num(language, promo.maxDailyCreditCap), request: num(language, promo.maxPerRequestCreditCap), cost: dollars(language, promo.maxCampaignCostMinor),
      total: dollars(language, promo.maxTotalCampaignCostMinor) }) : t('noPromo')}</dd></div>
  </dl>;
}
function Definition({ d, language, t }: { d: TrialCampaignDefinition; language: string; t: T }) {
  const b = d.promotionalBudget;
  return <dl className={styles.facts}>
    <div><dt>{t('trialLabel')}</dt><dd>{t(`p_${d.capabilityProfile}` as TrialsKey)} · {t('length', { n: String(d.durationDays) })}</dd></div>
    <div><dt>{t('eligibility')}</dt><dd>{t(`el_${d.eligibility}` as TrialsKey)} · {t(`lm_${d.linkMode}` as TrialsKey)}</dd></div>
    <div><dt>{t('schoolsLabel')}</dt><dd>{t('maxSchools', { n: num(language, d.maximumEnrollments) })}</dd></div>
    <div><dt>{t('enrollLabel')}</dt><dd>{moment(language, d.enrollmentOpensAt)} – {moment(language, d.enrollmentClosesAt)}</dd></div>
    <div><dt>{t('terms')}</dt><dd><code>{d.termsReference}</code></dd></div>
    <div><dt>{t('budget')}</dt><dd>{b ? t('budgetRow', { credits: num(language, b.creditsPerEnrollment), expiry: String(b.creditExpiryDays), daily: num(language, b.dailyCreditCap),
      request: num(language, b.perRequestCreditCap), cost: dollars(language, b.maximumCampaignCostMinor) }) : t('noBudget')}</dd></div>
  </dl>;
}
function Readiness({ state, version, language, t }: { state: PreviewState; version: number; language: string; t: T }) {
  if (state.state === 'LOADING') return <p className={styles.meta} role="status">{t('checking')}</p>;
  if (state.state === 'DENIED') return <p className={styles.notice} role="status">{t('checkDenied')}</p>;
  if (state.state !== 'READY') return <p className={styles.notice} role="status">{t('checkFailed')}</p>;
  const p = state.preview;
  return <div className={`${styles.notice} ${p.ready ? styles.ok : styles.warn}`} role="status" data-testid="trial-readiness">
    {p.ready ? <p>{t('ready', { version: String(version) })}</p> : <>
      <p>{t('notReady', { version: String(version) })}</p>
      <ul className={styles.plain}>{p.blockers.map((b) => <li key={b}>{BLOCKERS.has(b) ? t(`b_${b}` as TrialsKey) : t('b_OTHER', { code: b })}</li>)}</ul>
    </>}
    <p>{t('exposure', { n: num(language, p.plannedExposure.enrollments), cost: dollars(language, p.plannedExposure.promotionalCostMinor) })}</p>
    <p className={styles.meta}>{t('asOf', { time: moment(language, p.asOf) })}</p>
  </div>;
}

export type TrialsViewProps = Readonly<{
  language: string; concealed: boolean; governance: ReadState<TrialGovernanceView>; now: number; preview: PreviewState | null;
  onRefresh?: (() => void) | undefined; onCheck?: ((versionId: string) => void) | undefined;
}>;
/** Read-only HQ trial governance. Every value comes from the governance read or one readiness check; nothing here can change it. */
export function TrialsView(p: TrialsViewProps): React.ReactElement {
  const t: T = (key, vars) => trialsText(p.language, key, vars);
  const g = p.governance;
  const busy = g.state === 'LOADING';
  return <section className={styles.page} aria-labelledby="hq-trials-title" data-testid="hq-trials">
    <header className={styles.head}>
      <div><h1 id="hq-trials-title">{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
      {!p.concealed && p.onRefresh ? <button type="button" className={styles.secondary} onClick={p.onRefresh} disabled={busy}>{t('refresh')}</button> : null}
    </header>
    <p className={styles.meta}>{t('scope')}</p>
    {p.concealed ? <p className={styles.notice} role="status">{t('concealed')}</p>
      : g.state !== 'READY' ? <Notice state={g} t={t} onRefresh={p.onRefresh}/> : <Body view={g.view} {...p} t={t}/>}
  </section>;
}
function approvedText(rules: Extract<RuleState, { kind: 'IN_FORCE' | 'NOT_YET' | 'EXPIRED' }>, t: T, window: (d: TrialPolicyDecision) => { from: string; to: string }) {
  return t(rules.kind === 'IN_FORCE' ? 'inForce' : rules.kind === 'NOT_YET' ? 'notYet' : 'expired', { version: String(rules.version ?? '?'), ...window(rules.decision) });
}
function Body({ view, language, now, preview, onCheck, t }: TrialsViewProps & { view: TrialGovernanceView; t: T }) {
  const rules = ruleState(view, now), campaigns = campaignsOf(view);
  const truncated = Object.values(view.hasMore).some(Boolean);
  const versionOf = (policyId: string) => view.policyVersions.find((v) => v.policyId.toLowerCase() === policyId.toLowerCase())?.version;
  const window = (d: TrialPolicyDecision) => ({ from: moment(language, d.validFrom), to: moment(language, d.validUntil) });
  return <>
    <p className={styles.meta}>{t('asOf', { time: moment(language, view.asOf) })}</p>
    <div className={styles.grid}>
      <article className={styles.card} aria-labelledby="hq-trials-program">
        <div className={styles.cardHead}><h2 id="hq-trials-program">{t('programTitle')}</h2><span className={styles.chip} data-kind="off">{t('programOff')}</span></div>
        <ul className={styles.list}>
          <li>{t('signup')}: {t('disabled')}</li><li>{t('enrollment')}: {t('disabled')}</li><li>{t('promo')}: {t('disabled')}</li>
        </ul>
      </article>
      <article className={styles.card} aria-labelledby="hq-trials-other">
        <h2 id="hq-trials-other">{t('otherTitle')}</h2>
        <ul className={styles.list}>
          <li>{t('paidAccess')}: {t(`s_${view.existingPrograms.paidAccess}` as TrialsKey)}</li>
          <li>{t('aiCredits')}: {t(`s_${view.existingPrograms.aiCredits}` as TrialsKey)}</li>
          <li>{t('payments')}: {t(`s_${view.existingPrograms.payments}` as TrialsKey)}</li>
        </ul>
      </article>
    </div>

    <article className={styles.card} aria-labelledby="hq-trials-rules">
      <h2 id="hq-trials-rules">{t('rulesTitle')}</h2>
      <h3>{t('current')}</h3>
      <p data-testid="trial-rule-state" data-rule-state={rules.kind} className={rules.kind === 'IN_FORCE' ? undefined : styles.warnText}>{
        rules.kind === 'NONE' ? t('noDecision') : 'version' in rules ? approvedText(rules, t, window)
          : t(rules.kind === 'WITHDRAWN' ? 'withdrawnNow' : 'revokedNow')}</p>
      {view.policyVersions.length === 0 ? <p className={styles.meta}>{t('noRules')}</p> : view.policyVersions.map((v: TrialPolicyVersion) =>
        <details key={v.policyId} className={styles.detail} open={'version' in rules && rules.version === v.version}>
          <summary>{t('versionTitle', { version: String(v.version) })} · {t('proposed', { time: moment(language, v.recordedAt) })}</summary>
          <Terms terms={v.terms} language={language} t={t}/>
          <p className={styles.meta}>{t('because', { reason: v.reason })}</p>
        </details>)}
      <h3>{t('decisionsTitle')}</h3>
      {view.policyDecisions.length === 0 ? <p className={styles.meta}>{t('noDecisions')}</p> : <ul className={styles.list}>{view.policyDecisions.map((d) => <li key={d.decisionId}>
        <span>{t('decisionRow', { decision: t(`dec_${d.decision}` as TrialsKey), revision: String(d.revision), time: moment(language, d.recordedAt) })}</span>
        {d.decision === 'APPROVED' ? <span className={styles.meta}>{t('forVersion', { version: String(versionOf(d.policyId) ?? '?') })} · {t('validWindow', window(d))}</span> : null}
        <span className={styles.meta}>{t('because', { reason: d.reason })}</span>
      </li>)}</ul>}
    </article>

    <article className={styles.card} aria-labelledby="hq-trials-campaigns">
      <h2 id="hq-trials-campaigns">{t('campaignsTitle')}</h2>
      {campaigns.length === 0 ? <p className={styles.meta}>{t('noCampaigns')}</p> : <>
        {campaigns.some((c) => c.status === 'PUBLISHED') ? <p className={styles.meta}>{t('publishedNote')}</p> : null}
        <ul className={styles.campaigns}>{campaigns.map((c) => {
          const checking = preview && preview.versionId.toLowerCase() === c.latest.versionId.toLowerCase() ? preview : null;
          return <li key={c.campaignId} className={styles.campaign} data-testid="trial-campaign" data-status={c.status}>
            <div className={styles.cardHead}>
              <h3>{c.latest.definition.name}</h3>
              <span className={styles.chip} data-kind={c.status}>{t(`st_${c.status}` as TrialsKey)}</span>
            </div>
            <p className={styles.meta}>{t('versionN', { version: String(c.latest.version) })} · {moment(language, c.latest.recordedAt)}</p>
            {c.status === 'PUBLISHED' && c.publishedVersion !== null && c.publishedVersion !== c.latest.version
              ? <p className={styles.warnText}>{t('newerDraft', { published: String(c.publishedVersion), latest: String(c.latest.version) })}</p> : null}
            <Definition d={c.latest.definition} language={language} t={t}/>
            {onCheck ? <div className={styles.row}><button type="button" className={styles.secondary} disabled={checking?.state === 'LOADING'}
              onClick={() => onCheck(c.latest.versionId)}>{t('check')}</button></div> : null}
            {checking ? <Readiness state={checking} version={c.latest.version} language={language} t={t}/> : null}
            <details className={styles.detail}>
              <summary>{t('history')}</summary>
              <ul className={styles.list}>
                {c.publications.map((pub) => <li key={pub.publicationId}>{t('publicationRow', { kind: t(`pub_${pub.kind}` as TrialsKey),
                  version: String(c.versions.find((v) => v.versionId.toLowerCase() === pub.versionId.toLowerCase())?.version ?? '?'), revision: String(pub.revision),
                  time: moment(language, pub.recordedAt) })}<span className={styles.meta}>{t('because', { reason: pub.reason })}</span></li>)}
                {c.versions.map((v) => <li key={v.versionId}>{t('versionN', { version: String(v.version) })} · {moment(language, v.recordedAt)}
                  <span className={styles.meta}>{t('because', { reason: v.reason })}</span></li>)}
              </ul>
            </details>
          </li>;
        })}</ul>
      </>}
    </article>
    {truncated ? <p className={styles.meta}>{t('more')}</p> : null}
  </>;
}
