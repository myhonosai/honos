import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IMPORT_LANGUAGES, importText } from '../src/components/student-import/copy';
import { ImportError, csvHeaders, guessMapping, importErrorFor, keepForRetry, mappingProblem, studentImportApi } from '../src/components/student-import/http';
import { StudentImportView, effectiveChoice, problemText, unsavedDecisions, type StudentImportViewProps } from '../src/components/student-import/view';
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
const FIELDS = ['studentGivenName', 'studentFamilyName', 'birthDate', 'studentEmail', 'studentMobile', 'guardianGivenName', 'guardianFamilyName', 'guardianEmail', 'guardianMobile', 'familyKey'];
const batch = (over: Record<string, unknown> = {}) => ({ id: batchId, version: 1, status: 'STAGED', rowCount: 2, validCount: 1, importCount: 0, skipCount: 0, undecidedCount: 2,
  importedCount: 0, checksum: 'a'.repeat(64), schoolToday: '2026-11-09', createdAt: '2026-11-09T02:00:00.000Z', finalizedAt: null, ...over });
const row = (index: number, over: Record<string, unknown> = {}) => ({ index, raw: ['Ava', 'Stone', '2016-04-02'], choice: null, created: null, errors: [], suggestions: [],
  normalized: { studentGivenName: 'Ava', studentFamilyName: 'Stone', birthDate: '2016-04-02', guardian: { givenName: 'Mia', familyName: 'Stone', email: 'mia@example.test', mobile: '' } }, ...over });
const detailRaw = (over: Record<string, unknown> = {}) => ({ batch: batch(), headers: ['First', 'Last', 'DOB'], mapping: { First: 'studentGivenName', Last: 'studentFamilyName', DOB: 'birthDate' },
  rows: [row(1, { suggestions: [{ rowIndex: 2, reason: 'SAME_STUDENT_IN_FILE' }, { personId: id(50), reason: 'STUDENT_NAME_AND_BIRTH_DATE' }] }),
    row(2, { errors: ['guardian:REQUIRED_FOR_MINOR', 'birthDate:USE_YYYY_MM_DD'], normalized: { studentGivenName: 'Leo', studentFamilyName: 'Stone', birthDate: '2018-13-01', guardian: null } })], ...over });

it('reads as plain same-origin GETs with no query, no key and no x-hon header', async () => {
  const f = stub(json({ data: { batches: [batch()], fields: FIELDS, maxBytes: 262144, maxRows: 1000, maxColumns: 24 }, meta }));
  const read = await studentImportApi.list({ organizationId: org.toUpperCase(), schoolId: school }, signal(), () => true);
  expect(read.batches[0]?.id).toBe(batchId);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/student-imports`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
  const g = stub(json({ data: detailRaw(), meta }));
  await expect(studentImportApi.detail(scope, batchId.toUpperCase(), signal(), () => true)).resolves.toMatchObject({ rows: [{ index: 1 }, { index: 2 }] });
  expect((g.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/organizations/${org}/schools/${school}/student-imports/${batchId}`);
  stub(json({ data: detailRaw({ batch: batch({ id: id(41) }) }), meta }));
  expect((await fails(studentImportApi.detail(scope, batchId, signal(), () => true))).kind).toBe('UNKNOWN');
});

