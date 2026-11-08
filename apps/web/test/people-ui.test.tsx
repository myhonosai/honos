import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PERSON_RECORD_HUMAN_COMMAND, validatePersonRecord, type PersonRecord } from '@hon/contracts';
import { PersonRecordError, peopleApi, personErrorFor } from '../src/components/people/http';
import { attemptOutcome } from '../src/components/people/model';
import { birthDateInput, contactInput } from '../src/components/people/people';
import { PeopleView, outcomeText, type PeopleViewProps } from '../src/components/people/view';
import { SCHOOL_SHELL_NAV } from '../src/components/school-shell/catalog';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
import { id, scope } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const person = id(30), key = id(90);
const raw = (over: Record<string, unknown> = {}) => ({ personId: person, schoolId: scope.schoolId, givenName: 'Ana', familyName: 'Rivera',
  email: 'ana@example.invalid', phoneE164: '+15555550100', version: 3, updatedAt: '2026-11-07T06:30:00.000Z',
  student: { birthDate: '2015-04-02', status: 'ACTIVE', version: 1 }, consents: { EMAIL: 'NOT_RECORDED', SMS: 'NOT_RECORDED' }, canEdit: true, ...over });
const rec = (over: Record<string, unknown> = {}): PersonRecord => validatePersonRecord(raw(over));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: (Response | Error)[]) => {
  const fetch = vi.fn(async () => { const a = answers.shift(); if (!a || a instanceof Error) throw a ?? new Error('none'); return a; });
  vi.stubGlobal('fetch', fetch); return fetch;
};
const signal = () => new AbortController().signal, yes = () => true;

it('maps only the exact documented refusals; anything else is unknown', () => {
  const rows: [number, string | null, string][] = [
    [403, 'PERSON_FORBIDDEN', 'DENIED'], [403, null, 'DENIED'], [403, 'PERSON_BIRTH_DATE_OWNER_REQUIRED', 'OWNER_REQUIRED'],
    [400, 'PERSON_UNCHANGED', 'UNCHANGED'], [400, 'PERSON_INPUT_INVALID', 'INVALID'], [400, null, 'UNKNOWN'],
    [404, 'PERSON_UNAVAILABLE', 'MISSING'], [404, null, 'UNKNOWN'], [409, 'PERSON_VERSION_CONFLICT', 'CONFLICT'],
    [409, 'PERSON_CONTACT_CONSENT_REVIEW_REQUIRED', 'CONSENT'], [409, 'PERSON_IDEMPOTENCY_CONFLICT', 'UNKNOWN'], [409, null, 'UNKNOWN'],
    [503, 'PERSON_BUSY', 'BUSY'], [503, 'PERSON_UNAVAILABLE', 'UNKNOWN'], [500, null, 'UNKNOWN'], [502, 'PERSON_BUSY', 'UNKNOWN']];
  for (const [status, code, kind] of rows) expect(personErrorFor(status, code).kind, `${status} ${code}`).toBe(kind);
});

it('keeps the request and key only when the outcome is unknown or the record was busy', () => {
  for (const kind of ['UNKNOWN', 'BUSY'] as const) expect(attemptOutcome(new PersonRecordError(kind), 'contact').keep).toBe(true);
  for (const kind of ['DENIED', 'OWNER_REQUIRED', 'INVALID', 'UNCHANGED', 'MISSING', 'CONFLICT', 'CONSENT'] as const)
    expect(attemptOutcome(new PersonRecordError(kind), 'birthDate')).toEqual({ outcome: { kind, command: 'birthDate' }, keep: false });
  expect(attemptOutcome(new TypeError('network'), 'contact')).toEqual({ outcome: { kind: 'UNKNOWN', command: 'contact' }, keep: true });
  expect(attemptOutcome(new PersonRecordError('SESSION'), 'contact')).toEqual({ outcome: null, keep: false });
});

