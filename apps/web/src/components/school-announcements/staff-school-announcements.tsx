'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SCHOOL_ANNOUNCEMENT_LIMITS, isSchoolAnnouncementBody, isSchoolAnnouncementTitle, type SchoolAnnouncement } from '@hon/contracts';
import { useSchoolShell } from '../school-shell/context';
import { onShellPrivacyEvent } from '../school-shell/privacy';
import {
  AnnouncementsAccessError, AnnouncementsRefusal, attemptFor, loadSchoolAnnouncements, publishSchoolAnnouncement, withdrawSchoolAnnouncement, type AnnouncementsScope,
} from './http';
import s from '../comms-kit/comms.module.css';

function when(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
function failure(error: unknown) { return error instanceof Error ? error.message : 'Announcements are unavailable right now.'; }

/**
 * Parent app > Announcements (David 2026-11-19: "announcement that we can push out from crm"). 0576: staff with
 * family_messages.manage post a short announcement; every family of the school sees it on the HON Family app's Home screen for
 * 60 days. A post never changes; it can be taken down once. Nothing is texted, emailed or pushed to phones.
 */
export function StaffSchoolAnnouncements(): React.ReactElement {
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const scope: AnnouncementsScope | null = selection ? { organizationId: selection.organizationId, schoolId: selection.schoolId } : null;
  const scopeKey = scope ? `${scope.organizationId}/${scope.schoolId}` : '';
  const [items, setItems] = useState<SchoolAnnouncement[] | null>(null), [title, setTitle] = useState(''), [body, setBody] = useState('');
  const [confirming, setConfirming] = useState<'publish' | string | null>(null);
  const [busy, setBusy] = useState(false), [acting, setActing] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [denied, setDenied] = useState(false);
  const [hidden, setHidden] = useState(false);
  const generation = useRef(0), attempt = useRef<{ identity: string; key: string } | null>(null);

  const clear = useCallback(() => { ++generation.current; setItems(null); setConfirming(null); attempt.current = null; }, []);
  const refresh = useCallback(async () => {
    const [organizationId, schoolId] = scopeKey.split('/');
    if (!organizationId || !schoolId) return;
    const token = ++generation.current;
    setBusy(true); setDenied(false);
    try {
      const list = await loadSchoolAnnouncements({ organizationId, schoolId });
      if (generation.current !== token) return;
      setItems(list.announcements); setError(''); setHidden(false);
    } catch (problem) {
      if (generation.current !== token) return;
      setItems(null); setError(failure(problem)); setDenied(problem instanceof AnnouncementsAccessError);
    } finally { if (generation.current === token) setBusy(false); }
  }, [scopeKey]);
  useEffect(() => { clear(); void refresh(); }, [scopeKey, clear, refresh]);
  useEffect(() => onShellPrivacyEvent(() => { clear(); setTitle(''); setBody(''); setError(''); setNotice(''); setHidden(true); }), [clear]);

  async function command(identity: string, run: (key: string) => Promise<unknown>, done: string): Promise<boolean> {
    attempt.current = attemptFor(identity, attempt.current, () => crypto.randomUUID());
    const key = attempt.current.key;
    setActing(true); setError(''); setNotice('');
    try { await run(key); attempt.current = null; setConfirming(null); setNotice(done); await refresh(); return true; }
    catch (problem) {
      setError(failure(problem));
      if (problem instanceof AnnouncementsRefusal) { attempt.current = null; setConfirming(null); }
      if (problem instanceof AnnouncementsAccessError) { clear(); setDenied(true); }
      return false;
    } finally { setActing(false); }
  }
  const ready = isSchoolAnnouncementTitle(title) && isSchoolAnnouncementBody(body);
  async function publish() {
    if (!scope || !ready || acting) return;
    if (await command(`publish:${title}\n${body}`, key => publishSchoolAnnouncement(scope, title, body, key), 'Posted. Families see it on the HON Family app Home screen.')) { setTitle(''); setBody(''); }
  }
  async function withdraw(item: SchoolAnnouncement) {
    if (!scope || acting) return;
    await command(`withdraw:${item.announcementId}:${item.version}`, key => withdrawSchoolAnnouncement(scope, item.announcementId, item.version, key), 'Taken down. Families no longer see it.');
  }

  if (!scope) return <p role="status">Choose a school to see announcements.</p>;
  return <main className={s.page} data-school-announcements="">
    <header className={s.head}><div><h1>Announcements</h1>
      <p>Post a short note to every family at {shell.schoolName ?? 'your school'}. It shows on the Home screen of the HON Family app for 60 days. It is not texted, emailed or sent as a phone alert.</p></div>
      {items && <button type="button" className={s.ghost} disabled={busy} onClick={() => void refresh()}>Refresh</button>}</header>
    {hidden && !items && <p className={s.actions}><button type="button" className={s.button} onClick={() => void refresh()}>Show announcements</button></p>}
    <div aria-live="polite">{busy && !items && <p className={s.muted} role="status">Loading announcements…</p>}
      {error && <div className={s.flash} data-tone="bad" role="alert"><strong>{denied ? 'Not available for your role' : 'Announcements'}</strong><p>{denied ? 'You need the family messages permission at this school.' : error}</p></div>}
      {notice && <p className={s.flash} data-tone="ok" role="status">{notice}</p>}</div>
    {items && <>
      <section className={s.panel} aria-label="New announcement">
        <h2>New announcement</h2>
        <label className={s.label} htmlFor="announcement-title">Title
          <input id="announcement-title" className={s.field} value={title} maxLength={SCHOOL_ANNOUNCEMENT_LIMITS.title + 1} disabled={acting}
            onChange={e => { setTitle(e.target.value.replace(/[\r\n]+/g, ' ')); setConfirming(null); }} placeholder="Closed Monday for the holiday" /></label>
        <label className={s.label} htmlFor="announcement-body">Message
          <textarea id="announcement-body" className={s.field} rows={4} value={body} maxLength={SCHOOL_ANNOUNCEMENT_LIMITS.body + 1} disabled={acting}
            onChange={e => { setBody(e.target.value); setConfirming(null); }} /></label>
        <div className={s.actions}>
          <span className={s.muted}>{title.length} / {SCHOOL_ANNOUNCEMENT_LIMITS.title} · {body.length} / {SCHOOL_ANNOUNCEMENT_LIMITS.body}</span>
          {confirming === 'publish'
            ? <><span className={s.muted}>Every family at this school will see this. A post cannot be edited, only taken down.</span>
              <button type="button" className={s.primary} disabled={acting || !ready} onClick={() => void publish()}>{acting ? 'Posting…' : 'Post to all families'}</button>
              <button type="button" className={s.ghost} disabled={acting} onClick={() => setConfirming(null)}>Cancel</button></>
            : <button type="button" className={s.primary} disabled={acting || !ready} onClick={() => setConfirming('publish')}>Post…</button>}
        </div>
      </section>
      <section className={s.panel} aria-label="Posted announcements">
        <h2>Posted</h2>
        {items.length === 0 ? <p className={s.empty}>Nothing posted yet.</p> : <ul className={s.rows}>
          {items.map(item => <li key={item.announcementId} data-announcement={item.status}>
            <div className={s.actions}><strong>{item.title}</strong>
              {item.status === 'PUBLISHED' ? <span className={s.badge} data-tone="ok">Live</span> : <span className={s.badge}>Taken down</span>}
              <span className={s.muted}>Posted {when(item.publishedAt)}{item.withdrawnAt ? ` · taken down ${when(item.withdrawnAt)}` : ''}</span></div>
            <p style={{ whiteSpace: 'pre-wrap' }}>{item.body}</p>
            {item.status === 'PUBLISHED' && <div className={s.actions}>{confirming === item.announcementId
              ? <><span className={s.muted}>Families will no longer see it. This cannot be undone.</span>
                <button type="button" className={s.button} disabled={acting} onClick={() => void withdraw(item)}>{acting ? 'Taking down…' : 'Take it down'}</button>
                <button type="button" className={s.ghost} disabled={acting} onClick={() => setConfirming(null)}>Cancel</button></>
              : <button type="button" className={s.ghost} disabled={acting} onClick={() => setConfirming(item.announcementId)}>Take down…</button>}</div>}
          </li>)}
        </ul>}
      </section>
    </>}
  </main>;
}
