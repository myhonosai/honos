'use client';
import React, { useEffect, useId, useState } from 'react';
import styles from './pickers.module.css';
import type { LeadListItem } from '@hon/contracts';
import { CrmLeadAccessError, loadCrmLeads } from '../crm-leads-http';
import { PickerError, pickerApi, type CandidatePurpose, type EnrollmentPurpose, type PickerCandidate, type PickerEnrollment, type PickerRank, type PickerScope, type PickerStaff, type PickerStudent, type PickerTestingEvent, type RankPurpose, type StaffPurpose, type StudentPurpose } from './http';

/**
 * Pick-from-list controls for curriculum, testing and promotion screens. Choosing a row only fills the screen's own
 * fields, which the screen then reads or submits as before; the server re-checks every record on each command.
 */
export type ListState<T> = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; items: readonly T[] };
type Copy = Readonly<{ label: string; choose: string; loading: string; empty: string; denied: string; search?: string; unavailable?: string }>;

const name = (r: { givenName: string; familyName: string }) => `${r.givenName} ${r.familyName}`;
export const studentLabel = (r: PickerStudent): string => name(r);
export const staffLabel = (r: PickerStaff): string => r.displayName;
export const rankLabel = (r: PickerRank): string => `${r.curriculumName} · ${r.rankName}`;
export function enrollmentLabel(r: PickerEnrollment, showNext: boolean): string {
  const rank = r.currentRankName ?? 'No rank yet';
  return [name(r), r.curriculumName, showNext && r.nextRankName ? `${rank} → ${r.nextRankName}` : rank].join(' · ');
}
export function testingEventLabel(r: PickerTestingEvent, language = 'en'): string {
  const when = new Date(r.startsAt).toLocaleDateString(language, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return [r.name, r.curriculumName, when, ({ DRAFT: 'Draft', OPEN: 'Open', CLOSED: 'Closed' } as Record<string, string>)[r.status] ?? r.status].join(' · ');
}
const RESULT: Record<string, string> = { PENDING: 'Not graded yet', PASSED: 'Passed', DEFERRED: 'Deferred', NOT_PASSED: 'Not passed' };
export function candidateLabel(r: PickerCandidate): string {
  return [name(r), r.testingEventName, `Testing for ${r.targetRankName}`, RESULT[r.result] ?? r.result].join(' · ');
}

/** Pure view: a status line, an optional search box and one select. Testable with static markup. */
export function PickListView<T>({ copy, list, keyOf, describe, value, search, disabled, onSearch, onPick }: {
  copy: Copy; list: ListState<T>; keyOf: (item: T) => string; describe: (item: T) => string; value: string; search?: string; disabled: boolean;
  onSearch?: (text: string) => void; onPick?: (item: T | null) => void;
}): React.ReactElement {
  const ids = { search: useId(), pick: useId() };
  if (list.state === 'DENIED') return <p role="status" data-picker="denied" className={styles.picker}>{copy.denied}</p>;
  return <div data-picker={list.state.toLowerCase()} className={styles.picker}>
    {copy.search !== undefined && <><label htmlFor={ids.search}>{copy.search}</label>
      <input id={ids.search} type="search" maxLength={120} autoComplete="off" value={search ?? ''} disabled={disabled} onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} onChange={(e) => onSearch?.(e.target.value)} /></>}
    {list.state === 'READY' ? (list.items.length ? <><label htmlFor={ids.pick}>{copy.label}</label>
      <select id={ids.pick} value={value} disabled={disabled} onChange={(e) => {
        if (list.state !== 'READY') return; onPick?.(list.items.find((item) => keyOf(item) === e.target.value) ?? null);
      }}><option value="">{copy.choose}</option>{list.items.map((item) => <option key={keyOf(item)} value={keyOf(item)}>{describe(item)}</option>)}</select></>
      : <p role="status">{copy.empty}</p>)
      : <p role="status">{list.state === 'LOADING' ? copy.loading : copy.unavailable ?? 'This list could not be loaded. You can still enter record IDs below.'}</p>}
  </div>;
}

