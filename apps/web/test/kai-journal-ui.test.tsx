import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { kaiJournalPeriod } from '@hon/contracts';
import { SCHOOL_SHELL_NAV, schoolShellActiveRoute } from '../src/components/school-shell/catalog';
import { PERMISSION_LABELS, areaOf } from '../src/components/staff-permissions/catalog';
import { JournalError, journalApi, journalErrorFor, keepForRetry } from '../src/components/kai-journal/http';
import { JOURNAL_COPY } from '../src/components/kai-journal/copy';
import { addTopic, draftOf, draftProblems, newDraft, saveInput } from '../src/components/kai-journal/draft';
import { KaiJournalView, type KaiJournalViewProps } from '../src/components/kai-journal/view';
import { id } from './account-status-fixtures';

// 0476: the Kai teaching journal. Instructors log what they taught, recall it and see pattern notes (no AI).
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), key = id(77), entryId = id(20), scope = { organizationId: org, schoolId: school };
const meta = { requestId: id(5), correlationId: id(5) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as JournalError; } throw new Error('expected a failure'); };
const entry = (over: Record<string, unknown> = {}) => ({ entryId, taughtOn: '2026-11-17', className: 'Kids 6-8', notes: 'Roundhouse kick drills.\nPartner blocking.',
  topics: ['Roundhouse kick', 'Blocking'], source: 'SPOKEN', status: 'ACTIVE', shared: false, version: 1, createdAt: '2026-11-17T20:00:00.000Z', updatedAt: '2026-11-17T20:00:00.000Z', ...over });
const journal = (over: Record<string, unknown> = {}) => ({ timezone: 'America/Los_Angeles', today: '2026-11-18', from: '2026-08-20', to: '2026-11-19', entries: [entry()], ...over });
const input = (over: Record<string, unknown> = {}) => ({ entryId: null, expectedVersion: 0, taughtOn: '2026-11-17', className: 'Kids 6-8', notes: 'Roundhouse kick drills.',
  topics: ['Roundhouse kick'], source: 'TYPED', status: 'ACTIVE', shared: false, ...over }) as never;
const teamEntry = (over: Record<string, unknown> = {}) => ({ entryId: id(30), authorName: 'Coach Lee', taughtOn: '2026-11-16', className: null, notes: 'Sparring footwork.',
  topics: ['Footwork'], updatedAt: '2026-11-16T20:00:00.000Z', ...over });
const teamRead = (over: Record<string, unknown> = {}) => ({ today: '2026-11-18', from: '2026-10-19', to: '2026-11-19', entries: [teamEntry()], ...over });

