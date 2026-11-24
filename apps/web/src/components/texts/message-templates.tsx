'use client';
import React, { useEffect, useRef, useState } from 'react';
import {
  SCHOOL_TEMPLATE_LIMITS, schoolTemplateBodyMax, schoolTemplateBodyOk, schoolTemplateLineOk, schoolTemplateUnknownTags,
  type SaveSchoolTemplateInput, type SchoolTemplate, type SchoolTemplateChannel, type SchoolTemplateStatus,
} from '@hon/contracts';
import { MessagesAccessError, MessagesRefusal, loadTemplates, saveTemplate, setTemplateStatus, type MessagesScope } from './messages-http';
import { onShellPrivacyEvent } from '../school-shell/privacy';
import { MERGE_TAGS, insertAt } from '../comms-kit/merge-tags';
import { smsSegments } from '../comms-kit/sms-segments';
import type { WhenFormat } from './message-history';
import s from '../comms-kit/comms.module.css';

type Load = 'LOADING' | 'READY' | 'DENIED' | 'SESSION' | 'UNAVAILABLE';
export type Draft = Readonly<{ templateId: string | null; version: number; name: string; subject: string; body: string }>;
const EMPTY: Draft = { templateId: null, version: 0, name: '', subject: '', body: '' };
const size = (text: string) => [...text].length;

/** The save command for a draft, or null while it is not ready (blank, too long, a stray tag, edges with spaces). */
export function saveInput(channel: SchoolTemplateChannel, draft: Draft): SaveSchoolTemplateInput | null {
  const input: SaveSchoolTemplateInput = { templateId: draft.templateId, expectedVersion: draft.version, channel, name: draft.name.trim(),
    subject: channel === 'EMAIL' ? draft.subject.trim() : null, body: draft.body };
  if (!schoolTemplateLineOk(input.name, SCHOOL_TEMPLATE_LIMITS.name) || !schoolTemplateBodyOk(input.body, channel)) return null;
  if (channel === 'EMAIL' && !schoolTemplateLineOk(input.subject, SCHOOL_TEMPLATE_LIMITS.subject)) return null;
  return input;
}
/** A plain message for each definite refusal; the editor stays open with what was typed. */
export function refusalText(code: string): string {
  switch (code) {
    case 'MESSAGE_TEMPLATE_NAME_TAKEN': return 'Another template already has that name. Pick a different name.';
    case 'MESSAGE_TEMPLATE_LIMIT': return 'This school has reached its template limit. Archive one you no longer use, then save again.';
    case 'VERSION_CONFLICT': return 'Someone changed this template while you were editing. Close it, reopen it and make your change again.';
    case 'MESSAGE_TEMPLATE_ARCHIVED': return 'This template was archived. Restore it before changing it.';
    case 'MESSAGE_TEMPLATE_NOT_FOUND': return 'This template no longer exists at this school.';
    case 'MESSAGE_TEMPLATE_STATUS_UNCHANGED': return 'The template is already in that state. Reload the list.';
    default: return 'That template could not be saved. Check the name and the message, then try again.';
  }
}

/**
 * Templates tab (TE2 0586): saved texts or emails staff pick to fill Send. Reading needs communication.template.read; adding,
 * changing, archiving and restoring need communication.template.manage, checked by the server. A template is text only.
 * An uncertain save keeps its key so Retry cannot make a second copy; any edit after that starts a new command.
 */
