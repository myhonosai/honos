import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HISTORY_IMPORT_FIELDS } from '@hon/contracts';
import { HISTORY_IMPORT_LANGUAGES, historyImportText } from '../src/components/history-import/copy';
import { ImportError, guessMapping, historyImportApi, importErrorFor, keepForRetry, mappingProblem } from '../src/components/history-import/http';
import { HistoryImportView, effectiveChoice, problemText, unsavedDecisions, weekdayNames, type HistoryImportViewProps } from '../src/components/history-import/view';
import { SCHOOL_SHELL_NAV, schoolShellActiveRoute } from '../src/components/school-shell/catalog';
import { id } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), batchId = id(40), key = id(77), scope = { organizationId: org, schoolId: school };
const meta = { requestId: id(5), correlationId: id(5) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ImportError; } throw new Error('expected a failure'); };
const batch = (over: Record<string, unknown> = {}) => ({ id: batchId, kind: 'CLASSES', version: 1, status: 'STAGED', rowCount: 2, validCount: 1, importCount: 0, skipCount: 0,
  undecidedCount: 2, importedCount: 0, checksum: 'a'.repeat(64), schoolToday: '2026-11-09', createdAt: '2026-11-09T02:00:00.000Z', finalizedAt: null, ...over });
const listRaw = () => ({ batches: [batch()], fields: HISTORY_IMPORT_FIELDS, maxBytes: 262144, maxRows: 1000, maxColumns: 24 });
const classRow = (index: number, over: Record<string, unknown> = {}) => ({ index, raw: ['Little Tigers', 'Mon, Wed', '4:30 PM', '45'], choice: null, created: null, errors: [],
  matchedStudentProfileId: null, normalized: { className: 'Little Tigers', programName: 'Little Tigers', weekdays: '1,3', startTime: '16:30', durationMinutes: '45',
    capacity: '20', bookingPolicy: 'WALK_IN', startsOn: '2026-11-09', roomName: '' }, ...over });
const classDetail = (over: Record<string, unknown> = {}) => ({ batch: batch(), headers: ['Class', 'Days', 'Time', 'Minutes'],
  mapping: { Class: 'className', Days: 'weekdays', Time: 'startTime', Minutes: 'durationMinutes' },
  rows: [classRow(1), classRow(2, { errors: ['className:ALREADY_SCHEDULED', 'durationMinutes:OUT_OF_RANGE'] })], ...over });
const visitRow = (index: number, over: Record<string, unknown> = {}) => ({ index, raw: ['Ava', 'Stone', '2026-10-01'], choice: null, created: null, errors: [],
  matchedStudentProfileId: id(60), normalized: { studentGivenName: 'Ava', studentFamilyName: 'Stone', attendedOn: '2026-10-01', visits: '1', className: '', birthDate: '' }, ...over });
const visitDetail = (over: Record<string, unknown> = {}) => ({ batch: batch({ kind: 'ATTENDANCE' }), headers: ['First', 'Last', 'Date'],
  mapping: { First: 'studentGivenName', Last: 'studentFamilyName', Date: 'attendedOn' },
  rows: [visitRow(1), visitRow(2, { matchedStudentProfileId: null, errors: ['student:AMBIGUOUS', 'attendedOn:OUT_OF_RANGE'] })], ...over });

it('reads as plain same-origin GETs with no query, no key and no x-hon header', async () => {
  const f = stub(json({ data: listRaw(), meta }));
  const read = await historyImportApi.list({ organizationId: org.toUpperCase(), schoolId: school }, signal(), () => true);
  expect(read.batches[0]?.kind).toBe('CLASSES');
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/history-imports`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
  const g = stub(json({ data: visitDetail(), meta }));
  await expect(historyImportApi.detail(scope, batchId.toUpperCase(), signal(), () => true)).resolves.toMatchObject({ rows: [{ index: 1 }, { index: 2 }] });
  expect((g.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/organizations/${org}/schools/${school}/history-imports/${batchId}`);
  stub(json({ data: classDetail({ batch: batch({ id: id(41) }) }), meta }));
  expect((await fails(historyImportApi.detail(scope, batchId, signal(), () => true))).kind).toBe('UNKNOWN');
});

