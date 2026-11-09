import React from 'react';
import type { SaasCreativeLot, SaasCreativeReservationInternal } from '@hon/contracts';
import type { CreditsKey } from './copy';
import type { CreditsErrorKind } from './http';
import styles from './hq-creative-credits.module.css';

type T = (key: CreditsKey, vars?: Record<string, string>) => string;
/** Which HQ-owner correction form is open. None changes the program, the rates, a purchase or a payment. */
export type CreditForm = null | { kind: 'grant' } | { kind: 'debit'; lotId: string }
  | { kind: 'resolve'; reservationId: string; resolution: 'SUCCEEDED' | 'NOT_CHARGED' } | { kind: 'cost'; reservationId: string };
export type CreditAction = Exclude<CreditForm, null>['kind'];
/** LOST: a session end dropped a correction before its answer was confirmed; check the wallet before sending it again. */
export type CreditOutcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | 'LOST' | CreditsErrorKind; action: CreditAction; replayed?: boolean }>;
export type Fields = Readonly<Record<string, string>>;

export const GRANT_REASONS = ['PROMOTION', 'GOODWILL', 'SERVICE_RECOVERY', 'BILLING_CORRECTION', 'OTHER'] as const;
export const DEBIT_REASONS = ['BILLING_CORRECTION', 'RECORDED_IN_ERROR', 'OTHER'] as const;

/** A lot HQ may remove credits from: not purchased, not expired, with unused credits. */
export const debitable = (l: SaasCreativeLot) => l.kind !== 'PURCHASED_TOPUP' && !l.expired && l.availableCredits > 0;
/** A generation HQ may settle: its outcome is unknown or it is still held. */
export const settleable = (r: SaasCreativeReservationInternal) => r.status === 'OUTCOME_UNKNOWN' || r.status === 'RESERVED';
/** A released generation whose provider cost is still unknown. */
export const costable = (r: SaasCreativeReservationInternal) => r.status === 'RELEASED' && r.costStatus === 'UNKNOWN';

export function fieldsOf(form: HTMLFormElement): Fields {
  const out: Record<string, string> = {};
  for (const [name, value] of new FormData(form).entries()) if (typeof value === 'string') out[name] = value;
  return out;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className={styles.field}>{label}{children}</label>; }
function Confirm({ text }: { text: string }) { return <label className={styles.check}><input type="checkbox" name="confirm" required/>{text}</label>; }
function Buttons({ t, confirm, locked, onClose }: { t: T; confirm: string; locked: boolean; onClose: () => void }) {
  return <div className={styles.row}>
    <button type="submit" className={styles.primary} disabled={locked}>{confirm}</button>
    <button type="button" className={styles.secondary} onClick={onClose} disabled={locked}>{t('back')}</button>
  </div>;
}
type Common = Readonly<{ t: T; locked: boolean; onClose: () => void; onSubmit: (fields: Fields) => void }>;
function Shell({ title, help, danger, children, onSubmit, testid }: { title: string; help: string; danger?: boolean; children: React.ReactNode; onSubmit: (fields: Fields) => void; testid: string }) {
  return <form className={`${styles.form} ${danger ? styles.danger : ''}`} data-testid="credit-form" data-form={testid} aria-label={title}
    onSubmit={(e) => { e.preventDefault(); onSubmit(fieldsOf(e.currentTarget)); }}>
    <h4 className={styles.formTitle}>{title}</h4>
    <p className={styles.meta}>{help}</p>
    {children}
  </form>;
}
const Note = ({ t }: { t: T }) => <Field label={t('f_note')}><textarea name="note" rows={2} maxLength={500} required/></Field>;
const Evidence = ({ t }: { t: T }) => <Field label={t('f_evidence')}><input name="evidence" maxLength={200} required autoComplete="off"/></Field>;

