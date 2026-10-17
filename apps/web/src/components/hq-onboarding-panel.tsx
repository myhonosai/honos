'use client';

import { FormEvent, useEffect, useState } from 'react';
import { DEFAULT_PUBLIC_PLAN_TIER, PUBLIC_PLAN_CATALOG, type PublicPlanTier } from '@hon/config';

type AccessState = 'checking' | 'available' | 'signed-out' | 'forbidden' | 'unavailable';
type FormState = { kind: 'idle' } | { kind: 'submitting' } | { kind: 'success'; organizationId: string; schoolId: string } | { kind: 'error'; message: string };

const initialForm: { legalName: string; displayName: string; schoolName: string; schoolSlug: string; timezone: string; initialTier: PublicPlanTier } = {
  legalName: '',
  displayName: '',
  schoolName: '',
  schoolSlug: '',
  timezone: 'America/Los_Angeles',
  initialTier: DEFAULT_PUBLIC_PLAN_TIER,
};

export function HqOnboardingPanel(): React.ReactElement {
  const [access, setAccess] = useState<AccessState>('checking');
  const [form, setForm] = useState(initialForm);
  const [state, setState] = useState<FormState>({ kind: 'idle' });

  useEffect(() => {
    fetch('/api/v1/hq/session', { cache: 'no-store' })
      .then((response) => setAccess(response.ok ? 'available' : response.status === 401 ? 'signed-out' : response.status === 403 ? 'forbidden' : 'unavailable'))
      .catch(() => setAccess('unavailable'));
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ kind: 'submitting' });
    try {
      const response = await fetch('/api/v1/hq/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(form),
      });
      const payload = await response.json() as { data?: { organizationId?: string; schoolId?: string }; detail?: string; message?: string };
      if (!response.ok || !payload.data?.organizationId || !payload.data.schoolId) throw new Error(payload.detail ?? payload.message ?? 'HON could not provision the organization.');
      setState({ kind: 'success', organizationId: payload.data.organizationId, schoolId: payload.data.schoolId });
    } catch (error) {
      setState({ kind: 'error', message: error instanceof Error ? error.message : 'HON could not provision the organization.' });
    }
  }

  if (access === 'checking') return <section className="hq-provisioning"><p>ONBOARDING</p><h2>Checking governed HQ access…</h2></section>;
  if (access === 'signed-out') return <section className="hq-provisioning"><p>ONBOARDING</p><h2>Sign in before onboarding a school.</h2><a className="hq-launch" href="/auth/login">Sign in with Manus <span>→</span></a></section>;
  if (access === 'forbidden') return <section className="hq-provisioning"><p>ONBOARDING</p><h2>This account has no HQ onboarding authority.</h2><small>HON keeps school provisioning unavailable until a separate HQ role grants it.</small></section>;
  if (access === 'unavailable') return <section className="hq-provisioning"><p>ONBOARDING</p><h2>HQ access could not be verified.</h2><small>HON fails closed; no tenant will be created until the access gate is healthy.</small></section>;
  if (state.kind === 'success') return <section className="hq-provisioning hq-provisioning-success"><p>ONBOARDING COMPLETE</p><h2>School tenant provisioned through the HQ security boundary.</h2><small>Organization: <code>{state.organizationId}</code><br />School: <code>{state.schoolId}</code></small></section>;

  return <section className="hq-provisioning">
    <div><p>ONBOARD A SCHOOL</p><h2>Create an organization, its first school, and a scoped School Owner grant.</h2><small>This creates live tenant topology, append-only audit evidence, and a transactional outbox event. It does not create cross-school access.</small></div>
    <form onSubmit={submit} className="hq-onboarding-form">
      <label>Legal organization name<input required maxLength={180} value={form.legalName} onChange={(event) => setForm({ ...form, legalName: event.target.value })} placeholder="Example Martial Arts LLC" /></label>
      <label>School-facing name<input required maxLength={120} value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="Example Martial Arts" /></label>
      <label>First school name<input required maxLength={120} value={form.schoolName} onChange={(event) => setForm({ ...form, schoolName: event.target.value })} placeholder="Example Martial Arts — Main" /></label>
      <label>School slug<input required maxLength={80} pattern="[a-z0-9]+(-[a-z0-9]+)*" value={form.schoolSlug} onChange={(event) => setForm({ ...form, schoolSlug: event.target.value.toLowerCase() })} placeholder="example-main" /></label>
      <label>School timezone<input required maxLength={64} value={form.timezone} onChange={(event) => setForm({ ...form, timezone: event.target.value })} placeholder="America/Los_Angeles" /></label>
      <label>Initial HON tier<select value={form.initialTier} onChange={(event) => setForm({ ...form, initialTier: event.target.value as PublicPlanTier })}>{PUBLIC_PLAN_CATALOG.map((plan) => <option key={plan.tier} value={plan.tier}>{plan.displayName} — ${plan.monthlyDisplayPriceUsd}/month · {plan.premiumAiCreditPlanningAllowance.toLocaleString()} premium AI credit planning allowance</option>)}</select></label>
      <small className="hq-plan-catalog-note">Core and Complete values are non-binding public display metadata and planning allowances. This governed tenant-provisioning request does not activate live billing or an offer, create a subscription, issue an invoice, charge a payment, or grant credits.</small>
      <button type="submit" disabled={state.kind === 'submitting'}>{state.kind === 'submitting' ? 'Provisioning securely…' : 'Provision school tenant →'}</button>
      {state.kind === 'error' ? <output className="hq-form-error">{state.message}</output> : null}
    </form>
  </section>;
}
