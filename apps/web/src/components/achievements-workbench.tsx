'use client';
import React, { useEffect, useRef, useState } from 'react';
import { ACHIEVEMENT_CATEGORIES, ACHIEVEMENT_AGE_BANDS, ACHIEVEMENT_VISUALS, type AchievementDefinitionInput, type AchievementAwardInput, type AchievementDefinition, type AchievementAward, type AchievementAccess } from '@hon/contracts';
import { AchievementAccessError, achievementFingerprint, loadAchievementAccess, loadAchievementDefinitions, loadAchievementAwards, loadAchievementHistory, saveAchievement, type AchievementMutation } from './achievements-http';
import s from './curriculum-look/plain-page.module.css';
import { ManualSchoolFields, useShellSchoolInto } from './school-shell/page-school';
import { IdFields, StudentPicker } from './school-pickers/pickers';
const freshDefinition = (): AchievementDefinitionInput => ({ expectedVersion: 0, name: '', description: '', category: 'EFFORT', ageBand: 'CHILD', visualToken: null, status: 'ACTIVE' });
const freshAward = (): AchievementAwardInput => ({ expectedVersion: 0, definitionId: '', definitionVersion: 1, reason: null, awardedOn: '', visibleToFamily: false, status: 'AWARDED' });
function definitionDraft(d: AchievementDefinition): AchievementDefinitionInput { const { id: ignored, version, ...fields } = d; void ignored; return { expectedVersion: version, ...fields }; }
function awardDraft(a: AchievementAward): AchievementAwardInput { const { id: ignored, version, studentProfileId: ignoredStudent, definition: ignoredDefinition, recordedAt: ignoredTime, awardedByPrincipalId: ignoredAwarder, recordedByPrincipalId: ignoredActor, ...fields } = a; void ignoredTime; void ignoredAwarder; void ignoredActor; void ignored; void ignoredStudent; void ignoredDefinition; return { expectedVersion: version, ...fields }; }
/** CHILD_FOCUS -> "Child focus": enum codes read as words. */
export const plain = (code: string): string => { const t = code.toLowerCase().replaceAll('_', ' '); return t.charAt(0).toUpperCase() + t.slice(1); };
export function AchievementsWorkbench() {
  const [school, setSchool] = useState(''), [student, setStudent] = useState(''), [studentName, setStudentName] = useState('');
  const shell = useShellSchoolInto(selected => setSchool(selected.schoolId));
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
  async function load(selected = { school, student }) {
    const token = ++generation.current; clear(); setBusy(true); setError(''); setNotice('');
    try { await refresh(selected, token); }
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
      setNotice(mutation.op === 'DEFINITION' ? 'Achievement saved. Past awards keep the version they were given.' : 'Award saved.');
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
  // Open on the signed-in school right away; the server still checks every read and save.
  useEffect(() => { if (shell) { setSchool(shell.schoolId); setStudent(''); setStudentName(''); setPending(null); void load({ school: shell.schoolId, student: '' }); } }, [shell?.organizationId, shell?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps
  const pickerScope = shell && shell.schoolId === scope?.school ? { organizationId: shell.organizationId, schoolId: shell.schoolId } : null;
  function pickStudent(id: string, name: string) { setStudent(id); setStudentName(name); setPending(null); if (scope) void load({ school: scope.school, student: id }); }
  const chosen = definitions.find(d => d.id === award.definitionId);
  const canRetry = scope && pending && scope.school === pending.school && scope.student === pending.student && (pending.mutation.op === 'DEFINITION' ? access?.canManageDefinitions : access?.canRecordAwards);
  function describe(d: AchievementDefinition) { return <><h3>{d.name}</h3><p>{plain(d.category)} · {plain(d.ageBand)}{d.visualToken ? ` · ${plain(d.visualToken)}` : ''} · {d.status === 'ACTIVE' ? 'Active' : 'Archived'}</p><p className={s.body}>{d.description || 'No description.'}</p></>; }
  return <main className={s.page}>
    <header><p>Ranks &amp; curriculum</p><h1>Achievements</h1><p>Make a list of awards your school gives, like Best effort or Perfect attendance, then give them to students. You choose if the family sees each one in the parent app.</p></header>
    <aside data-plain-note=""><strong>An achievement recognizes effort. It is not a grade, a test result or a promotion.</strong></aside>
    <section><h2>Student</h2><ManualSchoolFields current={school}><label>School UUID<input value={school} onChange={e => { changed(); setSchool(e.target.value); }}/></label></ManualSchoolFields>
      {pickerScope && access?.canReadAwards && <StudentPicker scope={pickerScope} purpose="achievements" value={student} disabled={busy || Boolean(pending)} onPick={item => pickStudent(item?.studentProfileId ?? '', item ? `${item.givenName} ${item.familyName}` : '')} />}
      <IdFields manual={!pickerScope}><label>Student record ID (optional)<input value={student} onChange={e => { changed(); setStudent(e.target.value); setStudentName(''); }}/></label><button disabled={busy} onClick={() => void load()}>Open</button></IdFields></section>
    {error && <p role="alert" className={s.error}>{error}</p>}{notice && <p role="status" className={s.notice}>{notice}</p>}
    {pending && <section><h2>We couldn’t confirm that save</h2><p>Try it again before changing anything.</p><button disabled={busy || !canRetry} onClick={() => void mutate(pending.mutation, true)}>Try again</button><button disabled={busy} onClick={() => setPending(null)}>Discard</button></section>}
    {access?.canReadDefinitions && <section><h2>Your school’s achievements</h2>{definitions.length === 0 && <p>No achievements yet.</p>}{definitions.map(d => <article key={d.id}>{describe(d)}{access.canManageDefinitions && d.status === 'ACTIVE' && <button disabled={busy || Boolean(pending)} onClick={() => { setDefinitionId(d.id); setDefinition(definitionDraft(d)); }}>Edit</button>}{access.canRecordAwards && scope?.student && d.status === 'ACTIVE' && <button disabled={busy || Boolean(pending)} onClick={() => { setAwardId(null); setAward({ ...freshAward(), definitionId: d.id, definitionVersion: d.version }); }}>Award to {studentName || 'this student'}</button>}<button disabled={busy} onClick={() => void showHistory('DEFINITION', d.id)}>History</button></article>)}{definitionCursor && <button disabled={busy} onClick={() => void more('DEFINITION')}>More achievements</button>}</section>}
    {access?.canManageDefinitions && <section><h2>{definitionId ? `Edit ${definition.name || 'achievement'}` : 'New achievement'}</h2><button disabled={busy || Boolean(pending)} onClick={() => { setDefinitionId(null); setDefinition(freshDefinition()); }}>Start a new one</button><fieldset disabled={busy || Boolean(pending)}>
      <label>Name<input maxLength={100} value={definition.name} onChange={e => setDefinition({ ...definition, name: e.target.value })}/></label>
      <label>Description (optional, plain text)<textarea maxLength={600} value={definition.description} onChange={e => setDefinition({ ...definition, description: e.target.value })}/></label>
      <label>Category<select value={definition.category} onChange={e => setDefinition({ ...definition, category: e.target.value as AchievementDefinitionInput['category'] })}>{ACHIEVEMENT_CATEGORIES.map(x => <option key={x} value={x}>{plain(x)}</option>)}</select></label>
      <label>Age group<select value={definition.ageBand} onChange={e => setDefinition({ ...definition, ageBand: e.target.value as AchievementDefinitionInput['ageBand'] })}>{ACHIEVEMENT_AGE_BANDS.map(x => <option key={x} value={x}>{plain(x)}</option>)}</select></label><p className={s.meta}>Early childhood: 3–5. Child: 6–11. Teen: 12–17. Adult: 18+. Age is checked on the award date.</p>
      <label>Badge style (optional)<select value={definition.visualToken ?? ''} onChange={e => setDefinition({ ...definition, visualToken: e.target.value ? e.target.value as AchievementDefinitionInput['visualToken'] : null })}><option value="">None</option>{ACHIEVEMENT_VISUALS.map(x => <option key={x} value={x}>{plain(x)}</option>)}</select></label>
      <button data-primary="" onClick={() => void mutate({ op: 'DEFINITION', id: definitionId, input: definition })}>Save achievement</button>
      {definitionId && <button onClick={() => { const current = definitions.find(d => d.id === definitionId); if (current) void mutate({ op: 'DEFINITION', id: current.id, input: { ...definitionDraft(current), status: 'ARCHIVED' } }); }}>Archive (stops new awards)</button>}
    </fieldset></section>}
    {access?.canReadAwards && scope?.student && <section><h2>{studentName ? `${studentName}’s achievements` : 'This student’s achievements'}</h2>{awards.length === 0 && <p>No achievements awarded yet.</p>}{awards.map(a => <article key={a.id}>{describe(a.definition)}<p>{a.awardedOn} · {a.status === 'AWARDED' ? 'Awarded' : 'Withdrawn'} · {a.visibleToFamily ? 'Family can see it' : 'Staff only'}</p><p>Staff note: {a.reason ?? 'None'}</p>{access.canRecordAwards && a.status === 'AWARDED' && <button disabled={busy || Boolean(pending)} onClick={() => { setAwardId(a.id); setAward(awardDraft(a)); }}>Edit note, date or family view</button>}<button disabled={busy} onClick={() => void showHistory('AWARD', a.id)}>History</button></article>)}{awardCursor && <button disabled={busy} onClick={() => void more('AWARD')}>More awards</button>}</section>}
    {access?.canRecordAwards && scope?.student && <section><h2>{awardId ? 'Edit award' : `Give ${studentName || 'this student'} an achievement`}</h2><button disabled={busy || Boolean(pending)} onClick={() => { setAwardId(null); setAward(freshAward()); }}>Start a new award</button><fieldset disabled={busy || Boolean(pending)}>
      <p>Achievement: {chosen?.name ?? (award.definitionId ? 'Chosen achievement' : 'Choose one from the list above')}</p>
      <IdFields manual={false}><label>Achievement record ID<input disabled={Boolean(awardId)} value={award.definitionId} onChange={e => setAward({ ...award, definitionId: e.target.value })}/></label><label>Achievement version<input disabled={Boolean(awardId)} type="number" min={1} max={999999998} value={award.definitionVersion} onChange={e => setAward({ ...award, definitionVersion: Number(e.target.value) })}/></label></IdFields>
      <label>Award date<input type="date" value={award.awardedOn} onChange={e => setAward({ ...award, awardedOn: e.target.value })}/></label>
      <label>Staff note (optional, never shown to family)<textarea maxLength={1000} value={award.reason ?? ''} onChange={e => setAward({ ...award, reason: e.target.value || null })}/></label>
      <label><input type="checkbox" checked={award.visibleToFamily} onChange={e => setAward({ ...award, visibleToFamily: e.target.checked })}/>Let the family see it</label>
      <button data-primary="" onClick={() => void mutate({ op: 'AWARD', id: awardId, student: scope.student, input: award })}>{awardId ? 'Save changes' : 'Give achievement'}</button>
      {awardId && <button onClick={() => void mutate({ op: 'AWARD', id: awardId, student: scope.student, input: { ...award, status: 'WITHDRAWN', visibleToFamily: false } })}>Withdraw award</button>}
    </fieldset><p className={s.meta}>Withdrawing an award hides it from the family. Its history stays.</p></section>}
    {history && <section><h2>{history.kind === 'AWARD' ? 'Earlier versions of this award' : 'Earlier versions of this achievement'}</h2>{history.items.map(v => <article key={v.version}><p className={s.meta}>{plain(v.status)}</p>{'reason' in v ? <><p>{v.awardedOn} · {v.visibleToFamily ? 'Family visible' : 'Staff only'}</p><p className={s.meta}>Saved {v.recordedAt.slice(0, 10)}</p><p>Staff note: {v.reason ?? 'None'}</p></> : describe(v)}</article>)}{history.nextBefore && <button disabled={busy} onClick={() => void showHistory(history.kind, history.id, history.nextBefore)}>Show older</button>}</section>}
  </main>;
}
