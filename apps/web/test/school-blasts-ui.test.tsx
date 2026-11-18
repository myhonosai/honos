import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SCHOOL_BLAST_DELIVERY_STATES, SCHOOL_BLAST_OUTCOMES } from '@hon/contracts';
import { SCHOOL_SHELL_NAV, schoolShellActiveRoute } from '../src/components/school-shell/catalog';
import { PERMISSION_LABELS, areaOf } from '../src/components/staff-permissions/catalog';
import { BlastError, blastApi, blastErrorFor, keepForRetry } from '../src/components/school-blasts/http';
import { BLAST_COPY } from '../src/components/school-blasts/copy';
import { blastDraftOf, blastInput, blastProblems, insertMergeTag, newBlastDraft, scheduleInstant, scheduleOk } from '../src/components/school-blasts/format';
import { SchoolBlastsView, type SchoolBlastsViewProps } from '../src/components/school-blasts/view';
import { id } from './account-status-fixtures';

// 0524: Marketing > Blasts. Staff write one email or text, check its audience and send it now or schedule it.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), key = id(77), blastId = id(30), scope = { organizationId: org, schoolId: school };
const meta = { requestId: id(5), correlationId: id(5) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as BlastError; } throw new Error('expected a failure'); };
const zero = (keys: readonly string[]) => Object.fromEntries(keys.map(k => [k, 0]));
const blast = (over: Record<string, unknown> = {}) => ({ blastId, name: 'Open house', channel: 'EMAIL', subject: 'Hi {{first_name}}', body: 'Hello {{first_name}}',
  audience: { groups: ['ACTIVE_STUDENTS'], tags: [] }, status: 'DRAFT', version: 1, sendAt: null, queuedAt: null, cancelledAt: null, recipientCount: null,
  outcomes: null, deliveries: null, createdAt: '2026-11-18T08:00:00.000Z', updatedAt: '2026-11-18T08:00:00.000Z', ...over });
const queued = (over: Record<string, unknown> = {}) => blast({ status: 'QUEUED', version: 2, queuedAt: '2026-11-18T08:05:00.000Z', recipientCount: 3,
  outcomes: { ...zero(SCHOOL_BLAST_OUTCOMES), QUEUED: 3, NO_CONSENT: 1 }, deliveries: { ...zero(SCHOOL_BLAST_DELIVERY_STATES), WAITING: 2, DELIVERED: 1 }, ...over });
const preview = (over: Record<string, unknown> = {}) => ({ blastId, version: 1, channel: 'EMAIL', matched: 4, outcomes: { ...zero(SCHOOL_BLAST_OUTCOMES), QUEUED: 3, NO_CONSENT: 1 },
  sample: { firstName: 'Ana', subject: 'Hi Ana', body: 'Hello Ana' }, ...over });
const save = (over: Record<string, unknown> = {}) => ({ blastId: null, expectedVersion: 0, name: 'Open house', channel: 'EMAIL', subject: 'Hi {{first_name}}', body: 'Hello {{first_name}}',
  audience: { groups: ['ACTIVE_STUDENTS'], tags: [] }, ...over }) as never;

