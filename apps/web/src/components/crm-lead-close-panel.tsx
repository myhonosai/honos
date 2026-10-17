'use client';

import React, { useRef, useState, type FormEvent } from 'react';
import type { LeadListItem } from '@hon/contracts';
import { CrmLeadCloseUncertainError, prepareCrmLeadClose, submitCrmLeadClose, type CrmLeadCloseResult, type PreparedCrmLeadClose } from './crm-lead-close-http';

/** Mounted only by an independently loaded live OPEN row, never by query selectors. */
export function CrmLeadClosePanel({ row, organizationId, schoolId, onStarted, onBusy, onCancel }: {
  row: LeadListItem; organizationId: string; schoolId: string;
  onStarted: () => void; onBusy: (busy: boolean) => void; onCancel: () => void;
}): React.ReactElement {
  const [choice, setChoice] = useState<'' | 'WON' | 'LOST'>('');
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const [attempted, setAttempted] = useState(false);
  const [retry, setRetry] = useState<PreparedCrmLeadClose | null>(null);
  const [result, setResult] = useState<CrmLeadCloseResult | null>(null);
  const [error, setError] = useState('');

  async function send(request: PreparedCrmLeadClose): Promise<void> {
    if (active.current) return;
    active.current = true; setBusy(true); onBusy(true); onStarted(); setAttempted(true); setRetry(null); setError('');
    try { setResult(await submitCrmLeadClose(request)); }
    catch (e) { setError(e instanceof Error ? e.message : 'No verified close receipt.'); if (e instanceof CrmLeadCloseUncertainError) setRetry(request); }
    finally { active.current = false; setBusy(false); onBusy(false); }
  }
  function submit(event: FormEvent): void {
    event.preventDefault();
    if (busy || attempted || !confirmed || !choice || row.status !== 'OPEN') return;
    try {
      const request = prepareCrmLeadClose(organizationId,schoolId,row,{ status: choice, expectedVersion: row.version, ...(note.trim() ? { closeNote: note.trim() } : {}) },crypto.randomUUID());
      void send(request);
    } catch (e) { setError(e instanceof Error ? e.message : 'Invalid close command.'); }
  }
  return <section aria-label="Close selected CRM lead">
    <h2>Close CRM lead only</h2><p>Selected lead <code>{row.id}</code> · authorized OPEN row v{row.version}. The server independently rechecks current staff authority, OPEN state and version.</p>
    <p>WON and LOST are internal CRM terminal states only, not enrollment, membership, payment, revenue or conversion facts. Nothing is sent and no trial conclusion is recorded.</p>
    <form onSubmit={submit}><fieldset disabled={busy || attempted}>
      <label>CRM close choice<select required value={choice} onChange={e => { setChoice(e.target.value as '' | 'WON' | 'LOST'); setConfirmed(false); setError(''); }}><option value="">Choose exactly WON or LOST</option><option value="WON">WON — CRM-only</option><option value="LOST">LOST — CRM-only</option></select></label>
      <label>Optional internal close note<textarea maxLength={2000} value={note} onChange={e => { setNote(e.target.value); setConfirmed(false); setError(''); }} /></label>
      <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I explicitly confirm this selected lead/version and {choice || 'my choice'} as CRM-only recordkeeping, not enrollment or payment.</label>
      <button disabled={!choice || !confirmed}>Confirm CRM-only close</button><button type="button" onClick={onCancel}>Cancel close draft</button>
    </fieldset></form>
    {busy && <p role="status">Verifying the exact close command…</p>}
    {error && <p role="alert">{error}</p>}
    {retry && <button disabled={busy} type="button" onClick={() => void send(retry)}>Retry exact retained close request</button>}
    {result && <section aria-label="CRM-only close receipt"><h3>Returned CRM-only close receipt</h3><p>Lead <code>{result.receipt.leadId}</code> · {result.receipt.status} · v{result.receipt.priorVersion} → v{result.receipt.version} · {result.receipt.closedAt} · {result.replayed ? 'replayed receipt' : 'recorded receipt'}</p><p>Internal close note: {result.receipt.closeNote ?? 'Not recorded'}</p></section>}
    {attempted && <p>The loaded list has not been rewritten or refreshed. Explicitly use Load CRM leads to reauthorize and reload before any new close; reloading discards this in-memory retry/receipt.</p>}
  </section>;
}
