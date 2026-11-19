'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  SCHOOL_CALL_FILTERS, SCHOOL_CALL_LIMITS, SCHOOL_CALL_OUTCOMES, SCHOOL_CALL_RECORDING_CONSENT, schoolCallGreetingOk, schoolCallNoteOk,
  type SchoolCall, type SchoolCallFilter, type SchoolCallList, type SchoolCallOutcome, type SchoolCallingOverview,
} from '@hon/contracts';
import { useSchoolShell } from '../school-shell/context';
import { onShellPrivacyEvent } from '../school-shell/privacy';
import { useLocale } from '../localization/provider';
import { callsCopy, type CallsCopy } from './copy';
import {
  CallsAccessError, CallsRefusal, formatCallDuration, formatCallNumber, loadCalling, loadCalls, recordingUrl, saveCallingSettings, setDoNotCall, setRingMe, updateCall,
  type CallsScope,
} from './http';
import { CallButton } from './call-button';
import s from '../testing-registration.module.css';
import c from './calls.module.css';

function who(call: SchoolCall, copy: CallsCopy): string { return call.contactName ?? `${copy.unknownCaller} ${formatCallNumber(call.remoteE164)}`; }
function message(problem: unknown, copy: CallsCopy): string {
  if (problem instanceof CallsAccessError) return problem.reason === 'SESSION' ? copy.sessionEnded : copy.denied;
  if (problem instanceof CallsRefusal) return copy.refusal[problem.code] ?? copy.unavailable;
  return copy.unavailable;
}
/** A blank greeting means the standard greeting; anything else must pass the same rule the database applies. */
export function greetingValue(text: string): string | null | undefined {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return schoolCallGreetingOk(trimmed) ? trimmed : undefined;
}
type SettingsDraft = { callingOn: boolean; greeting: string; recordingOn: boolean; consent: boolean };
const draftOf = (o: SchoolCallingOverview): SettingsDraft => ({ callingOn: o.callingOn, greeting: o.voicemailGreeting ?? '', recordingOn: o.recordingOn, consent: o.recordingOn });

/**
 * 0556 Calls page: the call log (all, missed, voicemail, outgoing), the after-call card, Ring me and the owner's calling
 * settings. Every call carries the shell's school scope, which the server re-checks with communication.call.use (settings:
 * communication.call.manage). Nothing here dials or reaches Twilio; the browser phone (top bar) places and answers calls.
 */
