import React from 'react';
import type { FaceCheckInNotice } from '@hon/contracts';
import { locationCopy } from './copy';

/**
 * 0392: what HON tells a school about face check-in at its address. Information only: it never turns anything on. Every
 * profile is a draft a lawyer has not reviewed, and the notice says so.
 */
export function FaceCheckInNoticeView({ notice, language, className }: { notice: FaceCheckInNotice; language: string; className?: string | undefined }): React.ReactElement {
  const c = locationCopy(language);
  return <section className={className} aria-label={c.noticeTitle} data-face-notice={notice.status} data-face-profile={notice.profile ?? ''}>
    <h3>{c.noticeTitle}</h3>
    <p>{c.status[notice.status]}</p>
    {notice.status === 'AVAILABLE_WITH_CONSENT' ? <>
      <p>{c.lawsIntro}</p>
      <ul>{notice.laws.map(l => <li key={l}>{l}</li>)}</ul>
      <p>{c.baseline}</p>
      {notice.addOns.length > 0 ? <ul data-face-addons>{notice.addOns.map(a => <li key={a}>{c.addOns[a]}</li>)}</ul> : null}
    </> : null}
    <p><small>{c.draft}</small></p>
  </section>;
}
