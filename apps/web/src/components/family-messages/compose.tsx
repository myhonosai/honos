'use client';
import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { PersonRecordError, peopleApi, type PersonSummary } from '../people/http';
import { COMPOSE_MAX, ComposeRefusal, composeOk, createDraft, queueDraft, type ComposeChannel, type ComposeDraft, type ComposeScope } from './compose-http';
import s from '../comms-kit/comms.module.css';
import { MERGE_TAGS, fillMergeTags, insertAt, mergeTagsIn, unknownMergeTags } from '../comms-kit/merge-tags';
import { smsSegments } from '../comms-kit/sms-segments';
import { initials } from '../comms-kit/initials';

type Step = Readonly<{ kind: 'create'; key: string } | { kind: 'queue'; draft: ComposeDraft; key: string }>;
type Outcome = 'QUEUED' | 'CONSENT' | 'ACCESS' | 'INVALID' | 'CONFLICT' | 'NOT_DRAFT' | 'UNCERTAIN';
type Search = Readonly<{ state: 'IDLE' | 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; items: readonly PersonSummary[] }>;
const CHANNEL: Record<ComposeChannel, string> = { SMS: 'Text', EMAIL: 'Email' };
const BY: Record<ComposeChannel, string> = { SMS: 'texts', EMAIL: 'emails' };
const nameOf = (p: PersonSummary) => `${p.givenName} ${p.familyName}`;
const addressOf = (p: PersonSummary, channel: ComposeChannel) => channel === 'SMS' ? p.phoneE164 : p.email;

/** One-to-one sends fill these from the chosen contact; "Your name" is for group sends, which render on the server. */
const ONE_TO_ONE_TAGS = MERGE_TAGS.filter(tag => tag.key !== 'staff_name');
const SEARCH_WAIT_MS = 300;

/**
 * Texts > Send (and Email > Send, TE4): type a name, pick one contact, write (merge tags filled from that contact, shown in
 * the preview exactly as sent), confirm, Send. Was "New text or email" on Texts & email (L4). Create-then-queue with the
 * existing human commands; the server checks permission and consent. An uncertain step keeps only its own key for an exact
 * retry; any edit starts a new message. Nothing is stored in the browser.
 */