function useList<T>(load: (signal: AbortSignal) => Promise<T[]>, keys: readonly unknown[], delay: number): ListState<T> {
  const [list, setList] = useState<ListState<T>>({ state: 'LOADING' });
  useEffect(() => {
    let current = true; const abort = new AbortController();
    const timer = setTimeout(() => load(abort.signal).then(
      (items) => { if (current) setList({ state: 'READY', items }); },
      (error) => { if (current && !abort.signal.aborted) setList({ state: error instanceof PickerError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); }), delay);
    return () => { current = false; clearTimeout(timer); abort.abort(); };
  }, keys); // eslint-disable-line react-hooks/exhaustive-deps
  return list;
}

const ENROLLMENT_COPY: Record<EnrollmentPurpose, Copy> = {
  progress: { label: 'Student', choose: 'Choose a student', search: 'Find a student', loading: 'Reading students…', empty: 'No students with an active curriculum match.', denied: 'Your access does not include recording curriculum progress at this school.' },
  readiness: { label: 'Student', choose: 'Choose a student', search: 'Find a student', loading: 'Reading students…', empty: 'No students with an active curriculum match.', denied: 'Your access does not include promotion readiness at this school.' },
  testing: { label: 'Student', choose: 'Choose a student', search: 'Find a student', loading: 'Reading students…', empty: 'No students with an active curriculum match.', denied: 'Your access does not include testing at this school.' },
};
export function EnrollmentPicker({ scope, purpose, curriculumId = '', value, disabled, onPick }: {
  scope: PickerScope; purpose: EnrollmentPurpose; curriculumId?: string; value: string; disabled: boolean; onPick: (item: PickerEnrollment | null) => void;
}): React.ReactElement {
  const [search, setSearch] = useState('');
  const list = useList((signal) => pickerApi.enrollments(scope, purpose, search, signal, curriculumId),
    [scope.organizationId, scope.schoolId, purpose, search, curriculumId], search ? 250 : 0);
  return <PickListView copy={ENROLLMENT_COPY[purpose]} list={list} keyOf={(i) => i.enrollmentId} describe={(i) => enrollmentLabel(i, purpose !== 'progress')}
    value={value} search={search} disabled={disabled} onSearch={setSearch} onPick={onPick} />;
}

const EVENT_COPY: Copy = { label: 'Testing event', choose: 'Choose a testing event', loading: 'Reading testing events…', empty: 'No upcoming or open testing events. Create one first.', denied: 'Your access does not include testing at this school.' };
export function TestingEventPicker({ scope, value, disabled, onPick }: { scope: PickerScope; value: string; disabled: boolean; onPick: (item: PickerTestingEvent | null) => void }): React.ReactElement {
  const list = useList((signal) => pickerApi.testingEvents(scope, signal), [scope.organizationId, scope.schoolId], 0);
  const language = typeof navigator === 'undefined' ? 'en' : navigator.language;
  return <PickListView copy={EVENT_COPY} list={list} keyOf={(i) => i.testingEventId} describe={(i) => testingEventLabel(i, language)} value={value} disabled={disabled} onPick={onPick} />;
}

const CANDIDATE_COPY: Record<CandidatePurpose, Copy> = {
  grade: { label: 'Candidate', choose: 'Choose a candidate to grade', search: 'Find a candidate', loading: 'Reading candidates…', empty: 'No candidates are waiting for a grade.', denied: 'Your access does not include grading tests at this school.' },
  decision: { label: 'Candidate', choose: 'Choose a graded candidate', search: 'Find a candidate', loading: 'Reading candidates…', empty: 'No graded candidates are waiting for a promotion decision.', denied: 'Your access does not include promotion decisions at this school.' },
};
export function CandidatePicker({ scope, purpose, value, disabled, onPick }: {
  scope: PickerScope; purpose: CandidatePurpose; value: string; disabled: boolean; onPick: (item: PickerCandidate | null) => void;
}): React.ReactElement {
  const [search, setSearch] = useState('');
  const list = useList((signal) => pickerApi.candidates(scope, purpose, search, signal), [scope.organizationId, scope.schoolId, purpose, search], search ? 250 : 0);
  return <PickListView copy={CANDIDATE_COPY[purpose]} list={list} keyOf={(i) => i.candidateId} describe={candidateLabel} value={value} search={search} disabled={disabled} onSearch={setSearch} onPick={onPick} />;
}

const STUDENT_COPY: Record<StudentPurpose, Copy> = {
  teaching: { label: 'Student', choose: 'Choose a student (optional)', search: 'Find a student', loading: 'Reading students…', empty: 'No students match.', denied: 'Your access does not include student notes at this school.', unavailable: 'Students could not be loaded. Reload the page to try again.' },
  achievements: { label: 'Student', choose: 'Choose a student (optional)', search: 'Find a student', loading: 'Reading students…', empty: 'No students match.', denied: 'Your access does not include student achievements at this school.', unavailable: 'Students could not be loaded. Reload the page to try again.' },
};
export function StudentPicker({ scope, purpose, value, disabled, onPick }: { scope: PickerScope; purpose: StudentPurpose; value: string; disabled: boolean; onPick: (item: PickerStudent | null) => void }): React.ReactElement {
  const [search, setSearch] = useState('');
  const list = useList((signal) => pickerApi.students(scope, purpose, search, signal), [scope.organizationId, scope.schoolId, purpose, search], search ? 250 : 0);
  return <PickListView copy={STUDENT_COPY[purpose]} list={list} keyOf={(i) => i.studentProfileId} describe={studentLabel} value={value} search={search} disabled={disabled} onSearch={setSearch} onPick={onPick} />;
}

const RANK_COPY: Record<RankPurpose, Copy> = {
  teaching: { label: 'Target belt (optional)', choose: 'No target belt', loading: 'Reading belts…', empty: 'No belts are set up yet.', denied: 'Your access does not include this school’s belts.', unavailable: 'Belts could not be loaded. Reload the page to try again.' },
};
/** One list of "Curriculum · Belt"; choosing a row fills both the curriculum and the rank, so they always match. */
export function RankPicker({ scope, purpose, value, disabled, onPick, onItems }: { scope: PickerScope; purpose: RankPurpose; value: string; disabled: boolean; onPick: (item: PickerRank | null) => void; onItems?: (items: readonly PickerRank[]) => void }): React.ReactElement {
  const list = useList((signal) => pickerApi.ranks(scope, purpose, signal), [scope.organizationId, scope.schoolId, purpose], 0);
  useEffect(() => { if (list.state === 'READY') onItems?.(list.items); }, [list]); // eslint-disable-line react-hooks/exhaustive-deps
  return <PickListView copy={RANK_COPY[purpose]} list={list} keyOf={(i) => i.rankId} describe={rankLabel} value={value} disabled={disabled} onPick={onPick} />;
}

const STAFF_DENIED: Record<StaffPurpose, string> = {
  followups: 'Only managers can assign follow-ups to someone else.', work: 'Only managers can assign work to someone else.',
  qualifications: 'Your role does not include managing instructor qualifications.', roles: 'Your role does not include giving staff roles.',
  availability: 'Only managers can open another person’s availability.',
};
/** People with a role at this school, by name (0404). The list is only for screens whose own command manages a teammate. */
export function StaffPicker({ scope, purpose, label = 'Staff member', value, disabled, onPick, onState, onItems }: { scope: PickerScope; purpose: StaffPurpose; label?: string; value: string; disabled: boolean;
  onPick: (item: PickerStaff | null) => void; onState?: (state: ListState<PickerStaff>['state']) => void; onItems?: (items: readonly PickerStaff[]) => void }): React.ReactElement {
  const [search, setSearch] = useState('');
  const list = useList((signal) => pickerApi.staff(scope, purpose, signal), [scope.organizationId, scope.schoolId, purpose], 0);
  useEffect(() => { onState?.(list.state); if (list.state === 'READY') onItems?.(list.items); }, [list]); // eslint-disable-line react-hooks/exhaustive-deps
  const copy: Copy = { label, choose: 'Choose a person', search: 'Find a person', loading: 'Reading staff…', empty: 'No one matches.', denied: STAFF_DENIED[purpose], unavailable: 'Staff could not be loaded. Reload the page to try again.' };
  const shown: ListState<PickerStaff> = list.state === 'READY' ? { state: 'READY', items: list.items.filter((r) => r.displayName.toLowerCase().includes(search.trim().toLowerCase())) } : list;
  return <PickListView copy={copy} list={shown} keyOf={(i) => i.principalId} describe={staffLabel} value={value} search={search} disabled={disabled} onSearch={setSearch} onPick={onPick} />;
}

type LeadRow = Pick<LeadListItem, 'id' | 'givenName' | 'familyName'>;
export const leadLabel = (lead: LeadRow): string => name(lead);
/** The lead list has no server search, so the newest open leads are filtered by name on the page. */
export function filterLeads<T extends LeadRow>(leads: readonly T[], find: string): T[] {
  const needle = find.trim().toLowerCase();
  return needle ? leads.filter((lead) => leadLabel(lead).toLowerCase().includes(needle)) : [...leads];
}
const LEAD_COPY: Copy = { label: 'Lead', choose: 'Choose a lead', search: 'Find a lead', loading: 'Reading leads…', empty: 'No open leads match.', denied: 'Your role does not include reading leads at this school.', unavailable: 'Leads could not be loaded. Reload the page to try again.' };
/** The school's newest open leads (the CRM lead list, crm.lead.read), picked by name. */
export function LeadPicker({ scope, value, disabled, onPick, onState, onItems }: { scope: PickerScope; value: string; disabled: boolean; onPick: (lead: LeadListItem | null) => void; onState?: (state: ListState<LeadListItem>['state']) => void; onItems?: (items: readonly LeadListItem[]) => void }): React.ReactElement {
  const [search, setSearch] = useState('');
  const [list, setList] = useState<ListState<LeadListItem>>({ state: 'LOADING' });
  useEffect(() => {
    let current = true; const abort = new AbortController();
    loadCrmLeads(scope.organizationId, scope.schoolId, 'OPEN', abort.signal).then(
      (items) => { if (current) setList({ state: 'READY', items }); },
      (error) => { if (current && !abort.signal.aborted) setList({ state: error instanceof CrmLeadAccessError ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { current = false; abort.abort(); };
  }, [scope.organizationId, scope.schoolId]);
  useEffect(() => { onState?.(list.state); if (list.state === 'READY') onItems?.(list.items); }, [list]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown: ListState<LeadListItem> = list.state === 'READY' ? { state: 'READY', items: filterLeads(list.items, search) } : list;
  return <PickListView copy={LEAD_COPY} list={shown} keyOf={(i) => i.id} describe={leadLabel} value={value} search={search} disabled={disabled} onSearch={setSearch} onPick={onPick} />;
}

/** Record-ID inputs: shown directly when no school is selected, otherwise tucked under a fallback disclosure. */
export function IdFields({ manual, children }: { manual: boolean; children: React.ReactNode }): React.ReactElement {
  return manual ? <>{children}</> : <details data-id-fields="fallback" className={styles.idFields}><summary>Enter record IDs instead</summary>{children}</details>;
}

/** A staff member in words for signed-in staff: "You", their listed name, or a neutral fallback; never a record ID. */
export function personLabel(id: string | null, me: string, staff: ReadonlyMap<string, string>, none = 'Unassigned'): string {
  return id === null ? none : id === me ? 'You' : staff.get(id) ?? 'A teammate';
}
