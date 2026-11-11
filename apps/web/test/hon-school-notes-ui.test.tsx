import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HON_CONVERSATION_COMMAND, HON_SCHOOL_NOTES_API, HonConversationError, prepareSchoolNote, prepareSchoolNoteDelete,
} from '../src/components/hon-command/hon-conversation-http';
import { HonSchoolNotesView, type HonSchoolNotesViewProps } from '../src/components/hon-command/hon-school-notes';

// 0255 "What HON remembers": school notes the owner saves on purpose. Fixed same-origin paths, frozen writes with a fresh
// key, exact envelopes, and a view that only offers changes to someone the server says may manage notes.

const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const AT = '2026-11-11T09:00:00.000Z';
const SCHOOL = { organizationId: id(1), schoolId: id(2) };
const BASE = `/api/v1/organizations/${id(1)}/schools/${id(2)}/hon`;
const LIMITS = { maxNotes: 20, maxCharacters: 2000, noteCharacters: 200 };
const note = (n: number, text = `School fact number ${n}.`) => ({ id: id(n), text, createdAt: AT });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const noop = () => {};
const view = (over: Partial<HonSchoolNotesViewProps> = {}) => renderToStaticMarkup(<HonSchoolNotesView {...{
  phase: 'READY', notes: [note(3), note(4)], canManage: true, draft: '', pending: null, onDraft: noop, onAdd: noop, onDelete: noop, onRetry: noop, onDismiss: noop, onRefresh: noop, ...over,
} as HonSchoolNotesViewProps} />);

afterEach(() => { vi.unstubAllGlobals(); });

