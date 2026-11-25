'use client';
import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  MEMBERSHIP_PAYMENT_OPTION_FREQUENCIES, MEMBERSHIP_PLAN_CHANGE_CONFIRMATION, MEMBERSHIP_PLAN_SETUP_LIMITS, membershipPaymentOptionProblem,
  validateCreateMembershipPlanWithOptionsInput, validateReviseMembershipPlanWithOptionsInput,
  type CreateMembershipPlanWithOptionsInput, type MembershipPaymentOptionFrequency, type MembershipPaymentOptionInput, type MembershipPlanListing,
  type MembershipPlanProgramOption, type MembershipPlanSetup, type ReviseMembershipPlanWithOptionsInput,
} from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { createPlanWithOptionsRequest, revisePlanWithOptionsRequest, type PlanRequest, type PlanScope } from './http';
import { OPTION_FREQUENCY_LABELS, optionSummary, planCodeFromName, priceMinorFromText, priceTextFromMinor } from './presentation';
import styles from './plans.module.css';

/** One payment option as typed; numbers stay text until review. */
type OptionFields = { label: string; price: string; billingFrequency: MembershipPaymentOptionFrequency; payments: string; termMonths: string; downPayment: boolean; downPaymentPrice: string; checkoutEnabled: boolean };
const blankOption = (n: number): OptionFields => ({ label: n === 1 ? 'Standard payment' : '', price: '', billingFrequency: 'MONTHLY', payments: '', termMonths: '', downPayment: false, downPaymentPrice: '', checkoutEnabled: true });
const PROBLEMS: Record<NonNullable<ReturnType<typeof membershipPaymentOptionProblem>>, string> = {
  FIRST_NOT_QUARTERLY: 'Option 1 is the standard price and can be weekly, monthly, annual or paid in full. Put quarterly as a later option.',
  PAID_IN_FULL_NEEDS_LENGTH: 'Paid in full needs a length in months and is one payment, so leave the number of payments empty.',
  ANNUAL_WHOLE_YEARS: 'An annual option needs a length in whole years (12, 24, 36…), or no length.',
  QUARTERLY_WHOLE_QUARTERS: 'A quarterly option needs a length in whole quarters (3, 6, 9, 12…), or no length.',
};

/**
 * Membership plan editor (0642), laid out like the owner's previous CRM: one membership type with several payment options.
 * Publishing records terms only; no agreement, payment schedule or charge is created.
 */