export function ComposeMessage({ scope, channel, schoolName, initialContent = '' }: { scope: ComposeScope; channel: ComposeChannel; schoolName: string | null; initialContent?: string }): React.ReactElement {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<Search>({ state: 'IDLE' });
  const [person, setPerson] = useState<PersonSummary | null>(null);
  const [content, setContent] = useState(initialContent);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [sentTo, setSentTo] = useState('');
  const retained = useRef<Step | null>(null);
  // The exact text the retained step sends: a retry never re-fills merge tags, so the same key always carries the same text.
  const retainedText = useRef('');
  const active = useRef(false);
  const mounted = useRef(true);
  const lookup = useRef<AbortController | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const box = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; lookup.current?.abort(); if (searchTimer.current) clearTimeout(searchTimer.current); }; }, []);

  // One-to-one sends fill tags in the browser: a tag we cannot fill here (staff name, or the school name before it loads) is refused, never sent empty.
  const unknownTags = unknownMergeTags(content);
  const unfillable = mergeTagsIn(content, schoolName?.trim() ? ['staff_name'] : ['staff_name', 'school_name']);
  const filled = person ? fillMergeTags(content, { first_name: person.givenName, last_name: person.familyName, school_name: schoolName ?? '', staff_name: '' }) : content;
  const ready = Boolean(person && addressOf(person, channel) && unknownTags.length === 0 && unfillable.length === 0 && composeOk(person.personId, channel, filled));
  function edit(change: () => void): void {
    if (active.current) return;
    // While a send is uncertain the first message may already be queued: nothing changes until Retry or an explicit Discard.
    if (retained.current) return;
    setConfirmed(false); setOutcome(null); change();
  }
  function find(event?: FormEvent, text = query): void {
    event?.preventDefault();
    if (searchTimer.current) { clearTimeout(searchTimer.current); searchTimer.current = null; }
    if (active.current || retained.current) return;
    lookup.current?.abort(); const controller = new AbortController(); lookup.current = controller;
    setSearch({ state: 'LOADING' });
    peopleApi.search(scope, text, controller.signal)
      .then(items => { if (mounted.current && !controller.signal.aborted) setSearch({ state: 'READY', items }); })
      .catch(error => { if (mounted.current && !controller.signal.aborted) setSearch({ state: error instanceof PersonRecordError && (error.kind === 'DENIED' || error.kind === 'SESSION') ? 'DENIED' : 'UNAVAILABLE' }); });
  }
  /** Type-ahead: searching waits until typing pauses; Enter searches at once. */
  function type(value: string): void {
    setQuery(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (value.trim().length >= 2) searchTimer.current = setTimeout(() => find(undefined, value), SEARCH_WAIT_MS);
  }
  function pick(next: PersonSummary): void {
    edit(() => {
      if (searchTimer.current) { clearTimeout(searchTimer.current); searchTimer.current = null; }
      lookup.current?.abort(); setPerson(next); setSearch({ state: 'IDLE' });
    });
  }
  function insertTag(tag: string): void {
    if (!tag) return;
    edit(() => { const at = box.current?.selectionStart ?? content.length; setContent(insertAt(content, at, tag).text); });
  }
  async function run(start: Step, to: PersonSummary, via: ComposeChannel, text: string): Promise<void> {
    active.current = true; setBusy(true); setOutcome(null);
    let step: Step = start;
    try {
      retained.current = step; retainedText.current = text;
      if (step.kind === 'create') {
        const draft = await createDraft(scope, to.personId, via, text, step.key);
        step = { kind: 'queue', draft, key: crypto.randomUUID() }; retained.current = step;
      }
      await queueDraft(scope, step.draft, step.key);
      retained.current = null;
      if (mounted.current) { setOutcome('QUEUED'); setSentTo(`${nameOf(to)} by ${CHANNEL[via].toLowerCase()}`); setContent(''); setConfirmed(false); }
    } catch (caught) {
      if (!mounted.current) return;
      // A refusal is definite (nothing more happened); anything else, including ComposeUncertain, keeps the step for an exact retry.
      if (caught instanceof ComposeRefusal) { retained.current = null; setOutcome(caught.reason); setConfirmed(false); }
      else setOutcome('UNCERTAIN');
    } finally { active.current = false; if (mounted.current) setBusy(false); }
  }
  function send(event: FormEvent): void {
    event.preventDefault();
    if (active.current || !confirmed || !ready || !person || retained.current) return;
    void run({ kind: 'create', key: crypto.randomUUID() }, person, channel, filled);
  }
  function discard(): void {
    if (active.current || outcome !== 'UNCERTAIN') return;
    retained.current = null; setOutcome(null); setConfirmed(false); setContent('');
  }
  function retry(): void {
    const step = retained.current;
    if (active.current || !step || outcome !== 'UNCERTAIN' || !person) return;
    void run(step, person, channel, retainedText.current);
  }

  const who = person ? nameOf(person) : '';
  const address = person ? addressOf(person, channel) : null;
  const parts = channel === 'SMS' ? smsSegments(filled).segments : 0;
  const locked = busy || outcome === 'UNCERTAIN';
  return <div className={s.sendGrid} data-compose="">
    <section className={`${s.panel} ${s.stack}`} aria-labelledby="compose-title">
      <h2 id="compose-title">{channel === 'SMS' ? 'Send a text' : 'Send an email'}</h2>
      {!person && <form onSubmit={find} role="search" aria-label="Find a contact" className={s.stack}>
        <label className={s.label}>To<input className={s.field} name="composeQuery" value={query} maxLength={120} autoComplete="off" placeholder="Type a name, phone or email"
          disabled={locked} onChange={event => type(event.target.value)} /></label>
        <button type="submit" hidden disabled={locked}>Find</button>
      </form>}
      {search.state === 'LOADING' && <p className={s.muted} role="status">Finding contacts…</p>}
      {search.state === 'DENIED' && <p className={s.flash} data-tone="bad" role="alert">Your access does not include contacts at this school.</p>}
      {search.state === 'UNAVAILABLE' && <p className={s.flash} data-tone="bad" role="alert">Contacts could not be loaded. Try again.</p>}
      {search.state === 'READY' && search.items.length === 0 && <p className={s.muted}>No contact matches.</p>}
      {search.state === 'READY' && search.items.length > 0 && <ul className={s.matches} aria-label="Matching contacts">{search.items.map(item =>
        <li key={item.personId}><button type="button" className={s.row} disabled={locked} aria-pressed={person?.personId === item.personId} data-person={item.personId} onClick={() => pick(item)}>
          <span className={s.avatar} aria-hidden="true">{initials(nameOf(item))}</span>
          <span className={s.rowMain}><span className={s.rowName}>{nameOf(item)}</span>
            <span className={s.rowSub}>{addressOf(item, channel) ?? (channel === 'SMS' ? 'No mobile number' : 'No email')}</span></span>
        </button></li>)}</ul>}
      {person && <form onSubmit={send} aria-label={`Message to ${who}`}><fieldset disabled={locked} className={s.stack} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
        <div className={s.picked}><span className={s.avatar} aria-hidden="true">{initials(who)}</span>
          <span className={s.rowMain}><strong>To: {who}</strong><span className={s.rowSub}>{address ?? (channel === 'SMS' ? 'No mobile number: this contact cannot get texts' : 'No email address')}</span></span>
          <button type="button" className={s.ghost} onClick={() => edit(() => { setPerson(null); setQuery(''); })}>Change</button></div>
        <label className={s.label} htmlFor="compose-content">Message</label>
        <textarea id="compose-content" ref={box} className={s.field} name="composeContent" rows={6} maxLength={COMPOSE_MAX} value={content} onChange={event => edit(() => setContent(event.target.value))} />
        <div className={s.composerBar}>
          <span className={s.composerTools}><select aria-label="Insert a merge tag" value="" onChange={event => insertTag(event.target.value)}>
            <option value="">Insert…</option>{ONE_TO_ONE_TAGS.map(tag => <option key={tag.key} value={tag.tag}>{tag.label}</option>)}</select>
            <span>{filled.length} / {COMPOSE_MAX}{parts > 1 ? ` · ${parts} texts` : ''}</span></span>
        </div>
        {unknownTags.length > 0 && <p className={s.flash} data-tone="bad" role="alert">{`Not a merge tag: ${unknownTags.join(', ')}. Use Insert to add one.`}</p>}
        {unfillable.length > 0 && <p className={s.flash} data-tone="bad" role="alert">{`This tag can't be filled in here: ${unfillable.join(', ')}. Remove it or type the words.`}</p>}
        <label className={s.check}><input type="checkbox" name="confirmCompose" checked={confirmed} disabled={!ready} onChange={event => { if (!active.current && ready) setConfirmed(event.target.checked); }} />
          {` Send this to ${who} by ${CHANNEL[channel].toLowerCase()}`}</label>
        <p className={s.actions}><button type="submit" className={s.primary} disabled={!ready || !confirmed || busy}>{busy ? 'Sending…' : 'Send'}</button></p>
      </fieldset></form>}
      <div aria-live="polite">
        {outcome === 'QUEUED' && <p className={s.flash} data-tone="ok" role="status">{`Queued to send to ${sentTo}.`}</p>}
        {outcome === 'CONSENT' && <p className={s.flash} data-tone="bad" role="alert">{`${who} has not agreed to receive ${BY[channel]} from the school. Record their consent on `}<a href="/staff/people">their contact card</a> first.</p>}
        {outcome === 'ACCESS' && <p className={s.flash} data-tone="bad" role="alert">Not available for your role: you need permission to send messages at this school.</p>}
        {outcome === 'INVALID' && <p className={s.flash} data-tone="bad" role="alert">That message could not be sent. Check the contact and the message, then try again.</p>}
        {outcome === 'CONFLICT' && <p className={s.flash} data-tone="bad" role="alert">This message changed before it was sent. Write it again.</p>}
        {outcome === 'NOT_DRAFT' && <p className={s.flash} data-tone="bad" role="alert">This message is no longer a draft. It may already have been queued, so check this person's messages before writing it again.</p>}
        {outcome === 'UNCERTAIN' && <div className={s.flash} data-tone="bad" role="alert"><p>Not sure it went through. It may already be on its way, so the message is locked. Retry sends the same message again without a duplicate.</p>
          <p className={s.actions}><button type="button" className={s.button} disabled={busy} onClick={retry}>Retry the same message</button>
            <button type="button" className={s.ghost} disabled={busy} onClick={discard}>Discard and write a new one (the first may already be on its way)</button></p></div>}
      </div>
    </section>
    <aside className={`${s.panel} ${s.stack}`} aria-label="Preview">
      <h2>Preview</h2>
      {channel === 'SMS'
        ? <div className={s.phone}><ol className={s.messages} style={{ padding: 0 }}><li className={s.bubble} data-from="out"><p>{filled || 'Your text shows here as it will arrive.'}</p></li></ol></div>
        : <div className={s.stack}><p className={s.muted}>{`From ${schoolName ?? 'your school'}`}</p><p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{filled || 'Your email shows here as it will arrive.'}</p></div>}
      <p className={s.muted}>{person ? `Merge tags are filled in for ${who}.` : 'Pick a contact to see their name filled in.'} Texts go out from the school number; HON checks consent, STOP and quiet hours again before sending.</p>
    </aside>
  </div>;
}
