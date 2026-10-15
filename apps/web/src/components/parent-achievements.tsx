'use client';
import Link from 'next/link';
import React, { useRef, useState } from 'react';
import type { ParentAchievementAward } from '@hon/contracts';
import { loadParentAchievements } from './achievements-http';
import s from './community-workbench.module.css';
export function ParentAchievements() {
  const [school, setSchool] = useState(''), [family, setFamily] = useState(''), [student, setStudent] = useState('');
  const [loaded, setLoaded] = useState(false), [items, setItems] = useState<ParentAchievementAward[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''); const generation = useRef(0);
  function clear() { setLoaded(false); setItems([]); setCursor(null); }
  function changed() { ++generation.current; clear(); setError(''); setBusy(false); }
  async function load(after: string | null = null) {
    const token = ++generation.current; clear(); setBusy(true); setError('');
    try { const p = await loadParentAchievements(school, family, student, after); if (generation.current === token) { setItems(p.items); setCursor(p.nextAfter); setLoaded(true); } }
    catch (e) { if (generation.current === token) { clear(); setError(e instanceof Error ? e.message : 'Current child access unavailable.'); } }
    finally { if (generation.current === token) setBusy(false); }
  }
  return <main className={s.page}><nav><Link href="/parent">Family workspace</Link></nav><header><p>HON / FAMILY RECOGNITION</p><h1>Your child’s human-recorded achievements</h1><p>Read-only recognition that school staff explicitly chose to share for this exact child. No social feed or sibling records.</p></header><aside>Recognition is not a score, testing approval, promotion or readiness guarantee. Private staff reasons and revision history are never shared here.</aside>
    <section><h2>Current authorized child</h2><label>School UUID<input value={school} onChange={e => { changed(); setSchool(e.target.value); }}/></label><label>Current authorized family UUID<input value={family} onChange={e => { changed(); setFamily(e.target.value); }}/></label><label>Known child student profile UUID<input value={student} onChange={e => { changed(); setStudent(e.target.value); }}/></label><button disabled={busy} onClick={() => void load()}>Load this child’s visible achievements</button><p>Use the school-provided existing family and child record IDs. The server checks live family access and this child’s current membership on every read; entered IDs grant no access.</p></section>
    {error && <p role="alert" className={s.error}>{error}</p>}{loaded && <section><h2>Shared recognition for this child only</h2>{items.length === 0 && <p>No currently shared achievements for this child.</p>}{items.map(a => <article key={a.id}><h3>{a.definition.name}</h3><p>{a.awardedOn} · {a.definition.category} · {a.definition.visualToken ?? 'Recognition'}</p><p className={s.body}>{a.definition.description}</p></article>)}{cursor && <button disabled={busy} onClick={() => void load(cursor)}>Next visible achievements page</button>}</section>}
  </main>;
}