it('reads a range as a plain same-origin GET with no key and no x-hon header, and refuses drift', async () => {
  const f = stub(json({ data: journal(), meta }));
  expect((await journalApi.read({ organizationId: org.toUpperCase(), schoolId: school }, '2026-08-20', '2026-11-19', signal(), () => true)).entries).toHaveLength(1);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/staff/kai/journal/entries/2026-08-20/2026-11-19`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
  for (const bad of [journal({ from: '2026-08-21' }), journal({ extra: 1 }), journal({ entries: [entry({ taughtOn: '2026-08-01' })] }), journal({ entries: [entry(), entry()] }),
    journal({ entries: [entry({ status: 'REMOVED', notes: null, className: null, topics: [] })] }), journal({ entries: [entry({ notes: '<b>x</b>' })] })]) {
    stub(json({ data: bad, meta }));
    expect((await fails(journalApi.read(scope, '2026-08-20', '2026-11-19', signal(), () => true))).kind).toBe('UNKNOWN');
  }
  const silent = stub(json({}));
  expect((await fails(journalApi.read(scope, '2026-01-01', '2026-11-19', signal(), () => true))).kind).toBe('INVALID');
  expect(silent).not.toHaveBeenCalled();
});

it('a save sends its own command and key and must answer the next version of the same entry', async () => {
  const f = stub(json({ data: entry({ source: 'TYPED' }), meta: { ...meta, replayed: false } }));
  expect((await journalApi.save(scope, input(), key, signal(), () => true)).version).toBe(1);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/staff/kai/journal/entries`);
  expect(init).toMatchObject({ method: 'POST', headers: { 'X-HON-Human-Command': 'kai_journal.save', 'Idempotency-Key': key } });
  expect(JSON.parse(String(init.body))).toEqual(input());
  for (const bad of [entry({ version: 2 }), entry({ status: 'REMOVED', notes: null, className: null, topics: [] })]) {
    stub(json({ data: bad, meta: { ...meta, replayed: false } }));
    expect((await fails(journalApi.save(scope, input(), key, signal(), () => true))).kind).toBe('UNKNOWN');
  }
  stub(json({ data: entry({ entryId: id(21), version: 2 }), meta: { ...meta, replayed: false } }));
  expect((await fails(journalApi.save(scope, input({ entryId, expectedVersion: 1 }), key, signal(), () => true))).kind).toBe('UNKNOWN');
  const silent = stub(json({}));
  expect((await fails(journalApi.save(scope, input({ notes: '' }), key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(journalApi.save(scope, input(), 'not-a-key', signal(), () => true))).kind).toBe('INVALID');
  expect(silent).not.toHaveBeenCalled();
});

it('the team journal is a plain GET of shared entries with display names only, and refuses drift', async () => {
  const f = stub(json({ data: teamRead(), meta }));
  expect((await journalApi.readTeam(scope, '2026-10-19', '2026-11-19', signal(), () => true)).entries[0]).toMatchObject({ authorName: 'Coach Lee' });
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/staff/kai/journal/team/2026-10-19/2026-11-19`);
  expect(init).toMatchObject({ method: 'GET' });
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
  for (const bad of [teamRead({ entries: [teamEntry({ authorPrincipalId: id(9) })] }), teamRead({ entries: [teamEntry({ taughtOn: '2026-10-01' })] }),
    teamRead({ entries: [teamEntry(), teamEntry()] }), teamRead({ entries: [teamEntry({ authorName: 'a\nb' })] }), teamRead({ entries: [teamEntry({ version: 1 })] })]) {
    stub(json({ data: bad, meta }));
    expect((await fails(journalApi.readTeam(scope, '2026-10-19', '2026-11-19', signal(), () => true))).kind).toBe('UNKNOWN');
  }
  stub(json({ code: 'KAI_JOURNAL_FORBIDDEN' }, 403));
  expect((await fails(journalApi.readTeam(scope, '2026-10-19', '2026-11-19', signal(), () => true))).kind).toBe('DENIED');
});

it('sharing is off by default, kept by edits, sent with the save and dropped on remove', async () => {
  expect(newDraft('2026-11-18').shared).toBe(false);
  expect(saveInput({ ...newDraft('2026-11-18'), notes: 'x' }).shared).toBe(false);
  expect(saveInput({ ...draftOf(entry({ shared: true }) as never) }).shared).toBe(true);
  expect(saveInput(draftOf(entry({ shared: true }) as never), true)).toMatchObject({ status: 'REMOVED', shared: false });
  stub(json({ data: entry({ source: 'TYPED', shared: false }), meta: { ...meta, replayed: false } }));
  expect((await fails(journalApi.save(scope, input({ shared: true }), key, signal(), () => true))).kind).toBe('UNKNOWN');
  const f = stub(json({ data: entry({ source: 'TYPED', shared: true }), meta: { ...meta, replayed: false } }));
  expect((await journalApi.save(scope, input({ shared: true }), key, signal(), () => true)).shared).toBe(true);
  expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body)).shared).toBe(true);
});

it('maps only exact refusals; busy keeps the same-key retry', () => {
  expect(journalErrorFor(403, 'KAI_JOURNAL_FORBIDDEN').kind).toBe('DENIED');
  expect(journalErrorFor(409, 'VERSION_CONFLICT').kind).toBe('CHANGED');
  expect(journalErrorFor(409, 'KAI_JOURNAL_ENTRY_REMOVED').kind).toBe('GONE');
  expect(journalErrorFor(404, 'KAI_JOURNAL_ENTRY_NOT_FOUND').kind).toBe('GONE');
  expect(journalErrorFor(409, 'IDEMPOTENCY_KEY_REUSED').kind).toBe('INVALID');
  expect(journalErrorFor(409, 'KAI_JOURNAL_CONFLICT').kind).toBe('UNKNOWN');
  expect(journalErrorFor(503, null).kind).toBe('UNKNOWN');
  expect(keepForRetry(new JournalError('UNKNOWN'))).toBe(true);
  expect(keepForRetry(new JournalError('CHANGED'))).toBe(false);
});

it('the form checks date, class, notes and topics before sending; remove sends the entry as read', () => {
  const today = '2026-11-18';
  expect(draftProblems({ ...newDraft(today), notes: 'Kicks' }, today)).toEqual([]);
  expect(draftProblems(newDraft(today), today)).toEqual(['notes']);
  expect(draftProblems({ ...newDraft('2026-11-19'), notes: 'x', className: 'a<b' }, today)).toEqual(['date', 'className']);
  let d = { ...newDraft(today), notes: 'x', topicInput: '  Front  kick ' };
  d = addTopic(d); expect(d.topics).toEqual(['Front kick']); expect(d.topicInput).toBe('');
  expect(addTopic(d, 'front KICK').topics).toEqual(['Front kick']);
  expect(saveInput({ ...newDraft(today), notes: '  line one \r\nline two  ', className: '  ' })).toMatchObject({ notes: 'line one\nline two', className: null, status: 'ACTIVE', entryId: null });
  expect(saveInput(draftOf(entry() as never), true)).toMatchObject({ entryId, expectedVersion: 1, status: 'REMOVED', notes: 'Roundhouse kick drills.\nPartner blocking.' });
});

const props = (over: Partial<KaiJournalViewProps> = {}): KaiJournalViewProps => ({ language: 'en', waiting: false, concealed: false, hasSchool: true, today: '2026-11-18',
  read: { state: 'READY', read: journal() as never }, draft: newDraft('2026-11-18'), problems: [], hints: [], speech: { supported: true, listening: false, failed: false },
  confirmingRemove: false, outcome: null, locked: false, canRetry: false, question: '', recall: null, suggestions: [], team: { state: 'READY', entries: [teamEntry()] as never }, ...over });

it('the page: log form with voice, ask box, pattern notes and recent entries', () => {
  const page = renderToStaticMarkup(<KaiJournalView {...props({ hints: ['Forms'], suggestions: [{ kind: 'FOCUS', topic: 'Roundhouse kick', count: 5, total: 7 }, { kind: 'LOG', lastDate: '2026-11-05' }] })} />);
  expect(page).toContain('Tell Kai about today’s class'); expect(page).toContain('Speak'); expect(page).toContain('Avoid student names');
  expect(page).toContain('+ Forms'); expect(page).toContain('Ask Kai about your journal'); expect(page).toContain('What did we work on last week?');
  expect(page).toContain('Roundhouse kick came up in 5 of your last 7 classes'); expect(page).toContain('since Thu, Nov 5');
  expect(page).toContain('not AI'); expect(page).toContain(`data-entry="${entryId}"`); expect(page).toContain('spoken');
  expect(renderToStaticMarkup(<KaiJournalView {...props({ speech: { supported: false, listening: false, failed: false } })} />)).not.toContain('>Speak<');
  expect(renderToStaticMarkup(<KaiJournalView {...props({ speech: { supported: true, listening: true, failed: false } })} />)).toContain('Listening');
  const editing = renderToStaticMarkup(<KaiJournalView {...props({ draft: draftOf(entry() as never) })} />);
  expect(editing).toContain('Edit this entry'); expect(editing).toContain('Remove entry');
  expect(renderToStaticMarkup(<KaiJournalView {...props({ draft: draftOf(entry() as never), confirmingRemove: true })} />)).toContain('Its notes are erased');
  expect(renderToStaticMarkup(<KaiJournalView {...props({ problems: ['notes'] })} />)).toContain('Write what you taught');
  expect(renderToStaticMarkup(<KaiJournalView {...props({ suggestions: [] })} />)).toContain('Log a few classes with topics');
  expect(page).toContain('Share this entry with my school’s teaching team'); expect(page).not.toMatch(/type="checkbox" checked/);
  expect(page).toContain('Team journal'); expect(page).toContain('Coach Lee'); expect(page).toContain('Sparring footwork.');
  expect(renderToStaticMarkup(<KaiJournalView {...props({ draft: draftOf(entry({ shared: true }) as never) })} />)).toMatch(/type="checkbox" checked/);
  expect(renderToStaticMarkup(<KaiJournalView {...props({ read: { state: 'READY', read: journal({ entries: [entry({ shared: true })] }) as never } })} />)).toContain('data-tag="shared"');
  expect(renderToStaticMarkup(<KaiJournalView {...props({ team: { state: 'READY', entries: [] } })} />)).toContain('Nobody has shared an entry');
  expect(renderToStaticMarkup(<KaiJournalView {...props({ team: { state: 'DENIED' } })} />)).toContain('not available to you');
});

it('recall shows the range Kai understood, the topic tally and the entries', () => {
  const period = kaiJournalPeriod('What did we work on last week?', '2026-11-18');
  const shown = renderToStaticMarkup(<KaiJournalView {...props({ recall: { state: 'READY', period, entries: [entry({ taughtOn: '2026-11-12' })] as never, topics: [{ topic: 'Roundhouse kick', count: 2 }, { topic: 'Blocking', count: 1 }] } })} />);
  expect(shown).toContain('Your journal from Mon, Nov 9 to Sun, Nov 15'); expect(shown).toContain('1 class logged.'); expect(shown).toContain('Roundhouse kick (2), Blocking');
  const guess = kaiJournalPeriod('kicks?', '2026-11-18');
  const none = renderToStaticMarkup(<KaiJournalView {...props({ recall: { state: 'READY', period: guess, entries: [], topics: [] } })} />);
  expect(none).toContain('I didn’t catch a time'); expect(none).toContain('Nothing logged for these days.');
});

it('plain states and languages', () => {
  expect(renderToStaticMarkup(<KaiJournalView {...props({ read: { state: 'DENIED' } })} />)).toContain('Keep their own Kai teaching journal');
  expect(renderToStaticMarkup(<KaiJournalView {...props({ concealed: true })} />)).not.toContain('Roundhouse');
  expect(renderToStaticMarkup(<KaiJournalView {...props({ read: { state: 'UNAVAILABLE' } })} />)).toContain('Refresh');
  expect(renderToStaticMarkup(<KaiJournalView {...props({ outcome: { kind: 'UNKNOWN' }, canRetry: true })} />)).toContain('Try again');
  for (const language of ['ko', 'es'] as const) {
    const page = renderToStaticMarkup(<KaiJournalView {...props({ language, suggestions: [{ kind: 'REVISIT', topic: 'Blocking', daysAgo: 24, count: 3 }, { kind: 'TAG' }] })} />);
    expect(page).toContain(JOURNAL_COPY[language].pageTitle); expect(page).toContain(JOURNAL_COPY[language].suggestion({ kind: 'TAG' }, (d) => d));
  }
});

it('the page sits with Kai in the shell and the route manifest, the checklist names the permission, and nothing stays on the device', () => {
  expect(schoolShellActiveRoute('/staff/teaching-assistant/journal')).toBeTruthy();
  expect(JSON.stringify(SCHOOL_SHELL_NAV.find(item => item.key === 'aiTeam'))).toContain('/staff/teaching-assistant/journal');
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
  expect(manifest.routes.filter((r: { path: string }) => r.path === '/staff/teaching-assistant/journal')).toHaveLength(1);
  expect(PERMISSION_LABELS['teaching.journal.use']).toBe('Keep their own Kai teaching journal');
  expect(areaOf('teaching.journal.use').key).toBe('ranks');
  expect(readFileSync('src/components/teaching-assistant-workbench.tsx', 'utf8')).toContain('/staff/teaching-assistant/journal');
  for (const file of ['view.tsx', 'kai-journal.tsx', 'http.ts', 'draft.ts']) {
    expect(readFileSync(`src/components/kai-journal/${file}`, 'utf8')).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  }
});
