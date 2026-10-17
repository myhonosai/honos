'use client';
import React, { useRef, useState, type FormEvent } from 'react';
import type { MembershipActivationContext } from '@hon/contracts';
import { activateKnownMembership, loadMembershipActivationContext, MembershipActivationError, type KnownMembership } from './membership-activation-http';
import styles from './billing-renewals-workbench.module.css';

type RetainedActivation = { scope: KnownMembership; expectedVersion: number; key: string };
export function MembershipActivationWorkbench(): React.ReactElement {
  const [scope, setScope] = useState<KnownMembership>({ organizationId: '', schoolId: '', membershipId: '' });
  const [current, setCurrent] = useState<MembershipActivationContext | null>(null);
  const [retained, setRetained] = useState<RetainedActivation | null>(null);
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const generation = useRef(0);
  function clear() { generation.current++; setCurrent(null); setRetained(null); setConfirmed(false); setBusy(false); setError(''); setNotice(''); }
  function edit(key: keyof KnownMembership, value: string) { clear(); setScope(old => ({ ...old, [key]: value })); }
  async function load(event: FormEvent) {
    event.preventDefault(); clear(); const run = generation.current; setBusy(true);
    try { const observed = await loadMembershipActivationContext(scope); if (run === generation.current) setCurrent(observed); }
    catch (e) { if (run === generation.current) setError(e instanceof Error ? e.message : 'Membership context is unavailable.'); }
    finally { if (run === generation.current) setBusy(false); }
  }
  async function activate(command: RetainedActivation) {
    const run = generation.current;
    setBusy(true); setError(''); setNotice(''); setRetained(command); setCurrent(null); setConfirmed(false);
    try {
      const saved = await activateKnownMembership(command.scope, command.expectedVersion, command.key);
      if (run !== generation.current) return;
      setRetained(null);
      setNotice(`Saved activation result: ACTIVE at version ${saved.membership.version}${saved.replayed ? ' (idempotent replay)' : ''}. Reload to observe current state. No agreement or billing outcome is claimed.`);
    } catch (e) {
      if (run !== generation.current) return;
      if (e instanceof MembershipActivationError && [400, 401, 403, 404, 409].includes(e.status)) setRetained(null);
      setError(e instanceof Error ? e.message : 'Unverified activation result. No activation is assumed.');
    } finally { if (run === generation.current) setBusy(false); }
  }
  return <main className={styles.page}>
    <nav><a href="/core">HON Core</a><a href="/staff/dashboard">Staff dashboard</a></nav>
    <header><p>DIRECT HUMAN STAFF · MEMBERSHIP LIFECYCLE</p><h1>Activate a known membership</h1><p>Activation only. Not a membership directory or owner-launch action.</p></header>
    <aside><strong>Membership, agreement, billing and payment authorization are independent.</strong>
      <p>A current DRAFT membership may be activated without an agreement signature, invoice or payment initiation. This command changes only membership state to ACTIVE and records canonical audit/outbox evidence.</p>
      <p>No billing schedule is created or activated. No invoice, payment method, charge, recurring-billing authorization, agreement sending or reminder occurs. Card collection never authorizes recurring billing.</p>
      <p>Agreement status, billing status and payer authorization are not read here. ACTIVE does not mean signed, paid or authorized for collection. Current billing.membership.activate permission and the existing billing entitlement are checked by the server.</p>
    </aside>
    <section><h2>One already-known membership</h2><p>Enter the known organization, school and membership IDs. The server authorizes the exact school and derives the current membership version; there is no search or list.</p>
      <form onSubmit={event => void load(event)}><fieldset disabled={busy || retained !== null}>
        {(['organizationId', 'schoolId', 'membershipId'] as const).map(key => <label key={key}>{key === 'organizationId' ? 'Organization ID' : key === 'schoolId' ? 'School ID' : 'Already-known membership ID'}<input required maxLength={36} value={scope[key]} onChange={event => edit(key, event.target.value)} /></label>)}
        <button type="submit">Load / refresh current membership</button>
      </fieldset></form>
    </section>
    {busy && <p role="status">Checking current human authority…</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {current && <section><h2>Current membership observation</h2><p>Membership {current.membershipId} · {current.state} · version {current.version}</p>
      {current.state === 'DRAFT' ? <><p>DRAFT is not ACTIVE. Only the observed version below can be submitted.</p>
        <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />I intend to activate this membership only, without starting billing or changing an agreement.</label>
        <button disabled={busy || !confirmed} onClick={() => void activate({ scope: { organizationId: current.organizationId, schoolId: current.schoolId, membershipId: current.membershipId }, expectedVersion: current.version, key: crypto.randomUUID() })}>Activate membership only</button>
      </> : <p>{current.state === 'ACTIVE' ? 'Already ACTIVE. No activation command is available.' : 'Only a current DRAFT membership can be activated. No command is available for this state.'} No agreement, payment or billing outcome is implied.</p>}
    </section>}
    {retained && <aside><p>The response is uncertain. No activation is assumed. The exact membership, version and idempotency key are retained in memory only; there is no automatic retry.</p>
      <button disabled={busy} onClick={() => void activate(retained)}>Retry exact retained activation</button>
      <button disabled={busy} onClick={clear}>Discard retained retry and reload current state</button>
    </aside>}
  </main>;
}