it('searches one school with a bounded, closed list and no other selectors', async () => {
  const fetch = stub(json({ data: [{ id: person, givenName: 'Ana', familyName: 'Rivera', email: null, phoneE164: '+15555550100', version: 2, createdAt: '2026-11-01T00:00:00.000Z' }], meta: { requestId: 'r', correlationId: 'r' } }));
  const items = await peopleApi.search(scope, '  ana & co ', signal());
  expect(items).toEqual([{ personId: person, givenName: 'Ana', familyName: 'Rivera', email: null, phoneE164: '+15555550100' }]);
  const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/people?query=ana%20%26%20co`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store' });
  for (const bad of [[{ id: person, givenName: 'Ana', familyName: 'R', email: null, phoneE164: null, version: 1, createdAt: 'x', extra: 1 }],
    Array.from({ length: 51 }, (_, n) => ({ id: id(100 + n), givenName: 'A', familyName: 'B', email: null, phoneE164: null, version: 1, createdAt: 'x' }))]) {
    stub(json({ data: bad, meta: {} }));
    await expect(peopleApi.search(scope, '', signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
  }
  stub(json({ message: 'no' }, 403));
  await expect(peopleApi.search(scope, '', signal())).rejects.toMatchObject({ kind: 'DENIED' });
});

it('reads one person and refuses an answer for another school or person', async () => {
  stub(json({ data: raw() }));
  expect((await peopleApi.read(scope.schoolId, person, signal())).givenName).toBe('Ana');
  stub(json({ data: raw({ schoolId: id(3) }) }));
  await expect(peopleApi.read(scope.schoolId, person, signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
  stub(json({ data: raw({ personId: id(31) }) }));
  await expect(peopleApi.read(scope.schoolId, person, signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
  stub(json({ code: 'PERSON_UNAVAILABLE' }, 404));
  await expect(peopleApi.read(scope.schoolId, person, signal())).rejects.toMatchObject({ kind: 'MISSING' });
});

it('a 401 reports the session as ended', async () => {
  const seen = vi.fn(); (window as unknown as EventTarget).addEventListener(HON_SESSION_INVALIDATED_EVENT, seen);
  stub(json({ code: 'SIGN_IN_REQUIRED' }, 401));
  await expect(peopleApi.read(scope.schoolId, person, signal())).rejects.toMatchObject({ kind: 'SESSION' });
  expect(seen).toHaveBeenCalledTimes(1);
});

it('sends the closed edit body with the command header and key, and checks the answer echoes it', async () => {
  const input = contactInput(scope.schoolId, rec(), { givenName: ' Ana ', familyName: 'Rivera-Lopez', email: 'ANA@Example.invalid', phone: '+1 (555) 555-0100' });
  if (typeof input === 'string') throw new Error(input);
  expect(input).toEqual({ schoolId: scope.schoolId, personId: person, expectedVersion: 3, givenName: 'Ana', familyName: 'Rivera-Lopez', email: 'ana@example.invalid', phoneE164: '+15555550100' });
  const saved = raw({ familyName: 'Rivera-Lopez', version: 4 });
  const fetch = stub(json({ data: { person: saved, changedFields: ['familyName'] } }));
  const result = await peopleApi.update(input, key, signal(), yes);
  expect(result.changedFields).toEqual(['familyName']);
  const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/school/people/update');
  expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error' });
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': PERSON_RECORD_HUMAN_COMMAND, 'Idempotency-Key': key, 'Content-Type': 'application/json' });
  expect(JSON.parse(String(init.body))).toEqual(input);
  // An answer that does not echo what was sent is not a confirmation.
  for (const wrong of [raw({ familyName: 'Other', version: 4 }), raw({ familyName: 'Rivera-Lopez', version: 3 }), raw({ familyName: 'Rivera-Lopez', version: 4, schoolId: id(3) })]) {
    stub(json({ data: { person: wrong, changedFields: ['familyName'] } }));
    await expect(peopleApi.update(input, key, signal(), yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  }
  stub(new TypeError('network'));
  await expect(peopleApi.update(input, key, signal(), yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  stub(json({ code: 'PERSON_VERSION_CONFLICT', outcome: 'NOT_SUBMITTED' }, 409));
  await expect(peopleApi.update(input, key, signal(), yes)).rejects.toMatchObject({ kind: 'CONFLICT' });
  stub(new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
  await expect(peopleApi.update(input, key, signal(), yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
});

it('a 401 for a save that is no longer shown does not end the newer session; a current one does', async () => {
  const seen = vi.fn(); (window as unknown as EventTarget).addEventListener(HON_SESSION_INVALIDATED_EVENT, seen);
  const contact = contactInput(scope.schoolId, rec(), { givenName: 'Ana', familyName: 'Rivera-Lopez', email: 'ana@example.invalid', phone: '+15555550100' });
  const birth = birthDateInput(scope.schoolId, rec(), { birthDate: '2015-05-05', reason: 'Birth certificate' });
  if (typeof contact === 'string' || birth === null || typeof birth === 'string') throw new Error('input');
  const retired = () => false;
  stub(json({ code: 'SIGN_IN_REQUIRED' }, 401));
  await expect(peopleApi.update(contact, key, signal(), retired)).rejects.toMatchObject({ kind: 'SESSION' });
  stub(json({ code: 'SIGN_IN_REQUIRED' }, 401));
  await expect(peopleApi.updateBirthDate(birth, key, signal(), retired)).rejects.toMatchObject({ kind: 'SESSION' });
  expect(seen).not.toHaveBeenCalled();
  stub(json({ code: 'SIGN_IN_REQUIRED' }, 401));
  await expect(peopleApi.update(contact, key, signal(), yes)).rejects.toMatchObject({ kind: 'SESSION' });
  expect(seen).toHaveBeenCalledTimes(1);
  stub(json({ code: 'SIGN_IN_REQUIRED' }, 401));
  await expect(peopleApi.updateBirthDate(birth, key, signal(), yes)).rejects.toMatchObject({ kind: 'SESSION' });
  expect(seen).toHaveBeenCalledTimes(2);
});

it('accepts a receipt that keeps the stored spelling of an address that differs only in case', async () => {
  const stored = rec({ email: 'ANA@Example.invalid' });
  // A case-only change of the address is not a change.
  expect(contactInput(scope.schoolId, stored, { givenName: 'Ana', familyName: 'Rivera', email: 'ana@example.invalid', phone: '+15555550100' })).toBe('UNCHANGED');
  const input = contactInput(scope.schoolId, stored, { givenName: 'Ana', familyName: 'Rivera', email: 'ANA@Example.invalid', phone: '+15555550199' });
  if (typeof input === 'string') throw new Error(input);
  expect(input.email).toBe('ana@example.invalid');
  for (const student of [{ birthDate: '2015-04-02', status: 'ACTIVE', version: 1 }, { birthDate: '2015-04-02', status: 'ACTIVE' }]) {
    stub(json({ data: { person: raw({ email: 'ANA@Example.invalid', phoneE164: '+15555550199', version: 4, student }), changedFields: ['phoneE164'] } }));
    const result = await peopleApi.update(input, key, signal(), yes);
    expect(result.person.email).toBe('ANA@Example.invalid');
  }
  for (const email of ['other@example.invalid', null]) {
    stub(json({ data: { person: raw({ email, phoneE164: '+15555550199', version: 4 }), changedFields: ['phoneE164'] } }));
    await expect(peopleApi.update(input, key, signal(), yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  }
  const cleared = contactInput(scope.schoolId, stored, { givenName: 'Ana', familyName: 'Rivera', email: '', phone: '+15555550100' });
  if (typeof cleared === 'string') throw new Error(cleared);
  stub(json({ data: { person: raw({ email: 'ANA@Example.invalid', version: 4 }), changedFields: ['email'] } }));
  await expect(peopleApi.update(cleared, key, signal(), yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  stub(json({ data: { person: raw({ email: null, version: 4 }), changedFields: ['email'] } }));
  expect((await peopleApi.update(cleared, key, signal(), yes)).person.email).toBeNull();
});

it('builds edit bodies only from valid, changed values', () => {
  const r = rec();
  expect(contactInput(scope.schoolId, r, { givenName: 'Ana', familyName: 'Rivera', email: 'ana@example.invalid', phone: '+15555550100' })).toBe('UNCHANGED');
  expect(contactInput(scope.schoolId, r, { givenName: '', familyName: 'Rivera', email: '', phone: '' })).toBe('INVALID');
  expect(contactInput(scope.schoolId, r, { givenName: 'Ana', familyName: 'Rivera', email: 'not-an-email', phone: '' })).toBe('INVALID');
  expect(contactInput(scope.schoolId, r, { givenName: 'Ana', familyName: 'Rivera', email: '', phone: '5555550100' })).toBe('INVALID');
  expect(contactInput(scope.schoolId, r, { givenName: 'Ana', familyName: 'Rivera', email: '', phone: '' })).toMatchObject({ email: null, phoneE164: null });
  expect(birthDateInput(scope.schoolId, r, { birthDate: '2015-04-02', reason: 'checked' })).toBe('UNCHANGED');
  expect(birthDateInput(scope.schoolId, r, { birthDate: '2015-04-03', reason: '  ' })).toBe('INVALID');
  expect(birthDateInput(scope.schoolId, r, { birthDate: '2015-02-30', reason: 'checked' })).toBe('INVALID');
  expect(birthDateInput(scope.schoolId, r, { birthDate: '2015-04-03', reason: ' Birth certificate ' }))
    .toEqual({ schoolId: scope.schoolId, personId: person, expectedVersion: 1, birthDate: '2015-04-03', reason: 'Birth certificate' });
  expect(birthDateInput(scope.schoolId, rec({ student: null }), { birthDate: '2015-04-03', reason: 'x' })).toBeNull();
});

it('sends a birth date correction and requires the saved date and a newer student version in the answer', async () => {
  const input = birthDateInput(scope.schoolId, rec(), { birthDate: '2015-05-05', reason: 'Birth certificate' });
  if (input === null || typeof input === 'string') throw new Error(String(input));
  const fetch = stub(json({ data: { person: raw({ student: { birthDate: '2015-05-05', status: 'ACTIVE', version: 2 } }), changedFields: ['birthDate'], enrollmentCorrected: true } }));
  expect((await peopleApi.updateBirthDate(input, key, signal(), yes)).enrollmentCorrected).toBe(true);
  expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe('/api/v1/school/people/birth-date');
  stub(json({ data: { person: raw({ student: { birthDate: '2015-04-02', status: 'ACTIVE', version: 2 } }), changedFields: ['birthDate'], enrollmentCorrected: false } }));
  await expect(peopleApi.updateBirthDate(input, key, signal(), yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  stub(json({ code: 'PERSON_BIRTH_DATE_OWNER_REQUIRED' }, 403));
  await expect(peopleApi.updateBirthDate(input, key, signal(), yes)).rejects.toMatchObject({ kind: 'OWNER_REQUIRED' });
});

const base: PeopleViewProps = { language: 'en', waiting: false, concealed: false, hasSchool: true,
  list: { state: 'READY', query: '', items: [{ personId: person, givenName: 'Ana', familyName: 'Rivera', email: 'ana@example.invalid', phoneE164: null }] },
  record: { state: 'READY', record: rec() }, selectedId: person, outcome: null, locked: false, canRetry: false,
  onSearch: () => {}, onOpen: () => {}, onSaveContact: () => {}, onSaveBirth: () => {}, onTryAgain: () => {}, onDiscard: () => {} };
const view = (over: Partial<PeopleViewProps> = {}) => renderToStaticMarkup(<PeopleView {...base} {...over}/>);

it('shows nothing private before the school is verified, while hidden, or without a school', () => {
  for (const over of [{ waiting: true }, { concealed: true }, { hasSchool: false }]) {
    const html = view(over);
    expect(html).not.toMatch(/Ana|Rivera|example\.invalid|2015/);
    expect(html).not.toMatch(/<input|<form/);
  }
});

it('shows the record with edit forms, consent states and the owner rule', () => {
  const html = view();
  expect(html).toContain('value="Ana"'); expect(html).toContain('value="Rivera"'); expect(html).toContain('value="2015-04-02"');
  expect(html).toContain('Save changes'); expect(html).toContain('Save birth date');
  expect(html).toContain('only the school owner can save it');
  expect(html).toContain('aria-current="true"');
  expect(html).not.toMatch(/<fieldset[^>]*disabled/);
});

it('is read-only without edit access and offers no save', () => {
  const html = view({ record: { state: 'READY', record: rec({ canEdit: false }) } });
  expect(html).toContain('your access does not include editing');
  expect(html).toMatch(/<fieldset[^>]*disabled/);
  expect(html).not.toContain('Save changes'); expect(html).not.toContain('Save birth date');
});

it('explains why an address with active consent cannot be changed here', () => {
  const html = view({ record: { state: 'READY', record: rec({ consents: { EMAIL: 'OPTED_IN', SMS: 'OPTED_OUT' } }) } });
  expect(html).toContain('This person agreed to email');
  expect(html).toContain('Recording an opt-out is not on this screen yet');
  expect(html).toContain('Opted out');
});

it('has no child section for a person without a student profile', () => {
  const html = view({ record: { state: 'READY', record: rec({ student: null }) } });
  expect(html).not.toContain('Child details'); expect(html).not.toContain('Birth date');
});

it('locks both forms while a save is sending or kept, and offers Try again only for a kept save', () => {
  const sending = view({ locked: true, outcome: { kind: 'SENDING', command: 'contact' } });
  expect(sending.match(/<fieldset[^>]*disabled/g)).toHaveLength(2);
  expect(sending).toContain('Saving… keep this tab open.'); expect(sending).not.toContain('Try again');
  const kept = view({ locked: true, canRetry: true, outcome: { kind: 'UNKNOWN', command: 'contact' } });
  expect(kept).toContain('Try again'); expect(kept).toContain('never applied twice'); expect(kept).toContain('Reload the saved record');
  const conflict = view({ outcome: { kind: 'CONFLICT', command: 'birthDate' } });
  expect(conflict).not.toContain('Try again'); expect(conflict).toContain('Someone else changed this record');
});

it('words every outcome in all three languages', () => {
  const outcomes = [{ kind: 'SAVED', command: 'contact', fields: ['email', 'phoneE164'] }, { kind: 'SAVED', command: 'birthDate', enrollmentCorrected: true },
    ...['UNKNOWN', 'BUSY', 'DENIED', 'OWNER_REQUIRED', 'INVALID', 'LOCAL_INVALID', 'UNCHANGED', 'LOCAL_UNCHANGED', 'MISSING', 'CONFLICT', 'CONSENT'].map(kind => ({ kind, command: 'contact' }))] as const;
  for (const language of ['en', 'ko', 'es']) for (const o of outcomes) expect(outcomeText(language, o as never)?.text, `${language} ${o.kind}`).toMatch(/\S/);
  expect(outcomeText('en', outcomes[0] as never)?.text).toBe('Saved. Changed: email, phone.');
  expect(outcomeText('en', outcomes[1] as never)?.text).toContain('enrollment record now matches');
});

it('a replayed receipt without a student version asks for a reload instead of guessing it', () => {
  const r = { ...rec(), student: { birthDate: '2015-04-02', status: 'ACTIVE' } };
  const html = view({ record: { state: 'READY', record: r } });
  expect(html).toContain('Reload this person before correcting the birth date');
  expect(html).not.toContain('Save birth date');
});

it('is linked from the Students navigation and listed in the route manifest', () => {
  expect(SCHOOL_SHELL_NAV.find(i => i.key === 'students')?.routes.map(r => r.href)).toContain('/staff/people');
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: { path: string }[] };
  expect(manifest.routes.some(r => r.path === '/staff/people')).toBe(true);
});
