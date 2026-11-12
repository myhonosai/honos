import React from 'react';
import { CHECKOUT_LIMITS, type CheckoutFieldKind, type CheckoutLanguage, type CheckoutPage, type CheckoutPageKind, type CheckoutPageStatus, type CheckoutPlanChoice, type SchoolCheckoutPages } from '@hon/contracts';
import type { CheckoutErrorKind } from './http';
import type { CheckoutDraft, DraftEdit, TextDraft } from './draft';
import { formatMinor } from '../invoice-pickers';
import styles from '../membership-changes/membership-changes.module.css';

export type CheckoutListState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; read: SchoolCheckoutPages };
export type CheckoutOutcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | CheckoutErrorKind; status: CheckoutPageStatus }>;

export type SchoolCheckoutViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean;
  list: CheckoutListState; kind: CheckoutPageKind; editLanguage: CheckoutLanguage; draft: CheckoutDraft | null; dirty: boolean; problems: readonly string[];
  outcome: CheckoutOutcome; locked: boolean; canRetry: boolean;
  onKind?: ((kind: CheckoutPageKind) => void) | undefined; onEditLanguage?: ((language: CheckoutLanguage) => void) | undefined;
  onEdit?: ((edit: DraftEdit) => void) | undefined; onSave?: ((status: CheckoutPageStatus) => void) | undefined;
  onDiscard?: (() => void) | undefined; onRefreshList?: (() => void) | undefined; onTryAgain?: (() => void) | undefined;
}>;

const KIND_LABEL: Record<CheckoutPageKind, string> = { ENROLLMENT: 'Enrollment checkout', TUITION: 'Tuition payment page' };
const KIND_INTRO: Record<CheckoutPageKind, string> = {
  ENROLLMENT: 'What a new family sees when they sign up: the plans they can choose, any add-ons, your questions and your waiver.',
  TUITION: 'What a current family sees when they pay tuition: optional add-ons, your questions, and receipt and thank-you text.',
};
const LANGUAGE_LABEL: Record<CheckoutLanguage, string> = { en: 'English', ko: '한국어 (Korean)', es: 'Español (Spanish)' };
const FIELD_KIND_LABEL: Record<CheckoutFieldKind, string> = { TEXT: 'Short answer', CHOICE: 'Pick one', CHECKBOX: 'Checkbox (yes or no)' };
const FREQUENCY_LABEL: Record<string, string> = { WEEKLY: 'weekly', MONTHLY: 'monthly', ANNUAL: 'yearly', PAID_IN_FULL: 'paid in full' };
const OUTCOME_TEXT: Record<NonNullable<CheckoutOutcome>['kind'], string> = {
  SENDING: 'Saving. Keep this page open.',
  DONE: 'Saved. The page below was read again from the server.',
  SESSION: 'Your session ended. Sign in again; your edits on this page were not saved.',
  DENIED: 'You are not allowed to change checkout pages at this school. Nothing changed.',
  CHANGED: 'Someone else saved this page since you opened it. Nothing changed. Your edits are still here: Save again replaces their version, or Discard changes shows theirs.',
  PLAN_UNAVAILABLE: 'One of the chosen plans is no longer available at this school. Nothing changed; remove it and save again.',
  PLANS_REQUIRED: 'The enrollment page needs at least one plan before it can be published. Nothing changed.',
  INVALID: 'The page was not accepted as sent. Nothing changed; check the details and try again.',
  RATE: 'Too many requests. Nothing changed; try again in a moment.',
  UNKNOWN: 'The result is not known yet. Try again sends the exact same save, so nothing happens twice.',
};
const instant = (language: string, value: string) => new Date(value).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' });

function TextInput({ p, label, value, onChange, max, multiline = false }: { p: SchoolCheckoutViewProps; label: string; value: TextDraft; onChange: (next: TextDraft) => void; max: number; multiline?: boolean }) {
  const l = p.editLanguage;
  const hint = l === 'en' ? '' : value.en ? ` (English: ${value.en.length > 60 ? `${value.en.slice(0, 60)}…` : value.en})` : ' (add the English text first)';
  const props = { value: value[l], maxLength: max, disabled: p.locked, lang: l, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange({ ...value, [l]: e.currentTarget.value }) };
  return <label className={styles.field}>{label}{l === 'en' ? '' : ` in ${LANGUAGE_LABEL[l]}, optional`}{hint}
    {multiline ? <textarea rows={4} {...props}/> : <input type="text" {...props}/>}
  </label>;
}

