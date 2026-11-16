'use client';
import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { PersonRecordError, peopleApi, type PersonSummary } from '../people/http';
import { COMPOSE_MAX, ComposeRefusal, composeOk, createDraft, queueDraft, type ComposeChannel, type ComposeDraft, type ComposeScope } from './compose-http';
import s from '../testing-registration.module.css';
import c from './compose.module.css';

type Step = Readonly<{ kind: 'create'; key: string } | { kind: 'queue'; draft: ComposeDraft; key: string }>;
type Outcome = 'QUEUED' | 'CONSENT' | 'ACCESS' | 'INVALID' | 'CONFLICT' | 'UNCERTAIN';
type Search = Readonly<{ state: 'IDLE' | 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; items: readonly PersonSummary[] }>;
const CHANNEL: Record<ComposeChannel, string> = { SMS: 'Text', EMAIL: 'Email' };
const BY: Record<ComposeChannel, string> = { SMS: 'texts', EMAIL: 'emails' };
const nameOf = (p: PersonSummary) => `${p.givenName} ${p.familyName}`;
const addressOf = (p: PersonSummary, channel: ComposeChannel) => channel === 'SMS' ? p.phoneE164 : p.email;

/**
 * "New text or email" on Texts & email (L4): pick one contact, Text or Email, write, confirm, Send. Create-then-queue with the
 * existing human commands; the server checks permission and consent. An uncertain step keeps only its own key for an exact
 * retry; any edit starts a new message. Nothing is stored in the browser.
 */
export function ComposeMessage({ scope }: { scope: ComposeScope }): React.ReactElement {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<Search>({ state: 'IDLE' });
  const [person, setPerson] = useState<PersonSummary | null>(null);
  const [channel, setChannel] = useState<ComposeChannel | ''>('');
  const [content, setContent] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [sentTo, setSentTo] = useState('');
  const retained = useRef<Step | null>(null);
  const active = useRef(false);
  const mounted = useRef(true);
  const lookup = useRef<AbortController | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; lookup.current?.abort(); }; }, []);

  const ready = Boolean(person && channel && addressOf(person, channel) && composeOk(person.personId, channel, content));
  function edit(change: () => void): void {
    if (active.current) return;
    retained.current = null; setConfirmed(false); setOutcome(null); change();
  }
  function find(event: FormEvent): void {
    event.preventDefault();
    if (active.current) return;
    lookup.current?.abort(); const controller = new AbortController(); lookup.current = controller;
    setSearch({ state: 'LOADING' });
    peopleApi.search(scope, query, controller.signal)
      .then(items => { if (mounted.current && !controller.signal.aborted) setSearch({ state: 'READY', items }); })
      .catch(error => { if (mounted.current && !controller.signal.aborted) setSearch({ state: error instanceof PersonRecordError && (error.kind === 'DENIED' || error.kind === 'SESSION') ? 'DENIED' : 'UNAVAILABLE' }); });
  }
  function pick(next: PersonSummary): void {
    edit(() => { setPerson(next); setChannel(current => current && addressOf(next, current) ? current : next.phoneE164 ? 'SMS' : next.email ? 'EMAIL' : ''); });
  }
  async function run(start: Step, to: PersonSummary, via: ComposeChannel, text: string): Promise<void> {
    active.current = true; setBusy(true); setOutcome(null);
    let step: Step = start;
    try {
      retained.current = step;
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
    if (active.current || !confirmed || !ready || !person || !channel || retained.current) return;
    void run({ kind: 'create', key: crypto.randomUUID() }, person, channel, content);
  }
  function retry(): void {
    const step = retained.current;
    if (active.current || !step || outcome !== 'UNCERTAIN' || !person || !channel) return;
    void run(step, person, channel, content);
  }

  const who = person ? nameOf(person) : '';
  return <section className={s.card} aria-labelledby="compose-title" data-compose="">
    <h2 id="compose-title">New text or email</h2>
    <form className={c.form} onSubmit={find} role="search" aria-label="Find a contact">
      <label>Find a contact (name, email or phone)<input name="composeQuery" value={query} maxLength={120} autoComplete="off" disabled={busy} onChange={event => setQuery(event.target.value)} /></label>
      <p className={s.actions}><button type="submit" disabled={busy}>Find</button></p>
    </form>
    {search.state === 'LOADING' && <p role="status">Finding contacts…</p>}
    {search.state === 'DENIED' && <p role="alert">Your access does not include contacts at this school.</p>}
    {search.state === 'UNAVAILABLE' && <p role="alert">Contacts could not be loaded. Try Find again.</p>}
    {search.state === 'READY' && search.items.length === 0 && <p className={s.empty}>No contact matches.</p>}
    {search.state === 'READY' && search.items.length > 0 && <ul className={c.people} aria-label="Matching contacts">{search.items.map(item =>
      <li key={item.personId}><button type="button" disabled={busy} aria-pressed={person?.personId === item.personId} data-person={item.personId} onClick={() => pick(item)}>{nameOf(item)}</button>
        {' '}<span className={s.subtle}>{[item.phoneE164 ?? 'No mobile number', item.email ?? 'No email'].join(' · ')}</span></li>)}</ul>}
    {person && <form className={c.form} onSubmit={send} aria-label={`Message to ${who}`}><fieldset disabled={busy}>
      <p><strong>To: {who}</strong></p>
      <div role="radiogroup" aria-label="Send as" className={c.choices}>
        {(['SMS', 'EMAIL'] as const).map(value => <label key={value}>
          <input type="radio" name="composeChannel" value={value} checked={channel === value} disabled={!addressOf(person, value)} onChange={() => edit(() => setChannel(value))} />
          {` ${CHANNEL[value]}${addressOf(person, value) ? ` (${addressOf(person, value)})` : value === 'SMS' ? ' (no mobile number)' : ' (no email)'}`}</label>)}
      </div>
      <label>Message<textarea name="composeContent" rows={4} maxLength={COMPOSE_MAX} value={content} onChange={event => edit(() => setContent(event.target.value))} /></label>
      <p className={s.subtle}>{content.length} / {COMPOSE_MAX}</p>
      <label className={c.check}><input type="checkbox" name="confirmCompose" checked={confirmed} disabled={!ready} onChange={event => { if (!active.current && ready) setConfirmed(event.target.checked); }} />
        {channel ? ` Send this to ${who} by ${CHANNEL[channel].toLowerCase()}` : ' Choose Text or Email first'}</label>
      <p className={s.actions}><button type="submit" disabled={!ready || !confirmed || busy}>{busy ? 'Sending…' : 'Send'}</button></p>
    </fieldset></form>}
    <div aria-live="polite">
      {outcome === 'QUEUED' && <p className={s.notice} role="status">{`Queued to send to ${sentTo}.`}</p>}
      {outcome === 'CONSENT' && channel && <p role="alert">{`${who} has not agreed to receive ${BY[channel]} from the school. Record their consent on `}<a href="/staff/people">their contact card</a> first.</p>}
      {outcome === 'ACCESS' && <p role="alert">Not available for your role: you need permission to send messages at this school.</p>}
      {outcome === 'INVALID' && <p role="alert">That message could not be sent. Check the contact and the message, then try again.</p>}
      {outcome === 'CONFLICT' && <p role="alert">This message changed before it was sent. Write it again.</p>}
      {outcome === 'UNCERTAIN' && <p role="alert">Not sure it went through. <button type="button" disabled={busy} onClick={retry}>Retry the same message</button></p>}
    </div>
  </section>;
}
