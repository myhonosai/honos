import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { paperCopy } from '../src/components/paper-import/copy';
import { PaperError, cleanCell, clipCell, keepForRetry, paperErrorFor, paperImportApi } from '../src/components/paper-import/http';
import { PaperImportView, filledRows, type PaperImportViewProps } from '../src/components/paper-import/view';
import { SCHOOL_SHELL_NAV, schoolShellActiveRoute } from '../src/components/school-shell/catalog';
import { shellText } from '../src/components/school-shell/copy';
import { id } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), setId = id(40), key = id(77), scope = { organizationId: org, schoolId: school };
const meta = { requestId: id(5), correlationId: id(5) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as PaperError; } throw new Error('expected a failure'); };
const STUDENT_COLUMNS = ['studentGivenName', 'studentFamilyName', 'birthDate', 'studentEmail', 'studentMobile', 'guardianGivenName', 'guardianFamilyName', 'guardianEmail', 'guardianMobile', 'familyKey'];
const at = '2026-11-15T02:00:00.000Z', later = '2026-12-15T02:00:00.000Z';
const set = (over: Record<string, unknown> = {}) => ({ id: setId, kind: 'STUDENT_CARDS', target: 'STUDENTS', version: 2, status: 'OPEN', pageCount: 1, reader: null, readOutcome: null,
  sentBatchId: null, createdAt: at, expiresAt: later, readAt: null, sentAt: null, deletedAt: null, deleteReason: null, ...over });
const read = { status: 'READ', version: 3, reader: 'SYNTHETIC', readOutcome: 'SAMPLE_READ', readAt: at };
const page = { pageNo: 1, mediaType: 'image/png', bytes: 1200, checksum: 'a'.repeat(64) };
const row = ['Mina', 'Park', '2015-03-02', '', '', 'Grace', 'Park', '', '+12135550142', ''];
const detail = (over: Record<string, unknown> = {}, setOver: Record<string, unknown> = {}) => ({ set: set(setOver), columns: STUDENT_COLUMNS, rows: [], unsure: [], pages: [page], ...over });
const list = { sets: [set()], maxPages: 10, maxPageBytes: 1400000, maxRows: 200, retentionDays: 30 };

it('reads as plain same-origin GETs with no key and no x-hon header, and accepts only the set asked for', async () => {
  const f = stub(json({ data: list, meta }));
  expect((await paperImportApi.list({ organizationId: org.toUpperCase(), schoolId: school }, signal(), () => true)).sets[0]?.id).toBe(setId);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/paper-imports`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
  const g = stub(json({ data: { pageNo: 1, mediaType: 'image/png', data: 'iVBORw0KGgo=' }, meta }));
  await paperImportApi.page(scope, setId, 1, signal(), () => true);
  expect((g.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/organizations/${org}/schools/${school}/paper-imports/${setId}/pages/1`);
  expect((await fails(paperImportApi.page(scope, setId, 11, signal(), () => true))).kind).toBe('INVALID');
  stub(json({ data: detail({}, { id: id(41) }), meta }));
  expect((await fails(paperImportApi.detail(scope, setId, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: detail({}, { status: 'DELETED', pageCount: 0, deletedAt: at, deleteReason: 'STAFF' }), meta }));
  expect((await fails(paperImportApi.detail(scope, setId, signal(), () => true))).kind).toBe('UNKNOWN');
});

