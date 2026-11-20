'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  JOURNEY_RECOMMENDATION_LIMITS, isJourneyMessage, isJourneyTitle,
  type JourneyRecommendation, type JourneyRecommendationInterest, type JourneyRecommendations, type JourneyTarget, type JourneyTrigger, type SaveJourneyRecommendationInput,
} from '@hon/contracts';
import { onShellPrivacyEvent } from '../school-shell/privacy';
import {
  JourneyRecommendationsAccessError, JourneyRecommendationsRefusal, attemptFor, loadJourneyRecommendationInterest, loadJourneyRecommendations, saveJourneyRecommendation,
  setJourneyRecommendationStatus, type JourneyScope,
} from './http';
import s from '../comms-kit/comms.module.css';

export type JourneyPanelCurriculum = Readonly<{ id: string; name: string; ranks: readonly { id: string; name: string }[] }>;
type Draft = { recommendationId: string | null; expectedVersion: number | null; triggerKind: JourneyTrigger; rankId: string; threshold: string;
  title: string; message: string; targetKind: JourneyTarget; targetId: string; skipEnrolled: boolean };

const WHEN: Record<JourneyTrigger, string> = {
  RANK_REACHED: 'When the student reaches a rank', REQUIREMENTS_MET: 'After some requirements of a rank are met',
  TEST_BOOKED: 'When the student is booked for a rank test', CLASSES_ATTENDED: 'After a number of classes attended',
};
const WHERE: Record<JourneyTarget, string> = { CHECKOUT: 'A sign-up page', EVENT: 'An event', PRO_SHOP: 'The pro shop', ASK_SCHOOL: 'Ask the school (Messages)' };
const needsRank = (t: JourneyTrigger) => t !== 'CLASSES_ATTENDED';
const needsCount = (t: JourneyTrigger) => t === 'REQUIREMENTS_MET' || t === 'CLASSES_ATTENDED';
const needsTarget = (t: JourneyTarget) => t === 'CHECKOUT' || t === 'EVENT';
const empty = (): Draft => ({ recommendationId: null, expectedVersion: null, triggerKind: 'RANK_REACHED', rankId: '', threshold: '', title: '', message: '', targetKind: 'CHECKOUT', targetId: '', skipEnrolled: true });
/** "Mar 3" style day for an interest row, from the recorded instant only. */
export function interestDay(recordedAt: string): string {
  return new Date(recordedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
function failure(error: unknown) { return error instanceof Error ? error.message : 'Recommendations are unavailable right now.'; }

/** Plain words for one recommendation's "when", from the stored rule only. */
export function whenText(r: Pick<JourneyRecommendation, 'triggerKind' | 'rank' | 'threshold'>): string {
  if (r.triggerKind === 'RANK_REACHED') return `Reaches ${r.rank}`;
  if (r.triggerKind === 'TEST_BOOKED') return `Booked for the ${r.rank} test`;
  if (r.triggerKind === 'REQUIREMENTS_MET') return `${r.threshold} ${r.threshold === 1 ? 'requirement' : 'requirements'} met on ${r.rank}`;
  return `After ${r.threshold} ${r.threshold === 1 ? 'class' : 'classes'} attended`;
}

/** The save input for a draft, or null while something the server needs is missing. */
export function draftInput(curriculumId: string, d: Draft): SaveJourneyRecommendationInput | null {
  const count = Number(d.threshold);
  const max = d.triggerKind === 'REQUIREMENTS_MET' ? JOURNEY_RECOMMENDATION_LIMITS.requirements : JOURNEY_RECOMMENDATION_LIMITS.classes;
  if (!isJourneyTitle(d.title) || !isJourneyMessage(d.message)) return null;
  if (needsRank(d.triggerKind) && !d.rankId) return null;
  if (needsCount(d.triggerKind) && !(Number.isInteger(count) && count >= 1 && count <= max)) return null;
  if (needsTarget(d.targetKind) && !d.targetId) return null;
  return {
    recommendationId: d.recommendationId, expectedVersion: d.expectedVersion, curriculumId, triggerKind: d.triggerKind,
    rankId: needsRank(d.triggerKind) ? d.rankId : null, threshold: needsCount(d.triggerKind) ? count : null, title: d.title, message: d.message,
    targetKind: d.targetKind, targetCheckoutId: d.targetKind === 'CHECKOUT' ? d.targetId : null, targetEventId: d.targetKind === 'EVENT' ? d.targetId : null,
    skipEnrolled: d.targetKind === 'CHECKOUT' ? d.skipEnrolled : false,
  };
}

/**
 * Parent app > Curriculum > Recommendations (0603, David 2026-11-20: recommendations "by rank or certain point of journey").
 * Staff with curriculum.manage pin a sign-up page, an event, the pro shop or "ask the school" to a point on this program's
 * journey; families see it as a gift stop on their child's belt path. Mounted by the curriculum page for one curriculum.
 */
export function JourneyRecommendationsPanel({ organizationId, schoolId, curriculum }: { organizationId: string; schoolId: string; curriculum: JourneyPanelCurriculum }): React.ReactElement {
  const scopeKey = `${organizationId}/${schoolId}`;
  const [data, setData] = useState<JourneyRecommendations | null>(null), [draft, setDraft] = useState<Draft | null>(null);
  // 0608 interest is shown only when its own read verified; a failed interest read never hides the recommendations.
  const [interest, setInterest] = useState<JourneyRecommendationInterest | null>(null);
  const [busy, setBusy] = useState(false), [acting, setActing] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [denied, setDenied] = useState(false), [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const generation = useRef(0), attempt = useRef<{ identity: string; key: string } | null>(null);

  const clear = useCallback(() => { ++generation.current; setData(null); setInterest(null); setDraft(null); setConfirmRemove(null); attempt.current = null; }, []);
  const refresh = useCallback(async () => {
    const [org, school] = scopeKey.split('/');
    const token = ++generation.current;
    setBusy(true); setDenied(false);
    try {
      const scope = { organizationId: org!, schoolId: school! };
      const [read, interested] = await Promise.all([loadJourneyRecommendations(scope), loadJourneyRecommendationInterest(scope).catch(() => null)]);
      if (generation.current !== token) return;
      setData(read); setInterest(interested); setError('');
    } catch (problem) {
      if (generation.current !== token) return;
      setData(null); setInterest(null); setError(failure(problem)); setDenied(problem instanceof JourneyRecommendationsAccessError);
    } finally { if (generation.current === token) setBusy(false); }
  }, [scopeKey]);
  useEffect(() => { clear(); void refresh(); }, [scopeKey, curriculum.id, clear, refresh]);
  useEffect(() => onShellPrivacyEvent(() => { clear(); setError(''); setNotice(''); }), [clear]);

  const scope: JourneyScope = { organizationId, schoolId };
  async function command(identity: string, run: (key: string) => Promise<unknown>, done: string): Promise<boolean> {
    attempt.current = attemptFor(identity, attempt.current, () => crypto.randomUUID());
    const key = attempt.current.key;
    setActing(true); setError(''); setNotice('');
    try { await run(key); attempt.current = null; setNotice(done); await refresh(); return true; }
    catch (problem) {
      setError(failure(problem));
      if (problem instanceof JourneyRecommendationsRefusal) attempt.current = null;
      if (problem instanceof JourneyRecommendationsAccessError) { clear(); setDenied(true); }
      return false;
    } finally { setActing(false); }
  }

  const mine = data?.recommendations.filter(r => r.curriculumId === curriculum.id && r.status !== 'REMOVED') ?? [];
  const input = draft ? draftInput(curriculum.id, draft) : null;
  const set = (patch: Partial<Draft>) => setDraft(d => (d ? { ...d, ...patch } : d));
  async function save() {
    if (!input || acting) return;
    if (await command(`save:${JSON.stringify(input)}`, key => saveJourneyRecommendation(scope, input, key),
      'Saved. Families see it when their child reaches that point.')) setDraft(null);
  }
  function edit(r: JourneyRecommendation) {
    setDraft({ recommendationId: r.recommendationId, expectedVersion: r.version, triggerKind: r.triggerKind, rankId: r.rankId ?? '', threshold: r.threshold ? String(r.threshold) : '',
      title: r.title, message: r.message, targetKind: r.targetKind, targetId: r.targetCheckoutId ?? r.targetEventId ?? '', skipEnrolled: r.skipEnrolled });
  }
  async function status(r: JourneyRecommendation, next: 'ON' | 'OFF' | 'REMOVED') {
    if (acting) return;
    const done = next === 'REMOVED' ? 'Removed. Families no longer see it.' : next === 'OFF' ? 'Turned off. Families no longer see it.' : 'Turned on.';
    if (await command(`status:${r.recommendationId}:${r.version}:${next}`, key => setJourneyRecommendationStatus(scope, r.recommendationId, r.version, next, key), done)) setConfirmRemove(null);
  }

  return <section className={s.panel} aria-label={`Recommendations for ${curriculum.name}`} data-journey-recommendations="">
    <div className={s.actions}><h2>Recommendations</h2>
      {data && !draft && <button type="button" className={s.button} disabled={acting} onClick={() => setDraft(empty())}>Add a recommendation</button>}
      {data && <button type="button" className={s.ghost} disabled={busy} onClick={() => void refresh()}>Refresh</button>}</div>
    <p className={s.muted}>Pin a sign-up page, an event, the pro shop or a note to ask the school to a point on the {curriculum.name} journey. Families see it as a gift on their child's belt path in the HON Family app. Nothing is texted, emailed or charged.</p>
    <div aria-live="polite">{busy && !data && <p className={s.muted} role="status">Loading recommendations…</p>}
      {error && <div className={s.flash} data-tone="bad" role="alert"><strong>{denied ? 'Not available for your role' : 'Recommendations'}</strong><p>{denied ? 'You need the curriculum permission at this school.' : error}</p></div>}
      {notice && <p className={s.flash} data-tone="ok" role="status">{notice}</p>}</div>

    {data && draft && <form aria-label={draft.recommendationId ? 'Edit recommendation' : 'New recommendation'} onSubmit={e => { e.preventDefault(); void save(); }}>
      <label className={s.label} htmlFor="journey-when">When
        <select id="journey-when" className={s.field} value={draft.triggerKind} disabled={acting} onChange={e => set({ triggerKind: e.target.value as JourneyTrigger })}>
          {(Object.keys(WHEN) as JourneyTrigger[]).map(k => <option key={k} value={k}>{WHEN[k]}</option>)}</select></label>
      {needsRank(draft.triggerKind) && <label className={s.label} htmlFor="journey-rank">Rank
        <select id="journey-rank" className={s.field} value={draft.rankId} disabled={acting} onChange={e => set({ rankId: e.target.value })}>
          <option value="">Choose a rank</option>{curriculum.ranks.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}</select></label>}
      {needsCount(draft.triggerKind) && <label className={s.label} htmlFor="journey-count">{draft.triggerKind === 'CLASSES_ATTENDED' ? 'Classes attended' : 'Requirements met'}
        <input id="journey-count" className={s.field} inputMode="numeric" value={draft.threshold} disabled={acting} onChange={e => set({ threshold: e.target.value.replace(/\D+/g, '') })} /></label>}
      <label className={s.label} htmlFor="journey-where">Where it takes the family
        <select id="journey-where" className={s.field} value={draft.targetKind} disabled={acting} onChange={e => set({ targetKind: e.target.value as JourneyTarget, targetId: '' })}>
          {(Object.keys(WHERE) as JourneyTarget[]).map(k => <option key={k} value={k}>{WHERE[k]}</option>)}</select></label>
      {draft.targetKind === 'CHECKOUT' && <label className={s.label} htmlFor="journey-target">Sign-up page
        <select id="journey-target" className={s.field} value={draft.targetId} disabled={acting} onChange={e => set({ targetId: e.target.value })}>
          <option value="">Choose a page</option>{data.checkouts.map(p => <option key={p.checkoutId} value={p.checkoutId}>{p.title ?? 'Untitled page'}</option>)}</select></label>}
      {draft.targetKind === 'EVENT' && <label className={s.label} htmlFor="journey-target">Event
        <select id="journey-target" className={s.field} value={draft.targetId} disabled={acting} onChange={e => set({ targetId: e.target.value })}>
          <option value="">Choose an event</option>{data.events.map(v => <option key={v.eventId} value={v.eventId}>{v.title} ({v.localDate})</option>)}</select></label>}
      {draft.targetKind === 'CHECKOUT' && <label className={s.label}><input type="checkbox" checked={draft.skipEnrolled} disabled={acting} onChange={e => set({ skipEnrolled: e.target.checked })} /> Hide it from children already signed up on that page</label>}
      <label className={s.label} htmlFor="journey-title">Title
        <input id="journey-title" className={s.field} value={draft.title} maxLength={JOURNEY_RECOMMENDATION_LIMITS.title + 1} disabled={acting}
          onChange={e => set({ title: e.target.value.replace(/[\r\n]+/g, ' ') })} placeholder="Try summer camp" /></label>
      <label className={s.label} htmlFor="journey-message">Message to families
        <textarea id="journey-message" className={s.field} rows={3} value={draft.message} maxLength={JOURNEY_RECOMMENDATION_LIMITS.message + 1} disabled={acting} onChange={e => set({ message: e.target.value })} /></label>
      <div className={s.actions}>
        <span className={s.muted}>{draft.title.length} / {JOURNEY_RECOMMENDATION_LIMITS.title} · {draft.message.length} / {JOURNEY_RECOMMENDATION_LIMITS.message}</span>
        <button type="submit" className={s.primary} disabled={acting || !input}>{acting ? 'Saving…' : 'Save'}</button>
        <button type="button" className={s.ghost} disabled={acting} onClick={() => { setDraft(null); attempt.current = null; }}>Cancel</button></div>
    </form>}

    {data && (mine.length === 0 ? <p className={s.empty}>No recommendations for {curriculum.name} yet.</p> : <ul className={s.rows}>
      {mine.map(r => <li key={r.recommendationId} data-recommendation={r.status}>
        <div className={s.actions}><strong>{r.title}</strong>
          {r.status === 'ON' ? <span className={s.badge} data-tone="ok">On</span> : <span className={s.badge}>Off</span>}
          {!r.targetLive && needsTarget(r.targetKind) && <span className={s.badge} data-tone="bad">Page or event not open, families don't see it</span>}</div>
        <p className={s.muted}>{whenText(r)} · {WHERE[r.targetKind]}{r.targetLabel ? `: ${r.targetLabel}` : ''}</p>
        <p style={{ whiteSpace: 'pre-wrap' }}>{r.message}</p>
        <Interested rows={interest?.interest.filter(i => i.recommendationId === r.recommendationId) ?? null} />
        <div className={s.actions}>
          <button type="button" className={s.ghost} disabled={acting} onClick={() => edit(r)}>Edit</button>
          <button type="button" className={s.ghost} disabled={acting} onClick={() => void status(r, r.status === 'ON' ? 'OFF' : 'ON')}>{r.status === 'ON' ? 'Turn off' : 'Turn on'}</button>
          {confirmRemove === r.recommendationId
            ? <><span className={s.muted}>This cannot be undone.</span>
              <button type="button" className={s.button} disabled={acting} onClick={() => void status(r, 'REMOVED')}>Remove it</button>
              <button type="button" className={s.ghost} disabled={acting} onClick={() => setConfirmRemove(null)}>Cancel</button></>
            : <button type="button" className={s.ghost} disabled={acting} onClick={() => setConfirmRemove(r.recommendationId)}>Remove…</button>}
        </div>
      </li>)}
    </ul>)}
  </section>;
}

/** Families who tapped the main button in the HON Family app for one recommendation. Names and dates only; nobody was messaged. */
export function Interested({ rows }: { rows: JourneyRecommendationInterest['interest'] | null }): React.ReactElement | null {
  if (rows === null) return null;
  if (rows.length === 0) return <p className={s.muted}>No families have tapped it yet.</p>;
  return <details><summary>{rows.length} {rows.length === 1 ? 'family is' : 'families are'} interested</summary>
    <ul className={s.rows}>{rows.map(i => <li key={i.familyId}><strong>{i.familyName}</strong>
      {i.children.length ? ` · ${i.children.join(', ')}` : ''} <span className={s.muted}>· {interestDay(i.recordedAt)}</span></li>)}</ul>
    <p className={s.muted}>They tapped the button in the HON Family app. Nothing was sent to them; reach out in Messages if you'd like.</p></details>;
}
