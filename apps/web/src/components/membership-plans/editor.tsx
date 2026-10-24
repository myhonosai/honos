'use client';
import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  MEMBERSHIP_PLAN_BILLING_FREQUENCIES, MEMBERSHIP_PLAN_TERM_KINDS, MEMBERSHIP_PLAN_CHANGE_CONFIRMATION,
  validateCreateMembershipPlanInput, validateReviseMembershipPlanInput,
  type MembershipPlanListing, type MembershipPlanProgramOption, type CreateMembershipPlanInput, type ReviseMembershipPlanInput,
} from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { createPlanRequest, revisePlanRequest, type PlanRequest, type PlanScope } from './http';
import { FREQUENCY_LABELS, priceMinorFromText, priceTextFromMinor, planTerm } from './presentation';
import styles from './plans.module.css';

export function MembershipPlanEditor({ scope, selected, programs, disabled, onPublish, onCancel }: {
  scope: PlanScope; selected: MembershipPlanListing | null; programs: MembershipPlanProgramOption[]; disabled: boolean;
  onPublish(request: PlanRequest): void; onCancel(): void;
}): React.ReactElement {
  const { money } = useLocale();
  const [fields, setFields] = useState({ planCode: selected?.planCode ?? '', displayName: selected?.displayName ?? '', description: selected?.description ?? '',
    programId: selected?.programId ?? '', availability: selected?.availability ?? 'AVAILABLE', currency: selected?.currency ?? 'USD',
    price: selected ? priceTextFromMinor(selected.priceMinor, selected.currency) : '', billingFrequency: selected?.billingFrequency ?? 'MONTHLY',
    termKind: selected?.termKind ?? 'OPEN_ENDED', termMonths: selected?.termMonths === null || !selected ? '' : String(selected.termMonths) });
  const [review, setReview] = useState<CreateMembershipPlanInput | ReviseMembershipPlanInput | null>(null);
  const [confirmed, setConfirmed] = useState(false), [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => { heading.current?.focus(); }, [review]);
  function edit(key: keyof typeof fields, value: string): void { setFields(f => ({ ...f, [key]: value })); setReview(null); setConfirmed(false); setError(''); }
  function submit(event: FormEvent): void {
    event.preventDefault(); if (disabled) return;
    if (review) {
      if (!confirmed) return;
      onPublish(selected
        ? revisePlanRequest(scope, selected.planId, validateReviseMembershipPlanInput(review), crypto.randomUUID())
        : createPlanRequest(scope, validateCreateMembershipPlanInput(review), crypto.randomUUID()));
      return;
    }
    try {
      if (fields.programId && !programs.some(p => p.programId === fields.programId)) throw new Error('Choose a currently available school program, or no assigned program.');
      const terms = { displayName: fields.displayName.trim(), description: fields.description.trim() || null, programId: fields.programId || null,
        availability: fields.availability, currency: fields.currency, priceMinor: priceMinorFromText(fields.price, fields.currency), billingFrequency: fields.billingFrequency,
        termKind: fields.termKind, termMonths: fields.termKind === 'FIXED_MONTHS' ? Number(fields.termMonths) : null, confirmation: MEMBERSHIP_PLAN_CHANGE_CONFIRMATION };
      let input: CreateMembershipPlanInput | ReviseMembershipPlanInput;
      try { input = selected ? validateReviseMembershipPlanInput({ ...terms, expectedVersion: selected.version }) : validateCreateMembershipPlanInput({ ...terms, planCode: fields.planCode }); }
      catch { throw new Error('Review the required fields. Paid in full needs a fixed term of 1–60 months; an annual fixed term must be a whole number of years.'); }
      setReview(input); setConfirmed(false); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Review the plan fields.'); }
  }
  return <section className={styles.panel} aria-labelledby="plan-editor-title">
    <h2 id="plan-editor-title" ref={heading} tabIndex={-1}>{review ? 'Review published terms' : selected ? `Revise ${selected.displayName}` : 'Create membership plan'}</h2>
    <form onSubmit={submit}><fieldset disabled={disabled}>
      {review ? <div className={styles.review}>
        <h3>{review.displayName}</h3><p><strong>{money(review.priceMinor, review.currency)}</strong> {review.currency} · {FREQUENCY_LABELS[review.billingFrequency]} · {planTerm({ termKind: review.termKind, termMonths: review.termMonths ?? null })}</p>
        <dl><dt>Permanent plan code</dt><dd>{selected?.planCode ?? fields.planCode}</dd><dt>Version to publish</dt><dd>{selected ? selected.version + 1 : 1}</dd>
          <dt>Program</dt><dd>{programs.find(p => p.programId === review.programId)?.name ?? 'No program assigned'}</dd>
          <dt>Availability</dt><dd>{review.availability === 'AVAILABLE' ? 'Available for new enrollment' : 'Unavailable for new enrollment'}</dd>
          <dt>Description</dt><dd>{review.description ?? 'No description'}</dd></dl>
        <p>Publishing records these terms for new selections. Existing memberships keep their original plan version. No agreement, payment schedule or charge is created.</p>
        <label className={styles.check}><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I reviewed these terms and confirm publishing this plan version.</label>
        <div className={styles.actions}><button disabled={!confirmed}>{selected ? 'Publish new version' : 'Publish plan'}</button><button type="button" onClick={() => { setReview(null); setConfirmed(false); }}>Edit details</button></div>
      </div> : <>
        <div className={styles.formGrid}>
          <label>Plan name<input required maxLength={120} value={fields.displayName} onChange={e => edit('displayName', e.target.value)} /></label>
          <label>Plan code<input required pattern="[A-Z0-9][A-Z0-9_-]{0,39}" maxLength={40} readOnly={selected !== null} value={fields.planCode} onChange={e => edit('planCode', e.target.value.toUpperCase())} /><small>The code is permanent. Use letters, digits, hyphens or underscores.</small></label>
          <label>School program<select aria-label="School program" value={fields.programId} onChange={e => edit('programId', e.target.value)}><option value="">No program assigned</option>
            {fields.programId && !programs.some(p => p.programId === fields.programId) && <option value={fields.programId} disabled>Current program unavailable — choose another option</option>}
            {programs.map(p => <option key={p.programId} value={p.programId}>{p.name}</option>)}</select></label>
          <label>Availability<select aria-label="Availability" value={fields.availability} onChange={e => edit('availability', e.target.value)}><option value="AVAILABLE">Available</option><option value="UNAVAILABLE">Unavailable</option></select></label>
          <label>Currency<input required pattern="[A-Z]{3}" maxLength={3} value={fields.currency} onChange={e => edit('currency', e.target.value.toUpperCase())} /><small>Changing currency does not convert a price or update existing memberships.</small></label>
          <label>Published price<input required inputMode="decimal" value={fields.price} onChange={e => edit('price', e.target.value)} /><small>{fields.billingFrequency === 'PAID_IN_FULL' ? 'One price for the whole fixed term.' : 'Price per billing period.'} Use a decimal point where needed.</small></label>
          <label>Billing frequency<select aria-label="Billing frequency" value={fields.billingFrequency} onChange={e => edit('billingFrequency', e.target.value)}>{MEMBERSHIP_PLAN_BILLING_FREQUENCIES.map(f => <option key={f} value={f}>{FREQUENCY_LABELS[f]}</option>)}</select></label>
          <label>Membership term<select aria-label="Membership term" value={fields.termKind} onChange={e => edit('termKind', e.target.value)}>{MEMBERSHIP_PLAN_TERM_KINDS.map(k => <option key={k} value={k}>{k === 'FIXED_MONTHS' ? 'Fixed number of months' : 'Open ended'}</option>)}</select></label>
          {fields.termKind === 'FIXED_MONTHS' && <label>Term in months<input type="number" required min={1} max={60} step={1} value={fields.termMonths} onChange={e => edit('termMonths', e.target.value)} /></label>}
        </div>
        <label>Description<textarea rows={3} maxLength={500} value={fields.description} onChange={e => edit('description', e.target.value)} /></label>
        <p>Paid-in-full plans require a fixed term. An annual fixed term must be a whole number of years. Discounts, fees, agreements, taxes and payment schedules are managed separately and are unavailable here.</p>
        <button>Review plan</button>
      </>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <p><button type="button" onClick={onCancel}>Cancel editing</button></p>
    </fieldset></form>
  </section>;
}
