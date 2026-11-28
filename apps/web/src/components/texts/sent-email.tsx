'use client';
import React, { useEffect, useState } from 'react';
import { SCHOOL_MESSAGES_LIMITS, type ContactDeliveryState, type ContactEmailView } from '@hon/contracts';
import type { MessagesScope } from './messages-http';
import type { WhenFormat } from './message-history';
import { onShellPrivacyEvent } from '../school-shell/privacy';
import { loadContactEmail } from '../contact-history/http';
import { BodyText, type PicturesRead } from '../school-blasts/view';
import { blastCopy } from '../school-blasts/copy';
import { pictureIdsOf, videoIdsOf } from '../school-blasts/format';
import { mediaApi } from '../school-media/http';
import s from '../comms-kit/comms.module.css';

type FullEmail = { state: 'LOADING' } | { state: 'UNAVAILABLE' } | { state: 'READY'; email: ContactEmailView; pictures: PicturesRead };
const DELIVERY_LABEL: Record<ContactDeliveryState, string> = {
  QUEUED: 'Waiting to send', PENDING: 'Waiting to send', SENDING: 'Sending', ACCEPTED: 'Handed to the email service', DELIVERED: 'Delivered',
  BOUNCED: 'Bounced', FAILED: 'Failed', SUPPRESSED: 'Not sent (address blocked)', CANCELLED: 'Cancelled', UNKNOWN: 'Unknown',
};

/**
 * The whole email as stored and sent (the 0424 read the contact card uses): subject, full body with its pictures and videos,
 * delivery status and events. Read only; it needs the contact history access the contact card needs, and falls back to the
 * 160-character preview without it.
 */
export function SentEmail({ scope, personId, messageId, preview, when }: Readonly<{
  scope: MessagesScope; personId: string; messageId: string; preview: string | null; when: WhenFormat;
}>): React.ReactElement {
  const [full, setFull] = useState<FullEmail>({ state: 'LOADING' });
  useEffect(() => {
    let live = true;
    const owned = () => live;
    (async () => {
      try {
        const email = await loadContactEmail(scope, personId, messageId);
        if (!live) return;
        const media = pictureIdsOf(email.message.body).length + videoIdsOf(email.message.body).length > 0;
        setFull({ state: 'READY', email, pictures: media ? { state: 'LOADING' } : null });
        if (!media) return;
        try {
          const library = await mediaApi.library(scope, AbortSignal.timeout(15000), owned);
          if (live) setFull({ state: 'READY', email, pictures: { state: 'READY', assets: library.assets } });
        } catch { if (live) setFull({ state: 'READY', email, pictures: { state: 'UNAVAILABLE' } }); }
      } catch { if (live) setFull({ state: 'UNAVAILABLE' }); }
    })();
    const off = typeof window === 'undefined' ? () => {} : onShellPrivacyEvent(() => { live = false; setFull({ state: 'UNAVAILABLE' }); });
    return () => { live = false; off(); };
  }, [scope.organizationId, scope.schoolId, personId, messageId]);
  if (full.state === 'LOADING') return <p className={s.muted} role="status">Opening the full email…</p>;
  if (full.state === 'UNAVAILABLE') return preview === null
    ? <p className={s.muted} data-full-email-unavailable="">The full email could not be opened (it needs access to contact history).</p>
    : <>
      <p className={s.bubble} data-from="out" style={{ margin: 0, maxWidth: '100%' }}>{preview}</p>
      <p className={s.muted} data-full-email-unavailable="">The full email could not be opened (it needs access to contact history). This shows the first {SCHOOL_MESSAGES_LIMITS.previewMax} characters.</p>
    </>;
  const { email } = full;
  return <section aria-label="Email as sent" data-full-email={messageId} style={{ display: 'grid', gap: 8 }}>
    <h3 style={{ margin: 0 }}>{email.message.subject}</h3>
    <div className={s.bubble} data-from="out" style={{ margin: 0, maxWidth: '100%', whiteSpace: 'pre-wrap', display: 'grid', gap: 6 }}>
      <BodyText body={email.message.body} pictures={full.pictures ?? undefined} c={blastCopy('en')} /></div>
    <dl className={s.facts}>
      <div><dt>Delivery</dt><dd>{DELIVERY_LABEL[email.delivery.status]}{email.delivery.failureCode ? ` (${email.delivery.failureCode})` : ''}</dd></div>
      {email.delivery.events.length > 0 && <div><dt>Events</dt><dd>{email.delivery.events.map(e => `${e.type.toLowerCase()} ${when.short(e.at)}`).join(' · ')}</dd></div>}
      {email.resends.length > 0 && <div><dt>Resent</dt><dd>{email.resends.map(r => when.short(r.at)).join(' · ')}</dd></div>}
    </dl>
  </section>;
}
