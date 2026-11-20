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
function Page({ title, lead, data, children }: { title: string; lead: string; data: string; children: React.ReactNode }): React.ReactElement {
  return <main className={s.page} data-texts-tab={data}><header className={s.head}><div><h1>{title}</h1><p>{lead}</p></div></header>{children}</main>;
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
