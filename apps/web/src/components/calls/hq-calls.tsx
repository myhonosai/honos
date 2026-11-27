'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  HQ_CALL_OUTCOMES, SCHOOL_CALL_FILTERS, SCHOOL_CALL_LIMITS, schoolCallNoteOk,
  type HqCall, type HqCallList, type HqCallOutcome, type HqCallingOverview, type SchoolCallFilter,
} from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { CallsAccessError, CallsRefusal, formatCallDuration, formatCallNumber } from './http';
import { hqRecordingUrl, loadHqCalling, loadHqCalls, saveHqCallingSettings, setHqDoNotCall, setHqRingMe, updateHqCall } from './hq-http';
import { hqCallsCopy, type HqCallsCopy } from './hq-copy';
import { greetingValue } from './staff-calls';
import { CallButton } from './call-button';
import s from '../testing-registration.module.css';
import c from './calls.module.css';

function who(call: HqCall, copy: HqCallsCopy): string {
  return call.contactName ?? (call.remoteE164 ? `${copy.unknownCaller} ${formatCallNumber(call.remoteE164)}` : copy.unknownCaller);
}
function message(problem: unknown, copy: HqCallsCopy): string {
  if (problem instanceof CallsAccessError) return problem.reason === 'SESSION' ? copy.sessionEnded : copy.denied;
  if (problem instanceof CallsRefusal) return copy.refusal[problem.code] ?? copy.unavailable;
  return copy.unavailable;
}
type SettingsDraft = { callingOn: boolean; greeting: string };
const draftOf = (o: HqCallingOverview): SettingsDraft => ({ callingOn: o.callingOn, greeting: o.voicemailGreeting ?? '' });

/**
 * CL5 (0694) HQ Calls page: the HQ number's call log, the after-call card, Ring me and the HQ owner's settings. The server
 * re-proves the HQ person on every read and command (settings: HQ owner). Nothing here dials; the HQ top-bar phone does.
 * Leaving the tab hides everything; coming back reads again.
 */
