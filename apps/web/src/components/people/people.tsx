'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { validatePersonRecordUpdateInput, validateStudentBirthDateUpdateInput, type PersonRecord, type PersonRecordUpdateInput,
  type StudentBirthDateUpdateInput } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { PersonRecordError, peopleApi, sameEmail, type PeopleApi } from './http';
import { attemptOutcome, type ListState, type RecordState, type SaveOutcome } from './model';
import { PeopleView, type BirthDraft, type ContactDraft } from './view';

/**
 * A save whose outcome is not known yet: the exact request and key, in memory only, so "Try again" replays it.
 * Both commands replace whole values and carry the version they were read at, so dropping a kept request (Reload,
 * opening another person, concealment) can never apply anything twice or overwrite a newer change: a later save
 * from a stale read is refused as a version conflict.
 */
type Pending = Readonly<{ schoolId: string; personId: string; key: string }
  & ({ command: 'contact'; input: PersonRecordUpdateInput } | { command: 'birthDate'; input: StudentBirthDateUpdateInput })>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';
const newKey = () => globalThis.crypto.randomUUID();
const lower = (v: string) => v.toLowerCase();

/** Builds the closed edit body from the form, or says why it cannot be sent. Never sends an unchanged record. */
export function contactInput(schoolId: string, record: PersonRecord, draft: ContactDraft): PersonRecordUpdateInput | 'INVALID' | 'UNCHANGED' {
  const email = draft.email.trim(), phone = draft.phone.replace(/[\s().-]/g, '');
  let input: PersonRecordUpdateInput;
  try {
    input = validatePersonRecordUpdateInput({ schoolId, personId: record.personId, expectedVersion: record.version, givenName: draft.givenName,
      familyName: draft.familyName, email: email === '' ? null : email, phoneE164: phone === '' ? null : phone });
  } catch { return 'INVALID'; }
  return input.givenName === record.givenName && input.familyName === record.familyName && sameEmail(input.email, record.email) && input.phoneE164 === record.phoneE164
    ? 'UNCHANGED' : input;
}
export function birthDateInput(schoolId: string, record: PersonRecord, draft: BirthDraft): StudentBirthDateUpdateInput | 'INVALID' | 'UNCHANGED' | null {
  const version = record.student?.version;
  if (!record.student || version === undefined) return null;
  let input: StudentBirthDateUpdateInput;
  try { input = validateStudentBirthDateUpdateInput({ schoolId, personId: record.personId, expectedVersion: version, birthDate: draft.birthDate, reason: draft.reason }); }
  catch { return 'INVALID'; }
  return input.birthDate === record.student.birthDate ? 'UNCHANGED' : input;
}

/**
 * People for the school the shell verified: search, read one person, correct name and contact details, and correct
 * a child's birth date. Blur, a hidden tab, page hide, a school change or a session end hide the page at once, retire
 * every read and drop any kept save; reads start again only after the shell re-verifies the school.
 */
