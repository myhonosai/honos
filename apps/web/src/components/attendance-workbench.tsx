'use client';

import React, { useRef, useState, type FormEvent } from 'react';
import {
  ATTENDANCE_CATEGORIES,
  ATTENDANCE_STATUSES,
  ATTENDANCE_WEIGHT_MAX,
  type AttendanceCategory,
  type AttendanceCategoryPolicy,
  type AttendanceProgressionPolicy,
  type AttendanceRecordSummary,
  type AttendanceStatus,
  type ConfigureAttendancePolicyInput,
  type RecordAttendanceInput,
} from '@hon/contracts';
import {
  AttendanceWorkbenchUiError,
  attendancePaths,
  loadAttendancePolicy,
  loadExactAttendanceRecord,
  loadProgramAttendancePolicy,
  loadRosterAttendance,
  saveAttendancePolicy,
  saveAttendanceRecord,
  saveProgramAttendancePolicy,
  saveRosterAttendance,
  validateAttendancePolicyInput,
  validateAttendanceRecordInput,
  type AttendanceKnownScope,
} from './attendance-workbench-http';
import styles from './attendance-workbench.module.css';
import { useShellSchoolInto } from './school-shell/page-school';
import { IdFields } from './school-pickers/pickers';
import { CheckInPanel } from './attendance-check-in/check-in';
import { ClassChoice, ProgramChoice, StudentChoice, browserToday, type Choice, type ChoiceState } from './attendance-correction-pickers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type RecordDraft = { status: AttendanceStatus | ''; category: AttendanceCategory | ''; note: string };
type RetainedCommand = { fingerprint: string; key: string };
export type AttendanceInitialScope = { organizationId?: string | undefined; schoolId?: string | undefined };

const blankScope = (initialScope: AttendanceInitialScope = {}): AttendanceKnownScope => ({ organizationId: initialScope.organizationId ?? '', schoolId: initialScope.schoolId ?? '', programId: '', sessionId: '', studentProfileId: '' });
const blankRecord = (): RecordDraft => ({ status: '', category: '', note: '' });
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

function validScope(scope: AttendanceKnownScope): boolean {
  return [scope.organizationId, scope.schoolId, scope.programId, scope.sessionId, scope.studentProfileId].every(value => UUID.test(value));
}
/** Inside the shell a record needs only the class and student, and the rules only the program. */
const recordReadyIn = (scope: AttendanceKnownScope) => [scope.organizationId, scope.schoolId, scope.sessionId, scope.studentProfileId].every(value => UUID.test(value));
const policyReadyIn = (scope: AttendanceKnownScope) => [scope.organizationId, scope.schoolId, scope.programId].every(value => UUID.test(value));
type Names = { program: string; session: string; student: string };
const NO_NAMES: Names = { program: '', session: '', student: '' };

/** A prompt to the person, shown as written (nothing was sent). */
class Ask extends Error {}
/** Plain words for a refused or unknown result inside the shell. */
function shellErrorOf(reason: unknown): string {
  if (reason instanceof Ask) return reason.message;
  const status = reason instanceof AttendanceWorkbenchUiError ? reason.status : 0;
  if (status === 401) return 'Your sign-in has ended. Sign in again to continue.';
  if (status === 403) return 'Your access does not include this at this school. Nothing was changed.';
  if (status === 404) return 'That program, class or student is not available at this school. Nothing was changed.';
  if (status === 409) return 'This changed since it was loaded. Load it again, then make your change.';
  return 'We could not confirm the result. Try again: the same change is sent safely and is never saved twice.';
}

function policyDraftOf(policy: AttendanceProgressionPolicy): AttendanceCategoryPolicy[] {
  const byCategory = new Map(policy.categories.map(rule => [rule.category, rule]));
  return ATTENDANCE_CATEGORIES.map(category => {
    const rule = byCategory.get(category);
    if (!rule) throw new Error('The loaded policy did not include all seven attendance category rules.');
    return { ...rule };
  });
}

function recordDraftOf(record: AttendanceRecordSummary | null): RecordDraft {
  return record ? { status: record.status, category: record.category, note: record.note ?? '' } : blankRecord();
}

