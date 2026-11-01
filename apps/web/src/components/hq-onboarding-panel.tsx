'use client';

import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { SchoolCreationController } from './hq-onboarding-controller';
import { HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT } from './session-invalidation';
import { useHqModern } from './hq-modern/shell';
import styles from './hq-onboarding-panel.module.css';

export function HqOnboardingPanel(): React.ReactElement {
  const [controller] = useState(() => new SchoolCreationController());
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const { view } = useHqModern();
  const announcement = state.busy ? 'Verifying current HQ access and request…'
    : state.receipt ? (state.receipt.replayed ? 'The original school creation receipt was verified by replay.' : 'The server school creation receipt was verified.')
      : state.access === 'signed-out' ? 'Sign in before verifying HQ access. School-creation details are hidden.'
        : state.access === 'forbidden' ? 'HQ-owner access could not be verified. School-creation details are hidden.'
          : state.access === 'unavailable' ? 'HQ access is unavailable. School-creation details are hidden.'
            : state.message || (state.concealed ? 'School-creation details are hidden. Verify HQ-owner access to continue.' : 'HQ-owner access verified. Review the details before creating a school.');
  useEffect(() => {
    controller.start();
    const visibility = () => { if (document.visibilityState === 'hidden') controller.conceal(); };
    const events = ['blur', 'pagehide', HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT];
    for (const event of events) window.addEventListener(event, controller.conceal);
    document.addEventListener('visibilitychange', visibility);
    return () => { controller.stop(); for (const event of events) window.removeEventListener(event, controller.conceal); document.removeEventListener('visibilitychange', visibility); };
  }, [controller]);
  return <section className={`${styles.panel} ${styles[`presentation_${view}`]}`} aria-labelledby="hq-school-create-title" data-school-create data-school-create-busy={state.busy}>
    <h2 id="hq-school-create-title">Create a school</h2>
    <p>Create an organization and its first school in HON OS. This requires separate HQ onboarding authority.</p>
    <p className={styles.policy}><strong>Provisioning policy: no operating access.</strong> New schools start with a SUSPENDED entitlement. Payment activation is separate. An HQ-owner exception requires an approved policy and verified eligibility. This form grants no subscription, payment or AI credits.</p>
    <p className={styles.announcement} role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
    {state.concealed ? <>
      <p>{state.access === 'signed-out' ? 'Sign in before verifying HQ access.' : state.access === 'forbidden' ? 'Current HQ-owner access could not be verified.' : state.access === 'unavailable' ? 'HQ access is unavailable.' : 'School-creation details are hidden. Explicitly verify HQ-owner access to open this form.'}</p>
      {state.access === 'signed-out' && <a href="/auth/login">Sign in to HON</a>}
      <button type="button" disabled={state.busy} onClick={() => void controller.authorize()}>Verify HQ-owner access</button>
    </> : state.receipt ? <section aria-labelledby="hq-school-created">
      <h3 id="hq-school-created">School creation receipt</h3>
      <p>{state.receipt.replayed ? 'The original creation request was replayed.' : 'The server confirmed school creation.'}</p>
      <dl><dt>Organization ID</dt><dd><code>{state.receipt.organizationId}</code></dd><dt>School ID</dt><dd><code>{state.receipt.schoolId}</code></dd></dl>
      <p>The receipt confirms creation IDs and replay status only. It does not verify current access, owner account setup, payment or onboarding completion.</p>
    </section> : <form onSubmit={event => { event.preventDefault(); void controller.submit(); }}>
      <fieldset disabled={state.busy || state.uncertain} className={styles.fields}><legend>Organization and first school</legend>
        {([['legalName', 'Legal organization name', 180], ['displayName', 'School-facing organization name', 120], ['schoolName', 'First school name', 120], ['schoolSlug', 'School slug', 80], ['timezone', 'School timezone', 64]] as const).map(([key, label, maxLength]) => <label key={key}>{label}<input name={key} required maxLength={maxLength} value={state.form[key]} pattern={key === 'schoolSlug' ? '[a-z0-9]+(-[a-z0-9]+)*' : undefined} onChange={event => controller.edit(key, event.target.value)} /></label>)}
      </fieldset>
      <p className={styles.note}>HON OS is one product. Creation does not select a priced plan or grant operating access.</p>
      {state.uncertain && <p>An unverified request is retained. Fields are locked so the retry uses the original owner, payload and idempotency key. Keep this page open until a receipt is verified; leaving or reloading loses the in-memory retry.</p>}
      <label className={styles.confirm}><input type="checkbox" disabled={state.busy} checked={state.confirmed} onChange={event => controller.confirm(event.target.checked)} />{state.uncertain ? 'I reviewed the retained details and confirm retrying exactly this school-creation request.' : 'I reviewed these details and confirm creating this organization and first school without operating access.'}</label>
      <button type="submit" disabled={state.busy || !state.confirmed}>{state.uncertain ? 'Retry exact creation request' : 'Create school'}</button>
    </form>}
    {state.busy && <p>Verifying the request…</p>}
    {state.message && <p>{state.message}</p>}
  </section>;
}