export function MembershipPlanEditor({ scope, selected, setup, programs, disabled, onPublish, onCancel }: {
  scope: PlanScope; selected: MembershipPlanListing | null; setup: MembershipPlanSetup | null; programs: MembershipPlanProgramOption[]; disabled: boolean;
  onPublish(request: PlanRequest): void; onCancel(): void;
}): React.ReactElement {
  const { money } = useLocale();
  const currency0 = selected?.currency ?? 'USD';
  const [fields, setFields] = useState({ planCode: selected?.planCode ?? '', codeTouched: false, displayName: selected?.displayName ?? '', description: selected?.description ?? '',
    programId: selected?.programId ?? '', availability: selected?.availability ?? 'AVAILABLE', currency: currency0,
    classesPerWeek: setup?.classesPerWeek ? String(setup.classesPerWeek) : '', features: (setup?.features ?? []).join('\n') });
  const initialOptions: OptionFields[] = setup ? setup.paymentOptions.map((o, i) => ({ label: o.label ?? (i === 0 ? 'Standard payment' : ''),
    price: priceTextFromMinor(o.priceMinor, currency0), billingFrequency: o.billingFrequency, payments: o.payments === null ? '' : String(o.payments),
    termMonths: o.termMonths === null ? '' : String(o.termMonths), downPayment: o.downPaymentMinor !== null,
    downPaymentPrice: o.downPaymentMinor === null ? '' : priceTextFromMinor(o.downPaymentMinor, currency0), checkoutEnabled: o.checkoutEnabled })) : [blankOption(1)];
  const [options, setOptions] = useState<OptionFields[]>(initialOptions);
  const [review, setReview] = useState<CreateMembershipPlanWithOptionsInput | ReviseMembershipPlanWithOptionsInput | null>(null);
  const [confirmed, setConfirmed] = useState(false), [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => { heading.current?.focus(); }, [review]);
  function touched(): void { setReview(null); setConfirmed(false); setError(''); }
  function edit(key: keyof typeof fields, value: string): void {
    setFields(f => ({ ...f, [key]: value, ...(key === 'planCode' ? { codeTouched: true } : {}),
      ...(key === 'displayName' && !selected && !f.codeTouched ? { planCode: planCodeFromName(value) } : {}) })); touched();
  }
  function editOption(index: number, patch: Partial<OptionFields>): void { setOptions(list => list.map((o, i) => i === index ? { ...o, ...patch } : o)); touched(); }
  function addOption(): void { setOptions(list => list.length >= MEMBERSHIP_PLAN_SETUP_LIMITS.options ? list : [...list, blankOption(list.length + 1)]); touched(); }
  function removeOption(index: number): void { setOptions(list => list.length <= 1 ? list : list.filter((_, i) => i !== index)); touched(); }
  function moveUp(index: number): void { setOptions(list => index < 1 ? list : [...list.slice(0, index - 1), list[index]!, list[index - 1]!, ...list.slice(index + 1)]); touched(); }
  function count(value: string, label: string, max: number): number | null {
    if (!value.trim()) return null;
    if (!/^\d+$/.test(value.trim()) || Number(value) < 1 || Number(value) > max) throw new Error(`${label} must be a whole number from 1 to ${max}, or empty.`);
    return Number(value);
  }
  function submit(event: FormEvent): void {
    event.preventDefault(); if (disabled) return;
    if (review) {
      if (!confirmed) return;
      onPublish(selected
        ? revisePlanWithOptionsRequest(scope, selected.planId, validateReviseMembershipPlanWithOptionsInput(review), crypto.randomUUID())
        : createPlanWithOptionsRequest(scope, validateCreateMembershipPlanWithOptionsInput(review), crypto.randomUUID()));
      return;
    }
    try {
      if (fields.programId && !programs.some(p => p.programId === fields.programId)) throw new Error('Choose a current school program, or no program.');
      const paymentOptions: MembershipPaymentOptionInput[] = options.map((o, i) => {
        const name = `Option ${i + 1}`;
        if (!o.label.trim()) throw new Error(`${name} needs a name, for example "6 monthly payments".`);
        if (!o.price.trim()) throw new Error(`${name} needs an amount.`);
        const option: MembershipPaymentOptionInput = { label: o.label.trim(), priceMinor: priceMinorFromText(o.price, fields.currency), billingFrequency: o.billingFrequency,
          payments: o.billingFrequency === 'PAID_IN_FULL' ? null : count(o.payments, `${name} number of payments`, MEMBERSHIP_PLAN_SETUP_LIMITS.payments),
          termMonths: count(o.termMonths, `${name} length in months`, MEMBERSHIP_PLAN_SETUP_LIMITS.termMonths), checkoutEnabled: o.checkoutEnabled };
        if (o.downPayment) {
          const minor = priceMinorFromText(o.downPaymentPrice || '0', fields.currency);
          if (minor < 1) throw new Error(`${name} down payment must be more than zero, or turn it off.`);
          option.downPaymentMinor = minor;
        }
        const problem = membershipPaymentOptionProblem({ billingFrequency: option.billingFrequency, payments: option.payments ?? null, termMonths: option.termMonths ?? null }, i + 1);
        if (problem) throw new Error(`${name}: ${PROBLEMS[problem]}`);
        return option;
      });
      const labels = paymentOptions.map(o => o.label.toLowerCase());
      if (new Set(labels).size !== labels.length) throw new Error('Give each payment option a different name.');
      const features = fields.features.split('\n').map(f => f.trim()).filter(Boolean);
      if (features.length > MEMBERSHIP_PLAN_SETUP_LIMITS.features) throw new Error(`Keep features to ${MEMBERSHIP_PLAN_SETUP_LIMITS.features} lines or fewer.`);
      const base = { displayName: fields.displayName.trim(), description: fields.description.trim() || null, programId: fields.programId || null, availability: fields.availability,
        currency: fields.currency, classesPerWeek: count(fields.classesPerWeek, 'Classes per week', MEMBERSHIP_PLAN_SETUP_LIMITS.classesPerWeek), features, paymentOptions,
        confirmation: MEMBERSHIP_PLAN_CHANGE_CONFIRMATION };
      let input: CreateMembershipPlanWithOptionsInput | ReviseMembershipPlanWithOptionsInput;
      try { input = selected ? validateReviseMembershipPlanWithOptionsInput({ ...base, expectedVersion: selected.version }) : validateCreateMembershipPlanWithOptionsInput({ ...base, planCode: fields.planCode }); }
      catch { throw new Error('Check the plan name, plan code (capital letters, digits, - or _), currency and each option, then review again.'); }
      setReview(input); setConfirmed(false); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Check the plan fields.'); }
  }
  const programName = (id: string | null | undefined) => programs.find(p => p.programId === id)?.name ?? 'No program';
  return <section className={styles.panel} aria-labelledby="plan-editor-title">
    <h2 id="plan-editor-title" ref={heading} tabIndex={-1}>{review ? 'Check and publish' : selected ? `Edit ${selected.displayName}` : 'New membership plan'}</h2>
    <form onSubmit={submit}><fieldset disabled={disabled}>
      {review ? <div className={styles.review}>
        <h3>{review.displayName}</h3>
        <p>{programName(review.programId)}{review.classesPerWeek ? ` · ${review.classesPerWeek} classes a week` : ''} · {review.availability === 'AVAILABLE' ? 'Offered to new students' : 'Not offered to new students'}</p>
        <ol className={styles.optionList}>{review.paymentOptions.map((o, i) => <li key={i}><strong>{o.label}</strong> {optionSummary({ ...o, payments: o.payments ?? null, termMonths: o.termMonths ?? null,
          downPaymentMinor: o.downPaymentMinor ?? null }, review.currency, money)}{o.checkoutEnabled ? '' : ' · not on checkout pages'}</li>)}</ol>
        {!!review.features?.length && <ul>{review.features.map(f => <li key={f}>{f}</li>)}</ul>}
        {review.description && <p>{review.description}</p>}
        <p>Publishing saves these as version {selected ? selected.version + 1 : 1}. People already on this plan keep the version they joined with. Nothing is charged.</p>
        <label className={styles.check}><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I checked this plan and want to publish it.</label>
        <div className={styles.actions}><button disabled={!confirmed}>{selected ? 'Publish changes' : 'Publish plan'}</button><button type="button" onClick={() => { setReview(null); setConfirmed(false); }}>Back to editing</button></div>
      </div> : <>
        <div className={styles.formGrid}>
          <label>Plan name<input required maxLength={120} placeholder="e.g. Little Tigers" value={fields.displayName} onChange={e => edit('displayName', e.target.value)} /></label>
          <label>Program<select aria-label="Program" value={fields.programId} onChange={e => edit('programId', e.target.value)}><option value="">No program</option>
            {fields.programId && !programs.some(p => p.programId === fields.programId) && <option value={fields.programId} disabled>Program no longer available, choose another</option>}
            {programs.map(p => <option key={p.programId} value={p.programId}>{p.name}</option>)}</select></label>
        </div>
        <section className={styles.optionsBox} aria-labelledby="payment-options-title">
          <div className={styles.optionsHead}><div><h3 id="payment-options-title">Payment options</h3><p>Offer more than one way to pay. Option 1 is the standard price.</p></div>
            <button type="button" disabled={options.length >= MEMBERSHIP_PLAN_SETUP_LIMITS.options} onClick={addOption}>Add option</button></div>
          {options.map((o, i) => <fieldset key={i} className={styles.option} aria-label={`Option ${i + 1}`}>
            <div className={styles.optionsHead}><strong>Option {i + 1}{i === 0 ? ' (standard)' : ''}</strong><span className={styles.actions}>
              {i > 0 && <button type="button" onClick={() => moveUp(i)}>Move up</button>}
              {options.length > 1 && <button type="button" onClick={() => removeOption(i)}>Remove option {i + 1}</button>}</span></div>
            <label>Option name<input maxLength={MEMBERSHIP_PLAN_SETUP_LIMITS.labelLength} placeholder="e.g. 6 monthly payments" value={o.label} onChange={e => editOption(i, { label: e.target.value })} /></label>
            <div className={styles.formGrid}>
              <label>Amount<input inputMode="decimal" placeholder="99.00" value={o.price} onChange={e => editOption(i, { price: e.target.value })} /></label>
              <label>How often<select aria-label="How often" value={o.billingFrequency} onChange={e => editOption(i, { billingFrequency: e.target.value as MembershipPaymentOptionFrequency })}>
                {MEMBERSHIP_PAYMENT_OPTION_FREQUENCIES.map(f => <option key={f} value={f} disabled={i === 0 && f === 'QUARTERLY'}>{OPTION_FREQUENCY_LABELS[f]}</option>)}</select></label>
              {o.billingFrequency !== 'PAID_IN_FULL' && <label>Number of payments<input inputMode="numeric" placeholder="Empty = ongoing" value={o.payments} onChange={e => editOption(i, { payments: e.target.value })} /></label>}
              <label>Length in months<input inputMode="numeric" placeholder={o.billingFrequency === 'PAID_IN_FULL' ? 'Required, e.g. 12' : 'Empty = ongoing'} value={o.termMonths} onChange={e => editOption(i, { termMonths: e.target.value })} /></label>
            </div>
            <label className={styles.check}><input type="checkbox" checked={o.checkoutEnabled} onChange={e => editOption(i, { checkoutEnabled: e.target.checked })} />Offer this option on checkout pages</label>
            <label className={styles.check}><input type="checkbox" checked={o.downPayment} onChange={e => editOption(i, { downPayment: e.target.checked })} />Down payment at sign-up</label>
            {o.downPayment && <label>Down payment amount<input inputMode="decimal" value={o.downPaymentPrice} onChange={e => editOption(i, { downPaymentPrice: e.target.value })} /></label>}
          </fieldset>)}
        </section>
        <div className={styles.formGrid}>
          <label>Classes per week<input inputMode="numeric" placeholder="e.g. 2" value={fields.classesPerWeek} onChange={e => edit('classesPerWeek', e.target.value)} /></label>
          <label>Offered to new students<select aria-label="Offered to new students" value={fields.availability} onChange={e => edit('availability', e.target.value)}><option value="AVAILABLE">Yes</option><option value="UNAVAILABLE">No, hide it</option></select></label>
        </div>
        <label>Description<textarea rows={2} maxLength={500} placeholder="Short description" value={fields.description} onChange={e => edit('description', e.target.value)} /></label>
        <label>Features (one per line)<textarea rows={3} placeholder={'2 classes a week\nBelt testing included'} value={fields.features} onChange={e => edit('features', e.target.value)} /></label>
        <details><summary>Plan code and currency</summary><div className={styles.formGrid}>
          <label>Plan code<input required pattern="[A-Z0-9][A-Z0-9_-]{0,39}" maxLength={40} readOnly={selected !== null} value={fields.planCode} onChange={e => edit('planCode', e.target.value.toUpperCase())} /><small>Made from the name. It can't change later.</small></label>
          <label>Currency<input required pattern="[A-Z]{3}" maxLength={3} value={fields.currency} onChange={e => edit('currency', e.target.value.toUpperCase())} /></label>
        </div></details>
        <div className={styles.actions}><button>Review plan</button><button type="button" onClick={onCancel}>Cancel</button></div>
      </>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </fieldset></form>
  </section>;
}