it('sends each command with its own name; the one reading per set has no key, every other command does', async () => {
  const f = stub(json({ data: set(), meta: { ...meta, replayed: false } }));
  await paperImportApi.create(scope, 'STUDENT_CARDS', key, signal(), () => true);
  let [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/paper-imports`);
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': 'students.paper_import.create', 'Idempotency-Key': key });
  expect(JSON.parse(init.body as string)).toEqual({ kind: 'STUDENT_CARDS' });
  const r = stub(json({ data: detail({ rows: [row], unsure: [row.map((_, i) => i === 8)] }, read), meta }));
  await paperImportApi.read(scope, setId, 2, signal(), () => true);
  [path, init] = r.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/paper-imports/${setId}/reading`);
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': 'students.paper_import.reading' });
  expect(Object.keys(init.headers as object).some(k => /idempotency/i.test(k))).toBe(false);
  const s = stub(json({ data: set({ ...read, version: 4 }), meta }));
  await paperImportApi.save(scope, setId, 'STUDENT_CARDS', { expectedVersion: 3, rows: [row], unsure: [row.map(() => false)] }, key, signal(), () => true);
  [path, init] = s.mock.calls[0] as unknown as [string, RequestInit];
  expect(path.endsWith('/table')).toBe(true);
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': 'students.paper_import.save', 'Idempotency-Key': key });
  const d = stub(json({ data: set({ status: 'DELETED', pageCount: 0, version: 5, deletedAt: at, deleteReason: 'STAFF' }), meta }));
  await paperImportApi.remove(scope, setId, key, signal(), () => true);
  expect(JSON.parse((d.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({});
  const none = stub(json({}));
  expect((await fails(paperImportApi.save(scope, setId, 'STUDENT_CARDS', { expectedVersion: 3, rows: [['too', 'short']], unsure: [[false, false]] }, key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(paperImportApi.send(scope, setId, 3, 'not-a-key', signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(paperImportApi.addPage(scope, setId, { expectedVersion: 1, mediaType: 'image/gif' as never, data: 'AAAA' }, key, signal(), () => true))).kind).toBe('INVALID');
  expect(none).not.toHaveBeenCalled();
});

it('maps refusals to definitive outcomes, including an AI pause, and keeps only unknown ones for an exact retry', () => {
  expect(paperErrorFor(403, 'PAPER_IMPORT_AI_BLOCKED').kind).toBe('AI_BLOCKED');
  expect(paperErrorFor(403, 'PAPER_IMPORT_FORBIDDEN').kind).toBe('DENIED');
  expect(paperErrorFor(404, 'PAPER_IMPORT_GONE').kind).toBe('GONE');
  expect(paperErrorFor(400, 'PAPER_IMPORT_IMAGE_REFUSED').kind).toBe('IMAGE');
  expect(paperErrorFor(400, 'PAPER_IMPORT_TABLE_EMPTY').kind).toBe('EMPTY');
  expect(paperErrorFor(409, 'PAPER_IMPORT_PAGE_DUPLICATE').kind).toBe('DUPLICATE');
  expect(paperErrorFor(409, 'PAPER_IMPORT_READING_STALE').kind).toBe('CHANGED');
  expect(paperErrorFor(409, 'PAPER_IMPORT_BUSY').kind).toBe('UNKNOWN');
  expect(paperErrorFor(500, null).kind).toBe('UNKNOWN');
  expect(keepForRetry(new PaperError('UNKNOWN'))).toBe(true);
  expect(keepForRetry(new PaperError('CHANGED'))).toBe(false);
  expect(cleanCell('  Mina\u0000  Park‮ ')).toBe('Mina Park');
  expect(cleanCell('Mi\ufffdna \ud800')).toBe('Mi na');
  const long = 'a'.repeat(199) + '\u{1F600}';
  expect(clipCell(long)).toBe('a'.repeat(199)); expect(cleanCell(long + 'b')).toBe('a'.repeat(199));
  expect(filledRows([['', ' '], ['a', '']])).toBe(1);
});

const base = (over: Partial<PaperImportViewProps> = {}): PaperImportViewProps => ({ language: 'en', waiting: false, concealed: false, hasSchool: true,
  list: { state: 'READY', list: list as never }, selected: null, detail: { state: 'IDLE' }, draft: null, images: {}, viewing: 1, startKind: 'STUDENT_CARDS',
  confirmDelete: false, outcome: null, locked: false, canRetry: false, ...over });
const html = (over: Partial<PaperImportViewProps> = {}) => renderToStaticMarkup(<PaperImportView {...base(over)}/>);
const opened = (d: ReturnType<typeof detail>, over: Partial<PaperImportViewProps> = {}) => html({ selected: setId, detail: { state: 'READY', detail: d as never }, ...over });

it('shows nothing private before the school is verified, and the start card only to staff who may import', () => {
  for (const over of [{ waiting: true }, { concealed: true }, { hasSchool: false }]) {
    const out = html(over);
    expect(out).not.toContain('Your photo sets'); expect(out).not.toContain('What are you photographing?');
  }
  const home = html();
  expect(home).toContain('What are you photographing?'); expect(home).toContain('HON can read only the sample pages for now.');
  expect(home).toContain('Location and camera details are removed'); expect(home).toContain('erased the next time anyone at this school opens Import from photos');
  const denied = html({ list: { state: 'DENIED' } });
  expect(denied).toContain('You cannot import students at this school.'); expect(denied).not.toContain('What are you photographing?');
});

it('adds photos while open, then shows the photo beside an editable table with hard-to-read cells marked', () => {
  const open = opened(detail(), { images: { 1: { state: 'READY', src: 'data:image/png;base64,iVBORw0KGgo=' } } });
  expect(open).toContain('Take or choose photos'); expect(open).toContain('capture="environment"');
  expect(open).toContain('src="data:image/png;base64,iVBORw0KGgo="'); expect(open).toMatch(/<button type="button"[^>]*>Read with HON<\/button>/);
  expect(opened(detail({ pages: [] }, { pageCount: 0 }))).toMatch(/disabled=""[^>]*>Read with HON/);
  const unsure = [row.map((_, i) => i === 8)];
  const d = detail({ rows: [row], unsure }, read);
  const draft = { setId, version: 3, rows: [row], unsure, dirty: false };
  const table = opened(d, { draft });
  expect(table).not.toContain('Take or choose photos');
  expect(table).toContain('HON read the sample page.');
  expect(table).toContain('value="+12135550142"'); expect(table).toContain('data-unsure="true"'); expect(table).toContain('>check<');
  expect(table).toMatch(/<button type="button"[^>]*>Send to review<\/button>/); expect(table).not.toMatch(/disabled=""[^>]*>Send to review/);
  const dirty = opened(d, { draft: { ...draft, dirty: true } });
  expect(dirty).toContain('You have changes that are not saved.'); expect(dirty).toMatch(/disabled=""[^>]*>Send to review/);
  const blank = opened(detail({ rows: [], unsure: [] }, { ...read, readOutcome: 'NOT_READABLE' }), { draft: { ...draft, rows: [row.map(() => '')], unsure: [row.map(() => false)] } });
  expect(blank).toContain('HON can&#x27;t read photos yet.'); expect(blank).toMatch(/disabled=""[^>]*>Send to review/);
});

it('says where a sent table went, what deleted or expired photos mean, and offers Try again only for a kept command', () => {
  const sent = opened(detail({ rows: [row], unsure: [row.map(() => false)] }, { ...read, status: 'SENT', version: 4, sentAt: at, sentBatchId: id(60) }));
  expect(sent).toContain('Sent 1 rows to the student import review.'); expect(sent).toContain('href="/staff/migration/students"');
  const gone = opened(detail({ pages: [] }, { status: 'DELETED', pageCount: 0, deletedAt: at, deleteReason: 'EXPIRED' }));
  expect(gone).toContain('expired on'); expect(gone).not.toContain('Delete photos');
  expect(opened(detail(), { confirmDelete: true })).toContain('Yes, delete');
  expect(html({ outcome: { kind: 'UNKNOWN', action: 'send' }, canRetry: true, locked: true })).toContain('Try again');
  expect(html({ outcome: { kind: 'AI_BLOCKED', action: 'read' } })).toContain('Nothing was read');
  expect(html({ outcome: { kind: 'CHANGED', action: 'save' } })).not.toContain('Try again');
});

it('has every wording in English, Korean and Spanish, a Contacts route, and a verified-session page', async () => {
  const mod = await import('../src/components/paper-import/copy');
  expect(typeof mod.paperCopy).toBe('function');
  const keys = readFileSync('src/components/paper-import/copy.ts', 'utf8');
  expect(keys).toContain('const ko: Copy'); expect(keys).toContain('const es: Copy');
  for (const language of ['en', 'ko', 'es']) for (const k of ['title', 'standIn', 'privacy', 'e_AI_BLOCKED', 'fld_guardianMobile', 'fld_attendedOn'] as const) expect(paperCopy(language)(k)).toBeTruthy();
  expect(paperCopy('ko')('title')).toBe('사진으로 가져오기'); expect(paperCopy('es')('title')).toBe('Importar desde fotos');
  const students = SCHOOL_SHELL_NAV.find(g => g.key === 'students');
  expect(students?.routes.map(r => r.href)).toContain('/staff/migration/photos');
  expect(schoolShellActiveRoute('/staff/migration/photos')?.href).toBe('/staff/migration/photos');
  expect(shellText('ko', 'routePaperImport')).toBe('사진으로 가져오기');
  const pageSource = readFileSync('src/app/staff/migration/photos/page.tsx', 'utf8');
  expect(pageSource).toContain('await requireVerifiedWebSession()'); expect(pageSource).toContain("referrer: 'no-referrer'");
  expect(readFileSync('public/manus-routes.json', 'utf8')).toContain('"/staff/migration/photos"');
  for (const sample of ['student-card', 'contract', 'attendance-sheet']) expect(readFileSync(`public/paper-import-samples/${sample}.png`).subarray(1, 4).toString()).toBe('PNG');
});