/** Inside the shell the exact-record and policy tools are an advanced, collapsed section under the roster link. */
function AdvancedAttendance({ inShell, children }: { inShell: boolean; children?: React.ReactNode }): React.ReactElement {
  return inShell ? <details className={styles.advanced}><summary>Advanced: correct one exact record or set attendance rules for a program</summary>{children}</details> : <>{children}</>;
}

export function AttendanceWorkbench({ initialScope = {} }: { initialScope?: AttendanceInitialScope } = {}): React.ReactElement {
  const [scope, setScope] = useState<AttendanceKnownScope>(() => blankScope(initialScope));
  const shellSchool = useShellSchoolInto(school => setScope(current => ({ ...current, organizationId: school.organizationId, schoolId: school.schoolId })));
  const [policy, setPolicy] = useState<AttendanceProgressionPolicy | null>(null);
  const [policyDraft, setPolicyDraft] = useState<AttendanceCategoryPolicy[]>([]);
  const [record, setRecord] = useState<AttendanceRecordSummary | null>(null);
  const [recordChecked, setRecordChecked] = useState(false);
  const [recordDraft, setRecordDraft] = useState<RecordDraft>(blankRecord);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const retries = useRef(new Map<string, RetainedCommand>());
  const [classDate, setClassDate] = useState(browserToday);
  const [names, setNames] = useState<Names>(NO_NAMES);
  const [lists, setLists] = useState<Record<'program' | 'session' | 'student', ChoiceState>>({ program: 'LOADING', session: 'LOADING', student: 'LOADING' });
  const [schoolTimeZone, setSchoolTimeZone] = useState('');
  const inShell = Boolean(shellSchool);

  function clearLoaded(): void {
    setPolicy(null);
    setPolicyDraft([]);
    setRecord(null);
    setRecordChecked(false);
    setRecordDraft(blankRecord());
    retries.current.clear();
  }

  /** Shell pickers clear only their own section: a program change keeps a loaded record, a class or student change keeps loaded rules. */
  function clearSection(section: 'policy' | 'record'): void {
    if (section === 'policy') { setPolicy(null); setPolicyDraft([]); }
    else { setRecord(null); setRecordChecked(false); setRecordDraft(blankRecord()); }
    for (const slot of [...retries.current.keys()]) if (slot.startsWith(`${section}:`)) retries.current.delete(slot);
  }

  function changeScope(field: keyof AttendanceKnownScope, value: string): void {
    clearLoaded();
    setNotice('');
    setError('');
    setScope(current => ({ ...current, [field]: value.trim().toLowerCase() }));
    if (field === 'programId' || field === 'sessionId' || field === 'studentProfileId') setNames(current => ({ ...current, [field === 'programId' ? 'program' : field === 'sessionId' ? 'session' : 'student']: '' }));
  }

  /** Shell pickers: a picked class clears the student; a picked student or program loads its current record or rules. */
  function choose(field: 'programId' | 'sessionId' | 'studentProfileId', choice: Choice | null): void {
    const value = choice?.id.toLowerCase() ?? '';
    const next: AttendanceKnownScope = { ...scope, [field]: value, ...(field === 'sessionId' ? { studentProfileId: '' } : {}) };
    clearSection(field === 'programId' ? 'policy' : 'record');
    setNotice('');
    setError('');
    setScope(next);
    const label = choice?.label ?? '';
    setNames(current => field === 'programId' ? { ...current, program: label } : field === 'sessionId' ? { ...current, session: label, student: '' } : { ...current, student: label });
    if (field === 'studentProfileId' && recordReadyIn(next)) void run(() => loadRecord(next, label));
    if (field === 'programId' && policyReadyIn(next)) void run(() => loadPolicy(next, label));
  }

  function changeDate(value: string): void {
    setClassDate(value);
    choose('sessionId', null);
  }

  function retainedKey(slot: string, body: ConfigureAttendancePolicyInput | RecordAttendanceInput): string {
    const fingerprint = canonical(body);
    const retained = retries.current.get(slot);
    if (!retained || retained.fingerprint !== fingerprint) {
      const next = { fingerprint, key: crypto.randomUUID() };
      retries.current.set(slot, next);
      return next.key;
    }
    return retained.key;
  }

  async function run(work: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (reason) {
      if (reason instanceof AttendanceWorkbenchUiError && [401, 403].includes(reason.status)) clearLoaded();
      setError(inShell ? shellErrorOf(reason) : `${reason instanceof Error ? reason.message : 'Attendance workbench unavailable.'} No success, credit, progression, or authorization outcome is assumed.`);
    } finally {
      setBusy(false);
    }
  }

  async function loadPolicy(target: AttendanceKnownScope = scope, programName: string = names.program): Promise<void> {
    if (inShell ? !policyReadyIn(target) : !validScope(target)) throw new (inShell ? Ask : Error)(inShell ? 'Choose a program first.' : 'Enter all five exact already-known UUIDs before loading a policy.');
    setPolicy(null);
    setPolicyDraft([]);
    const loaded = inShell ? await loadProgramAttendancePolicy(target) : await loadAttendancePolicy(target);
    setPolicy(loaded);
    setPolicyDraft(policyDraftOf(loaded));
    setNotice(inShell ? `Loaded the attendance rules for ${programName || 'this program'}.` : `Verified attendance policy for returned program ${loaded.programId}, version ${loaded.version}, with all seven category rules loaded.`);
  }

  async function loadRecord(target: AttendanceKnownScope = scope, studentName: string = names.student): Promise<void> {
    if (inShell ? !recordReadyIn(target) : !validScope(target)) throw new (inShell ? Ask : Error)(inShell ? 'Choose a class and a student first.' : 'Enter all five exact already-known UUIDs before looking up an attendance record.');
    setRecord(null);
    setRecordChecked(false);
    setRecordDraft(blankRecord());
    const loaded = inShell ? await loadRosterAttendance(target) : await loadExactAttendanceRecord(target);
    setRecord(loaded);
    setRecordChecked(true);
    setRecordDraft(recordDraftOf(loaded));
    const who = studentName || 'This student';
    setNotice(inShell
      ? (loaded ? `Loaded ${who === 'This student' ? 'this student’s' : `${who}’s`} attendance for this class. Change it below.` : `${who} has no attendance recorded for this class yet. You can record it below.`)
      : loaded
        ? `Verified attendance record v${loaded.version} for the returned exact session/student pair.`
        : 'Verified empty state: no attendance record exists for this exact known session/student pair.');
  }

  async function savePolicy(): Promise<void> {
    if (!policy) throw new (inShell ? Ask : Error)(inShell ? 'Load the program’s rules first.' : 'Load the exact current attendance policy before editing it.');
    const input: ConfigureAttendancePolicyInput = {
      expectedVersion: policy.version,
      categories: ATTENDANCE_CATEGORIES.map(category => {
        const rule = policyDraft.find(candidate => candidate.category === category);
        if (!rule) throw new Error('Keep all seven category rules in the policy command.');
        return { category, operationalAllowed: rule.operationalAllowed, progressionEnabled: rule.progressionEnabled, weightMilli: rule.weightMilli };
      }),
    };
    validateAttendancePolicyInput(input);
    const slot = inShell ? `policy:${scope.organizationId}/${scope.schoolId}/${scope.programId}` : `policy:${attendancePaths.policy(scope)}`;
    const result = inShell ? await saveProgramAttendancePolicy(scope, input, retainedKey(slot, input)) : await saveAttendancePolicy(scope, input, retainedKey(slot, input));
    retries.current.delete(slot);
    setPolicy(result.policy);
    setPolicyDraft(policyDraftOf(result.policy));
    if (inShell) { setNotice(`Saved the attendance rules for ${names.program || 'this program'}.`); return; }
    setNotice(`Verified policy v${result.policy.version}${result.replayed ? ' replay receipt' : ' saved'}. Returned program and all seven category rules were checked. This is nonfinancial and does not auto-progress or pass anyone.`);
  }

  async function saveRecord(): Promise<void> {
    if (!recordChecked) throw new (inShell ? Ask : Error)(inShell ? 'Choose a class and a student first.' : 'Load the current exact session/student record first.');
    if (!recordDraft.status || !recordDraft.category) throw new (inShell ? Ask : Error)(inShell ? 'Choose a status and a category.' : 'Select one closed-set attendance status and one closed-set category.');
    const input: RecordAttendanceInput = {
      studentProfileId: scope.studentProfileId,
      status: recordDraft.status,
      category: recordDraft.category,
      note: recordDraft.note.trim(),
      ...(record ? { expectedVersion: record.version } : {}),
    };
    validateAttendanceRecordInput(input);
    const slot = inShell ? `record:${scope.organizationId}/${scope.schoolId}/${scope.sessionId}/${scope.studentProfileId}` : `record:${attendancePaths.record(scope)}`;
    const result = inShell ? await saveRosterAttendance(scope, input, retainedKey(slot, input)) : await saveAttendanceRecord(scope, input, retainedKey(slot, input));
    retries.current.delete(slot);
    setRecord(result.attendance);
    setRecordChecked(true);
    setRecordDraft(recordDraftOf(result.attendance));
    if (inShell) { setNotice(`Saved ${names.student ? `${names.student}’s` : 'this'} attendance.`); return; }
    setNotice(`Verified attendance record v${result.attendance.version}${result.replayed ? ' replay receipt' : ' saved'} for the returned exact pair. Its category and policy/credit snapshot are display facts only; no pass or automatic progression occurred.`);
  }

  const setRule = (category: AttendanceCategory, patch: Partial<AttendanceCategoryPolicy>) => {
    setPolicyDraft(current => current.map(rule => rule.category === category ? { ...rule, ...patch } : rule));
  };

  const scopeReady = validScope(scope);
  const recordReady = inShell ? recordReadyIn(scope) : scopeReady;
  const policyReady = inShell ? policyReadyIn(scope) : scopeReady;
  const failed = (state: ChoiceState) => state === 'DENIED' || state === 'UNAVAILABLE';
  const reportList = (list: keyof typeof lists) => (state: ChoiceState) => setLists(current => current[list] === state ? current : { ...current, [list]: state });
  const idInput = (field: keyof AttendanceKnownScope, label: string) => <label key={field}>{label}<input value={scope[field]} disabled={busy} autoComplete="off" maxLength={36} placeholder="Exact known UUID; not a search" onChange={event => changeScope(field, event.target.value)} /></label>;
  return <main className={styles.page}>
    <nav aria-label="Staff navigation"><a href="/staff/dashboard">School dashboard</a><a href="/staff/attendance/planned-absences">Planned absence review</a><a href="/staff/team/availability">Availability</a><a href="/staff/instructor-qualifications">Qualifications</a><a href="/staff/roles">Roles</a><a href="/auth/login">Sign in</a></nav>
    {shellSchool ? <><header><h1>Attendance</h1></header><CheckInPanel scope={shellSchool} /><p>To mark a whole class at once (Present, Late, Excused or Absent), <a href="/staff/schedule">open the class in the schedule</a>.</p></>
      : <header><p>Attendance</p><h1>Attendance</h1><p>Record who was at class and set each program’s attendance rules.</p></header>}
    <AdvancedAttendance inShell={inShell}>
    <aside data-plain-note=""><strong>Attendance is a record only. It does not decide promotion, testing or progress.</strong></aside>
    {busy && <p role="status">{inShell ? 'Loading…' : 'Checking the current exact human-staff scope and requested attendance fact…'}</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}

    {shellSchool ? <section>
      <h2>Record to correct</h2>
      <p>Choose the day, the class and the student whose attendance you want to correct.</p>
      <div className={styles.scopeGrid}>
        <label>Class date<input type="date" value={classDate} disabled={busy} onChange={event => changeDate(event.target.value)} /></label>
        <ClassChoice scope={shellSchool} date={classDate} value={scope.sessionId} disabled={busy} onPick={choice => choose('sessionId', choice)} onState={reportList('session')} onTimeZone={setSchoolTimeZone} />
        {UUID.test(scope.sessionId) && <StudentChoice scope={shellSchool} sessionId={scope.sessionId} value={scope.studentProfileId} disabled={busy} onPick={choice => choose('studentProfileId', choice)} onState={reportList('student')} />}
      </div>
      <IdFields manual={failed(lists.session) || failed(lists.student)}><div className={styles.scopeGrid}>{idInput('sessionId', 'Class ID')}{idInput('studentProfileId', 'Student ID')}</div></IdFields>
    </section> : <section>
      <h2>1 / Exact already-known scope</h2>
      <p>Enter the five UUIDs you already know. A verified dashboard or Command Center may prefill only the organization and school selectors as untrusted URL values; it grants no authority and does not load anything. Program, class session, and student profile always start blank and must be manually entered as already-known IDs. There is no directory, name search, freeform route, query authority, parent access, HQ access, or AI selector. Changing any selector clears loaded policy, current record, command result, and retained retry keys.</p>
      <div className={styles.scopeGrid}>
        {([
          ['organizationId', 'Organization UUID'], ['schoolId', 'School UUID'], ['programId', 'Program UUID'], ['sessionId', 'Class session UUID'], ['studentProfileId', 'Student profile UUID'],
        ] as Array<[keyof AttendanceKnownScope, string]>).map(([field, label]) => idInput(field, label))}
      </div>
      <p>{scopeReady ? 'Five UUIDs are locally well-formed. The server remains authoritative for every human staff permission and tenant boundary.' : 'All five values must be exact UUIDs before any fixed-path request is enabled.'}</p>
    </section>}

    <section>
      {shellSchool ? <>
        <h2>Attendance rules for a program</h2>
        <p>Choose a program to see and change how each kind of attendance counts.</p>
        <ProgramChoice scope={shellSchool} value={scope.programId} disabled={busy} onPick={choice => choose('programId', choice)} onState={reportList('program')} />
        <IdFields manual={failed(lists.program)}>{idInput('programId', 'Program ID')}<div className={styles.actions}><button type="button" disabled={busy || !policyReady} onClick={() => void run(loadPolicy)}>Load rules</button></div></IdFields>
        {policy && <div className={styles.actions}><button type="button" disabled={busy} onClick={() => void run(loadPolicy)}>Reload rules</button></div>}
      </> : <>
        <h2>2 / Load and maintain a program attendance policy</h2>
        <p>Load is required before editing. A policy command sends the loaded expected version, every one of the seven rules, and a generated idempotency key. The same retry key is retained only while the command body stays unchanged.</p>
        <div className={styles.actions}><button type="button" disabled={busy || !policyReady} onClick={() => void run(loadPolicy)}>Load exact program policy</button>{policy && <button type="button" disabled={busy} onClick={() => void run(loadPolicy)}>Refresh loaded policy</button>}</div>
        {!policy && <p className={styles.empty}>No policy is loaded. Policy editing is intentionally blocked until the returned program policy has been verified.</p>}
      </>}
      {policy && <>
        {shellSchool ? <div className={styles.record}><p><strong>Program:</strong> {names.program || 'Entered by ID'}</p></div>
          : <div className={styles.record}><p><strong>Verified returned program:</strong> {policy.programId}</p><p><strong>Verified policy version:</strong> {policy.version}</p><p><strong>Closed rule count:</strong> {policy.categories.length} of 7 categories</p></div>}
        <form onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void run(savePolicy); }}>
          <fieldset disabled={busy}>
            <div className={styles.rules}>
              {ATTENDANCE_CATEGORIES.map(category => {
                const rule = policyDraft.find(candidate => candidate.category === category);
                if (!rule) return null;
                return <article className={styles.rule} key={category}><h3>{category}</h3><p>Fixed category; it cannot be added, removed, or renamed here.</p><label className={styles.check}><input type="checkbox" checked={rule.operationalAllowed} onChange={event => setRule(category, { operationalAllowed: event.target.checked })} />Operationally allowed</label><label className={styles.check}><input type="checkbox" checked={rule.progressionEnabled} onChange={event => setRule(category, { progressionEnabled: event.target.checked })} />Progression-enabled evidence flag</label><label>Nonfinancial weight (milli-classes)<input type="number" required min="0" max={ATTENDANCE_WEIGHT_MAX} step="1" value={rule.weightMilli} onChange={event => setRule(category, { weightMilli: event.target.value === '' ? -1 : Number(event.target.value) })} /></label></article>;
              })}
            </div>
            {shellSchool ? <p>Weights are whole numbers from 0 to 10000 (1000 counts as one class). These rules never promote or pass anyone on their own.</p>
              : <aside className={styles.warning}><strong>Operational evidence only — not money and not an automated decision.</strong><p>Weights are bounded whole numbers from 0 to 10000 in this browser; the server is authoritative. “Progression enabled” preserves a returned policy rule only. It does not calculate readiness, grant a pass, change a curriculum state, or auto-progress a student.</p></aside>}
            <button type="submit">{shellSchool ? 'Save rules' : <>Save seven-rule policy with version {policy.version}</>}</button>
          </fieldset>
        </form>
      </>}
    </section>

    <section>
      {shellSchool ? <>
        <h2>{names.student && names.session ? `${names.student} · ${names.session}` : 'Attendance record'}</h2>
        <div className={styles.actions}><button type="button" disabled={busy || !recordReady} onClick={() => void run(loadRecord)}>{recordChecked ? 'Reload attendance' : 'Load attendance'}</button></div>
        {!recordChecked && <p className={styles.empty}>Choose a class and a student above to see their attendance.</p>}
      </> : <>
        <h2>3 / Exact current attendance record</h2>
        <p>Lookup is limited to the known class session and known student profile pair. It does not list a roster, search students, infer booking/capacity, or claim a student can attend.</p>
        <div className={styles.actions}><button type="button" disabled={busy || !recordReady} onClick={() => void run(loadRecord)}>Load exact session/student record</button>{recordChecked && <button type="button" disabled={busy} onClick={() => void run(loadRecord)}>Refresh exact current record</button>}</div>
        {!recordChecked && <p className={styles.empty}>No current record lookup has completed. Recording is blocked until this exact pair is checked.</p>}
        {recordChecked && !record && <p className={styles.empty}>Verified empty state: no stored attendance record exists for this exact pair. This is not a booking, eligibility, schedule, or readiness conclusion.</p>}
      </>}
      {recordChecked && <form onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void run(saveRecord); }}>
        <fieldset disabled={busy}>
          <div className={styles.recordForm}>
            <label>Status<select required value={recordDraft.status} onChange={event => setRecordDraft(current => ({ ...current, status: event.target.value as AttendanceStatus | '' }))}><option value="" disabled>Select recorded status</option>{ATTENDANCE_STATUSES.map(status => <option key={status}>{status}</option>)}</select></label>
            <label>Category<select required value={recordDraft.category} onChange={event => setRecordDraft(current => ({ ...current, category: event.target.value as AttendanceCategory | '' }))}><option value="" disabled>Select one closed-set category</option>{ATTENDANCE_CATEGORIES.map(category => <option key={category}>{category}</option>)}</select></label>
            <label className={styles.note}>Staff note (optional, max 2000 characters)<textarea value={recordDraft.note} maxLength={2000} rows={4} onChange={event => setRecordDraft(current => ({ ...current, note: event.target.value }))} /></label>
          </div>
          {!shellSchool && <p>Expected version: {record ? <strong>{record.version} (returned by the current exact record)</strong> : 'no record exists, so this first-record command sends no expected version.'} A generated idempotency key accompanies this command; it is reused only for this unchanged body.</p>}
          <button type="submit">{shellSchool ? 'Save attendance' : 'Record exact attendance state'}</button>
        </fieldset>
      </form>}
      {record && shellSchool && <div className={styles.record}>
        <h3>Current attendance</h3>
        <dl>
          {Object.entries({
            Class: names.session || 'Entered by ID',
            Student: names.student || 'Entered by ID',
            Status: record.status,
            Category: record.category,
            'Recorded at': new Date(record.recordedAt).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', ...(schoolTimeZone ? { timeZone: schoolTimeZone } : {}) }),
            Note: record.note ?? 'No note',
          }).map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{value}</dd></React.Fragment>)}
        </dl>
      </div>}
      {record && !shellSchool && <div className={styles.record}>
        <h3>Verified returned attendance facts</h3>
        <dl>
          {Object.entries({
            'Attendance record': record.id,
            'Exact class session': record.classSessionId,
            'Exact student profile': record.studentProfileId,
            Status: record.status,
            Category: record.category,
            'Record version': record.version,
            'Policy snapshot version': record.progressionPolicyVersion,
            'Progression-enabled snapshot': String(record.progressionEnabled),
            'Progression weight snapshot (milli-classes)': record.progressionWeightMilli,
            'Progression credit snapshot (milli-classes)': record.progressionCreditMilli,
            'Recorded at': record.recordedAt,
            'Last updated': record.updatedAt,
            Note: record.note ?? 'not recorded',
          }).map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{value}</dd></React.Fragment>)}
        </dl>
        <p>These are returned record snapshots, not a current progress/readiness calculation, a pass credit, a promotion decision, or a payment/member/schedule result.</p>
      </div>}
    </section>
    </AdvancedAttendance>
  </main>;
}
