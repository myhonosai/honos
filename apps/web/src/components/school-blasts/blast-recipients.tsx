'use client';
import React, { useEffect, useState } from 'react';
import { SCHOOL_BLAST_LIMITS, type SchoolBlast, type SchoolBlastRecipients } from '@hon/contracts';
import { onShellPrivacyEvent } from '../school-shell/privacy';
import { SentEmail } from '../texts/sent-email';
import type { WhenFormat } from '../texts/message-history';
import { BlastError, blastApi, type BlastScope } from './http';
import type { BlastCopy } from './copy';
import page from '../membership-changes/membership-changes.module.css';
import styles from './school-blasts.module.css';

export type RecipientsRead = { state: 'CLOSED' } | { state: 'LOADING' } | { state: 'DENIED' } | { state: 'UNAVAILABLE' } | { state: 'READY'; read: SchoolBlastRecipients };

/** Pure list of who a sent blast went to (0716). An email row opens the email exactly as it was sent to that person. */
export function BlastRecipientsView({ c, read, openId, onToggle, onOpen, email }: Readonly<{
  c: BlastCopy; read: RecipientsRead; openId: string | null; onToggle?: () => void; onOpen?: (messageId: string | null) => void;
  email?: (personId: string, messageId: string) => React.ReactNode;
}>): React.ReactElement {
  const shown = read.state !== 'CLOSED';
  return <div data-testid="blast-recipients" data-state={read.state}>
    <div className={page.row}>
      <button type="button" className={page.secondary} aria-expanded={shown} onClick={() => onToggle?.()} data-action="recipients">{shown ? c.hideRecipients : c.viewRecipients}</button>
    </div>
    {read.state === 'LOADING' ? <p className={page.meta} role="status">{c.reading}</p>
      : read.state === 'DENIED' ? <p className={page.warnText} role="alert">{c.recipientsDenied}</p>
      : read.state === 'UNAVAILABLE' ? <p className={page.warnText} role="alert">{c.recipientsUnavailable}</p>
      : read.state === 'READY' ? <>
        <h3>{c.recipientsTitle}</h3>
        {read.read.items.length === 0 ? <p className={page.meta}>{c.recipientsEmpty}</p> : <ul className={styles.stack} style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {read.read.items.map(r => <li key={r.personId} data-recipient={r.personId} data-outcome={r.outcome}>
            <div className={page.row} style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <span><strong>{r.name || c.noName}</strong>{' '}
                <span className={page.meta}>{r.delivery ? c.deliveries[r.delivery] : c.outcomes[r.outcome]}{r.failureCode ? ` (${r.failureCode})` : ''}</span></span>
              {read.read.channel === 'EMAIL' && r.messageId
                ? <button type="button" className={styles.small} aria-expanded={openId === r.messageId} data-open-email={r.messageId}
                  onClick={() => onOpen?.(openId === r.messageId ? null : r.messageId)}>{openId === r.messageId ? c.closeEmail : c.openEmail}</button> : null}
            </div>
            {openId !== null && openId === r.messageId && email ? email(r.personId, r.messageId) : null}
          </li>)}
        </ul>}
        {read.read.items.length >= SCHOOL_BLAST_LIMITS.recipients ? <p className={page.meta}>{c.recipientsCapped}</p> : null}
      </> : null}
  </div>;
}

/**
 * "View recipients" on a sent blast: reads the list only when asked, and opens one email at a time through the contact
 * history read (0424), which keeps its own permission. Cleared on a privacy event.
 */
export function BlastRecipients({ scope, blast, c, when }: Readonly<{ scope: BlastScope; blast: SchoolBlast; c: BlastCopy; when: WhenFormat }>): React.ReactElement {
  const [read, setRead] = useState<RecipientsRead>({ state: 'CLOSED' });
  const [openId, setOpenId] = useState<string | null>(null);
  const loading = read.state === 'LOADING';
  useEffect(() => {
    if (!loading) return;
    let live = true;
    const owned = () => live;
    blastApi.recipients(scope, blast.blastId, AbortSignal.timeout(15000), owned).then(
      (answer) => { if (live) setRead({ state: 'READY', read: answer }); },
      (error) => { if (live) setRead({ state: error instanceof BlastError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { live = false; };
  }, [loading, scope.organizationId, scope.schoolId, blast.blastId]);
  useEffect(() => typeof window === 'undefined' ? undefined : onShellPrivacyEvent(() => { setOpenId(null); setRead({ state: 'CLOSED' }); }), []);
  return <BlastRecipientsView c={c} read={read} openId={openId}
    onToggle={() => { setOpenId(null); setRead(read.state === 'CLOSED' ? { state: 'LOADING' } : { state: 'CLOSED' }); }}
    onOpen={setOpenId}
    email={(personId, messageId) => <SentEmail key={messageId} scope={scope} personId={personId} messageId={messageId} preview={null} when={when}/>}/>;
}
