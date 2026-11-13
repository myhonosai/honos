'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import type { CreateInvoiceDraftInput, Iso4217Currency } from '@hon/contracts';
import {
  InvoiceAccessError, InvoiceUncertainError, prepareInvoiceDraft, prepareInvoiceIssue, submitInvoiceCommand, validateInvoiceDraft,
  type DraftInvoiceReceipt, type InvoiceReceipt, type PreparedInvoiceCommand,
} from './invoice-workbench-http';
import styles from './attendance-workbench.module.css';
import { InvoicePickers, amountToMinor, endOfSchoolDay, formatMinor } from './invoice-pickers';

type Fields = { organizationId: string; schoolId: string; billingAccountId: string; membershipId: string; currency: string; subtotalMinor: string; dueAt: string; amountText: string; dueDate: string };
const EMPTY: Fields = { organizationId: '', schoolId: '', billingAccountId: '', membershipId: '', currency: '', subtotalMinor: '', dueAt: '', amountText: '', dueDate: '' };
export type InvoiceShellScope = Readonly<{ organizationId: string; schoolId: string }>;

/** With a shell school, the school comes from the shell and the currency defaults to USD; a pick made at another school is dropped. */
export function shellInvoiceFields(fields: Fields, shellScope: InvoiceShellScope | null): Fields {
  if (!shellScope) return fields;
  const moved = fields.schoolId !== '' && fields.schoolId.toLowerCase() !== shellScope.schoolId.toLowerCase();
  const currency = fields.currency || 'USD';
  // The amount is typed in the currency's own units, so it is re-derived whenever the currency changes.
  return { ...fields, organizationId: shellScope.organizationId, schoolId: shellScope.schoolId, currency, subtotalMinor: amountToMinor(fields.amountText, currency) ?? 'invalid',
    ...(moved ? { billingAccountId: '', membershipId: '', dueAt: '', dueDate: '' } : {}) };
}
const ID_LABELS = { organizationId: 'Organization UUID', schoolId: 'School UUID', billingAccountId: 'Known billing account UUID', membershipId: 'Known linked membership UUID (optional)' };
function input(fields: Fields): CreateInvoiceDraftInput {
  if (!/^(0|[1-9]\d{0,9})$/.test(fields.subtotalMinor)) throw new Error('A bounded minor-unit integer is required.');
  return { billingAccountId: fields.billingAccountId, ...(fields.membershipId ? { membershipId: fields.membershipId } : {}),
    currency: fields.currency as Iso4217Currency, subtotalMinor: Number(fields.subtotalMinor), dueAt: fields.dueAt };
}

