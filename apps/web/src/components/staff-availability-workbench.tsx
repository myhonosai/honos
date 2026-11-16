'use client';
import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { validateStaffRevision, type StaffAvailabilityProfile, type StaffRevision, type StaffRevisionInput, type StaffRevisionKind, type StaffQualification, type WeeklyStaffWindow } from '@hon/contracts';
import { StaffAvailabilityUiError, staffAvailabilityPath, staffAvailabilityRequest } from './staff-availability-http';
import { useShellSchool } from './school-shell/page-school';
import { IdFields, StaffPicker, type ListState } from './school-pickers/pickers';
import styles from './staff-availability-workbench.module.css';
const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
type Draft = { effectiveFrom: string; endsOn: string; windows: WeeklyStaffWindow[]; qualifications: StaffQualification[] };
const empty: Draft = { effectiveFrom: '', endsOn: '', windows: [], qualifications: [] };
function schoolDate(timezone: string): string { const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()); const part = (k: string) => parts.find(p => p.type === k)?.value ?? ''; return `${part('year')}-${part('month')}-${part('day')}`; }
function draft(r: StaffRevision | null, timezone: string): Draft { return { effectiveFrom: r?.effectiveFrom ?? schoolDate(timezone), endsOn: r?.endsOn ?? '', windows: r?.windows ?? [], qualifications: r?.qualifications ?? [] }; }
export function StaffAvailabilityWorkbench(): React.ReactElement {
  const [knownId, setKnownId] = useState(''), [target, setTarget] = useState('self');
  const [profile, setProfile] = useState<StaffAvailabilityProfile | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [availability, setAvailability] = useState<Draft>(empty), [qualifications, setQualifications] = useState<Draft>(empty), [saved, setSaved] = useState<StaffRevision | null>(null);
  const [historyKind, setHistoryKind] = useState<StaffRevisionKind>('AVAILABILITY'), [historyVersion, setHistoryVersion] = useState('1');
  const retries = useRef(new Map<string, { fingerprint: string; key: string }>());
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map()), [staffList, setStaffList] = useState<ListState<unknown>['state']>('LOADING');
  // Managers pick a team member by name from the shell's verified school, once it matches the loaded profile's school.
  const shell = useShellSchool(), pickScope = shell && profile && shell.schoolId === profile.schoolId ? shell : null;
  useEffect(() => { void run(() => load('self')); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- open on the signed-in staff member right away
  function clear() { setProfile(null); setAvailability(empty); setQualifications(empty); setSaved(null); }
  async function run(work: () => Promise<void>) { if (busy) return; setBusy(true); setError(''); setNotice(''); try { await work(); } catch (e) { if (e instanceof StaffAvailabilityUiError && [401, 403].includes(e.status)) { clear(); retries.current.clear(); } setError(`${e instanceof Error ? e.message : 'Staff metadata unavailable.'} No success is assumed.`); } finally { setBusy(false); } }
  function show(p: StaffAvailabilityProfile, t: string) { setProfile(p); setTarget(t); setAvailability(draft(p.availability, p.timezone)); setQualifications(draft(p.qualifications, p.timezone)); setSaved(null); }
  async function load(t: string) { clear(); show(await staffAvailabilityRequest<StaffAvailabilityProfile>(staffAvailabilityPath(t)), t); }
  async function save(kind: StaffRevisionKind, end: boolean) {
    if (!profile) throw new Error('Open an availability first.');
    const d = kind === 'AVAILABILITY' ? availability : qualifications, r = kind === 'AVAILABILITY' ? profile.availability : profile.qualifications;
    const body: StaffRevisionInput = { expectedVersion: r?.version ?? 0, status: end ? 'ENDED' : 'ACTIVE', effectiveFrom: d.effectiveFrom, endsOn: end ? null : d.endsOn || null, ...(kind === 'AVAILABILITY' ? { windows: end ? [] : d.windows } : { qualifications: end ? [] : d.qualifications }) };
    validateStaffRevision(kind, body);
    const url = staffAvailabilityPath(target, kind), fingerprint = JSON.stringify(body), prior = retries.current.get(url);
    if (prior?.fingerprint !== fingerprint) retries.current.set(url, { fingerprint, key: crypto.randomUUID() });
    const revision = await staffAvailabilityRequest<StaffRevision>(url, body, retries.current.get(url)!.key);
    if (revision.schoolId !== profile.schoolId || revision.principalId !== profile.principalId) throw new Error('Unexpected scope in saved result.');
    retries.current.delete(url);
    const updated = { ...profile, [kind === 'AVAILABILITY' ? 'availability' : 'qualifications']: revision };
    show(updated, target); setNotice(`Saved. Classes and schedules are not changed.`);
  }
  const lifecycle = (kind: StaffRevisionKind, d: Draft, set: (d: Draft) => void) => <div className={styles.dates}><label>Starts on<input type="date" min="2000-01-01" max="2099-12-31" required value={d.effectiveFrom} onChange={e => set({ ...d, effectiveFrom: e.target.value })} /></label><label>Ends before (optional)<input type="date" min="2000-01-01" max="2099-12-31" value={d.endsOn} onChange={e => set({ ...d, endsOn: e.target.value })} /></label></div>;
  const submit = (kind: StaffRevisionKind) => (e: FormEvent) => { e.preventDefault(); void run(() => save(kind, false)); };
  return <main className={styles.page}>
    <nav><a href="/staff/dashboard">School dashboard</a><a href="/staff/roles">Staff role permissions</a><a href="/auth/login">Sign in</a></nav>
    <header><p>Staff</p><h1>Availability</h1><p>Set the weekly times you or a team member can teach.</p></header>
    <aside data-plain-note=""><strong>Availability is a record only. It does not schedule classes or change pay.</strong></aside>
    {error && <p className={styles.error} role="alert">{error}</p>}{notice && <p className={styles.notice} role="status">{notice}</p>}
    <section><h2>Whose availability</h2><div className={styles.actions}><button disabled={busy} onClick={() => void run(() => load('self'))}>Show my availability</button></div>
      {pickScope && staffList !== 'DENIED' && <StaffPicker scope={pickScope} purpose="availability" label="Or a team member" value={profile && !profile.own ? profile.principalId : ''} disabled={busy} onState={setStaffList} onItems={items => setNames(m => new Map([...m, ...items.map(p => [p.principalId, p.displayName] as const)]))} onPick={person => { if (person) void run(() => load(person.principalId)); }} />}
      {(() => { const form = <form onSubmit={e => { e.preventDefault(); void run(() => load(knownId)); }}><label>Staff record ID<input autoComplete="off" maxLength={36} required value={knownId} onChange={e => setKnownId(e.target.value)} /></label><button disabled={busy || !knownId}>Open</button></form>;
        return !pickScope ? (profile ? <IdFields manual={false}>{form}</IdFields> : null) : staffList === 'UNAVAILABLE' ? form : staffList === 'DENIED' ? null : <IdFields manual={false}>{form}</IdFields>; })()}
      {profile && <p>Showing {profile.own ? 'your availability' : `availability for ${names.get(profile.principalId) ?? 'a team member'}`}. Times are in {profile.timezone}.</p>}
    </section>
    {profile && <>
      <section><h2>Weekly availability{profile.availability ? (profile.availability.status === 'ENDED' ? ' · ended' : '') : ' · nothing saved yet'}</h2><p>Times are in <strong>{profile.timezone}</strong>, 24-hour (for example 09:00 to 17:00). Use 24:00 for the end of the day, and split overnight times across two days. Up to 28 times.</p>
        {!profile.canManageAvailability && <p>You can view this availability but not change it.</p>}
        <form onSubmit={submit('AVAILABILITY')}><fieldset disabled={busy || !profile.canManageAvailability}>{lifecycle('AVAILABILITY', availability, setAvailability)}
          {availability.windows.map((w, index) => <div className={styles.row} key={index}><label>Weekday<select value={w.weekday} onChange={e => setAvailability({ ...availability, windows: availability.windows.map((x, i) => i === index ? { ...x, weekday: Number(e.target.value) } : x) })}>{days.map((day, i) => <option value={i + 1} key={day}>{day}</option>)}</select></label>{(['start', 'end'] as const).map(k => <label key={k}>{k === 'start' ? 'Start' : 'End'}<input required maxLength={5} placeholder={k === 'start' ? '09:00' : '17:00 or 24:00'} value={w[k]} onChange={e => setAvailability({ ...availability, windows: availability.windows.map((x, i) => i === index ? { ...x, [k]: e.target.value } : x) })} /></label>)}<button type="button" onClick={() => setAvailability({ ...availability, windows: availability.windows.filter((_, i) => i !== index) })}>Remove from draft</button></div>)}
          <div className={styles.actions}><button type="button" disabled={availability.windows.length >= 28} onClick={() => setAvailability({ ...availability, windows: [...availability.windows, { weekday: 1, start: '', end: '' }] })}>Add a time</button><button type="submit">Save availability</button><button type="button" disabled={!profile.availability} onClick={() => void run(() => save('AVAILABILITY', true))}>End availability stream on the start date</button></div>
        </fieldset></form><p>Saved history is never overwritten; each save adds a new version.</p>
      </section>
      <section><h2>Qualifications (as entered, unverified){profile.qualifications ? '' : ' · nothing saved yet'}</h2><p>Up to 30 entries, each a title and issuer with an optional expiry date. Your team enters these; they are not checked.</p>
        {!profile.canManageQualifications && <p>You can view these but not change them.</p>}
        <form onSubmit={submit('QUALIFICATIONS')}><fieldset disabled={busy || !profile.canManageQualifications}>{lifecycle('QUALIFICATIONS', qualifications, setQualifications)}
          {qualifications.qualifications.map((q, index) => <div className={styles.row} key={index}>{(['title', 'issuer'] as const).map(k => <label key={k}>{k === 'title' ? 'Title' : 'Issuer'}<input required maxLength={120} value={q[k]} onChange={e => setQualifications({ ...qualifications, qualifications: qualifications.qualifications.map((x, i) => i === index ? { ...x, [k]: e.target.value } : x) })} /></label>)}<label>Optional expiry date<input type="date" min="2000-01-01" max="2099-12-31" value={q.expiresOn ?? ''} onChange={e => setQualifications({ ...qualifications, qualifications: qualifications.qualifications.map((x, i) => i === index ? { ...x, expiresOn: e.target.value || null } : x) })} /></label><button type="button" onClick={() => setQualifications({ ...qualifications, qualifications: qualifications.qualifications.filter((_, i) => i !== index) })}>Remove from draft</button></div>)}
          <div className={styles.actions}><button type="button" disabled={qualifications.qualifications.length >= 30} onClick={() => setQualifications({ ...qualifications, qualifications: [...qualifications.qualifications, { title: '', issuer: '', expiresOn: null }] })}>Add an entry</button><button type="submit">Save qualifications</button><button type="button" disabled={!profile.qualifications} onClick={() => void run(() => save('QUALIFICATIONS', true))}>End qualifications on the start date</button></div>
        </fieldset></form>
      </section>
      <section><h2>Earlier versions</h2><div className={styles.actions}><button disabled={busy} onClick={() => void run(() => load(target))}>Refresh</button><label>Which<select value={historyKind} onChange={e => { setHistoryKind(e.target.value as StaffRevisionKind); setSaved(null); }}>{(['AVAILABILITY', 'QUALIFICATIONS'] as const).map(k => <option key={k} value={k}>{k === 'AVAILABILITY' ? 'Availability' : 'Qualifications'}</option>)}</select></label><label>Version number<input type="number" min="1" max="999999999" value={historyVersion} onChange={e => { setHistoryVersion(e.target.value); setSaved(null); }} /></label><button disabled={busy || !/^[1-9][0-9]{0,8}$/.test(historyVersion)} onClick={() => void run(async () => { setSaved(null); setSaved(await staffAvailabilityRequest<StaffRevision>(staffAvailabilityPath(target, historyKind, Number(historyVersion)))); })}>Show version</button></div>
        {saved && <div><h3>{saved.kind === 'AVAILABILITY' ? 'Availability' : 'Qualifications'}, version {saved.version}{saved.status === 'ENDED' ? ' (ended)' : ''}</h3><p>Recorded {saved.recordedAt}. Applies from {saved.effectiveFrom} to {saved.endsOn ?? 'no end date'} ({saved.timezone}).</p><ul>{saved.windows?.map((w, i) => <li key={i}>{days[w.weekday - 1]} {w.start}–{w.end}</li>)}{saved.qualifications?.map((q, i) => <li key={i}>{q.title} — {q.issuer}; expiry {q.expiresOn ?? 'not recorded'} (unverified)</li>)}</ul></div>}
        <p>If a save is not confirmed, saving the same entries again is safe. No save is assumed until the page confirms it.</p>
      </section>
    </>}
  </main>;
}
