import React from 'react';
import { TRIAL_DURATION_CHOICES, TRIAL_ELIGIBILITIES, TRIAL_LINK_MODES, TRIAL_PROFILES, type TrialCampaignDefinition, type TrialPolicyTerms } from '@hon/contracts';
import type { TrialsKey } from './copy';
import type { TrialsErrorKind } from './http';
import styles from './hq-trials.module.css';

type T = (key: TrialsKey, vars?: Record<string, string>) => string;
/** Which HQ-owner form is open. Each one records governance only; none turns trials on. */
export type TrialForm = null | { kind: 'propose' } | { kind: 'approve' } | { kind: 'end'; decision: 'WITHDRAWN' | 'REVOKED' }
  | { kind: 'draft'; campaignId: string | null } | { kind: 'publish'; campaignId: string } | { kind: 'withdraw'; campaignId: string };
export type TrialAction = Exclude<TrialForm, null>['kind'];
export type TrialOutcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | TrialsErrorKind; action: TrialAction; replayed?: boolean }>;
export type Fields = Readonly<Record<string, string>>;

/** Form values by name; a repeated name (a checkbox group) is joined with commas. */
export function fieldsOf(form: HTMLFormElement): Fields {
  const out: Record<string, string> = {};
  for (const [name, value] of new FormData(form).entries()) if (typeof value === 'string') out[name] = name in out ? `${out[name]},${value}` : value;
  return out;
}
const day = (at: number) => new Date(at).toISOString().slice(0, 10);
const cents = (minor: number) => (minor / 100).toFixed(2).replace(/\.00$/, '');

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className={styles.field}>{label}{children}</label>; }
function Reason({ t, label }: { t: T; label?: TrialsKey }) {
  return <Field label={t(label ?? 'reason')}><textarea name="reason" rows={2} minLength={10} maxLength={500} required/></Field>;
}
function Choices({ name, legend, values, chosen, label }: { name: string; legend: string; values: readonly (string | number)[]; chosen: readonly (string | number)[];
  label: (v: string | number) => string }) {
  return <fieldset className={styles.choices}><legend>{legend}</legend>
    {values.map((v) => <label key={String(v)} className={styles.check}><input type="checkbox" name={name} value={String(v)} defaultChecked={chosen.includes(v)}/>{label(v)}</label>)}
  </fieldset>;
}
function Buttons({ t, confirm, locked, onClose }: { t: T; confirm: string; locked: boolean; onClose: () => void }) {
  return <div className={styles.row}>
    <button type="submit" className={styles.primary} disabled={locked}>{confirm}</button>
    <button type="button" className={styles.secondary} onClick={onClose} disabled={locked}>{t('back')}</button>
  </div>;
}
type Common = Readonly<{ t: T; locked: boolean; onClose: () => void; onSubmit: (fields: Fields) => void }>;
const submit = (onSubmit: (fields: Fields) => void) => (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); onSubmit(fieldsOf(event.currentTarget)); };

/** New rules, starting from the latest version's terms. */
export function ProposeForm({ t, locked, onClose, onSubmit, base }: Common & { base: TrialPolicyTerms | null }) {
  const promo = base?.promotionalLimits ?? null;
  return <form className={styles.form} aria-label={t('proposeTitle')} data-testid="trial-form" data-form="propose" onSubmit={submit(onSubmit)}>
    <h3>{t('proposeTitle')}</h3>
    <p className={styles.meta}>{t('proposeHelp')}</p>
    <Choices name="dur" legend={t('durations')} values={TRIAL_DURATION_CHOICES} chosen={base?.allowedDurationsDays ?? [14, 30]} label={(v) => t('days', { n: String(v) })}/>
    <Choices name="profile" legend={t('profiles')} values={TRIAL_PROFILES} chosen={base?.allowedCapabilityProfiles ?? ['CORE', 'COMPLETE']} label={(v) => t(`p_${v}` as TrialsKey)}/>
    <Choices name="elig" legend={t('eligibility')} values={TRIAL_ELIGIBILITIES} chosen={base?.allowedEligibilityCodes ?? ['NEW_ORGANIZATIONS_ONLY']} label={(v) => t(`el_${v}` as TrialsKey)}/>
    <Choices name="link" legend={t('linkModes')} values={TRIAL_LINK_MODES} chosen={base?.allowedLinkModes ?? ['PRIVATE_INVITATION']} label={(v) => t(`lm_${v}` as TrialsKey)}/>
    <div className={styles.grid}>
      <Field label={t('capacity')}><input name="capacity" inputMode="numeric" defaultValue={String(base?.maxEnrollmentCapacity ?? 25)} required/></Field>
      <Field label={t('totalCapacity')}><input name="totalCapacity" inputMode="numeric" defaultValue={String(base?.maxTotalEnrollmentCapacity ?? 50)} required/></Field>
      <Field label={t('windowDays')}><input name="windowDays" inputMode="numeric" defaultValue={String(base?.maxEnrollmentWindowDays ?? 90)} required/></Field>
      <Field label={t('maxCampaigns')}><input name="maxCampaigns" inputMode="numeric" defaultValue={String(base?.maxPublishedCampaigns ?? 2)} required/></Field>
      <Field label={t('terms')}><input name="termsReference" defaultValue={base?.termsReference ?? ''} required/></Field>
    </div>
    <label className={styles.check}><input type="checkbox" name="promo" value="on" defaultChecked={promo !== null}/>{t('promoAllow')}</label>
    <div className={styles.grid}>
      <Field label={t('promoCredits')}><input name="promoCredits" inputMode="numeric" defaultValue={promo ? String(promo.maxCreditsPerEnrollment) : ''}/></Field>
      <Field label={t('promoExpiry')}><input name="promoExpiry" inputMode="numeric" defaultValue={promo ? String(promo.maxCreditExpiryDays) : ''}/></Field>
      <Field label={t('promoDaily')}><input name="promoDaily" inputMode="numeric" defaultValue={promo ? String(promo.maxDailyCreditCap) : ''}/></Field>
      <Field label={t('promoRequest')}><input name="promoRequest" inputMode="numeric" defaultValue={promo ? String(promo.maxPerRequestCreditCap) : ''}/></Field>
      <Field label={t('promoCost')}><input name="promoCost" inputMode="decimal" defaultValue={promo ? cents(promo.maxCampaignCostMinor) : ''}/></Field>
      <Field label={t('promoTotal')}><input name="promoTotal" inputMode="decimal" defaultValue={promo ? cents(promo.maxTotalCampaignCostMinor) : ''}/></Field>
    </div>
    <p className={styles.meta}>{t('promoHelp')}</p>
    <Reason t={t}/>
    <Buttons t={t} confirm={t('proposeConfirm')} locked={locked} onClose={onClose}/>
  </form>;
}