function Plans({ p, draft, plans }: { p: SchoolCheckoutViewProps; draft: CheckoutDraft; plans: readonly CheckoutPlanChoice[] }) {
  const shown = draft.planIds.map((id) => plans.find((x) => x.planId === id) ?? null);
  const others = plans.filter((x) => x.available && !draft.planIds.includes(x.planId));
  const describe = (plan: CheckoutPlanChoice) => `${plan.displayName} · ${formatMinor(plan.priceMinor, plan.currency)} ${FREQUENCY_LABEL[plan.billingFrequency] ?? ''}`;
  return <fieldset className={styles.form} data-testid="checkout-plans"><legend>Plans shown, in order</legend>
    {shown.length === 0 ? <p className={styles.meta}>{p.kind === 'ENROLLMENT' ? 'No plans yet. Choose at least one before publishing.' : 'No plans shown. That is fine for a tuition payment page.'}</p> : null}
    <ol className={styles.list}>{draft.planIds.map((id, i) => {
      const plan = shown[i];
      return <li key={id} data-testid="checkout-plan-shown">
        <span>{plan ? describe(plan) : 'A plan that is no longer in your catalog'}{plan && !plan.available ? ' · no longer available, remove it' : ''}</span>
        <span className={styles.row}>
          <button type="button" className={styles.secondary} disabled={p.locked || i === 0} aria-label={`Move ${plan?.displayName ?? 'plan'} up`} onClick={() => p.onEdit?.({ type: 'planMove', planId: id, by: -1 })}>Up</button>
          <button type="button" className={styles.secondary} disabled={p.locked || i === draft.planIds.length - 1} aria-label={`Move ${plan?.displayName ?? 'plan'} down`} onClick={() => p.onEdit?.({ type: 'planMove', planId: id, by: 1 })}>Down</button>
          <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onEdit?.({ type: 'plan', planId: id, shown: false })}>Remove</button>
        </span>
      </li>;
    })}</ol>
    {others.length > 0 && draft.planIds.length < CHECKOUT_LIMITS.plans ? <><p className={styles.meta}>Add a plan from your catalog:</p>
      <ul className={styles.list}>{others.map((plan) => <li key={plan.planId}>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onEdit?.({ type: 'plan', planId: plan.planId, shown: true })}>Add {describe(plan)}</button>
      </li>)}</ul></> : null}
    {plans.length === 0 ? <p className={styles.meta}>Your school has no membership plans yet. Add them under Plans first.</p> : null}
  </fieldset>;
}

function AddOns({ p, draft, currency }: { p: SchoolCheckoutViewProps; draft: CheckoutDraft; currency: string }) {
  return <fieldset className={styles.form} data-testid="checkout-addons"><legend>Add-ons</legend>
    <p className={styles.meta}>Extra items such as a uniform or a registration fee. A required add-on is always added; an optional one the family can tick.</p>
    {draft.addOns.map((a, i) => <div key={a.key} className={styles.card} data-testid="checkout-addon">
      <TextInput p={p} label={`Add-on ${i + 1} name`} value={a.label} max={CHECKOUT_LIMITS.label} onChange={(label) => p.onEdit?.({ type: 'addOn', index: i, patch: { label } })}/>
      <label className={styles.field}>Amount ({a.currency})<input type="text" inputMode="decimal" value={a.amount} disabled={p.locked} placeholder={a.currency === 'USD' ? '25.00' : ''}
        onChange={(e) => p.onEdit?.({ type: 'addOn', index: i, patch: { amount: e.currentTarget.value } })}/></label>
      <label className={styles.check}><input type="checkbox" checked={a.required} disabled={p.locked} onChange={(e) => p.onEdit?.({ type: 'addOn', index: i, patch: { required: e.currentTarget.checked } })}/> Required</label>
      <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onEdit?.({ type: 'removeAddOn', index: i })}>Remove add-on</button>
    </div>)}
    {draft.addOns.length < CHECKOUT_LIMITS.addOns ? <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onEdit?.({ type: 'addAddOn', currency })}>Add an add-on</button> : null}
  </fieldset>;
}