it('sends each command with its own name and key, and accepts only this batch and kind back', async () => {
  const csv = 'Class,Days,Time,Minutes\nKids,Mon,16:30,45\n';
  const mapping = { Class: 'className', Days: 'weekdays', Time: 'startTime', Minutes: 'durationMinutes' } as const;
  const f = stub(json({ data: batch(), meta: { ...meta, replayed: false } }));
  await historyImportApi.stage(scope, { kind: 'CLASSES', csv, mapping }, key, signal(), () => true);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/history-imports`);
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': 'history.import.stage', 'Idempotency-Key': key, 'Content-Type': 'application/json' });
  expect(JSON.parse(init.body as string)).toEqual({ kind: 'CLASSES', csv, mapping });
  stub(json({ data: batch({ kind: 'ATTENDANCE' }), meta }));
  expect((await fails(historyImportApi.stage(scope, { kind: 'CLASSES', csv, mapping }, key, signal(), () => true))).kind).toBe('UNKNOWN');
  const g = stub(json({ data: batch({ version: 2, importCount: 1, skipCount: 1, undecidedCount: 0 }), meta }));
  await historyImportApi.decide(scope, batchId, { expectedVersion: 1, decisions: [{ index: 1, choice: 'IMPORT' }, { index: 2, choice: 'SKIP' }] }, key, signal(), () => true);
  expect((g.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe(`/api/v1/organizations/${org}/schools/${school}/history-imports/${batchId}/decisions`);
  expect((g.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'X-HON-Human-Command': 'history.import.decide' });
  const h = stub(json({ data: batch({ version: 3, status: 'FINALIZED', importCount: 1, skipCount: 1, undecidedCount: 0, importedCount: 1, finalizedAt: '2026-11-09T03:00:00.000Z' }), meta }));
  await historyImportApi.finalize(scope, batchId, { expectedVersion: 2, selectedIndices: [1] }, key, signal(), () => true);
  expect((h.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'X-HON-Human-Command': 'history.import.finalize' });
  stub(json({ data: batch({ id: id(41), version: 2, importCount: 1, skipCount: 1, undecidedCount: 0 }), meta }));
  expect((await fails(historyImportApi.decide(scope, batchId, { expectedVersion: 1, decisions: [{ index: 1, choice: 'SKIP' }] }, key, signal(), () => true))).kind).toBe('UNKNOWN');
  const none = stub(json({}));
  // Missing a required field, a field of the other kind, a bad key, an empty decision: refused before anything is sent.
  expect((await fails(historyImportApi.stage(scope, { kind: 'CLASSES', csv, mapping: { ...mapping, Minutes: 'ignore' } }, key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(historyImportApi.stage(scope, { kind: 'ATTENDANCE', csv, mapping }, key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(historyImportApi.stage(scope, { kind: 'CLASSES', csv, mapping }, 'not-a-key', signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(historyImportApi.decide(scope, batchId, { expectedVersion: 1, decisions: [] }, key, signal(), () => true))).kind).toBe('INVALID');
  expect(none).not.toHaveBeenCalled();
});

it('maps refusals to definitive outcomes, a stale import included, and keeps only unknown ones for an exact retry', () => {
  expect(importErrorFor(403, 'HISTORY_IMPORT_FORBIDDEN').kind).toBe('DENIED');
  expect(importErrorFor(404, 'HISTORY_IMPORT_NOT_FOUND').kind).toBe('GONE');
  expect(importErrorFor(400, 'HISTORY_IMPORT_ROW_NOT_IMPORTABLE').kind).toBe('NOT_IMPORTABLE');
  expect(importErrorFor(400, 'HISTORY_IMPORT_INVALID').kind).toBe('INVALID');
  expect(importErrorFor(409, 'VERSION_CONFLICT').kind).toBe('CHANGED');
  expect(importErrorFor(409, 'HISTORY_IMPORT_STALE').kind).toBe('STALE');
  expect(importErrorFor(409, 'HISTORY_IMPORT_SELECTION_REQUIRED').kind).toBe('SELECTION');
  expect(importErrorFor(409, 'HISTORY_IMPORT_BUSY').kind).toBe('UNKNOWN');
  expect(importErrorFor(409, 'HISTORY_IMPORT_CONFLICT').kind).toBe('UNKNOWN');
  expect(importErrorFor(503, 'HISTORY_IMPORT_UNAVAILABLE').kind).toBe('UNKNOWN');
  expect(keepForRetry(new ImportError('UNKNOWN'))).toBe(true);
  expect(keepForRetry(new ImportError('RATE'))).toBe(true);
  expect(keepForRetry(new ImportError('STALE'))).toBe(false);
  expect(keepForRetry(new ImportError('CHANGED'))).toBe(false);
});

it('suggests a mapping per kind from familiar export headers, and checks it like the server', () => {
  const classes = guessMapping('CLASSES', ['Class Name', 'Program', 'Days of Week', 'Start Time', 'Duration', 'Max Students', 'Room', 'Instructor']);
  expect(classes).toEqual({ 'Class Name': 'className', Program: 'programName', 'Days of Week': 'weekdays', 'Start Time': 'startTime', Duration: 'durationMinutes',
    'Max Students': 'capacity', Room: 'roomName', Instructor: 'ignore' });
  expect(mappingProblem('CLASSES', classes)).toBeNull();
  const visits = guessMapping('ATTENDANCE', ['First Name', 'Last Name', 'DOB', 'Check-in Date', 'Class', 'Email']);
  expect(visits).toEqual({ 'First Name': 'studentGivenName', 'Last Name': 'studentFamilyName', DOB: 'birthDate', 'Check-in Date': 'attendedOn', Class: 'className', Email: 'ignore' });
  expect(mappingProblem('ATTENDANCE', visits)).toBeNull();
  expect(mappingProblem('CLASSES', visits)).toBe('DUPLICATE');
  expect(mappingProblem('ATTENDANCE', { A: 'studentGivenName', B: 'studentFamilyName' })).toBe('REQUIRED');
  expect(mappingProblem('ATTENDANCE', { A: 'studentGivenName', B: 'studentFamilyName', C: 'attendedOn', D: 'attendedOn' })).toBe('DUPLICATE');
  const wide = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`c${i}`, 'ignore' as const]));
  expect(mappingProblem('ATTENDANCE', { ...wide, c0: 'studentGivenName', c1: 'studentFamilyName', c2: 'attendedOn' })).toBeNull();
});

const base = (over: Partial<HistoryImportViewProps> = {}): HistoryImportViewProps => ({ language: 'en', waiting: false, concealed: false, hasSchool: true, kind: 'CLASSES',
  list: { state: 'READY', list: listRaw() as never }, selected: null, detail: { state: 'IDLE' }, upload: { phase: 'NONE' }, choices: {}, outcome: null,
  locked: false, canRetry: false, ...over });
const html = (over: Partial<HistoryImportViewProps> = {}) => renderToStaticMarkup(<HistoryImportView {...base(over)}/>);

it('shows nothing private before the school is verified, and upload only to staff who may import', () => {
  for (const over of [{ waiting: true }, { concealed: true }, { hasSchool: false }]) {
    const out = html(over);
    expect(out).not.toContain('Recent imports'); expect(out).not.toContain('Upload a CSV');
  }
  const open = html();
  expect(open).toContain('Upload a CSV file'); expect(open).toContain('aria-pressed="true"');
  expect(open).toContain('Class schedule, '); expect(open).toContain('creates no class sessions');
  expect(html({ kind: 'ATTENDANCE' })).toContain('never creates a check-in');
  const denied = html({ list: { state: 'DENIED' } });
  expect(denied).toContain('You cannot import classes or attendance at this school.'); expect(denied).not.toContain('Upload a CSV file');
  const mapping = html({ kind: 'ATTENDANCE', upload: { phase: 'MAPPING', fileName: 'visits.csv', csv: 'A,B\n1,2\n', headers: ['A', 'B'], mapping: { A: 'studentGivenName', B: 'ignore' } } });
  expect(mapping).toContain('Match columns to student first name, last name and the date attended.');
  expect(mapping).toContain('Date attended (required)'); expect(mapping).not.toContain('Class name (required)');
  expect(mapping).toMatch(/<button type="submit"[^>]*disabled/);
});

it('reviews class rows with days in words, stated defaults and problems that can only be skipped', () => {
  const read = classDetail();
  const view = html({ selected: batchId, detail: { state: 'READY', detail: read as never } });
  expect(view).toContain('Mon, Wed at 16:30, 45 min');
  expect(view).toContain('20 places · walk-in · from Nov 9, 2026');
  expect(view).toContain('Class name: a class with this name, day and time is already scheduled');
  expect(view).toContain('Length (minutes): use 5 to 600 minutes');
  expect(view).toContain('Blank cells use these defaults');
  expect(view).toContain('disabled="" name="choice-2" value="IMPORT"');
  expect(view).toMatch(/Import 0 classes<\/button>/);
  const rows = read.rows as never as Parameters<typeof effectiveChoice>[0][];
  expect(effectiveChoice(rows[1]!, { 2: 'IMPORT' })).toBe('SKIP');
  expect(unsavedDecisions(read as never, { 1: 'SKIP' })).toEqual([{ index: 1, choice: 'SKIP' }, { index: 2, choice: 'SKIP' }]);
  const done = classDetail({ batch: batch({ version: 3, status: 'FINALIZED', importCount: 1, skipCount: 1, undecidedCount: 0, importedCount: 1, finalizedAt: '2026-11-09T03:00:00.000Z' }),
    rows: [classRow(1, { choice: 'IMPORT', created: { programId: id(61), seriesId: id(62) } }), classRow(2, { choice: 'SKIP', errors: ['x:NEW_CODE'] })] });
  const final = html({ selected: batchId, detail: { state: 'READY', detail: done as never } });
  expect(final).toContain('1 classes added to the schedule'); expect(final).toContain('href="/staff/schedule"');
  expect(final).toContain('Not imported'); expect(final).not.toContain('type="radio"');
  expect(problemText('x:NEW_CODE', (k) => historyImportText('en', k))).toBe('x: needs checking');
});

it('reviews attendance rows against existing students and explains a stale import', () => {
  const saved = visitDetail({ batch: batch({ kind: 'ATTENDANCE', version: 2, importCount: 1, skipCount: 1, undecidedCount: 0 }),
    rows: [visitRow(1, { choice: 'IMPORT' }), visitRow(2, { choice: 'SKIP', matchedStudentProfileId: null, errors: ['student:AMBIGUOUS', 'attendedOn:OUT_OF_RANGE'] })] });
  const view = html({ kind: 'CLASSES', selected: batchId, detail: { state: 'READY', detail: saved as never } });
  expect(view).toContain('Review attendance');
  expect(view).toContain('Matched to a student at this school');
  expect(view).toContain('Student: more than one student matches; add a birth date column');
  expect(view).toContain('Date attended: must be a past date, within 50 years');
  expect(view).not.toContain('Some decisions are not saved yet.');
  expect(view).toMatch(/<button type="button"[^>]*>Import 1 attendance rows<\/button>/);
  expect(view).not.toMatch(/disabled=""[^>]*>Import 1 attendance rows/);
  const stale = html({ outcome: { kind: 'STALE', action: 'finalize' } });
  expect(stale).toContain('Upload the file again'); expect(stale).not.toContain('Try again');
  expect(html({ outcome: { kind: 'UNKNOWN', action: 'finalize' }, canRetry: true, locked: true })).toContain('Try again');
  expect(weekdayNames('en', '1,7')).toBe('Mon, Sun');
});

it('has every wording in English, Korean and Spanish, and a staff classes route', () => {
  const keys = Object.keys(HISTORY_IMPORT_LANGUAGES.en).sort();
  expect(Object.keys(HISTORY_IMPORT_LANGUAGES.ko).sort()).toEqual(keys); expect(Object.keys(HISTORY_IMPORT_LANGUAGES.es).sort()).toEqual(keys);
  expect(historyImportText('ko', 'title')).toBe('수업 및 출석 가져오기');
  const classes = SCHOOL_SHELL_NAV.find(g => g.key === 'classes');
  expect(classes?.routes.map(r => r.href)).toContain('/staff/migration/classes');
  expect(schoolShellActiveRoute('/staff/migration/classes')?.href).toBe('/staff/migration/classes');
  const page = readFileSync('src/app/staff/migration/classes/page.tsx', 'utf8');
  expect(page).toContain('await requireVerifiedWebSession()');
  expect(readFileSync('public/manus-routes.json', 'utf8')).toContain('"/staff/migration/classes"');
});