it('sends each command with its own name and key, and accepts only this batch back', async () => {
  const csv = 'First,Last\nAva,Stone\n', mapping = { First: 'studentGivenName', Last: 'studentFamilyName' } as const;
  const f = stub(json({ data: batch(), meta: { ...meta, replayed: false } }));
  await studentImportApi.stage(scope, { csv, mapping }, key, signal(), () => true);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/student-imports`);
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': 'students.import.stage', 'Idempotency-Key': key, 'Content-Type': 'application/json' });
  expect(JSON.parse(init.body as string)).toEqual({ csv, mapping });
  const g = stub(json({ data: batch({ version: 2, importCount: 1, skipCount: 1, undecidedCount: 0 }), meta }));
  await studentImportApi.decide(scope, batchId, { expectedVersion: 1, decisions: [{ index: 1, choice: 'IMPORT' }, { index: 2, choice: 'SKIP' }] }, key, signal(), () => true);
  expect((g.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'X-HON-Human-Command': 'students.import.decide' });
  stub(json({ data: batch({ id: id(41), version: 2, importCount: 1, skipCount: 1, undecidedCount: 0 }), meta }));
  expect((await fails(studentImportApi.finalize(scope, batchId, { expectedVersion: 2, selectedIndices: [1] }, key, signal(), () => true))).kind).toBe('UNKNOWN');
  const h = stub(json({}));
  expect((await fails(studentImportApi.stage(scope, { csv, mapping: { First: 'studentGivenName', Last: 'ignore' } }, key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(studentImportApi.stage(scope, { csv, mapping }, 'not-a-key', signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(studentImportApi.decide(scope, batchId, { expectedVersion: 1, decisions: [] }, key, signal(), () => true))).kind).toBe('INVALID');
  expect(h).not.toHaveBeenCalled();
});

it('maps refusals to definitive outcomes and keeps only unknown ones for an exact retry', () => {
  expect(importErrorFor(403, 'STUDENT_IMPORT_FORBIDDEN').kind).toBe('DENIED');
  expect(importErrorFor(404, 'STUDENT_IMPORT_NOT_FOUND').kind).toBe('GONE');
  expect(importErrorFor(400, 'STUDENT_IMPORT_ROW_NOT_IMPORTABLE').kind).toBe('NOT_IMPORTABLE');
  expect(importErrorFor(400, 'STUDENT_IMPORT_INVALID').kind).toBe('INVALID');
  expect(importErrorFor(409, 'VERSION_CONFLICT').kind).toBe('CHANGED');
  expect(importErrorFor(409, 'STUDENT_IMPORT_SELECTION_REQUIRED').kind).toBe('SELECTION');
  expect(importErrorFor(409, 'STUDENT_IMPORT_BUSY').kind).toBe('UNKNOWN');
  expect(importErrorFor(503, 'STUDENT_IMPORT_UNAVAILABLE').kind).toBe('UNKNOWN');
  expect(keepForRetry(new ImportError('UNKNOWN'))).toBe(true);
  expect(keepForRetry(new ImportError('RATE'))).toBe(true);
  expect(keepForRetry(new ImportError('CHANGED'))).toBe(false);
});

it('reads only a clean header row and suggests a mapping staff can review', () => {
  expect(csvHeaders('﻿First Name,Last Name,"Parent, First",DOB\r\nAva,Stone,Mia,2016-04-02\r\n')).toEqual(['First Name', 'Last Name', 'Parent, First', 'DOB']);
  expect(csvHeaders('First,First\n')).toBeNull();
  expect(csvHeaders('"First,Last\n')).toBeNull();
  expect(csvHeaders(',Last\n')).toBeNull();
  const guess = guessMapping(['First Name', 'Last Name', 'Date of Birth', 'Parent First Name', 'Parent Last Name', 'Parent Email', 'Parent Phone', 'Family', 'Notes', 'Email']);
  expect(guess).toEqual({ 'First Name': 'studentGivenName', 'Last Name': 'studentFamilyName', 'Date of Birth': 'birthDate', 'Parent First Name': 'guardianGivenName',
    'Parent Last Name': 'guardianFamilyName', 'Parent Email': 'guardianEmail', 'Parent Phone': 'guardianMobile', Family: 'familyKey', Notes: 'ignore', Email: 'studentEmail' });
  expect(mappingProblem(guess)).toBeNull();
  expect(mappingProblem({ A: 'studentGivenName' })).toBe('STUDENT_NAMES');
  expect(mappingProblem({ A: 'studentGivenName', B: 'studentFamilyName', C: 'studentFamilyName' })).toBe('DUPLICATE');
  expect(mappingProblem({ A: 'studentGivenName', B: 'studentFamilyName', C: 'guardianGivenName' })).toBe('GUARDIAN_NAMES');
  expect(mappingProblem({ A: 'studentGivenName', B: 'studentFamilyName', C: 'guardianEmail' })).toBe('GUARDIAN_CONTACT');
});

const base = (over: Partial<StudentImportViewProps> = {}): StudentImportViewProps => ({ language: 'en', waiting: false, concealed: false, hasSchool: true,
  list: { state: 'READY', list: { batches: [batch() as never], fields: FIELDS as never, maxBytes: 262144, maxRows: 1000, maxColumns: 24 } },
  selected: null, detail: { state: 'IDLE' }, upload: { phase: 'NONE' }, choices: {}, outcome: null, locked: false, canRetry: false, ...over });
const html = (over: Partial<StudentImportViewProps> = {}) => renderToStaticMarkup(<StudentImportView {...base(over)}/>);

it('shows nothing private before the school is verified, and upload only to staff who may import', () => {
  for (const over of [{ waiting: true }, { concealed: true }, { hasSchool: false }]) {
    const out = html(over);
    expect(out).not.toContain('Recent imports'); expect(out).not.toContain('Upload a CSV');
  }
  expect(html()).toContain('Upload a CSV file');
  const denied = html({ list: { state: 'DENIED' } });
  expect(denied).toContain('You cannot import students at this school.'); expect(denied).not.toContain('Upload a CSV file');
  const mapping = html({ upload: { phase: 'MAPPING', fileName: 'roster.csv', csv: 'A,B\n1,2\n', headers: ['A', 'B'], mapping: { A: 'studentGivenName', B: 'ignore' } } });
  expect(mapping).toContain('Match a column to student first name');
  expect(mapping).toMatch(/<button type="submit"[^>]*disabled/);
});

it('reviews rows: problems in words, rows with problems can only be skipped, and import waits for saved decisions', () => {
  const read = detailRaw();
  const view = html({ selected: batchId, detail: { state: 'READY', detail: read as never } });
  expect(view).toContain('Guardian: a student under 18 needs a guardian');
  expect(view).toContain('Birth date: use YYYY-MM-DD');
  expect(view).toContain('Same student as row 2.');
  expect(view).toContain('May already be at this school (same name and birth date).');
  expect(view).toContain('disabled="" name="choice-2" value="IMPORT"');
  expect(view).toContain('Some decisions are not saved yet.');
  expect(view).toMatch(/Import 0 students<\/button>/);
  const rows = read.rows as never as Parameters<typeof effectiveChoice>[0][];
  expect(effectiveChoice(rows[0]!, {})).toBe('IMPORT');
  expect(effectiveChoice(rows[1]!, { 2: 'IMPORT' })).toBe('SKIP');
  expect(unsavedDecisions(read as never, { 1: 'SKIP' })).toEqual([{ index: 1, choice: 'SKIP' }, { index: 2, choice: 'SKIP' }]);
  const saved = detailRaw({ batch: batch({ version: 2, importCount: 1, skipCount: 1, undecidedCount: 0 }),
    rows: [row(1, { choice: 'IMPORT' }), row(2, { choice: 'SKIP', errors: ['student:NAME_REQUIRED'] })] });
  const ready = html({ selected: batchId, detail: { state: 'READY', detail: saved as never } });
  expect(ready).not.toContain('Some decisions are not saved yet.');
  expect(ready).toMatch(/<button type="button"[^>]*>Import 1 students<\/button>/);
  expect(ready).not.toMatch(/disabled=""[^>]*>Import 1 students/);
  const done = detailRaw({ batch: batch({ version: 3, status: 'FINALIZED', importCount: 1, skipCount: 1, undecidedCount: 0, importedCount: 1, finalizedAt: '2026-11-09T03:00:00.000Z' }),
    rows: [row(1, { choice: 'IMPORT', created: { familyId: id(60), guardianPersonId: id(61), studentPersonId: id(62), studentProfileId: id(63) } }), row(2, { choice: 'SKIP', errors: ['x:UNKNOWN_CODE'] })] });
  const final = html({ selected: batchId, detail: { state: 'READY', detail: done as never } });
  expect(final).toContain('1 students imported'); expect(final).toContain('Not imported'); expect(final).not.toContain('type="radio"');
  expect(problemText('x:UNKNOWN_CODE', (k) => importText('en', k))).toBe('x: needs checking');
  expect(html({ outcome: { kind: 'UNKNOWN', action: 'finalize' }, canRetry: true, locked: true })).toContain('Try again');
  expect(html({ outcome: { kind: 'CHANGED', action: 'decide' } })).not.toContain('Try again');
});

it('has every wording in English, Korean and Spanish, and a staff students route', () => {
  const keys = Object.keys(IMPORT_LANGUAGES.en).sort();
  expect(Object.keys(IMPORT_LANGUAGES.ko).sort()).toEqual(keys); expect(Object.keys(IMPORT_LANGUAGES.es).sort()).toEqual(keys);
  expect(importText('ko', 'title')).toBe('학생 가져오기');
  const students = SCHOOL_SHELL_NAV.find(g => g.key === 'students');
  expect(students?.routes.map(r => r.href)).toContain('/staff/migration/students');
  expect(schoolShellActiveRoute('/staff/migration/students')?.href).toBe('/staff/migration/students');
  const page = readFileSync('src/app/staff/migration/students/page.tsx', 'utf8');
  expect(page).toContain('await requireVerifiedWebSession()');
  expect(readFileSync('public/manus-routes.json', 'utf8')).toContain('"/staff/migration/students"');
});