export function People({ api = peopleApi }: { api?: PeopleApi }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const [list, setList] = useState<ListState>({ state: 'LOADING' });
  const [query, setQuery] = useState('');
  const [listRefresh, setListRefresh] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [record, setRecord] = useState<RecordState>({ state: 'NONE' });
  const [recordRefresh, setRecordRefresh] = useState(0);
  const [outcome, setOutcome] = useState<SaveOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const listGeneration = useRef(0), recordGeneration = useRef(0);
  // Advances only when the page is concealed, so a save answer is shown unless private display was retired meanwhile.
  const privacy = useRef(0);
  const pending = useRef<Pending | null>(null);
  const sending = useRef(false);
  const selected = useRef<string | null>(null);
  const lastSchool = useRef<string | null>(null);
  const drop = useCallback(() => { pending.current = null; setLock(sending.current ? 'SENDING' : 'NONE'); }, []);
  // Cleared on unmount: a save started by this People view never speaks for a later one.
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; pending.current = null; }; }, []);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); listGeneration.current++; recordGeneration.current++; privacy.current++;
    setList({ state: 'LOADING' }); setRecord(prior => prior.state === 'NONE' ? prior : { state: 'LOADING' }); setOutcome(null); drop();
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), [drop]);

  const school = selection ? lower(selection.schoolId) : null;
  useEffect(() => {
    if (school !== null && lastSchool.current !== null && school !== lastSchool.current) {
      selected.current = null; setSelectedId(null); setQuery(''); setOutcome(null); drop();
    }
    if (school !== null) lastSchool.current = school;
  }, [school, drop]);

  useEffect(() => {
    const current = ++listGeneration.current;
    setList({ state: 'LOADING' });
    if (!selection) return;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.search({ organizationId: selection.organizationId, schoolId: selection.schoolId }, query, signal).then(
      items => { if (current === listGeneration.current) setList({ state: 'READY', query, items }); },
      error => { if (current === listGeneration.current) setList({ state: error instanceof PersonRecordError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [selection?.organizationId, selection?.schoolId, query, listRefresh, api]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const current = ++recordGeneration.current;
    if (!selectedId) { setRecord({ state: 'NONE' }); return; }
    setRecord({ state: 'LOADING' });
    if (!selection) return;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.read(selection.schoolId, selectedId, signal).then(
      value => { if (current === recordGeneration.current) setRecord({ state: 'READY', record: value }); },
      error => {
        if (current !== recordGeneration.current) return;
        const kind = error instanceof PersonRecordError ? error.kind : 'UNKNOWN';
        setRecord({ state: kind === 'DENIED' ? 'DENIED' : kind === 'MISSING' ? 'MISSING' : 'UNAVAILABLE' });
      });
    return () => { abort.abort(); };
  }, [selection?.schoolId, selectedId, recordRefresh, api]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current || !selection || lower(selection.schoolId) !== request.schoolId) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING', command: request.command });
    let next: SaveOutcome, keep: boolean, saved: PersonRecord | null = null;
    try {
      const signal = AbortSignal.timeout(30000), owned = () => mounted.current && shown === privacy.current
        && pending.current?.key === request.key && selected.current === request.personId && lastSchool.current === request.schoolId;
      if (request.command === 'contact') {
        const result = await api.update(request.input, request.key, signal, owned);
        saved = result.person; next = { kind: 'SAVED', command: 'contact', fields: result.changedFields };
      } else {
        const result = await api.updateBirthDate(request.input, request.key, signal, owned);
        saved = result.person; next = { kind: 'SAVED', command: 'birthDate', enrollmentCorrected: result.enrollmentCorrected };
      }
      keep = false;
    } catch (error) { ({ outcome: next, keep } = attemptOutcome(error, request.command)); }
    finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (saved) setListRefresh(value => value + 1);
    // Concealed meanwhile, or another person opened: the answer is not shown; the saved record is read again on return.
    if (shown !== privacy.current || selected.current !== request.personId) {
      setOutcome(prior => prior?.kind === 'SENDING' ? null : prior); setRecordRefresh(value => value + 1); return;
    }
    setOutcome(next);
    if (saved) {
      // A replayed receipt saved before 0218 has no student version: read the record again rather than guess it.
      if (saved.student && saved.student.version === undefined) setRecordRefresh(value => value + 1);
      else setRecord({ state: 'READY', record: saved });
    }
  }, [api, selection?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = record.state === 'READY' ? record.record : null;
  const start = useCallback((next: Pending) => { pending.current = next; void send(); }, [send]);
  const onSaveContact = useCallback((draft: ContactDraft) => {
    if (lock !== 'NONE' || pending.current || sending.current || !selection || !current || !current.canEdit) return;
    const input = contactInput(selection.schoolId, current, draft);
    if (input === 'INVALID' || input === 'UNCHANGED') { setOutcome({ kind: input === 'INVALID' ? 'LOCAL_INVALID' : 'LOCAL_UNCHANGED', command: 'contact' }); return; }
    start({ schoolId: lower(selection.schoolId), personId: current.personId, key: newKey(), command: 'contact', input });
  }, [lock, selection?.schoolId, current, start]); // eslint-disable-line react-hooks/exhaustive-deps
  const onSaveBirth = useCallback((draft: BirthDraft) => {
    if (lock !== 'NONE' || pending.current || sending.current || !selection || !current || !current.canEdit) return;
    const input = birthDateInput(selection.schoolId, current, draft);
    if (input === null) return;
    if (input === 'INVALID' || input === 'UNCHANGED') { setOutcome({ kind: input === 'INVALID' ? 'LOCAL_INVALID' : 'LOCAL_UNCHANGED', command: 'birthDate' }); return; }
    start({ schoolId: lower(selection.schoolId), personId: current.personId, key: newKey(), command: 'birthDate', input });
  }, [lock, selection?.schoolId, current, start]); // eslint-disable-line react-hooks/exhaustive-deps
  const onOpen = useCallback((personId: string) => {
    selected.current = personId; setSelectedId(personId); setOutcome(null); drop(); setRecordRefresh(value => value + 1);
  }, [drop]);
  const onDiscard = useCallback(() => { setOutcome(null); drop(); setRecordRefresh(value => value + 1); }, [drop]);
  const onTryAgain = useCallback(() => { void send(); }, [send]);
  const onSearch = useCallback((value: string) => { setQuery(value.trim()); setListRefresh(n => n + 1); }, []);
  const onReload = useCallback(() => setRecordRefresh(value => value + 1), []);

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <PeopleView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      hasSchool={selection !== null} list={list} record={record} selectedId={selectedId} outcome={outcome} locked={lock !== 'NONE'} canRetry={lock === 'KEPT'}
      onSearch={onSearch} onOpen={onOpen} onReload={onReload} onSaveContact={onSaveContact} onSaveBirth={onSaveBirth} onTryAgain={onTryAgain} onDiscard={onDiscard}/>
  </div>;
}
