'use client';
import React from 'react';
import { useSchoolShell } from '../school-shell/context';
import { useLocale } from '../localization/provider';
import { shortWhen } from '../comms-kit/short-when';
import { MessageHistory, type WhenFormat } from './message-history';
import { MessageTemplates } from './message-templates';
import { OptedOutList } from './opted-out';
import s from '../comms-kit/comms.module.css';

/** The shell's school and the viewer's time format, shared by the Texts tabs (and the Email tabs in TE4). */
export function useTabScope(): { scope: { organizationId: string; schoolId: string } | null; key: string; when: WhenFormat } {
  const shell = useSchoolShell();
  const { preferences, date, formattingLocale } = useLocale();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  return { scope: selection ? { organizationId: selection.organizationId, schoolId: selection.schoolId } : null,
    key: selection ? `${selection.organizationId}/${selection.schoolId}` : '',
    when: { short: iso => shortWhen(iso, { locale: formattingLocale, timeZone: preferences.timeZone }), full: date } };
}
function Page({ title, lead, data, email = false, children }: { title: string; lead: string; data: string; email?: boolean; children: React.ReactNode }): React.ReactElement {
  return <main className={s.page} {...{ [email ? 'data-email-tab' : 'data-texts-tab']: data }}><header className={s.head}><div><h1>{title}</h1><p>{lead}</p></div></header>{children}</main>;
}

export function TextsHistory(): React.ReactElement {
  const { scope, key, when } = useTabScope();
  if (!scope) return <p role="status">Choose a school to see its texts.</p>;
  return <Page title="Text history" lead="Every text the school sent, newest first: staff texts, conversation replies, campaigns and automations." data="history">
    <MessageHistory key={key} scope={scope} channel="SMS" when={when} /></Page>;
}
export function TextsTemplates(): React.ReactElement {
  const { scope, key, when } = useTabScope();
  if (!scope) return <p role="status">Choose a school to see its templates.</p>;
  return <Page title="Text templates" lead="Save the texts you send often. Pick one in Send and it fills the message for you." data="templates">
    <MessageTemplates key={key} scope={scope} channel="SMS" when={when} useHref={id => `/staff/texts/send?template=${encodeURIComponent(id)}`} /></Page>;
}
export function TextsOptedOut(): React.ReactElement {
  const { scope, key, when } = useTabScope();
  if (!scope) return <p role="status">Choose a school to see who opted out.</p>;
  return <Page title="Opted out of texts" lead="Contacts who replied STOP or asked not to get texts. HON never texts them." data="opted-out">
    <OptedOutList key={key} scope={scope} channel="SMS" when={when} /></Page>;
}

/** Email (TE4): the same History, Templates and Opted out tabs as Texts, for the school's emails. */
export function EmailHistory(): React.ReactElement {
  const { scope, key, when } = useTabScope();
  if (!scope) return <p role="status">Choose a school to see its emails.</p>;
  return <Page title="Email history" lead="Every email the school sent, newest first: staff emails, conversation replies, campaigns and automations." data="history" email>
    <MessageHistory key={key} scope={scope} channel="EMAIL" when={when} /></Page>;
}
export function EmailTemplates(): React.ReactElement {
  const { scope, key, when } = useTabScope();
  if (!scope) return <p role="status">Choose a school to see its templates.</p>;
  return <Page title="Email templates" lead="Save the emails you send often, subject and all. Pick one in Send and it fills the email for you." data="templates" email>
    <MessageTemplates key={key} scope={scope} channel="EMAIL" when={when} useHref={id => `/staff/email?template=${encodeURIComponent(id)}`} /></Page>;
}
export function EmailOptedOut(): React.ReactElement {
  const { scope, key, when } = useTabScope();
  if (!scope) return <p role="status">Choose a school to see who opted out.</p>;
  return <Page title="Opted out of email" lead="Contacts who unsubscribed or asked not to get emails. HON never emails them." data="opted-out" email>
    <OptedOutList key={key} scope={scope} channel="EMAIL" when={when} /></Page>;
}
