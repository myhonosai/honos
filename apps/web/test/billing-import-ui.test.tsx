import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BILLING_IMPORT_FIELDS, BILLING_IMPORT_REQUIRED } from '@hon/contracts';
import { BILLING_IMPORT_LANGUAGES, billingImportText } from '../src/components/billing-import/copy';
import { ImportError, billingImportApi, guessMapping, importErrorFor, keepForRetry, mappingProblem } from '../src/components/billing-import/http';
import { BillingImportView, effectiveChoice, money, problemText, unsavedDecisions, type BillingImportViewProps } from '../src/components/billing-import/view';
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
const batch = (over: Record<string, unknown> = {}) => ({ id: batchId, kind: 'MEMBERSHIPS', version: 1, status: 'STAGED', rowCount: 2, validCount: 1, importCount: 0, skipCount: 0,
  undecidedCount: 2, importedCount: 0, balanceCount: 0, checksum: 'a'.repeat(64), schoolToday: '2026-11-13', schoolTimezone: 'America/Los_Angeles',
  createdAt: '2026-11-13T02:00:00.000Z', finalizedAt: null, ...over });
const listRaw = () => ({ batches: [batch()], fields: BILLING_IMPORT_FIELDS, required: BILLING_IMPORT_REQUIRED, maxBytes: 262144, maxRows: 1000, maxColumns: 24 });
const headers = ['First', 'Last', 'Plan', 'Price', 'Frequency', 'Start', 'Next charge', 'Balance'];
const mapping = { First: 'studentGivenName', Last: 'studentFamilyName', Plan: 'planName', Price: 'amount', Frequency: 'frequency', Start: 'startedOn',
  'Next charge': 'nextChargeOn', Balance: 'balanceOwed' } as const;
const row = (index: number, over: Record<string, unknown> = {}) => ({ index, raw: ['Ava', 'Stone', 'Black Belt Club', '149', 'monthly', '2026-01-05', '2026-12-01', '75.50'],
  choice: null, created: null, errors: [], matchedStudentProfileId: id(60), payerPersonId: id(61), payerName: 'Sam Stone',
  normalized: { studentGivenName: 'Ava', studentFamilyName: 'Stone', planName: 'Black Belt Club', amount: '149', currency: 'USD', frequency: 'MONTHLY',
    startedOn: '2026-01-05', nextChargeOn: '2026-12-01', balanceOwed: '75.50', planCode: 'BLACK_BELT_CLUB', planMatched: true, amountMinor: '14900', balanceMinor: '7550' }, ...over });
const problemRow = (index: number) => row(index, { matchedStudentProfileId: null, payerPersonId: null, payerName: null,
  errors: ['payer:CHOOSE_PAYER', 'nextChargeOn:OUT_OF_RANGE', 'student:HAS_MEMBERSHIP'],
  normalized: { studentGivenName: 'Leo', studentFamilyName: 'Park', planName: 'Little Ninjas', amount: '99', currency: 'USD', frequency: 'WEEKLY',
    startedOn: '2026-02-01', nextChargeOn: '2025-01-01', planCode: 'LITTLE_NINJAS', planMatched: false, amountMinor: '9900', balanceMinor: '' } });
const detail = (over: Record<string, unknown> = {}) => ({ batch: batch(), headers, mapping, rows: [row(1), problemRow(2)], ...over });

it('reads as plain same-origin GETs with no query, no key and no x-hon header, and accepts only this batch', async () => {
  const f = stub(json({ data: listRaw(), meta }));
  const read = await billingImportApi.list({ organizationId: org.toUpperCase(), schoolId: school }, signal(), () => true);
  expect(read.batches[0]?.kind).toBe('MEMBERSHIPS');
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/billing-imports`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
  const g = stub(json({ data: detail(), meta }));
  await expect(billingImportApi.detail(scope, batchId.toUpperCase(), signal(), () => true)).resolves.toMatchObject({ rows: [{ index: 1, payerName: 'Sam Stone' }, { index: 2 }] });
  expect((g.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/organizations/${org}/schools/${school}/billing-imports/${batchId}`);
  stub(json({ data: detail({ batch: batch({ id: id(41) }) }), meta }));
  expect((await fails(billingImportApi.detail(scope, batchId, signal(), () => true))).kind).toBe('UNKNOWN');
  // A row with problems that still claims a payer is not a shape this screen accepts.
  stub(json({ data: detail({ rows: [row(1), { ...problemRow(2), payerPersonId: id(62) }] }), meta }));
  expect((await fails(billingImportApi.detail(scope, batchId, signal(), () => true))).kind).toBe('UNKNOWN');
});