/** Approve the latest rules version for a window. */
export function ApproveForm({ t, locked, onClose, onSubmit, version, now }: Common & { version: number; now: number }) {
  return <form className={`${styles.form} ${styles.danger}`} aria-label={t('approveTitle', { version: String(version) })} data-testid="trial-form" data-form="approve" onSubmit={submit(onSubmit)}>
    <h3>{t('approveTitle', { version: String(version) })}</h3>
    <p className={styles.meta}>{t('approveHelp')}</p>
    <div className={styles.grid}>
      <Field label={t('validFrom')}><input type="date" name="validFrom" defaultValue={day(now)} required/></Field>
      <Field label={t('validUntil')}><input type="date" name="validUntil" defaultValue={day(now + 90 * 86_400_000)} required/></Field>
    </div>
    <label className={styles.check}><input type="checkbox" name="confirm" value="on" required/>{t('approveConfirmText')}</label>
    <Reason t={t}/>
    <Buttons t={t} confirm={t('approveConfirm')} locked={locked} onClose={onClose}/>
  </form>;
}

/** Withdraw (not yet started) or revoke (started) the current approval. */
export function EndForm({ t, locked, onClose, onSubmit, decision }: Common & { decision: 'WITHDRAWN' | 'REVOKED' }) {
  const kind = decision === 'WITHDRAWN' ? 'withdrawRules' : 'revokeRules';
  return <form className={`${styles.form} ${styles.danger}`} aria-label={t(kind)} data-testid="trial-form" data-form="end" onSubmit={submit(onSubmit)}>
    <h3>{t(kind)}</h3>
    <p className={styles.meta}>{t('endHelp')}</p>
    <Reason t={t}/>
    <Buttons t={t} confirm={t(kind)} locked={locked} onClose={onClose}/>
  </form>;
}