describe('School notes transport (0255)', () => {
  it('freezes an add with a fresh key and refuses contacts, links and bad lengths before anything is sent', () => {
    const a = prepareSchoolNote(SCHOOL, '  We close the first week of August.  ');
    const b = prepareSchoolNote(SCHOOL, 'We close the first week of August.');
    expect(Object.isFrozen(a)).toBe(true); expect(a.key).not.toBe(b.key);
    expect(a.path).toBe(`${BASE}/school-notes`);
    expect(JSON.parse(a.body)).toEqual({ text: 'We close the first week of August.' });
    for (const bad of ['ab', 'x'.repeat(201), 'Email coach@example.test', 'Call 555 123 4567', 'See https://x.test', '<b>x</b>']) expect(() => prepareSchoolNote(SCHOOL, bad)).toThrow(HonConversationError);
  });
  it('freezes a delete for one note id', () => {
    const d = prepareSchoolNoteDelete(SCHOOL, id(3).toUpperCase());
    expect(d.path).toBe(`${BASE}/school-notes/${id(3)}/delete`);
    expect(d.body).toBe('{}');
    expect(() => prepareSchoolNoteDelete(SCHOOL, 'not-a-uuid')).toThrow(HonConversationError);
    expect(() => prepareSchoolNoteDelete(SCHOOL, `${id(3)}/../x`)).toThrow(HonConversationError);
  });
  it('reads exactly the notes envelope with no-store; drift is unavailable, never an empty list', async () => {
    const page = { notes: [note(3)], canManage: false, limits: LIMITS };
    const fetchMock = vi.fn(async () => json(200, { data: page }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(HON_SCHOOL_NOTES_API.read(SCHOOL, new AbortController().signal)).resolves.toEqual(page);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(`${BASE}/school-notes`); expect(init).toMatchObject({ method: 'GET', cache: 'no-store', credentials: 'same-origin' });
    for (const bad of [{ data: { ...page, extra: 1 } }, { data: page, extra: 1 }, { data: { ...page, notes: [{ ...note(3), text: 'mail a@b.test' }] } }]) {
      vi.stubGlobal('fetch', vi.fn(async () => json(200, bad)));
      expect(((await HON_SCHOOL_NOTES_API.read(SCHOOL, new AbortController().signal).catch((e: unknown) => e)) as HonConversationError).kind).toBe('UNAVAILABLE');
    }
    vi.stubGlobal('fetch', vi.fn(async () => json(403, {})));
    expect(((await HON_SCHOOL_NOTES_API.read(SCHOOL, new AbortController().signal).catch((e: unknown) => e)) as HonConversationError).kind).toBe('FORBIDDEN');
  });
  it('sends the human-command header and key; a full list is definitive, anything uncertain keeps the exact retry', async () => {
    const prepared = prepareSchoolNote(SCHOOL, 'Kids classes are 45 minutes long.');
    const fetchMock = vi.fn(async () => json(200, { data: { record: { note: note(5, 'Kids classes are 45 minutes long.') }, replayed: false } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(HON_SCHOOL_NOTES_API.send(prepared)).resolves.toMatchObject({ replayed: false });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init).toMatchObject({ method: 'POST', body: prepared.body });
    expect(init.headers).toMatchObject({ 'X-HON-Human-Command': HON_CONVERSATION_COMMAND, 'Idempotency-Key': prepared.key });
    const cases: Array<[() => Response | Promise<Response>, string, string | null]> = [
      [() => json(409, { code: 'HON_SCHOOL_NOTES_FULL' }), 'CONFLICT', 'HON_SCHOOL_NOTES_FULL'],
      [() => json(409, { code: 'HON_IDEMPOTENCY_CONFLICT' }), 'CONFLICT', 'HON_IDEMPOTENCY_CONFLICT'],
      [() => json(404, { code: 'HON_SCHOOL_NOTE_NOT_FOUND' }), 'INVALID', 'HON_SCHOOL_NOTE_NOT_FOUND'],
      [() => json(403, { code: 'HON_SCHOOL_NOTES_FORBIDDEN' }), 'FORBIDDEN', 'HON_SCHOOL_NOTES_FORBIDDEN'],
      [() => json(200, { data: { record: { noteId: id(3), deleted: false }, replayed: false } }), 'UNKNOWN', null],
      [() => Promise.reject(new TypeError('network')), 'UNKNOWN', null],
    ];
    for (const [respond, kind, code] of cases) {
      vi.stubGlobal('fetch', vi.fn(respond));
      const error = await HON_SCHOOL_NOTES_API.send(prepared).catch((e: unknown) => e);
      expect([(error as HonConversationError).kind, (error as HonConversationError).code]).toEqual([kind, code]);
    }
  });
});

describe('What HON remembers view (0255)', () => {
  it('lists the notes and, for a manager, offers add and one-by-one delete with the privacy rule', () => {
    const html = view();
    expect(html).toContain('What HON remembers');
    expect(html).toContain('School fact number 3.'); expect(html).toContain('School fact number 4.');
    expect(html.match(/data-hon-note-delete/g)).toHaveLength(2);
    expect(html).toContain('maxLength="200"');
    expect(html).toContain('2 of 20 notes');
    expect(html).toMatch(/never about a student, family or staff member/);
  });
  it('shows notes read-only to HON users who cannot manage them', () => {
    const html = view({ canManage: false });
    expect(html).toContain('School fact number 3.');
    expect(html).not.toContain('data-hon-note-delete');
    expect(html).not.toContain('<textarea');
    expect(html).toMatch(/Only an owner, or staff given permission, can change these notes/);
  });
  it('says when the list is full and keeps add closed', () => {
    const html = view({ notes: Array.from({ length: 20 }, (_, i) => ({ ...note(3), id: `${id(3).slice(0, -2)}${String(i).padStart(2, '0')}` })), draft: 'One more fact here.' });
    expect(html).toMatch(/full/); expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });
  it('keeps the exact retry for an unknown outcome and hides notes when not ready', () => {
    const html = view({ pending: { kind: 'add', state: 'UNKNOWN', code: null } });
    expect(html).toContain('Retry the same request');
    expect(view({ phase: 'LOADING', notes: [] })).not.toContain('School fact');
    expect(view({ phase: 'FORBIDDEN', notes: [] })).toMatch(/role does not include HON/);
    expect(view({ notes: [] })).toMatch(/No notes yet/);
  });
});