function Questions({ p, draft }: { p: SchoolCheckoutViewProps; draft: CheckoutDraft }) {
  return <fieldset className={styles.form} data-testid="checkout-questions"><legend>Questions for the family</legend>
    {draft.customFields.map((f, i) => <div key={f.key} className={styles.card} data-testid="checkout-question">
      <TextInput p={p} label={`Question ${i + 1}`} value={f.label} max={CHECKOUT_LIMITS.question} onChange={(label) => p.onEdit?.({ type: 'field', index: i, patch: { label } })}/>
      <label className={styles.field}>Answer type<select value={f.kind} disabled={p.locked} onChange={(e) => p.onEdit?.({ type: 'field', index: i, patch: { kind: e.currentTarget.value as CheckoutFieldKind } })}>
        {(Object.keys(FIELD_KIND_LABEL) as CheckoutFieldKind[]).map((k) => <option key={k} value={k}>{FIELD_KIND_LABEL[k]}</option>)}
      </select></label>
      {f.kind === 'CHOICE' ? <>{f.options.map((o, j) => <div key={j} className={styles.row}>
        <TextInput p={p} label={`Choice ${j + 1}`} value={o} max={CHECKOUT_LIMITS.label} onChange={(text) => p.onEdit?.({ type: 'option', index: i, option: j, text })}/>
        <button type="button" className={styles.secondary} disabled={p.locked || f.options.length <= 2} onClick={() => p.onEdit?.({ type: 'removeOption', index: i, option: j })}>Remove choice</button>
      </div>)}
      {f.options.length < CHECKOUT_LIMITS.choiceOptions ? <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onEdit?.({ type: 'addOption', index: i })}>Add a choice</button> : null}</> : null}
      <label className={styles.check}><input type="checkbox" checked={f.required} disabled={p.locked} onChange={(e) => p.onEdit?.({ type: 'field', index: i, patch: { required: e.currentTarget.checked } })}/> The family must answer</label>
      <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onEdit?.({ type: 'removeField', index: i })}>Remove question</button>
    </div>)}
    {draft.customFields.length < CHECKOUT_LIMITS.fields ? <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onEdit?.({ type: 'addField' })}>Add a question</button> : null}
  </fieldset>;
}

function Texts({ p, draft }: { p: SchoolCheckoutViewProps; draft: CheckoutDraft }) {
  return <fieldset className={styles.form} data-testid="checkout-texts"><legend>Waiver, receipt and thank-you</legend>
    <label className={styles.check}><input type="checkbox" checked={draft.waiverOn} disabled={p.locked} onChange={(e) => p.onEdit?.({ type: 'waiverOn', on: e.currentTarget.checked })}/> Families must agree to a waiver</label>
    {draft.waiverOn ? <TextInput p={p} label="Waiver text" value={draft.waiver} max={CHECKOUT_LIMITS.waiver} multiline onChange={(text) => p.onEdit?.({ type: 'text', target: 'waiver', text })}/> : null}
    <TextInput p={p} label="Note on the receipt (optional)" value={draft.receiptNote} max={CHECKOUT_LIMITS.note} multiline onChange={(text) => p.onEdit?.({ type: 'text', target: 'receiptNote', text })}/>
    <TextInput p={p} label="Thank-you message (optional)" value={draft.thankYou} max={CHECKOUT_LIMITS.note} multiline onChange={(text) => p.onEdit?.({ type: 'text', target: 'thankYou', text })}/>
  </fieldset>;
}

function Status({ p, page }: { p: SchoolCheckoutViewProps; page: CheckoutPage | null }) {
  return <p className={styles.meta} data-testid="checkout-status">{page === null ? 'Not saved yet.'
    : `${page.status === 'PUBLISHED' ? 'Published' : 'Draft, not shown to families'} · version ${page.version} · saved ${instant(p.language, page.updatedAt)}`}
    {p.dirty ? ' · you have unsaved changes' : ''}</p>;
}