export function HqCalls(): React.ReactElement {
  const { preferences, date } = useLocale();
  const copy = hqCallsCopy(preferences.language);
  const [overview, setOverview] = useState<HqCallingOverview | null>(null), [list, setList] = useState<HqCallList | null>(null);
  const [filter, setFilter] = useState<SchoolCallFilter>('ALL'), [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState(''), [settings, setSettings] = useState<SettingsDraft | null>(null);
  const [busy, setBusy] = useState(false), [acting, setActing] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [denied, setDenied] = useState(false), [hidden, setHidden] = useState(false);
  const generation = useRef(0);

  const clear = useCallback(() => { ++generation.current; setOverview(null); setList(null); setOpenId(null); setNote(''); setSettings(null); }, []);
  const refresh = useCallback(async (nextFilter?: SchoolCallFilter) => {
    const token = ++generation.current;
    setBusy(true); setDenied(false);
    try {
      const [o, l] = await Promise.all([loadHqCalling(), loadHqCalls({ filter: nextFilter ?? filter })]);
      if (generation.current !== token) return;
      setOverview(o); setList(l); setSettings(draftOf(o)); setError(''); setHidden(false);
    } catch (problem) {
      if (generation.current !== token) return;
      setOverview(null); setList(null); setError(message(problem, copy)); setDenied(problem instanceof CallsAccessError);
    } finally { if (generation.current === token) setBusy(false); }
  }, [filter, copy]);
  useEffect(() => { void refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- first read only
  useEffect(() => {
    // HQ stays on screen when the person looks away (#671); only a session end hides the calls.
    const onSessionEnd = () => { clear(); setError(''); setNotice(''); setHidden(true); };
    window.addEventListener(HON_SESSION_INVALIDATED_EVENT, onSessionEnd);
    return () => window.removeEventListener(HON_SESSION_INVALIDATED_EVENT, onSessionEnd);
  }, [clear]);

  async function more() {
    if (!list?.nextCursor) return;
    const token = generation.current;
    try {
      const page = await loadHqCalls({ filter, before: list.nextCursor });
      if (generation.current !== token) return;
      setList({ calls: [...list.calls, ...page.calls.filter(x => !list.calls.some(y => y.callId === x.callId))], nextCursor: page.nextCursor });
    } catch (problem) { if (generation.current === token) setError(message(problem, copy)); }
  }
  /** Commands are version-checked, not keyed: an unconfirmed one is never retried blind; the page reloads instead. */
  async function command(run: () => Promise<unknown>, done: string): Promise<boolean> {
    setActing(true); setError(''); setNotice('');
    try { await run(); setNotice(done); await refresh(); return true; }
    catch (problem) {
      if (problem instanceof CallsAccessError) { clear(); setDenied(true); setError(message(problem, copy)); }
      else if (problem instanceof CallsRefusal) {
        const msg = message(problem, copy);
        if (/VERSION_CONFLICT|CALL_CONFLICT/.test(problem.code)) await refresh();
        setError(msg);
      } else setError(copy.unknownSave);
      return false;
    } finally { setActing(false); }
  }
  function choose(next: SchoolCallFilter) { setFilter(next); setOpenId(null); void refresh(next); }
  function openCall(call: HqCall) { setOpenId(call.callId === openId ? null : call.callId); setNote(call.note ?? ''); setNotice(''); }
  function saveOutcome(call: HqCall, outcome: HqCallOutcome | null) {
    void command(() => updateHqCall({ callId: call.callId, expectedVersion: call.version, outcome }), copy.saved);
  }
  function saveNote(event: React.FormEvent, call: HqCall) {
    event.preventDefault();
    const value = note.trim() ? note : null;
    if (value !== null && !schoolCallNoteOk(value)) return;
    void command(() => updateHqCall({ callId: call.callId, expectedVersion: call.version, note: value }), copy.saved);
  }
  function saveSettings(event: React.FormEvent) {
    event.preventDefault();
    if (!overview || !settings) return;
    const greeting = greetingValue(settings.greeting);
    if (greeting === undefined) return;
    void command(() => saveHqCallingSettings({ callingOn: settings.callingOn, voicemailGreeting: greeting, expectedVersion: overview.version }), copy.settingsSaved);
  }

  const open = list?.calls.find(x => x.callId === openId) ?? null;
  const ringers = overview?.staff?.filter(m => m.ringMe).map(m => m.name) ?? [];
  const greetingOk = settings ? greetingValue(settings.greeting) !== undefined : false;
  return <main className={`${s.page} ${c.hq}`} data-hq-calls=""><div className={s.shell}>
    <header className={s.header}><h1>{copy.title}</h1><p>{copy.intro}</p></header>
    {hidden && !list && <p className={s.actions}><span className={s.subtle}>{copy.hidden}</span> <button type="button" onClick={() => void refresh()}>{copy.show}</button></p>}
    <div aria-live="polite">{busy && !list && <p role="status">{copy.loading}</p>}
      {error && <div className={s.error} role="alert"><strong>{denied ? copy.deniedTitle : copy.title}</strong><p>{error}</p></div>}
      {notice && <p className={s.notice} role="status">{notice}</p>}</div>

    {overview && <section className={s.card} aria-label={copy.hqNumber}>
      <h2>{copy.hqNumber}: {overview.hqNumber ? formatCallNumber(overview.hqNumber) : '—'}</h2>
      {!overview.numberReady && <p>{copy.noNumber} <a href="/hq/communications">{copy.setUpNumber}</a></p>}
      <p><strong>{overview.callingOn ? copy.callingOn : copy.callingOff}</strong>{!overview.callingOn && <> · <span className={s.subtle}>{copy.callingOffHint}</span></>}</p>
      <p>{copy.missedToday(overview.missedToday)} · {copy.unheard(overview.unheardVoicemails)}</p>
      <p className={s.actions}>
        <label><input type="checkbox" checked={overview.ringMe} disabled={acting || !overview.callingOn}
          onChange={e => { const on = e.target.checked; void command(() => setHqRingMe(on), on ? copy.ringMeOn : copy.ringMeOff); }} /> {copy.ringMe}</label>
        <span className={s.subtle}>{copy.ringMeHint}</span></p>
      {overview.callingOn && <p className={s.subtle}>{overview.staff ? (ringers.length ? copy.ringing(ringers.join(', ')) + '.' : copy.nobodyRings) + ' ' : ''}{copy.voicemailNote}</p>}
    </section>}

    {list && <section className={s.card} aria-label={copy.log}>
      <h2>{copy.log}</h2>
      <p className={`${s.actions} ${c.pressed}`} role="group" aria-label={copy.log}>
        {SCHOOL_CALL_FILTERS.map(f => <button key={f} type="button" aria-pressed={filter === f} disabled={busy} onClick={() => choose(f)}>{copy.filters[f]}</button>)}
        <button type="button" disabled={busy} onClick={() => void refresh()}>{copy.refresh}</button>
      </p>
      {list.calls.length === 0 ? <p className={s.empty}>{filter === 'ALL' ? copy.empty : copy.emptyFiltered}</p> : <ul className={s.list}>
        {list.calls.map(x => <li key={x.callId}>
          <button type="button" aria-expanded={openId === x.callId} onClick={() => openCall(x)}>{who(x, copy)}</button>{' '}
          <span className={s.subtle}>{x.direction === 'IN' ? copy.incoming : copy.outgoing} · {copy.status[x.status]}
            {x.durationSeconds ? ` · ${formatCallDuration(x.durationSeconds)}` : ''} · {date(x.startedAt)}{x.staffName ? ` · ${copy.by(x.staffName)}` : ''}</span>
          {x.contactSchools.length > 0 && <span className={s.subtle}> · {copy.ownerOf(x.contactSchools.join(', '))}</span>}
          {x.voicemail && <span className={s.badge}> {x.heard ? copy.voicemailHeard : copy.voicemailNew}</span>}
          {x.doNotCall && <span className={s.subtle}> · {copy.doNotCallBadge}</span>}
          {x.outcome && <span className={s.subtle}> · {copy.outcomes[x.outcome]}</span>}
        </li>)}
      </ul>}
      {list.nextCursor && <p className={s.actions}><button type="button" disabled={busy} onClick={() => void more()}>{copy.more}</button></p>}
    </section>}

    {open && <section className={s.card} aria-label={copy.card(who(open, copy))}>
      <h2>{copy.card(who(open, copy))}</h2>
      <p className={s.subtle}>{open.remoteE164 ? formatCallNumber(open.remoteE164) : copy.unknownCaller} · {copy.status[open.status]} · {date(open.startedAt)} · {copy.notRecorded}</p>
      {!open.doNotCall && open.remoteE164 && <p className={s.actions}><CallButton phoneE164={open.remoteE164} personId={open.contactUserId ?? undefined}
        name={open.contactName ?? undefined} language={preferences.language} /></p>}
      <fieldset className={c.outcomes}><legend>{copy.outcome}</legend><p className={`${s.actions} ${c.pressed}`}>
        {HQ_CALL_OUTCOMES.map(o => <button key={o} type="button" aria-pressed={open.outcome === o} disabled={acting} onClick={() => saveOutcome(open, o)}>{copy.outcomes[o]}</button>)}
        {open.outcome && <button type="button" disabled={acting} onClick={() => saveOutcome(open, null)}>{copy.clearOutcome}</button>}
      </p></fieldset>
      <form className={c.form} onSubmit={e => saveNote(e, open)}>
        <label htmlFor="hq-call-note">{copy.note}</label>
        <textarea id="hq-call-note" rows={3} value={note} maxLength={SCHOOL_CALL_LIMITS.noteMax + 1} onChange={e => setNote(e.target.value)} disabled={acting} aria-describedby="hq-call-note-hint" />
        <p id="hq-call-note-hint" className={s.subtle}>{copy.noteHint}</p>
        <p className={s.actions}><button type="submit" disabled={acting || (note.trim() !== '' && !schoolCallNoteOk(note)) || note === (open.note ?? '')}>{copy.save}</button></p>
      </form>
      {open.voicemail && !open.heard && <p className={s.actions}><button type="button" disabled={acting}
        onClick={() => void command(() => updateHqCall({ callId: open.callId, expectedVersion: open.version, heard: true }), copy.markedHeard)}>{copy.markHeard}</button></p>}
      {open.recordingAvailable && <div>
        <p><strong>{copy.listen(open.recordingSeconds === null ? '' : formatCallDuration(open.recordingSeconds))}</strong></p>
        <audio key={open.callId} controls preload="none" src={hqRecordingUrl(open.callId)} style={{ width: '100%', maxWidth: 480 }} aria-label={copy.listen('')} data-call-recording="" />
        <p className={s.subtle}>{copy.voicemailKept}</p></div>}
      {open.remoteE164 && <p className={s.actions}><button type="button" disabled={acting}
        onClick={() => void command(() => setHqDoNotCall({ phoneE164: open.remoteE164!, doNotCall: !open.doNotCall }), open.doNotCall ? copy.doNotCallRemoved : copy.doNotCallAdded)}>
        {open.doNotCall ? copy.removeDoNotCall : copy.addDoNotCall}</button> <span className={s.subtle}>{copy.doNotCallHint}</span></p>}
    </section>}

    {overview && settings && <section className={s.card} aria-label={copy.settings}>
      <h2>{copy.settings}</h2>
      {!overview.canManage ? <p className={s.subtle}>{copy.ownerOnly}</p> : <form className={c.form} onSubmit={saveSettings}>
        <p className={s.subtle}>{copy.settingsHint}</p>
        <p><label><input type="checkbox" checked={settings.callingOn} disabled={acting} onChange={e => setSettings({ ...settings, callingOn: e.target.checked })} /> {copy.turnOn}</label></p>
        <label htmlFor="hq-call-greeting">{copy.greeting}</label>
        <textarea id="hq-call-greeting" rows={2} value={settings.greeting} maxLength={SCHOOL_CALL_LIMITS.greetingMax + 1} disabled={acting} aria-describedby="hq-call-greeting-hint"
          onChange={e => setSettings({ ...settings, greeting: e.target.value })} />
        <p id="hq-call-greeting-hint" className={s.subtle}>{copy.greetingHint}</p>
        <p className={s.actions}><button type="submit" disabled={acting || !greetingOk}>{copy.saveSettings}</button></p>
      </form>}
    </section>}
  </div></main>;
}