export function InvoiceWorkbench({ shellScope = null }: { shellScope?: InvoiceShellScope | null } = {}): React.ReactElement {
  const [rawFields, setFields] = useState<Fields>(EMPTY);
  const fields = shellInvoiceFields(rawFields, shellScope);
  const [createConfirmed, setCreateConfirmed] = useState(false);
  const [issueConfirmed, setIssueConfirmed] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<InvoiceReceipt | null>(null);
  const [retry, setRetry] = useState<PreparedInvoiceCommand | null>(null);
  const [error, setError] = useState('');
  const active = useRef(false);
  const submitted = useRef(false);
  const currentReceipt = useRef<InvoiceReceipt | null>(null);
  const retained = useRef<PreparedInvoiceCommand | null>(null);
  const mounted = useRef(true);
  const epoch = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; epoch.current++; retained.current = null; currentReceipt.current = null; };
  }, []);
  const renderEpoch = epoch.current;
  let valid = false;
  try { validateInvoiceDraft({ organizationId: fields.organizationId, schoolId: fields.schoolId }, input(fields)); valid = true; } catch { /* local syntax only */ }

  function clearFacts(): void {
    retained.current = null; currentReceipt.current = null;
    setReceipt(null); setRetry(null); setCreateConfirmed(false); setIssueConfirmed(false);
  }
  function edit(change: () => void): void {
    if (active.current || !mounted.current) return;
    epoch.current++; change(); submitted.current = false; clearFacts(); setAttempted(false); setError('');
  }
  function discard(): void { edit(() => setFields(EMPTY)); }
  async function send(command: PreparedInvoiceCommand): Promise<void> {
    if (active.current || !mounted.current) return;
    const generation = epoch.current;
    active.current = true; submitted.current = true; retained.current = null; currentReceipt.current = null;
    setBusy(true); setAttempted(true); setReceipt(null); setRetry(null); setCreateConfirmed(false); setIssueConfirmed(false); setError('');
    try {
      const result = await submitInvoiceCommand(command);
      if (mounted.current && generation === epoch.current) { currentReceipt.current = result; setReceipt(result); }
    } catch (caught) {
      if (!mounted.current || generation !== epoch.current) return;
      if (caught instanceof InvoiceAccessError) {
        epoch.current++; submitted.current = false; clearFacts(); setFields(EMPTY); setAttempted(false);
      } else if (caught instanceof InvoiceUncertainError) { retained.current = command; setRetry(command); }
      else clearFacts();
      // Never echo response/problem/network details or an unverified fact.
      setError(caught instanceof InvoiceAccessError || caught instanceof InvoiceUncertainError ? caught.message
        : 'Invoice command rejected or conflicted. Receipt and retry were cleared. Edit inputs or discard before a new explicitly confirmed draft attempt.');
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function create(event: FormEvent): void {
    event.preventDefault();
    if (active.current || submitted.current || !mounted.current || renderEpoch !== epoch.current || !createConfirmed) return;
    try {
      const scope = { organizationId: fields.organizationId, schoolId: fields.schoolId };
      const body = input(fields); validateInvoiceDraft(scope, body);
      void send(prepareInvoiceDraft(scope, body, crypto.randomUUID()));
    } catch { setError('Enter only exact known UUIDs, an uppercase ISO currency, subtotal 0–2147483647 minor units and a timezone-qualified due timestamp. Nothing was submitted.'); }
  }
  function issue(event: FormEvent, draft: DraftInvoiceReceipt): void {
    event.preventDefault();
    if (active.current || !mounted.current || renderEpoch !== epoch.current || !issueConfirmed || currentReceipt.current !== draft) return;
    try { void send(prepareInvoiceIssue(draft, crypto.randomUUID())); }
    catch { clearFacts(); setError('The verified in-memory DRAFT receipt is unavailable. No issue was submitted; start a new explicit draft attempt.'); }
  }
  function retryExact(command: PreparedInvoiceCommand): void {
    if (active.current || retained.current !== command || !mounted.current) return;
    void send(command);
  }

  return <main className={styles.page}>
    <nav aria-label="Staff navigation"><a href="/staff/dashboard">Staff dashboard</a><a href="/staff/command-center">Command Center</a></nav>
    <header><p>HON / DIRECT-HUMAN BILLING</p><h1>Human invoice workbench</h1>
      <p>Create one canonical DRAFT invoice, then separately confirm issuance of only its verified in-memory receipt. {shellScope ? 'Choose who the invoice is for from your school’s memberships, then enter the amount and due date. Every invoice of this school, including drafts that still need issuing, is listed below.' : 'This page starts blank and idle: no invoice/account/payer/membership directory, list, search or current-status read.'}</p>
    </header>
    <aside><strong>Invoice record only — issuing is not delivery or collection.</strong>
      <p>Neither command creates payment authorization or a payment attempt, checkout or card capture, a recurring schedule, provider execution or reconciliation, a financial adjustment, refund, credit or discount, an agreement, a membership change, communications, schedule or attendance changes, or any provider, AI, Action Engine or automation effect.</p>
      <p>Exact known IDs are untrusted selectors, not authority. Existing current human scope, permissions <code>billing.invoice.create</code> / <code>billing.invoice.issue</code>, entitlement, tenant RLS, billing-account currency and linked-membership checks remain decisive. Issuance independently rechecks the current DRAFT state and returned version.</p>
    </aside>
    <section aria-labelledby="invoice-create"><h2 id="invoice-create">Create one DRAFT invoice</h2>
      <p>{shellScope ? 'Choosing a membership fills its billing account and links the membership.' : 'Use only IDs already known through an authorized staff workflow.'} Total, discount, status, version and audit attribution are server-owned. Earlier drafts are in the school's invoice list below, where they can be issued.</p>
      <form onSubmit={create}><fieldset disabled={busy}>
        {shellScope ? <div className={styles.scopeGrid}>
          <InvoicePickers scope={shellScope} membershipId={fields.membershipId} amount={fields.amountText} currency={fields.currency} dueDate={fields.dueDate} disabled={busy}
            onPick={item => edit(() => setFields({ ...fields, billingAccountId: item.billingAccountId, membershipId: item.membershipId }))}
            onAmount={text => edit(() => setFields({ ...fields, amountText: text }))}
            onDueDate={(date, zone) => edit(() => setFields({ ...fields, dueDate: date, dueAt: endOfSchoolDay(date, zone) ?? '' }))}/>
          <label>Currency<input name="currency" required autoComplete="off" spellCheck={false} maxLength={3} value={fields.currency} onChange={event => edit(() => setFields({ ...fields, currency: event.target.value }))} /></label>
        </div> : <div className={styles.scopeGrid}>{(Object.keys(ID_LABELS) as (keyof typeof ID_LABELS)[]).map(name =>
          <label key={name}>{ID_LABELS[name]}<input name={name} required={name !== 'membershipId'} autoComplete="off" spellCheck={false} maxLength={36} value={fields[name]} onChange={event => edit(() => setFields({ ...fields, [name]: event.target.value }))} /></label>)}
          <label>ISO 4217 currency<input name="currency" required autoComplete="off" spellCheck={false} maxLength={3} placeholder="USD" value={fields.currency} onChange={event => edit(() => setFields({ ...fields, currency: event.target.value }))} /></label>
          <label>Subtotal (minor-unit integer)<input name="subtotalMinor" required autoComplete="off" inputMode="numeric" maxLength={10} placeholder="0–2147483647" value={fields.subtotalMinor} onChange={event => edit(() => setFields({ ...fields, subtotalMinor: event.target.value }))} /></label>
          <label>Due at (ISO timestamp with timezone)<input name="dueAt" required autoComplete="off" spellCheck={false} maxLength={40} placeholder="2030-05-01T09:15:30-07:00" value={fields.dueAt} onChange={event => edit(() => setFields({ ...fields, dueAt: event.target.value }))} /></label>
        </div>}
        <label className={styles.check}><input name="createConfirmed" type="checkbox" checked={createConfirmed} disabled={!valid || attempted} onChange={event => setCreateConfirmed(event.target.checked)} />I explicitly confirm creation of this exact DRAFT invoice only, not issuance.</label>
        <div className={styles.actions}><button type="submit" disabled={!valid || !createConfirmed || attempted}>Create DRAFT invoice</button><button type="button" onClick={discard}>Discard inputs / start over</button></div>
      </fieldset></form>
      {busy && <p role="status">Verifying the exact human invoice command…</p>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {retry && <div className={styles.warning}><strong>Outcome uncertain — no receipt is assumed.</strong><p>Only the exact {retry.operation === 'CREATE' ? 'draft-create' : 'issue'} path, body and idempotency key remain in memory. Nothing retries automatically. An input edit, discard or reload removes this retry but cannot undo a command that may already have succeeded. Seek authorized staff review before a different attempt; the school's invoice list below shows whether it was created or issued.</p><button type="button" disabled={busy} onClick={() => retryExact(retry)}>Retry exact unchanged invoice command</button></div>}
      {!receipt && !busy && <p className={styles.empty}>No verified invoice receipt is shown.</p>}
    </section>
    {receipt && <section aria-label="Returned invoice receipt" className={styles.record}>
      <h2>Returned invoice receipt: {receipt.invoice.status}</h2>
      <p>{receipt.replayed ? 'Replayed command receipt.' : 'Recorded command receipt.'} This is an exact command-response snapshot, not a live invoice or payment status.</p>
      <dl>
        <dt>Invoice UUID</dt><dd>{receipt.invoice.id}</dd>
        <dt>Billing account UUID</dt><dd>{receipt.invoice.billingAccountId}</dd>
        {receipt.invoice.membershipId && <><dt>Linked membership UUID</dt><dd>{receipt.invoice.membershipId}</dd></>}
        <dt>Returned total</dt><dd>{formatMinor(receipt.invoice.totalMinor, receipt.invoice.currency)}</dd>
        <dt>Returned currency</dt><dd>{receipt.invoice.currency}</dd>
        <dt>Returned subtotal (minor units)</dt><dd>{receipt.invoice.subtotalMinor}</dd>
        <dt>Returned discount (minor units)</dt><dd>{receipt.invoice.discountMinor}</dd>
        <dt>Returned total (minor units)</dt><dd>{receipt.invoice.totalMinor}</dd>
        <dt>Returned due at</dt><dd>{receipt.invoice.dueAt}</dd>
        <dt>Returned version</dt><dd>{receipt.invoice.version}</dd>
        <dt>Created at</dt><dd>{receipt.invoice.createdAt}</dd>
      </dl>
      {receipt.invoice.status === 'DRAFT' && <form onSubmit={event => issue(event, receipt as DraftInvoiceReceipt)}><fieldset disabled={busy}>
        <h3>Separately issue only this verified DRAFT</h3><p>The sole issue body is the returned expected version; its route comes only from this receipt's invoice UUID. A new idempotency key is generated only on your explicit issue submit. No delivery, collection or payment action follows.</p>
        <label className={styles.check}><input name="issueConfirmed" type="checkbox" checked={issueConfirmed} onChange={event => setIssueConfirmed(event.target.checked)} />I explicitly confirm issuing only this verified DRAFT invoice record, with no downstream effect.</label>
        <button type="submit" disabled={!issueConfirmed}>Issue verified DRAFT invoice</button>
      </fieldset></form>}
      {receipt.invoice.status === 'ISSUED' && <p>ISSUED is only the returned invoice record status. It does not mean sent, delivered, collected, authorized, attempted or paid. No further issue action is available.</p>}
    </section>}
    <p>All inputs, receipts and uncertainty-only retries are memory-only. Edits reset facts and confirmations; 401/403 clears all. Definite rejection or conflict discards the invalid receipt and retry and requires a new explicit attempt. No storage, polling, automatic action or historic recovery exists here.</p>
    <p>Editing, discarding or reloading does not cancel or undo an already created or issued invoice. Review any lost or uncertain outcome through a separately authorized staff process before another draft attempt.</p>
  </main>;
}
