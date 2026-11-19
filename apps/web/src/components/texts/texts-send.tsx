'use client';
import React from 'react';
import { useSchoolShell } from '../school-shell/context';
import { ComposeMessage } from '../family-messages/compose';
import s from '../comms-kit/comms.module.css';

/** Texts > Send (docs/architecture/SCHOOL_TEXTS_AND_EMAIL_PAGES.md): one person now; groups join here after blasts (TE5). */
export function TextsSend(): React.ReactElement {
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  if (!selection) return <p role="status">Choose a school to send a text.</p>;
  return <main className={s.page} data-texts-send="">
    <header className={s.head}><div><h1>Send a text</h1><p>Text one contact from the school number. Merge tags fill in from the contact you pick.</p></div></header>
    <ComposeMessage key={`${selection.organizationId}/${selection.schoolId}`} scope={{ organizationId: selection.organizationId, schoolId: selection.schoolId }} channel="SMS" schoolName={shell.schoolName} />
  </main>;
}
