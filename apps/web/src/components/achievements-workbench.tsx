'use client';
import Link from 'next/link';
import React, { useRef, useState } from 'react';
import { ACHIEVEMENT_HELP, ACHIEVEMENT_CATEGORIES, ACHIEVEMENT_AGE_BANDS, ACHIEVEMENT_VISUALS, type AchievementDefinitionInput, type AchievementAwardInput, type AchievementDefinition, type AchievementAward, type AchievementAccess } from '@hon/contracts';
import { AchievementAccessError, achievementFingerprint, loadAchievementAccess, loadAchievementDefinitions, loadAchievementAwards, loadAchievementHistory, saveAchievement, type AchievementMutation } from './achievements-http';
import s from './community-workbench.module.css';
const freshDefinition = (): AchievementDefinitionInput => ({ expectedVersion: 0, name: '', description: '', category: 'EFFORT', ageBand: 'CHILD', visualToken: null, status: 'ACTIVE' });
const freshAward = (): AchievementAwardInput => ({ expectedVersion: 0, definitionId: '', definitionVersion: 1, reason: null, awardedOn: '', visibleToFamily: false, status: 'AWARDED' });
function definitionDraft(d: AchievementDefinition): AchievementDefinitionInput { const { id: ignored, version, ...fields } = d; void ignored; return { expectedVersion: version, ...fields }; }
function awardDraft(a: AchievementAward): AchievementAwardInput { const { id: ignored, version, studentProfileId: ignoredStudent, definition: ignoredDefinition, recordedAt: ignoredTime, awardedByPrincipalId: ignoredAwarder, recordedByPrincipalId: ignoredActor, ...fields } = a; void ignoredTime; void ignoredAwarder; void ignoredActor; void ignored; void ignoredStudent; void ignoredDefinition; return { expectedVersion: version, ...fields }; }
export function AchievementsWorkbench() {
  const [school, setSchool] = useState(''), [student, setStudent] = useState('');
  const [scope, setScope] = useState<{ school: string; student: string } | null>(null), [access, setAccess] = useState<AchievementAccess | null>(null);
  const [definitions, setDefinitions] = useState<AchievementDefinition[]>([]), [awards, setAwards] = useState<AchievementAward[]>([]);
  const [definitionCursor, setDefinitionCursor] = useState<string | null>(null), [awardCursor, setAwardCursor] = useState<string | null>(null);
  const [definition, setDefinition] = useState(freshDefinition), [definitionId, setDefinitionId] = useState<string | null>(null);
  const [award, setAward] = useState(freshAward), [awardId, setAwardId] = useState<string | null>(null);
  const [history, setHistory] = useState<{ kind: 'DEFINITION' | 'AWARD'; id: string; items: (AchievementDefinition | AchievementAward)[]; nextBefore: number | null } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [pending, setPending] = useState<{ school: string; student: string; mutation: AchievementMutation; key: string } | null>(null);
  const generation = useRef(0);
  function clear() { setScope(null); setAccess(null); setDefinitions([]); setAwards([]); setHistory(null); setDefinitionId(null); setAwardId(null); setDefinition(freshDefinition()); setAward(freshAward()); setDefinitionCursor(null); setAwardCursor(null); }
  function changed() { ++generation.current; clear(); setPending(null); setBusy(false); setError(''); setNotice(''); }
  async function refresh(selected: { school: string; student: string }, token: number) {
    const permissions = await loadAchievementAccess(selected.school);
    const [d, a] = await Promise.all([permissions.canReadDefinitions ? loadAchievementDefinitions(selected.school) : null, permissions.canReadAwards && selected.student ? loadAchievementAwards(selected.school, selected.student) : null]);
    if (generation.current !== token) return;
    setScope(selected); setAccess(permissions); setDefinitions(d?.items ?? []); setAwards(a?.items ?? []); setDefinitionCursor(d?.nextAfter ?? null); setAwardCursor(a?.nextAfter ?? null);
  }
  async function load() {
    const token = ++generation.current; clear(); setBusy(true); setError(''); setNotice('');
    try { await refresh({ school, student }, token); }
    catch (e) { if (generation.current === token) { clear(); if (e instanceof AchievementAccessError) setPending(null); setError(e instanceof Error ? e.message : 'Unavailable'); } }
    finally { if (generation.current === token) setBusy(false); }
  }
  async function mutate(mutation: AchievementMutation, retry = false) {
    if (!scope || busy) return; const selected = scope; const token = generation.current;
    const attempt = retry ? pending : { ...selected, mutation, key: crypto.randomUUID() };
    if (!attempt || attempt.school !== selected.school || attempt.student !== selected.student || achievementFingerprint(attempt.mutation) !== achievementFingerprint(mutation)) return;
    setPending(attempt); setBusy(true); setError(''); setNotice('');
    try {
      await saveAchievement(selected.school, mutation, attempt.key);
      if (generation.current !== token) return;
      setPending(null); setDefinitionId(null); setAwardId(null); setDefinition(freshDefinition()); setAward(freshAward()); setHistory(null);
      setNotice(mutation.op === 'DEFINITION' ? 'Human definition revision saved. Existing awards keep their original definition version.' : 'Explicit human recognition saved. No rank, testing, attendance, points or observations changed.');
      await refresh(selected, token);
    } catch (e) { if (generation.current === token) { clear(); if (e instanceof AchievementAccessError) setPending(null); setError(e instanceof Error ? e.message : 'Unavailable'); } }
    finally { if (generation.current === token) setBusy(false); }
  }
  async function more(kind: 'DEFINITION' | 'AWARD') {
    if (!scope) return; const token = generation.current; setBusy(true); setError('');
    try {
      if (kind === 'DEFINITION') { const p = await loadAchievementDefinitions(scope.school, definitionCursor); if (generation.current === token) { setDefinitions(p.items); setDefinitionCursor(p.nextAfter); } }
      else { const p = await loadAchievementAwards(scope.school, scope.student, awardCursor); if (generation.current === token) { setAwards(p.items); setAwardCursor(p.nextAfter); } }
    } catch (e) { if (generation.current === token) { clear(); setPending(null); setError(e instanceof Error ? e.message : 'Unavailable'); } }
    finally { if (generation.current === token) setBusy(false); }
  }
  async function showHistory(kind: 'DEFINITION' | 'AWARD', id: string, before: number | null = null) {
    if (!scope) return; const token = generation.current; setBusy(true); setHistory(null); setError('');
    try { const h = await loadAchievementHistory(scope.school, kind, id, kind === 'AWARD' ? scope.student : null, before); if (generation.current === token) setHistory({ kind, ...h }); }
    catch (e) { if (generation.current === token) { clear(); setPending(null); setError(e instanceof Error ? e.message : 'Unavailable'); } }
    finally { if (generation.current === token) setBusy(false); }
  }
  const canRetry = scope && pending && scope.school === pending.school && scope.student === pending.student && (pending.mutation.op === 'DEFINITION' ? access?.canManageDefinitions : access?.canRecordAwards);
  function describe(d: AchievementDefinition) { return <><h3>{d.name}</h3><p>{d.category} · {d.ageBand.replaceAll('_', ' ')} · {d.visualToken ?? 'No visual token'} · Version {d.version} · {d.status}</p><p className={s.body}>{d.description || 'No description provided.'}</p></>; }
  return <main className={s.page}>
    <nav><Link href="/core">School workspace</Link><Link href="/parent/achievements">Separate family recognition view</Link></nav>
    <header><p>HON / HUMAN STUDENT RECOGNITION</p><h1>Recognize effort. Keep judgment human.</h1><p>School-owned achievements and explicit instructor or staff decisions. Available on Essential, Core and Complete.</p></header>
    <aside>{ACHIEVEMENT_HELP}</aside>
    <section><h2>Known school and student</h2><label>School UUID<input value={school} onChange={e => { changed(); setSchool(e.target.value); }}/></label><label>Known student profile UUID (optional for definitions)<input value={student} onChange={e => { changed(); setStudent(e.target.value); }}/></label><button disabled={busy} onClick={() => void load()}>Load current permissions and records</button><p>Use an already-known school and student record. These selectors are not authorization; there is no student directory here.</p></section>
    {error && <p role="alert" className={s.error}>{error}</p>}{notice && <p role="status" className={s.notice}>{notice}</p>}
    {pending && <section><h2>Uncertain request retained</h2><p>Reload the same school and child access, then retry the exact unchanged request with its original key. Nothing is automatically retried. Access denial or changing scope clears the private draft.</p><button disabled={busy || !canRetry} onClick={() => void mutate(pending.mutation, true)}>Retry unchanged request</button><button disabled={busy} onClick={() => setPending(null)}>Discard retained retry</button></section>}
    {access?.canReadDefinitions && <section><h2>School achievement definitions</h2>{definitions.length === 0 && <p>No school definitions recorded.</p>}{definitions.map(d => <article key={d.id}>{describe(d)}<p>Definition ID: {d.id}</p>{access.canManageDefinitions && d.status === 'ACTIVE' && <button disabled={busy || Boolean(pending)} onClick={() => { setDefinitionId(d.id); setDefinition(definitionDraft(d)); }}>Revise definition</button>}{access.canRecordAwards && scope?.student && d.status === 'ACTIVE' && <button disabled={busy || Boolean(pending)} onClick={() => { setAwardId(null); setAward({ ...freshAward(), definitionId: d.id, definitionVersion: d.version }); }}>Choose for human award</button>}<button disabled={busy} onClick={() => void showHistory('DEFINITION', d.id)}>Definition history</button></article>)}{definitionCursor && <button disabled={busy} onClick={() => void more('DEFINITION')}>Next definitions page</button>}</section>}
    {access?.canManageDefinitions && <section><h2>{definitionId ? `Revise definition version ${definition.expectedVersion}` : 'Create school achievement'}</h2><button disabled={busy || Boolean(pending)} onClick={() => { setDefinitionId(null); setDefinition(freshDefinition()); }}>New definition</button><fieldset disabled={busy || Boolean(pending)}>
      <label>Name<input maxLength={100} value={definition.name} onChange={e => setDefinition({ ...definition, name: e.target.value })}/></label>
      <label>Description (optional, plain text)<textarea maxLength={600} value={definition.description} onChange={e => setDefinition({ ...definition, description: e.target.value })}/></label>
      <label>Category<select value={definition.category} onChange={e => setDefinition({ ...definition, category: e.target.value as AchievementDefinitionInput['category'] })}>{ACHIEVEMENT_CATEGORIES.map(x => <option key={x}>{x}</option>)}</select></label>
      <label>Age band<select value={definition.ageBand} onChange={e => setDefinition({ ...definition, ageBand: e.target.value as AchievementDefinitionInput['ageBand'] })}>{ACHIEVEMENT_AGE_BANDS.map(x => <option key={x}>{x}</option>)}</select></label><p>Early childhood: 3–5. Child: 6–11. Teen: 12–17. Adult: 18+. Birth date must be known; age is checked on the award date. This is not a readiness assessment.</p>
      <label>Optional visual token<select value={definition.visualToken ?? ''} onChange={e => setDefinition({ ...definition, visualToken: e.target.value ? e.target.value as AchievementDefinitionInput['visualToken'] : null })}><option value="">None</option>{ACHIEVEMENT_VISUALS.map(x => <option key={x}>{x}</option>)}</select></label>
      <button onClick={() => void mutate({ op: 'DEFINITION', id: definitionId, input: definition })}>Save human definition</button>
      {definitionId && <button onClick={() => { const current = definitions.find(d => d.id === definitionId); if (current) void mutate({ op: 'DEFINITION', id: current.id, input: { ...definitionDraft(current), status: 'ARCHIVED' } }); }}>Archive unchanged definition permanently</button>}
    </fieldset></section>}
    {access?.canReadAwards && scope?.student && <section><h2>Recognition for this exact student</h2>{awards.length === 0 && <p>No human awards recorded for this student.</p>}{awards.map(a => <article key={a.id}>{describe(a.definition)}<p>{a.awardedOn} · {a.status} · Award revision {a.version} · {a.visibleToFamily ? 'Visible to authorized family' : 'Staff only'}</p><p>Private staff reason: {a.reason ?? 'Not provided'}</p>{access.canRecordAwards && a.status === 'AWARDED' && <button disabled={busy || Boolean(pending)} onClick={() => { setAwardId(a.id); setAward(awardDraft(a)); }}>Correct reason, date or family visibility</button>}<button disabled={busy} onClick={() => void showHistory('AWARD', a.id)}>Private award history</button></article>)}{awardCursor && <button disabled={busy} onClick={() => void more('AWARD')}>Next awards page</button>}</section>}
    {access?.canRecordAwards && scope?.student && <section><h2>{awardId ? `Correct award revision ${award.expectedVersion}` : 'Explicit human award decision'}</h2><p>Student: {scope.student}. No rule, observation, attendance or AI suggestion awards this achievement.</p><button disabled={busy || Boolean(pending)} onClick={() => { setAwardId(null); setAward(freshAward()); }}>New human award</button><fieldset disabled={busy || Boolean(pending)}>
      <label>Known definition UUID<input disabled={Boolean(awardId)} value={award.definitionId} onChange={e => setAward({ ...award, definitionId: e.target.value })}/></label><label>Exact definition version<input disabled={Boolean(awardId)} type="number" min={1} max={999999998} value={award.definitionVersion} onChange={e => setAward({ ...award, definitionVersion: Number(e.target.value) })}/></label>
      <label>Award date<input type="date" value={award.awardedOn} onChange={e => setAward({ ...award, awardedOn: e.target.value })}/></label>
      <label>Private staff reason (optional; never shared with family)<textarea maxLength={1000} value={award.reason ?? ''} onChange={e => setAward({ ...award, reason: e.target.value || null })}/></label>
      <label><input type="checkbox" checked={award.visibleToFamily} onChange={e => setAward({ ...award, visibleToFamily: e.target.checked })}/>Visible to currently authorized family for this child</label>
      <button onClick={() => void mutate({ op: 'AWARD', id: awardId, student: scope.student, input: award })}>{awardId ? 'Save explicit human correction' : 'Award by my explicit human decision'}</button>
      {awardId && <button onClick={() => void mutate({ op: 'AWARD', id: awardId, student: scope.student, input: { ...award, status: 'WITHDRAWN', visibleToFamily: false } })}>Withdraw award permanently</button>}
    </fieldset><p>Student and definition are immutable. Withdrawal preserves history and removes family visibility. Definition archive stops new awards, not existing recognition.</p></section>}
    {history && <section><h2>{history.kind === 'AWARD' ? 'Private human award revision history' : 'School definition revision history'}</h2>{history.items.map(v => <article key={v.version}><p>Version {v.version} · {v.status}</p>{'reason' in v ? <><p>{v.awardedOn} · {v.visibleToFamily ? 'Family visible' : 'Staff only'}</p><p>Originally awarded by human principal {v.awardedByPrincipalId}. This revision was recorded by human principal {v.recordedByPrincipalId} at {v.recordedAt}</p><p>Private reason: {v.reason ?? 'Not provided'}</p></> : describe(v)}</article>)}{history.nextBefore && <button disabled={busy} onClick={() => void showHistory(history.kind, history.id, history.nextBefore)}>Older revisions</button>}</section>}
  </main>;
}
