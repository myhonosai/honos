'use client';
import React, { useEffect, useRef, useState } from 'react';
import { PickerError, STAFF_LIMIT, pickerApi, type PickerStaff, type StaffPurpose } from '../school-pickers/http';
import { useShellSchool } from '../school-shell/page-school';
import styles from './staff-directory.module.css';

type List = Readonly<{ state: 'LOADING' } | { state: 'READY'; items: readonly PickerStaff[] } | { state: 'DENIED' } | { state: 'UNAVAILABLE' }>;
/** The 0404 staff list is per screen permission; the first screen this person manages decides whether they see the list. */
const PURPOSES: readonly StaffPurpose[] = ['roles', 'availability', 'qualifications'];
/** Where each staff job lives today; the destination page picks the person by name (0404 pick list), never by typed ID. */
export const STAFF_CARD_LINKS: readonly Readonly<{ href: string; label: string }>[] = [
  { href: '/staff/roles', label: 'Roles & permissions' },
  { href: '/staff/team/availability', label: 'Availability' },
  { href: '/staff/instructor-qualifications', label: 'Qualifications' },
  { href: '/staff/documents', label: 'Documents' },
];

/**
 * Staff (L5, docs/architecture/SCHOOL_APP_TARGET_LAYOUT.md): opens on the people with a role at this school, by name, and a
 * slide-out card per person with the staff jobs. Read only: the server decides who may see the list (0404), and every job's
 * own page checks its own permission again. No IDs are shown or typed here.
 */
export function StaffDirectory(): React.ReactElement | null {
  const scope = useShellSchool();
  const [list, setList] = useState<List>({ state: 'LOADING' });
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<PickerStaff | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!scope) return;
    const controller = new AbortController();
    (async () => {
      let denied = false;
      for (const purpose of PURPOSES) {
        try {
          const items = await pickerApi.staff(scope, purpose, controller.signal);
          if (mounted.current && !controller.signal.aborted) setList({ state: 'READY', items });
          return;
        } catch (error) {
          if (controller.signal.aborted || !mounted.current) return;
          if (error instanceof PickerError && error.kind === 'DENIED') { denied = true; continue; }
          setList({ state: 'UNAVAILABLE' }); return;
        }
      }
      if (denied && mounted.current) setList({ state: 'DENIED' });
    })();
    return () => controller.abort();
  }, [scope?.organizationId, scope?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    // Focus moves into the card, and back to the person's name when the card closes or another person opens.
    document.getElementById('staff-card-close')?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(null); };
    document.addEventListener('keydown', onKey);
    const opener = open.principalId;
    return () => {
      document.removeEventListener('keydown', onKey);
      const name = Array.from(document.querySelectorAll<HTMLElement>('[data-person]')).find(button => button.dataset.person === opener);
      name?.focus();
    };
  }, [open]);

  if (!scope) return null;
  const needle = search.trim().toLowerCase();
  const shown = list.state === 'READY' ? list.items.filter(person => person.displayName.toLowerCase().includes(needle)) : [];
  return <section className={styles.section} aria-labelledby="staff-directory-title" data-staff-directory="">
    <div className={styles.head}>
      <h2 id="staff-directory-title">{list.state === 'READY' ? `Your staff (${list.items.length >= STAFF_LIMIT ? `${STAFF_LIMIT}+` : list.items.length})` : 'Your staff'}</h2>
      {list.state === 'READY' && list.items.length > 0 && <input className={styles.search} name="staffSearch" type="search" aria-label="Find a person" placeholder="Find a person"
        value={search} maxLength={120} onChange={event => setSearch(event.target.value)} />}
    </div>
    {list.state === 'LOADING' && <p role="status">Reading staff…</p>}
    {list.state === 'DENIED' && <p className={styles.note}>Your role does not include the staff list. The tabs above still open each staff page.</p>}
    {list.state === 'UNAVAILABLE' && <p role="alert">Staff could not be loaded. Reload the page to try again.</p>}
    {list.state === 'READY' && list.items.length === 0 && <p className={styles.note}>No one has a role at this school yet. Invite your first staff member below.</p>}
    {list.state === 'READY' && list.items.length > 0 && shown.length === 0 && <p className={styles.note}>No one matches.</p>}
    {shown.length > 0 && <ul className={styles.list} aria-label="Staff">{shown.map(person =>
      <li key={person.principalId}><button type="button" className={styles.person} data-person={person.principalId} aria-expanded={open?.principalId === person.principalId}
        aria-controls={open?.principalId === person.principalId ? 'staff-card' : undefined} onClick={() => setOpen(current => current?.principalId === person.principalId ? null : person)}>{person.displayName}</button></li>)}</ul>}
    {open && <aside id="staff-card" className={styles.card} aria-label={`${open.displayName}, staff card`} data-staff-card="">
      <button type="button" id="staff-card-close" className={styles.close} onClick={() => setOpen(null)}>Close</button>
      <h2>{open.displayName}</h2>
      <p className={styles.note}>{`Open a staff job for ${open.displayName}. Each page lists your staff by name, so pick ${open.displayName} there.`}</p>
      <ul className={styles.links}>{STAFF_CARD_LINKS.map(link => <li key={link.href}><a href={link.href}>{link.label}</a></li>)}</ul>
    </aside>}
  </section>;
}
