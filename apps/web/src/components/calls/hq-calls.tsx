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
import styles from '../hq-access/hq-access.module.css';
import k from './hq-calls.module.css';

function who(call: HqCall, copy: HqCallsCopy): string {
  return call.contactName ?? (call.remoteE164 ? `${copy.unknownCaller} ${formatCallNumber(call.remoteE164)}` : copy.unknownCaller);
}
function message(problem: unknown, copy: HqCallsCopy): string {
  if (problem instanceof CallsAccessError) return problem.reason === 'SESSION' ? copy.sessionEnded : copy.denied;
  if (problem instanceof CallsRefusal) return copy.refusal[problem.code] ?? copy.unavailable;
  return copy.unavailable;
}
type SettingsDraft = { greeting: string };
const draftOf = (o: HqCallingOverview): SettingsDraft => ({ greeting: o.voicemailGreeting ?? '' });

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
    void command(() => saveHqCallingSettings({ callingOn: overview.callingOn, voicemailGreeting: greeting, expectedVersion: overview.version }), copy.settingsSaved);
  }

  const open = list?.calls.find(x => x.callId === openId) ?? null;
  const ringers = overview?.staff?.filter(m => m.ringMe).map(m => m.name) ?? [];
  const greetingOk = settings ? greetingValue(settings.greeting) !== undefined : false;
  const outcomeTone = error ? 'blocked' : 'ok';
  return <main className={styles.access} data-hq-calls="">
    <header className={styles.head}><div><h1>{copy.title}</h1><p className={styles.intro}>{copy.intro}</p></div>
      {list && <button type="button" className={styles.secondary} disabled={busy} onClick={() => void refresh()}>{copy.refresh}</button>}</header>
    {hidden && !list && <div className={styles.notice}><p>{copy.hidden}</p><button type="button" className={styles.secondary} onClick={() => void refresh()}>{copy.show}</button></div>}
    <div aria-live="polite">{busy && !list && <p className={styles.notice} role="status">{copy.loading}</p>}
      {(error || notice) && <div className={styles.outcome} data-tone={outcomeTone} role={error ? 'alert' : 'status'}>
        {error ? <p><strong>{denied ? copy.deniedTitle : copy.title}</strong> · {error}</p> : <p>{notice}</p>}</div>}</div>

    {overview && <section className={styles.card} aria-label={copy.hqNumber} data-hq-calls-number={overview.numberReady ? 'ready' : 'none'}>
      <div className={styles.cardHead}><h2>{copy.hqNumber}: {overview.hqNumber ? formatCallNumber(overview.hqNumber) : '—'}</h2>
        <span className={styles.status} data-tone={overview.callingOn ? 'ready' : 'waiting'} data-hq-calling={overview.callingOn ? 'on' : 'off'}>
          {overview.callingOn ? copy.statusOn : copy.statusOff}</span></div>
      {!overview.numberReady && <div className={styles.outcome} data-tone="waiting"><p>{copy.noNumber}</p>
        {overview.canManage ? <a className={styles.primary} href="/hq/communications#hq-buy-number" data-hq-calls-buy="">{copy.setUpNumber}</a>
          : <p className={styles.meta}>{copy.askOwnerNumber}</p>}</div>}
      <p className={styles.meta}>{overview.callingOn ? copy.callingOn : `${copy.callingOff}. ${copy.callingOffHint}`}</p>
      {overview.canManage && <div className={styles.actions}>
        <button type="button" className={overview.callingOn ? styles.secondary : styles.primary} disabled={acting} data-hq-calling-toggle=""
          onClick={() => { const on = !overview.callingOn; void command(() => saveHqCallingSettings({ callingOn: on, voicemailGreeting: overview.voicemailGreeting, expectedVersion: overview.version }),
            on ? copy.callingTurnedOn : copy.callingTurnedOff); }}>{overview.callingOn ? copy.turnCallingOff : copy.turnCallingOn}</button></div>}
      <dl className={styles.facts}><div><dt>{copy.filters.MISSED}</dt><dd>{copy.missedToday(overview.missedToday)}</dd></div>
        <div><dt>{copy.filters.VOICEMAIL}</dt><dd>{copy.unheard(overview.unheardVoicemails)}</dd></div></dl>
      <div className={k.ringRow}>
        <button type="button" role="switch" aria-checked={overview.ringMe} aria-describedby="hq-ring-me-hint" className={k.switch} data-hq-ring-me={overview.ringMe ? 'on' : 'off'}
          disabled={acting || !overview.callingOn}
          onClick={() => { const on = !overview.ringMe; void command(() => setHqRingMe(on), on ? copy.ringMeOn : copy.ringMeOff); }}>
          <span className={k.knob} aria-hidden="true"/><span>{copy.ringMe}</span>
          <span className={k.switchState}>{overview.ringMe ? copy.ringMeOnLabel : copy.ringMeOffLabel}</span></button>
        <p id="hq-ring-me-hint" className={styles.meta}>{overview.callingOn ? copy.ringMeHint : copy.ringMeNeedsCalling}</p></div>
      {overview.callingOn && <p className={styles.meta}>{overview.staff ? (ringers.length ? copy.ringing(ringers.join(', ')) + '.' : copy.nobodyRings) + ' ' : ''}{copy.voicemailNote}</p>}
    </section>}

    {list && <section className={styles.card} aria-label={copy.log}>
      <div className={styles.cardHead}><h2>{copy.log}</h2></div>
      <div className={styles.filters} role="group" aria-label={copy.log}>
        {SCHOOL_CALL_FILTERS.map(f => <button key={f} type="button" aria-pressed={filter === f} disabled={busy} onClick={() => choose(f)}>{copy.filters[f]}</button>)}
      </div>
      {list.calls.length === 0 ? <p className={styles.notice}>{filter === 'ALL' ? copy.empty : copy.emptyFiltered}</p> : <ul className={styles.list}>
        {list.calls.map(x => <li key={x.callId} className={k.callRow}>
          <button type="button" className={k.callName} aria-expanded={openId === x.callId} onClick={() => openCall(x)}>{who(x, copy)}</button>
          <span className={styles.meta}>{x.direction === 'IN' ? copy.incoming : copy.outgoing} · {copy.status[x.status]}
            {x.durationSeconds ? ` · ${formatCallDuration(x.durationSeconds)}` : ''} · {date(x.startedAt)}{x.staffName ? ` · ${copy.by(x.staffName)}` : ''}
            {x.contactSchools.length > 0 && ` · ${copy.ownerOf(x.contactSchools.join(', '))}`}
            {x.doNotCall && ` · ${copy.doNotCallBadge}`}{x.outcome && ` · ${copy.outcomes[x.outcome]}`}</span>
          {x.voicemail && <span className={styles.status} data-tone={x.heard ? 'ready' : 'waiting'}>{x.heard ? copy.voicemailHeard : copy.voicemailNew}</span>}
        </li>)}
      </ul>}
      {list.nextCursor && <div className={styles.actions}><button type="button" className={styles.secondary} disabled={busy} onClick={() => void more()}>{copy.more}</button></div>}
    </section>}

    {open && <section className={styles.card} aria-label={copy.card(who(open, copy))}>
      <div className={styles.cardHead}><h2>{copy.card(who(open, copy))}</h2></div>
      <p className={styles.meta}>{open.remoteE164 ? formatCallNumber(open.remoteE164) : copy.unknownCaller} · {copy.status[open.status]} · {date(open.startedAt)} · {copy.notRecorded}</p>
      {!open.doNotCall && open.remoteE164 && <div className={styles.actions}><CallButton phoneE164={open.remoteE164} personId={open.contactUserId ?? undefined}
        name={open.contactName ?? undefined} language={preferences.language} /></div>}
      <fieldset className={styles.fields}><legend className={k.legend}>{copy.outcome}</legend><div className={styles.filters}>
        {HQ_CALL_OUTCOMES.map(o => <button key={o} type="button" aria-pressed={open.outcome === o} disabled={acting} onClick={() => saveOutcome(open, o)}>{copy.outcomes[o]}</button>)}
        {open.outcome && <button type="button" disabled={acting} onClick={() => saveOutcome(open, null)}>{copy.clearOutcome}</button>}
      </div></fieldset>
      <form className={styles.form} onSubmit={e => saveNote(e, open)}>
        <label htmlFor="hq-call-note">{copy.note}</label>
        <textarea id="hq-call-note" rows={3} value={note} maxLength={SCHOOL_CALL_LIMITS.noteMax + 1} onChange={e => setNote(e.target.value)} disabled={acting} aria-describedby="hq-call-note-hint" />
        <p id="hq-call-note-hint" className={styles.meta}>{copy.noteHint}</p>
        <div className={styles.actions}><button type="submit" className={styles.primary} disabled={acting || (note.trim() !== '' && !schoolCallNoteOk(note)) || note === (open.note ?? '')}>{copy.save}</button></div>
      </form>
      {open.voicemail && !open.heard && <div className={styles.actions}><button type="button" className={styles.secondary} disabled={acting}
        onClick={() => void command(() => updateHqCall({ callId: open.callId, expectedVersion: open.version, heard: true }), copy.markedHeard)}>{copy.markHeard}</button></div>}
      {open.recordingAvailable && <div className={styles.fields}>
        <p><strong>{copy.listen(open.recordingSeconds === null ? '' : formatCallDuration(open.recordingSeconds))}</strong></p>
        <audio key={open.callId} controls preload="none" src={hqRecordingUrl(open.callId)} style={{ width: '100%', maxWidth: 480 }} aria-label={copy.listen('')} data-call-recording="" />
        <p className={styles.meta}>{copy.voicemailKept}</p></div>}
      {open.remoteE164 && <div className={styles.actions}><button type="button" className={styles.secondary} disabled={acting}
        onClick={() => void command(() => setHqDoNotCall({ phoneE164: open.remoteE164!, doNotCall: !open.doNotCall }), open.doNotCall ? copy.doNotCallRemoved : copy.doNotCallAdded)}>
        {open.doNotCall ? copy.removeDoNotCall : copy.addDoNotCall}</button> <span className={styles.meta}>{copy.doNotCallHint}</span></div>}
    </section>}

    {overview && settings && <section className={styles.card} aria-label={copy.settings} id="hq-call-settings">
      <div className={styles.cardHead}><h2>{copy.settings}</h2></div>
      {!overview.canManage ? <p className={styles.meta}>{copy.ownerOnly}</p> : <form className={styles.form} onSubmit={saveSettings}>
        <p className={styles.meta}>{copy.settingsHint}</p>
        <label htmlFor="hq-call-greeting">{copy.greeting}</label>
        <textarea id="hq-call-greeting" rows={2} value={settings.greeting} maxLength={SCHOOL_CALL_LIMITS.greetingMax + 1} disabled={acting} aria-describedby="hq-call-greeting-hint"
          onChange={e => setSettings({ ...settings, greeting: e.target.value })} />
        <p id="hq-call-greeting-hint" className={styles.meta}>{copy.greetingHint}</p>
        <div className={styles.actions}><button type="submit" className={styles.primary} disabled={acting || !greetingOk}>{copy.saveSettings}</button></div>
      </form>}
    </section>}
  </main>;
}