it('reads are plain same-origin GETs with no key or command; answers must match what was asked', async () => {
  const f = stub(json({ data: [{ blastId, name: 'Open house', channel: 'EMAIL', status: 'DRAFT', version: 1, sendAt: null, queuedAt: null, recipientCount: null, updatedAt: '2026-11-18T08:00:00.000Z' }], meta }));
  expect((await blastApi.list(scope, signal(), () => true))[0]!.blastId).toBe(blastId);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/marketing/blasts`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
  stub(json({ data: blast({ blastId: id(31) }), meta }));
  expect((await fails(blastApi.get(scope, blastId, signal(), () => true))).kind).toBe('UNKNOWN');
  const a = stub(json({ data: preview(), meta }));
  expect((await blastApi.audience(scope, blastId, signal(), () => true)).matched).toBe(4);
  expect((a.mock.calls[0] as unknown as [string])[0]).toMatch(new RegExp(`/marketing/blasts/${blastId}/audience$`));
  for (const bad of [preview({ matched: 5 }), preview({ sample: null }), preview({ email: 'x@example.test' })]) {
    stub(json({ data: bad, meta }));
    expect((await fails(blastApi.audience(scope, blastId, signal(), () => true))).kind).toBe('UNKNOWN');
  }
});

it('each command sends its own name and key; receipts must be the next version and what was sent', async () => {
  const f = stub(json({ data: blast(), meta: { ...meta, replayed: false } }));
  expect((await blastApi.save(scope, save(), key, signal(), () => true)).version).toBe(1);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/marketing/blasts`);
  expect(init).toMatchObject({ method: 'POST', headers: { 'X-HON-Human-Command': 'marketing_blast.save', 'Idempotency-Key': key } });
  stub(json({ data: blast({ body: 'Other' }), meta: { ...meta, replayed: false } }));
  expect((await fails(blastApi.save(scope, save(), key, signal(), () => true))).kind).toBe('UNKNOWN');
  const s = stub(json({ data: queued(), meta: { ...meta, replayed: false } }));
  expect((await blastApi.send(scope, { blastId, expectedVersion: 1, sendAt: null }, key, signal(), () => true)).status).toBe('QUEUED');
  expect((s.mock.calls[0] as unknown as [string, RequestInit])[0]).toMatch(/\/marketing\/blasts\/send$/);
  expect((s.mock.calls[0] as unknown as [string, RequestInit])[1]).toMatchObject({ headers: { 'X-HON-Human-Command': 'marketing_blast.send' } });
  const at = new Date(Date.now() + 3_600_000).toISOString();
  stub(json({ data: queued(), meta: { ...meta, replayed: false } }));
  expect((await fails(blastApi.send(scope, { blastId, expectedVersion: 1, sendAt: at }, key, signal(), () => true))).kind).toBe('UNKNOWN');
  const c = stub(json({ data: queued({ status: 'CANCELLED', version: 3, sendAt: at, cancelledAt: '2026-11-18T08:06:00.000Z' }), meta: { ...meta, replayed: false } }));
  expect((await blastApi.cancel(scope, { blastId, expectedVersion: 2 }, key, signal(), () => true)).status).toBe('CANCELLED');
  expect((c.mock.calls[0] as unknown as [string, RequestInit])[1]).toMatchObject({ headers: { 'X-HON-Human-Command': 'marketing_blast.cancel' } });
  const silent = stub(json({}));
  expect((await fails(blastApi.save(scope, save({ body: 'Hi {{favorite_color}}' }), key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(blastApi.send(scope, { blastId, expectedVersion: 1, sendAt: new Date(Date.now() + 10_000).toISOString() }, key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(blastApi.cancel(scope, { blastId, expectedVersion: 1 }, 'not-a-key', signal(), () => true))).kind).toBe('INVALID');
  expect(silent).not.toHaveBeenCalled();
});

it('maps only exact refusals; busy keeps the same-key retry', () => {
  expect(blastErrorFor(403, 'SCHOOL_BLAST_FORBIDDEN').kind).toBe('DENIED');
  expect(blastErrorFor(409, 'VERSION_CONFLICT').kind).toBe('CHANGED');
  expect(blastErrorFor(409, 'BLAST_NOT_DRAFT').kind).toBe('NOT_DRAFT');
  expect(blastErrorFor(409, 'BLAST_NOT_CANCELLABLE').kind).toBe('NOT_CANCELLABLE');
  expect(blastErrorFor(409, 'BLAST_NO_RECIPIENTS').kind).toBe('NO_RECIPIENTS');
  expect(blastErrorFor(409, 'BLAST_AUDIENCE_TOO_LARGE').kind).toBe('TOO_LARGE');
  expect(blastErrorFor(409, 'BLAST_DAILY_LIMIT').kind).toBe('DAILY_LIMIT');
  expect(blastErrorFor(400, 'BLAST_TEXT_TOO_LONG').kind).toBe('TOO_LONG');
  expect(blastErrorFor(404, 'BLAST_NOT_FOUND').kind).toBe('GONE');
  expect(blastErrorFor(409, 'SCHOOL_BLAST_CONFLICT').kind).toBe('UNKNOWN');
  expect(blastErrorFor(503, null).kind).toBe('UNKNOWN');
  expect(keepForRetry(new BlastError('UNKNOWN'))).toBe(true);
  expect(keepForRetry(new BlastError('DAILY_LIMIT'))).toBe(false);
});

it('the composer checks like the server, inserts merge tags at the cursor, and reads schedule times as this device’s time', () => {
  const d = newBlastDraft('EMAIL');
  expect(blastProblems(d)).toEqual(['name', 'subject', 'body']);
  const ok = { ...d, name: ' Open house ', subject: 'Hi {{first_name}}', body: 'Hello {{first_name}}', tags: 'Adults, kids' };
  expect(blastProblems(ok)).toEqual([]);
  expect(blastInput(ok)).toEqual({ blastId: null, expectedVersion: 0, name: 'Open house', channel: 'EMAIL', subject: 'Hi {{first_name}}', body: 'Hello {{first_name}}',
    audience: { groups: ['ACTIVE_STUDENTS'], tags: ['Adults', 'kids'] } });
  expect(blastProblems({ ...ok, body: 'Hi {{favorite_color}}' })).toEqual(['mergeTag']);
  expect(blastProblems({ ...ok, groups: [], tags: 'a, A' })).toEqual(['groups', 'tags']);
  const text = { ...newBlastDraft('SMS'), name: 'Reminder', body: 'x'.repeat(1001) };
  expect(blastProblems(text)).toEqual(['bodyLength']);
  expect(blastInput({ ...text, subject: 'ignored' }).subject).toBeNull();
  expect(insertMergeTag('Hello !', 6, 6, 'first_name')).toEqual({ text: 'Hello {{first_name}}!', caret: 20 });
  expect(insertMergeTag('Hello NAME', 6, 10, 'last_name').text).toBe('Hello {{last_name}}');
  expect(blastDraftOf(blast({ audience: { groups: ['TRIAL'], tags: ['A', 'B'] } }) as never)).toMatchObject({ blastId, version: 1, groups: ['TRIAL'], tags: 'A, B' });
  expect(scheduleInstant('2026-02-30T10:00')).toBeNull();
  expect(scheduleInstant('tomorrow')).toBeNull();
  const local = new Date(Date.now() + 2 * 3_600_000);
  const value = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}T${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`;
  expect(scheduleOk(scheduleInstant(value))).toBe(true);
  expect(scheduleOk(new Date(Date.now() + 61 * 86_400_000).toISOString())).toBe(false);
});

const props = (over: Partial<SchoolBlastsViewProps> = {}): SchoolBlastsViewProps => ({ language: 'en', waiting: false, concealed: false, hasSchool: true,
  list: { state: 'READY', blasts: [] }, selected: null, draft: null, dirty: false, problems: [], preview: null, scheduleLocal: '', scheduleValid: false, ask: null,
  outcome: null, locked: false, canRetry: false, ...over });

it('the composer: merge tag buttons, groups, a save that waits for changes, and sending only after a fresh audience check and a confirm', () => {
  const draft = blastDraftOf(blast() as never);
  const fresh = renderToStaticMarkup(<SchoolBlastsView {...props({ draft: newBlastDraft('EMAIL'), dirty: true, problems: ['name', 'subject', 'body'] })} />);
  expect(fresh).toContain('New email'); for (const f of ['first_name', 'last_name', 'school_name', 'staff_name']) expect(fresh).toContain(`data-merge="${f}"`);
  expect(fresh).toContain('data-group="ACTIVE_STUDENTS"'); expect(fresh).toMatch(/disabled=""[^>]*data-action="save"/); expect(fresh).not.toContain('data-testid="blast-send"');
  expect(fresh).toContain('agreed to hear from you');
  const text = renderToStaticMarkup(<SchoolBlastsView {...props({ draft: newBlastDraft('SMS'), dirty: true })} />);
  expect(text).not.toContain('data-field="subject"'); expect(text).toContain('Pictures and video are coming later');
  const unsaved = renderToStaticMarkup(<SchoolBlastsView {...props({ draft, dirty: true })} />);
  expect(unsaved).toContain('Save your changes before you send'); expect(unsaved).toMatch(/disabled=""[^>]*data-action="preview"/); expect(unsaved).not.toContain('data-action="send-now"');
  const checked = renderToStaticMarkup(<SchoolBlastsView {...props({ draft, preview: { state: 'READY', preview: preview() as never } })} />);
  expect(checked).toContain('4 people match'); expect(checked).toContain('data-outcome="NO_CONSENT">1<'); expect(checked).toContain('How it looks for Ana');
  expect(checked).toContain('data-action="send-now"'); expect(checked).toMatch(/disabled=""[^>]*data-action="schedule"/); expect(checked).not.toContain('data-testid="blast-confirm"');
  const nobody = renderToStaticMarkup(<SchoolBlastsView {...props({ draft, preview: { state: 'READY', preview: preview({ matched: 1, outcomes: { ...zero(SCHOOL_BLAST_OUTCOMES), NO_ADDRESS: 1 }, sample: null }) as never } })} />);
  expect(nobody).toContain('Nobody in this audience'); expect(nobody).not.toContain('data-action="send-now"');
  const confirm = renderToStaticMarkup(<SchoolBlastsView {...props({ draft, preview: { state: 'READY', preview: preview() as never }, ask: { sendAt: null, recipients: 3 } })} />);
  expect(confirm).toContain('Send to 3 people?'); expect(confirm).toContain('data-action="confirm"');
});

it('a sent blast is read-only with delivery counts; only a future scheduled one can be cancelled', () => {
  const sent = renderToStaticMarkup(<SchoolBlastsView {...props({ selected: { state: 'READY', blast: queued() as never } })} />);
  expect(sent).toContain('data-status="QUEUED"'); expect(sent).toContain('data-delivery="WAITING">2<'); expect(sent).toContain('data-delivery="DELIVERED">1<');
  expect(sent).not.toContain('data-delivery="FAILED"'); expect(sent).not.toContain('data-action="cancel"'); expect(sent).not.toContain('data-field="body"');
  expect(sent).toContain('Until then they wait');
  const at = '2026-11-20T18:00:00.000Z';
  const later = renderToStaticMarkup(<SchoolBlastsView {...props({ now: Date.parse('2026-11-18T09:00:00.000Z'), selected: { state: 'READY', blast: queued({ sendAt: at }) as never } })} />);
  expect(later).toContain('data-action="cancel"'); expect(later).toContain('Scheduled for');
  const past = renderToStaticMarkup(<SchoolBlastsView {...props({ now: Date.parse('2026-11-21T09:00:00.000Z'), selected: { state: 'READY', blast: queued({ sendAt: at }) as never } })} />);
  expect(past).not.toContain('data-action="cancel"');
});

it('plain states and languages', () => {
  expect(renderToStaticMarkup(<SchoolBlastsView {...props({ list: { state: 'DENIED' } })} />)).toContain('data-testid="blast-denied"');
  expect(renderToStaticMarkup(<SchoolBlastsView {...props({ list: { state: 'UNAVAILABLE' } })} />)).toContain('could not be read');
  expect(renderToStaticMarkup(<SchoolBlastsView {...props({ concealed: true, selected: { state: 'READY', blast: queued() as never } })} />)).not.toContain('Open house');
  expect(renderToStaticMarkup(<SchoolBlastsView {...props({ outcome: { kind: 'UNKNOWN' }, canRetry: true })} />)).toContain('won’t be sent twice');
  expect(renderToStaticMarkup(<SchoolBlastsView {...props({ outcome: { kind: 'DAILY_LIMIT' } })} />)).toContain('10 blasts in the last 24 hours');
  for (const language of ['ko', 'es'] as const) expect(renderToStaticMarkup(<SchoolBlastsView {...props({ language })} />)).toContain(BLAST_COPY[language].pageTitle);
});

it('the page is under Marketing in the shell and the route manifest, both permissions have names, and nothing stays on the device', () => {
  expect(schoolShellActiveRoute('/staff/marketing/blasts')).toBeTruthy();
  expect(JSON.stringify(SCHOOL_SHELL_NAV.find(item => item.key === 'marketing'))).toContain('/staff/marketing/blasts');
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
  expect(manifest.routes.filter((r: { path: string }) => r.path === '/staff/marketing/blasts')).toHaveLength(1);
  expect(PERMISSION_LABELS['marketing.blast.read']).toBe('See blasts');
  expect(PERMISSION_LABELS['marketing.blast.send']).toBe('Send blasts');
  expect(areaOf('marketing.blast.send').key).toBe('marketing');
  for (const file of ['view.tsx', 'school-blasts.tsx', 'http.ts', 'format.ts']) {
    expect(readFileSync(`src/components/school-blasts/${file}`, 'utf8')).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  }
});
