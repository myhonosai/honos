'use client';
import React, { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { FamilyReferralReward, SchoolReferral, SchoolReferralProgramStatus, SchoolReferrals } from '@hon/contracts';
import { useShellSchool } from '../school-shell/page-school';
import { ReferralError, keepForRetry, schoolReferralsApi, type ProgramSave, type RewardSave, type SchoolReferralsApi, type Scope } from './http';
import styles from '../campaign-workbench.module.css';

/**
 * 0604 Marketing > Referrals. Staff turn the school's family referral program on, choose the lead form the friend fills in,
 * and write the reward in their own words. They see every referral with its lead and flags and record the reward decision.
 * Recording "Reward given" is a record only: the school gives the reward its own way, nothing is paid or credited here.
 */
export type ProgramDraft = Readonly<{ status: SchoolReferralProgramStatus; formId: string; referrerReward: string; friendOffer: string; rules: string; shareMessage: string }>;
export const LEAD_LABEL: Record<SchoolReferral['leadStatus'], string> = { OPEN: 'Interested', WON: 'Joined', LOST: "Didn't join", ARCHIVED: "Didn't join" };
export const REWARD_LABEL: Record<FamilyReferralReward, string> = { PENDING: 'Not decided yet', GIVEN: 'Reward given', NOT_ELIGIBLE: 'Not eligible' };
export function referralProblem(error: unknown): string {
  const kind = error instanceof ReferralError ? error.kind : 'UNKNOWN';
  if (kind === 'SESSION') return 'Your sign-in has ended. Sign in again.';
  if (kind === 'DENIED') return "You don't have permission to manage referrals at this school.";
  if (kind === 'VERSION') return 'This changed since you opened it. Refresh and try again.';
  if (kind === 'FORM') return 'Choose a lead form that is live. Publish one on the Lead forms page first.';
  if (kind === 'NOT_FOUND') return 'That referral is no longer here. Refresh the list.';
  if (kind === 'INVALID') return 'Check the fields and try again.';
  if (kind === 'PENDING') return 'Your last change is not confirmed yet. Press Try again first, or Refresh to drop it.';
  return "We couldn't confirm that. Try again.";
}
export const draftOf = (data: SchoolReferrals | null): ProgramDraft => ({ status: data?.program.status ?? 'OFF', formId: data?.program.formId ?? '',
  referrerReward: data?.program.referrerReward ?? '', friendOffer: data?.program.friendOffer ?? '', rules: data?.program.rules ?? '', shareMessage: data?.program.shareMessage ?? '' });

export type SchoolReferralsViewProps = Readonly<{
  data: SchoolReferrals | null; draft: ProgramDraft; busy: boolean; error: string; notice: string; canRetry: boolean;
  notes: Readonly<Record<string, string>>;
  onDraft?: (draft: ProgramDraft) => void; onSave?: () => void; onRefresh?: () => void; onRetry?: () => void;
  onNote?: (referralId: string, note: string) => void; onDecide?: (referral: SchoolReferral, decision: FamilyReferralReward) => void;
}>;
export function SchoolReferralsView(p: SchoolReferralsViewProps): React.ReactElement {
  const d = p.draft, data = p.data, manage = !!data?.canManage;
  const set = (patch: Partial<ProgramDraft>) => p.onDraft?.({ ...d, ...patch });
  const submit = (e: FormEvent) => { e.preventDefault(); p.onSave?.(); };
  const published = data?.forms.filter(f => f.status === 'PUBLISHED') ?? [];
  const current = data?.forms.find(f => f.formId === d.formId && f.status !== 'PUBLISHED');
  const missing = !!d.formId && !data?.forms.some(f => f.formId === d.formId);
  return <main className={styles.page} data-testid="school-referrals">
    <nav><a href="/staff/marketing">Marketing</a><a href="/staff/marketing/forms">Lead forms</a><a href="/staff/crm/leads">Leads</a></nav>
    <header><p>Marketing</p><h1>Family referrals</h1><p>Families share a personal link from the HON Family app. A friend who signs up becomes a lead in your pipeline, marked as referred by that family.</p></header>
    <aside data-plain-note=""><strong>You give the reward your own way.</strong> Marking a reward as given only records it. Nothing is paid, credited or added to an invoice.</aside>
    {p.error && <p role="alert" className={styles.error}>{p.error}</p>}{p.notice && <p role="status">{p.notice}</p>}
    {p.canRetry && <button type="button" disabled={p.busy} onClick={p.onRetry}>Try again</button>}
    {!data ? (p.busy ? <p role="status">Loading referrals…</p> : <button type="button" onClick={p.onRefresh}>Refresh</button>) : <>
      <section aria-label="Summary"><h2>So far</h2>
        <ul data-testid="referral-counts">
          <li><strong>{data.counts.referred}</strong> friends referred</li><li><strong>{data.counts.joined}</strong> joined</li>
          <li><strong>{data.counts.rewarded}</strong> rewards given</li><li><strong>{data.counts.awaitingDecision}</strong> joined and waiting for your reward decision</li>
        </ul>
        <button type="button" disabled={p.busy} onClick={p.onRefresh}>Refresh</button>
      </section>
      <section><h2>Your program</h2><form onSubmit={submit}><fieldset disabled={p.busy || !manage}>
        {!manage && <p>You can see this program. Only people who manage referrals can change it.</p>}
        <label><input type="checkbox" checked={d.status === 'ON'} onChange={e => set({ status: e.target.checked ? 'ON' : 'OFF' })} />Families can share their link</label>
        <label>Form the friend fills in<select required={d.status === 'ON'} value={d.formId} onChange={e => set({ formId: e.target.value })}>
          <option value="">Choose a live lead form</option>
          {current && <option value={current.formId}>{current.title} (not live)</option>}
          {missing && <option value={d.formId}>The current form (no longer available)</option>}
          {published.map(f => <option key={f.formId} value={f.formId}>{f.title}</option>)}
        </select></label>
        {published.length === 0 && <p>You have no live lead forms yet. <a href="/staff/marketing/forms">Publish one</a> first.</p>}
        <label>Reward for the family<input required={d.status === 'ON'} maxLength={200} placeholder="One free month of classes" value={d.referrerReward} onChange={e => set({ referrerReward: e.target.value })} /></label>
        <label>Offer for the friend (optional)<input maxLength={200} placeholder="Free trial week" value={d.friendOffer} onChange={e => set({ friendOffer: e.target.value })} /></label>
        <label>Rules (optional)<textarea maxLength={500} placeholder="Given after your friend's first paid month." value={d.rules} onChange={e => set({ rules: e.target.value })} /></label>
        <label>Message families send with the link (optional)<textarea maxLength={280} placeholder="Come train with us!" value={d.shareMessage} onChange={e => set({ shareMessage: e.target.value })} /></label>
        <p>Turning sharing off stops new referrals at once. Referrals you already have stay.</p>
        <button type="submit">Save program</button>
      </fieldset></form></section>
      <section><h2>Referrals</h2>
        {data.referrals.length === 0 ? <p>No referrals yet.</p> : <ul data-testid="referral-list">{data.referrals.map(r => <li key={r.referralId} data-reward={r.rewardStatus}>
          <p><strong>{r.familyName || 'A family'}</strong> referred <strong>{r.friendName || 'a friend'}</strong> on {new Date(r.createdAt).toLocaleDateString()}</p>
          <p>{LEAD_LABEL[r.leadStatus]} · {REWARD_LABEL[r.rewardStatus]}{r.rewardNote ? ` · ${r.rewardNote}` : ''}</p>
          {r.selfReferral && <p data-flag="SELF">The friend's email or mobile matches this family. Not counted for the family.</p>}
          {r.existingContact && <p data-flag="EXISTING_CONTACT">This friend was already a contact at your school.</p>}
          {manage && <div>
            {r.rewardStatus === 'PENDING' && <label>Note (optional)<input maxLength={300} value={p.notes[r.referralId] ?? ''} onChange={e => p.onNote?.(r.referralId, e.target.value)} /></label>}
            {r.rewardStatus === 'PENDING' ? <>
              <button type="button" disabled={p.busy} onClick={() => p.onDecide?.(r, 'GIVEN')}>Reward given</button>
              <button type="button" disabled={p.busy} onClick={() => p.onDecide?.(r, 'NOT_ELIGIBLE')}>Not eligible</button>
            </> : <button type="button" disabled={p.busy} onClick={() => p.onDecide?.(r, 'PENDING')}>Undo decision</button>}
          </div>}
        </li>)}</ul>}
      </section>
    </>}
  </main>;
}

type Pending = Readonly<{ kind: 'program'; save: ProgramSave; fingerprint: string } | { kind: 'reward'; save: RewardSave; fingerprint: string }>;
export function SchoolReferralsWorkbench({ api = schoolReferralsApi }: { api?: SchoolReferralsApi }): React.ReactElement {
  const school = useShellSchool();
  const scope: Scope | null = school ? { organizationId: school.organizationId, schoolId: school.schoolId } : null;
  const [data, setData] = useState<SchoolReferrals | null>(null), [draft, setDraft] = useState<ProgramDraft>(draftOf(null));
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [notes, setNotes] = useState<Record<string, string>>({});
  const pending = useRef<Pending | null>(null), gate = useRef(false), generation = useRef(0);
  const load = useCallback(async (s: Scope) => {
    const mine = ++generation.current, abort = new AbortController();
    const fresh = await api.read(s, abort.signal, () => mine === generation.current);
    if (mine !== generation.current) return;
    setData(fresh); setDraft(draftOf(fresh));
    // Keep notes typed for referrals still waiting for a decision; drop the rest.
    setNotes(n => Object.fromEntries(Object.entries(n).filter(([id]) => fresh.referrals.some(r => r.referralId === id && r.rewardStatus === 'PENDING'))));
  }, [api]);
  const run = useCallback(async (work: () => Promise<void>) => {
    if (gate.current) return; gate.current = true; setBusy(true); setError('');
    try { await work(); } catch (e) { if (!keepForRetry(e)) pending.current = null; setError(referralProblem(e)); }
    finally { gate.current = false; setBusy(false); }
  }, []);
  useEffect(() => { setData(null); if (scope) void run(() => load(scope)); }, [scope?.organizationId, scope?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps
  async function send(next: Pending) {
    if (!scope) return;
    // An unconfirmed change must be settled (Try again) before another one starts, so it is never silently dropped.
    if (pending.current && pending.current.fingerprint !== next.fingerprint) throw new ReferralError('PENDING');
    pending.current = pending.current ?? next;
    const p = pending.current, abort = new AbortController(), owned = () => true;
    const replayed = p.kind === 'program' ? (await api.saveProgram(scope, p.save, abort.signal, owned)).replayed : (await api.saveReward(scope, p.save, abort.signal, owned)).replayed;
    pending.current = null; setNotice(replayed ? 'This was already saved.' : 'Saved.');
    try { await load(scope); } catch { setData(null); setNotice('Saved, but the list could not be refreshed. Refresh before making more changes.'); }
  }
  function save() {
    if (!data) return;
    const input = { expectedVersion: data.program.version, status: draft.status, formId: draft.formId || null, referrerReward: draft.referrerReward.trim(),
      friendOffer: draft.friendOffer.trim(), rules: draft.rules.trim(), shareMessage: draft.shareMessage.trim() };
    const fingerprint = JSON.stringify(['program', input]);
    setNotice('');
    void run(async () => {
      const key = pending.current?.fingerprint === fingerprint ? pending.current.save.key : crypto.randomUUID();
      await send({ kind: 'program', save: api.prepareProgram(input, key), fingerprint });
    });
  }
  function decide(r: SchoolReferral, decision: FamilyReferralReward) {
    const input = { expectedVersion: r.version, decision, note: decision === 'PENDING' ? '' : (notes[r.referralId] ?? '').trim() };
    const fingerprint = JSON.stringify(['reward', r.referralId, input]);
    setNotice('');
    void run(async () => {
      const key = pending.current?.fingerprint === fingerprint ? pending.current.save.key : crypto.randomUUID();
      await send({ kind: 'reward', save: api.prepareReward(r.referralId, input, key), fingerprint });
    });
  }
  return <SchoolReferralsView data={data} draft={draft} busy={busy || !scope} error={error} notice={notice} canRetry={!!pending.current && !busy} notes={notes}
    onDraft={setDraft} onSave={save} onRefresh={() => { if (scope) { pending.current = null; setNotice(''); void run(() => load(scope)); } }}
    onRetry={() => { const p = pending.current; if (p) void run(() => send(p)); }}
    onNote={(id, note) => setNotes(n => ({ ...n, [id]: note }))} onDecide={decide} />;
}