/** A new campaign, or the next version of one, starting from its latest definition. */
export function DraftForm({ t, locked, onClose, onSubmit, base, termsReference, now, isNew }: Common & { base: TrialCampaignDefinition | null; termsReference: string; now: number; isNew: boolean }) {
  const b = base?.promotionalBudget ?? null;
  const opens = base ? base.enrollmentOpensAt.slice(0, 10) : day(now), closes = base ? base.enrollmentClosesAt.slice(0, 10) : day(now + 30 * 86_400_000);
  const title = isNew ? t('draftNewTitle') : t('draftNextTitle');
  return <form className={styles.form} aria-label={title} data-testid="trial-form" data-form="draft" onSubmit={submit(onSubmit)}>
    <h3>{title}</h3>
    <p className={styles.meta}>{t('draftHelp')}</p>
    <div className={styles.grid}>
      <Field label={t('campaignName')}><input name="name" maxLength={120} defaultValue={base?.name ?? ''} required/></Field>
      <Field label={t('trialLabel')}><select name="duration" defaultValue={String(base?.durationDays ?? 30)}>
        {TRIAL_DURATION_CHOICES.map((d) => <option key={d} value={String(d)}>{t('length', { n: String(d) })}</option>)}</select></Field>
      <Field label={t('profiles')}><select name="profile" defaultValue={base?.capabilityProfile ?? 'COMPLETE'}>
        {TRIAL_PROFILES.map((p) => <option key={p} value={p}>{t(`p_${p}` as TrialsKey)}</option>)}</select></Field>
      <Field label={t('eligibility')}><select name="elig" defaultValue={base?.eligibility ?? 'NEW_ORGANIZATIONS_ONLY'}>
        {TRIAL_ELIGIBILITIES.map((e) => <option key={e} value={e}>{t(`el_${e}` as TrialsKey)}</option>)}</select></Field>
      <Field label={t('linkModes')}><select name="link" defaultValue={base?.linkMode ?? 'PRIVATE_INVITATION'}>
        {TRIAL_LINK_MODES.map((m) => <option key={m} value={m}>{t(`lm_${m}` as TrialsKey)}</option>)}</select></Field>
      <Field label={t('opens')}><input type="date" name="opens" defaultValue={opens} required/></Field>
      <Field label={t('closes')}><input type="date" name="closes" defaultValue={closes} required/></Field>
      <Field label={t('schoolsLabel')}><input name="maxEnrollments" inputMode="numeric" defaultValue={String(base?.maximumEnrollments ?? 10)} required/></Field>
      <Field label={t('terms')}><input name="termsReference" defaultValue={base?.termsReference ?? termsReference} required/></Field>
    </div>
    <label className={styles.check}><input type="checkbox" name="promo" value="on" defaultChecked={b !== null}/>{t('budgetAllow')}</label>
    <div className={styles.grid}>
      <Field label={t('budgetCredits')}><input name="promoCredits" inputMode="numeric" defaultValue={b ? String(b.creditsPerEnrollment) : ''}/></Field>
      <Field label={t('budgetExpiry')}><input name="promoExpiry" inputMode="numeric" defaultValue={b ? String(b.creditExpiryDays) : ''}/></Field>
      <Field label={t('promoDaily')}><input name="promoDaily" inputMode="numeric" defaultValue={b ? String(b.dailyCreditCap) : ''}/></Field>
      <Field label={t('promoRequest')}><input name="promoRequest" inputMode="numeric" defaultValue={b ? String(b.perRequestCreditCap) : ''}/></Field>
      <Field label={t('budgetCost')}><input name="promoCost" inputMode="decimal" defaultValue={b ? cents(b.maximumCampaignCostMinor) : ''}/></Field>
    </div>
    <Reason t={t}/>
    <Buttons t={t} confirm={t('draftConfirm')} locked={locked} onClose={onClose}/>
  </form>;
}

/** Publish the checked version: bound to the readiness read that said it is ready. */
export function PublishForm({ t, locked, onClose, onSubmit, version }: Common & { version: number }) {
  return <form className={`${styles.form} ${styles.danger}`} aria-label={t('publishTitle', { version: String(version) })} data-testid="trial-form" data-form="publish" onSubmit={submit(onSubmit)}>
    <h3>{t('publishTitle', { version: String(version) })}</h3>
    <p className={styles.meta}>{t('publishHelp')}</p>
    <label className={styles.check}><input type="checkbox" name="confirm" value="on" required/>{t('publishConfirmText')}</label>
    <Reason t={t}/>
    <Buttons t={t} confirm={t('publishConfirm')} locked={locked} onClose={onClose}/>
  </form>;
}

export function WithdrawForm({ t, locked, onClose, onSubmit }: Common) {
  return <form className={`${styles.form} ${styles.danger}`} aria-label={t('withdrawCampaign')} data-testid="trial-form" data-form="withdraw" onSubmit={submit(onSubmit)}>
    <h3>{t('withdrawCampaign')}</h3>
    <p className={styles.meta}>{t('withdrawHelp')}</p>
    <Reason t={t}/>
    <Buttons t={t} confirm={t('withdrawCampaign')} locked={locked} onClose={onClose}/>
  </form>;
}

/** The last command's answer. Only an unknown outcome (or a rate limit) keeps the exact request for Try again. */
export function Outcome({ outcome, t, canRetry, onTryAgain, onStop }: { outcome: TrialOutcome; t: T; canRetry: boolean; onTryAgain?: (() => void) | undefined; onStop?: (() => void) | undefined }) {
  if (!outcome) return null;
  const text = outcome.kind === 'SENDING' ? t('sending') : outcome.kind === 'DONE' ? t(`done_${outcome.action}` as TrialsKey) : t(`e_${outcome.kind}` as TrialsKey);
  const bad = outcome.kind !== 'SENDING' && outcome.kind !== 'DONE';
  return <div className={`${styles.notice} ${bad ? styles.warn : ''}`} role={bad ? 'alert' : 'status'} data-testid="trial-outcome" data-kind={outcome.kind}>
    <p>{text}</p>
    {outcome.kind === 'DONE' && outcome.replayed ? <p>{t('replayed')}</p> : null}
    {canRetry ? <div className={styles.row}>
      {onTryAgain ? <button type="button" className={styles.primary} onClick={onTryAgain}>{t('tryAgain')}</button> : null}
      {onStop ? <button type="button" className={styles.secondary} onClick={onStop}>{t('stop')}</button> : null}
    </div> : null}
  </div>;
}