it('sends each command with its own name and key, and refuses bad input before anything is sent', async () => {
  const csv = `${headers.join(',')}\nAva,Stone,Black Belt Club,149,monthly,2026-01-05,2026-12-01,75.50\n`;
  const f = stub(json({ data: batch(), meta: { ...meta, replayed: false } }));
  await billingImportApi.stage(scope, { csv, mapping }, key, signal(), () => true);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/billing-imports`);
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': 'billing.import.stage', 'Idempotency-Key': key, 'Content-Type': 'application/json' });
  expect(JSON.parse(init.body as string)).toEqual({ csv, mapping });
  const g = stub(json({ data: batch({ version: 2, importCount: 1, skipCount: 1, undecidedCount: 0 }), meta }));
  await billingImportApi.decide(scope, batchId, { expectedVersion: 1, decisions: [{ index: 1, choice: 'IMPORT' }, { index: 2, choice: 'SKIP' }] }, key, signal(), () => true);
  expect((g.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe(`/api/v1/organizations/${org}/schools/${school}/billing-imports/${batchId}/decisions`);
  expect((g.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'X-HON-Human-Command': 'billing.import.decide' });
  const h = stub(json({ data: batch({ version: 3, status: 'FINALIZED', importCount: 1, skipCount: 1, undecidedCount: 0, importedCount: 1, balanceCount: 1,
    finalizedAt: '2026-11-13T03:00:00.000Z' }), meta }));
  await billingImportApi.finalize(scope, batchId, { expectedVersion: 2, selectedIndices: [1] }, key, signal(), () => true);
  expect((h.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe(`/api/v1/organizations/${org}/schools/${school}/billing-imports/${batchId}/finalize`);
  expect((h.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'X-HON-Human-Command': 'billing.import.finalize' });
  stub(json({ data: batch({ id: id(41), version: 2, importCount: 1, skipCount: 1, undecidedCount: 0 }), meta }));
  expect((await fails(billingImportApi.decide(scope, batchId, { expectedVersion: 1, decisions: [{ index: 1, choice: 'SKIP' }] }, key, signal(), () => true))).kind).toBe('UNKNOWN');
  const none = stub(json({}));
  expect((await fails(billingImportApi.stage(scope, { csv, mapping: { ...mapping, 'Next charge': 'ignore' } }, key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(billingImportApi.stage(scope, { csv, mapping: { ...mapping, Balance: 'className' as never } }, key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(billingImportApi.stage(scope, { csv, mapping }, 'not-a-key', signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(billingImportApi.decide(scope, batchId, { expectedVersion: 1, decisions: [] }, key, signal(), () => true))).kind).toBe('INVALID');
  expect(none).not.toHaveBeenCalled();
});

it('maps refusals to definitive outcomes, a stale import included, and keeps only unknown ones for an exact retry', () => {
  expect(importErrorFor(403, 'BILLING_IMPORT_FORBIDDEN').kind).toBe('DENIED');
  expect(importErrorFor(404, 'BILLING_IMPORT_NOT_FOUND').kind).toBe('GONE');
  expect(importErrorFor(400, 'BILLING_IMPORT_ROW_NOT_IMPORTABLE').kind).toBe('NOT_IMPORTABLE');
  expect(importErrorFor(400, 'BILLING_IMPORT_INVALID').kind).toBe('INVALID');
  expect(importErrorFor(409, 'VERSION_CONFLICT').kind).toBe('CHANGED');
  expect(importErrorFor(409, 'BILLING_IMPORT_STALE').kind).toBe('STALE');
  expect(importErrorFor(409, 'BILLING_IMPORT_SELECTION_REQUIRED').kind).toBe('SELECTION');
  expect(importErrorFor(409, 'BILLING_IMPORT_BUSY').kind).toBe('UNKNOWN');
  expect(importErrorFor(503, 'BILLING_IMPORT_UNAVAILABLE').kind).toBe('UNKNOWN');
  expect(keepForRetry(new ImportError('UNKNOWN'))).toBe(true);
  expect(keepForRetry(new ImportError('RATE'))).toBe(true);
  expect(keepForRetry(new ImportError('STALE'))).toBe(false);
  expect(keepForRetry(new ImportError('CHANGED'))).toBe(false);
});

it('suggests a mapping from familiar billing export headers, and checks it like the server', () => {
  const guess = guessMapping(['First Name', 'Last Name', 'DOB', 'Parent First Name', 'Parent Last Name', 'Membership Type', 'Recurring Amount', 'Billing Cycle',
    'Start Date', 'Expiration Date', 'Next Billing Date', 'Balance Due', 'Email']);
  expect(guess).toEqual({ 'First Name': 'studentGivenName', 'Last Name': 'studentFamilyName', DOB: 'birthDate', 'Parent First Name': 'payerGivenName',
    'Parent Last Name': 'payerFamilyName', 'Membership Type': 'planName', 'Recurring Amount': 'amount', 'Billing Cycle': 'frequency', 'Start Date': 'startedOn',
    'Expiration Date': 'endsOn', 'Next Billing Date': 'nextChargeOn', 'Balance Due': 'balanceOwed', Email: 'ignore' });
  expect(mappingProblem(guess)).toBeNull();
  expect(mappingProblem({ A: 'studentGivenName', B: 'studentFamilyName' })).toBe('REQUIRED');
  expect(mappingProblem({ ...mapping, X: 'amount' })).toBe('DUPLICATE');
  // Two "Price"-like headers: only the first takes the field.
  expect(guessMapping(['Price', 'Fee'])).toEqual({ Price: 'amount', Fee: 'ignore' });
});

const base = (over: Partial<BillingImportViewProps> = {}): BillingImportViewProps => ({ language: 'en', waiting: false, concealed: false, hasSchool: true,
  list: { state: 'READY', list: listRaw() as never }, selected: null, detail: { state: 'IDLE' }, upload: { phase: 'NONE' }, choices: {}, outcome: null,
  locked: false, canRetry: false, ...over });
const html = (over: Partial<BillingImportViewProps> = {}) => renderToStaticMarkup(<BillingImportView {...base(over)}/>);

it('shows nothing private before the school is verified, and upload only to staff who may import', () => {
  for (const over of [{ waiting: true }, { concealed: true }, { hasSchool: false }]) {
    const out = html(over);
    expect(out).not.toContain('Recent imports'); expect(out).not.toContain('Upload a CSV');
  }
  const open = html();
  expect(open).toContain('Upload a CSV file'); expect(open).toContain('It charges no card and sends no message.');
  expect(open).toContain('Import your students first');
  const denied = html({ list: { state: 'DENIED' } });
  expect(denied).toContain('You cannot import memberships at this school.'); expect(denied).not.toContain('Upload a CSV file');
  const mapped = html({ upload: { phase: 'MAPPING', fileName: 'members.csv', csv: 'A,B\n1,2\n', headers: ['A', 'B'], mapping: { A: 'studentGivenName', B: 'ignore' } } });
  expect(mapped).toContain('Match columns to student first name, last name, plan, price, billing frequency, start date and next charge date.');
  expect(mapped).toContain('Next charge date (required)'); expect(mapped).not.toContain('Balance owed (required)');
  expect(mapped).toMatch(/<button type="submit"[^>]*disabled/);
});

it('reviews each row with its payer, terms in money, the opening balance and problems that can only be skipped', () => {
  const read = detail();
  const view = html({ selected: batchId, detail: { state: 'READY', detail: read as never } });
  expect(view).toContain('Paid by Sam Stone');
  expect(view).toContain('Matches your plan catalog'); expect(view).toContain('Plan code LITTLE_NINJAS');
  expect(view).toContain('$149.00 monthly'); expect(view).toContain('$99.00 weekly');
  expect(view).toContain('$75.50, due Nov 13, 2026'); expect(view).toContain('Nothing owed');
  expect(view).toContain('No end date'); expect(view).toContain('Next charge Dec 1, 2026');
  expect(view).toContain('Payer: the family has more than one guardian; add payer name columns');
  expect(view).toContain('Next charge date: must be today or later, within about a year');
  expect(view).toContain('Student: this student already has a membership here');
  expect(view).toContain('disabled="" name="choice-2" value="IMPORT"');
  expect(view).toMatch(/Import 0 memberships<\/button>/);
  const rows = read.rows as never as Parameters<typeof effectiveChoice>[0][];
  expect(effectiveChoice(rows[1]!, { 2: 'IMPORT' })).toBe('SKIP');
  expect(unsavedDecisions(read as never, { 1: 'SKIP' })).toEqual([{ index: 1, choice: 'SKIP' }, { index: 2, choice: 'SKIP' }]);
  expect(problemText('x:NEW_CODE', (k) => billingImportText('en', k))).toBe('x: needs checking');
  expect(money('en', '5000', 'JPY')).toBe('¥5,000'); expect(money('en', '14900', 'USD')).toBe('$149.00');
});

it('after import, says what was created and where to go next, and explains a stale import', () => {
  const done = detail({ batch: batch({ version: 3, status: 'FINALIZED', importCount: 1, skipCount: 1, undecidedCount: 0, importedCount: 1, balanceCount: 1,
    finalizedAt: '2026-11-13T03:00:00.000Z' }),
    rows: [row(1, { choice: 'IMPORT', created: { billingAccountId: id(70), membershipId: id(71), scheduleId: id(72), invoiceId: id(73) } }), { ...problemRow(2), choice: 'SKIP' }] });
  const final = html({ selected: batchId, detail: { state: 'READY', detail: done as never } });
  expect(final).toContain('1 memberships imported on'); expect(final).toContain('with 1 opening balances');
  expect(final).toContain('href="/staff/memberships"'); expect(final).toContain('href="/staff/billing/receivables"'); expect(final).toContain('href="/staff/billing/saved-payment-methods"');
  expect(final).toContain('Live charging stays off');
  expect(final).toContain('Not imported'); expect(final).not.toContain('type="radio"');
  const stale = html({ outcome: { kind: 'STALE', action: 'finalize' } });
  expect(stale).toContain('Upload the file again'); expect(stale).not.toContain('Try again');
  expect(html({ outcome: { kind: 'UNKNOWN', action: 'finalize' }, canRetry: true, locked: true })).toContain('Try again');
});

it('has every wording in English, Korean and Spanish, and a staff billing route', () => {
  const keys = Object.keys(BILLING_IMPORT_LANGUAGES.en).sort();
  expect(Object.keys(BILLING_IMPORT_LANGUAGES.ko).sort()).toEqual(keys); expect(Object.keys(BILLING_IMPORT_LANGUAGES.es).sort()).toEqual(keys);
  expect(billingImportText('ko', 'title')).toBe('회원권 및 잔액 가져오기');
  const billing = SCHOOL_SHELL_NAV.find(g => g.key === 'billing');
  expect(billing?.routes.map(r => r.href)).toContain('/staff/migration/memberships');
  expect(schoolShellActiveRoute('/staff/migration/memberships')?.href).toBe('/staff/migration/memberships');
  const page = readFileSync('src/app/staff/migration/memberships/page.tsx', 'utf8');
  expect(page).toContain('await requireVerifiedWebSession()');
  expect(readFileSync('public/manus-routes.json', 'utf8')).toContain('"/staff/migration/memberships"');
});