export function GrantForm({ school, ...c }: Common & { school: string }) {
  const { t } = c;
  return <Shell title={t('grantTitle', { school })} help={t('grantHelp')} onSubmit={c.onSubmit} testid="grant">
    <Field label={t('f_kind')}><select name="kind" defaultValue="PROMOTIONAL">
      <option value="PROMOTIONAL">{t('k_PROMOTIONAL')}</option><option value="ADJUSTMENT">{t('k_ADJUSTMENT')}</option></select></Field>
    <Field label={t('f_credits')}><input name="credits" inputMode="numeric" pattern="[0-9]{1,10}" required autoComplete="off"/></Field>
    <Field label={t('f_reason')}><select name="reason" defaultValue="GOODWILL">{GRANT_REASONS.map((r) => <option key={r} value={r}>{t(`ar_${r}` as CreditsKey)}</option>)}</select></Field>
    <Note t={t}/>
    <Confirm text={t('grantConfirmText', { school })}/>
    <Buttons t={t} confirm={t('grantConfirm')} locked={c.locked} onClose={c.onClose}/>
  </Shell>;
}
export function DebitForm({ lot, ...c }: Common & { lot: SaasCreativeLot }) {
  const { t } = c;
  return <Shell title={t('debitTitle', { kind: t(`k_${lot.kind}` as CreditsKey) })} help={t('debitHelp', { n: String(lot.availableCredits) })} danger onSubmit={c.onSubmit} testid="debit">
    <Field label={t('f_credits')}><input name="credits" inputMode="numeric" pattern="[0-9]{1,10}" required autoComplete="off"/></Field>
    <Field label={t('f_reason')}><select name="reason" defaultValue="BILLING_CORRECTION">{DEBIT_REASONS.map((r) => <option key={r} value={r}>{t(`ar_${r}` as CreditsKey)}</option>)}</select></Field>
    <Note t={t}/>
    <Confirm text={t('debitConfirmText')}/>
    <Buttons t={t} confirm={t('debitConfirm')} locked={c.locked} onClose={c.onClose}/>
  </Shell>;
}
export function ResolveForm({ reservation: r, resolution, ...c }: Common & { reservation: SaasCreativeReservationInternal; resolution: 'SUCCEEDED' | 'NOT_CHARGED' }) {
  const { t } = c;
  const succeeded = resolution === 'SUCCEEDED';
  return <Shell title={t(succeeded ? 'resolveOkTitle' : 'resolveNoTitle')} help={t(succeeded ? 'resolveOkHelp' : 'resolveNoHelp', { credits: String(r.reservedCredits) })}
    danger={!succeeded} onSubmit={c.onSubmit} testid={succeeded ? 'resolve-succeeded' : 'resolve-not-charged'}>
    {succeeded ? <Field label={t('f_units', { units: String(r.units), unit: t(`m_${r.mediaKind}` as CreditsKey) })}>
      <input name="units" inputMode="numeric" pattern="[0-9]{1,4}" defaultValue={String(r.units)} required autoComplete="off"/></Field> : null}
    <Field label={t(succeeded ? 'f_cost' : 'f_costOptional')}><input name="cost" inputMode="decimal" required={succeeded} autoComplete="off" placeholder="0.08"/></Field>
    <Evidence t={t}/>
    <Confirm text={t(succeeded ? 'resolveOkConfirmText' : 'resolveNoConfirmText')}/>
    <Buttons t={t} confirm={t('resolveConfirm')} locked={c.locked} onClose={c.onClose}/>
  </Shell>;
}
export function CostForm(c: Common) {
  const { t } = c;
  return <Shell title={t('costTitle')} help={t('costHelp')} onSubmit={c.onSubmit} testid="cost">
    <Field label={t('f_cost')}><input name="cost" inputMode="decimal" required autoComplete="off" placeholder="0.08"/></Field>
    <Evidence t={t}/>
    <Confirm text={t('costConfirmText')}/>
    <Buttons t={t} confirm={t('costConfirm')} locked={c.locked} onClose={c.onClose}/>
  </Shell>;
}
export function Outcome({ outcome, t, canRetry, onTryAgain, onStop }: { outcome: CreditOutcome; t: T; canRetry: boolean; onTryAgain?: (() => void) | undefined; onStop?: (() => void) | undefined }) {
  if (!outcome) return null;
  const text = outcome.kind === 'SENDING' ? t('sending') : outcome.kind === 'DONE' ? t(`done_${outcome.action}` as CreditsKey) : t(`e_${outcome.kind}` as CreditsKey);
  const bad = outcome.kind !== 'SENDING' && outcome.kind !== 'DONE';
  return <div className={`${styles.notice} ${bad ? styles.warn : ''}`} role={bad ? 'alert' : 'status'} data-testid="credit-outcome" data-kind={outcome.kind}>
    <p>{text}</p>
    {outcome.kind === 'DONE' && outcome.replayed ? <p>{t('replayed')}</p> : null}
    {canRetry ? <div className={styles.row}>
      {onTryAgain ? <button type="button" className={styles.primary} onClick={onTryAgain}>{t('tryAgain')}</button> : null}
      {onStop ? <button type="button" className={styles.secondary} onClick={onStop}>{t('stop')}</button> : null}
    </div> : null}
  </div>;
}
