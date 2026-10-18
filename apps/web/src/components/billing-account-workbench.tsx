'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { loadCurrentStaffReportingSchool, type CurrentStaffReportingSchool } from './current-staff-reporting-school-http';
import { loadStaffReportingSchools, type StaffReportingSchoolChoice, type StaffReportingSchools } from './staff-reporting-schools-http';
import {
  BillingAccountAccessError, BillingAccountCurrencyConflictError, BillingAccountRejectedError, BillingAccountUncertainError,
  prepareBillingAccountCommand, prepareBillingAccountPayerLookup, submitBillingAccountCommand, submitBillingAccountPayerLookup,
  type BillingAccountPayerChoice, type BillingAccountReceipt, type BillingAccountScope, type PreparedBillingAccountCommand,
} from './billing-account-workbench-http';
import styles from './staff-availability-workbench.module.css';

type ScopeState = 'RESOLVING' | 'SELECTION_REQUIRED' | 'READY' | 'UNAVAILABLE';
const reasonValid = (value: string): boolean => value.length >= 1 && value.length <= 500 && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** This page starts with no payer, account, request key, or command and stores nothing in the browser. */
export function BillingAccountWorkbench({ initialSourceContactPersonId }: { initialSourceContactPersonId?: string } = {}): React.ReactElement {
  const initialCandidate = typeof initialSourceContactPersonId === 'string' && UUID.test(initialSourceContactPersonId) ? initialSourceContactPersonId.toLowerCase() : '';
  const [scope, setScope] = useState<BillingAccountScope | null>(null);
  const [scopeState, setScopeState] = useState<ScopeState>('RESOLVING');
  const [scopeMessage, setScopeMessage] = useState('Resolving current staff billing scope…');
  const [schoolChoices, setSchoolChoices] = useState<StaffReportingSchoolChoice[]>([]);
  const [schoolChoiceId, setSchoolChoiceId] = useState('');
  const [query, setQuery] = useState('');
  const [sourceContactCandidate, setSourceContactCandidate] = useState(initialCandidate);
  const [payers, setPayers] = useState<BillingAccountPayerChoice[] | null>(null);
  const [payer, setPayer] = useState<BillingAccountPayerChoice | null>(null);
  const [currency, setCurrency] = useState('');
  const [normalConfirmed, setNormalConfirmed] = useState(false);
  const [additionalReason, setAdditionalReason] = useState('');
  const [additionalConfirmed, setAdditionalConfirmed] = useState(false);
  const [receipt, setReceipt] = useState<BillingAccountReceipt | null>(null);
  const [additionalAvailable, setAdditionalAvailable] = useState(false);
  const [retry, setRetry] = useState<PreparedBillingAccountCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const scopeEpoch = useRef(0);
  const commandEpoch = useRef(0);
  const active = useRef(false);
  const resolverRead = useRef<Promise<CurrentStaffReportingSchool> | null>(null);
  const selectorRead = useRef<Promise<StaffReportingSchools> | null>(null);

  function clearCommandFacts(clearOffer = true): void {
    setNormalConfirmed(false); setAdditionalConfirmed(false); setRetry(null); setReceipt(null);
    if (clearOffer) { setAdditionalAvailable(false); setAdditionalReason(''); }
  }
  function clearPayers(): void { setPayers(null); setPayer(null); }
  function resetDraft(clearSourceContactCandidate = false): void { commandEpoch.current++; clearPayers(); setQuery(''); setCurrency(''); clearCommandFacts(); if (clearSourceContactCandidate) setSourceContactCandidate(''); setError(''); }
  function accessLost(): void {
    scopeEpoch.current++; commandEpoch.current++; resolverRead.current = null; selectorRead.current = null; active.current = false;
    setScope(null); setScopeState('UNAVAILABLE'); setScopeMessage('Current human billing-account authority is unavailable. No school, payer or account is selected.');
    setSchoolChoices([]); setSchoolChoiceId(''); resetDraft(true); setBusy(false);
  }
  function editCommand(change: () => void): void {
    if (active.current) return;
    commandEpoch.current++; change(); clearCommandFacts(); setError('');
  }
  function editReason(value: string): void {
    if (active.current) return;
    commandEpoch.current++; setAdditionalReason(value); setAdditionalConfirmed(false); setRetry(null); setError('');
  }
  async function chooseScope(next: BillingAccountScope): Promise<void> {
    const generation = ++scopeEpoch.current;
    commandEpoch.current++; setScope(null); setScopeState('RESOLVING'); setScopeMessage('Verifying selected staff school for a later explicit billing-account read…');
    setSchoolChoiceId(''); resetDraft();
    // The reporting-school choice is an aid only. No account/payer read or command happens here.
    if (generation !== scopeEpoch.current) return;
    setScope(next); setScopeState('READY'); setScopeMessage('Choose a payer lookup query. The server independently authorizes billing.account.create before returning any current-school choices.');
  }
  useEffect(() => {
    let mounted = true; const generation = ++scopeEpoch.current;
    const current = (): boolean => mounted && generation === scopeEpoch.current;
    resolverRead.current ??= loadCurrentStaffReportingSchool();
    void resolverRead.current.then(async (resolved) => {
      if (!current()) return;
      if (resolved.state === 'RESOLVED') { await chooseScope({ organizationId: resolved.organizationId, schoolId: resolved.schoolId }); return; }
      selectorRead.current ??= loadStaffReportingSchools(); const options = await selectorRead.current;
      if (!current()) return;
      if (options.state === 'SELECTION_REQUIRED') {
        setScope(null); setScopeState('SELECTION_REQUIRED'); setSchoolChoices(options.schools); setSchoolChoiceId('');
        setScopeMessage('Choose one authorized reporting school before an explicit billing-account payer lookup. No school is selected automatically.');
      } else {
        setScope(null); setScopeState('UNAVAILABLE'); setSchoolChoices([]);
        setScopeMessage('A safe staff reporting-school selection is unavailable. No payer lookup or account command is available.');
      }
    }).catch(() => {
      if (!current()) return; setScope(null); setScopeState('UNAVAILABLE'); setSchoolChoices([]);
      setScopeMessage('Current staff billing scope is unavailable. No school, payer or account is selected.');
    });
    return () => { mounted = false; scopeEpoch.current++; };
  }, []);
  useEffect(() => {
    const leave = (): void => { accessLost(); };
    const visibility = (): void => { if (document.visibilityState === 'hidden') leave(); };
    window.addEventListener('pagehide', leave); window.addEventListener('blur', leave); document.addEventListener('visibilitychange', visibility);
    return () => { window.removeEventListener('pagehide', leave); window.removeEventListener('blur', leave); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  async function selectSchool(event: FormEvent): Promise<void> {
    event.preventDefault(); if (scopeState !== 'SELECTION_REQUIRED') return;
    const choice = schoolChoices.find(item => item.schoolId === schoolChoiceId);
    if (!choice) { setError('Choose an authorized reporting school before payer lookup.'); return; }
    await chooseScope({ organizationId: choice.organizationId, schoolId: choice.schoolId });
  }
  async function lookup(event: FormEvent): Promise<void> {
    event.preventDefault(); if (!scope || busy || query.length < 2 || query.length > 20 || query.trim() !== query) return;
    const generation = ++commandEpoch.current; setBusy(true); clearPayers(); clearCommandFacts(); setError('');
    try {
      const found = await submitBillingAccountPayerLookup(prepareBillingAccountPayerLookup(scope, query));
      if (generation === commandEpoch.current) setPayers(found);
    } catch (caught) {
      if (generation !== commandEpoch.current) return;
      if (caught instanceof BillingAccountAccessError) { accessLost(); return; }
      setError(caught instanceof Error ? caught.message : 'Payer lookup is unavailable. No payer was selected.');
    } finally { if (generation === commandEpoch.current) setBusy(false); }
  }
  function choosePayer(next: BillingAccountPayerChoice): void {
    if (active.current) return; commandEpoch.current++; setPayer(next); clearCommandFacts(); setError('');
  }
  async function send(command: PreparedBillingAccountCommand): Promise<void> {
    if (active.current) return;
    const generation = commandEpoch.current; active.current = true; setBusy(true); setRetry(null); setReceipt(null); setNormalConfirmed(false); setAdditionalConfirmed(false); setError('');
    try {
      const result = await submitBillingAccountCommand(command);
      if (generation === commandEpoch.current) { setReceipt(result); setAdditionalAvailable(result.account.reused); setAdditionalReason(''); }
    } catch (caught) {
      if (generation !== commandEpoch.current) return;
      if (caught instanceof BillingAccountAccessError) { accessLost(); return; }
      if (caught instanceof BillingAccountCurrencyConflictError) { setAdditionalAvailable(true); setAdditionalReason(''); setError(caught.message); }
      else if (caught instanceof BillingAccountUncertainError) { setRetry(command); setError(caught.message); }
      else setError(caught instanceof BillingAccountRejectedError ? caught.message : 'Billing-account command was rejected. No verified receipt is shown.');
    } finally { active.current = false; if (generation === commandEpoch.current) setBusy(false); }
  }
  function create(event: FormEvent, additional: boolean): void {
    event.preventDefault();
    if (!scope || !payer || busy || (additional ? !additionalConfirmed || !reasonValid(additionalReason) : !normalConfirmed)) return;
    try {
      const input = { responsiblePersonId: payer.id, ...(currency ? { currency } : {}), ...(additional ? { createAdditional: true, additionalReason } : {}) };
      // The sole key allocation is inside an explicit confirmation click.
      void send(prepareBillingAccountCommand(scope, input, crypto.randomUUID()));
    } catch { setError('The selected payer, uppercase currency, or documented additional-account reason is invalid. Nothing was submitted.'); }
  }
  const currencyValid = currency === '' || /^[A-Z]{3}$/.test(currency);
  const selectedName = payer?.displayName ?? '';
  return <main className={styles.page}>
    <nav aria-label="Staff navigation"><a href="/staff/dashboard">Staff dashboard</a><a href="/staff/command-center">Command Center</a></nav>
    <header><p>HON / DIRECT-HUMAN BILLING</p><h1>Billing account create or reuse</h1><p>Find one current-school responsible payer through an explicit bounded lookup, then confirm a canonical account request. The server decides whether a matching canonical account is reused. No entered value establishes authority.</p></header>
    <aside><strong>Account record only — no collection or responsibility transfer.</strong><p>This workbench cannot create a membership, invoice, payment method, payment schedule, charge, provider action, communication, automation, AI or Action Engine request. It does not collect financial credentials, merge accounts, transfer payer responsibility, or imply payment, enrollment, agreement or collection status.</p></aside>
    {sourceContactCandidate && <section aria-label="CRM source-contact candidate"><p><strong>CRM source-contact candidate:</strong> <code>{sourceContactCandidate}</code>. This untrusted reference is not a payer selection, responsible-person finding, family relationship, billing account, scope, currency, membership, payment authorization or command input. Use the separate explicit lookup below to obtain a server-authorized current-school payer choice.</p></section>}
    <section aria-labelledby="billing-account-scope"><h2 id="billing-account-scope">Current billing school</h2>
      {scopeState === 'SELECTION_REQUIRED' && <form onSubmit={(event) => void selectSchool(event)}><fieldset disabled={busy}><label>Authorized reporting school<select required autoComplete="off" value={schoolChoiceId} onChange={event => { resetDraft(); setSchoolChoiceId(event.target.value); }}><option value="">Choose a school…</option>{schoolChoices.map(choice => <option key={choice.schoolId} value={choice.schoolId}>{choice.schoolName} — {choice.organizationName}</option>)}</select></label><button disabled={!schoolChoiceId}>Use selected school</button></fieldset></form>}
      <p role="status">{scopeMessage}</p>
    </section>
    <section aria-labelledby="billing-account-payer"><h2 id="billing-account-payer">Find current-school responsible payer</h2><p>Enter 2–20 characters and explicitly request at most ten authorized current-school payer choices. No payer, account or directory is loaded automatically.</p>
      <form onSubmit={(event) => void lookup(event)}><fieldset disabled={busy || scopeState !== 'READY'}><label>Payer name query<input required autoComplete="off" maxLength={20} value={query} onChange={event => { commandEpoch.current++; setQuery(event.target.value); clearPayers(); clearCommandFacts(); setError(''); }} /></label><button disabled={!scope || query.length < 2 || query.length > 20 || query.trim() !== query}>Find payer choices</button></fieldset></form>
      {payers && <div aria-label="Current-school payer choices">{payers.length === 0 ? <p role="status">No current-school payer choice was returned for this explicit query.</p> : payers.map(choice => <button type="button" key={choice.id} disabled={busy} onClick={() => choosePayer(choice)}>Use {choice.displayName}</button>)}</div>}
      {payer && <p role="status">Selected payer: <strong>{selectedName}</strong>. This is a server-returned choice, not an account or financial fact.</p>}
    </section>
    <section aria-labelledby="billing-account-command"><h2 id="billing-account-command">Confirm canonical account request</h2><p>A normal request reuses an exact-currency canonical account when one exists; otherwise it creates the first canonical account. A conflicting currency is never changed silently.</p>
      <form onSubmit={event => create(event, false)}><fieldset disabled={busy || !payer || scopeState !== 'READY'}><label>Optional uppercase currency<input autoComplete="off" spellCheck={false} maxLength={3} placeholder="USD" value={currency} onChange={event => editCommand(() => setCurrency(event.target.value.toUpperCase()))} /></label><label className={styles.check}><input type="checkbox" checked={normalConfirmed} disabled={!payer || !currencyValid} onChange={event => setNormalConfirmed(event.target.checked)} />I explicitly confirm this payer/currency account create-or-reuse request only.</label><div className={styles.actions}><button disabled={!payer || !currencyValid || !normalConfirmed}>Confirm create or reuse billing account</button><button type="button" onClick={() => resetDraft(true)}>Discard billing-account draft</button></div></fieldset></form>
      {busy && <p role="status">Verifying the exact direct-human billing-account request…</p>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {retry && <section className={styles.warning}><strong>Outcome uncertain — no account receipt is assumed.</strong><p>Only the exact in-memory request body and idempotency key are retained. Nothing retries automatically. Editing a payer, currency or reason, discarding, access loss or leaving the page clears this retry.</p><button type="button" disabled={busy} onClick={() => void send(retry)}>Retry exact unchanged billing-account request</button></section>}
    </section>
    {additionalAvailable && <section aria-labelledby="billing-account-additional"><h2 id="billing-account-additional">Explicit additional account</h2><p>This option appears only after a normal canonical reuse or a canonical currency conflict. It creates a separate additional account for the same selected payer and never merges accounts or transfers responsibility.</p><form onSubmit={event => create(event, true)}><fieldset disabled={busy || !payer}><label>Documented business reason (1–500 characters)<textarea required autoComplete="off" maxLength={500} value={additionalReason} onChange={event => editReason(event.target.value)} /></label><label className={styles.check}><input type="checkbox" checked={additionalConfirmed} disabled={!reasonValid(additionalReason)} onChange={event => setAdditionalConfirmed(event.target.checked)} />I explicitly confirm a separate additional account with this documented reason.</label><button disabled={!reasonValid(additionalReason) || !additionalConfirmed}>Confirm additional billing account</button></fieldset></form></section>}
    {receipt && <section aria-label="Returned billing account receipt" className={styles.record}><h2>Returned billing account receipt</h2><p>{receipt.replayed ? 'Replayed command receipt.' : receipt.account.reused ? 'Canonical account reuse receipt.' : 'Billing account creation receipt.'} This is not a live payment, enrollment, membership, schedule, provider or collection status.</p><dl><dt>Billing account ID</dt><dd>{receipt.account.id}</dd><dt>Currency</dt><dd>{receipt.account.currency}</dd><dt>Classification</dt><dd>{receipt.account.classification}</dd><dt>Reused</dt><dd>{String(receipt.account.reused)}</dd></dl></section>}
    <p>All queries, choices, selected payer, confirmations, receipts and uncertainty-only retries are memory-only. Server authorization is rechecked for every lookup and command. Editing, discarding, access loss or leaving this view clears browser state; it never undoes a completed account command.</p>
  </main>;
}