export function MessageTemplates({ scope, channel, when, useHref }: { scope: MessagesScope; channel: SchoolTemplateChannel; when: WhenFormat; useHref: (templateId: string) => string }): React.ReactElement {
  const [status, setStatus] = useState<SchoolTemplateStatus>('ACTIVE');
  const [items, setItems] = useState<readonly SchoolTemplate[]>([]);
  const [load, setLoad] = useState<Load>('LOADING');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const pending = useRef<{ fingerprint: string; key: string } | null>(null);
  const box = useRef<HTMLTextAreaElement | null>(null);
  const noun = channel === 'SMS' ? 'text' : 'email';

  async function fetchList(next: SchoolTemplateStatus): Promise<void> {
    const token = ++generation.current;
    setLoad('LOADING');
    try {
      const list = await loadTemplates(scope, { channel, status: next });
      if (generation.current !== token) return;
      setItems(list.templates); setLoad('READY');
    } catch (error) {
      if (generation.current !== token) return;
      setItems([]); setLoad(error instanceof MessagesAccessError ? (error.reason === 'SESSION' ? 'SESSION' : 'DENIED') : 'UNAVAILABLE');
    }
  }
  useEffect(() => {
    void fetchList('ACTIVE');
    const off = typeof window === 'undefined' ? () => {} : onShellPrivacyEvent(() => { ++generation.current; setItems([]); setDraft(null); pending.current = null; setUncertain(false); setLoad('LOADING'); });
    return () => { off(); ++generation.current; };
  }, []);

  function show(next: SchoolTemplateStatus): void { if (busy || uncertain) return; setStatus(next); setDraft(null); setProblem(''); setNotice(''); void fetchList(next); }
  function edit(change: Partial<Draft>): void {
    if (!draft || busy || uncertain) return;
    setDraft({ ...draft, ...change }); setProblem('');
  }
  function insertTag(tag: string): void {
    if (!tag || !draft) return;
    const at = box.current?.selectionStart ?? draft.body.length;
    edit({ body: insertAt(draft.body, at, tag).text });
  }
  function startNew(): void { if (busy || uncertain) return; pending.current = null; setDraft(EMPTY); setProblem(''); setNotice(''); }
  function startEdit(t: SchoolTemplate): void {
    if (busy || uncertain) return;
    pending.current = null; setDraft({ templateId: t.templateId, version: t.version, name: t.name, subject: t.subject ?? '', body: t.body }); setProblem(''); setNotice('');
  }
  function close(): void { if (busy || uncertain) return; pending.current = null; setDraft(null); setProblem(''); }
  function keyFor(fingerprint: string): string {
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, key: crypto.randomUUID() };
    return pending.current.key;
  }
  function failed(error: unknown): void {
    if (error instanceof MessagesRefusal) { pending.current = null; setUncertain(false); setProblem(refusalText(error.code)); return; }
    if (error instanceof MessagesAccessError) {
      pending.current = null; setUncertain(false);
      setProblem(error.reason === 'SESSION' ? 'Your session ended. Sign in again, then save.' : 'Not available for your role: you need permission to manage templates at this school.');
      return;
    }
    setUncertain(true); setProblem('Not sure it was saved. Retry saves the same change without making a copy.');
  }
  async function save(event?: React.FormEvent): Promise<void> {
    event?.preventDefault();
    if (!draft || busy) return;
    const input = saveInput(channel, draft);
    if (!input) return;
    setBusy(true); setProblem('');
    try {
      const { template } = await saveTemplate(scope, input, keyFor(JSON.stringify(['save', input])));
      pending.current = null; setUncertain(false); setDraft(null);
      setNotice(`Saved “${template.name}”.`);
      setItems(status === 'ACTIVE' ? [...items.filter(t => t.templateId !== template.templateId), template].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())) : items);
    } catch (error) { failed(error); } finally { setBusy(false); }
  }
  async function move(t: SchoolTemplate, next: SchoolTemplateStatus): Promise<void> {
    if (busy || uncertain || draft) return;
    setBusy(true); setProblem(''); setNotice('');
    try {
      await setTemplateStatus(scope, t.templateId, t.version, next, keyFor(JSON.stringify(['status', t.templateId, t.version, next])));
      pending.current = null;
      setItems(items.filter(i => i.templateId !== t.templateId));
      setNotice(next === 'ARCHIVED' ? `Archived “${t.name}”. Find it under Archived to restore it.` : `Restored “${t.name}”.`);
    } catch (error) {
      if (error instanceof MessagesRefusal || error instanceof MessagesAccessError) { pending.current = null; setProblem(error instanceof MessagesRefusal ? refusalText(error.code) : 'Not available for your role: you need permission to manage templates at this school.'); }
      else setProblem('Not sure that went through. Reload the list to check before trying again.');
    } finally { setBusy(false); }
  }
  function discardUncertain(): void { if (busy) return; pending.current = null; setUncertain(false); setProblem(''); setDraft(null); void fetchList(status); }

  const ready = draft ? saveInput(channel, draft) !== null : false;
  const unknownTags = draft ? schoolTemplateUnknownTags(`${draft.name}\n${channel === 'EMAIL' ? draft.subject : ''}\n${draft.body}`) : [];
  const max = schoolTemplateBodyMax(channel);
  const parts = draft && channel === 'SMS' ? smsSegments(draft.body).segments : 0;

  return <div className={s.stack} data-message-templates={channel}>
    <div className={s.composerBar}>
      <ul className={s.chips} aria-label="Show">
        <li><button type="button" className={s.chip} aria-pressed={status === 'ACTIVE'} onClick={() => show('ACTIVE')}>Active</button></li>
        <li><button type="button" className={s.chip} aria-pressed={status === 'ARCHIVED'} onClick={() => show('ARCHIVED')}>Archived</button></li>
      </ul>
      {status === 'ACTIVE' && !draft && <button type="button" className={s.primary} name="newTemplate" disabled={busy || uncertain} onClick={startNew}>{`New ${noun} template`}</button>}
    </div>
    <div aria-live="polite">{notice && <p className={s.flash} data-tone="ok" role="status">{notice}</p>}
      {problem && !draft && <p className={s.flash} data-tone="bad" role="alert">{problem}</p>}</div>

    {draft && <form className={`${s.panel} ${s.stack}`} aria-label={draft.templateId ? `Edit ${draft.name || 'template'}` : `New ${noun} template`} onSubmit={event => void save(event)} data-template-editor="">
      <h2>{draft.templateId ? 'Edit template' : `New ${noun} template`}</h2>
      <fieldset disabled={busy || uncertain} className={s.stack} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
        <label className={s.label}>Name<input className={s.field} name="templateName" value={draft.name} maxLength={SCHOOL_TEMPLATE_LIMITS.name} autoComplete="off"
          placeholder="For example: Class cancelled" onChange={event => edit({ name: event.target.value })} /></label>
        {channel === 'EMAIL' && <label className={s.label}>Subject<input className={s.field} name="templateSubject" value={draft.subject} maxLength={SCHOOL_TEMPLATE_LIMITS.subject} autoComplete="off"
          onChange={event => edit({ subject: event.target.value })} /></label>}
        <label className={s.label} htmlFor="template-body">Message</label>
        <textarea id="template-body" ref={box} className={s.field} name="templateBody" rows={6} value={draft.body} onChange={event => edit({ body: event.target.value })} />
        <div className={s.composerBar}>
          <span className={s.composerTools}><select aria-label="Insert a merge tag" value="" onChange={event => insertTag(event.target.value)}>
            <option value="">Insert…</option>{MERGE_TAGS.map(tag => <option key={tag.key} value={tag.tag}>{tag.label}</option>)}</select>
            <span data-count="">{size(draft.body)} / {max}{parts > 1 ? ` · ${parts} texts` : ''}</span></span>
        </div>
        {unknownTags.length > 0 && <p className={s.flash} data-tone="bad" role="alert">{`Not a merge tag: ${unknownTags.join(', ')}. Use Insert to add one.`}</p>}
        {size(draft.body) > max && <p className={s.flash} data-tone="bad" role="alert">{`The message is over ${max} characters.`}</p>}
        <p className={s.muted}>Merge tags fill in when you send. “Your name” only fills in for group sends, so a text to one person asks you to replace it.</p>
      </fieldset>
      {problem && <div className={s.flash} data-tone="bad" role="alert"><p>{problem}</p>
        {uncertain && <p className={s.actions}><button type="button" className={s.button} disabled={busy} onClick={() => void save()}>Retry the same save</button>
          <button type="button" className={s.ghost} disabled={busy} onClick={discardUncertain}>Discard and reload</button></p>}</div>}
      <p className={s.actions}><button type="submit" className={s.primary} name="saveTemplate" disabled={!ready || busy || uncertain}>{busy ? 'Saving…' : 'Save template'}</button>
        <button type="button" className={s.ghost} disabled={busy || uncertain} onClick={close}>Cancel</button></p>
    </form>}

    {load === 'LOADING' && <p className={s.muted} role="status">Loading templates…</p>}
    {load === 'DENIED' && <p className={s.flash} data-tone="bad" role="alert">Your access does not include templates at this school.</p>}
    {load === 'SESSION' && <p className={s.flash} data-tone="bad" role="alert">Your session ended. Sign in again to see templates.</p>}
    {load === 'UNAVAILABLE' && <div className={s.flash} data-tone="bad" role="alert"><p>Templates could not be loaded.</p>
      <p className={s.actions}><button type="button" className={s.button} onClick={() => void fetchList(status)}>Try again</button></p></div>}
    {load === 'READY' && items.length === 0 && !draft && <div className={`${s.panel} ${s.empty}`}><strong>{status === 'ACTIVE' ? `No ${noun} templates yet` : 'Nothing archived'}</strong>
      <span>{status === 'ACTIVE' ? `Save the ${noun}s you send often, then pick one in Send.` : 'Archived templates show here so you can restore them.'}</span></div>}
    {load === 'READY' && items.length > 0 && <ul className={s.cards} aria-label={status === 'ACTIVE' ? 'Templates' : 'Archived templates'}>{items.map(t =>
      <li key={t.templateId} className={`${s.panel} ${s.card}`} data-template={t.templateId}>
        <h3>{t.name}</h3>
        {t.subject && <p className={s.rowSub} style={{ whiteSpace: 'normal' }}><strong>Subject:</strong> {t.subject}</p>}
        <p className={s.cardBody}>{t.body}</p>
        <p className={s.rowSub}><time dateTime={t.updatedAt} title={when.full(t.updatedAt)}>{`Updated ${when.short(t.updatedAt)}`}</time></p>
        <p className={status === 'ACTIVE' ? s.cardActions : s.actions}>{status === 'ACTIVE'
          ? <><a className={s.primary} href={useHref(t.templateId)}>Use in Send</a>
            <button type="button" className={s.button} disabled={busy || uncertain || Boolean(draft)} onClick={() => startEdit(t)}>Edit</button>
            <button type="button" className={s.ghost} disabled={busy || uncertain || Boolean(draft)} onClick={() => void move(t, 'ARCHIVED')}>Archive</button></>
          : <button type="button" className={s.button} disabled={busy || uncertain || Boolean(draft)} onClick={() => void move(t, 'ACTIVE')}>Restore</button>}</p>
      </li>)}</ul>}
  </div>;
}
