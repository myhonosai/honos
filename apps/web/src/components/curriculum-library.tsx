'use client';
import React, { useRef, useState, type FormEvent } from 'react';
import type { StaffCurriculumLibrary, CurriculumResourceRecord, CurriculumResourceCreateInput } from '@hon/contracts';
import { loadStaffLibrary, createLibraryReference, updateLibraryReference, archiveLibraryReference } from './curriculum-library-http';
import s from './curriculum-look/look.module.css';
import { useShellSchoolInto } from './school-shell/page-school';

const KIND = { VIDEO: 'Video', LINK: 'Link' } as const;
const WHO = { STAFF: 'Staff only', PARENT: 'Staff and families' } as const;

/**
 * Ranks & curriculum > Videos and links (docs/architecture/RANK_SETUP_AND_PLAIN_CURRICULUM_PAGES.md section 6). Same API and same
 * retained-key retries as before, in plain words and the dark school look. The school is the verified shell school; the server
 * re-checks permission and the school's subscription on every call.
 */
export function StaffCurriculumLibraryWorkbench() {
  const [school, setSchool] = useState(''), [view, setView] = useState<StaffCurriculumLibrary | null>(null), [curriculum, setCurriculum] = useState(''), [rank, setRank] = useState('');
  const [edit, setEdit] = useState<CurriculumResourceRecord | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [adding, setAdding] = useState(false), [showRemoved, setShowRemoved] = useState(false);
  const gate = useRef(false), keys = useRef(new Map<string, string>());
  // Inside the school shell the signed-in school's library loads on open; the server still authorizes it.
  const shellSchool = useShellSchoolInto((signedIn) => { setSchool(signedIn.schoolId); setView(null); setEdit(null); void list(signedIn.schoolId); });
  function list(target: string) { return run(async () => { setView(null); setEdit(null); const result = await loadStaffLibrary(target); setView(result); setCurriculum(result.curricula[0]?.id ?? ''); setRank(''); }); }
  async function run(work: () => Promise<void>) {
    if (gate.current) return; gate.current = true; setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (e) { setView(null); setEdit(null); setError(e instanceof Error ? e.message : 'Videos and links are unavailable right now. Refresh to check before trying again.'); }
    finally { gate.current = false; setBusy(false); }
  }
  /** A retry of the same change reuses its key until the server confirms it. */
  function retry(fingerprint: string) { const old = keys.current.get(fingerprint); if (old) return old; const key = crypto.randomUUID(); keys.current.set(fingerprint, key); return key; }
  function saved(r: CurriculumResourceRecord, done: string) { setView((v) => v ? { ...v, resources: [...v.resources.filter((x) => x.id !== r.id), r] } : v); setEdit(null); setNotice(done); }
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    const input: CurriculumResourceCreateInput = { expectedVersion: 0, curriculumId: curriculum, rankId: rank || null, kind: String(f.get('kind')) as 'VIDEO' | 'LINK', url: String(f.get('url')).trim(),
      title: String(f.get('title')).trim(), description: String(f.get('description')).trim(), audience: String(f.get('audience')) as 'STAFF' | 'PARENT' };
    const fp = `${school}:create:${JSON.stringify(input)}`; saved(await createLibraryReference(school, input, retry(fp)), `Saved "${input.title}".`); keys.current.delete(fp); setAdding(false);
  }
  async function update(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (!edit) throw new Error('Choose the item to edit again.'); const f = new FormData(e.currentTarget);
    const input = { expectedVersion: edit.version, title: String(f.get('title')).trim(), description: String(f.get('description')).trim(), audience: String(f.get('audience')) as 'STAFF' | 'PARENT' };
    const fp = `${school}:${edit.id}:${JSON.stringify(input)}`; saved(await updateLibraryReference(school, edit.id, input, retry(fp)), `Saved "${input.title}".`); keys.current.delete(fp);
  }
  async function archive(r: CurriculumResourceRecord) { const fp = `${school}:${r.id}:archive:${r.version}`; saved(await archiveLibraryReference(school, r.id, { expectedVersion: r.version }, retry(fp)), `Removed "${r.title}".`); keys.current.delete(fp); }

  const programName = (id: string) => view?.curricula.find((c) => c.id === id)?.name ?? 'Program';
  const beltName = (id: string | null) => id ? view?.curricula.flatMap((c) => c.ranks).find((k) => k.id === id)?.name ?? 'One belt' : 'Every belt';
  const active = view?.resources.filter((r) => r.status === 'ACTIVE') ?? [], removed = view?.resources.filter((r) => r.status !== 'ACTIVE') ?? [];
  const item = (r: CurriculumResourceRecord) => <article key={r.id}>
    <h3>{r.title}</h3>{r.description && <p>{r.description}</p>}
    <p className={s.meta}>{KIND[r.kind as keyof typeof KIND] ?? r.kind} · {programName(r.curriculumId)} · {beltName(r.rankId)} · {WHO[r.audience as keyof typeof WHO] ?? r.audience}</p>
    {r.status === 'ACTIVE' && <div className={s.actions}><a className={s.ghost} href={r.url} target="_blank" rel="noopener noreferrer">Open</a>
      <button type="button" className={s.ghost} disabled={busy} onClick={() => setEdit(r)}>Edit</button>
      <button type="button" className={s.danger} disabled={busy} onClick={() => void run(() => archive(r))}>Remove</button></div>}
    {edit?.id === r.id && <form key={`${edit.id}:${edit.version}`} className={s.addForm} onSubmit={(e) => void run(() => update(e))}><fieldset disabled={busy} className={s.stack}>
      <p className={s.meta}>The link and the belt stay the same. To change them, remove this one and add a new one.</p>
      <Fields record={edit} /><div className={s.actions}><button className={s.primary}>Save</button><button type="button" className={s.ghost} onClick={() => setEdit(null)}>Cancel</button></div></fieldset></form>}
  </article>;

  return <main className={s.page}>
    <header className={s.head}><div><p className={s.eyebrow}>Ranks &amp; curriculum</p><h1>Videos and links</h1>
      <p>Keep the videos and links you teach with in one place. Choose whether only your staff see each one, or families see it in the parent app too.</p></div>
      <div className={s.actions}><a className={s.ghost} href="/staff/curriculum/ranks">Rank setup</a><a className={s.ghost} href="/staff/parent-app/curriculum">What families see in the app</a>
        {shellSchool && <button type="button" className={s.button} disabled={busy} onClick={() => void list(shellSchool.schoolId)}>{busy ? 'Loading…' : 'Refresh library'}</button>}</div></header>
    {error && <p role="alert" className={s.flash} data-tone="bad">{error}</p>}
    {notice && <p role="status" className={s.flash} data-tone="ok">{notice}</p>}
    {!shellSchool && <p className={s.muted}>Open this page from your school&apos;s menu to see its videos and links.</p>}
    {view && !view.curricula.length && <div className={s.empty}><strong>No programs yet</strong><span>Set up a program and its belts in <a href="/staff/curriculum/ranks">Rank setup</a> first, then add videos and links here.</span></div>}
    {view && !!view.curricula.length && <>
      <section className={s.panel} aria-labelledby="library-items">
        <div className={s.beltHead}><h2 id="library-items">Your videos and links ({active.length})</h2>
          {!adding && <button type="button" className={s.primary} disabled={busy} onClick={() => setAdding(true)}>Add a video or link</button>}</div>
        {adding && <form className={s.addForm} onSubmit={(e) => void run(() => create(e))}><fieldset disabled={busy} className={s.stack}>
          <div className={s.grid2}>
            <label className={s.label}>Program<select className={s.field} required value={curriculum} onChange={(e) => { setCurriculum(e.target.value); setRank(''); }}>
              {view.curricula.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label className={s.label}>Belt<select className={s.field} value={rank} onChange={(e) => setRank(e.target.value)}><option value="">Every belt</option>
              {view.curricula.find((c) => c.id === curriculum)?.ranks.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
            <label className={s.label}>Type<select className={s.field} name="kind"><option value="VIDEO">Video</option><option value="LINK">Link</option></select></label>
            <label className={s.label}>Link<input className={s.field} name="url" type="url" required maxLength={2048} autoComplete="off" placeholder="https://www.youtube.com/watch?v=…" /></label>
          </div>
          <p className={s.meta}>Use the full web address that starts with https://. It opens on that site.</p>
          <Fields /><div className={s.actions}><button className={s.primary} disabled={!curriculum}>Save</button><button type="button" className={s.ghost} onClick={() => setAdding(false)}>Cancel</button></div>
        </fieldset></form>}
        {!active.length && !adding && <p className={s.muted}>Nothing here yet. Add the first video or link your students practice with.</p>}
        {active.map(item)}
      </section>
      {!!removed.length && <section className={s.panel} aria-label="Removed">
        <button type="button" className={s.ghost} aria-expanded={showRemoved} onClick={() => setShowRemoved(!showRemoved)}>Removed ({removed.length})</button>
        {showRemoved && removed.map(item)}</section>}
    </>}
    <p className={s.meta}>If a save does not confirm, press it again: the same change is never saved twice. If someone else changed an item, refresh first.</p>
  </main>;
}

function Fields({ record }: { record?: CurriculumResourceRecord }) {
  return <div className={s.grid2}>
    <label className={s.label}>Title<input className={s.field} name="title" required maxLength={160} defaultValue={record?.title ?? ''} placeholder="Front kick drill" /></label>
    <label className={s.label}>Who can see it<select className={s.field} name="audience" defaultValue={record?.audience ?? 'STAFF'}><option value="STAFF">Staff only</option><option value="PARENT">Staff and families</option></select></label>
    <label className={s.label}>Description (optional)<textarea className={s.field} name="description" maxLength={600} defaultValue={record?.description ?? ''} /></label>
  </div>;
}