export function StaffCalls(): React.ReactElement {
  const shell = useSchoolShell();
  const { preferences, date } = useLocale();
  const copy = callsCopy(preferences.language);
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const scopeKey = selection ? `${selection.organizationId}/${selection.schoolId}` : '';
  const [overview, setOverview] = useState<SchoolCallingOverview | null>(null), [list, setList] = useState<SchoolCallList | null>(null);
  const [filter, setFilter] = useState<SchoolCallFilter>('ALL'), [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState(''), [settings, setSettings] = useState<SettingsDraft | null>(null);
  const [busy, setBusy] = useState(false), [acting, setActing] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [denied, setDenied] = useState(false), [hidden, setHidden] = useState(false);
  const generation = useRef(0);

  const scopeOf = useCallback((): CallsScope | null => {
    const [organizationId, schoolId] = scopeKey.split('/');
    return organizationId && schoolId ? { organizationId, schoolId } : null;
  }, [scopeKey]);
  const clear = useCallback(() => { ++generation.current; setOverview(null); setList(null); setOpenId(null); setNote(''); setSettings(null); }, []);
  const refresh = useCallback(async (nextFilter?: SchoolCallFilter) => {
    const scope = scopeOf();
    if (!scope) return;
    const token = ++generation.current;
    setBusy(true); setDenied(false);
    try {
      const [o, l] = await Promise.all([loadCalling(scope), loadCalls(scope, { filter: nextFilter ?? filter })]);
      if (generation.current !== token) return;
      setOverview(o); setList(l); setSettings(draftOf(o)); setError(''); setHidden(false);
    } catch (problem) {
      if (generation.current !== token) return;
      setOverview(null); setList(null); setError(message(problem, copy)); setDenied(problem instanceof CallsAccessError);
    } finally { if (generation.current === token) setBusy(false); }
  }, [scopeOf, filter, copy]);
  useEffect(() => { clear(); void refresh(); }, [scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps -- reload on a new school only
  useEffect(() => onShellPrivacyEvent(() => { clear(); setError(''); setNotice(''); setHidden(true); }), [clear]);

  async function more() {
    const scope = scopeOf();
    if (!scope || !list?.nextCursor) return;
    const token = generation.current;
    try {
      const page = await loadCalls(scope, { filter, before: list.nextCursor });
      if (generation.current !== token) return;
      setList({ calls: [...list.calls, ...page.calls.filter(c => !list.calls.some(x => x.callId === c.callId))], nextCursor: page.nextCursor });
    } catch (problem) { if (generation.current === token) setError(message(problem, copy)); }
  }
  /** Commands are version-checked, not keyed: an unconfirmed one is never retried blind; the page reloads instead. */
  async function command(run: (scope: CallsScope) => Promise<unknown>, done: string): Promise<boolean> {
    const scope = scopeOf();
    if (!scope) return false;
    setActing(true); setError(''); setNotice('');
    try { await run(scope); setNotice(done); await refresh(); return true; }
    catch (problem) {
      if (problem instanceof CallsAccessError) { clear(); setDenied(true); setError(message(problem, copy)); }
      else if (problem instanceof CallsRefusal) {
        const msg = message(problem, copy);
        if (/VERSION_CONFLICT|CALL_CONFLICT/.test(problem.code)) await refresh();
        setError(msg);
      } else { setError(copy.unknownSave); }
      return false;
    } finally { setActing(false); }
  }
  function choose(next: SchoolCallFilter) { setFilter(next); setOpenId(null); void refresh(next); }
  function openCall(c: SchoolCall) { setOpenId(c.callId === openId ? null : c.callId); setNote(c.note ?? ''); setNotice(''); }
  function saveOutcome(c: SchoolCall, outcome: SchoolCallOutcome | null) {
    void command(scope => updateCall(scope, { callId: c.callId, expectedVersion: c.version, outcome }), copy.saved);
  }
  function saveNote(event: React.FormEvent, c: SchoolCall) {
    event.preventDefault();
    const value = note.trim() ? note : null;
    if (value !== null && !schoolCallNoteOk(value)) return;
    void command(scope => updateCall(scope, { callId: c.callId, expectedVersion: c.version, note: value }), copy.saved);
  }
  function saveSettings(event: React.FormEvent) {
    event.preventDefault();
    if (!overview || !settings) return;
    const greeting = greetingValue(settings.greeting);
    if (greeting === undefined || (settings.recordingOn && !settings.consent)) return;
    void command(scope => saveCallingSettings(scope, { callingOn: settings.callingOn, voicemailGreeting: greeting, recordingOn: settings.recordingOn,
      recordingConsentAccepted: settings.recordingOn && settings.consent, expectedVersion: overview.version }), copy.settingsSaved);
  }

  if (!selection) return <p role="status">{copy.chooseSchool}</p>;
  const open = list?.calls.find(c => c.callId === openId) ?? null;
  const ringers = overview?.staff?.filter(m => m.ringMe).map(m => m.name) ?? [];
  const greetingOk = settings ? greetingValue(settings.greeting) !== undefined : false;
  return <main className={s.page}><div className={s.shell}>
    <header className={s.header}><h1>{copy.title}</h1><p>{copy.intro}</p></header>
    {hidden && !list && <p className={s.actions}><span className={s.subtle}>{copy.hidden}</span> <button type="button" onClick={() => void refresh()}>{copy.show}</button></p>}
    <div aria-live="polite">{busy && !list && <p role="status">{copy.loading}</p>}
      {error && <div className={s.error} role="alert"><strong>{denied ? copy.deniedTitle : copy.title}</strong><p>{error}</p></div>}
      {notice && <p className={s.notice} role="status">{notice}</p>}</div>

    {overview && <section className={s.card} aria-label={copy.schoolNumber}>
      <h2>{copy.schoolNumber}: {overview.schoolNumber ? formatCallNumber(overview.schoolNumber) : '—'}</h2>
      {!overview.numberReady && <p>{copy.noNumber} <a href="/staff/settings/texting-number">{copy.setUpNumber}</a></p>}
      <p><strong>{overview.callingOn ? copy.callingOn : copy.callingOff}</strong>{!overview.callingOn && <> · <span className={s.subtle}>{copy.callingOffHint}</span></>}</p>
      <p>{copy.missedToday(overview.missedToday)} · {copy.unheard(overview.unheardVoicemails)}</p>
      <p className={s.actions}>
        <label><input type="checkbox" checked={overview.ringMe} disabled={acting || !overview.callingOn}
          onChange={e => { const on = e.target.checked; void command(scope => setRingMe(scope, on), on ? copy.ringMeOn : copy.ringMeOff); }} /> {copy.ringMe}</label>
        <span className={s.subtle}>{copy.ringMeHint}</span></p>
      {overview.callingOn && <p className={s.subtle}>{overview.staff ? (ringers.length ? copy.ringing(ringers.join(', ')) + '.' : copy.nobodyRings) + ' ' : ''}
        {copy.forwardingNote}{overview.missedCallTextBack ? ` ${copy.textBackNote}` : ''}</p>}
    </section>}

    {list && <section className={s.card} aria-label={copy.log}>
      <h2>{copy.log}</h2>
      <p className={`${s.actions} ${c.pressed}`} role="group" aria-label={copy.log}>
        {SCHOOL_CALL_FILTERS.map(f => <button key={f} type="button" aria-pressed={filter === f} disabled={busy} onClick={() => choose(f)}>{copy.filters[f]}</button>)}
        <button type="button" disabled={busy} onClick={() => void refresh()}>{copy.refresh}</button>
      </p>
      {list.calls.length === 0 ? <p className={s.empty}>{filter === 'ALL' ? copy.empty : copy.emptyFiltered}</p> : <ul className={s.list}>
        {list.calls.map(c => <li key={c.callId}>
          <button type="button" aria-expanded={openId === c.callId} onClick={() => openCall(c)}>
            {who(c, copy)}</button>{' '}
          <span className={s.subtle}>{c.direction === 'IN' ? copy.incoming : copy.outgoing} · {copy.status[c.status]}
            {c.durationSeconds ? ` · ${formatCallDuration(c.durationSeconds)}` : ''} · {date(c.startedAt)}{c.staffName ? ` · ${copy.by(c.staffName)}` : ''}</span>
          {c.voicemail && <span className={s.badge}> {c.heard ? copy.voicemailHeard : copy.voicemailNew}</span>}
          {c.recorded && <span className={s.subtle}> · {copy.recorded}</span>}
          {c.doNotCall && <span className={s.subtle}> · {copy.doNotCallBadge}</span>}
          {c.outcome && <span className={s.subtle}> · {copy.outcomes[c.outcome]}</span>}
        </li>)}
      </ul>}
      {list.nextCursor && <p className={s.actions}><button type="button" disabled={busy} onClick={() => void more()}>{copy.more}</button></p>}
    </section>}

    {open && <section className={s.card} aria-label={copy.card(who(open, copy))}>
      <h2>{copy.card(who(open, copy))}</h2>
      <p className={s.subtle}>{formatCallNumber(open.remoteE164)} · {copy.status[open.status]} · {date(open.startedAt)}</p>
      {!open.doNotCall && <p className={s.actions}><CallButton phoneE164={open.remoteE164} personId={open.personId ?? undefined} name={open.contactName ?? undefined}
        language={preferences.language} /></p>}
      <fieldset className={c.outcomes}><legend>{copy.outcome}</legend><p className={`${s.actions} ${c.pressed}`}>
        {SCHOOL_CALL_OUTCOMES.map(o => <button key={o} type="button" aria-pressed={open.outcome === o} disabled={acting} onClick={() => saveOutcome(open, o)}>{copy.outcomes[o]}</button>)}
        {open.outcome && <button type="button" disabled={acting} onClick={() => saveOutcome(open, null)}>{copy.clearOutcome}</button>}
      </p></fieldset>
      <form className={c.form} onSubmit={e => saveNote(e, open)}>
        <label htmlFor="call-note">{copy.note}</label>
        <textarea id="call-note" rows={3} value={note} maxLength={SCHOOL_CALL_LIMITS.noteMax + 1} onChange={e => setNote(e.target.value)} disabled={acting} aria-describedby="call-note-hint" />
        <p id="call-note-hint" className={s.subtle}>{copy.noteHint}</p>
        <p className={s.actions}><button type="submit" disabled={acting || (note.trim() !== '' && !schoolCallNoteOk(note)) || note === (open.note ?? '')}>{copy.save}</button></p>
      </form>
      {open.voicemail && !open.heard && <p className={s.actions}><button type="button" disabled={acting}
        onClick={() => void command(scope => updateCall(scope, { callId: open.callId, expectedVersion: open.version, heard: true }), copy.markedHeard)}>{copy.markHeard}</button></p>}
      {open.recordingAvailable && scopeOf() && <div>
        <p><strong>{copy.listen(open.recordingSeconds === null ? '' : formatCallDuration(open.recordingSeconds))}</strong></p>
        <audio key={open.callId} controls preload="none" src={recordingUrl(scopeOf()!, open.callId)} style={{ width: '100%', maxWidth: 480 }}
          aria-label={copy.listen('')} data-call-recording="" />
        <p className={s.subtle}>{copy.recordingKept}</p></div>}
      <p className={s.actions}><button type="button" disabled={acting}
        onClick={() => void command(scope => setDoNotCall(scope, { phoneE164: open.remoteE164, doNotCall: !open.doNotCall }), open.doNotCall ? copy.doNotCallRemoved : copy.doNotCallAdded)}>
        {open.doNotCall ? copy.removeDoNotCall : copy.addDoNotCall}</button> <span className={s.subtle}>{copy.doNotCallHint}</span></p>
    </section>}

    {overview && settings && <section className={s.card} aria-label={copy.settings}>
      <h2>{copy.settings}</h2>
      {!overview.canManage ? <p className={s.subtle}>{copy.ownerOnly}</p> : <form className={c.form} onSubmit={saveSettings}>
        <p className={s.subtle}>{copy.settingsHint}</p>
        <p><label><input type="checkbox" checked={settings.callingOn} disabled={acting} onChange={e => setSettings({ ...settings, callingOn: e.target.checked })} /> {copy.turnOn}</label></p>
        <label htmlFor="call-greeting">{copy.greeting}</label>
        <textarea id="call-greeting" rows={2} value={settings.greeting} maxLength={SCHOOL_CALL_LIMITS.greetingMax + 1} disabled={acting} aria-describedby="call-greeting-hint"
          onChange={e => setSettings({ ...settings, greeting: e.target.value })} />
        <p id="call-greeting-hint" className={s.subtle}>{copy.greetingHint}</p>
        <p><label><input type="checkbox" checked={settings.recordingOn} disabled={acting}
          onChange={e => setSettings({ ...settings, recordingOn: e.target.checked, consent: e.target.checked && settings.consent })} /> {copy.recording}</label>
          {' '}<span className={s.subtle}>{copy.recordingHint}</span></p>
        {settings.recordingOn && <blockquote>{SCHOOL_CALL_RECORDING_CONSENT}
          <p>{overview.recordingConsentAt && overview.recordingOn ? copy.consentAccepted(date(overview.recordingConsentAt)) : <label>
            <input type="checkbox" checked={settings.consent} disabled={acting} onChange={e => setSettings({ ...settings, consent: e.target.checked })} /> {copy.consentLabel}</label>}</p>
        </blockquote>}
        <p className={s.actions}><button type="submit" disabled={acting || !greetingOk || (settings.recordingOn && !settings.consent)}>{copy.saveSettings}</button></p>
      </form>}
    </section>}
  </div></main>;
}
