'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { kaiAddDays, kaiJournalPeriod, kaiJournalSuggestions, kaiJournalTopicHints, kaiJournalTopicTally, type SaveKaiJournalEntryInput } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { browserRecognition, detectHonVoiceSupport, honVoiceLang, type RecognitionAdapter, type RecognitionSession } from '../hon-command/hon-voice';
import { JournalError, journalApi, keepForRetry, type JournalApi, type JournalScope } from './http';
import { addTopic, draftOf, draftProblems, newDraft, saveInput, type JournalDraft } from './draft';
import { KaiJournalView, type DraftField, type JournalOutcome, type JournalReadState, type JournalRecallState, type JournalTeamState } from './view';

type Pending = Readonly<{ key: string; scope: JournalScope; input: SaveKaiJournalEntryInput }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';
const browserToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
type VoiceWindow = Parameters<typeof detectHonVoiceSupport>[0];
const voiceWindow = (): VoiceWindow | null => typeof window === 'undefined' ? null : window as unknown as VoiceWindow;

/**
 * Kai teaching journal (0476). The instructor tells Kai what they taught (typed, or dictated with the browser's own free
 * speech recognition), asks Kai what they worked on, and sees pattern notes from fixed rules. No AI runs here. The form and
 * any unanswered save live in memory only; a school change or session end drops them. Every save answer is followed by a
 * fresh read.
 */
