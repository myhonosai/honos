'use client';
import React, { useRef, useState, type FormEvent } from 'react';
import { CRM_FOLLOW_UP_HELP, type FollowUpInput, type FollowUpRecord, type FollowUpQueue, type FollowUpStatus, type FollowUpOperation, type FollowUpTransition } from '@hon/contracts';
import { loadFollowUps, readFollowUp, mutateFollowUp, followUpFingerprint, FollowUpAccessError } from './crm-follow-ups-http';
import { crmFollowUpLeadId } from './crm-follow-up-handoff';
import { formatInSchool, instantToSchoolLocal, readSessionSchoolClock, schoolLocalToInstant } from './school-time';
import styles from './staff-availability-workbench.module.css';
const initial = (assigneeId = '', leadId = ''): FollowUpInput => ({ expectedVersion: 0, leadId, assigneeId, subject: '', note: '', dueAt: null, priority: 'NORMAL' });
const fields = (r: FollowUpRecord): FollowUpInput => ({ expectedVersion:r.version,leadId:r.leadId,assigneeId:r.assigneeId,subject:r.subject,note:r.note,dueAt:r.dueAt,priority:r.priority });
export function CrmFollowUpsWorkbench({ initialLeadId, clockReader = readSessionSchoolClock }: { initialLeadId?: string | undefined; clockReader?: typeof readSessionSchoolClock } = {}): React.ReactElement {
  // B-CRM-3: the server names the verified school's timezone; until it does (or if it cannot), due times stay explicit UTC.
  const [zone,setZone] = useState<{ schoolId: string; timezone: string } | null>(null), [dueEdit,setDueEdit] = useState<string | null>(null);
  const tz = zone?.timezone ?? null, schoolRef = useRef('');
  const shown = (instant: string | null) => instant === null ? 'not set' : tz ? formatInSchool(instant, tz, typeof navigator === 'undefined' ? 'en-US' : navigator.language || 'en-US') : instant;
  const [context,setContext] = useState<FollowUpQueue | null>(null), [selected,setSelected] = useState<FollowUpRecord | null>(null), [draft,setDraft] = useState<FollowUpInput>(initial);
  const [queue,setQueue] = useState<'mine' | 'team'>('mine'), [status,setStatus] = useState<FollowUpStatus | 'ALL'>('OPEN'), [busy,setBusy] = useState(false), [error,setError] = useState(''), [notice,setNotice] = useState(''), [knownId,setKnownId] = useState('');
  const retry = useRef<{ fingerprint:string; key:string; op:FollowUpOperation; id:string | null; input:FollowUpInput | FollowUpTransition } | null>(null);
  const pendingLeadId = useRef(crmFollowUpLeadId(initialLeadId) ?? '');
  const [uncertain,setUncertain] = useState(false), [needsRefresh,setNeedsRefresh] = useState(false);
  async function run(work: () => Promise<void>) { setBusy(true); setError(''); setNotice(''); try { await work(); } catch (e) { if (e instanceof FollowUpAccessError) { pendingLeadId.current=''; schoolRef.current=''; setZone(null); setContext(null); setSelected(null); resetDraft(initial()); } setError(e instanceof Error ? e.message : 'No verified result.'); } finally { setBusy(false); } }
  function choose(r: FollowUpRecord | null) { setNeedsRefresh(false); setSelected(r); resetDraft(r ? fields(r) : initial(context?.principalId)); }
  function resetDraft(d: FollowUpInput) { setDraft(d); setDueEdit(null); }
  function edit(p: Partial<FollowUpInput>) { setDraft(d => ({ ...d,...p })); setNotice(''); }
  async function load(after: string | null = null) { await run(async () => {
    const prefilledLeadId = after === null ? pendingLeadId.current : ''; pendingLeadId.current='';
    setContext(null); setSelected(null); resetDraft(initial());
    const c = await loadFollowUps(queue,status,after); setContext(c); schoolRef.current = c.schoolId; resetDraft(initial(c.principalId,prefilledLeadId));
    if (zone?.schoolId !== c.schoolId) { setZone(null); void clockReader(c.schoolId, AbortSignal.timeout(10_000)).then(r => { if (r.state === 'READY' && schoolRef.current === c.schoolId) setZone({ schoolId: c.schoolId, timezone: r.clock.schoolTimezone }); }); }
  }); }
  async function open(id: string) { await run(async () => {
    setSelected(null); resetDraft(initial(context?.principalId)); const r = await readFollowUp(id);
    if (!context || r.schoolId !== context.schoolId) throw new Error('School changed. Reload the authorized queue.');
    choose(r);
  }); }
  async function submit(op: FollowUpOperation, id: string | null, input: FollowUpInput | FollowUpTransition) {
    const fingerprint = followUpFingerprint({op,id,input});
    if (retry.current?.fingerprint !== fingerprint) retry.current = { fingerprint,key:crypto.randomUUID(),op,id,input:structuredClone(input) };
    setUncertain(true); const saved = await mutateFollowUp(op,id,input,retry.current.key);
    if (!context || saved.schoolId !== context.schoolId) throw new Error('School changed. No save assumed; reload current records.');
    setUncertain(false); setNeedsRefresh(true); setSelected(saved); resetDraft(fields(saved));
    // Do not synthesize list results or pretend a replay is the current version.
    setContext({...context,items:context.items.filter(r => r.followUpId !== saved.followUpId)});
    setNotice(`Verified saved version ${saved.version}: ${saved.status}. No outreach sent. Reload current detail before further edits; retries may return an older saved version.`);
  }
  async function save(e: FormEvent) { e.preventDefault(); await run(async () => {
    let input = draft;
    if (tz && dueEdit !== null) {
      if (dueEdit === '') input = { ...draft, dueAt: null };
      else { const z = schoolLocalToInstant(dueEdit, tz); if (z.state !== 'OK') throw new Error(z.state === 'NONEXISTENT' ? 'That school time is skipped by a daylight-saving change. Choose another time; nothing was saved.' : 'Enter a valid school date and time; nothing was saved.'); input = { ...draft, dueAt: z.instant }; }
    }
    await submit(selected ? 'UPDATE':'CREATE',selected?.followUpId ?? null,input);
  }); }
  return <main className={styles.page}>
    <nav><a href="/staff/dashboard">School dashboard</a><a href="/staff/search">Staff search</a><a href="/auth/login">Sign in</a></nav>
    <header><p>HUMAN CRM · ESSENTIAL / CORE / COMPLETE</p><h1>CRM follow-ups</h1><p>Your next human step, kept in one place. A lead ID handoff remains an untrusted local draft until this page explicitly loads its authorized queue.</p></header>
    <aside><strong>Records only. No automated outreach.</strong><p>{CRM_FOLLOW_UP_HELP}</p><p>Permissions: crm.follow_up.self_manage for your current assignments; crm.follow_up.manage for team records and assigning other known eligible staff. Both require exact school crm.lead.read. No staff directory or external recipients.</p></aside>
    <section><h2>Authorized school queue</h2><div className={styles.row}><label>Queue<select disabled={busy} value={queue} onChange={e => {pendingLeadId.current='';setQueue(e.target.value as 'mine'|'team');setContext(null);setSelected(null);resetDraft(initial());}}><option value="mine">My assignments</option><option value="team">Team · managers only</option></select></label><label>Status<select disabled={busy} value={status} onChange={e => {pendingLeadId.current='';setStatus(e.target.value as FollowUpStatus|'ALL');setContext(null);setSelected(null);resetDraft(initial());}}><option>OPEN</option><option>COMPLETED</option><option>CANCELLED</option><option>ALL</option></select></label><button disabled={busy} onClick={() => void load()}>Load / refresh queue</button></div><p>Up to 50 records per page, ordered by record ID. {tz ? `Due dates use school time (${tz}); they do not trigger work.` : 'Due dates use UTC; they do not trigger work.'} Queue content omits subject, private note and lead contact data.</p></section>
    {busy && <p role="status">Checking the current human school boundary…</p>}
    {error && <p role="alert" className={styles.error}>{error} No save is assumed after an uncertain response.</p>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {uncertain && retry.current && <aside><p>An unverified request is retained in memory for this page only. Changing fields is not a retry. No automatic resubmission.</p><button disabled={busy || !context} onClick={() => void run(async () => { const r = retry.current!; await submit(r.op,r.id,r.input); })}>Retry exact retained request</button></aside>}
    {context && <><section><h2>{context.queue === 'mine' ? 'My assignments':'School team records'}</h2><p>School {context.schoolId}. Signed-in staff {context.principalId}.</p><button disabled={busy} onClick={() => choose(null)}>New follow-up</button>
      {context.items.length === 0 && <p>No records on this page. Create a human follow-up or choose another status.</p>}
      <div className={styles.actions}>{context.items.map(r => <button key={r.followUpId} disabled={busy} onClick={() => void open(r.followUpId)}>{r.status} · {r.priority} · due {shown(r.dueAt)} · v{r.version}<br/>Lead {r.leadId}<br/>Assignee {r.assigneeId}</button>)}</div>
      {context.nextAfter && <button disabled={busy} onClick={() => void load(context.nextAfter)}>Next 50 records</button>}
      <form onSubmit={e => { e.preventDefault(); void open(knownId); }}><label>Already-known follow-up ID<input required value={knownId} onChange={e => setKnownId(e.target.value)} placeholder="Record UUID"/></label><button disabled={busy}>Load current detail</button></form>
    </section>
    {selected && <section><h2>Saved record · v{selected.version}</h2><p>{selected.followUpId} · {selected.status} · recorded {selected.recordedAt}</p><h3>{selected.subject}</h3><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{selected.note || 'No private note recorded.'}</p><p>Due {shown(selected.dueAt)} · {selected.priority}</p><p>Completed {selected.completedAt ?? '—'} · cancelled {selected.cancelledAt ?? '—'}</p><div className={styles.actions}><button disabled={busy} onClick={() => void open(selected.followUpId)}>Reload current detail</button>{(selected.status === 'OPEN' ? ['COMPLETE','CANCEL'] as const : ['REOPEN'] as const).map(op => <button key={op} disabled={busy || needsRefresh} onClick={() => void run(() => submit(op,selected.followUpId,{expectedVersion:selected.version}))}>{op === 'COMPLETE' ? 'Mark completed (record only)' : op === 'CANCEL' ? 'Cancel follow-up':'Reopen follow-up'}</button>)}</div><p>Managers can reopen inactive assignments, then reassign to a currently eligible known staff member. Inactive staff cannot access records themselves.</p></section>}
    {(!selected || selected.status === 'OPEN') && <section><h2>{selected ? 'Revise / reassign':'Create human follow-up'}</h2><p>Expected version {draft.expectedVersion}. Lead linkage cannot change after creation. Enter only IDs already known in this school; no contact details are fetched here.</p><form onSubmit={save}><fieldset disabled={busy || needsRefresh}><div className={styles.row}><label>Known lead ID<input required readOnly={!!selected} value={draft.leadId} onChange={e => edit({leadId:e.target.value})}/></label><label>Assignee staff ID<input required readOnly={!context.canManage} value={draft.assigneeId} onChange={e => edit({assigneeId:e.target.value})}/></label></div><label>Subject (private detail)<input required maxLength={120} value={draft.subject} onChange={e => edit({subject:e.target.value})}/></label><label>Private follow-up note<textarea maxLength={2000} rows={5} value={draft.note} onChange={e => edit({note:e.target.value})}/></label><div className={styles.row}>{tz ? <label data-testid="due-time-basis">Due at school time · {tz} (optional)<input type="datetime-local" step="60" min="2000-01-01T00:00" max="2099-12-31T23:59" value={dueEdit ?? (draft.dueAt ? instantToSchoolLocal(draft.dueAt, tz) : '')} onChange={e => { setDueEdit(e.target.value); setNotice(''); }}/></label>
              : <label data-testid="due-time-basis">Due at UTC (optional)<input type="datetime-local" step="0.001" min="2000-01-01T00:00" max="2099-12-31T23:59:59.999" value={draft.dueAt?.slice(0,-1) ?? ''} onChange={e => edit({dueAt:e.target.value ? new Date(`${e.target.value}Z`).toISOString():null})}/></label>}<label>Priority<select value={draft.priority} onChange={e => edit({priority:e.target.value as FollowUpInput['priority']})}><option>LOW</option><option>NORMAL</option><option>HIGH</option></select></label></div><button type="submit">{selected ? 'Save revision':'Create follow-up record'}</button></fieldset></form></section>}
    </>}
  </main>;
}