function Editor({ p, read }: { p: SchoolCheckoutViewProps; read: SchoolCheckoutPages }) {
  const draft = p.draft, page = p.kind === 'ENROLLMENT' ? read.enrollment : read.tuition;
  if (!draft) return null;
  const currency = read.plans[0]?.currency ?? 'USD';
  return <article className={styles.card} aria-labelledby="checkout-kind-title" data-testid="checkout-editor">
    <div className={styles.cardHead}><h2 id="checkout-kind-title">{KIND_LABEL[p.kind]}</h2>
      <button type="button" className={styles.secondary} disabled={p.locked || p.dirty} onClick={p.onRefreshList}>Refresh</button></div>
    <p className={styles.meta}>{KIND_INTRO[p.kind]}</p>
    <Status p={p} page={page}/>
    <div className={styles.tabs} role="group" aria-label="Language you are editing">{(Object.keys(LANGUAGE_LABEL) as CheckoutLanguage[]).map((l) =>
      <button key={l} type="button" className={styles.tab} aria-pressed={p.editLanguage === l} disabled={p.locked} onClick={() => p.onEditLanguage?.(l)}>{LANGUAGE_LABEL[l]}</button>)}</div>
    <p className={styles.meta}>English is required. Korean and Spanish are optional; where they are empty, families see the English text.</p>
    <Plans p={p} draft={draft} plans={read.plans}/>
    <AddOns p={p} draft={draft} currency={currency}/>
    <Questions p={p} draft={draft}/>
    <Texts p={p} draft={draft}/>
    {p.problems.length > 0 ? <div className={`${styles.notice} ${styles.warn}`} role="status" data-testid="checkout-problems"><p>Fix these before saving:</p>
      <ul>{p.problems.map((x, i) => <li key={i}>{x}</li>)}</ul></div> : null}
    <div className={styles.actions}>
      <button type="button" className={styles.secondary} disabled={p.locked || p.problems.length > 0} onClick={() => p.onSave?.('DRAFT')}>Save as draft</button>
      <button type="button" className={styles.primary} disabled={p.locked || p.problems.length > 0} onClick={() => p.onSave?.('PUBLISHED')}>Save and publish</button>
      {p.dirty ? <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onDiscard}>Discard changes</button> : null}
    </div>
    <p className={styles.meta}>Families cannot open this page yet; the family checkout comes in a later update. Card details are always entered on your payment provider&apos;s own secure form, never stored by HON.</p>
  </article>;
}

/** The checkout page settings body: pure, every state comes from props. */
export function SchoolCheckoutView(p: SchoolCheckoutViewProps): React.ReactElement {
  const list = p.list;
  return <section className={styles.page} aria-labelledby="school-checkout-title">
    <header className={styles.head}><div>
      <h1 id="school-checkout-title">Checkout pages</h1>
      <p className={styles.intro}>Choose what families see when they enroll or pay tuition online. Your school&apos;s logo and colors come from your shared school branding. HON adds no fee to any payment your school collects.</p>
    </div></header>
    {p.concealed ? <p className={styles.notice} role="status">Hidden while this tab was in the background. Return to the page to show it again.</p>
      : p.waiting ? <p className={styles.notice} role="status">Checking your school…</p>
      : !p.hasSchool ? <p className={styles.notice} role="status">Choose a school to edit its checkout pages.</p>
      : <>
        {p.outcome ? <div className={`${styles.notice} ${['DONE', 'SENDING'].includes(p.outcome.kind) ? '' : styles.warn}`} role="status" data-testid="checkout-outcome">
          <p>{OUTCOME_TEXT[p.outcome.kind]}</p>
          {p.outcome.kind === 'DONE' ? <p className={styles.meta}>{p.outcome.status === 'PUBLISHED' ? 'This version is published.' : 'Saved as a draft; families do not see drafts.'}</p> : null}
          {p.canRetry ? <button type="button" className={styles.primary} onClick={p.onTryAgain}>Try again</button> : null}
        </div> : null}
        {list.state === 'LOADING' ? <p className={styles.meta} role="status">Reading checkout pages…</p>
          : list.state === 'DENIED' ? <p className={styles.meta} role="status">You need the manage checkout pages permission at this school to see this page.</p>
          : list.state !== 'READY' ? <p className={styles.meta} role="status">Checkout pages are not available right now. Nothing changed.</p>
          : <>
            <div className={styles.tabs} role="tablist" aria-label="Checkout page">{(['ENROLLMENT', 'TUITION'] as const).map((k) =>
              <button key={k} type="button" role="tab" className={styles.tab} aria-selected={p.kind === k} disabled={p.locked || (p.dirty && p.kind !== k)} onClick={() => p.onKind?.(k)}>{KIND_LABEL[k]}</button>)}</div>
            {p.dirty ? <p className={styles.meta}>Save or discard your changes before switching pages.</p> : null}
            <Editor p={p} read={list.read}/>
          </>}
      </>}
  </section>;
}