export function KaiJournal({ api = journalApi, recognition, initialToday }: { api?: JournalApi; recognition?: RecognitionAdapter | null; initialToday?: string }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [today, setToday] = useState(() => initialToday ?? browserToday());
  const [read, setRead] = useState<JournalReadState>({ state: 'LOADING' });
  const [team, setTeam] = useState<JournalTeamState>({ state: 'LOADING' });
  const [draft, setDraft] = useState<JournalDraft>(() => newDraft(initialToday ?? browserToday()));
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<JournalOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const [refresh, setRefresh] = useState(0);
  const [question, setQuestion] = useState('');
  const [recall, setRecall] = useState<JournalRecallState>(null);
  const [listening, setListening] = useState(false);
  const [speechFailed, setSpeechFailed] = useState(false);
  const gen = useRef(0), privacy = useRef(0), mounted = useRef(false), lastSchool = useRef<string | null>(null), recallGen = useRef(0);
  const pending = useRef<Pending | null>(null), sending = useRef(false), speech = useRef<RecognitionSession | null>(null);
  const adapter = useMemo<RecognitionAdapter | null>(() => {
    if (recognition !== undefined) return recognition;
    const win = voiceWindow();
    return win && detectHonVoiceSupport(win).recognition ? browserRecognition(win) : null;
  }, [recognition]);
  const stopSpeech = useCallback(() => { speech.current?.abort(); speech.current = null; setListening(false); }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; gen.current++; pending.current = null; speech.current?.abort(); speech.current = null; }; }, []);

  const forget = useCallback(() => { stopSpeech(); setDraft(newDraft(today)); setConfirming(false); setOutcome(null); setRecall(null); setQuestion(''); }, [stopSpeech, today]);
  useEffect(() => onShellPrivacyEvent((event) => {
    concealShellPrivateNow(); gen.current++; privacy.current++; recallGen.current++; pending.current = null; stopSpeech();
    setLock(sending.current ? 'SENDING' : 'NONE'); setOutcome(null); setRead({ state: 'LOADING' }); setTeam({ state: 'LOADING' }); setRecall(null);
    if (event.type === HON_SESSION_INVALIDATED_EVENT || event.type === HON_SCHOOL_CONTEXT_CHANGED_EVENT) forget();
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), [forget, stopSpeech]);

  const school = schoolId ? schoolId.toLowerCase() : null;
  useEffect(() => {
    if (school !== null && lastSchool.current !== null && school !== lastSchool.current) forget();
    if (school !== null) lastSchool.current = school;
  }, [school, forget]);

  // The last 90 days (plus a day either side, for the school's time zone): recent entries, topic hints and pattern notes.
  useEffect(() => {
    const current = ++gen.current, shown = privacy.current;
    setRead({ state: 'LOADING' });
    if (!orgId || !schoolId) return;
    const owned = () => mounted.current && current === gen.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    const anchor = browserToday();
    api.read({ organizationId: orgId, schoolId }, kaiAddDays(anchor, -90), kaiAddDays(anchor, 1), signal, owned).then(
      (journal) => {
        if (!owned()) return;
        setRead({ state: 'READY', read: journal });
        if (!initialToday && journal.today !== today) { setToday(journal.today); setDraft((d) => d.entryId === null && !d.notes ? { ...d, taughtOn: journal.today } : d); }
      },
      (error) => { if (owned() && !abort.signal.aborted) setRead({ state: error instanceof JournalError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, orgId, schoolId, refresh, initialToday]); // eslint-disable-line react-hooks/exhaustive-deps

  // What other instructors at this school shared in the last 30 days (read-only). Refreshed with the page's own read.
  useEffect(() => {
    const shown = privacy.current;
    setTeam({ state: 'LOADING' });
    if (!orgId || !schoolId) return;
    let live = true;
    const owned = () => live && mounted.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    const anchor = browserToday();
    api.readTeam({ organizationId: orgId, schoolId }, kaiAddDays(anchor, -30), kaiAddDays(anchor, 1), signal, owned).then(
      (shared) => { if (owned()) setTeam({ state: 'READY', entries: shared.entries }); },
      (error) => { if (owned() && !abort.signal.aborted) setTeam({ state: error instanceof JournalError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { live = false; abort.abort(); };
  }, [api, orgId, schoolId, refresh]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SAVING' });
    let next: JournalOutcome, keep = false;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      await api.save(request.scope, request.input, request.key, AbortSignal.timeout(30000), owned);
      next = { kind: request.input.status === 'REMOVED' ? 'REMOVED' : 'SAVED' };
    } catch (error) {
      keep = keepForRetry(error);
      next = { kind: error instanceof JournalError ? error.kind : 'UNKNOWN' };
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next);
    if (next?.kind === 'SAVED' || next?.kind === 'REMOVED' || next?.kind === 'CHANGED' || next?.kind === 'GONE') { setDraft(newDraft(today)); setConfirming(false); setRecall(null); }
    if (!keep) setRefresh((n) => n + 1);
  }, [api, today]);

  const problems = useMemo(() => draftProblems(draft, today), [draft, today]);
  const queue = useCallback((input: SaveKaiJournalEntryInput) => {
    if (lock !== 'NONE' || pending.current || sending.current || !orgId || !schoolId) return;
    stopSpeech();
    pending.current = { key: globalThis.crypto.randomUUID(), scope: { organizationId: orgId, schoolId }, input };
    void send();
  }, [lock, orgId, schoolId, send, stopSpeech]);
  const onSave = useCallback(() => { if (!problems.length) queue(saveInput(draft)); }, [draft, problems, queue]);
  const onConfirmRemove = useCallback(() => {
    const original = read.state === 'READY' ? read.read.entries.find((e) => e.entryId === draft.entryId) : undefined;
    // Removing sends the entry exactly as it was read, whatever the form now holds.
    if (original) queue(saveInput(draftOf(original), true));
  }, [draft.entryId, queue, read]);
  const onEdit = useCallback((field: DraftField, value: string) => { if (lock === 'NONE') setDraft((d) => ({ ...d, [field]: value })); }, [lock]);
  const onAddTopic = useCallback((topic?: string) => { if (lock === 'NONE') setDraft((d) => addTopic(d, topic)); }, [lock]);
  const onShare = useCallback((shared: boolean) => { if (lock === 'NONE') setDraft((d) => ({ ...d, shared })); }, [lock]);
  const onRemoveTopic = useCallback((topic: string) => { if (lock === 'NONE') setDraft((d) => ({ ...d, topics: d.topics.filter((t) => t !== topic) })); }, [lock]);

  const onSpeak = useCallback(() => {
    if (!adapter || lock !== 'NONE') return;
    if (speech.current) { speech.current.stop(); return; }
    setSpeechFailed(false); setListening(true);
    const shown = privacy.current;
    speech.current = adapter.start({ lang: honVoiceLang(preferences.language), continuous: true, onDevice: false }, {
      onInterim: () => undefined,
      onFinal: (text) => {
        if (!text || shown !== privacy.current || !mounted.current) return;
        setDraft((d) => { const joined = d.notes ? `${d.notes.replace(/\s+$/, '')} ${text}` : text; return { ...d, notes: joined.slice(0, 2000), source: 'SPOKEN' }; });
      },
      onError: (code) => { if (code !== 'aborted' && code !== 'no-speech' && mounted.current) setSpeechFailed(true); },
      onEnd: () => { speech.current = null; if (mounted.current) setListening(false); },
    });
  }, [adapter, lock, preferences.language]);

  const onAsk = useCallback((asked?: string) => {
    const text = (asked ?? question).trim();
    if (!orgId || !schoolId || !text) return;
    if (asked !== undefined) setQuestion(asked);
    const period = kaiJournalPeriod(text, today);
    const current = ++recallGen.current, shown = privacy.current;
    const owned = () => mounted.current && current === recallGen.current && shown === privacy.current;
    setRecall({ state: 'LOADING', period });
    api.read({ organizationId: orgId, schoolId }, period.from, period.to, AbortSignal.timeout(15000), owned).then(
      (journal) => { if (owned()) setRecall({ state: 'READY', period, entries: journal.entries, topics: kaiJournalTopicTally(journal.entries) }); },
      () => { if (owned()) setRecall({ state: 'UNAVAILABLE', period }); });
  }, [api, orgId, schoolId, question, today]);

  const entries = read.state === 'READY' ? read.read.entries : [];
  const suggestions = useMemo(() => kaiJournalSuggestions(entries, today), [entries, today]);
  const hints = useMemo(() => kaiJournalTopicHints(draft.notes, kaiJournalTopicTally(entries), draft.topics), [draft.notes, draft.topics, entries]);

  return <div key={shell.phase} data-shell-private="">
    <KaiJournalView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      hasSchool={!!schoolId} today={today} read={read} draft={draft} problems={problems} hints={hints}
      speech={{ supported: !!adapter, listening, failed: speechFailed }} confirmingRemove={confirming} outcome={outcome}
      locked={lock !== 'NONE'} canRetry={lock === 'KEPT'} question={question} recall={recall} suggestions={suggestions} team={team} onShare={onShare}
      onEdit={onEdit} onAddTopic={onAddTopic} onRemoveTopic={onRemoveTopic} onSpeak={onSpeak} onSave={onSave}
      onCancelEdit={() => { if (lock === 'NONE') { stopSpeech(); setDraft(newDraft(today)); setConfirming(false); } }}
      onAskRemove={() => setConfirming(true)} onConfirmRemove={onConfirmRemove} onKeep={() => setConfirming(false)}
      onOpen={(entry) => { if (lock === 'NONE') { stopSpeech(); setDraft(draftOf(entry)); setConfirming(false); setOutcome(null); globalThis.scrollTo?.({ top: 0 }); } }}
      onQuestion={setQuestion} onAsk={onAsk} onRefresh={() => setRefresh((n) => n + 1)} onTryAgain={() => { void send(); }} />
  </div>;
}
