'use client';
import React, { useEffect, useRef, useState } from 'react';
import type { SchoolTemplate } from '@hon/contracts';
import { useSchoolShell } from '../school-shell/context';
import { ComposeMessage } from '../family-messages/compose';
import { loadTemplates, type MessagesScope } from './messages-http';
import { SchoolBlasts } from '../school-blasts/school-blasts';
import page from '../membership-changes/membership-changes.module.css';
import s from '../comms-kit/comms.module.css';

type Templates = Readonly<{ state: 'LOADING' | 'NONE' } | { state: 'READY'; items: readonly SchoolTemplate[] }>;

/**
 * "Use a template" for Send: the school's active templates for the channel (communication.template.read). Picking one only
 * fills the message box; nothing is sent until the usual confirm and Send. Without template access the picker is left out.
 */
export function TemplatePicker({ scope, channel, chosen, onChoose, disabled = false }: { scope: MessagesScope; channel: 'SMS' | 'EMAIL'; chosen: string | null;
  onChoose: (template: SchoolTemplate | null) => void; disabled?: boolean }): React.ReactElement | null {
  const [templates, setTemplates] = useState<Templates>({ state: 'LOADING' });
  useEffect(() => {
    let live = true;
    loadTemplates(scope, { channel, status: 'ACTIVE' })
      .then(list => { if (!live) return; setTemplates({ state: 'READY', items: list.templates }); if (chosen) onChoose(list.templates.find(t => t.templateId === chosen) ?? null); })
      .catch(() => { if (live) setTemplates({ state: 'NONE' }); });
    return () => { live = false; };
  }, []);
  if (templates.state !== 'READY' || templates.items.length === 0) return null;
  return <label className={s.label} style={{ maxWidth: 420 }}>Use a template
    <select className={s.field} name="useTemplate" disabled={disabled} value={chosen && templates.items.some(t => t.templateId === chosen) ? chosen : ''}
      onChange={event => { if (!disabled) onChoose(templates.items.find(t => t.templateId === event.target.value) ?? null); }}>
      <option value="">Start from a blank message</option>
      {templates.items.map(t => <option key={t.templateId} value={t.templateId}>{t.name}</option>)}
    </select></label>;
}

const SEND_COPY = {
  SMS: { title: 'Send a text', lead: 'Text a group (a blast) or one contact from the school number. Merge tags fill in for each person.', none: 'Choose a school to send a text.', data: 'data-texts-send',
    blast: 'New blast', one: 'One person', oneLead: 'Text one contact. Merge tags fill in from the contact you pick.' },
  EMAIL: { title: 'Send an email', lead: 'Email a group (a blast) or one contact from the school. Merge tags fill in for each person.', none: 'Choose a school to send an email.', data: 'data-email-send',
    blast: 'New blast', one: 'One person', oneLead: 'Email one contact. Merge tags in the subject and message fill in from the contact you pick.' },
} as const;
type SendMode = 'BLAST' | 'ONE';

/**
 * Texts > Send and Email > Send (docs/architecture/SCHOOL_TEXTS_AND_EMAIL_PAGES.md). TE5: "New blast" (the 0621 blast composer for
 * this channel, with groups, tags, filters and picked people) is the first tab, as in the owner's current CRM; "One person" keeps
 * the single send. A ?template= link opens One person, since templates fill that form.
 */
function ChannelSend({ channel, templateId }: { channel: 'SMS' | 'EMAIL'; templateId: string | null }): React.ReactElement {
  const [mode, setMode] = useState<SendMode>(templateId ? 'ONE' : 'BLAST');
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const [template, setTemplate] = useState<SchoolTemplate | null>(null);
  // While a send is in flight or uncertain, changing the template would remount Compose and lose its retry key: the picker locks.
  const [locked, setLocked] = useState(false);
  const lockedNow = useRef(false);
  const lock = (value: boolean) => { lockedNow.current = value; setLocked(value); };
  // A late template answer (the ?template= prefill) never replaces the message while a send is locked.
  const choose = (next: SchoolTemplate | null) => { if (!lockedNow.current) setTemplate(next); };
  const copy = SEND_COPY[channel];
  if (!selection) return <p role="status">{copy.none}</p>;
  const scope = { organizationId: selection.organizationId, schoolId: selection.schoolId };
  const scopeKey = `${selection.organizationId}/${selection.schoolId}`;
  const tabs = <div className={page.row} role="group" aria-label={copy.title} data-send-modes="">
    {(['BLAST', 'ONE'] as const).map(m => <button key={m} type="button" className={page.tab} aria-pressed={mode === m} disabled={locked && m !== mode}
      onClick={() => setMode(m)} data-send-mode={m}>{m === 'BLAST' ? copy.blast : copy.one}</button>)}
  </div>;
  if (mode === 'BLAST') return <main className={s.page} {...{ [copy.data]: '' }} data-mode="BLAST">
    <header className={s.head}><div><h1>{copy.title}</h1><p>{copy.lead}</p></div></header>
    {tabs}
    <SchoolBlasts key={scopeKey} channel={channel} />
  </main>;
  return <main className={s.page} {...{ [copy.data]: '' }} data-mode="ONE">
    <header className={s.head}><div><h1>{copy.title}</h1><p>{copy.oneLead}</p></div></header>
    {tabs}
    <TemplatePicker key={scopeKey} scope={scope} channel={channel} chosen={template?.templateId ?? templateId} onChoose={choose} disabled={locked} />
    <ComposeMessage key={`${scopeKey}/${template?.templateId ?? ''}`} scope={scope} channel={channel} schoolName={shell.schoolName}
      initialContent={template?.body ?? ''} initialSubject={template?.subject ?? ''} onLockChange={lock} />
  </main>;
}

export function TextsSend({ templateId = null }: { templateId?: string | null }): React.ReactElement { return ChannelSend({ channel: 'SMS', templateId }); }
export function EmailSend({ templateId = null }: { templateId?: string | null }): React.ReactElement { return ChannelSend({ channel: 'EMAIL', templateId }); }
