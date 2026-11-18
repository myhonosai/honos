'use client';
import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { type FollowUpInput, type FollowUpRecord, type FollowUpQueue, type FollowUpQueueItem, type FollowUpStatus, type FollowUpOperation, type FollowUpTransition } from '@hon/contracts';
import { loadFollowUps, readFollowUp, mutateFollowUp, followUpFingerprint, FollowUpAccessError } from './crm-follow-ups-http';
import { crmFollowUpLeadId } from './crm-follow-up-handoff';
import { formatInSchool, instantToSchoolLocal, readSessionSchoolClock, schoolLocalToInstant } from './school-time';
import { useShellSchool } from './school-shell/page-school';
import { IdFields, LeadPicker, StaffPicker, leadLabel, type ListState } from './school-pickers/pickers';
import styles from './staff-availability-workbench.module.css';
const initial = (assigneeId = '', leadId = ''): FollowUpInput => ({ expectedVersion: 0, leadId, assigneeId, subject: '', note: '', dueAt: null, priority: 'NORMAL' });
const fields = (r: FollowUpRecord): FollowUpInput => ({ expectedVersion:r.version,leadId:r.leadId,assigneeId:r.assigneeId,subject:r.subject,note:r.note,dueAt:r.dueAt,priority:r.priority });
export const FOLLOW_UP_STATUS: Record<FollowUpStatus, string> = { OPEN: 'Open', COMPLETED: 'Completed', CANCELLED: 'Cancelled' };
const PRIORITY: Record<FollowUpInput['priority'], string> = { LOW: 'Low priority', NORMAL: 'Normal priority', HIGH: 'High priority' };
type Names = { leads: ReadonlyMap<string, string>; staff: ReadonlyMap<string, string> };
/** A queue row in words: lead and assignee by name from the school's pick lists, never by record ID. */
export function followUpRowText(r: FollowUpQueueItem, me: string, names: Names, shown: (instant: string | null) => string): { title: string; lead: string; assignee: string } {
  return { title: `${FOLLOW_UP_STATUS[r.status]} · ${PRIORITY[r.priority]} · due ${shown(r.dueAt)}`,
    lead: names.leads.get(r.leadId) ?? 'Lead not in the open list',
    assignee: r.assigneeId === me ? 'You' : names.staff.get(r.assigneeId) ?? 'A teammate' };
}
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
  const [names,setNames] = useState<Names>({ leads: new Map(), staff: new Map() });
  const [leadList,setLeadList] = useState<ListState<unknown>['state']>('LOADING'), [staffList,setStaffList] = useState<ListState<unknown>['state']>('LOADING');
  // Pick lists only for the shell's verified school, and only when it is the school the queue came from.
  const shell = useShellSchool(), pickScope = shell && context && shell.schoolId === context.schoolId ? shell : null;
  const manualLead = !pickScope || leadList === 'DENIED' || leadList === 'UNAVAILABLE', manualStaff = !pickScope || staffList === 'DENIED' || staffList === 'UNAVAILABLE';
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- open on the signed-in school right away
  async function run(work: () => Promise<void>) { setBusy(true); setError(''); setNotice(''); try { await work(); } catch (e) { if (e instanceof FollowUpAccessError) { pendingLeadId.current=''; schoolRef.current=''; setZone(null); setContext(null); setSelected(null); resetDraft(initial()); } setError(e instanceof Error ? e.message : 'Nothing could be confirmed.'); } finally { setBusy(false); } }
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
    if (!context || r.schoolId !== context.schoolId) throw new Error('School changed. Refresh the list.');
    choose(r);
  }); }
  async function submit(op: FollowUpOperation, id: string | null, input: FollowUpInput | FollowUpTransition) {
    const fingerprint = followUpFingerprint({op,id,input});
    if (retry.current?.fingerprint !== fingerprint) retry.current = { fingerprint,key:crypto.randomUUID(),op,id,input:structuredClone(input) };
    setUncertain(true); const saved = await mutateFollowUp(op,id,input,retry.current.key);
    if (!context || saved.schoolId !== context.schoolId) throw new Error('School changed. Nothing is assumed saved; refresh the list.');
    setUncertain(false); setNeedsRefresh(true); setSelected(saved); resetDraft(fields(saved));
    // Do not synthesize list results or pretend a replay is the current version.
    setContext({...context,items:context.items.filter(r => r.followUpId !== saved.followUpId)});
    setNotice(`Saved: ${FOLLOW_UP_STATUS[saved.status].toLowerCase()}. Nothing was sent to the lead. Reload current detail before editing again.`);
  }
  async function save(e: FormEvent) { e.preventDefault(); await run(async () => {
    let input = draft;
    if (tz && dueEdit !== null) {
      if (dueEdit === '') input = { ...draft, dueAt: null };
      else { const z = schoolLocalToInstant(dueEdit, tz); if (z.state !== 'OK') throw new Error(z.state === 'NONEXISTENT' ? 'That school time is skipped by a daylight-saving change. Choose another time; nothing was saved.' : 'Enter a valid school date and time; nothing was saved.'); input = { ...draft, dueAt: z.instant }; }
    }
    await submit(selected ? 'UPDATE':'CREATE',selected?.followUpId ?? null,input);
  }); }
  const leadName = (id: string) => names.leads.get(id) ?? (id ? 'Lead chosen on the lead page' : '');
  const leadInput = <label>Lead record ID<input required readOnly={!!selected} value={draft.leadId} onChange={e => edit({leadId:e.target.value})}/></label>;
  const staffInput = <label>Staff record ID<input required value={draft.assigneeId} onChange={e => edit({assigneeId:e.target.value})}/></label>;
  const knownForm = <form onSubmit={e => { e.preventDefault(); void open(knownId); }}><label>Follow-up record ID<input required value={knownId} onChange={e => setKnownId(e.target.value)}/></label><button disabled={busy}>Open</button></form>;
  return <main className={styles.page}>
    <nav><a href="/staff/dashboard">School dashboard</a><a href="/staff/search">Staff search</a><a href="/auth/login">Sign in</a></nav>
    <header><p>Leads</p><h1>Follow-ups</h1><p>Your next step with each lead, kept in one place.</p></header>
    <aside data-plain-note=""><strong>Follow-ups are reminders for your team. Nothing is sent to leads automatically.</strong></aside>
    <section><h2>Show</h2><div className={styles.row}><label>Whose<select disabled={busy} value={queue} onChange={e => {pendingLeadId.current='';setQueue(e.target.value as 'mine'|'team');setContext(null);setSelected(null);resetDraft(initial());}}><option value="mine">Mine</option><option value="team">Whole team (managers)</option></select></label><label>Status<select disabled={busy} value={status} onChange={e => {pendingLeadId.current='';setStatus(e.target.value as FollowUpStatus|'ALL');setContext(null);setSelected(null);resetDraft(initial());}}><option value="OPEN">Open</option><option value="COMPLETED">Completed</option><option value="CANCELLED">Cancelled</option><option value="ALL">All</option></select></label><button disabled={busy} onClick={() => void load()}>Refresh</button></div><p>{tz ? `Due dates use school time (${tz}).` : 'Due dates use UTC.'} Due dates are for planning and do not send anything.</p></section>
    {busy && <p role="status">Working…</p>}
    {error && <p role="alert" className={styles.error}>{error} No save is assumed until the page confirms it.</p>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {uncertain && retry.current && <aside><p>The last save was not confirmed. Retry sends the same request again; changing fields does not.</p><button disabled={busy || !context} onClick={() => void run(async () => { const r = retry.current!; await submit(r.op,r.id,r.input); })}>Retry exact retained request</button></aside>}
    {context && <><section><h2>{context.queue === 'mine' ? 'My follow-ups':'Team follow-ups'}</h2><button disabled={busy} onClick={() => choose(null)}>New follow-up</button>
      {context.items.length === 0 && <p>No records on this page. Create a follow-up or choose another status.</p>}
      <div className={styles.actions}>{context.items.map(r => { const row = followUpRowText(r, context.principalId, names, shown); return <button key={r.followUpId} disabled={busy} onClick={() => void open(r.followUpId)}>{row.title}<br/>Lead: {row.lead}<br/>Assigned to: {row.assignee}</button>; })}</div>
      {context.nextAfter && <button disabled={busy} onClick={() => void load(context.nextAfter)}>Next 50 records</button>}
      <IdFields manual={false}>{knownForm}</IdFields>
    </section>
    {selected && <section><h2>{FOLLOW_UP_STATUS[selected.status]} follow-up</h2><h3>{selected.subject}</h3><p>Lead: {leadName(selected.leadId) || 'Lead not in the open list'} · Assigned to: {selected.assigneeId === context.principalId ? 'You' : names.staff.get(selected.assigneeId) ?? 'A teammate'}</p><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{selected.note || 'No private note.'}</p><p>Due {shown(selected.dueAt)} · {PRIORITY[selected.priority]}</p>{selected.completedAt && <p>Completed {shown(selected.completedAt)}</p>}{selected.cancelledAt && <p>Cancelled {shown(selected.cancelledAt)}</p>}<div className={styles.actions}><button disabled={busy} onClick={() => void open(selected.followUpId)}>Reload current detail</button>{(selected.status === 'OPEN' ? ['COMPLETE','CANCEL'] as const : ['REOPEN'] as const).map(op => <button key={op} disabled={busy || needsRefresh} onClick={() => void run(() => submit(op,selected.followUpId,{expectedVersion:selected.version}))}>{op === 'COMPLETE' ? 'Mark completed' : op === 'CANCEL' ? 'Cancel follow-up':'Reopen follow-up'}</button>)}</div>{context.canManage && <p>To hand a follow-up to someone else, reopen it if needed, then reassign it below.</p>}</section>}
    {(!selected || selected.status === 'OPEN') && <section><h2>{selected ? 'Edit or reassign':'New follow-up'}</h2>{selected && <p>The lead cannot change after the follow-up is created.</p>}<form onSubmit={save}><fieldset disabled={busy || needsRefresh}><div className={styles.row}>
      {selected ? <p>Lead: {leadName(draft.leadId) || 'Lead not in the open list'}</p> : <>{pickScope && <LeadPicker scope={pickScope} value={draft.leadId} disabled={busy} onState={setLeadList} onItems={items => setNames(n => ({ ...n, leads: new Map([...n.leads, ...items.map(l => [l.id, leadLabel(l)] as const)]) }))} onPick={lead => edit({leadId: lead?.id ?? ''})}/>}{pickScope && !manualLead && draft.leadId && !names.leads.has(draft.leadId) && <p>{leadName(draft.leadId)}</p>}{manualLead ? leadInput : <IdFields manual={false}>{leadInput}</IdFields>}</>}
      {context.canManage ? <>{pickScope && <StaffPicker scope={pickScope} purpose="followups" label="Assign to" value={draft.assigneeId} disabled={busy} onState={setStaffList} onItems={items => setNames(n => ({ ...n, staff: new Map([...n.staff, ...items.map(s => [s.principalId, s.displayName] as const)]) }))} onPick={person => edit({assigneeId: person?.principalId ?? ''})}/>}{manualStaff ? staffInput : <IdFields manual={false}>{staffInput}</IdFields>}</>
        : <p>Assigned to: {draft.assigneeId === context.principalId ? 'You' : names.staff.get(draft.assigneeId) ?? 'A teammate'}</p>}
    </div><label>Subject (private detail)<input required maxLength={120} value={draft.subject} onChange={e => edit({subject:e.target.value})}/></label><label>Private follow-up note<textarea maxLength={2000} rows={5} value={draft.note} onChange={e => edit({note:e.target.value})}/></label><div className={styles.row}>{tz ? <label data-testid="due-time-basis">Due at school time · {tz} (optional)<input type="datetime-local" step="60" min="2000-01-01T00:00" max="2099-12-31T23:59" value={dueEdit ?? (draft.dueAt ? instantToSchoolLocal(draft.dueAt, tz) : '')} onChange={e => { setDueEdit(e.target.value); setNotice(''); }}/></label>
              : <label data-testid="due-time-basis">Due at UTC (optional)<input type="datetime-local" step="0.001" min="2000-01-01T00:00" max="2099-12-31T23:59:59.999" value={draft.dueAt?.slice(0,-1) ?? ''} onChange={e => edit({dueAt:e.target.value ? new Date(`${e.target.value}Z`).toISOString():null})}/></label>}<label>Priority<select value={draft.priority} onChange={e => edit({priority:e.target.value as FollowUpInput['priority']})}><option value="LOW">Low</option><option value="NORMAL">Normal</option><option value="HIGH">High</option></select></label></div><button type="submit">{selected ? 'Save changes':'Create follow-up'}</button></fieldset></form></section>}
    </>}
  </main>;
}
