'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { validatePersonRecordUpdateInput, validateStudentBirthDateUpdateInput, type PersonRecord, type PersonRecordUpdateInput,
  type SchoolContactCard, type SchoolContactOptions, type StudentBirthDateUpdateInput } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { PersonRecordError, peopleApi, sameEmail, type PeopleApi } from './http';
import { attemptOutcome, type ListState, type RecordState, type SaveOutcome } from './model';
import { PeopleView, type BirthDraft, type ContactDraft } from './view';
import { PersonConsents } from './consents';
import { consentApi, type ConsentApi } from './consent-http';
import { NO_CONTACT_FILTERS, contactAdminApi, contactsApi, type ContactAdminApi, type ContactFilters, type ContactsApi } from './contacts-http';
import { ContactActions, type ContactChange } from './contact-actions';
import type { CardState, CardTab, MembershipItem } from './contact-card';
import { MembershipPanel } from './membership-panel';
import { NewMembershipTools } from './new-membership';
import { initialCardTarget } from './card-link';
import { PersonPhoto } from './photo';
import { AgreementLinkPanel } from '../agreement-link/send-panel';
import { ContactMessageHistory } from '../contact-history/contact-history';
import { photoApi, type PhotoApi } from './photo-http';

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
export function People({ api = peopleApi, consents = consentApi, contacts = contactsApi, admin = contactAdminApi, photos = photoApi }: { api?: PeopleApi; consents?: ConsentApi;
  contacts?: ContactsApi; admin?: ContactAdminApi; photos?: PhotoApi }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const [list, setList] = useState<ListState>({ state: 'LOADING' });
  const [filters, setFilters] = useState<ContactFilters>(NO_CONTACT_FILTERS);
  // The rank, program and plan choices, read once with the first page for this school.
  const [options, setOptions] = useState<SchoolContactOptions | null>(null);
  const [listRefresh, setListRefresh] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [record, setRecord] = useState<RecordState>({ state: 'NONE' });
  const [recordRefresh, setRecordRefresh] = useState(0);
  const [card, setCard] = useState<CardState>({ state: 'NONE' });
  const [cardTab, setCardTab] = useState<CardTab>('overview');
  const [cardRefresh, setCardRefresh] = useState(0);
  const cardGeneration = useRef(0);
  // A card read again after a membership change keeps showing the card meanwhile, so the open panel and its answer stay.
  const quietCard = useRef(false);
  // A People link (for example from the membership report) names a card to open, once, after the school is verified.
  const linkHandled = useRef(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
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
    cardGeneration.current++;
    setList({ state: 'LOADING' }); setRecord(prior => prior.state === 'NONE' ? prior : { state: 'LOADING' }); setCard(prior => prior.state === 'NONE' ? prior : { state: 'LOADING' }); setOutcome(null); setActionNotice(null); drop();
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), [drop]);

  const school = selection ? lower(selection.schoolId) : null;
  useEffect(() => {
    if (school !== null && lastSchool.current !== null && school !== lastSchool.current) {
      selected.current = null; setSelectedId(null); setFilters(NO_CONTACT_FILTERS); setOptions(null); setOutcome(null); drop();
    }
    if (school !== null) lastSchool.current = school;
  }, [school, drop]);

  useEffect(() => {
    const current = ++listGeneration.current;
    setList({ state: 'LOADING' });
    if (!selection) return;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    contacts.list({ organizationId: selection.organizationId, schoolId: selection.schoolId }, filters, null, options === null, signal).then(
      page => {
        if (current !== listGeneration.current) return;
        if (page.options) setOptions(page.options);
        setList({ state: 'READY', filters, counts: page.counts, rows: page.rows, nextCursor: page.nextCursor, more: 'IDLE' });
      },
      error => { if (current === listGeneration.current) setList({ state: error instanceof PersonRecordError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [selection?.organizationId, selection?.schoolId, filters, listRefresh, contacts]); // eslint-disable-line react-hooks/exhaustive-deps

  // The next page continues the same filters; a filter change, a reload or concealment retires it (the generation moves on).
  const onMore = useCallback(() => {
    if (!selection || list.state !== 'READY' || !list.nextCursor || list.more === 'LOADING') return;
    const current = listGeneration.current, shown = list;
    setList({ ...shown, more: 'LOADING' });
    contacts.list({ organizationId: selection.organizationId, schoolId: selection.schoolId }, shown.filters, shown.nextCursor, false, AbortSignal.timeout(15000)).then(
      page => {
        if (current !== listGeneration.current) return;
        const seen = new Set(shown.rows.map(r => r.personId));
        setList({ ...shown, counts: page.counts, rows: [...shown.rows, ...page.rows.filter(r => !seen.has(r.personId))], nextCursor: page.nextCursor, more: 'IDLE' });
      },
      () => { if (current === listGeneration.current) setList({ ...shown, more: 'FAILED' }); });
  }, [selection?.organizationId, selection?.schoolId, list, contacts]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // The contact card is read with the record and again after a save; a denied or missing person shows the record's own message.
  useEffect(() => {
    const current = ++cardGeneration.current, quiet = quietCard.current;
    quietCard.current = false;
    if (!selectedId) { setCard({ state: 'NONE' }); return; }
    if (!quiet) setCard({ state: 'LOADING' });
    if (!selection) return;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    contacts.card({ organizationId: selection.organizationId, schoolId: selection.schoolId }, selectedId, signal).then(
      value => { if (current === cardGeneration.current) setCard({ state: 'READY', card: value }); },
      error => {
        if (current !== cardGeneration.current) return;
        const kind = error instanceof PersonRecordError ? error.kind : 'UNKNOWN';
        setCard(kind === 'DENIED' || kind === 'MISSING' || kind === 'SESSION' ? { state: 'NONE' } : { state: 'UNAVAILABLE' });
      });
    return () => { abort.abort(); };
  }, [selection?.organizationId, selection?.schoolId, selectedId, recordRefresh, cardRefresh, contacts]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (linkHandled.current || !selection) return;
    linkHandled.current = true;
    const target = initialCardTarget(globalThis.location?.search ?? '');
    if (!target) return;
    selected.current = target.personId; setSelectedId(target.personId); setCardTab(target.tab); setRecordRefresh(value => value + 1);
  }, [selection]);

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
    selected.current = personId; setSelectedId(personId); setCardTab('overview'); setOutcome(null); setActionNotice(null); drop(); setRecordRefresh(value => value + 1);
  }, [drop]);
  // After a delete, restore or merge: read the list and the card again; a merge opens the person who was kept.
  const onContactChanged = useCallback((change: ContactChange, notice: string) => {
    if (!mounted.current) return;
    setListRefresh(n => n + 1);
    if (change.kind === 'MERGED' && change.keepPersonId !== selected.current) { selected.current = change.keepPersonId; setSelectedId(change.keepPersonId); setOutcome(null); drop(); }
    setRecordRefresh(n => n + 1); setActionNotice(notice);
  }, [drop]);
  const actionsSlot = useCallback((c: SchoolContactCard) => selection ? <ContactActions key={`${lower(selection.schoolId)}:${c.person.personId}:${c.overview.segment}`}
    language={preferences.language} scope={{ organizationId: selection.organizationId, schoolId: selection.schoolId }} card={c} onChanged={onContactChanged}
    api={admin} contacts={contacts}/> : null,
  [selection?.organizationId, selection?.schoolId, preferences.language, onContactChanged, admin, contacts]); // eslint-disable-line react-hooks/exhaustive-deps
  // After a membership is started, paused, resumed, cancelled or a refund recorded: read the card and the list again.
  const onMembershipChanged = useCallback(() => { if (!mounted.current) return; quietCard.current = true; setCardRefresh(n => n + 1); setListRefresh(n => n + 1); }, []);
  const membershipSlot = useCallback((m: MembershipItem) => selection ? <MembershipPanel key={`${lower(selection.schoolId)}:${m.membershipId}`} language={preferences.language}
    scope={{ organizationId: selection.organizationId, schoolId: selection.schoolId }} item={m} onChanged={onMembershipChanged}/> : null,
  [selection?.organizationId, selection?.schoolId, preferences.language, onMembershipChanged]); // eslint-disable-line react-hooks/exhaustive-deps
  // New membership and Renew (0398) at the top of the membership tab; the server decides who can have which plan.
  const membershipTools = useCallback((items: readonly MembershipItem[]) => selection && selectedId ? <NewMembershipTools key={`${lower(selection.schoolId)}:${selectedId}`}
    language={preferences.language} scope={{ organizationId: selection.organizationId, schoolId: selection.schoolId, personId: selectedId }} items={items}
    onChanged={onMembershipChanged}/> : null,
  [selection?.organizationId, selection?.schoolId, selectedId, preferences.language, onMembershipChanged]); // eslint-disable-line react-hooks/exhaustive-deps
  const onDiscard = useCallback(() => { setOutcome(null); drop(); setRecordRefresh(value => value + 1); }, [drop]);
  const onTryAgain = useCallback(() => { void send(); }, [send]);
  const onFilters = useCallback((next: ContactFilters) => { setFilters({ ...next, query: next.query.trim() }); setListRefresh(n => n + 1); }, []);
  const onReload = useCallback(() => setRecordRefresh(value => value + 1), []);
  // A recorded consent changes only that channel's summary, taken from the server's answer, so the contact form's consent rule is current.
  const onConsentRecorded = useCallback((channel: 'EMAIL' | 'SMS', status: 'OPTED_IN' | 'OPTED_OUT') => {
    setRecord(prior => prior.state === 'READY' ? { state: 'READY', record: { ...prior.record, consents: { ...prior.record.consents, [channel]: status } } } : prior);
  }, []);
  // The contact photo (0390) and contact consent each have their own reads and commands, mounted per person.
  const consentSlot = useCallback((r: PersonRecord) => selection ? <>
    <PersonPhoto key={`photo:${lower(selection.schoolId)}:${r.personId}`} language={preferences.language} schoolId={selection.schoolId} record={r} canEdit={r.canEdit} api={photos}/>
    <PersonConsents key={`${lower(selection.schoolId)}:${r.personId}`} language={preferences.language}
      scope={{ organizationId: selection.organizationId, schoolId: selection.schoolId }} record={r} canEdit={r.canEdit} onRecorded={onConsentRecorded} api={consents}/>
    {/* 0424: this person's texts, emails and messages (opened on request; needs the conversations permission). */}
    <ContactMessageHistory key={`history:${lower(selection.schoolId)}:${r.personId}`} scope={{ organizationId: selection.organizationId, schoolId: selection.schoolId }} personId={r.personId}/>
    {/* 0499: send the family a link to sign the membership agreement (students only; its own read decides access). */}
    {r.student ? <AgreementLinkPanel key={`agreement:${lower(selection.schoolId)}:${r.personId}`} language={preferences.language} schoolId={selection.schoolId} personId={r.personId}/> : null}
  </> : null,
  [selection?.organizationId, selection?.schoolId, preferences.language, onConsentRecorded, consents, photos]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <PeopleView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      hasSchool={selection !== null} list={list} record={record} selectedId={selectedId} outcome={outcome} locked={lock !== 'NONE'} canRetry={lock === 'KEPT'}
      filters={filters} options={options} card={card} cardTab={cardTab} membershipSlot={membershipSlot} membershipTools={membershipTools} actionsSlot={actionsSlot} actionNotice={actionNotice} onFilters={onFilters} onMore={onMore} onOpen={onOpen} onReload={onReload} onSaveContact={onSaveContact} onSaveBirth={onSaveBirth} onTryAgain={onTryAgain} onDiscard={onDiscard} consentSlot={consentSlot}/>
  </div>;
}
