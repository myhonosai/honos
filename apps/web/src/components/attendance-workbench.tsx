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
  saveAttendancePolicy,
  saveAttendanceRecord,
  validateAttendancePolicyInput,
  validateAttendanceRecordInput,
  type AttendanceKnownScope,
} from './attendance-workbench-http';
import styles from './attendance-workbench.module.css';

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

export function AttendanceWorkbench({ initialScope = {} }: { initialScope?: AttendanceInitialScope } = {}): React.ReactElement {
  const [scope, setScope] = useState<AttendanceKnownScope>(() => blankScope(initialScope));
  const [policy, setPolicy] = useState<AttendanceProgressionPolicy | null>(null);
  const [policyDraft, setPolicyDraft] = useState<AttendanceCategoryPolicy[]>([]);
  const [record, setRecord] = useState<AttendanceRecordSummary | null>(null);
  const [recordChecked, setRecordChecked] = useState(false);
  const [recordDraft, setRecordDraft] = useState<RecordDraft>(blankRecord);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const retries = useRef(new Map<string, RetainedCommand>());

  function clearLoaded(): void {
    setPolicy(null);
    setPolicyDraft([]);
    setRecord(null);
    setRecordChecked(false);
    setRecordDraft(blankRecord());
    retries.current.clear();
  }

  function changeScope(field: keyof AttendanceKnownScope, value: string): void {
    clearLoaded();
    setNotice('');
    setError('');
    setScope(current => ({ ...current, [field]: value.trim().toLowerCase() }));
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
      setError(`${reason instanceof Error ? reason.message : 'Attendance workbench unavailable.'} No success, credit, progression, or authorization outcome is assumed.`);
    } finally {
      setBusy(false);
    }
  }

  async function loadPolicy(): Promise<void> {
    if (!validScope(scope)) throw new Error('Enter all five exact already-known UUIDs before loading a policy.');
    setPolicy(null);
    setPolicyDraft([]);
    const loaded = await loadAttendancePolicy(scope);
    setPolicy(loaded);
    setPolicyDraft(policyDraftOf(loaded));
    setNotice(`Verified attendance policy for returned program ${loaded.programId}, version ${loaded.version}, with all seven category rules loaded.`);
  }

  async function loadRecord(): Promise<void> {
    if (!validScope(scope)) throw new Error('Enter all five exact already-known UUIDs before looking up an attendance record.');
    setRecord(null);
    setRecordChecked(false);
    setRecordDraft(blankRecord());
    const loaded = await loadExactAttendanceRecord(scope);
    setRecord(loaded);
    setRecordChecked(true);
    setRecordDraft(recordDraftOf(loaded));
    setNotice(loaded
      ? `Verified attendance record v${loaded.version} for the returned exact session/student pair.`
      : 'Verified empty state: no attendance record exists for this exact known session/student pair.');
  }

  async function savePolicy(): Promise<void> {
    if (!policy) throw new Error('Load the exact current attendance policy before editing it.');
    const input: ConfigureAttendancePolicyInput = {
      expectedVersion: policy.version,
      categories: ATTENDANCE_CATEGORIES.map(category => {
        const rule = policyDraft.find(candidate => candidate.category === category);
        if (!rule) throw new Error('Keep all seven category rules in the policy command.');
        return { category, operationalAllowed: rule.operationalAllowed, progressionEnabled: rule.progressionEnabled, weightMilli: rule.weightMilli };
      }),
    };
    validateAttendancePolicyInput(input);
    const slot = `policy:${attendancePaths.policy(scope)}`;
    const result = await saveAttendancePolicy(scope, input, retainedKey(slot, input));
    retries.current.delete(slot);
    setPolicy(result.policy);
    setPolicyDraft(policyDraftOf(result.policy));
    setNotice(`Verified policy v${result.policy.version}${result.replayed ? ' replay receipt' : ' saved'}. Returned program and all seven category rules were checked. This is nonfinancial and does not auto-progress or pass anyone.`);
  }

  async function saveRecord(): Promise<void> {
    if (!recordChecked) throw new Error('Load the current exact session/student record first.');
    if (!recordDraft.status || !recordDraft.category) throw new Error('Select one closed-set attendance status and one closed-set category.');
    const input: RecordAttendanceInput = {
      studentProfileId: scope.studentProfileId,
      status: recordDraft.status,
      category: recordDraft.category,
      note: recordDraft.note.trim(),
      ...(record ? { expectedVersion: record.version } : {}),
    };
    validateAttendanceRecordInput(input);
    const slot = `record:${attendancePaths.record(scope)}`;
    const result = await saveAttendanceRecord(scope, input, retainedKey(slot, input));
    retries.current.delete(slot);
    setRecord(result.attendance);
    setRecordChecked(true);
    setRecordDraft(recordDraftOf(result.attendance));
    setNotice(`Verified attendance record v${result.attendance.version}${result.replayed ? ' replay receipt' : ' saved'} for the returned exact pair. Its category and policy/credit snapshot are display facts only; no pass or automatic progression occurred.`);
  }

  const setRule = (category: AttendanceCategory, patch: Partial<AttendanceCategoryPolicy>) => {
    setPolicyDraft(current => current.map(rule => rule.category === category ? { ...rule, ...patch } : rule));
  };

  const scopeReady = validScope(scope);
  return <main className={styles.page}>
    <nav aria-label="Staff navigation"><a href="/staff/dashboard">School dashboard</a><a href="/staff/attendance/planned-absences">Planned absence review</a><a href="/staff/team/availability">Availability</a><a href="/staff/instructor-qualifications">Qualifications</a><a href="/staff/roles">Roles</a><a href="/auth/login">Sign in</a></nav>
    <header><p>HUMAN STAFF / ATTENDANCE OPERATIONS</p><h1>Attendance workbench</h1><p>Record one exact known student attendance state for one exact known class session, and maintain one exact known program’s closed-set attendance policy.</p></header>
    <aside><strong>Conventional staff recordkeeping only.</strong><p>Each request uses existing server authorization, tenant RLS, category and policy-snapshot validation, plus audit/outbox evidence. This workbench has no Action Engine, AI, provider, payment, message, membership, capacity, schedule, or external-network path. It does not determine class eligibility, program suitability, readiness, progress, pass credit, or any automatic progression outcome.</p></aside>
    {busy && <p role="status">Checking the current exact human-staff scope and requested attendance fact…</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}

    <section>
      <h2>1 / Exact already-known scope</h2>
      <p>Enter the five UUIDs you already know. A verified dashboard or Command Center may prefill only the organization and school selectors as untrusted URL values; it grants no authority and does not load anything. Program, class session, and student profile always start blank and must be manually entered as already-known IDs. There is no directory, name search, freeform route, query authority, parent access, HQ access, or AI selector. Changing any selector clears loaded policy, current record, command result, and retained retry keys.</p>
      <div className={styles.scopeGrid}>
        {([
          ['organizationId', 'Organization UUID'], ['schoolId', 'School UUID'], ['programId', 'Program UUID'], ['sessionId', 'Class session UUID'], ['studentProfileId', 'Student profile UUID'],
        ] as Array<[keyof AttendanceKnownScope, string]>).map(([field, label]) => <label key={field}>{label}<input value={scope[field]} disabled={busy} autoComplete="off" maxLength={36} placeholder="Exact known UUID; not a search" onChange={event => changeScope(field, event.target.value)} /></label>)}
      </div>
      <p>{scopeReady ? 'Five UUIDs are locally well-formed. The server remains authoritative for every human staff permission and tenant boundary.' : 'All five values must be exact UUIDs before any fixed-path request is enabled.'}</p>
    </section>

    <section>
      <h2>2 / Load and maintain a program attendance policy</h2>
      <p>Load is required before editing. A policy command sends the loaded expected version, every one of the seven rules, and a generated idempotency key. The same retry key is retained only while the command body stays unchanged.</p>
      <div className={styles.actions}><button type="button" disabled={busy || !scopeReady} onClick={() => void run(loadPolicy)}>Load exact program policy</button>{policy && <button type="button" disabled={busy} onClick={() => void run(loadPolicy)}>Refresh loaded policy</button>}</div>
      {!policy && <p className={styles.empty}>No policy is loaded. Policy editing is intentionally blocked until the returned program policy has been verified.</p>}
      {policy && <>
        <div className={styles.record}><p><strong>Verified returned program:</strong> {policy.programId}</p><p><strong>Verified policy version:</strong> {policy.version}</p><p><strong>Closed rule count:</strong> {policy.categories.length} of 7 categories</p></div>
        <form onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void run(savePolicy); }}>
          <fieldset disabled={busy}>
            <div className={styles.rules}>
              {ATTENDANCE_CATEGORIES.map(category => {
                const rule = policyDraft.find(candidate => candidate.category === category);
                if (!rule) return null;
                return <article className={styles.rule} key={category}><h3>{category}</h3><p>Fixed category; it cannot be added, removed, or renamed here.</p><label className={styles.check}><input type="checkbox" checked={rule.operationalAllowed} onChange={event => setRule(category, { operationalAllowed: event.target.checked })} />Operationally allowed</label><label className={styles.check}><input type="checkbox" checked={rule.progressionEnabled} onChange={event => setRule(category, { progressionEnabled: event.target.checked })} />Progression-enabled evidence flag</label><label>Nonfinancial weight (milli-classes)<input type="number" required min="0" max={ATTENDANCE_WEIGHT_MAX} step="1" value={rule.weightMilli} onChange={event => setRule(category, { weightMilli: event.target.value === '' ? -1 : Number(event.target.value) })} /></label></article>;
              })}
            </div>
            <aside className={styles.warning}><strong>Operational evidence only — not money and not an automated decision.</strong><p>Weights are bounded whole numbers from 0 to 10000 in this browser; the server is authoritative. “Progression enabled” preserves a returned policy rule only. It does not calculate readiness, grant a pass, change a curriculum state, or auto-progress a student.</p></aside>
            <button type="submit">Save seven-rule policy with version {policy.version}</button>
          </fieldset>
        </form>
      </>}
    </section>

    <section>
      <h2>3 / Exact current attendance record</h2>
      <p>Lookup is limited to the known class session and known student profile pair. It does not list a roster, search students, infer booking/capacity, or claim a student can attend.</p>
      <div className={styles.actions}><button type="button" disabled={busy || !scopeReady} onClick={() => void run(loadRecord)}>Load exact session/student record</button>{recordChecked && <button type="button" disabled={busy} onClick={() => void run(loadRecord)}>Refresh exact current record</button>}</div>
      {!recordChecked && <p className={styles.empty}>No current record lookup has completed. Recording is blocked until this exact pair is checked.</p>}
      {recordChecked && !record && <p className={styles.empty}>Verified empty state: no stored attendance record exists for this exact pair. This is not a booking, eligibility, schedule, or readiness conclusion.</p>}
      {recordChecked && <form onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void run(saveRecord); }}>
        <fieldset disabled={busy}>
          <div className={styles.recordForm}>
            <label>Status<select required value={recordDraft.status} onChange={event => setRecordDraft(current => ({ ...current, status: event.target.value as AttendanceStatus | '' }))}><option value="" disabled>Select recorded status</option>{ATTENDANCE_STATUSES.map(status => <option key={status}>{status}</option>)}</select></label>
            <label>Category<select required value={recordDraft.category} onChange={event => setRecordDraft(current => ({ ...current, category: event.target.value as AttendanceCategory | '' }))}><option value="" disabled>Select one closed-set category</option>{ATTENDANCE_CATEGORIES.map(category => <option key={category}>{category}</option>)}</select></label>
            <label className={styles.note}>Staff note (optional, max 2000 characters)<textarea value={recordDraft.note} maxLength={2000} rows={4} onChange={event => setRecordDraft(current => ({ ...current, note: event.target.value }))} /></label>
          </div>
          <p>Expected version: {record ? <strong>{record.version} (returned by the current exact record)</strong> : 'no record exists, so this first-record command sends no expected version.'} A generated idempotency key accompanies this command; it is reused only for this unchanged body.</p>
          <button type="submit">Record exact attendance state</button>
        </fieldset>
      </form>}
      {record && <div className={styles.record}>
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
  </main>;
}
