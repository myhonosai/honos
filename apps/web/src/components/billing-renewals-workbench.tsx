'use client';
import React, { useRef, useState, type FormEvent } from 'react';
import { BILLING_RENEWAL_HELP, RENEWAL_STATUSES, type RenewalInput, type RenewalRecord, type RenewalQueue, type RenewalStatus, type RenewalOperation, type RenewalMembershipFacts, type RenewalHistory } from '@hon/contracts';
import { loadRenewals, readRenewal, readRenewalMembership, loadRenewalHistory, mutateRenewal, renewalFingerprint, RenewalAccessError } from './billing-renewals-http';
import styles from './billing-renewals-workbench.module.css';
const initial = (): RenewalInput => ({ expectedVersion: 0, membershipId: '', reviewFrom: '', reviewTo: '', status: 'OPEN', note: '', reason: '', reminderNeeded: null });
const fields = (r: RenewalRecord): RenewalInput => ({ expectedVersion: r.version, membershipId: r.membershipId, reviewFrom: r.reviewFrom, reviewTo: r.reviewTo, status: r.status, note: r.note, reason: r.reason, reminderNeeded: r.reminderNeeded });
function Facts({ facts, title }: { facts: RenewalMembershipFacts; title: string }) {
  return <section><h2>{title}</h2><p>Membership {facts.membershipId} · {facts.state} · membership version {facts.membershipVersion}</p>
    <p>Term start: {facts.termStartedAt ?? 'Not recorded'}<br/>Term end: {facts.termEndsAt ?? 'Not recorded / open-ended'}</p>
    <p>{facts.scheduleCount} existing schedules. {facts.schedulesTruncated ? 'Only the first 20 by schedule ID are shown; not a complete schedule list.' : 'All recorded schedules shown.'} These are observations, not invoices, receipts or a collection plan.</p>
    <ul>{facts.schedules.map(s => <li key={s.scheduleId}>{s.frequency} · {s.status} · {s.amountMinor} minor units {s.currency}<br/>Recorded next-charge fact: {s.nextChargeAt ?? 'Not recorded'}<br/>Observed auto-renew flag: {s.autoRenew ? 'true' : 'false'} — no execution or renewal promise.</li>)}</ul>
  </section>;
}
export function BillingRenewalsWorkbench(): React.ReactElement {
  const [context, setContext] = useState<RenewalQueue | null>(null), [selected, setSelected] = useState<RenewalRecord | null>(null), [draft, setDraft] = useState<RenewalInput>(initial);
  const [status, setStatus] = useState<RenewalStatus | 'ALL'>('OPEN'), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [knownId, setKnownId] = useState('');
  const [currentFacts, setCurrentFacts] = useState<RenewalMembershipFacts | null>(null), [history, setHistory] = useState<RenewalHistory | null>(null), [historical, setHistorical] = useState(false);
  const retry = useRef<{ fingerprint: string; key: string; op: RenewalOperation; id: string | null; input: RenewalInput } | null>(null);
  const [uncertain, setUncertain] = useState(false), [needsRefresh, setNeedsRefresh] = useState(false);
  function clearDetail() { setSelected(null); setDraft(initial()); setCurrentFacts(null); setHistory(null); setHistorical(false); setNeedsRefresh(false); }
  async function run(work: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (e) {
      if (e instanceof RenewalAccessError) { setContext(null); clearDetail(); }
      setError(e instanceof Error ? e.message : 'No verified result.');
    } finally { setBusy(false); }
  }
  function edit(p: Partial<RenewalInput>) { setDraft(d => ({ ...d, ...p })); setNotice(''); if ('membershipId' in p) setCurrentFacts(null); }
  async function load(after: string | null = null) { await run(async () => { setContext(null); clearDetail(); setContext(await loadRenewals(status, after)); }); }
  async function open(id: string, version: number | null = null) { await run(async () => {
    clearDetail(); const d = await readRenewal(id, version);
    if (!context || d.record.schoolId !== context.schoolId) throw new Error('School changed. Reload the authorized queue.');
    setSelected(d.record); setDraft({ ...fields(d.record), ...(d.record.status === 'CLOSED' && version === null ? { status: 'OPEN' as const } : {}) }); setCurrentFacts(d.currentMembershipFacts); setHistorical(version !== null);
  }); }
  async function knownMembership() { await run(async () => { setCurrentFacts(null); setCurrentFacts(await readRenewalMembership(draft.membershipId)); }); }
  async function loadHistory(before: number | null = null) { if (!selected) return; await run(async () => {
    setHistory(null); const h = await loadRenewalHistory(selected.renewalId, before);
    if (!context || h.schoolId !== context.schoolId) throw new Error('School changed. Reload the authorized queue.'); setHistory(h);
  }); }
  async function submit(op: RenewalOperation, id: string | null, input: RenewalInput) {
    const fingerprint = renewalFingerprint({ op, id, input });
    if (retry.current?.fingerprint !== fingerprint) retry.current = { fingerprint, key: crypto.randomUUID(), op, id, input: structuredClone(input) };
    setUncertain(true); const saved = await mutateRenewal(op, id, input, retry.current.key);
    if (!context || saved.schoolId !== context.schoolId) throw new Error('School changed. No save assumed; reload current records.');
    setUncertain(false); setNeedsRefresh(true); setHistorical(false); setSelected(saved); setDraft(fields(saved)); setCurrentFacts(null); setHistory(null);
    setContext({ ...context, items: context.items.filter(r => r.renewalId !== saved.renewalId) });
    setNotice(`Verified saved review version ${saved.version}: ${saved.status}. No collection, notices or automatic renewal. Reload current detail before further edits; retries can return an older saved version.`);
  }
  async function save(e: FormEvent) { e.preventDefault(); await run(() => submit(selected ? 'REVISE' : 'CREATE', selected?.renewalId ?? null, draft)); }
  return <main className={styles.page}>
    <nav><a href="/core">HON Core</a><a href="/staff/search">Staff search</a><a href="/auth/login">Sign in</a></nav>
    <header><p>HUMAN BILLING · ESSENTIAL / CORE / COMPLETE</p><h1>Membership renewal reviews</h1><p>A practical shared finance review queue. Human records, not billing execution.</p></header>
    <aside><strong>No collection. No notices. No automatic renewal.</strong><p>{BILLING_RENEWAL_HELP}</p>
      <p>Exact school permissions: billing.renewal.manage and billing.membership.read, for verified human staff. Shared school records, not self assignments. No payer directory or customer contact lookup. Do not enter card details, payment-method tokens or provider secrets in private notes.</p></aside>
    <section><h2>Authorized school reviews</h2><div className={styles.row}>
      <label>Status<select disabled={busy} value={status} onChange={e => { setStatus(e.target.value as RenewalStatus | 'ALL'); setContext(null); clearDetail(); }}>{[...RENEWAL_STATUSES, 'ALL'].map(s => <option key={s}>{s}</option>)}</select></label>
      <button disabled={busy} onClick={() => void load()}>Load / refresh reviews</button></div>
      <p>Up to 50 records per page, ordered by review ID. Half-open review windows use UTC and may be past or future, from 1 minute to 366 days in 2000–2099. They do not trigger work. The queue omits private notes and reasons.</p></section>
    {busy && <p role="status">Checking the current human school boundary…</p>}
    {error && <p role="alert" className={styles.error}>{error} No save is assumed after an uncertain response.</p>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {uncertain && retry.current && <aside><p>An unverified request is retained in memory for this page only. Changing fields is not a retry. No automatic resubmission.</p><button disabled={busy || !context} onClick={() => void run(async () => { const r = retry.current!; await submit(r.op, r.id, r.input); })}>Retry exact retained request</button></aside>}
    {context && <>
      <section><h2>Shared school finance queue</h2><p>School {context.schoolId}. Signed-in staff {context.principalId}.</p><button disabled={busy} onClick={clearDetail}>New renewal review</button>
        {context.items.length === 0 && <p>No reviews on this page. Create a human review or choose another status.</p>}
        <div className={styles.actions}>{context.items.map(r => <button key={r.renewalId} disabled={busy} onClick={() => void open(r.renewalId)}>{r.status} · v{r.version}<br/>Membership {r.membershipId}<br/>{r.reviewFrom} to {r.reviewTo}<br/>Manual reminder needed: {r.reminderNeeded === null ? 'not recorded' : r.reminderNeeded ? 'yes (fact only)' : 'no'}</button>)}</div>
        {context.nextAfter && <button disabled={busy} onClick={() => void load(context.nextAfter)}>Next 50 reviews</button>}
        <form onSubmit={e => { e.preventDefault(); void open(knownId); }}><label>Already-known renewal review ID<input required value={knownId} onChange={e => setKnownId(e.target.value)} placeholder="Review UUID"/></label><button disabled={busy}>Load current detail</button></form>
      </section>
      {selected && <section><h2>{historical ? 'Historical saved revision · read only' : 'Saved review'} · v{selected.version}</h2><p>{selected.renewalId} · {selected.status} · recorded {selected.recordedAt}</p>
        <h3>Private review note</h3><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{selected.note}</p><h3>Explicit review reason</h3><p style={{ overflowWrap: 'anywhere' }}>{selected.reason}</p>
        <p>Review window {selected.reviewFrom} (inclusive) to {selected.reviewTo} (exclusive). Reminder needed: {selected.reminderNeeded === null ? 'not recorded' : String(selected.reminderNeeded)} (manual fact only).</p>
        <div className={styles.actions}><button disabled={busy} onClick={() => void open(selected.renewalId)}>Reload current detail</button><button disabled={busy} onClick={() => void loadHistory()}>Load revision history</button></div>
      </section>}
      {selected && <Facts facts={selected.membershipFacts} title="Membership facts captured at this saved revision"/>}
      {currentFacts && <Facts facts={currentFacts} title="Current known membership facts · observed on human read"/>}
      {history && <section><h2>Immutable revision history</h2><p>Metadata only here. Open an exact saved revision to inspect its private note, reason and captured facts; current membership facts remain separate.</p>
        <div className={styles.actions}>{history.items.map(r => <button key={r.version} disabled={busy} onClick={() => void open(r.renewalId, r.version)}>v{r.version} · {r.status} · {r.recordedAt}<br/>{r.reviewFrom} to {r.reviewTo}</button>)}</div>
        {history.nextBefore && <button disabled={busy} onClick={() => void loadHistory(history.nextBefore)}>Older 50 revisions</button>}
      </section>}
      {!historical && <section><h2>{selected ? selected.status === 'CLOSED' ? 'Explicitly reopen closed review' : 'Revise human review' : 'Create human renewal review'}</h2>
        <p>Expected review version {draft.expectedVersion}. Membership linkage cannot change. Every save captures current facts; it never changes the membership. All statuses are human recordkeeping, not eligibility decisions. CLOSED requires a reasoned OPEN revision to reopen.</p>
        <form onSubmit={save}><fieldset disabled={busy || needsRefresh}>
          <label>Already-known membership ID<input required readOnly={!!selected} value={draft.membershipId} onChange={e => edit({ membershipId: e.target.value })}/></label>
          {!selected && <button type="button" onClick={() => void knownMembership()}>Read known membership summary</button>}
          <div className={styles.row}>{(['reviewFrom', 'reviewTo'] as const).map(k => <label key={k}>{k === 'reviewFrom' ? 'Review from UTC (inclusive)' : 'Review to UTC (exclusive)'}<input required type="datetime-local" step="0.001" min="2000-01-01T00:00" max="2099-12-31T23:59:59.999" value={draft[k]?.slice(0, -1) ?? ''} onChange={e => edit({ [k]: e.target.value ? new Date(`${e.target.value}Z`).toISOString() : '' })}/></label>)}</div>
          <label>Human review status<select value={draft.status} onChange={e => edit({ status: e.target.value as RenewalStatus })}>{(selected?.status === 'CLOSED' || !selected ? ['OPEN'] : RENEWAL_STATUSES).map(s => <option key={s}>{s}</option>)}</select></label>
          <label>Explicit private review note<textarea required maxLength={2000} rows={5} value={draft.note} onChange={e => edit({ note: e.target.value })}/></label>
          <label>Explicit reason<input required maxLength={500} value={draft.reason} onChange={e => edit({ reason: e.target.value })}/></label>
          <label>Manual reminder-needed fact (does not schedule or send)<select value={draft.reminderNeeded === null ? 'unknown' : String(draft.reminderNeeded)} onChange={e => edit({ reminderNeeded: e.target.value === 'unknown' ? null : e.target.value === 'true' })}><option value="unknown">Not recorded</option><option value="false">No</option><option value="true">Yes · human fact only</option></select></label>
          <button type="submit" disabled={!selected && currentFacts?.membershipId !== draft.membershipId}>{selected ? 'Save reasoned review revision' : 'Create renewal review record'}</button>
        </fieldset></form>
      </section>}
    </>}
  </main>;
}
